import { Router } from "express";
import crypto from "node:crypto";
import { db, now, j, localDate, auditLog, getSettings, currentTenant, DEFAULT_TENANT_SLUG } from "../db.js";
import { quoteLines, round2 } from "../engine/pricing.js";
import { rentalAvailability, courseSlots } from "../engine/availability.js";
import { createBooking, serializeBooking, setStatus, recomputeRefund } from "../lib/bookingService.js";
import { cancelReservation, webPosSuspend } from "../lib/nav.js";
import { encryptId } from "../lib/crypto.js";
import { emit } from "../lib/events.js";

export const bookingRouter = Router();

// --- Availability & quotes ---------------------------------------------------

bookingRouter.get("/availability/rental", async (req, res) => {
  const { productNo, storeId, from, to } = req.query as Record<string, string>;
  if (!productNo || !storeId || !from || !to) return res.status(400).json({ error: "productNo, storeId, from, to are required" });
  res.json(await rentalAvailability(productNo, storeId, from, to));
});

bookingRouter.get("/availability/course", (req, res) => {
  const { productNo, from, days } = req.query as Record<string, string>;
  if (!productNo) return res.status(400).json({ error: "productNo is required" });
  res.json({ slots: courseSlots(productNo, from || new Date().toISOString(), Number(days) || 60) });
});

