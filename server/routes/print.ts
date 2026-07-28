// Printable documents (server-rendered HTML, print-ready):
//   /print/contract/:id      — rental contract w/ deposit, ID last-4, signature (R12-R13)
//   /print/packing-list/:id  — kit contents checklist per rental line (R8)
//   /print/daily             — morning batch: all of today's rental paperwork (R8)
//   /print/confirmation/:id  — course booking confirmation (class step 16)
import { Router } from "express";
import { requirePerm } from "../lib/auth.js";
import { db, localDate, getSettings } from "../db.js";
import { serializeBooking } from "../lib/bookingService.js";

export const printRouter = Router();
printRouter.use(requirePerm("bookings"));

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number) => `CA$${(Number(n) || 0).toFixed(2)}`;
const dt = (s: string) => (s ? new Date(s).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "");

export function page(title: string, body: string, opts?: { bare?: boolean }): string {
  const toolbar = opts?.bare ? "" : `<div class="print-toolbar"><button onclick="history.length > 1 ? history.back() : location.assign('/')">Back</button><button onclick="window.print()">Print</button></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
    body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 40px auto; max-width: 760px; }
    h1 { font-size: 20px; border-bottom: 3px solid #12A46B; padding-bottom: 8px; }
    h2 { font-size: 15px; margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
    th { background: #E4F6EE; color: #0E7A50; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .meta { display: flex; gap: 32px; flex-wrap: wrap; margin: 16px 0; }
    .meta div b { display: block; font-size: 11px; text-transform: uppercase; color: #666; }
    .sig { margin-top: 48px; display: flex; gap: 48px; }
    .sig div { flex: 1; border-top: 1px solid #111; padding-top: 6px; font-size: 11px; color: #555; }
    .box { border: 1px solid #ccc; padding: 10px 14px; margin: 12px 0; border-radius: 4px; }
    .small { font-size: 11px; color: #555; }
    .checkbox { display: inline-block; width: 12px; height: 12px; border: 1px solid #333; margin-right: 8px; vertical-align: -2px; }
    .pagebreak { page-break-after: always; }
    .print-toolbar { position: sticky; top: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 10px; background: #f5f5f5; border-bottom: 1px solid #ddd; z-index: 1; }
    .print-toolbar button { padding: 6px 14px; border: 1px solid #bbb; border-radius: 4px; background: #fff; cursor: pointer; }
    @media print { body { margin: 12mm; } .print-toolbar { display: none; } }
  </style></head><body>${toolbar}${body}<script>if(new URLSearchParams(location.search).has("autoprint"))window.print()</script></body></html>`;
}

const pageOpts = (req: import("express").Request) => {
  const bare: unknown = req.query.bare;
  return { bare: bare === "1" || bare === true };
};

function bookingHeader(b: any): string {
  const store = b.storeId ? (db.prepare("SELECT name, city FROM stores WHERE id = ?").get(b.storeId) as any) : null;
  return `<div class="meta">
    <div><b>Booking</b>${esc(b.ref)}</div>
    <div><b>Customer</b>${esc(`${b.customer.firstName} ${b.customer.lastName}`.trim() || b.customer.email)}<br>${esc(b.customer.email)}${b.customer.phone ? `<br>${esc(b.customer.phone)}` : ""}</div>
    <div><b>Store</b>${esc(store ? `${store.name} (${store.city})` : "-")}</div>
    <div><b>Created</b>${dt(b.createdAt)}</div>
    ${b.customer.b2b ? '<div><b>Terms</b>B2B — pay later</div>' : ""}
  </div>`;
}

function kitRows(productNo: string): { itemNo: string; description: string; qty: number }[] {
  return db.prepare(
    `SELECT k.item_no AS itemNo, k.description, k.qty FROM product_kit_items k
     JOIN products p ON p.id = k.product_id WHERE p.product_no = ?`,
  ).all(productNo) as any[];
}

