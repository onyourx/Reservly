// Availability:
//  - Rentals: units per store (product_store_qty) minus overlapping active booking
//    lines, evaluated per calendar day. In live mode NAV's GetActivityAvailability is
//    the authority; local holds still apply on top so unpaid web carts can't double-book.
//  - Courses: session capacity minus booked seats.
import { db, getSettings } from "../db.js";
import { getActivityAvailability, navMode } from "../lib/nav.js";

const ACTIVE = "('RESERVED','POS_PENDING','PAID','PICKED_UP')";
const activeHoldCutoff = () => new Date().toISOString();

function ruleAllows(productNo: string, storeId: string, at: string): boolean {
  const product = db.prepare("SELECT id FROM products WHERE product_no=?").get(productNo) as any;
  const date = at.slice(0, 10);
  const time = at.slice(11, 16) || "00:00";
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const rules = db.prepare(`SELECT * FROM availability_rules WHERE
    (scope_type='PRODUCT' AND scope_id=?) OR (scope_type='STORE' AND scope_id=?)`).all(product?.id || "", storeId) as any[];
  const blackedOut = rules.some((r) => r.kind === "BLACKOUT" && r.starts_at.slice(0, 10) <= date && r.ends_at.slice(0, 10) >= date);
  if (blackedOut) return false;
  const opening = rules.filter((r) => r.kind === "OPENING" && Number(r.weekday) === weekday);
  return !opening.length || opening.some((r) => r.from_time <= time && r.to_time >= time);
}

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
    const held = db.prepare(
      `SELECT COALESCE(SUM(qty),0) AS n FROM booking_holds
       WHERE product_no=? AND store_id=? AND expires_at>?
         AND date(date_from)<=date(?) AND date(date_to)>=date(?)`,
    ).get(productNo, storeId, activeHoldCutoff(), date, date) as { n: number };
    const blocked = db.prepare(
      `SELECT COUNT(DISTINCT u.id) AS n FROM rental_units u JOIN products p ON p.id=u.product_id
       WHERE p.product_no=? AND u.store_id=?
         AND (u.status IN ('SERVICE','RETIRED') OR EXISTS (
           SELECT 1 FROM rental_unit_unavailability x WHERE x.unit_id=u.id
             AND date(x.starts_at) <= date(?) AND date(x.ends_at) >= date(?)
         ))`,
    ).get(productNo, storeId, date, date) as { n: number };
    return { date, qty: ruleAllows(productNo, storeId, `${date}T${from.slice(11, 16) || "00:00"}`) ? Math.max(0, totalQty - booked.n - held.n - blocked.n) : 0 };
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
  const held = db.prepare(
    "SELECT COALESCE(SUM(qty),0) AS n FROM booking_holds WHERE session_id=? AND expires_at>?",
  ).get(sessionId, activeHoldCutoff()) as { n: number };
  return row.n + held.n;
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
      availableByRules: ruleAllows(productNo, s.store_id, s.starts_at),
    };
  }).filter((s) => s.availableByRules);
}

export function serviceSlots(productNo: string, storeId: string, dateISO: string): { slots: string[] } {
  const date = String(dateISO).slice(0, 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const product = db.prepare(
    `SELECT p.id,p.duration,COALESCE(q.qty,1) AS capacity
     FROM products p LEFT JOIN product_store_qty q ON q.product_id=p.id AND q.store_id=?
     WHERE p.product_no=? AND p.type='SERVICE'`,
  ).get(storeId, productNo) as { id: string; duration: number; capacity: number } | undefined;
  if (!product) throw new Error("Service product not found");
  const durationMinutes = Math.round(Number(product.duration) * 60);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error("Service duration is invalid");

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) return { slots: [] };
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const openings = db.prepare(`SELECT from_time,to_time FROM availability_rules
    WHERE kind='OPENING' AND weekday=? AND
      ((scope_type='PRODUCT' AND scope_id=?) OR (scope_type='STORE' AND scope_id=?))
    ORDER BY from_time,to_time`).all(weekday, product.id, storeId) as { from_time: string; to_time: string }[];
  const settings = getSettings();
  const windows = openings.length ? openings : [{
    from_time: settings.serviceOpenTime || "09:00",
    to_time: settings.serviceCloseTime || "17:00",
  }];
  // Guard against inverted service hours
  if ((windows[0]?.from_time || "09:00") >= (windows[0]?.to_time || "17:00")) {
    console.warn(`[availability] inverted service hours (${windows[0]?.from_time} >= ${windows[0]?.to_time}), returning no slots`);
    return { slots: [] };
  }
  const nowMs = Date.now();
  const bookedStmt = db.prepare(`SELECT COALESCE(SUM(l.qty),0) AS n
    FROM booking_lines l JOIN bookings b ON b.id=l.booking_id
    WHERE l.type='SERVICE' AND l.product_no=? AND l.store_id=?
      AND l.date_from<=? AND l.date_to>?
      AND b.status IN ${ACTIVE}`);
  const slots: string[] = [];
  for (const window of windows) {
    const [fromHour, fromMinute] = window.from_time.slice(0, 5).split(":").map(Number);
    const [toHour, toMinute] = window.to_time.slice(0, 5).split(":").map(Number);
    let minute = fromHour * 60 + fromMinute;
    const endMinute = toHour * 60 + toMinute;
    while (minute + durationMinutes <= endMinute) {
      const hhmm = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(Math.round(minute % 60)).padStart(2, "0")}`;
      const start = `${date}T${hhmm}:00.000Z`;
      if (new Date(start).getTime() > nowMs) {
        const booked = bookedStmt.get(productNo, storeId, start, start) as { n: number };
        if (booked.n < Math.max(0, Number(product.capacity))) slots.push(hhmm);
      }
      minute += durationMinutes;
    }
  }
  return { slots: [...new Set(slots)].sort() };
}
