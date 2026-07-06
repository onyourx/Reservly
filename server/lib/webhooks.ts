// Outbound booking webhooks: every booking.* event is delivered to each active
// subscription with the FULL booking snapshot, so consumers (Conduit recipes,
// or anything else) never have to call back for details. Bodies are signed with
// HMAC-SHA256 (X-Booking-Signature) when the subscription has a secret.
// Delivery is fire-and-forget with one retry — integrations never block staff.
import crypto from "node:crypto";
import { db, now, pj } from "../db.js";

export interface WebhookRow {
  id: string; url: string; events: string; secret: string; active: number;
  created_at: string; last_status: string;
}

export function matchingWebhooks(eventType: string): WebhookRow[] {
  const rows = db.prepare("SELECT * FROM webhooks WHERE active = 1").all() as WebhookRow[];
  return rows.filter((w) => {
    if (w.events === "*" || !w.events) return true;
    const list = pj<string[]>(w.events, []);
    return list.includes(eventType) || list.includes("*");
  });
}

async function deliverOnce(hook: WebhookRow, body: string): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "gosselin-booking/1.0",
  };
  if (hook.secret) {
    headers["x-booking-signature"] = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
  }
  const res = await fetch(hook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
  return `${res.status} @ ${now()}`;
}

export function dispatchWebhooks(eventType: string, payload: Record<string, unknown>) {
  const hooks = matchingWebhooks(eventType);
  if (!hooks.length) return;
  const body = JSON.stringify({ event: eventType, at: now(), ...payload });
  for (const hook of hooks) {
    void (async () => {
      let status: string;
      try {
        status = await deliverOnce(hook, body);
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          status = await deliverOnce(hook, body);
        } catch (err) {
          status = `failed: ${String((err as Error).message ?? err).slice(0, 120)} @ ${now()}`;
        }
      }
      db.prepare("UPDATE webhooks SET last_status = ? WHERE id = ?").run(status, hook.id);
    })();
  }
}
