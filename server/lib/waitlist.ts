import { db, now } from "../db.js";
import { emit } from "./events.js";

export function notifyWaitlistForBooking(bookingId: string) {
  const lines = db.prepare("SELECT product_no,session_id,store_id,date_from,date_to FROM booking_lines WHERE booking_id=?").all(bookingId) as any[];
  for (const line of lines) {
    const waiting = db.prepare(`SELECT * FROM waitlist WHERE status='WAITING' AND product_no=?
      AND COALESCE(session_id,'')=COALESCE(?,'') AND (session_id IS NOT NULL OR (
        COALESCE(store_id,'')=COALESCE(?,'') AND date_from<=? AND date_to>=?
      )) ORDER BY created_at LIMIT 5`).all(line.product_no, line.session_id, line.store_id, line.date_to, line.date_from) as any[];
    for (const entry of waiting) {
      db.prepare("UPDATE waitlist SET status='NOTIFIED',notified_at=? WHERE id=?").run(now(), entry.id);
      emit(bookingId, "waitlist.availability_opened", {
        waitlistId: entry.id, productNo: entry.product_no, sessionId: entry.session_id,
        email: entry.customer_email, phone: entry.customer_phone,
      });
    }
  }
}
