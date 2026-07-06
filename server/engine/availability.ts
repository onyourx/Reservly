// Availability:
//  - Rentals: units per store (product_store_qty) minus overlapping active booking
//    lines, evaluated per calendar day. In live mode NAV's GetActivityAvailability is
//    the authority; local holds still apply on top so unpaid web carts can't double-book.
//  - Courses: session capacity minus booked seats.
import { db } from "../db.js";
import { getActivityAvailability, navMode } from "../lib/nav.js";

const ACTIVE = "('RESERVED','POS_PENDING','PAID','PICKED_UP')";

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(from.slice(0, 10) + "T00:00:00Z");
  const end = new Date(to.slice(0, 10) + "T00:00:00Z");
  for (let d = start; d <= end && days.length < 366; d = new Date(d.getTime() + 86_400_000)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export async function rentalAvailability(productNo: string, storeId: string, from: string, to: string) {
  const stock = db
    .prepare(
      `SELECT COALESCE(q.qty, 0) AS qty FROM products p
       LEFT JOIN product_store_qty q ON q.product_id = p.id AND q.store_id = ?
       WHERE p.product_no = ?`,
    )
    .get(storeId, productNo) as { qty: number } | undefined;
  const totalQty = stock?.qty ?? 0;

  const days = eachDay(from, to);
  const perDay = days.map((date) => {
    const booked = db
      .prepare(
        `SELECT COALESCE(SUM(l.qty), 0) AS n FROM booking_lines l
         JOIN bookings b ON b.id = l.booking_id
         WHERE l.product_no = ? AND l.store_id = ? AND b.status IN ${ACTIVE}
           AND date(l.date_from) <= date(?) AND date(l.date_to) >= date(?)`,
      )
      .get(productNo, storeId, date, date) as { n: number };
    return { date, qty: Math.max(0, totalQty - booked.n) };
  });

  if (navMode() === "live") {
    // Cross-check with NAV; take the more conservative figure per day.
    try {
      const nav = await getActivityAvailability(productNo, from, days.length);
      for (const slot of nav) {
        const d = String(slot.AvailDate || "").replace(/\//g, "-");
        const local = perDay.find((p) => p.date === d);
        if (local) local.qty = Math.min(local.qty, Number(slot.Availability ?? 0));
      }
    } catch {
      /* NAV unreachable → local holds still protect us */
    }
  }
  return { available: perDay.every((p) => p.qty > 0), perDay };
}

export function sessionBooked(sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(l.qty), 0) AS n FROM booking_lines l
       JOIN bookings b ON b.id = l.booking_id
       WHERE l.session_id = ? AND b.status IN ${ACTIVE}`,
    )
    .get(sessionId) as { n: number };
  return row.n;
}

export function courseSlots(productNo: string, from: string, daysAhead: number) {
  const to = new Date(new Date(from).getTime() + daysAhead * 86_400_000).toISOString();
  const sessions = db
    .prepare(
      `SELECT s.*, st.name AS store_name FROM sessions s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN stores st ON st.id = s.store_id
       WHERE p.product_no = ? AND s.starts_at >= ? AND s.starts_at <= ?
       ORDER BY s.starts_at`,
    )
    .all(productNo, from, to) as any[];
  return sessions.map((s) => {
    const booked = sessionBooked(s.id);
    const trainers = db
      .prepare(
        `SELECT r.name FROM session_trainers t JOIN resources r ON r.id = t.resource_id WHERE t.session_id = ?`,
      )
      .all(s.id) as { name: string }[];
    return {
      sessionId: s.id,
      date: s.starts_at.slice(0, 10),
      time: s.starts_at.slice(11, 16),
      endsAt: s.ends_at,
      storeId: s.store_id,
      location: s.store_name || "",
      capacity: s.capacity,
      booked,
      remaining: Math.max(0, s.capacity - booked),
      instanceNo: s.instance_no,
      instanceCount: s.instance_count,
      trainers: trainers.map((t) => t.name),
    };
  });
}
