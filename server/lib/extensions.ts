import { db, uid, now, j, getSettings, auditLog, pj } from "../db.js";
import { rentalAvailability, eachDay } from "../engine/availability.js";
import { rentalDays, productByNo, rentalLineTotal } from "../engine/pricing.js";
import { sendMail } from "./mailer.js";
import { createDraftInvoice } from "./shopifyAdmin.js";
import { serializeBooking } from "./bookingService.js";
import { scheduleBookingReminders } from "./notifications.js";
import { validateRentalWindow } from "./policy.js";

export interface ExtensionRequest {
  id: string;
  bookingId: string;
  lineId: string;
  oldDateTo: string;
  newDateTo: string;
  price: number;
  status: "REQUESTED" | "APPROVED" | "REJECTED" | "APPLIED" | "EXPIRED" | "CANCELLED";
  shopifyDraftOrderId: string;
  invoiceUrl: string;
  decidedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function extensionRow(id: string): any {
  return db.prepare("SELECT * FROM extension_requests WHERE id=?").get(id) as any;
}

function serializeExtension(row: any): ExtensionRequest | null {
  if (!row) return null;
  return {
    id: row.id, bookingId: row.booking_id, lineId: row.line_id,
    oldDateTo: row.old_date_to, newDateTo: row.new_date_to,
    price: Number(row.price), status: row.status,
    shopifyDraftOrderId: row.shopify_draft_order_id || "",
    invoiceUrl: row.invoice_url || "", decidedAt: row.decided_at,
    paidAt: row.paid_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const field = (row: any, camel: string, snake: string) => row?.[camel] ?? row?.[snake];

export async function checkExtensionAvailability(line: any, newDateTo: string): Promise<boolean> {
  if (line?.type !== "RENTAL") return false;
  const oldDateTo = String(field(line, "to", "date_to") || "");
  if (!oldDateTo || !newDateTo || new Date(newDateTo) <= new Date(oldDateTo)) return false;
  const avail = await rentalAvailability(
    String(field(line, "productNo", "product_no")),
    String(field(line, "storeId", "store_id")),
    oldDateTo,
    newDateTo,
  );
  const added = new Set(eachDay(oldDateTo, newDateTo).filter((day) => day > oldDateTo.slice(0, 10)));
  const qty = Number(line.qty) || 1;
  return added.size > 0 && avail.perDay.filter((day) => added.has(day.date)).every((day) => day.qty >= qty);
}

export function priceExtension(line: any, newDateTo: string): number {
  const product = productByNo(String(field(line, "productNo", "product_no")));
  if (!product) throw new Error("Product not found");
  const addedDays = rentalDays(String(field(line, "to", "date_to")), newDateTo);
  return rentalLineTotal(product, addedDays, Number(line.qty) || 1).lineTotal;
}

export async function requestExtension(bookingId: string, lineId: string, newDateTo: string): Promise<ExtensionRequest | null> {
  const settings = getSettings();
  if (settings.extensionsEnabled !== "1") throw new Error("Extensions are not enabled");
  const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(bookingId) as any;
  if (!booking || !["RESERVED", "PAID", "PICKED_UP", "RETURNED"].includes(booking.status)) throw new Error("Booking cannot be extended");
  const line = db.prepare("SELECT * FROM booking_lines WHERE id=? AND booking_id=?").get(lineId, bookingId) as any;
  if (!line || line.type !== "RENTAL") throw new Error("Invalid rental line");
  if (!newDateTo || new Date(newDateTo) <= new Date(line.date_to)) throw new Error("New return date must be after the current return date");
  const validation = validateRentalWindow(line.date_from, newDateTo);
  if (!validation.ok) throw new Error(validation.error);
  if (!(await checkExtensionAvailability(line, newDateTo))) throw new Error("Requested dates are no longer available");
  const id = uid();
  const at = now();
  db.prepare(`INSERT INTO extension_requests
    (id,booking_id,line_id,old_date_to,new_date_to,price,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'REQUESTED',?,?)`)
    .run(id, bookingId, lineId, line.date_to, newDateTo, priceExtension(line, newDateTo), at, at);
  if (settings.extensionApproval === "auto") return approveExtension(id);
  return serializeExtension(extensionRow(id));
}

export async function draftOrderCreate(bookingId: string, price: number, requestId?: string): Promise<{ draftOrderId: string; invoiceUrl: string } | null> {
  try {
    const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(bookingId) as any;
    if (!booking) throw new Error("Booking not found");
    const request = requestId
      ? extensionRow(requestId)
      : db.prepare("SELECT * FROM extension_requests WHERE booking_id=? AND status='REQUESTED' ORDER BY created_at DESC LIMIT 1").get(bookingId) as any;
    if (!request) throw new Error("Extension request not found");
    const line = db.prepare("SELECT * FROM booking_lines WHERE id=?").get(request.line_id) as any;
    return await createDraftInvoice({
      customerEmail: booking.customer_email,
      customerFirstName: booking.customer_first,
      customerLastName: booking.customer_last,
      customerPhone: booking.customer_phone,
      title: `Rental extension — ${line.product_name} until ${request.new_date_to} (${booking.ref})`,
      price,
      customAttributes: [{ key: "reservly_extension_id", value: request.id }],
    });
  } catch (err) {
    console.error("[extensions] draftOrderCreate failed:", err);
    return null;
  }
}

export async function approveExtension(requestId: string): Promise<ExtensionRequest | null> {
  const request = extensionRow(requestId);
  if (!request || request.status !== "REQUESTED") throw new Error("Extension request is not awaiting approval");
  const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(request.booking_id) as any;
  const line = db.prepare("SELECT * FROM booking_lines WHERE id=? AND booking_id=?").get(request.line_id, request.booking_id) as any;
  if (!booking || !line) throw new Error("Booking or rental line not found");
  if (!(await checkExtensionAvailability(line, request.new_date_to))) {
    const at = now();
    db.prepare("UPDATE extension_requests SET status='REJECTED',decided_at=?,updated_at=? WHERE id=?").run(at, at, requestId);
    await sendMail({
      to: booking.customer_email,
      subject: `Rental extension request declined — ${booking.ref}`,
      text: "Unfortunately, the requested dates are no longer available. Please contact us.",
    });
    return serializeExtension(extensionRow(requestId));
  }
  db.prepare(`INSERT INTO booking_holds(token,product_no,session_id,store_id,date_from,date_to,qty,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    uid(), line.product_no, request.id, line.store_id, line.date_to, request.new_date_to, line.qty,
    new Date(Date.now() + 48 * 3_600_000).toISOString(), now(),
  );
  let draft: { draftOrderId: string; invoiceUrl: string } | null = null;
  if (getSettings().shopifyApiSecret) draft = await draftOrderCreate(booking.id, request.price, request.id);
  const at = now();
  db.prepare(`UPDATE extension_requests SET status='APPROVED',shopify_draft_order_id=?,
    invoice_url=?,decided_at=?,updated_at=? WHERE id=?`)
    .run(draft?.draftOrderId || "", draft?.invoiceUrl || "", at, at, requestId);
  const payment = draft?.invoiceUrl ? `Payment link: ${draft.invoiceUrl}` : "Contact the store to complete payment";
  await sendMail({
    to: booking.customer_email,
    subject: `Rental extension approved — ${booking.ref}`,
    text: `${line.product_name}: ${request.old_date_to} to ${request.new_date_to}. Price: $${Number(request.price).toFixed(2)}. Booking: ${booking.ref}. ${payment}`,
    html: `<p>Your rental extension for <strong>${line.product_name}</strong> has been approved.</p><p>${request.old_date_to} → ${request.new_date_to}</p><p>Price: $${Number(request.price).toFixed(2)}</p><p>Booking: ${booking.ref}</p><p>${payment}</p>`,
  });
  return serializeExtension(extensionRow(requestId));
}

export async function rejectExtension(requestId: string, reason?: string): Promise<ExtensionRequest | null> {
  const request = extensionRow(requestId);
  if (!request || request.status !== "REQUESTED") throw new Error("Extension request is not awaiting approval");
  const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(request.booking_id) as any;
  if (!booking) throw new Error("Booking not found");
  const at = now();
  db.prepare("UPDATE extension_requests SET status='REJECTED',decided_at=?,updated_at=? WHERE id=?").run(at, at, requestId);
  const detail = reason || "Contact the store for details";
  await sendMail({
    to: booking.customer_email,
    subject: `Rental extension request declined — ${booking.ref}`,
    text: `Your request to extend rental has been declined. Reason: ${detail}`,
  });
  return serializeExtension(extensionRow(requestId));
}

export async function applyPaidExtension(requestId: string): Promise<void> {
  const request = extensionRow(requestId);
  if (!request) throw new Error("Extension request not found");
  if (request.status !== "APPROVED") return;
  const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(request.booking_id) as any;
  const line = db.prepare("SELECT * FROM booking_lines WHERE id=? AND booking_id=?").get(request.line_id, request.booking_id) as any;
  if (!booking || !line) throw new Error("Booking or rental line not found");
  const at = now();
  db.transaction(() => {
    db.prepare("UPDATE booking_lines SET date_to=?,days=?,line_total=line_total+? WHERE id=?")
      .run(request.new_date_to, rentalDays(line.date_from, request.new_date_to), request.price, line.id);
    db.prepare("UPDATE bookings SET subtotal=subtotal+?,total=total+?,updated_at=? WHERE id=?")
      .run(request.price, request.price, at, booking.id);
    db.prepare("DELETE FROM booking_holds WHERE session_id=?").run(request.id);
    db.prepare("UPDATE extension_requests SET status='APPLIED',paid_at=?,updated_at=? WHERE id=?").run(at, at, requestId);
  })();
  auditLog("rental.extension_applied", booking.ref, booking.customer_email, "system");
  scheduleBookingReminders(booking.id);
  await sendMail({
    to: booking.customer_email,
    subject: `Rental extended — ${booking.ref}`,
    text: `Your rental of ${line.product_name} has been successfully extended to ${request.new_date_to}.`,
  });
}

// Keep the shared database helpers referenced here intentionally: extension payloads
// and booking serialization use the same JSON and booking conventions as this module.
void j;
void pj;
void serializeBooking;
