import crypto from "node:crypto";
import { db, getSettings, now, uid } from "../db.js";
import { decryptSecret, encryptSecret, key } from "./crypto.js";

export type CalendarProvider = "GOOGLE" | "MICROSOFT";
type CalendarRow = {
  resource_id: string; provider: CalendarProvider; calendar_id: string; account_email: string;
  access_token_enc: string; refresh_token_enc: string; expires_at: number; sync_token: string;
  last_sync_at: string; last_error: string;
};

const TIMEOUT = 5_000;
const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
const baseUrl = () => (getSettings().calendarPublicUrl || getSettings().publicUrl || process.env.PUBLIC_URL || "").replace(/\/+$/, "");
export const calendarCallbackUrl = () => `${baseUrl()}/api/calendars/oauth/callback`;

function secret(provider: CalendarProvider) {
  const settings = getSettings();
  const stored = provider === "GOOGLE" ? settings.googleClientSecretEnc : settings.msClientSecretEnc;
  return stored ? decryptSecret(stored) : "";
}

function signedState(resourceId: string, provider: CalendarProvider) {
  const payload = Buffer.from(JSON.stringify({ resourceId, provider, timestamp: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(state: string): { resourceId: string; provider: CalendarProvider; timestamp: number } {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) throw new Error("invalid_state");
  const expected = crypto.createHmac("sha256", key()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("invalid_state");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!parsed.resourceId || !["GOOGLE", "MICROSOFT"].includes(parsed.provider) || Date.now() - Number(parsed.timestamp) > 15 * 60_000) {
    throw new Error("invalid_or_expired_state");
  }
  return parsed;
}

export function linkStart(provider: CalendarProvider, resourceId: string): { authUrl: string; callbackUrl: string } {
  const settings = getSettings();
  const state = signedState(resourceId, provider);
  const callbackUrl = calendarCallbackUrl();
  if (!baseUrl()) throw new Error("calendar_public_url_required");
  const params = new URLSearchParams({
    client_id: provider === "GOOGLE" ? settings.googleClientId : settings.msClientId,
    redirect_uri: callbackUrl, response_type: "code", state,
    scope: provider === "GOOGLE" ? "https://www.googleapis.com/auth/calendar" : "offline_access Calendars.ReadWrite User.Read",
  });
  if (provider === "GOOGLE") {
    params.set("access_type", "offline");
    params.set("prompt", "consent");
    return { authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, callbackUrl };
  }
  return { authUrl: `https://login.microsoftonline.com/${encodeURIComponent(settings.msTenantId || "common")}/oauth2/v2.0/authorize?${params}`, callbackUrl };
}

async function jsonResponse(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(body.error_description || body.error?.message || body.error || `HTTP ${response.status}`);
  return body;
}

export async function linkCallback(providerInput: string, code: string, state: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const verified = verifyState(state);
    if (providerInput && providerInput !== verified.provider) throw new Error("provider_mismatch");
    const provider = verified.provider;
    const settings = getSettings();
    const tokenUrl = provider === "GOOGLE"
      ? "https://oauth2.googleapis.com/token"
      : `https://login.microsoftonline.com/${encodeURIComponent(settings.msTenantId || "common")}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: provider === "GOOGLE" ? settings.googleClientId : settings.msClientId,
      client_secret: secret(provider), code, redirect_uri: calendarCallbackUrl(), grant_type: "authorization_code",
    });
    if (provider === "MICROSOFT") body.set("scope", "offline_access Calendars.ReadWrite User.Read");
    const tokens = await jsonResponse(await request(tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    }));
    const accessToken = String(tokens.access_token || "");
    if (!accessToken) throw new Error("token_exchange_failed");
    let calendarId = "primary", email = "";
    if (provider === "GOOGLE") {
      const info = await jsonResponse(await request("https://www.googleapis.com/calendar/v3/calendars/primary", {
        headers: { authorization: `Bearer ${accessToken}` },
      }));
      calendarId = String(info.id || "primary");
      email = String(info.id || "");
    } else {
      const profile = await jsonResponse(await request("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { authorization: `Bearer ${accessToken}` },
      }));
      email = String(profile.mail || profile.userPrincipalName || "");
      const calendars = await jsonResponse(await request("https://graph.microsoft.com/v1.0/me/calendars?$filter=isDefaultCalendar%20eq%20true&$select=id", {
        headers: { authorization: `Bearer ${accessToken}` },
      }));
      calendarId = String(calendars.value?.[0]?.id || "");
    }
    db.prepare(`INSERT INTO resource_calendars
      (resource_id,provider,calendar_id,account_email,access_token_enc,refresh_token_enc,expires_at,sync_token,last_sync_at,last_error,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(resource_id) DO UPDATE SET provider=excluded.provider,calendar_id=excluded.calendar_id,
      account_email=excluded.account_email,access_token_enc=excluded.access_token_enc,
      refresh_token_enc=excluded.refresh_token_enc,expires_at=excluded.expires_at,sync_token='',last_error=''`)
      .run(verified.resourceId, provider, calendarId, email, encryptSecret(accessToken),
        tokens.refresh_token ? encryptSecret(String(tokens.refresh_token)) : "",
        Date.now() + Number(tokens.expires_in || 3600) * 1000, "", "", "", now());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error).message || error) };
  }
}

function calendarRow(resourceId: string) {
  return db.prepare("SELECT * FROM resource_calendars WHERE resource_id=?").get(resourceId) as CalendarRow | undefined;
}

export async function refreshIfNeeded(row: CalendarRow): Promise<boolean> {
  if (Number(row.expires_at) > Date.now() + 30_000) return true;
  try {
    if (!row.refresh_token_enc) throw new Error("missing_refresh_token");
    const settings = getSettings();
    const tokenUrl = row.provider === "GOOGLE"
      ? "https://oauth2.googleapis.com/token"
      : `https://login.microsoftonline.com/${encodeURIComponent(settings.msTenantId || "common")}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: row.provider === "GOOGLE" ? settings.googleClientId : settings.msClientId,
      client_secret: secret(row.provider), refresh_token: decryptSecret(row.refresh_token_enc), grant_type: "refresh_token",
    });
    if (row.provider === "MICROSOFT") body.set("scope", "offline_access Calendars.ReadWrite User.Read");
    const tokens = await jsonResponse(await request(tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    }));
    db.prepare(`UPDATE resource_calendars SET access_token_enc=?,refresh_token_enc=?,
      expires_at=?,last_error='' WHERE resource_id=?`).run(
      encryptSecret(String(tokens.access_token)),
      tokens.refresh_token ? encryptSecret(String(tokens.refresh_token)) : row.refresh_token_enc,
      Date.now() + Number(tokens.expires_in || 3600) * 1000, row.resource_id,
    );
    return true;
  } catch (error) {
    const message = String((error as Error).message || error);
    db.prepare("UPDATE resource_calendars SET last_error=? WHERE resource_id=?").run(message, row.resource_id);
    console.warn("[calendar] token refresh failed", { resourceId: row.resource_id, error: message });
    return false;
  }
}

