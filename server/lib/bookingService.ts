// Booking creation + serialization shared by the admin API (staff store view) and
// the Shopify orders/create webhook (web channel) — one code path for both R4-R5
// and class steps 6-10.
import crypto from "node:crypto";
import { db, uid, now, pj, j, getSettings, auditLog } from "../db.js";
import { quoteLines, round2, type QuoteLineIn } from "../engine/pricing.js";
import { confirmReservation } from "./nav.js";
import { idLast4 } from "./crypto.js";
import { emit } from "./events.js";
import { scheduleBookingReminders } from "./notifications.js";
import { validateRentalWindow } from "./policy.js";
import { serviceSlots } from "../engine/availability.js";
import { createZoomMeeting } from "./zoom.js";

export interface CustomerIn {
  email: string; firstName?: string; lastName?: string; phone?: string; b2b?: boolean;
}

export class BookingValidationError extends Error {
  constructor(public payload: Record<string, unknown>) {
    super(String(payload.error || "Booking validation failed"));
  }
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
  holdToken?: string;
  intakeResponses?: Record<string, unknown>;
  fieldResponses?: Record<string, unknown>;
  termsAccepted?: boolean;
  enforceTerms?: boolean;
  addons?: { productNo: string; name: string; qty: number; unitPrice: number; shopifyVariantId?: string }[];
}) {
  if (!input.customer?.email) throw new Error("customer.email is required");
  if (!input.lines?.length) throw new Error("At least one line is required");
  const quoted = quoteLines(input.lines);
  for (const line of quoted.lines) {
    if (line.type !== "RENTAL") continue;
    const validation = validateRentalWindow(line.from, line.to);
    if (!validation.ok) throw new Error(validation.error);
  }
  for (const line of quoted.lines) {
    if (line.type !== "SERVICE") continue;
    const storeId = line.storeId || input.storeId;
    if (!storeId) throw new Error("Service line needs storeId");
    const date = line.from.slice(0, 10);
    const time = line.from.slice(11, 16);
    if (!serviceSlots(line.productNo, storeId, date).slots.includes(time)) {
      throw new BookingValidationError({ error: "Slot no longer available" });
    }
    const capacity = db.prepare(`SELECT COALESCE(q.qty,1) AS qty FROM products p
      LEFT JOIN product_store_qty q ON q.product_id=p.id AND q.store_id=?
      WHERE p.product_no=?`).get(storeId, line.productNo) as { qty: number } | undefined;
    const booked = db.prepare(`SELECT COALESCE(SUM(l.qty),0) AS n FROM booking_lines l
      JOIN bookings b ON b.id=l.booking_id
      WHERE l.type='SERVICE' AND l.product_no=? AND l.store_id=?
        AND l.date_from<=? AND l.date_to>?
      AND b.status IN ('RESERVED','POS_PENDING','PAID','PICKED_UP')`)
      .get(line.productNo, storeId, line.from, line.from) as { n: number };
    const requested = quoted.lines.filter((candidate) => candidate.type === "SERVICE"
      && candidate.productNo === line.productNo
      && (candidate.storeId || input.storeId) === storeId
      && candidate.from === line.from).reduce((sum, candidate) => sum + candidate.qty, 0);
    if (booked.n + requested > Math.max(0, Number(capacity?.qty ?? 1))) {
      throw new BookingValidationError({ error: "Slot no longer available" });
    }
  }

  const productNos = [...new Set(quoted.lines.map((line) => line.productNo))];
  const placeholders = productNos.map(() => "?").join(",");
  const fields = db.prepare(`SELECT f.* FROM booking_fields f JOIN products p ON p.id=f.product_id
    WHERE p.product_no IN (${placeholders}) ORDER BY f.sort,f.id`).all(...productNos) as any[];
  const responses = input.fieldResponses ?? input.intakeResponses ?? {};
  const storedResponses: { fieldId: string; label: string; value: unknown }[] = [];
  for (const field of fields) {
    const hasValue = Object.prototype.hasOwnProperty.call(responses, field.id);
    let value = responses[field.id];
    const requiredCheckboxMissing = field.type === "checkbox"
      && value !== true && value !== "true" && value !== 1 && value !== "1";
    if (field.required && (!hasValue || value === "" || value == null || requiredCheckboxMissing)) {
      throw new BookingValidationError({ error: "field_required", fieldId: field.id });
    }
    if (!hasValue || value === "" || value == null) continue;
    const options = pj<string[]>(field.options, []);
    let valid = true;
    if (field.type === "dropdown" || field.type === "radio") {
      valid = typeof value === "string" && options.includes(value);
    } else if (field.type === "checkbox") {
      if (typeof value !== "boolean") {
        if (value === "true" || value === 1 || value === "1") value = true;
        else if (value === "false" || value === 0 || value === "0") value = false;
        else valid = false;
      }
    } else if (field.type === "date") {
      valid = typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)
        && !Number.isNaN(new Date(value.length === 10 ? `${value}T00:00:00Z` : value).getTime());
    } else if (field.type === "number") {
      valid = value !== "" && Number.isFinite(Number(value));
    }
    if (!valid) throw new BookingValidationError({ error: "field_invalid", fieldId: field.id });
    storedResponses.push({ fieldId: field.id, label: field.label, value });
  }

  const settings = getSettings();
  const ref = newRef();
  const termsTypes = [...new Set(quoted.lines.map((line) => line.type.toLowerCase()))]
    .filter((type) => settings[`terms${type[0].toUpperCase()}${type.slice(1)}Enabled`] === "1");
  if (termsTypes.length && input.termsAccepted !== true) {
    if (input.enforceTerms !== false) {
      throw new BookingValidationError({ error: "terms_required", types: termsTypes });
    }
    auditLog("terms.missing_on_paid_order", ref);
    console.warn("[bookingService] Missing required terms acceptance on paid order; creating booking", {
      bookingRef: ref,
      shopifyOrderId: input.shopifyOrderId,
      termsTypes,
    });
  }
  const addonTotal = round2((input.addons || []).reduce((sum, a) => sum + (Number(a.unitPrice) || 0) * Math.max(1, Number(a.qty) || 1), 0));
  const commerceTotal = round2(quoted.subtotal + addonTotal);

  const types = new Set(quoted.lines.map((l) => l.type));
  const type = types.size > 1 ? "MIXED" : [...types][0];
  const id = uid();
  const status = input.paid ? "PAID" : "RESERVED";
  const manageToken = crypto.randomBytes(24).toString("base64url");

  db.prepare(
    `INSERT INTO bookings (id, ref, type, status, channel, store_id, customer_email, customer_first,
       customer_last, customer_phone, customer_b2b, subtotal, deposit, total, currency,
       shopify_order_id, shopify_order_name, notes, manage_token, intake_responses, terms_accepted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, ref, type, status, input.channel, input.storeId ?? null,
    input.customer.email, input.customer.firstName ?? "", input.customer.lastName ?? "",
    input.customer.phone ?? "", input.customer.b2b ? 1 : 0,
    commerceTotal, quoted.deposit, commerceTotal, settings.currency || "CAD",
    input.shopifyOrderId ?? "", input.shopifyOrderName ?? "", input.notes ?? "", manageToken,
    j(storedResponses), input.termsAccepted === true ? now() : null, now(), now(),
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

  const onlineServiceLine = quoted.lines.find((line) => {
    if (line.type !== "SERVICE") return false;
    const product = db.prepare("SELECT online FROM products WHERE product_no=?").get(line.productNo) as { online: number } | undefined;
    return !!product?.online;
  });
  const zoomConfigured = !!(settings.zoomAccountId && settings.zoomClientId && settings.zoomClientSecret);
  if (onlineServiceLine && zoomConfigured) {
    const onlineProduct = db.prepare("SELECT name FROM products WHERE product_no=?")
      .get(onlineServiceLine.productNo) as { name: string } | undefined;
    try {
      const zoom = await createZoomMeeting({
        topic: `${onlineProduct?.name || onlineServiceLine.productName} - ${input.customer.firstName || "Class"}`,
        startsAt: onlineServiceLine.from,
        endsAt: onlineServiceLine.to,
      });
      db.prepare("UPDATE bookings SET meeting_url=? WHERE id=?").run(zoom.joinUrl, id);
    } catch (err) {
      console.warn("[bookingService] Zoom meeting creation failed for booking", { bookingId: id, error: String(err) });
    }
  }

  if (input.holdToken) db.prepare("DELETE FROM booking_holds WHERE token=?").run(input.holdToken);
  if (input.addons?.length) {
    const insertAddon = db.prepare(`INSERT INTO booking_addons(id,booking_id,addon_product_no,name,qty,unit_price,shopify_variant_id)
      VALUES(?,?,?,?,?,?,?)`);
    for (const addon of input.addons) insertAddon.run(uid(), id, addon.productNo, addon.name, Math.max(1, addon.qty || 1),
      Number(addon.unitPrice) || 0, addon.shopifyVariantId || "");
  }

  emit(id, "booking.created", { ref, type, channel: input.channel, email: input.customer.email, total: commerceTotal, addonTotal });
  const publicUrl = (getSettings().publicUrl || process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  emit(id, "booking.management_link_created", {
    email: input.customer.email,
    url: `${publicUrl}/manage/${manageToken}`,
    calendarUrl: `${publicUrl}/manage/${manageToken}/calendar.ics`,
  });
  scheduleBookingReminders(id);
  return serializeBooking(id)!;
}

export function serializeBooking(id: string) {
  const b = db.prepare("SELECT * FROM bookings WHERE id = ? OR ref = ?").get(id, id) as any;
  if (!b) return null;
  const lines = (db.prepare("SELECT * FROM booking_lines WHERE booking_id = ? ORDER BY rowid").all(b.id) as any[]).map((l) => {
    // Stored checklist wins; otherwise derive one from the product's kit so
    // staff always have something to tick off at pickup (R8-R11).
    let checklist = pj<{ itemNo: string; description: string; qty: number; checked: boolean }[]>(l.checklist, []);
    if (!checklist.length && l.type === "RENTAL") {
      const kit = db.prepare(
        `SELECT k.item_no AS itemNo, k.description, k.qty FROM product_kit_items k
         JOIN products p ON p.id = k.product_id WHERE p.product_no = ?`,
      ).all(l.product_no) as { itemNo: string; description: string; qty: number }[];
      checklist = [
        { itemNo: l.product_no, description: `${l.product_name} (main unit)`, qty: l.qty, checked: false },
        ...kit.map((k) => ({ ...k, qty: k.qty * l.qty, checked: false })),
      ];
    }
    return {
      id: l.id, type: l.type, productNo: l.product_no, productName: l.product_name,
      sessionId: l.session_id, storeId: l.store_id, from: l.date_from, to: l.date_to,
      qty: l.qty, days: l.days, unitPrice: l.unit_price, lineTotal: l.line_total,
      deposit: l.deposit, status: l.status, activityNo: l.activity_no, bookingRef: l.booking_ref,
      sellingItem: l.selling_item, inspectionOut: l.inspection_out, inspectionIn: l.inspection_in,
      damages: pj(l.damages, [] as any[]),
      checklist,
      ...(l.type === "SERVICE" ? { meetingUrl: b.meeting_url || "" } : {}),
      ...(l.session_id ? (() => {
        const session = db.prepare("SELECT delivery_mode,meeting_url FROM sessions WHERE id=?").get(l.session_id) as any;
        return { deliveryMode: session?.delivery_mode || "IN_PERSON", meetingUrl: session?.meeting_url || "" };
      })() : {}),
      units: (db.prepare(`SELECT u.id, u.barcode, u.serial_no AS serialNo, u.status, u.condition,
        u.store_id AS storeId, x.assigned_at AS assignedAt, x.returned_at AS returnedAt
        FROM booking_line_units x JOIN rental_units u ON u.id = x.unit_id
        WHERE x.booking_line_id = ? ORDER BY u.barcode`).all(l.id) as any[]),
    };
  });
  const events = (db.prepare("SELECT * FROM events WHERE booking_id = ? ORDER BY id DESC LIMIT 50").all(b.id) as any[]).map((e) => ({
    at: e.at, type: e.type, detail: pj(e.detail, {}),
  }));
  const fieldResponses = pj(b.intake_responses, {});
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
    idPhotoAt: b.id_photo_at || "",
    contractSignedAt: b.contract_signed_at, signatureName: b.signature_name || "",
    signaturePending: Boolean(b.sign_token) && !b.contract_signed_at,
    notes: b.notes, createdAt: b.created_at, checkedInAt: b.checked_in_at, noShowAt: b.no_show_at,
    noShowFee: Number(b.no_show_fee || 0), noShowFeeStatus: b.no_show_fee_status || "",
    noShowDraftOrderId: b.no_show_draft_order_id || "",
    intakeResponses: fieldResponses, fieldResponses, rescheduleCount: b.reschedule_count || 0,
    termsAcceptedAt: b.terms_accepted_at || "",
    addons: db.prepare(`SELECT addon_product_no AS productNo,name,qty,unit_price AS unitPrice,
      shopify_variant_id AS shopifyVariantId FROM booking_addons WHERE booking_id=?`).all(b.id),
    events,
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
