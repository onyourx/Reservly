import { db, getSettings, now, uid } from "../db.js";
import { emit } from "./events.js";
import { sendMail } from "./mailer.js";

const DEFAULT_PICKUP_SUBJECT = "Reminder: your rental pickup at {{store}}";
const DEFAULT_RETURN_SUBJECT = "Reminder: your rental return to {{store}}";
const DEFAULT_PICKUP_TEMPLATE = `<p>Hi {{firstName}},</p>
<p>We're looking forward to your rental pickup at <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>See you soon!</p>`;
const DEFAULT_RETURN_TEMPLATE = `<p>Hi {{firstName}},</p>
<p>This is a reminder to return your rental to <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>Thank you!</p>`;

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => values[key] ?? "");
}

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const storeTimeZone = () => process.env.BOOKING_TZ || "America/Toronto";
const formatDate = (value: string) => new Date(value).toLocaleDateString("en-CA", {
  dateStyle: "medium",
  timeZone: storeTimeZone(),
});
const formatTime = (value: string) => new Date(value).toLocaleTimeString("en-CA", {
  timeStyle: "short",
  timeZone: storeTimeZone(),
});

function isReminderEnabled(newKey: string, legacyEnabled: string): boolean {
  if (newKey === "1") return true;
  if (newKey === "" && legacyEnabled === "1") return true;
  return false;
}

export function scheduleBookingReminders(bookingId: string) {
  const settings = getSettings();
  const pickupEnabled = isReminderEnabled(settings.reminderPickupEnabled, settings.remindersEnabled);
  const returnEnabled = isReminderEnabled(settings.reminderReturnEnabled, settings.remindersEnabled);
  if (!pickupEnabled && !returnEnabled) {
    db.prepare("DELETE FROM notification_jobs WHERE booking_id=? AND status='PENDING'").run(bookingId);
    return;
  }

  db.prepare(`UPDATE notification_jobs SET status='CANCELLED'
    WHERE booking_id=? AND status='PENDING' AND type IN ('REMINDER_PICKUP','REMINDER_RETURN')`).run(bookingId);

  const dates = db.prepare(
    "SELECT MIN(date_from) starts, MAX(date_to) ends FROM booking_lines WHERE booking_id=?",
  ).get(bookingId) as { starts?: string; ends?: string } | undefined;
  const lines = db.prepare("SELECT type FROM booking_lines WHERE booking_id=?").all(bookingId) as { type: string }[];
  const allService = lines.length > 0 && lines.every((l) => l.type === "SERVICE");
  const insert = db.prepare(`INSERT INTO notification_jobs(id,booking_id,type,scheduled_at,status,created_at)
    VALUES(?,?,?,?,'PENDING',?)`);

  const reminders = [
    { type: "REMINDER_PICKUP", enabled: pickupEnabled, date: dates?.starts, hours: settings.reminderPickupHours },
    { type: "REMINDER_RETURN", enabled: returnEnabled, date: dates?.ends, hours: settings.reminderReturnHours },
  ];
  for (const reminder of reminders) {
    if (!reminder.enabled) continue;
    // Skip REMINDER_RETURN for service-only bookings
    if (allService && reminder.type === "REMINDER_RETURN") continue;
    if (!reminder.date) continue;
    const at = new Date(reminder.date).getTime() - Math.max(0, Number(reminder.hours) || 0) * 3_600_000;
    if (at > Date.now()) {
      insert.run(uid(), bookingId, reminder.type, new Date(at).toISOString(), now());
    }
  }
}

export function cancelBookingNotifications(bookingId: string) {
  db.prepare("UPDATE notification_jobs SET status='CANCELLED' WHERE booking_id=? AND status='PENDING'").run(bookingId);
}