function eventIdFor(sessionId: string, resourceId: string) {
  return (db.prepare("SELECT external_event_id FROM session_calendar_events WHERE session_id=? AND resource_id=?")
    .get(sessionId, resourceId) as { external_event_id: string } | undefined)?.external_event_id || "";
}

export async function pushSessionEvent(session: any, resourceId: string): Promise<void> {
  try {
    let row = calendarRow(resourceId);
    if (!row || !(await refreshIfNeeded(row))) return;
    row = calendarRow(resourceId);
    if (!row) return;
    const product = db.prepare("SELECT name FROM products WHERE id=?").get(session.product_id || session.productId) as { name: string } | undefined;
    const resource = db.prepare("SELECT name FROM resources WHERE id=?").get(resourceId) as { name: string } | undefined;
    const externalId = eventIdFor(session.id, resourceId) || (session.room_id === resourceId ? session.external_event_id : "");
    const payload = row.provider === "GOOGLE" ? {
      summary: product?.name || "Reservly session",
      description: `Reservly session ID: ${session.id}\nResource: ${resource?.name || resourceId}`,
      start: { dateTime: session.starts_at || session.startsAt },
      end: { dateTime: session.ends_at || session.endsAt },
    } : {
      subject: product?.name || "Reservly session",
      body: { contentType: "text", content: `Reservly session ID: ${session.id}\nResource: ${resource?.name || resourceId}` },
      start: { dateTime: session.starts_at || session.startsAt, timeZone: "UTC" },
      end: { dateTime: session.ends_at || session.endsAt, timeZone: "UTC" },
    };
    const root = row.provider === "GOOGLE"
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendar_id || "primary")}/events`
      : "https://graph.microsoft.com/v1.0/me/events";
    const response = await request(`${root}${externalId ? `/${encodeURIComponent(externalId)}` : ""}`, {
      method: externalId ? "PATCH" : "POST",
      headers: { authorization: `Bearer ${decryptSecret(row.access_token_enc)}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await jsonResponse(response);
    const id = String(result.id || externalId);
    db.prepare(`INSERT INTO session_calendar_events(session_id,resource_id,external_event_id) VALUES (?,?,?)
      ON CONFLICT(session_id,resource_id) DO UPDATE SET external_event_id=excluded.external_event_id`).run(session.id, resourceId, id);
    if ((session.room_id || session.roomId) === resourceId) db.prepare("UPDATE sessions SET external_event_id=? WHERE id=?").run(id, session.id);
  } catch (error) {
    console.warn("[calendar] session push failed", { sessionId: session?.id, resourceId, error: String(error) });
  }
}

