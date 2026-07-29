import { Router } from "express";
import { db, getSettings } from "../db.js";
import { requireOwner, requirePerm } from "../lib/auth.js";
import { calendarCallbackUrl, linkCallback, linkStart, syncAllResources, type CalendarProvider } from "../lib/calendarSync.js";
import { decryptSecret } from "../lib/crypto.js";

export const calendarsRouter = Router();

calendarsRouter.get("/resources/:id/calendar", requirePerm("sessions"), (req, res) => {
  const row = db.prepare(`SELECT provider,account_email AS accountEmail,last_sync_at AS lastSyncAt,last_error AS lastError
    FROM resource_calendars WHERE resource_id=?`).get(req.params.id);
  res.json(row || null);
});

calendarsRouter.post("/resources/:id/calendar/link", requireOwner, (req, res) => {
  const provider = String(req.body?.provider || "") as CalendarProvider;
  if (!["GOOGLE", "MICROSOFT"].includes(provider)) return res.status(400).json({ error: "invalid_provider" });
  const settings = getSettings();
  const clientId = provider === "GOOGLE" ? settings.googleClientId : settings.msClientId;
  const encryptedSecret = provider === "GOOGLE" ? settings.googleClientSecretEnc : settings.msClientSecretEnc;
  let hasSecret = false;
  try { hasSecret = Boolean(encryptedSecret && decryptSecret(encryptedSecret)); } catch { hasSecret = false; }
  if (!clientId || !hasSecret) return res.status(400).json({ error: "provider_not_configured" });
  if (!db.prepare("SELECT 1 FROM resources WHERE id=?").get(req.params.id)) return res.status(404).json({ error: "resource_not_found" });
  try {
    const { authUrl } = linkStart(provider, req.params.id);
    return res.json({ authUrl });
  } catch (error) {
    return res.status(400).json({ error: String((error as Error).message || error) });
  }
});

calendarsRouter.get("/calendars/oauth/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const result = code && state ? await linkCallback("", code, state) : { ok: false, error: "missing_code_or_state" };
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Calendar</title></head>
    <body><p>${result.ok ? "Calendar linked! You can close this window." : `Error: ${escapeHtml(result.error || "unknown_error")}`}</p></body></html>`);
});

calendarsRouter.delete("/resources/:id/calendar", requireOwner, (req, res) => {
  db.transaction(() => {
    db.prepare("DELETE FROM resource_calendars WHERE resource_id=?").run(req.params.id);
    db.prepare("DELETE FROM resource_blocks WHERE resource_id=? AND source IN ('GOOGLE','MICROSOFT')").run(req.params.id);
    db.prepare("DELETE FROM session_calendar_events WHERE resource_id=?").run(req.params.id);
  })();
  res.json({ ok: true });
});

calendarsRouter.post("/calendars/sync", requireOwner, async (_req, res) => {
  res.json({ results: await syncAllResources() });
});

calendarsRouter.get("/calendars/callback-url", requireOwner, (_req, res) => {
  res.json({ callbackUrl: calendarCallbackUrl() });
});

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] || character);
}