bookingRouter.post("/quote", (req, res) => {
  try {
    const q = quoteLines(req.body?.lines ?? []);
    res.json({ ...q, currency: "CAD" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

// --- Bookings -----------------------------------------------------------------

bookingRouter.get("/bookings", (req, res) => {
  const { status, type, storeId, q, date } = req.query as Record<string, string>;
  let sql = "SELECT id FROM bookings WHERE 1=1";
  const params: unknown[] = [];
  if (status) { sql += " AND status = ?"; params.push(status); }
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (storeId) { sql += " AND store_id = ?"; params.push(storeId); }
  if (q) {
    sql += " AND (ref LIKE ? OR customer_email LIKE ? OR customer_last LIKE ? OR customer_first LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (date) {
    sql += " AND id IN (SELECT booking_id FROM booking_lines WHERE date(date_from) <= date(?) AND date(date_to) >= date(?))";
    params.push(date, date);
  }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = db.prepare(sql).all(...params) as { id: string }[];
  res.json({ bookings: rows.map((r) => serializeBooking(r.id)) });
});

bookingRouter.post("/bookings", async (req, res) => {
  try {
    const booking = await createBooking({
      customer: req.body?.customer,
      storeId: req.body?.storeId,
      channel: req.body?.channel === "WEB" ? "WEB" : "STAFF",
      notes: req.body?.notes,
      lines: req.body?.lines ?? [],
    });
    res.json({ booking });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

bookingRouter.get("/bookings/:id", (req, res) => {
  const booking = serializeBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  auditLog("booking.viewed", booking.ref, booking.customer.email);
  res.json({ booking });
});

function mustGet(id: string) {
  const b = db.prepare("SELECT * FROM bookings WHERE id = ? OR ref = ?").get(id, id) as any;
  if (!b) throw Object.assign(new Error("Booking not found"), { status: 404 });
  return b;
}

/** R3B / class 12-15: push to LS Retail POS as a suspended transaction. */
bookingRouter.post("/bookings/:id/push-pos", async (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const lines = db.prepare("SELECT * FROM booking_lines WHERE booking_id = ?").all(b.id) as any[];
    const receiptNo = `WEB-${b.ref}`;
    await webPosSuspend({
      receiptNo,
      customerEmail: b.customer_email,
      lines: lines.map((l) => ({
        sellingItem: l.selling_item || l.product_no,
        description: `${l.product_name} ${l.date_from.slice(0, 10)}`,
        amount: l.line_total,
        bookingRef: l.booking_ref || b.ref,
        qty: l.qty,
      })),
    });
    db.prepare("UPDATE bookings SET pos_receipt_no = ?, status = 'POS_PENDING', updated_at = ? WHERE id = ?").run(receiptNo, now(), b.id);
    emit(b.id, "booking.pos_pushed", { receiptNo });
    res.json({ receiptNo, booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 502).json({ error: String(err.message ?? err) });
  }
});

/** R3B follow-up: the POS may apply coupons — reconcile final financials here. */
bookingRouter.post("/bookings/:id/reconcile", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const posTotal = Number(req.body?.posTotal);
    if (!Number.isFinite(posTotal)) return res.status(400).json({ error: "posTotal (number) is required" });
    db.prepare("UPDATE bookings SET pos_total = ?, pos_receipt_no = COALESCE(NULLIF(?, ''), pos_receipt_no), status = CASE WHEN status IN ('RESERVED','POS_PENDING') THEN 'PAID' ELSE status END, updated_at = ? WHERE id = ?")
      .run(posTotal, String(req.body?.receiptNo ?? ""), now(), b.id);
    emit(b.id, "booking.reconciled", { posTotal, originalTotal: b.total });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** R8-R11: staff tick off every kit item while preparing / handing over. */
bookingRouter.put("/bookings/:id/checklist", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const { lineId, items } = req.body ?? {};
    if (!lineId || !Array.isArray(items)) return res.status(400).json({ error: "lineId and items[] are required" });
    const line = db.prepare("SELECT id FROM booking_lines WHERE id = ? AND booking_id = ?").get(lineId, b.id);
    if (!line) return res.status(404).json({ error: "Line not found" });
    const clean = items.map((i: any) => ({
      itemNo: String(i.itemNo ?? ""), description: String(i.description ?? ""),
      qty: Number(i.qty) || 1, checked: Boolean(i.checked),
    }));
    db.prepare("UPDATE booking_lines SET checklist = ? WHERE id = ?").run(j(clean), lineId);
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** E-signature: mint a one-time signing link; delivery (email) rides the event
 *  stream → Conduit → HubSpot, and staff can copy/text the link directly. */
bookingRouter.post("/bookings/:id/request-signature", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const token = crypto.randomBytes(24).toString("base64url");
    db.prepare("UPDATE bookings SET sign_token = ?, updated_at = ? WHERE id = ?").run(token, now(), b.id);
    const base = (getSettings().publicUrl || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const { slug } = currentTenant();
    const url = `${base}/sign/${token}${slug !== DEFAULT_TENANT_SLUG ? `?t=${slug}` : ""}`;
    emit(b.id, "booking.signature_requested", { email: b.customer_email, url });
    auditLog("signature.requested", b.ref, b.customer_email);
    res.json({ url, booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** R11-R14: pickup — inspection, deposit, encrypted government ID, contract. */
bookingRouter.post("/bookings/:id/pickup", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const { idNumber, depositAmount, inspection, signature } = req.body ?? {};
    if (idNumber) db.prepare("UPDATE bookings SET id_encrypted = ? WHERE id = ?").run(encryptId(String(idNumber)), b.id);
    if (depositAmount != null) db.prepare("UPDATE bookings SET deposit = ? WHERE id = ?").run(round2(Number(depositAmount) || 0), b.id);
    if (signature) db.prepare("UPDATE bookings SET contract_signed_at = ? WHERE id = ?").run(now(), b.id);
    if (inspection) db.prepare("UPDATE booking_lines SET inspection_out = ? WHERE booking_id = ?").run(String(inspection), b.id);
    db.prepare("UPDATE booking_lines SET status = 'PICKED_UP' WHERE booking_id = ? AND type = 'RENTAL'").run(b.id);
    setStatus(b.id, "PICKED_UP", "booking.picked_up", { deposit: depositAmount });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** R15-R18: return — inspection, damages, deposit refund computation. */
bookingRouter.post("/bookings/:id/return", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const { inspection, damages } = req.body ?? {};
    if (inspection) db.prepare("UPDATE booking_lines SET inspection_in = ? WHERE booking_id = ?").run(String(inspection), b.id);
    if (Array.isArray(damages) && damages.length) {
      db.prepare("UPDATE booking_lines SET damages = ? WHERE booking_id = ? AND type = 'RENTAL'").run(j(damages), b.id);
    }
    db.prepare("UPDATE booking_lines SET status = 'RETURNED' WHERE booking_id = ? AND type = 'RENTAL'").run(b.id);
    const refundDue = recomputeRefund(b.id);
    setStatus(b.id, "RETURNED", "booking.returned", { refundDue });
    res.json({ booking: serializeBooking(b.id), refundDue });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.post("/bookings/:id/complete", (req, res) => {
  try {
    const b = mustGet(req.params.id);
    db.prepare("UPDATE booking_lines SET status = 'COMPLETED' WHERE booking_id = ?").run(b.id);
    setStatus(b.id, "COMPLETED", "booking.completed");
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.post("/bookings/:id/cancel", async (req, res) => {
  try {
    const b = mustGet(req.params.id);
    const lines = db.prepare("SELECT * FROM booking_lines WHERE booking_id = ? AND activity_no != ''").all(b.id) as any[];
    for (const l of lines) {
      try {
        await cancelReservation(l.activity_no, b.customer_email);
      } catch (err) {
        emit(b.id, "nav.cancel_failed", { activityNo: l.activity_no, error: String(err) });
      }
    }
    db.prepare("UPDATE booking_lines SET status = 'CANCELLED' WHERE booking_id = ?").run(b.id);
    setStatus(b.id, "CANCELLED", "booking.cancelled", { reason: req.body?.reason ?? "" });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

// --- Dashboard ------------------------------------------------------------------

bookingRouter.get("/dashboard/today", (req, res) => {
  const storeId = String(req.query.storeId ?? "");
  const today = localDate();
  const storeCond = storeId ? " AND (b.store_id = ? OR l.store_id = ?)" : "";
  const params = storeId ? [today, storeId, storeId] : [today];

  const pickups = (db.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
     WHERE l.type = 'RENTAL' AND date(l.date_from) = date(?) AND b.status IN ('RESERVED','POS_PENDING','PAID')${storeCond}`,
  ).all(...params) as any[]).map((r) => serializeBooking(r.id));

  const returns = (db.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
     WHERE l.type = 'RENTAL' AND date(l.date_to) = date(?) AND b.status = 'PICKED_UP'${storeCond}`,
  ).all(...params) as any[]).map((r) => serializeBooking(r.id));

  const classes = (db.prepare(
    `SELECT s.id FROM sessions s WHERE date(s.starts_at) = date(?)${storeId ? " AND s.store_id = ?" : ""} ORDER BY s.starts_at`,
  ).all(...(storeId ? [today, storeId] : [today])) as any[]).map((r) => {
    const s = db.prepare("SELECT s.*, p.name AS product_name FROM sessions s JOIN products p ON p.id = s.product_id WHERE s.id = ?").get(r.id) as any;
    const booked = (db.prepare(
      `SELECT COALESCE(SUM(l.qty),0) AS n FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
       WHERE l.session_id = ? AND b.status IN ('RESERVED','POS_PENDING','PAID','PICKED_UP')`,
    ).get(s.id) as any).n;
    return { session: { id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, storeId: s.store_id }, productName: s.product_name, booked, capacity: s.capacity };
  });

  const stats = {
    activeRentals: (db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'PICKED_UP'").get() as any).n,
    // created_at is UTC ISO; 'localtime' folds it to the store's calendar day.
    todayRevenue: (db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM bookings WHERE date(created_at, 'localtime') = date(?) AND status != 'CANCELLED'").get(today) as any).n,
    upcoming7d: (db.prepare(
      `SELECT COUNT(DISTINCT booking_id) AS n FROM booking_lines
       WHERE date(date_from) BETWEEN date(?) AND date(?, '+7 day')`,
    ).get(today, today) as any).n,
    openDeposits: (db.prepare("SELECT COALESCE(SUM(deposit),0) AS n FROM bookings WHERE status = 'PICKED_UP'").get() as any).n,
  };

  res.json({ date: today, pickups, returns, classes, stats });
});