function signatureBlock(b: any): string {
  const raw = db.prepare("SELECT signature_png, signature_name FROM bookings WHERE id = ?").get(b.id) as any;
  if (b.contractSignedAt && raw?.signature_png) {
    return `<div class="meta" style="margin-top:36px">
      <div><b>Signed electronically by</b>${esc(raw.signature_name || b.customer.email)}<br>
      <img src="${raw.signature_png.startsWith("data:image/png;base64,") ? raw.signature_png : ""}" alt="signature" style="max-height:80px;margin-top:6px;border-bottom:1px solid #999"></div>
      <div><b>Date</b>${dt(b.contractSignedAt)}</div>
      <div><b>Staff signature</b><div style="border-top:1px solid #111;margin-top:40px;width:180px"></div></div>
    </div>`;
  }
  return `<div class="sig"><div>Customer signature</div><div>Staff signature</div><div>Date</div></div>`;
}

function linesTable(b: any): string {
  const rentals = b.lines.filter((l: any) => l.type === "RENTAL");
  return `<table><tr><th>Equipment</th><th>From</th><th>To</th><th>Days</th><th>Qty</th><th>Total</th></tr>
    ${rentals.map((l: any) => `<tr><td>${esc(l.productName)}<div class="small">${esc(l.productNo)} · NAV ${esc(l.activityNo || "-")}</div></td>
      <td>${dt(l.from)}</td><td>${dt(l.to)}</td><td>${l.days ?? "-"}</td><td>${l.qty}</td><td>${money(l.lineTotal)}</td></tr>`).join("")}
    </table>`;
}

const CODE39: Record<string, string> = {
  "0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw",
  "5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn",
  A:"wnnnnwnnw",B:"nnwnnwnnw",C:"wnwnnwnnn",D:"nnnnwwnnw",E:"wnnnwwnnn",F:"nnwnwwnnn",
  G:"nnnnnwwnw",H:"wnnnnwwnn",I:"nnwnnwwnn",J:"nnnnwwwnn",K:"wnnnnnnww",L:"nnwnnnnww",
  M:"wnwnnnnwn",N:"nnnnwnnww",O:"wnnnwnnwn",P:"nnwnwnnwn",Q:"nnnnnnwww",R:"wnnnnnwwn",
  S:"nnwnnnwwn",T:"nnnnwnwwn","-":"nnnnwnwnw","*":"nwnnwnwnn",
};
function barcode(value: string): string {
  const text = `*${value.toUpperCase().replace(/[^0-9A-Z-]/g, "-")}*`;
  let x = 0;
  const bars: string[] = [];
  for (const char of text) {
    const pattern = CODE39[char] || CODE39["-"];
    pattern.split("").forEach((width, i) => {
      const w = width === "w" ? 3 : 1;
      if (i % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${w}" height="54"/>`);
      x += w;
    });
    x += 1;
  }
  return `<svg viewBox="0 0 ${x} 68" style="width:280px;max-width:100%" role="img" aria-label="Barcode ${esc(value)}">${bars.join("")}<text x="${x / 2}" y="67" text-anchor="middle" font-size="10">${esc(value)}</text></svg>`;
}

/** Contract body — the Settings template (with {{placeholders}}) when present,
 *  otherwise the built-in layout. Shared with the e-signature page. */
export function contractBody(b: any): string {
  const rentals = b.lines.filter((l: any) => l.type === "RENTAL");
  const template = getSettings().contractTemplate?.trim();
  if (template) {
    const store = b.storeId ? (db.prepare("SELECT name, city FROM stores WHERE id = ?").get(b.storeId) as any) : null;
    const values: Record<string, string> = {
      ref: esc(b.ref),
      customerName: esc(`${b.customer.firstName} ${b.customer.lastName}`.trim() || b.customer.email),
      customerEmail: esc(b.customer.email),
      customerPhone: esc(b.customer.phone),
      store: esc(store ? `${store.name} (${store.city})` : ""),
      createdAt: esc(dt(b.createdAt)),
      lines: linesTable(b),
      subtotal: money(b.subtotal),
      deposit: money(b.deposit),
      idLast4: b.idOnFile ? `…${esc(b.idLast4)}` : "not on file",
      signature: signatureBlock(b),
      date: esc(dt(new Date().toISOString())),
    };
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
  }
  return `
    <h1>Rental Contract — ${esc(b.ref)}</h1>
    ${bookingHeader(b)}
    ${linesTable(b)}
    <div class="meta">
      <div><b>Rental total</b>${money(b.subtotal)}</div>
      <div><b>Security deposit</b>${money(b.deposit)}</div>
      <div><b>Government ID on file</b>${b.idOnFile ? `Yes (…${esc(b.idLast4)})` : "No"}</div>
    </div>
    <h2>Condition at pickup / damages</h2>
    <div class="box" style="min-height:70px">${esc(rentals.map((l: any) => l.inspectionOut).filter(Boolean).join("; ")) || "&nbsp;"}</div>
    <p class="small">The customer acknowledges receiving the equipment listed above in the stated condition and agrees to
    return it by the end date. Late returns are billed per additional day. The deposit is refunded on return,
    less any charges for damage or missing items.</p>
    ${signatureBlock(b)}`;
}

function packingBody(b: any): string {
  const rentals = b.lines.filter((l: any) => l.type === "RENTAL");
  return `
    <h1>Packing List — ${esc(b.ref)}</h1>
    ${bookingHeader(b)}
    ${rentals.map((l: any) => {
      const kit = kitRows(l.productNo);
      return `<h2>${esc(l.productName)} <span class="small">(${esc(l.productNo)}) — pickup ${dt(l.from)}</span></h2>
      <table><tr><th style="width:30px"></th><th>Item</th><th>Description</th><th>Qty</th></tr>
      <tr><td><span class="checkbox"></span></td><td>${esc(l.productNo)}</td><td>${esc(l.productName)} (main unit)</td><td>${l.qty}</td></tr>
      ${kit.map((k) => `<tr><td><span class="checkbox"></span></td><td>${esc(k.itemNo)}</td><td>${esc(k.description)}</td><td>${k.qty * l.qty}</td></tr>`).join("")}
      </table>`;
    }).join("")}
    <div class="sig"><div>Prepared by</div><div>Checked with customer</div></div>`;
}

printRouter.get("/contract/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  res.send(page(`Contract ${b.ref}`, contractBody(b), pageOpts(req)));
});

