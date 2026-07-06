// Printable documents (server-rendered HTML, print-ready):
//   /print/contract/:id      — rental contract w/ deposit, ID last-4, signature (R12-R13)
//   /print/packing-list/:id  — kit contents checklist per rental line (R8)
//   /print/daily             — morning batch: all of today's rental paperwork (R8)
//   /print/confirmation/:id  — course booking confirmation (class step 16)
import { Router } from "express";
import { db, localDate } from "../db.js";
import { serializeBooking } from "../lib/bookingService.js";

export const printRouter = Router();

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number) => `CA$${(Number(n) || 0).toFixed(2)}`;
const dt = (s: string) => (s ? new Date(s).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "");

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body { font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; color: #111; margin: 40px auto; max-width: 760px; }
    h1 { font-size: 20px; border-bottom: 2px solid #111; padding-bottom: 8px; }
    h2 { font-size: 15px; margin-top: 28px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .meta { display: flex; gap: 32px; flex-wrap: wrap; margin: 16px 0; }
    .meta div b { display: block; font-size: 11px; text-transform: uppercase; color: #666; }
    .sig { margin-top: 48px; display: flex; gap: 48px; }
    .sig div { flex: 1; border-top: 1px solid #111; padding-top: 6px; font-size: 11px; color: #555; }
    .box { border: 1px solid #ccc; padding: 10px 14px; margin: 12px 0; border-radius: 4px; }
    .small { font-size: 11px; color: #555; }
    .checkbox { display: inline-block; width: 12px; height: 12px; border: 1px solid #333; margin-right: 8px; vertical-align: -2px; }
    .pagebreak { page-break-after: always; }
    @media print { body { margin: 12mm; } }
  </style></head><body>${body}<script>if(new URLSearchParams(location.search).has("autoprint"))window.print()</script></body></html>`;
}

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

function contractBody(b: any): string {
  const rentals = b.lines.filter((l: any) => l.type === "RENTAL");
  return `
    <h1>Rental Contract — ${esc(b.ref)}</h1>
    ${bookingHeader(b)}
    <table><tr><th>Equipment</th><th>From</th><th>To</th><th>Days</th><th>Qty</th><th>Total</th></tr>
    ${rentals.map((l: any) => `<tr><td>${esc(l.productName)}<div class="small">${esc(l.productNo)} · NAV ${esc(l.activityNo || "-")}</div></td>
      <td>${dt(l.from)}</td><td>${dt(l.to)}</td><td>${l.days ?? "-"}</td><td>${l.qty}</td><td>${money(l.lineTotal)}</td></tr>`).join("")}
    </table>
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
    <div class="sig"><div>Customer signature</div><div>Staff signature</div><div>Date</div></div>`;
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
  res.send(page(`Contract ${b.ref}`, contractBody(b)));
});

printRouter.get("/packing-list/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  res.send(page(`Packing list ${b.ref}`, packingBody(b)));
});

printRouter.get("/confirmation/:id", (req, res) => {
  const b = serializeBooking(req.params.id);
  if (!b) return res.status(404).send("Booking not found");
  const courses = b.lines.filter((l: any) => l.type === "COURSE");
  res.send(page(`Confirmation ${b.ref}`, `
    <h1>Booking Confirmation — ${esc(b.ref)}</h1>
    ${bookingHeader(b)}
    <table><tr><th>Class</th><th>Date</th><th>Seats</th><th>Total</th></tr>
    ${courses.map((l: any) => `<tr><td>${esc(l.productName)}</td><td>${dt(l.from)} – ${dt(l.to).split(",").pop()}</td><td>${l.qty}</td><td>${money(l.lineTotal)}</td></tr>`).join("")}
    </table>
    <p>Total: <b>${money(b.subtotal)}</b> — Status: ${esc(b.status)}</p>
    <p class="small">Please arrive 10 minutes before the class starts. Bring your camera and a charged battery.</p>`));
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
  if (!bookings.length) return res.send(page(`Daily paperwork ${date}`, `<h1>Daily paperwork — ${esc(date)}</h1><p>No rental pickups scheduled.</p>`));
  const body = bookings
    .map((b, i) => packingBody(b) + '<div class="pagebreak"></div>' + contractBody(b) + (i < bookings.length - 1 ? '<div class="pagebreak"></div>' : ""))
    .join("");
  res.send(page(`Daily paperwork ${date}`, body));
});
