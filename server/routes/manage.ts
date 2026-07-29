import { Router } from "express";
import { db, now, auditLog, getSettings } from "../db.js";
import { serializeBooking } from "../lib/bookingService.js";
import { emit } from "../lib/events.js";
import { cancelReservation } from "../lib/nav.js";
import { page } from "./print.js";
import { notifyWaitlistForBooking } from "../lib/waitlist.js";
import { cancelBookingNotifications, scheduleBookingReminders } from "../lib/notifications.js";
import { refundQuote, validateRentalWindow } from "../lib/policy.js";

export const manageRouter = Router();

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isHttpUrl = (v: unknown) => /^https?:\/\/.+/i.test(String(v ?? ""));

function rowFor(token: string) {
  if (!token || token.length < 20) return null;
  return db.prepare("SELECT * FROM bookings WHERE manage_token=?").get(token) as any;
}

function policy(bookingId: string) {
  const rows = db.prepare(`SELECT p.customer_can_cancel,p.customer_can_reschedule,p.cancellation_hours
    FROM booking_lines l JOIN products p ON p.product_no=l.product_no WHERE l.booking_id=?`).all(bookingId) as any[];
  return {
    canCancel: rows.length > 0 && rows.every((r) => !!r.customer_can_cancel),
    canReschedule: rows.length > 0 && rows.every((r) => !!r.customer_can_reschedule),
    cutoffHours: Math.max(0, ...rows.map((r) => Number(r.cancellation_hours) || 0)),
  };
}

function cutoffPassed(bookingId: string, hours: number) {
  const line = db.prepare("SELECT MIN(date_from) starts FROM booking_lines WHERE booking_id=?").get(bookingId) as any;
  return !line?.starts || new Date(line.starts).getTime() - Date.now() < hours * 3_600_000;
}