export async function deleteSessionEvent(sessionId: string, resourceId: string): Promise<void> {
  try {
    let row = calendarRow(resourceId);
    const session = db.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as any;
    const externalId = eventIdFor(sessionId, resourceId) || (session?.room_id === resourceId ? session.external_event_id : "");
    if (!row || !externalId || !(await refreshIfNeeded(row))) return;
    row = calendarRow(resourceId);
    const url = row!.provider === "GOOGLE"
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row!.calendar_id || "primary")}/events/${encodeURIComponent(externalId)}`
      : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalId)}`;
    const response = await request(url, { method: "DELETE", headers: { authorization: `Bearer ${decryptSecret(row!.access_token_enc)}` } });
    if (!response.ok && response.status !== 404 && response.status !== 410) await jsonResponse(response);
    db.prepare("DELETE FROM session_calendar_events WHERE session_id=? AND resource_id=?").run(sessionId, resourceId);
    if (session?.room_id === resourceId) db.prepare("UPDATE sessions SET external_event_id='' WHERE id=?").run(sessionId);
  } catch (error) {
    console.warn("[calendar] session delete failed", { sessionId, resourceId, error: String(error) });
  }
}

const localParts = (value: string, timeZone?: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, time: "00:00" };
  if (!value.endsWith("Z") && !/[+-]\d\d:\d\d$/.test(value)) {
    return { date: value.slice(0, 10), time: value.slice(11, 16) || "00:00" };
  }
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || process.env.BOOKING_TZ || "America/Toronto",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
};

