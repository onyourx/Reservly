// Booking creation + serialization shared by the admin API (staff store view) and
// the Shopify orders/create webhook (web channel) — one code path for both R4-R5
// and class steps 6-10.
import crypto from "node:crypto";
import { db, uid, now, pj, j } from "../db.js";
import { quoteLines, round2, type QuoteLineIn } from "../engine/pricing.js";
import { confirmReservation } from "./nav.js";
import { idLast4 } from "./crypto.js";
import { emit } from "./events.js";

export interface CustomerIn {
  email: string; firstName?: string; lastName?: string; phone?: string; b2b?: boolean;
}

function newRef(): string {
  return "BK-" + Date.now().toString(36).toUpperCase().slice(-5) + crypto.randomBytes(2).toString("hex").toUpperCase();
}

export async function createBooking(input: {
  customer: CustomerIn;
  storeId?: string;
  channel: "STAFF" | "WEB";
  notes?: string;
  lines: QuoteLineIn[];
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  paid?: boolean;
}) {
  if (!input.customer?.email) throw new Error("customer.email is required");
  if (!input.lines?.length) throw new Error("At least one line is required");
  const quoted = quoteLines(input.lines);

  const types = new Set(quoted.lines.map((l) => l.type));
  const type = types.size > 1 ? "MIXED" : [...types][0];
  const id = uid();
  const ref = newRef();
  const status = input.paid ? "PAID" : "RESERVED";

  db.prepare(
    `INSERT INTO bookings (id, ref, type, status, channel, store_id, customer_email, customer_first,
       customer_last, customer_phone, customer_b2b, subtotal, deposit, total, currency,
       shopify_order_id, shopify_order_name, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CAD', ?, ?, ?, ?, ?)`,
  ).run(
    id, ref, type, status, input.channel, input.storeId ?? null,
    input.customer.email, input.customer.firstName ?? "", input.customer.lastName ?? "",
    input.customer.phone ?? "", input.customer.b2b ? 1 : 0,
    quoted.subtotal, quoted.deposit, quoted.subtotal,
    input.shopifyOrderId ?? "", input.shopifyOrderName ?? "", input.notes ?? "", now(), now(),
  );

  for (const line of quoted.lines) {
    const lineId = uid();
    db.prepare(
      `INSERT INTO booking_lines (id, booking_id, type, product_no, product_name, session_id, store_id,
         date_from, date_to, qty, days, unit_price, line_total, deposit, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED')`,
    ).run(
      lineId, id, line.type, line.productNo, line.productName, line.sessionId ?? null,
      line.storeId ?? input.storeId ?? null, line.from, line.to, line.qty,
      line.days ?? null, line.unitPrice, line.lineTotal, line.deposit,
    );

    // Register the reservation in NAV (LS Activity). NAV enters it unpaid/draft;
    // the POS FreeText/BookingRef line flips it to paid on cart posting.
    try {
      const store = db.prepare("SELECT code FROM stores WHERE id = ?").get(line.storeId ?? input.storeId ?? "") as { code: string } | undefined;
      const nav = await confirmReservation({
        locationNo: store?.code ?? "",
        productNo: line.productNo,
        dateFrom: line.from.slice(0, 10),
        timeFrom: line.from.slice(11, 19) || "09:00:00",
        dateTo: line.type === "RENTAL" ? line.to.slice(0, 10) : "",
        timeTo: line.type === "RENTAL" ? line.to.slice(11, 19) || "17:00:00" : "",
        clientId: input.customer.email,
        quantity: line.qty,
      });
      db.prepare("UPDATE booking_lines SET activity_no = ?, booking_ref = ?, selling_item = ? WHERE id = ?")
        .run(nav.activityNo, nav.bookingRef, nav.sellingItem, lineId);
      // In live mode NAV's totals are authoritative for the POS push.
      if (nav.totalAmount > 0) {
        db.prepare("UPDATE booking_lines SET line_total = ?, unit_price = ? WHERE id = ?")
          .run(nav.totalAmount, nav.unitPrice, lineId);
      }
    } catch (err) {
      emit(id, "nav.reservation_failed", { line: line.productNo, error: String(err) });
    }
  }

  emit(id, "booking.created", { ref, type, channel: input.channel, email: input.customer.email, total: quoted.subtotal });
  return serializeBooking(id)!;
}

export function serializeBooking(id: string) {
  const b = db.prepare("SELECT * FROM bookings WHERE id = ? OR ref = ?").get(id, id) as any;
  if (!b) return null;
  const lines = (db.prepare("SELECT * FROM booking_lines WHERE booking_id = ? ORDER BY rowid").all(b.id) as any[]).map((l) => ({
    id: l.id, type: l.type, productNo: l.product_no, productName: l.product_name,
    sessionId: l.session_id, storeId: l.store_id, from: l.date_from, to: l.date_to,
    qty: l.qty, days: l.days, unitPrice: l.unit_price, lineTotal: l.line_total,
    deposit: l.deposit, status: l.status, activityNo: l.activity_no, bookingRef: l.booking_ref,
    sellingItem: l.selling_item, inspectionOut: l.inspection_out, inspectionIn: l.inspection_in,
    damages: pj(l.damages, [] as any[]),
  }));
  const events = (db.prepare("SELECT * FROM events WHERE booking_id = ? ORDER BY id DESC LIMIT 50").all(b.id) as any[]).map((e) => ({
    at: e.at, type: e.type, detail: pj(e.detail, {}),
  }));
  return {
    id: b.id, ref: b.ref, type: b.type, status: b.status, channel: b.channel, storeId: b.store_id,
    customer: {
      email: b.customer_email, firstName: b.customer_first, lastName: b.customer_last,
      phone: b.customer_phone, b2b: !!b.customer_b2b,
    },
    lines, subtotal: b.subtotal, deposit: b.deposit, total: b.total, posTotal: b.pos_total,
    refundDue: b.refund_due, currency: b.currency, posReceiptNo: b.pos_receipt_no,
    shopifyOrderId: b.shopify_order_id, shopifyOrderName: b.shopify_order_name,
    idOnFile: !!b.id_encrypted, idLast4: b.id_encrypted ? idLast4(b.id_encrypted) : "",
    contractSignedAt: b.contract_signed_at, notes: b.notes, createdAt: b.created_at, events,
    navRefs: lines.filter((l) => l.activityNo).map((l) => ({
      lineId: l.id, activityNo: l.activityNo, bookingRef: l.bookingRef, sellingItem: l.sellingItem,
    })),
  };
}

export function setStatus(bookingId: string, status: string, eventType: string, detail: Record<string, unknown> = {}) {
  db.prepare("UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), bookingId);
  emit(bookingId, eventType, detail);
}

export function recomputeRefund(bookingId: string) {
  const b = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as any;
  const lines = db.prepare("SELECT damages FROM booking_lines WHERE booking_id = ?").all(bookingId) as any[];
  const damageCharges = lines.reduce(
    (a, l) => a + pj<{ charge?: number }[]>(l.damages, []).reduce((x, d) => x + (Number(d.charge) || 0), 0),
    0,
  );
  // R18: deposit refunded minus damage charges (rental fees were already paid at pickup).
  const refund = round2(Math.max(0, b.deposit - damageCharges));
  db.prepare("UPDATE bookings SET refund_due = ?, updated_at = ? WHERE id = ?").run(refund, now(), bookingId);
  return refund;
}