printRouter.get("/packing-list/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  res.send(page(`Packing list ${b.ref}`, packingBody(b), pageOpts(req)));
});

printRouter.get("/confirmation/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  const courses = b.lines.filter((l: any) => l.type === "COURSE");
  res.send(page(`Confirmation ${b.ref}`, `
    <h1>Booking Confirmation — ${esc(b.ref)}</h1>
    ${bookingHeader(b)}
    <table><tr><th>Class</th><th>Date</th><th>Delivery</th><th>Seats</th><th>Total</th></tr>
    ${courses.map((l: any) => `<tr><td>${esc(l.productName)}</td><td>${dt(l.from)} – ${dt(l.to).split(",").pop()}</td><td>${esc((l.deliveryMode || "IN_PERSON").replace("_"," "))}${l.meetingUrl ? `<br><a href="${esc(l.meetingUrl)}">Join virtual class</a>` : ""}</td><td>${l.qty}</td><td>${money(l.lineTotal)}</td></tr>`).join("")}
    </table>
    <p>Total: <b>${money(b.subtotal)}</b> — Status: ${esc(b.status)}</p>
    <p class="small">Please arrive 10 minutes before the class starts. Bring your camera and a charged battery.</p>`, pageOpts(req)));
});

printRouter.get("/ticket/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  res.send(page(`Ticket ${b.ref}`, `<h1>eTicket — ${esc(b.ref)}</h1>${bookingHeader(b)}
    ${b.lines.map((l: any) => `<div class="box"><h2>${esc(l.productName)}</h2>
      <p>${dt(l.from)} – ${dt(l.to)} · ${l.qty} attendee${l.qty === 1 ? "" : "s"}</p>${barcode(l.bookingRef || b.ref)}</div>`).join("")}
    <p class="small">Present this ticket at check-in. Each ticket is valid only for the booking and quantity shown.</p>`, pageOpts(req)));
});

printRouter.get("/run-sheet", (req, res) => {
  const date = String(req.query.date || localDate());
  const storeId = String(req.query.storeId || "");
  const rows = db.prepare(`SELECT b.ref,b.status,b.customer_first,b.customer_last,b.customer_email,b.customer_phone,
    l.product_name,l.date_from,l.date_to,l.qty FROM bookings b JOIN booking_lines l ON l.booking_id=b.id
    WHERE b.status!='CANCELLED' AND date(l.date_from)=date(?) ${storeId ? "AND COALESCE(l.store_id,b.store_id)=?" : ""}
    ORDER BY l.date_from,b.ref`).all(...(storeId ? [date, storeId] : [date])) as any[];
  res.send(page(`Run sheet ${date}`, `<h1>Run Sheet — ${esc(date)}</h1><table>
    <tr><th>Time</th><th>Booking</th><th>Customer</th><th>Service</th><th>Qty</th><th>Status</th></tr>
    ${rows.map((r) => `<tr><td>${dt(r.date_from)}</td><td>${esc(r.ref)}</td><td>${esc(`${r.customer_first} ${r.customer_last}`)}<br><span class="small">${esc(r.customer_phone || r.customer_email)}</span></td><td>${esc(r.product_name)}</td><td>${r.qty}</td><td>${esc(r.status)}</td></tr>`).join("")}
    </table>`, pageOpts(req)));
});

printRouter.get("/enrollment/:sessionId", (req, res) => {
  const session = db.prepare(`SELECT s.*,p.name FROM sessions s JOIN products p ON p.id=s.product_id WHERE s.id=?`).get(req.params.sessionId) as any;
  if (!session) return res.status(404).send("Session not found");
  const rows = db.prepare(`SELECT b.ref,b.customer_first,b.customer_last,b.customer_email,b.customer_phone,l.qty,
    b.checked_in_at,b.no_show_at FROM booking_lines l JOIN bookings b ON b.id=l.booking_id
    WHERE l.session_id=? AND b.status!='CANCELLED' ORDER BY b.customer_last,b.customer_first`).all(session.id) as any[];
  res.send(page(`Enrollment ${session.name}`, `<h1>Enrollment — ${esc(session.name)}</h1>
    <p>${dt(session.starts_at)} · ${rows.reduce((n, r) => n + r.qty, 0)}/${session.capacity} enrolled</p>
    <table><tr><th></th><th>Customer</th><th>Contact</th><th>Seats</th><th>Attendance</th></tr>
    ${rows.map((r) => `<tr><td><span class="checkbox"></span></td><td>${esc(`${r.customer_first} ${r.customer_last}`)}<br><span class="small">${esc(r.ref)}</span></td><td>${esc(r.customer_email)}<br>${esc(r.customer_phone)}</td><td>${r.qty}</td><td>${r.checked_in_at ? "Checked in" : r.no_show_at ? "No-show" : ""}</td></tr>`).join("")}</table>`, pageOpts(req)));
});

/** Morning batch (R8): every packing list + contract for today's pickups. */
printRouter.get("/daily", (req, res) => {
  const date = String(req.query.date ?? localDate());
  const storeId = String(req.query.storeId ?? "");
  let sql = `SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
    WHERE l.type = 'RENTAL' AND date(l.date_from) = date(?) AND b.status IN ('RESERVED','POS_PENDING','PAID')`;
  const params: unknown[] = [date];
  if (storeId) { sql += " AND (b.store_id = ? OR l.store_id = ?)"; params.push(storeId, storeId); }
  const bookings = (db.prepare(sql).all(...params) as any[]).map((r) => serializeBooking(r.id)).filter(Boolean) as any[];
  if (!bookings.length) return res.send(page(`Daily paperwork ${date}`, `<h1>Daily paperwork — ${esc(date)}</h1><p>No rental pickups scheduled.</p>`, pageOpts(req)));
  const body = bookings
    .map((b, i) => packingBody(b) + '<div class="pagebreak"></div>' + contractBody(b) + (i < bookings.length - 1 ? '<div class="pagebreak"></div>' : ""))
    .join("");
  res.send(page(`Daily paperwork ${date}`, body, pageOpts(req)));
});