export async function pullBusy(resourceId: string, fromISO: string, toISO: string): Promise<void> {
  try {
    let row = calendarRow(resourceId);
    if (!row || !(await refreshIfNeeded(row))) return;
    row = calendarRow(resourceId)!;
    const incremental = Boolean(row.sync_token);
    let url: string;
    if (row.provider === "GOOGLE") {
      const params = new URLSearchParams({ singleEvents: "true", showDeleted: "true", maxResults: "2500" });
      if (incremental) params.set("syncToken", row.sync_token);
      else { params.set("timeMin", fromISO); params.set("timeMax", toISO); }
      url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(row.calendar_id || "primary")}/events?${params}`;
    } else {
      url = incremental ? row.sync_token : `https://graph.microsoft.com/v1.0/me/calendarView/delta?startDateTime=${encodeURIComponent(fromISO)}&endDateTime=${encodeURIComponent(toISO)}`;
    }
    const seen = new Set<string>(), deleted = new Set<string>();
    let nextToken = row.sync_token;
    while (url) {
      const data = await jsonResponse(await request(url, { headers: { authorization: `Bearer ${decryptSecret(row.access_token_enc)}` } }));
      const events = data.items || data.value || [];
      for (const event of events) {
        const id = String(event.id || "");
        if (!id) continue;
        if (event.status === "cancelled" || event["@removed"]) { deleted.add(id); continue; }
        seen.add(id);
        const startValue = event.start?.dateTime || event.start?.date;
        const endValue = event.end?.dateTime || event.end?.date;
        if (!startValue || !endValue) continue;
        if (db.prepare("SELECT 1 FROM session_calendar_events WHERE resource_id=? AND external_event_id=?").get(resourceId, id)) continue;
        const start = localParts(startValue, event.start?.timeZone);
        const end = localParts(endValue, event.end?.timeZone);
        if (db.prepare("SELECT 1 FROM resource_blocks WHERE resource_id=? AND external_event_id=?").get(resourceId, id)) continue;
        db.prepare(`INSERT INTO resource_blocks(id,resource_id,date,from_time,to_time,reason,source,created_at,external_event_id)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(uid(), resourceId, start.date, start.time, end.time > start.time ? end.time : "23:59",
          `Imported from ${row.provider}`, row.provider, now(), id);
      }
      if (row.provider === "GOOGLE") {
        url = data.nextPageToken ? `${url.split("&pageToken=")[0]}&pageToken=${encodeURIComponent(data.nextPageToken)}` : "";
        if (data.nextSyncToken) nextToken = data.nextSyncToken;
      } else {
        url = data["@odata.nextLink"] || "";
        if (data["@odata.deltaLink"]) nextToken = data["@odata.deltaLink"];
      }
    }
    for (const id of deleted) db.prepare("DELETE FROM resource_blocks WHERE resource_id=? AND source=? AND external_event_id=?").run(resourceId, row.provider, id);
    if (!incremental) {
      const rows = db.prepare("SELECT external_event_id FROM resource_blocks WHERE resource_id=? AND source=? AND external_event_id<>''").all(resourceId, row.provider) as { external_event_id: string }[];
      for (const item of rows) if (!seen.has(item.external_event_id)) {
        db.prepare("DELETE FROM resource_blocks WHERE resource_id=? AND source=? AND external_event_id=?").run(resourceId, row.provider, item.external_event_id);
      }
    }
    db.prepare("UPDATE resource_calendars SET sync_token=?,last_sync_at=?,last_error='' WHERE resource_id=?").run(nextToken || "", now(), resourceId);
  } catch (error) {
    const message = String((error as Error).message || error);
    if (message.includes("410") || message.includes("Sync token")) db.prepare("UPDATE resource_calendars SET sync_token='' WHERE resource_id=?").run(resourceId);
    db.prepare("UPDATE resource_calendars SET last_error=? WHERE resource_id=?").run(message, resourceId);
    console.warn("[calendar] pull failed", { resourceId, error: message });
  }
}

export async function syncAllResources(): Promise<{ resourceId: string; ok: boolean; error?: string }[]> {
  const results: { resourceId: string; ok: boolean; error?: string }[] = [];
  let rows: CalendarRow[] = [];
  try {
    rows = db.prepare("SELECT * FROM resource_calendars").all() as CalendarRow[];
  } catch (error) {
    console.warn("[calendar] could not list linked resources", String(error));
    return results;
  }
  for (const row of rows) {
    try {
      if (!(await refreshIfNeeded(row))) {
        const error = (calendarRow(row.resource_id)?.last_error || "token_refresh_failed");
        results.push({ resourceId: row.resource_id, ok: false, error });
        continue;
      }
      const from = new Date();
      const to = new Date(from.getTime() + 8 * 7 * 86_400_000);
      await pullBusy(row.resource_id, from.toISOString(), to.toISOString());
      const error = calendarRow(row.resource_id)?.last_error || "";
      results.push(error ? { resourceId: row.resource_id, ok: false, error } : { resourceId: row.resource_id, ok: true });
    } catch (error) {
      const message = String((error as Error).message || error);
      db.prepare("UPDATE resource_calendars SET last_error=? WHERE resource_id=?").run(message, row.resource_id);
      results.push({ resourceId: row.resource_id, ok: false, error: message });
    }
  }
  return results;
}
