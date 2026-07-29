import { Router, raw } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, now, j, localDate, auditLog, getSettings, currentTenant, DEFAULT_TENANT_SLUG } from "../db.js";
import { quoteLines, round2 } from "../engine/pricing.js";
import { rentalAvailability, courseSlots, serviceSlots } from "../engine/availability.js";
import { BookingValidationError, createBooking, serializeBooking, setStatus, recomputeRefund } from "../lib/bookingService.js";
import { cancelReservation, webPosSuspend } from "../lib/nav.js";
import { encryptId } from "../lib/crypto.js";
import { emit } from "../lib/events.js";
import { notifyWaitlistForBooking } from "../lib/waitlist.js";
import { cancelBookingNotifications, scheduleBookingReminders } from "../lib/notifications.js";
import { allowedStoreIds, requireOwner, requirePerm } from "../lib/auth.js";
import { createDraftInvoice, ensureShopifyCustomer, findShopifyCustomer } from "../lib/shopifyAdmin.js";
import { sendMail } from "../lib/mailer.js";
import { listPrinters, printDocument } from "../lib/printing.js";
import { refundQuote, validateRentalWindow } from "../lib/policy.js";
import { deleteIdPhoto, fetchIdPhoto, sftpConfigured, uploadIdPhoto } from "../lib/idPhotos.js";
import { DATA_DIR } from "../lib/platform.js";
import { sendClassTicketEmail } from "../lib/ticketEmail.js";

export const bookingRouter = Router();

bookingRouter.get("/extension-requests", requirePerm("bookings"), (req, res) => {
  const status = String(req.query.status || "");
  const storeIds = allowedStoreIds(req);
  let sql = `
    SELECT e.*, b.ref, b.customer_email, l.product_name, l.date_to
    FROM extension_requests e
    JOIN bookings b ON b.id = e.booking_id
    JOIN booking_lines l ON l.id = e.line_id
    WHERE 1=1
  `;
  const params: any[] = [];
  if (status) {
    sql += " AND e.status = ?";
    params.push(status);
  }
  if (storeIds !== "*") {
    sql += ` AND b.store_id IN (${storeIds.map(() => "?").join(",")})`;
    params.push(...storeIds);
  }
  sql += " ORDER BY e.created_at DESC";
  const rows = db.prepare(sql).all(...params) as any[];
  res.json({
    requests: rows.map((r) => ({
      id: r.id, bookingRef: r.ref, customerEmail: r.customer_email,
      productName: r.product_name, oldDateTo: r.old_date_to, newDateTo: r.new_date_to,
      price: r.price, status: r.status, decidedAt: r.decided_at, paidAt: r.paid_at,
      createdAt: r.created_at,
    })),
  });
});

bookingRouter.post("/extension-requests/:id/approve", requirePerm("bookings"), async (req, res) => {
  try {
    const row = db.prepare("SELECT booking_id FROM extension_requests WHERE id=?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "Extension request not found" });
    mustGet(req, row.booking_id);
    const { approveExtension } = await import("../lib/extensions.js");
    const result = await approveExtension(req.params.id);
    res.json({ ok: !!result });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

bookingRouter.post("/extension-requests/:id/reject", requirePerm("bookings"), async (req, res) => {
  try {
    const row = db.prepare("SELECT booking_id FROM extension_requests WHERE id=?").get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: "Extension request not found" });
    mustGet(req, row.booking_id);
    const { rejectExtension } = await import("../lib/extensions.js");
    const result = await rejectExtension(req.params.id, req.body?.reason);
    res.json({ ok: !!result });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: String(err.message || err) });
  }
});

bookingRouter.get("/printers", requirePerm("bookings"), async (_req, res) => {
  res.json(await listPrinters());
});

bookingRouter.post("/print", requirePerm("bookings"), async (req, res) => {
  try {
    const { doc, id, printer } = req.body ?? {};
    if (doc !== "contract" && doc !== "packing-list") {
      return res.status(400).json({ error: "Invalid document type" });
    }
    const booking = mustGet(req, String(id ?? ""));
    const path = `/print/${doc}/${encodeURIComponent(booking.id)}`;
    const jobId = await printDocument(path, String(printer ?? ""));
    auditLog("print.sent", booking.ref);
    return res.json({ ok: true, jobId });
  } catch (err: any) {
    if (err.status) return res.status(err.status).json({ error: String(err.message ?? err) });
    return res.status(502).json({ error: "print_failed", detail: String(err.message ?? err) });
  }
});

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

