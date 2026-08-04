import { getSettings } from "../db.js";
import { round2 } from "../engine/pricing.js";

function settingNumber(value: string | undefined, fallback: number) {
  if (value == null || value.trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

const bookingTimeZone = process.env.BOOKING_TZ || "America/Toronto";

function localTime(iso: string): string {
  // A timezone-less string is already shop wall-clock time; Date-parsing it
  // would reinterpret it in the host timezone.
  const naive = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso);
  if (naive && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return naive[1];
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: bookingTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return `${hour}:${minute}`;
}

export function validateRentalWindow(fromISO: string, toISO: string): { ok: true } | { ok: false; error: string } {
  const settings = getSettings();
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const durationSeconds = (to.getTime() - from.getTime()) / 1000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { ok: false, error: "Choose a valid date range" };
  }

  const pickupEarliestTime = settings.pickupEarliestTime?.trim();
  if (pickupEarliestTime && localTime(fromISO) < pickupEarliestTime) {
    return { ok: false, error: `Pickups start at ${pickupEarliestTime}` };
  }
  const returnByTime = settings.returnByTime?.trim();
  if (returnByTime && localTime(toISO) > returnByTime) {
    return { ok: false, error: `Returns are due by ${returnByTime}` };
  }

  const valueText = settings.rentalIncrementValue?.trim();
  if (!valueText) return { ok: true };
  const increment = Number(valueText);
  if (!Number.isInteger(increment) || increment <= 0) return { ok: true };
  const unit = settings.rentalIncrementUnit === "hour" ? "hour" : "day";
  let valid: boolean;
  if (unit === "hour") {
    const blockSeconds = increment * 3600;
    const remainder = durationSeconds % blockSeconds;
    valid = remainder <= 60 || blockSeconds - remainder <= 60;
  } else {
    const fromDate = fromISO.slice(0, 10);
    const toDate = toISO.slice(0, 10);
    const days = (new Date(`${toDate}T00:00:00Z`).getTime() - new Date(`${fromDate}T00:00:00Z`).getTime()) / 86_400_000;
    valid = Number.isInteger(days) && days > 0 && days % increment === 0;
  }
  return valid
    ? { ok: true }
    : { ok: false, error: `Rentals are booked in blocks of ${increment} ${unit}(s)` };
}

export function refundQuote(
  booking: { total: number },
  firstStart: string,
  at: Date = new Date(),
): {
  enabled: boolean;
  daysBefore: number;
  percent: number;
  amount: number;
  tier: "full" | "partial" | "none";
} {
  const settings = getSettings();
  const enabled = settings.cancelPolicyEnabled === "1";
  const partialDays = settingNumber(settings.cancelPartialRefundDays, 2);
  let fullDays = settingNumber(settings.cancelFullRefundDays, 7);
  const partialPercent = Math.min(100, Math.max(0, settingNumber(settings.cancelPartialRefundPercent, 50)));
  if (fullDays <= partialDays) fullDays = partialDays + 1;

  const daysBefore = (new Date(firstStart).getTime() - at.getTime()) / 86_400_000;
  const total = Number(booking.total);
  const fullAmount = round2(Number.isFinite(total) ? total : 0);

  if (!enabled || daysBefore >= fullDays) {
    return { enabled, daysBefore, percent: 100, amount: fullAmount, tier: "full" };
  }
  if (daysBefore >= partialDays) {
    return {
      enabled: true,
      daysBefore,
      percent: partialPercent,
      amount: round2(fullAmount * partialPercent / 100),
      tier: "partial",
    };
  }
  return { enabled: true, daysBefore, percent: 0, amount: 0, tier: "none" };
}