const ics = (v: unknown) => String(v ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
const icsDate = (v: string) => new Date(v).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

manageRouter.get("/:token/calendar.ics", (req, res) => {
  const row = rowFor(req.params.token);
  if (!row) return res.status(404).send("Calendar link expired");
  const booking = serializeBooking(row.id)!;
  const events = booking.lines.map((line: any) => [
    "BEGIN:VEVENT", `UID:${line.id}@reservly`, `DTSTAMP:${icsDate(booking.createdAt)}`,
    `DTSTART:${icsDate(line.from)}`, `DTEND:${icsDate(line.to)}`,
    `SUMMARY:${ics(line.productName)}`, `DESCRIPTION:${ics(`Booking ${booking.ref}`)}`,
    line.meetingUrl ? `URL:${ics(line.meetingUrl)}` : "", "END:VEVENT",
  ].filter(Boolean).join("\r\n")).join("\r\n");
  res.type("text/calendar").set("Content-Disposition", `attachment; filename="${booking.ref}.ics"`)
    .send(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Reservly//Booking//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n${events}\r\nEND:VCALENDAR\r\n`);
});

manageRouter.get("/:token", (req, res) => {
  const row = rowFor(req.params.token);
  if (!row) return res.status(404).send(page("Link expired", "<h1>Link expired</h1><p>Please contact the store for help.</p>"));
  const booking = serializeBooking(row.id)!;
  const rules = policy(row.id);
  const locked = cutoffPassed(row.id, rules.cutoffHours);
  const first = db.prepare("SELECT MIN(date_from) AS starts FROM booking_lines WHERE booking_id=?").get(row.id) as { starts: string | null };
  const quote = first.starts ? refundQuote(row, first.starts) : null;
  const refundWarning = quote?.enabled
    ? quote.tier === "none"
      ? "<p><strong>No refund per policy</strong></p>"
      : `<p><strong>Cancelling now: ${quote.percent}% refund ($${quote.amount.toFixed(2)})</strong></p>`
    : "";
  const max = Number(getSettings().maxCustomerReschedules) || 5;
  const settings = getSettings();
  const extensionsEnabled = settings.extensionsEnabled === "1";
  const extendable = extensionsEnabled && ["RESERVED", "PAID", "PICKED_UP", "RETURNED"].includes(booking.status);
  const lines = booking.lines.map((l: any) => {
    const joinLink = l.meetingUrl && isHttpUrl(l.meetingUrl) ? `
      <div style="margin-top:12px">
        <a href="${esc(l.meetingUrl)}" target="_blank" style="display:inline-block; padding:10px 16px; background:#12A46B; color:#fff; text-decoration:none; border-radius:4px; font-weight:600">Join online session</a>
      </div>` : "";
    return `<li><strong>${esc(l.productName)}</strong><br>${new Date(l.from).toLocaleString("en-CA")} → ${new Date(l.to).toLocaleString("en-CA")}
      ${joinLink}
      ${extendable && l.type === "RENTAL" ? `
      <div style="margin-top:20px; padding:10px; background:#f5f5f5; border-radius:4px">
        <h3>Extend rental: ${esc(l.productName)}</h3>
        <p>Current return: <strong>${l.to.slice(0, 10)}</strong></p>
        <input id="ext_${esc(l.id)}_date" type="date" min="${new Date(new Date(l.to).getTime() + 86_400_000).toISOString().slice(0, 10)}" required>
        <button onclick="extQuote('${esc(l.id)}')">Check price</button>
        <p id="ext_${esc(l.id)}_quote"></p>
        <button id="ext_${esc(l.id)}_submit" style="display:none" onclick="extSubmit('${esc(l.id)}')">Request extension</button>
      </div>` : ""}
    </li>`;
  }).join("");
  const extensionRequests = extensionsEnabled ? `
    <div id="requests" style="margin-top:20px">
      <h3>Extension requests</h3>
      <p>Loading…</p>
    </div>` : "";
  const actions = booking.status === "CANCELLED"
    ? "<p><strong>This booking has been cancelled.</strong></p>"
    : locked
      ? `<p>Online changes closed ${rules.cutoffHours} hours before the booking. Please contact the store.</p>`
      : `<div style="display:flex;gap:10px;flex-wrap:wrap">
          ${rules.canReschedule && booking.rescheduleCount < max ? `<button onclick="document.getElementById('move').hidden=false">Reschedule</button>` : ""}
          ${rules.canCancel ? `${refundWarning}<button style="background:#b42318" onclick="run('cancel')">Cancel booking</button>` : ""}
        </div>
        <form id="move" hidden onsubmit="move(event)" style="margin-top:18px">
          <h2>Choose new dates</h2>
          <select id="line">${booking.lines.map((l: any) => `<option value="${esc(l.id)}">${esc(l.productName)}</option>`).join("")}</select>
          <input id="from" type="datetime-local" required>
          <input id="to" type="datetime-local" required>
          <button type="submit">Request reschedule</button>
        </form>`;
  res.send(page(`Manage ${booking.ref}`, `
    <h1>Manage booking ${booking.ref}</h1>
    <p>${esc(booking.customer.firstName)} ${esc(booking.customer.lastName)}</p>
    <ul style="line-height:1.7">${lines}</ul>${extensionRequests}${actions}
    <p id="status"></p>
    <script>
      function send(body){return fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>{const d=await r.json();if(!r.ok)throw Error(d.error||"Request failed");return d})}
      function run(action){if(action==="cancel"&&!confirm("Cancel this booking?"))return;send({action:action}).then(()=>location.reload()).catch(e=>status.textContent=e.message)}
      function move(e){e.preventDefault();send({action:"reschedule",lineId:line.value,from:from.value,to:to.value}).then(()=>location.reload()).catch(e=>status.textContent=e.message)}
      function extQuote(lineId){const date=document.getElementById("ext_"+lineId+"_date").value;const out=document.getElementById("ext_"+lineId+"_quote");send({action:"extension_quote",lineId:lineId,newDateTo:date}).then(d=>{out.textContent=d.available?"Extension price: $"+d.price:"Those dates are unavailable";document.getElementById("ext_"+lineId+"_submit").style.display=d.available?"inline-block":"none"}).catch(e=>out.textContent=e.message)}
      function extSubmit(lineId){const date=document.getElementById("ext_"+lineId+"_date").value;send({action:"request_extension",lineId:lineId,newDateTo:date}).then(d=>{if(d.invoiceUrl)location.href=d.invoiceUrl;else location.reload()}).catch(e=>status.textContent=e.message)}
      ${extensionsEnabled ? `send({action:"extension_requests"}).then(d=>{requests.innerHTML="<h3>Extension requests</h3>"+(d.requests.length?d.requests.map(r=>"<p><strong>"+r.productName+"</strong>: "+r.oldDateTo.slice(0,10)+" → "+r.newDateTo.slice(0,10)+" — "+r.status+" ($"+Number(r.price).toFixed(2)+")</p>").join(""):"<p>No extension requests.</p>")}).catch(e=>requests.innerHTML="<h3>Extension requests</h3><p>"+e.message+"</p>")` : ""}
    </script>`));
});

manageRouter.post("/:token", async (req, res) => {
  const row = rowFor(req.params.token);
  if (!row) return res.status(404).json({ error: "This management link is invalid" });
  const extensionsEnabled = getSettings().extensionsEnabled === "1";
  if (req.body?.action === "extension_quote") {
    const { lineId, newDateTo } = req.body;
    const line = db.prepare("SELECT * FROM booking_lines WHERE id=? AND booking_id=?").get(lineId, row.id) as any;
    if (!line || line.type !== "RENTAL") return res.status(400).json({ error: "Invalid line" });
    if (!extensionsEnabled) return res.status(400).json({ error: "Extensions are not available" });
    try {
      const { checkExtensionAvailability, priceExtension } = await import("../lib/extensions.js");
      const available = await checkExtensionAvailability(line, newDateTo);
      const price = available ? priceExtension(line, newDateTo) : 0;
      return res.json({ available, price: price.toFixed(2) });
    } catch (err) {
      return res.status(400).json({ error: String(err) });
    }
  }
  if (req.body?.action === "request_extension") {
    const { lineId, newDateTo } = req.body;
    if (!extensionsEnabled) return res.status(400).json({ error: "Extensions are not available" });
    try {
      const { requestExtension } = await import("../lib/extensions.js");
      const request = await requestExtension(row.id, lineId, newDateTo);
      return res.json({ ok: true, status: request?.status, invoiceUrl: request?.invoiceUrl });
    } catch (err) {
      return res.status(400).json({ error: String(err) });
    }
  }
  if (req.body?.action === "extension_requests") {
    if (!extensionsEnabled) return res.status(400).json({ error: "Extensions are not available" });
    const requests = db.prepare(`SELECT e.*,l.product_name FROM extension_requests e
      JOIN booking_lines l ON l.id=e.line_id WHERE e.booking_id=? ORDER BY e.created_at DESC`).all(row.id) as any[];
    return res.json({ requests: requests.map((request) => ({
      id: request.id, productName: request.product_name, oldDateTo: request.old_date_to,
      newDateTo: request.new_date_to, price: request.price, status: request.status,
    })) });
  }
  const rules = policy(row.id);
  if (cutoffPassed(row.id, rules.cutoffHours)) return res.status(409).json({ error: "The online change cutoff has passed" });
  if (req.body?.action === "cancel") {
    if (!rules.canCancel) return res.status(403).json({ error: "Customer cancellation is disabled" });
    const first = db.prepare("SELECT MIN(date_from) AS starts FROM booking_lines WHERE booking_id=?").get(row.id) as { starts: string | null };
    if (!first.starts) return res.status(404).json({ error: "Booking has no lines" });
    const quote = refundQuote(row, first.starts);
    const lines = db.prepare("SELECT activity_no FROM booking_lines WHERE booking_id=? AND activity_no!=''").all(row.id) as any[];
    for (const line of lines) await cancelReservation(line.activity_no, row.customer_email).catch(() => false);
    db.prepare("UPDATE booking_lines SET status='CANCELLED' WHERE booking_id=?").run(row.id);
    if (quote.enabled === true) {
      db.prepare("UPDATE bookings SET status='CANCELLED',refund_due=?,updated_at=? WHERE id=?").run(quote.amount, now(), row.id);
    } else {
      db.prepare("UPDATE bookings SET status='CANCELLED',updated_at=? WHERE id=?").run(now(), row.id);
    }
    emit(row.id, "booking.cancelled", { by: "customer" });
    cancelBookingNotifications(row.id);
    notifyWaitlistForBooking(row.id);
    auditLog("booking.customer_cancelled", row.ref, row.customer_email, "customer");
    return res.json({ ok: true, quote });
  }
  if (req.body?.action === "reschedule") {
    if (!rules.canReschedule) return res.status(403).json({ error: "Customer rescheduling is disabled" });
    const max = Number(getSettings().maxCustomerReschedules) || 5;
    if (row.reschedule_count >= max) return res.status(409).json({ error: "The customer reschedule limit has been reached" });
    const { lineId, from, to } = req.body;
    if (!from || !to || new Date(to) <= new Date(from)) return res.status(400).json({ error: "Choose a valid date range" });
    const line = db.prepare("SELECT type FROM booking_lines WHERE id=? AND booking_id=?").get(lineId, row.id) as { type: string } | undefined;
    const fromISO = new Date(from).toISOString();
    const toISO = new Date(to).toISOString();
    if (line?.type === "RENTAL") {
      const validation = validateRentalWindow(fromISO, toISO);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
    }
    const result = db.prepare(`UPDATE booking_lines SET date_from=?,date_to=? WHERE id=? AND booking_id=? AND type='RENTAL'`)
      .run(fromISO, toISO, lineId, row.id);
    if (!result.changes) return res.status(400).json({ error: "Online rescheduling for this line requires staff assistance" });
    db.prepare("UPDATE bookings SET reschedule_count=reschedule_count+1,updated_at=? WHERE id=?").run(now(), row.id);
    emit(row.id, "booking.rescheduled", { by: "customer", lineId, from, to });
    scheduleBookingReminders(row.id);
    auditLog("booking.customer_rescheduled", row.ref, row.customer_email, "customer");
    return res.json({ ok: true });
  }
  res.status(400).json({ error: "Unknown action" });
});