bookingRouter.get("/availability/service", (req, res) => {
  try {
    const { productNo, storeId, date } = req.query as Record<string, string>;
    if (!productNo || !storeId || !date) return res.status(400).json({ error: "productNo, storeId, date are required" });
    res.json(serviceSlots(productNo, storeId, date));
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

bookingRouter.get("/terms/:type", (req, res) => {
  const names: Record<string, string> = { rental: "Rental", course: "Course", service: "Service" };
  const name = names[req.params.type];
  if (!name) return res.status(404).json({ error: "Not found" });
  const settings = getSettings();
  if (settings[`terms${name}Pdf`] === "1") {
    const file = path.join(DATA_DIR, "uploads", "terms", `${currentTenant().slug}-${req.params.type}.pdf`);
    if (fs.existsSync(file)) {
      res.setHeader("Content-Type", "application/pdf");
      return res.send(fs.readFileSync(file));
    }
  }
  const terms = settings[`terms${name}Html`];
  if (!terms) return res.status(404).json({ error: "Not found" });
  res.type("html").send(`<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><style>body{font:16px sans-serif;max-width:800px;margin:0 auto;padding:20px;line-height:1.6}</style></head>
<body>${terms}</body>
</html>`);
});

bookingRouter.post("/quote", (req, res) => {
  try {
    const q = quoteLines(req.body?.lines ?? []);
    for (const line of q.lines) {
      if (line.type !== "RENTAL") continue;
      const validation = validateRentalWindow(line.from, line.to);
      if (!validation.ok) return res.status(400).json({ error: validation.error });
    }
    res.json({ ...q, currency: "CAD" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

// --- Bookings -----------------------------------------------------------------

bookingRouter.get("/bookings/:id/refund-quote", requirePerm("bookings"), (req, res) => {
  try {
    const booking = mustGet(req, req.params.id);
    const first = db.prepare("SELECT MIN(date_from) AS starts FROM booking_lines WHERE booking_id = ?").get(booking.id) as { starts: string | null };
    if (!first.starts) return res.status(404).json({ error: "Booking has no lines" });
    res.json({ ...refundQuote(booking, first.starts), bookingRef: booking.ref });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.get("/bookings", requirePerm("bookings"), (req, res) => {
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
  const allowed = allowedStoreIds(req);
  if (allowed !== "*") {
    if (allowed.length) {
      sql += ` AND (store_id IN (${allowed.map(() => "?").join(",")}) OR store_id IS NULL OR store_id = '')`;
      params.push(...allowed);
    } else {
      sql += " AND (store_id IS NULL OR store_id = '')";
    }
  }
  sql += " ORDER BY created_at DESC LIMIT 200";
  const rows = db.prepare(sql).all(...params) as { id: string }[];
  res.json({ bookings: rows.map((r) => serializeBooking(r.id)) });
});

bookingRouter.post("/bookings", requirePerm("bookings"), async (req, res) => {
  try {
    const booking = await createBooking({
      customer: req.body?.customer,
      storeId: req.body?.storeId,
      channel: req.body?.channel === "WEB" ? "WEB" : "STAFF",
      notes: req.body?.notes,
      lines: req.body?.lines ?? [],
      fieldResponses: req.body?.fieldResponses,
      termsAccepted: req.body?.termsAccepted,
    });
    const settings = getSettings();
    const isConfigured = settings.shopifyShop?.trim() && settings.shopifyApiSecret;
    if (booking.channel === "STAFF" && isConfigured) {
      void ensureShopifyCustomer({
        email: booking.customer.email,
        firstName: booking.customer.firstName,
        lastName: booking.customer.lastName,
        phone: booking.customer.phone,
      }).catch((e) => console.warn("[shopify] customer sync failed:", (e as Error).message));
    }
    res.json({ booking });
  } catch (err) {
    res.status(400).json(err instanceof BookingValidationError ? err.payload : { error: String((err as Error).message ?? err) });
  }
});

bookingRouter.get("/customers/lookup", requirePerm("bookings"), async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const settings = getSettings();
  const isConfigured = settings.shopifyShop?.trim() && settings.shopifyApiSecret;
  if (isConfigured) {
    try {
      const customer = await findShopifyCustomer(email);
      if (customer) {
        return res.json({
          found: true,
          source: "shopify",
          customer: {
            email: customer.email,
            firstName: customer.firstName,
            lastName: customer.lastName,
            phone: customer.phone,
          },
        });
      }
    } catch (err) {
      console.warn("[shopify] customer lookup failed:", (err as Error).message);
    }
  }

  const customer = db.prepare(
    `SELECT customer_first, customer_last, customer_phone, customer_email
     FROM bookings
     WHERE customer_email = ? COLLATE NOCASE
     ORDER BY created_at DESC
     LIMIT 1`,
  ).get(email) as {
    customer_first: string;
    customer_last: string;
    customer_phone: string;
    customer_email: string;
  } | undefined;
  if (customer) {
    return res.json({
      found: true,
      source: "local",
      customer: {
        email: customer.customer_email,
        firstName: customer.customer_first,
        lastName: customer.customer_last,
        phone: customer.customer_phone,
      },
    });
  }

  res.json({ found: false });
});

bookingRouter.get("/bookings/:id", requirePerm("bookings"), (req, res) => {
  const booking = serializeBooking(req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  const allowed = allowedStoreIds(req);
  if (allowed !== "*" && booking.storeId && !allowed.includes(booking.storeId)) {
    return res.status(404).json({ error: "not_found" });
  }
  auditLog("booking.viewed", booking.ref, booking.customer.email);
  res.json({ booking });
});

function mustGet(req: import("express").Request, id: string) {
  const b = db.prepare("SELECT * FROM bookings WHERE id = ? OR ref = ?").get(id, id) as any;
  if (!b) throw Object.assign(new Error("Booking not found"), { status: 404 });
  const allowed = allowedStoreIds(req);
  if (allowed !== "*" && b.store_id && !allowed.includes(b.store_id)) {
    throw Object.assign(new Error("not_found"), { status: 404 });
  }
  return b;
}

const idPhotoRaw = raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "10mb" });

bookingRouter.post("/bookings/:id/id-photo", requirePerm("bookings"), (req, res, next) => {
  idPhotoRaw(req, res, (error) => {
    if (error) {
      const oversized = (error as any).type === "entity.too.large";
      return res.status(400).json({ error: oversized ? "image_too_large" : "invalid_image" });
    }
    next();
  });
}, async (req, res) => {
  try {
    const booking = mustGet(req, req.params.id);
    if (!sftpConfigured()) return res.status(400).json({ error: "sftp_not_configured" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0 || req.body.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: "invalid_image" });
    }
    const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      return res.status(400).json({ error: "invalid_image_type" });
    }
    const remoteName = await uploadIdPhoto(booking.ref, req.body, mime);
    const capturedAt = now();
    db.prepare("UPDATE bookings SET id_photo_ref = ?, id_photo_at = ?, updated_at = ? WHERE id = ?")
      .run(remoteName, capturedAt, capturedAt, booking.id);
    auditLog("id_photo.captured", booking.ref);
    return res.json({ ok: true, idPhotoAt: capturedAt });
  } catch (error) {
    return res.status((error as any).status || 502).json({ error: String((error as Error).message || error) });
  }
});

bookingRouter.get("/bookings/:id/id-photo", requirePerm("bookings"), async (req, res) => {
  try {
    const booking = mustGet(req, req.params.id);
    if (!booking.id_photo_ref) return res.status(404).json({ error: "id_photo_not_found" });
    const photo = await fetchIdPhoto(booking.id_photo_ref);
    auditLog("id_photo.viewed", booking.ref);
    res.setHeader("Content-Type", photo.mime);
    res.setHeader("Cache-Control", "no-store");
    return res.send(photo.buffer);
  } catch (error) {
    return res.status((error as any).status || 502).json({ error: String((error as Error).message || error) });
  }
});

bookingRouter.delete("/bookings/:id/id-photo", requireOwner, async (req, res) => {
  try {
    const booking = mustGet(req, req.params.id);
    if (booking.id_photo_ref) await deleteIdPhoto(booking.id_photo_ref).catch(() => undefined);
    const changedAt = now();
    db.prepare("UPDATE bookings SET id_photo_ref = '', id_photo_at = '', updated_at = ? WHERE id = ?")
      .run(changedAt, booking.id);
    auditLog("id_photo.deleted", booking.ref);
    return res.json({ ok: true });
  } catch (error) {
    return res.status((error as any).status || 500).json({ error: String((error as Error).message || error) });
  }
});

/** R3B / class 12-15: push to LS Retail POS as a suspended transaction. */
bookingRouter.post("/bookings/:id/push-pos", requirePerm("bookings"), async (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
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
bookingRouter.post("/bookings/:id/reconcile", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const posTotal = Number(req.body?.posTotal);
    if (!Number.isFinite(posTotal)) return res.status(400).json({ error: "posTotal (number) is required" });
    db.prepare("UPDATE bookings SET pos_total = ?, pos_receipt_no = COALESCE(NULLIF(?, ''), pos_receipt_no), status = CASE WHEN status IN ('RESERVED','POS_PENDING') THEN 'PAID' ELSE status END, updated_at = ? WHERE id = ?")
      .run(posTotal, String(req.body?.receiptNo ?? ""), now(), b.id);
    void sendClassTicketEmail(b.id).catch((err) => console.warn("[ticketEmail]", err));
    emit(b.id, "booking.reconciled", { posTotal, originalTotal: b.total });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** R8-R11: staff tick off every kit item while preparing / handing over. */
bookingRouter.put("/bookings/:id/checklist", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
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
bookingRouter.post("/bookings/:id/request-signature", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
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
bookingRouter.post("/bookings/:id/pickup", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const { idNumber, depositAmount, inspection, signature, unitAssignments } = req.body ?? {};
    if (idNumber) db.prepare("UPDATE bookings SET id_encrypted = ? WHERE id = ?").run(encryptId(String(idNumber)), b.id);
    if (depositAmount != null) db.prepare("UPDATE bookings SET deposit = ? WHERE id = ?").run(round2(Number(depositAmount) || 0), b.id);
    if (signature) db.prepare("UPDATE bookings SET contract_signed_at = ? WHERE id = ?").run(now(), b.id);
    if (inspection) db.prepare("UPDATE booking_lines SET inspection_out = ? WHERE booking_id = ?").run(String(inspection), b.id);
    if (unitAssignments && typeof unitAssignments === "object") {
      const pending: { lineId: string; unitId: string }[] = [];
      const selected = new Set<string>();
      for (const [lineId, unitIds] of Object.entries(unitAssignments as Record<string, unknown>)) {
        const line = db.prepare("SELECT id, qty FROM booking_lines WHERE id = ? AND booking_id = ? AND type = 'RENTAL'").get(lineId, b.id) as any;
        if (!line || !Array.isArray(unitIds) || unitIds.length !== line.qty) {
          return res.status(400).json({ error: `Assign exactly ${line?.qty ?? 0} rental unit(s) to each rental line` });
        }
        for (const unitId of unitIds) {
          const key = String(unitId);
          if (selected.has(key)) return res.status(400).json({ error: "A rental unit can only be assigned once" });
          const unit = db.prepare(`SELECT u.id FROM rental_units u JOIN booking_lines l ON l.id = ?
            JOIN products p ON p.product_no = l.product_no
            WHERE u.id = ? AND u.product_id = p.id AND u.status = 'AVAILABLE'`).get(lineId, key);
          if (!unit) return res.status(409).json({ error: "A selected rental unit is no longer available" });
          selected.add(key);
          pending.push({ lineId, unitId: key });
        }
      }
      db.transaction(() => {
        for (const item of pending) {
          db.prepare("INSERT INTO booking_line_units (booking_line_id, unit_id, assigned_at) VALUES (?, ?, ?)").run(item.lineId, item.unitId, now());
          db.prepare("UPDATE rental_units SET status = 'ON_RENT', updated_at = ? WHERE id = ?").run(now(), item.unitId);
        }
      })();
    }
    db.prepare("UPDATE booking_lines SET status = 'PICKED_UP' WHERE booking_id = ? AND type = 'RENTAL'").run(b.id);
    setStatus(b.id, "PICKED_UP", "booking.picked_up", { deposit: depositAmount });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

/** R15-R18: return — inspection, damages, deposit refund computation. */
bookingRouter.post("/bookings/:id/return", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const { inspection, damages, unitConditions } = req.body ?? {};
    if (inspection) db.prepare("UPDATE booking_lines SET inspection_in = ? WHERE booking_id = ?").run(String(inspection), b.id);
    if (Array.isArray(damages) && damages.length) {
      db.prepare("UPDATE booking_lines SET damages = ? WHERE booking_id = ? AND type = 'RENTAL'").run(j(damages), b.id);
    }
    db.prepare("UPDATE booking_lines SET status = 'RETURNED' WHERE booking_id = ? AND type = 'RENTAL'").run(b.id);
    const assigned = db.prepare(`SELECT x.unit_id FROM booking_line_units x JOIN booking_lines l ON l.id=x.booking_line_id
      WHERE l.booking_id=? AND x.returned_at IS NULL`).all(b.id) as { unit_id: string }[];
    for (const { unit_id } of assigned) {
      const condition = String(unitConditions?.[unit_id] || "GOOD");
      const unit = db.prepare("SELECT usage_count,next_service_usage,next_service_at FROM rental_units WHERE id=?").get(unit_id) as any;
      const nextUsage = Number(unit?.usage_count || 0) + 1;
      const serviceDue = (unit?.next_service_usage != null && nextUsage >= unit.next_service_usage)
        || (unit?.next_service_at && unit.next_service_at <= now());
      const status = condition === "DAMAGED" || serviceDue ? "SERVICE" : "AVAILABLE";
      db.prepare("UPDATE rental_units SET condition=?, status=?, usage_count=?, updated_at=? WHERE id=?").run(condition, status, nextUsage, now(), unit_id);
      if (serviceDue) emit(b.id, "rental.maintenance_due", { unitId: unit_id, usageCount: nextUsage });
      db.prepare("UPDATE booking_line_units SET returned_at=? WHERE unit_id=? AND booking_line_id IN (SELECT id FROM booking_lines WHERE booking_id=?)").run(now(), unit_id, b.id);
    }
    const lateFee = (db.prepare(`SELECT COALESCE(SUM(
      CASE WHEN julianday(?) > julianday(l.date_to)
      THEN CEIL(julianday(?) - julianday(l.date_to)) * COALESCE(NULLIF(p.late_fee_per_day,0),p.default_unit_price) * l.qty
      ELSE 0 END),0) AS n
      FROM booking_lines l JOIN products p ON p.product_no=l.product_no
      WHERE l.booking_id=? AND l.type='RENTAL'`).get(now(), now(), b.id) as any).n;
    const refundDue = recomputeRefund(b.id);
    setStatus(b.id, "RETURNED", "booking.returned", { refundDue, lateFeeSuggested: round2(lateFee) });
    res.json({ booking: serializeBooking(b.id), refundDue, lateFeeSuggested: round2(lateFee) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.post("/bookings/:id/complete", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    db.prepare("UPDATE booking_lines SET status = 'COMPLETED' WHERE booking_id = ?").run(b.id);
    setStatus(b.id, "COMPLETED", "booking.completed");
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.post("/bookings/:id/cancel", requirePerm("bookings"), async (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const first = db.prepare("SELECT MIN(date_from) AS starts FROM booking_lines WHERE booking_id = ?").get(b.id) as { starts: string | null };
    if (!first.starts) return res.status(404).json({ error: "Booking has no lines" });
    const quote = refundQuote(b, first.starts);
    const lines = db.prepare("SELECT * FROM booking_lines WHERE booking_id = ? AND activity_no != ''").all(b.id) as any[];
    for (const l of lines) {
      try {
        await cancelReservation(l.activity_no, b.customer_email);
      } catch (err) {
        emit(b.id, "nav.cancel_failed", { activityNo: l.activity_no, error: String(err) });
      }
    }
    db.prepare("UPDATE booking_lines SET status = 'CANCELLED' WHERE booking_id = ?").run(b.id);
    if (quote.enabled === true) {
      db.prepare("UPDATE bookings SET refund_due = ? WHERE id = ?").run(quote.amount, b.id);
    }
    setStatus(b.id, "CANCELLED", "booking.cancelled", { reason: req.body?.reason ?? "" });
    cancelBookingNotifications(b.id);
    notifyWaitlistForBooking(b.id);
    res.json({ booking: serializeBooking(b.id), quote });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message ?? err) });
  }
});

bookingRouter.post("/bookings/:id/reschedule", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const { lineId, from, to, sessionId, storeId } = req.body ?? {};
    const line = db.prepare("SELECT * FROM booking_lines WHERE id=? AND booking_id=?").get(lineId, b.id) as any;
    if (!line) return res.status(404).json({ error: "Booking line not found" });
    if (!from || !to || new Date(to) <= new Date(from)) return res.status(400).json({ error: "A valid from/to range is required" });
    if (line.type === "COURSE") {
      const session = db.prepare(`SELECT s.* FROM sessions s JOIN products p ON p.id=s.product_id
        WHERE s.id=? AND p.product_no=?`).get(sessionId, line.product_no) as any;
      if (!session) return res.status(400).json({ error: "A matching session is required" });
      const occupied = db.prepare(`SELECT COALESCE(SUM(l.qty),0) n FROM booking_lines l JOIN bookings x ON x.id=l.booking_id
        WHERE l.session_id=? AND l.id<>? AND x.status IN ('RESERVED','POS_PENDING','PAID','PICKED_UP')`).get(sessionId, line.id) as any;
      if (occupied.n + line.qty > session.capacity) return res.status(409).json({ error: "The selected session is full" });
      db.prepare("UPDATE booking_lines SET session_id=?,store_id=?,date_from=?,date_to=? WHERE id=?")
        .run(session.id, session.store_id, session.starts_at, session.ends_at, line.id);
    } else {
      db.prepare("UPDATE booking_lines SET store_id=?,date_from=?,date_to=? WHERE id=?")
        .run(storeId || line.store_id, from, to, line.id);
    }
    db.prepare("UPDATE bookings SET store_id=COALESCE(?,store_id),reschedule_count=reschedule_count+1,updated_at=? WHERE id=?")
      .run(storeId || null, now(), b.id);
    emit(b.id, "booking.rescheduled", { lineId, from, to, sessionId: sessionId || null, storeId: storeId || null });
    scheduleBookingReminders(b.id);
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message || err) });
  }
});

bookingRouter.post("/bookings/:id/check-in", requirePerm("bookings"), (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    db.prepare("UPDATE bookings SET checked_in_at=?,no_show_at=NULL,updated_at=? WHERE id=?").run(now(), now(), b.id);
    emit(b.id, "booking.checked_in", {});
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) { res.status(err.status ?? 500).json({ error: String(err.message || err) }); }
});

bookingRouter.post("/bookings/:id/no-show", requirePerm("bookings"), async (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    const at = now();
    db.prepare("UPDATE bookings SET no_show_at=?,updated_at=? WHERE id=?").run(at, at, b.id);
    emit(b.id, "booking.no_show", { reason: String(req.body?.reason || "") });
    auditLog("booking.no_show", b.ref, String(req.body?.reason || ""));

    const settings = getSettings();
    const mode = settings.noShowFeeMode;
    const configuredValue = Number(settings.noShowFeeValue);
    const fee = mode === "percent"
      ? Math.round(Number(b.total) * (configuredValue / 100) * 100) / 100
      : mode === "fixed" ? configuredValue : 0;
    let status = "";

    if ((mode === "percent" || mode === "fixed") && Number.isFinite(fee) && fee > 0) {
      db.prepare(`UPDATE bookings SET no_show_fee=?,no_show_fee_status='',
        no_show_draft_order_id='',updated_at=? WHERE id=?`).run(fee, now(), b.id);

      let draft: { draftOrderId: string; invoiceUrl: string } | null = null;
      if (settings.shopifyApiSecret) {
        draft = await createDraftInvoice({
          customerEmail: b.customer_email,
          customerFirstName: b.customer_first,
          customerLastName: b.customer_last,
          customerPhone: b.customer_phone,
          title: `No-show fee — ${b.ref}`,
          price: fee,
          customAttributes: [{ key: "reservly_noshow_ref", value: b.id }],
        });
      }

      status = draft ? "INVOICED" : "PENDING_PAYMENT";
      db.prepare(`UPDATE bookings SET no_show_fee_status=?,no_show_draft_order_id=?,
        updated_at=? WHERE id=?`).run(status, draft?.draftOrderId || "", now(), b.id);

      const amount = `$${fee.toFixed(2)}`;
      const paymentMessage = draft
        ? `Please pay the no-show fee of ${amount} here: ${draft.invoiceUrl}`
        : `A no-show fee of ${amount} is payable at the store`;
      try {
        await sendMail({
          to: b.customer_email,
          subject: `No-show fee — ${b.ref}`,
          text: paymentMessage,
        });
      } catch (err) {
        console.error("[bookings] no-show fee email failed:", err);
      }
      auditLog("booking.no_show_fee_charged", b.ref, `${amount} ${status}`);
    }

    res.json({ booking: serializeBooking(b.id), noShowFee: { amount: fee > 0 ? fee : 0, status } });
  } catch (err: any) { res.status(err.status ?? 500).json({ error: String(err.message || err) }); }
});

bookingRouter.post("/bookings/:id/waive-no-show-fee", requireOwner, (req, res) => {
  try {
    const b = mustGet(req, req.params.id);
    if (!(Number(b.no_show_fee) > 0)) return res.status(400).json({ error: "No no-show fee exists" });
    if (b.no_show_fee_status === "PAID") return res.status(400).json({ error: "A paid no-show fee cannot be waived" });
    db.prepare("UPDATE bookings SET no_show_fee_status='WAIVED',updated_at=? WHERE id=?").run(now(), b.id);
    auditLog("booking.no_show_fee_waived", b.ref, `$${Number(b.no_show_fee).toFixed(2)}`);
    emit(b.id, "booking.no_show_fee_waived", { amount: Number(b.no_show_fee) });
    res.json({ booking: serializeBooking(b.id) });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: String(err.message || err) });
  }
});

bookingRouter.get("/reports/appointments.csv", requirePerm("reports"), (req, res) => {
  const from = String(req.query.from || "0000-01-01");
  const to = String(req.query.to || "9999-12-31");
  const rows = db.prepare(`SELECT b.ref,b.status,b.type,b.channel,b.customer_email,b.customer_first,b.customer_last,
    b.subtotal,b.deposit,b.total,b.created_at,l.product_no,l.product_name,l.date_from,l.date_to,l.qty
    FROM bookings b JOIN booking_lines l ON l.booking_id=b.id
    WHERE date(l.date_from) BETWEEN date(?) AND date(?) ORDER BY l.date_from`).all(from, to) as any[];
  const columns = ["ref","status","type","channel","customer_email","customer_first","customer_last","subtotal","deposit","total","created_at","product_no","product_name","date_from","date_to","qty"];
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  res.type("text/csv").attachment(`reservly-appointments-${from}-${to}.csv`)
    .send([columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n"));
});

bookingRouter.get("/reports/bookings.csv", requirePerm("reports"), (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(from) || !validDate(to)) {
    return res.status(400).json({ error: "A valid from/to date range is required" });
  }
  if (from > to) {
    return res.status(400).json({ error: "The from date must be on or before the to date" });
  }

  const allowed = allowedStoreIds(req);
  let storeCondition = "";
  const params: unknown[] = [from, to];
  if (allowed !== "*") {
    storeCondition = allowed.length
      ? ` AND b.store_id IN (${allowed.map(() => "?").join(",")})`
      : " AND 1=0";
    params.push(...allowed);
  }
  const rows = db.prepare(`SELECT b.ref AS booking_ref,b.status,b.type,b.channel,s.name AS store,
    b.customer_email,TRIM(COALESCE(b.customer_first,'') || ' ' || COALESCE(b.customer_last,'')) AS customer_name,
    b.created_at,b.subtotal,b.deposit,b.total,b.pos_total,b.refund_due,b.currency,b.pos_receipt_no,
    b.shopify_order_name,
    (SELECT GROUP_CONCAT(summary, ' | ') FROM (
      SELECT l.qty || '×' || l.product_name || ' ' || l.date_from || '→' || l.date_to AS summary
      FROM booking_lines l WHERE l.booking_id=b.id ORDER BY l.id
    )) AS line_summary,
    (SELECT GROUP_CONCAT(entry, ' | ') FROM (
      SELECT e.at || ' ' || e.type AS entry FROM events e WHERE e.booking_id=b.id ORDER BY e.at
    )) AS timeline
    FROM bookings b
    LEFT JOIN stores s ON s.id=b.store_id
    WHERE date(b.created_at) BETWEEN date(?) AND date(?)${storeCondition}
    ORDER BY b.created_at DESC`).all(...params) as any[];
  const columns = ["booking_ref","status","type","channel","store","customer_email","customer_name","created_at",
    "subtotal","deposit","total","pos_total","refund_due","currency","pos_receipt_no","shopify_order_name",
    "line_summary","timeline"];
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return res.type("text/csv").attachment(`bookings-${from}-${to}.csv`)
    .send([columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n"));
});

bookingRouter.get("/reports/summary", requirePerm("reports"), (req, res) => {
  const from = String(req.query.from || "0000-01-01");
  const to = String(req.query.to || "9999-12-31");
  const topServices = db.prepare(`SELECT l.product_no AS productNo,l.product_name AS name,
    COUNT(DISTINCT b.id) AS bookings,SUM(l.qty) AS units,SUM(l.line_total) AS sales
    FROM booking_lines l JOIN bookings b ON b.id=l.booking_id
    WHERE b.status!='CANCELLED' AND date(l.date_from) BETWEEN date(?) AND date(?)
    GROUP BY l.product_no,l.product_name ORDER BY sales DESC`).all(from, to);
  const totals = db.prepare(`SELECT COUNT(*) bookings,COALESCE(SUM(total),0) sales,
    COALESCE(AVG(total),0) averageOrder FROM bookings WHERE status!='CANCELLED'
    AND date(created_at) BETWEEN date(?) AND date(?)`).get(from, to);
  res.json({ from, to, totals, topServices });
});

bookingRouter.get("/waitlist", requirePerm("bookings"), (req, res) => {
  const status = String(req.query.status || "");
  const rows = db.prepare(`SELECT * FROM waitlist ${status ? "WHERE status=?" : ""} ORDER BY created_at DESC`)
    .all(...(status ? [status] : []));
  res.json({ waitlist: rows });
});

bookingRouter.delete("/waitlist/:id", requirePerm("bookings"), (req, res) => {
  db.prepare("DELETE FROM waitlist WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// --- Dashboard ------------------------------------------------------------------

bookingRouter.get("/dashboard/today", (req, res) => {
  const storeId = String(req.query.storeId ?? "");
  const today = localDate();
  const storeCond = storeId ? " AND (b.store_id = ? OR l.store_id = ?)" : "";
  const allowed = allowedStoreIds(req);
  const accessCond = allowed === "*"
    ? ""
    : allowed.length
      ? ` AND (b.store_id IN (${allowed.map(() => "?").join(",")}) OR b.store_id IS NULL OR b.store_id = '')`
      : " AND (b.store_id IS NULL OR b.store_id = '')";
  const params = storeId ? [today, storeId, storeId] : [today];
  if (allowed !== "*") params.push(...allowed);
  const statsParams = allowed === "*" ? [] : allowed;

  const pickups = (db.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
     WHERE l.type = 'RENTAL' AND date(l.date_from) = date(?) AND b.status IN ('RESERVED','POS_PENDING','PAID')${storeCond}${accessCond}`,
  ).all(...params) as any[]).map((r) => serializeBooking(r.id));

  const returns = (db.prepare(
    `SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
     WHERE l.type = 'RENTAL' AND date(l.date_to) = date(?) AND b.status = 'PICKED_UP'${storeCond}${accessCond}`,
  ).all(...params) as any[]).map((r) => serializeBooking(r.id));

  const classes = (db.prepare(
    `SELECT s.id FROM sessions s WHERE date(s.starts_at) = date(?)${storeId ? " AND s.store_id = ?" : ""} ORDER BY s.starts_at`,
  ).all(...(storeId ? [today, storeId] : [today])) as any[]).map((r) => {
    const s = db.prepare("SELECT s.*, p.name AS product_name FROM sessions s JOIN products p ON p.id = s.product_id WHERE s.id = ?").get(r.id) as any;
    const booked = (db.prepare(
      `SELECT COALESCE(SUM(l.qty),0) AS n FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
       WHERE l.session_id = ? AND b.status IN ('RESERVED','POS_PENDING','PAID','PICKED_UP')${accessCond}`,
    ).get(s.id, ...statsParams) as any).n;
    return { session: { id: s.id, startsAt: s.starts_at, endsAt: s.ends_at, storeId: s.store_id }, productName: s.product_name, booked, capacity: s.capacity };
  });

  const statsAccessCond = allowed === "*"
    ? ""
    : allowed.length
      ? ` AND (store_id IN (${allowed.map(() => "?").join(",")}) OR store_id IS NULL OR store_id = '')`
      : " AND (store_id IS NULL OR store_id = '')";
  const stats = {
    activeRentals: (db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'PICKED_UP'${statsAccessCond}`).get(...statsParams) as any).n,
    // created_at is UTC ISO; 'localtime' folds it to the store's calendar day.
    todayRevenue: (db.prepare(`SELECT COALESCE(SUM(total),0) AS n FROM bookings WHERE date(created_at, 'localtime') = date(?) AND status != 'CANCELLED'${statsAccessCond}`).get(today, ...statsParams) as any).n,
    upcoming7d: (db.prepare(
      `SELECT COUNT(DISTINCT l.booking_id) AS n FROM booking_lines l JOIN bookings b ON b.id=l.booking_id
       WHERE date(l.date_from) BETWEEN date(?) AND date(?, '+7 day')${accessCond}`,
    ).get(today, today, ...statsParams) as any).n,
    openDeposits: (db.prepare(`SELECT COALESCE(SUM(deposit),0) AS n FROM bookings WHERE status = 'PICKED_UP'${statsAccessCond}`).get(...statsParams) as any).n,
  };

  res.json({ date: today, pickups, returns, classes, stats });
});

/** Unified daily control surface inspired by LS Activity's availability matrix
 * and Booxi's operational calendar. It intentionally derives readiness and
 * exceptions from existing booking state instead of adding another workflow. */
bookingRouter.get("/operations", (req, res) => {
  const date = String(req.query.date || localDate());
  const storeId = String(req.query.storeId || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }

  const allowed = allowedStoreIds(req);
  const accessCond = allowed === "*"
    ? ""
    : allowed.length
      ? `AND (b.store_id IN (${allowed.map(() => "?").join(",")}) OR b.store_id IS NULL OR b.store_id = '')`
      : "AND (b.store_id IS NULL OR b.store_id = '')";
  const queryParams: unknown[] = storeId
    ? [date, date, date, date, storeId, storeId]
    : [date, date, date, date];
  if (allowed !== "*") queryParams.push(...allowed);
  const rows = db.prepare(
    `SELECT DISTINCT b.id
       FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
      WHERE b.status != 'CANCELLED'
        AND (date(l.date_from) = date(?) OR date(l.date_to) = date(?)
             OR (l.type = 'RENTAL' AND date(l.date_from) < date(?) AND date(l.date_to) > date(?)))
        ${storeId ? "AND (b.store_id = ? OR l.store_id = ?)" : ""}
        ${accessCond}
      ORDER BY l.date_from, b.ref`,
  ).all(...queryParams) as { id: string }[];

  const bookings = rows.map((r) => serializeBooking(r.id)).filter(Boolean) as any[];
  const items: any[] = [];
  const attention: any[] = [];
  const seenAttention = new Set<string>();

  const flag = (booking: any, kind: string, label: string, severity: "warning" | "critical", at: string) => {
    const key = `${booking.id}:${kind}`;
    if (seenAttention.has(key)) return;
    seenAttention.add(key);
    attention.push({
      id: key, bookingId: booking.id, ref: booking.ref, customer: booking.customer,
      kind, label, severity, at,
    });
  };

  for (const booking of bookings) {
    for (const line of booking.lines) {
      const startsToday = line.from.slice(0, 10) === date;
      const endsToday = line.to.slice(0, 10) === date;
      const spansToday = line.type === "RENTAL" && line.from.slice(0, 10) < date && line.to.slice(0, 10) > date;
      if (!startsToday && !endsToday && !spansToday) continue;

      const checklistTotal = line.checklist?.length || 0;
      const checklistDone = line.checklist?.filter((x: any) => x.checked).length || 0;
      const signed = Boolean(booking.contractSignedAt);
      const paid = !["RESERVED", "POS_PENDING"].includes(booking.status);
      const phase = line.type === "COURSE" ? "CLASS" : startsToday ? "PICKUP" : endsToday ? "RETURN" : "ON_RENT";
      items.push({
        id: `${booking.id}:${line.id}:${phase}`,
        bookingId: booking.id, ref: booking.ref, type: line.type, phase,
        startsAt: phase === "RETURN" ? line.to : line.from,
        endsAt: line.to, productName: line.productName, qty: line.qty,
        customer: booking.customer, status: booking.status,
        readiness: { paid, signed, checklistDone, checklistTotal },
      });

      if (line.type === "RENTAL" && endsToday && booking.status === "PICKED_UP" && line.to < now()) {
        flag(booking, "OVERDUE_RETURN", "Return is overdue", "critical", line.to);
      }
      if (line.type === "RENTAL" && startsToday && ["RESERVED", "POS_PENDING", "PAID"].includes(booking.status)) {
        if (!paid) flag(booking, "PAYMENT", "Payment/POS reconciliation needed", "warning", line.from);
        if (!signed) flag(booking, "CONTRACT", "Contract signature needed", "warning", line.from);
        if (checklistTotal > checklistDone) {
          flag(booking, "KIT", `${checklistTotal - checklistDone} kit item${checklistTotal - checklistDone === 1 ? "" : "s"} unchecked`, "warning", line.from);
        }
      }
    }
  }

  const order = { critical: 0, warning: 1 };
  attention.sort((a, b) => order[a.severity as keyof typeof order] - order[b.severity as keyof typeof order] || a.at.localeCompare(b.at));
  items.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  res.json({
    date, items, attention,
    summary: {
      pickups: items.filter((x) => x.phase === "PICKUP").length,
      returns: items.filter((x) => x.phase === "RETURN").length,
      classes: items.filter((x) => x.phase === "CLASS").length,
      onRent: items.filter((x) => x.phase === "ON_RENT").length,
      needsAttention: attention.length,
    },
  });
});