export async function dispatchDueNotifications() {
  const jobs = db.prepare(`SELECT * FROM notification_jobs WHERE status='PENDING' AND scheduled_at<=?
    ORDER BY scheduled_at LIMIT 50`).all(now()) as any[];
  for (const job of jobs) {
    try {
      const booking = db.prepare("SELECT * FROM bookings WHERE id=?").get(job.booking_id) as any;
      const lines = db.prepare("SELECT * FROM booking_lines WHERE booking_id=? ORDER BY rowid")
        .all(job.booking_id) as any[];
      if (!booking || booking.status === "CANCELLED") {
        db.prepare("UPDATE notification_jobs SET status='CANCELLED' WHERE id=?").run(job.id);
        continue;
      }
      if (job.type === "REMINDER_PICKUP" && ["PICKED_UP", "RETURNED", "COMPLETED"].includes(booking.status)) {
        db.prepare("UPDATE notification_jobs SET status='CANCELLED' WHERE id=?").run(job.id);
        continue;
      }
      if (job.type === "REMINDER_RETURN" && ["RETURNED", "COMPLETED"].includes(booking.status)) {
        db.prepare("UPDATE notification_jobs SET status='CANCELLED' WHERE id=?").run(job.id);
        continue;
      }

      emit(job.booking_id, "booking.reminder_due", { notificationJobId: job.id, type: job.type });

      if (job.type !== "REMINDER_PICKUP" && job.type !== "REMINDER_RETURN") {
        db.prepare("UPDATE notification_jobs SET status='SENT',sent_at=?,attempts=attempts+1 WHERE id=?").run(now(), job.id);
        continue;
      }

      const rentals = lines.filter((line) => line.type === "RENTAL");
      const starts = lines.map((line) => line.date_from).filter(Boolean).sort()[0] || "";
      const ends = lines.map((line) => line.date_to).filter(Boolean).sort().at(-1) || "";
      const relevantDate = job.type === "REMINDER_PICKUP" ? starts : ends;
      const store = booking.store_id
        ? db.prepare("SELECT name,city FROM stores WHERE id=?").get(booking.store_id) as any
        : null;
      const storeLabel = store ? [store.name, store.city].filter(Boolean).join(" — ") : "-";
      const values: Record<string, string> = {
        firstName: escapeHtml(booking.customer_first),
        lastName: escapeHtml(booking.customer_last),
        ref: escapeHtml(booking.ref),
        store: escapeHtml(storeLabel),
        date: escapeHtml(relevantDate ? formatDate(relevantDate) : ""),
        time: escapeHtml(relevantDate ? formatTime(relevantDate) : ""),
        items: escapeHtml(rentals.map((line) => `${line.qty}× ${line.product_name}`).join(", ")),
      };
      const settings = getSettings();
      const isPickup = job.type === "REMINDER_PICKUP";
      const subject = renderTemplate(
        (isPickup ? settings.reminderPickupSubject : settings.reminderReturnSubject)
          || (isPickup ? DEFAULT_PICKUP_SUBJECT : DEFAULT_RETURN_SUBJECT),
        values,
      );
      let html = renderTemplate(
        (isPickup ? settings.reminderPickupTemplate : settings.reminderReturnTemplate)
          || (isPickup ? DEFAULT_PICKUP_TEMPLATE : DEFAULT_RETURN_TEMPLATE),
        values,
      );
      const meetingUrl = lines
        .filter((line) => line.session_id)
        .map((line) => db.prepare("SELECT meeting_url FROM sessions WHERE id=?").get(line.session_id) as { meeting_url: string } | undefined)
        .find((session) => session?.meeting_url)?.meeting_url || "";
      if (meetingUrl) {
        html += `<p><strong>Join online:</strong> <a href="${escapeHtml(meetingUrl)}">${escapeHtml(meetingUrl)}</a></p>`;
      }
      const sent = await sendMail({
        to: booking.customer_email,
        subject,
        text: html.replace(/<[^>]*>/g, ""),
        html,
      });
      if (sent) {
        db.prepare("UPDATE notification_jobs SET status='SENT',sent_at=?,attempts=attempts+1,last_error='' WHERE id=?")
          .run(now(), job.id);
      } else {
        const attempts = Number(job.attempts) + 1;
        db.prepare("UPDATE notification_jobs SET status=?,attempts=?,last_error='smtp_unavailable_or_failed' WHERE id=?")
          .run(attempts >= 3 ? "FAILED" : "PENDING", attempts, job.id);
      }
    } catch (error) {
      db.prepare("UPDATE notification_jobs SET attempts=attempts+1,last_error=? WHERE id=?")
        .run(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), job.id);
    }
  }
}

export function startNotificationSchedule() {
  dispatchDueNotifications();
  const timer = setInterval(dispatchDueNotifications, 60_000);
  timer.unref();
}
