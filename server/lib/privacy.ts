// Data retention & redaction (privacy declarations: "retention periods",
// "minimum personal data"; Shopify mandatory compliance webhooks).
//
//  - Encrypted government IDs are purged idRetentionDays after a booking closes.
//  - Whole bookings are anonymized dataRetentionDays after creation (financial
//    totals are kept for reporting; the person is unlinked).
//  - customers/redact → immediate anonymization for that customer.
import { db, getSettings, auditLog, now, j } from "../db.js";

const cutoffISO = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export function sweepRetention(): { idsPurged: number; bookingsAnonymized: number } {
  const s = getSettings();
  const idDays = Math.max(1, Number(s.idRetentionDays) || 30);
  const dataDays = Math.max(30, Number(s.dataRetentionDays) || 730);

  const idsPurged = db
    .prepare(
      `UPDATE bookings SET id_encrypted = '' WHERE id_encrypted != ''
       AND status IN ('COMPLETED','CANCELLED') AND updated_at < ?`,
    )
    .run(cutoffISO(idDays)).changes;

  const stale = db
    .prepare(
      `SELECT id, ref FROM bookings WHERE customer_email != 'redacted'
       AND status IN ('COMPLETED','CANCELLED') AND created_at < ?`,
    )
    .all(cutoffISO(dataDays)) as { id: string; ref: string }[];
  for (const b of stale) anonymizeBooking(b.id);

  if (idsPurged || stale.length) {
    auditLog("retention.sweep", "", `idsPurged=${idsPurged} anonymized=${stale.length}`, "system");
  }
  return { idsPurged, bookingsAnonymized: stale.length };
}

export function anonymizeBooking(bookingId: string) {
  db.prepare(
    `UPDATE bookings SET customer_email = 'redacted', customer_first = '', customer_last = '',
     customer_phone = '', id_encrypted = '', notes = '', updated_at = ? WHERE id = ?`,
  ).run(now(), bookingId);
  // Event payloads can carry the email — blank them for this booking.
  db.prepare("UPDATE events SET detail = '{}' WHERE booking_id = ?").run(bookingId);
}

/** Shopify customers/redact (and staff-initiated erasure). */
export function redactCustomer(email: string): number {
  if (!email) return 0;
  const rows = db.prepare("SELECT id FROM bookings WHERE customer_email = ?").all(email) as { id: string }[];
  for (const r of rows) anonymizeBooking(r.id);
  auditLog("privacy.redact", email, `bookings=${rows.length}`, "system");
  return rows.length;
}

/** Shopify customers/data_request: everything we hold on this person. */
export function collectCustomerData(email: string) {
  const bookings = db
    .prepare(
      `SELECT ref, type, status, subtotal, deposit, total, currency, created_at,
              customer_email, customer_first, customer_last, customer_phone
       FROM bookings WHERE customer_email = ?`,
    )
    .all(email);
  const lines = db
    .prepare(
      `SELECT b.ref, l.product_name, l.date_from, l.date_to, l.qty, l.line_total
       FROM booking_lines l JOIN bookings b ON b.id = l.booking_id WHERE b.customer_email = ?`,
    )
    .all(email);
  auditLog("privacy.export", email, `bookings=${bookings.length}`);
  return { email, bookings, lines, note: "Government ID numbers are stored encrypted and are not exportable." };
}

export function startRetentionSchedule() {
  const run = () => {
    try {
      sweepRetention();
    } catch (err) {
      console.error("[privacy] retention sweep failed:", err);
    }
  };
  run(); // on boot
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}

export const jsonExport = (data: unknown) => j(data);
