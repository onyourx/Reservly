// Booking lifecycle events: stored locally and forwarded to Conduit (the iPaaS),
// which owns the cross-system flows — HubSpot transactional emails (R6/R19, class
// steps 11/17), NAV notifications, etc. Forwarding is fire-and-forget: integrations
// must never block or fail the in-store flow.
import { getSettings, logEvent } from "../db.js";
import { dispatchWebhooks } from "./webhooks.js";

export function emit(bookingId: string | null, type: string, detail: Record<string, unknown> = {}) {
  logEvent(bookingId, type, detail);

  // Registered outbound webhooks get the FULL booking snapshot so consumers
  // (Conduit recipes → outside systems) never need a follow-up call.
  // Lazy import avoids the events ↔ bookingService cycle.
  void (async () => {
    let booking: unknown = null;
    try {
      if (bookingId) {
        const { serializeBooking } = await import("./bookingService.js");
        booking = serializeBooking(bookingId);
      }
    } catch {
      /* snapshot is best-effort */
    }
    dispatchWebhooks(type, { bookingId, detail, booking });
  })();

  const conduitUrl = getSettings().conduitUrl?.replace(/\/+$/, "");
  if (!conduitUrl) return;
  fetch(`${conduitUrl}/api/pub/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "booking", type, bookingId, detail, at: new Date().toISOString() }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}
