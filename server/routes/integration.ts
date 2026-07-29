// Shopify + settings + events surfaces.
//
// One-cart checkout: the storefront widget adds the booking product to the Shopify
// cart with `_booking_*` line item properties; retail items ride in the same cart.
// Shopify processes payment for everything at once; orders/create lands here and we
// create the booking + NAV reservation (R4-R5, class steps 6-10). B2B customers use
// Shopify's native pay-later terms — the order arrives unpaid and the booking stays
// RESERVED until reconciliation.
import { Router, raw } from "express";
import crypto from "node:crypto";
import { db, getSettings, putSettings, pj, auditLog, uid, now, currentTenant } from "../db.js";
import { navMode } from "../lib/nav.js";
import { ensureMetafieldDefinitions, getShopifyCustomerEmail } from "../lib/shopifyAdmin.js";
import { authRequired, isAuthenticated, login, logout, requireOwner, setAdminPassword, staffAccess } from "../lib/auth.js";
import { adminSession } from "../lib/platform.js";
import { getStaffSession, staffTokenOf } from "../lib/staffSessions.js";
import { collectCustomerData, redactCustomer, sweepRetention } from "../lib/privacy.js";
import { BookingValidationError, createBooking } from "../lib/bookingService.js";
import { quoteLines } from "../engine/pricing.js";
import { rentalAvailability, courseSlots, serviceSlots } from "../engine/availability.js";
import { encryptPasswordForSftp, sftpConfigured, testSftp } from "../lib/idPhotos.js";
import { sendClassTicketEmail } from "../lib/ticketEmail.js";

export const settingsRouter = Router();
export const shopifyRouter = Router(); // mounted at /webhooks/shopify with raw body
export const proxyRouter = Router();   // mounted at /proxy (Shopify App Proxy)

// --- Settings / health / events ---------------------------------------------

export const SAFE_KEYS = ["currency", "navMode", "navBaseUrl", "navUsername", "navDomain", "shopifyShop", "shopifyClientId", "sftpHost", "sftpPort", "sftpUser", "sftpPath", "conduitUrl", "posStoreId", "posTerminalId", "posStaffId", "idRetentionDays", "dataRetentionDays", "publicUrl", "contractTemplate", "enabledLanguages", "zoomAccountId", "zoomClientId", "zoomUserId", "slotHoldMinutes", "maxCustomerReschedules", "extensionsEnabled", "extensionApproval", "noShowFeeMode", "noShowFeeValue", "reminderHours", "remindersEnabled", "reminderPickupEnabled", "reminderReturnEnabled", "reminderPickupHours", "reminderReturnHours", "reminderPickupSubject", "reminderPickupTemplate", "reminderReturnSubject", "reminderReturnTemplate", "cancelPolicyEnabled", "cancelFullRefundDays", "cancelPartialRefundDays", "cancelPartialRefundPercent", "pickupEarliestTime", "returnByTime", "serviceOpenTime", "serviceCloseTime", "rentalIncrementUnit", "rentalIncrementValue", "termsRentalEnabled", "termsCourseEnabled", "termsServiceEnabled", "termsRentalHtml", "termsCourseHtml", "termsServiceHtml"];

settingsRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    navMode: navMode(),
    shopifyConfigured: Boolean(getSettings().shopifyApiSecret),
    sftpConfigured: sftpConfigured(),
    authRequired: authRequired(),
  });
});

// --- Staff auth (open endpoints; everything else behind requireAuth) ----------

settingsRouter.get("/auth", (req, res) => {
  const required = authRequired();
  const authenticated = isAuthenticated(req);

  let role: "superadmin" | "staff" | null = null;
  let tenant: string | null = null;
  let username: string | null = null;

  const adminSesh = adminSession(req);
  if (adminSesh) {
    role = "superadmin";
    tenant = adminSesh.tenantSlug;
    username = adminSesh.email;
  } else {
    const staffSesh = getStaffSession(staffTokenOf(req));
    if (staffSesh && staffSesh.expiresAt > Date.now() && staffSesh.tenantSlug === currentTenant().slug) {
      role = "staff";
      tenant = staffSesh.tenantSlug;
      username = staffSesh.username;
    }
  }

  const detailed = authenticated ? staffAccess(req) : null;
  res.json({
    required,
    authenticated,
    role,
    tenant,
    username,
    access: detailed ? {
      role: detailed.role,
      permissions: detailed.perms,
      storeIds: detailed.storeIds,
      canManageUsers: ["superadmin", "legacy", "owner"].includes(detailed.role),
    } : null,
  });
});
settingsRouter.post("/login", login);
settingsRouter.post("/logout", logout);

settingsRouter.get("/settings", (_req, res) => {
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SAFE_KEYS.map((k) => [k, s[k] ?? ""])) });
});

settingsRouter.put("/settings", requireOwner, (req, res) => {
  const { adminPassword, sftpPassword, sftpPasswordEnc: _ignoredSftpPasswordEnc, ...rest } = req.body ?? {};
  if ("currency" in rest) {
    const normalized = String(rest.currency ?? "").toUpperCase().trim();
    if (!normalized) {
      delete rest.currency;
    } else {
      if (!/^[A-Z]{3}$/.test(normalized)) {
        return res.status(400).json({ error: "invalid_currency" });
      }
      rest.currency = normalized;
    }
  }
  try {
    if (adminPassword) setAdminPassword(String(adminPassword));
  } catch (err) {
    return res.status(400).json({ error: String((err as Error).message ?? err) });
  }
  for (const key of ["contractTemplate", "reminderPickupTemplate", "reminderReturnTemplate"]) {
    if (typeof rest[key] !== "string") continue;
    rest[key] = rest[key]
      .replace(/<(script|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(script|iframe|object|embed|form)\b[^>]*\/?>/gi, "")
      .replace(/\son\w+\s*=\s*(["']).*?\1/gi, "")
      .replace(/\s(href|src)\s*=\s*(["'])\s*javascript:.*?\2/gi, "");
  }
  if (sftpPassword && sftpPassword !== "") {
    putSettings({ sftpPasswordEnc: encryptPasswordForSftp(String(sftpPassword)) });
  }
  putSettings(rest);
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SAFE_KEYS.map((k) => [k, s[k] ?? ""])) });
});

settingsRouter.post("/sftp/test", requireOwner, async (_req, res) => {
  res.json(await testSftp());
});

// --- Privacy tooling (staff-facing, audited) -----------------------------------

settingsRouter.get("/privacy/export", requireOwner, (req, res) => {
  const email = String(req.query.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  res.json(collectCustomerData(email));
});

settingsRouter.post("/privacy/redact", requireOwner, (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  res.json({ redactedBookings: redactCustomer(email) });
});

settingsRouter.post("/privacy/sweep", requireOwner, (_req, res) => {
  res.json(sweepRetention());
});

// --- Outbound webhooks (booking.* events → Conduit / external systems) ----------

settingsRouter.get("/webhooks", requireOwner, (_req, res) => {
  const rows = db.prepare("SELECT id, url, events, active, created_at, last_status, CASE WHEN secret != '' THEN 1 ELSE 0 END AS has_secret FROM webhooks ORDER BY created_at").all() as any[];
  res.json({ webhooks: rows.map((w) => ({ id: w.id, url: w.url, events: w.events === "*" ? ["*"] : pj(w.events, ["*"]), active: !!w.active, createdAt: w.created_at, lastStatus: w.last_status, hasSecret: !!w.has_secret })) });
});

settingsRouter.post("/webhooks", requireOwner, (req, res) => {
  const { url, events, secret } = req.body ?? {};
  if (!/^https?:\/\//.test(String(url ?? ""))) return res.status(400).json({ error: "A valid http(s) url is required" });
  const id = uid();
  const eventsVal = Array.isArray(events) && events.length && !events.includes("*") ? JSON.stringify(events) : "*";
  db.prepare("INSERT INTO webhooks (id, url, events, secret, active, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(id, String(url), eventsVal, String(secret ?? ""), now());
  auditLog("webhook.created", String(url));
  res.json({ id });
});

settingsRouter.delete("/webhooks/:id", requireOwner, (req, res) => {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

settingsRouter.post("/webhooks/:id/test", requireOwner, async (req, res) => {
  const hook = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(req.params.id) as any;
  if (!hook) return res.status(404).json({ error: "Webhook not found" });
  const { dispatchWebhooks } = await import("../lib/webhooks.js");
  dispatchWebhooks("booking.test", { bookingId: null, detail: { ping: true }, booking: null });
  res.json({ ok: true, note: "test event dispatched; lastStatus updates shortly" });
});

settingsRouter.get("/audit", requireOwner, (req, res) => {
  const rows = db.prepare("SELECT at, actor, action, subject, detail FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(Number(req.query.limit) || 100);
  res.json({ audit: rows });
});

/** One-click Shopify store setup: metafield definitions the widget reads. */
settingsRouter.post("/shopify/setup", requireOwner, async (_req, res) => {
  try {
    res.json({ results: await ensureMetafieldDefinitions() });
  } catch (err) {
    res.status(502).json({ error: String((err as Error).message ?? err) });
  }
});

settingsRouter.get("/events", requireOwner, (req, res) => {
  const { bookingId, limit } = req.query as Record<string, string>;
  const rows = bookingId
    ? db.prepare("SELECT * FROM events WHERE booking_id = ? ORDER BY id DESC LIMIT ?").all(bookingId, Number(limit) || 100)
    : db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(Number(limit) || 100);
  res.json({ events: (rows as any[]).map((e) => ({ at: e.at, type: e.type, bookingId: e.booking_id, detail: pj(e.detail, {}) })) });
});

settingsRouter.get("/notification-jobs", requireOwner, (req, res) => {
  const status = String(req.query.status || "");
  const rows = db.prepare(`SELECT n.*,b.ref,b.customer_email FROM notification_jobs n
    JOIN bookings b ON b.id=n.booking_id ${status ? "WHERE n.status=?" : ""}
    ORDER BY n.scheduled_at DESC LIMIT 250`).all(...(status ? [status] : []));
  res.json({ jobs: rows });
});

settingsRouter.post("/notification-jobs/dispatch", requireOwner, async (_req, res) => {
  const { dispatchDueNotifications } = await import("../lib/notifications.js");
  await dispatchDueNotifications();
  res.json({ ok: true });
});

// --- Shopify webhook: orders/create -------------------------------------------

function verifyShopifyHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean {
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

shopifyRouter.post("/orders-create", raw({ type: "*/*" }), async (req, res) => {
  const secret = getSettings().shopifyApiSecret;
  const hmac = String(req.headers["x-shopify-hmac-sha256"] ?? "");
  if (secret && !verifyShopifyHmac(req.body as Buffer, hmac, secret)) {
    return res.status(401).json({ error: "invalid webhook HMAC" });
  }
  let order: any;
  try {
    order = JSON.parse((req.body as Buffer).toString("utf8"));
  } catch {
    return res.status(400).json({ error: "invalid JSON" });
  }
  // Always 200 fast — Shopify retries on failure and we don't want duplicate bookings
  // for application-level issues; errors land in the event log instead.
  res.status(200).json({ ok: true });

  try {
    const noShowBookingId = order.note_attributes?.find((a: any) => a.name === "reservly_noshow_ref")?.value
      || order.line_items?.flatMap((item: any) => item.properties ?? [])
        .find((p: any) => p.name === "reservly_noshow_ref")?.value;
    if (noShowBookingId) {
      const booking = db.prepare("SELECT id,ref,no_show_fee_status FROM bookings WHERE id=?").get(String(noShowBookingId)) as any;
      if (booking && ["INVOICED", "PENDING_PAYMENT"].includes(booking.no_show_fee_status)) {
        db.prepare("UPDATE bookings SET no_show_fee_status='PAID',updated_at=? WHERE id=?").run(now(), booking.id);
        auditLog("booking.no_show_fee_paid", booking.ref, `Shopify order ${String(order.id ?? "")}`, "shopify");
      }
    }

    const extensionRequestId = order.note_attributes?.find((a: any) => a.name === "reservly_extension_id")?.value
      || order.line_items?.[0]?.properties?.find((p: any) => p.name === "reservly_extension_id")?.value;
    if (extensionRequestId) {
      try {
        const { applyPaidExtension } = await import("../lib/extensions.js");
        await applyPaidExtension(extensionRequestId);
      } catch (err) {
        console.error("[extensions] applyPaidExtension failed:", err);
      }
    }

    const existing = db.prepare("SELECT id FROM bookings WHERE shopify_order_id = ?").get(String(order.id)) as any;
    if (existing) return;

    const lines: any[] = [];
    const addons: any[] = [];
    const bookingProperties: Record<string, string> = {};
    const bookingLineProperties: Record<string, string>[] = [];
    for (const item of order.line_items ?? []) {
      const props: Record<string, string> = Object.fromEntries((item.properties ?? []).map((p: any) => [p.name, String(p.value)]));
      if (props._booking_addon_for) {
        addons.push({
          productNo: props._addon_product_no || item.sku || String(item.product_id),
          name: item.title || item.name || "Booking add-on", qty: item.quantity || 1,
          unitPrice: Number(item.price) || 0, shopifyVariantId: String(item.variant_id || ""),
        });
        continue;
      }
      if (!props._booking_type || props._cross_sell === "1") continue; // plain retail item OR cross-sell product
      Object.assign(bookingProperties, props);
      bookingLineProperties.push(props);
      if (props._booking_type === "RENTAL") {
        lines.push({ type: "RENTAL", productNo: props._product_no, storeId: props._store_id, from: props._from, to: props._to, qty: item.quantity || 1, holdToken: props._hold_token });
      } else if (props._booking_type === "COURSE") {
        lines.push({ type: "COURSE", sessionId: props._session_id, qty: item.quantity || 1, holdToken: props._hold_token });
      } else if (props._booking_type === "SERVICE") {
        lines.push({ type: "SERVICE", productNo: props._product_no, storeId: props._store_id, from: props._from, to: props._to, qty: item.quantity || 1, holdToken: props._hold_token });
      }
    }
    if (!lines.length) return;

    const isB2B = (order.customer?.tags ?? "").split(",").map((t: string) => t.trim().toUpperCase()).includes("B2B");
    const paid = order.financial_status === "paid"; // B2B pay-later arrives 'pending'
    const settings = getSettings();
    const termsAccepted = bookingLineProperties.every((props) => {
      const key = `terms${props._booking_type[0]}${props._booking_type.slice(1).toLowerCase()}Enabled`;
      return settings[key] !== "1" || String(props._terms_accepted).toLowerCase() === "true";
    });
    const booking = await createBooking({
      customer: {
        email: order.email || order.customer?.email || "unknown@web",
        firstName: order.customer?.first_name, lastName: order.customer?.last_name,
        phone: order.customer?.phone, b2b: isB2B,
      },
      storeId: lines.find((l) => l.storeId)?.storeId,
      channel: "WEB",
      lines,
      shopifyOrderId: String(order.id),
      shopifyOrderName: order.name,
      paid,
      holdToken: lines.find((l) => l.holdToken)?.holdToken,
      fieldResponses: Object.fromEntries(Object.entries(bookingProperties)
        .filter(([key]) => key.startsWith("_field_") || key.startsWith("_intake_"))
        .map(([key, value]) => [key.startsWith("_field_") ? key.slice(7) : key.slice(8), value])),
      termsAccepted,
      enforceTerms: false,
      addons,
    });
    void sendClassTicketEmail(booking.id).catch((err) => console.warn("[ticketEmail]", err));
  } catch (err) {
    db.prepare("INSERT INTO events (booking_id, type, detail, at) VALUES (NULL, 'shopify.order_failed', ?, ?)")
      .run(JSON.stringify({ orderId: order?.id, error: String(err) }), new Date().toISOString());
  }
});

// --- Shopify mandatory compliance webhooks (GDPR) -------------------------------
// Must 401 on invalid HMAC per Shopify requirements. One endpoint, topic header.

shopifyRouter.post("/compliance", raw({ type: "*/*" }), (req, res) => {
  const secret = getSettings().shopifyApiSecret;
  const hmac = String(req.headers["x-shopify-hmac-sha256"] ?? "");
  if (!verifyShopifyHmac(req.body as Buffer, hmac, secret)) {
    return res.status(401).json({ error: "invalid webhook HMAC" });
  }
  const topic = String(req.headers["x-shopify-topic"] ?? "");
  let payload: any = {};
  try {
    payload = JSON.parse((req.body as Buffer).toString("utf8"));
  } catch {
    /* empty body is fine for shop/redact */
  }
  const email = payload?.customer?.email ?? "";
  if (topic === "customers/redact") {
    redactCustomer(email);
  } else if (topic === "customers/data_request") {
    // Export is compiled and audited; staff retrieves it via /api/privacy/export
    // and delivers it to the merchant/customer.
    auditLog("privacy.data_request", email, `shopify order ids: ${JSON.stringify(payload?.orders_requested ?? [])}`, "shopify");
  } else if (topic === "shop/redact") {
    putSettings({ shopifyShop: "", shopifyApiSecret: "" });
    auditLog("privacy.shop_redact", String(payload?.shop_domain ?? ""), "", "shopify");
  }
  res.status(200).json({ ok: true });
});

// --- Shopify App Proxy (storefront widget → /apps/booking/*) ---------------------

/** App-proxy signature: HMAC-SHA256 (hex) of the sorted `k=v` params joined WITHOUT
 *  separators, excluding `signature` itself. */
function verifyProxySignature(query: Record<string, unknown>, secret: string): boolean {
  const { signature, ...rest } = query as Record<string, string>;
  if (!secret) return true; // dev mode: no secret configured
  if (!signature) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? (rest[k] as unknown as string[]).join(",") : rest[k]}`).join("");
  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
  } catch {
    return false;
  }
}

proxyRouter.use((req, res, next) => {
  if (!verifyProxySignature(req.query as Record<string, unknown>, getSettings().shopifyApiSecret)) {
    return res.status(401).json({ error: "invalid proxy signature" });
  }
  next();
});

type PortalLine = {
  qty?: unknown;
  product_name?: unknown;
  date_from?: unknown;
  date_to?: unknown;
};

type PortalBooking = {
  id?: unknown;
  ref?: unknown;
  status?: unknown;
  manage_token?: unknown;
  lines?: PortalLine[];
};

export function escapeLiquidData(v: unknown): string {
  let s = String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  s = s.replace(/\{\{/g, "&#123;&#123;").replace(/\}\}/g, "&#125;&#125;");
  s = s.replace(/{%/g, "&#123;%").replace(/%}/g, "%&#125;");
  return s;
}

function portalDate(v: unknown): string {
  const value = String(v ?? "");
  const dateOnly = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  if (!dateOnly) return value;
  const date = new Date(`${dateOnly}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function portalStatus(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderPortalCard(booking: PortalBooking, publicUrl: string): string {
  const status = String(booking.status ?? "");
  const statusClass = status === "CANCELLED" ? " is-cancelled" : status === "COMPLETED" ? " is-completed" : "";
  const lines = (booking.lines ?? []).map((line) => {
    const from = escapeLiquidData(portalDate(line.date_from));
    const to = escapeLiquidData(portalDate(line.date_to));
    return `<li>${escapeLiquidData(line.qty)}× ${escapeLiquidData(line.product_name)}, ${from} to ${to}</li>`;
  }).join("");
  const token = String(booking.manage_token ?? "").trim();
  const base = String(publicUrl ?? "").replace(/\/+$/, "");
  const manageLink = token
    ? `<a class="reservly-portal__manage" href="${escapeLiquidData(`${base}/manage/${token}`)}">Manage booking</a>`
    : "";

  return `<article class="reservly-portal__card">
    <div class="reservly-portal__card-head">
      <strong>${escapeLiquidData(booking.ref)}</strong>
      <span class="reservly-portal__badge${statusClass}">${escapeLiquidData(portalStatus(status))}</span>
    </div>
    <ul>${lines}</ul>
    ${manageLink}
  </article>`;
}

/** Pure renderer: callers must authenticate the Shopify customer and load only
 * that customer's records before passing them here. */
export function renderCustomerReservationsPortal(input: {
  customerEmail: string;
  activeBookings: PortalBooking[];
  pastBookings: PortalBooking[];
  publicUrl: string;
}): string {
  const active = input.activeBookings.length
    ? input.activeBookings.map((booking) => renderPortalCard(booking, input.publicUrl)).join("")
    : `<p>No active reservations found for ${escapeLiquidData(input.customerEmail)}</p>`;
  const past = input.pastBookings.length
    ? input.pastBookings.map((booking) => renderPortalCard(booking, input.publicUrl)).join("")
    : "<p>No past or cancelled reservations found.</p>";

  return `<section class="reservly-portal">
  <style>
    .reservly-portal{font:inherit;max-width:860px;margin:0 auto;padding:24px 16px;color:inherit}
    .reservly-portal h1{margin:0 0 20px}.reservly-portal__card{margin:0 0 14px;padding:18px;border:1px solid #d9d9d9;border-radius:8px}
    .reservly-portal__card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.reservly-portal__card ul{margin:12px 0;padding-left:22px}
    .reservly-portal__badge{padding:4px 9px;border-radius:999px;background:#e7f4ec;color:#176b3a;font-size:.8em}.reservly-portal__badge.is-cancelled{background:#f8e7e7;color:#8a2525}
    .reservly-portal__badge.is-completed{background:#eceff3;color:#4d5968}.reservly-portal__manage{display:inline-block;margin-top:4px}
    .reservly-portal details{margin-top:24px}.reservly-portal summary{cursor:pointer;font-weight:600;margin-bottom:14px}
  </style>
  <h1>My reservations</h1>
  <div class="reservly-portal__active">${active}</div>
  <details>
    <summary>Past &amp; cancelled</summary>
    ${past}
  </details>
</section>`;
}

function portalMessage(message: string, includeLoginLink = false): string {
  return `<section class="reservly-portal" style="font:inherit;max-width:860px;margin:0 auto;padding:24px 16px">
  <h1>My reservations</h1>
  <p>${message}</p>
  ${includeLoginLink ? '<p><a href="/account/login">Sign in to your shop account</a></p>' : ""}
</section>`;
}

proxyRouter.get("/portal", async (req, res) => {
  res.type("application/liquid");
  const customerId = String(req.query.logged_in_customer_id ?? "").trim();
  if (!customerId) {
    return res.status(200).send(portalMessage("Please sign in to your shop account to view your reservations.", true));
  }

  const email = await getShopifyCustomerEmail(customerId);
  if (!email) {
    return res.status(200).send(portalMessage("Your reservations are temporarily unavailable. Please try again later."));
  }

  const activeBookings = db.prepare(
    "SELECT * FROM bookings WHERE customer_email = ? COLLATE NOCASE AND status NOT IN ('CANCELLED') ORDER BY created_at DESC LIMIT 20",
  ).all(email) as PortalBooking[];
  const pastBookings = db.prepare(
    "SELECT * FROM bookings WHERE customer_email = ? COLLATE NOCASE AND status IN ('CANCELLED', 'COMPLETED') ORDER BY created_at DESC LIMIT 10",
  ).all(email) as PortalBooking[];
  const linesForBooking = db.prepare("SELECT * FROM booking_lines WHERE booking_id = ? ORDER BY date_from ASC");
  for (const booking of [...activeBookings, ...pastBookings]) {
    booking.lines = linesForBooking.all(String(booking.id ?? "")) as PortalLine[];
  }

  return res.status(200).send(renderCustomerReservationsPortal({
    customerEmail: email,
    activeBookings,
    pastBookings,
    publicUrl: String(getSettings().publicUrl || ""),
  }));
});

proxyRouter.get("/availability", async (req, res) => {
  const { productNo, storeId, from, to } = req.query as Record<string, string>;
  if (!productNo || !storeId || !from || !to) return res.status(400).json({ error: "productNo, storeId, from, to required" });
  res.json(await rentalAvailability(productNo, storeId, from, to));
});

proxyRouter.get("/sessions", (req, res) => {
  const { productNo, from, days } = req.query as Record<string, string>;
  if (!productNo) return res.status(400).json({ error: "productNo required" });
  res.json({ slots: courseSlots(productNo, from || new Date().toISOString(), Number(days) || 90).filter((s) => s.remaining > 0) });
});

proxyRouter.get("/service-slots", (req, res) => {
  try {
    const { productNo, storeId, date } = req.query as Record<string, string>;
    if (!productNo || !storeId || !date) return res.status(400).json({ error: "productNo, storeId, date required" });
    res.json(serviceSlots(productNo, storeId, date));
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

proxyRouter.get("/product-fields", (req, res) => {
  const productNo = String(req.query.productNo || "").trim();
  const requestedLocale = String(req.query.locale || "").trim().toLowerCase();
  const locale = requestedLocale === "en" ? "" : requestedLocale;
  if (!productNo) return res.status(400).json({ error: "productNo required" });
  const product = db.prepare("SELECT id,min_qty,max_qty FROM products WHERE product_no=?").get(productNo) as
    { id: string; min_qty: number; max_qty: number } | undefined;
  if (!product) return res.status(404).json({ error: "Product not found" });
  const customFields = (db.prepare(`SELECT id,label,type,options,required FROM booking_fields
    WHERE product_id=? ORDER BY sort,id`).all(product.id) as any[]).map((field) => {
    const optionValues = pj<string[]>(field.options, []);
    const translation = locale
      ? db.prepare(`SELECT label,options FROM booking_field_translations
          WHERE field_id=? AND locale=?`).get(field.id, locale) as any
      : undefined;
    const translatedOptions = translation ? pj<string[]>(translation.options, []) : [];
    return {
      id: field.id,
      name: translation?.label || field.label,
      type: field.type,
      required: !!field.required,
      placeholder: "",
      options: translation
        ? optionValues.map((option, index) => translatedOptions[index] || option)
        : optionValues,
      optionValues,
      validation: {},
    };
  });
  const settings = getSettings();
  res.json({
    productNo,
    customFields,
    quantity: {
      min: Math.max(1, Number(product.min_qty) || 1),
      max: Math.max(1, Number(product.max_qty) || 1),
    },
    termsEnabled: {
      RENTAL: settings.termsRentalEnabled === "1",
      COURSE: settings.termsCourseEnabled === "1",
      SERVICE: settings.termsServiceEnabled === "1",
    },
  });
});

proxyRouter.post("/bookings", async (req, res) => {
  try {
    const booking = await createBooking({
      customer: req.body?.customer,
      storeId: req.body?.storeId,
      channel: "WEB",
      notes: req.body?.notes,
      lines: req.body?.lines ?? [],
      fieldResponses: req.body?.fieldResponses,
      termsAccepted: req.body?.termsAccepted,
      holdToken: req.body?.holdToken,
      addons: req.body?.addons,
    });
    res.json({ booking });
  } catch (err) {
    res.status(400).json(err instanceof BookingValidationError ? err.payload : { error: String((err as Error).message ?? err) });
  }
});

proxyRouter.get("/quote", (req, res) => {
  try {
    const { type = "RENTAL", productNo, storeId, from, to, sessionId, qty } = req.query as Record<string, string>;
    if (!["RENTAL", "COURSE", "SERVICE"].includes(type)) return res.status(400).json({ error: "Invalid booking type" });
    const q = quoteLines([{
      type: type as "RENTAL" | "COURSE" | "SERVICE",
      productNo, storeId, from, to, sessionId, qty: Number(qty) || 1,
    }]);
    res.json({ ...q, currency: getSettings().currency || "CAD" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

proxyRouter.get("/stores", (_req, res) => {
  res.json({ stores: db.prepare("SELECT id, code, name, city FROM stores ORDER BY name").all() });
});

proxyRouter.get("/search", async (req, res) => {
  const { from, to, storeId, type } = req.query as Record<string, string>;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  const products = db.prepare(`SELECT p.*,q.store_id,q.qty FROM products p
    LEFT JOIN product_store_qty q ON q.product_id=p.id
    WHERE p.available_on_web=1 ${type ? "AND p.type=?" : ""} ${storeId ? "AND q.store_id=?" : ""}
    ORDER BY p.name`).all(...[type || null, storeId || null].filter(Boolean)) as any[];
  const results = [];
  for (const p of products) {
    if (p.type === "RENTAL") {
      if (!p.store_id) continue;
      const availability = await rentalAvailability(p.product_no, p.store_id, from, to);
      if (availability.available) results.push({ productNo: p.product_no, name: p.name, type: p.type, storeId: p.store_id, available: Math.min(...availability.perDay.map((d) => d.qty)), imageUrl: p.image_url });
    } else {
      const slots = courseSlots(p.product_no, from, Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000)));
      if (slots.length) results.push({ productNo: p.product_no, name: p.name, type: p.type, slots, imageUrl: p.image_url });
    }
  }
  res.json({ from, to, results });
});

proxyRouter.get("/addons", (req, res) => {
  const productNo = String(req.query.productNo || "");
  const addons = db.prepare(`SELECT a.addon_product_no AS productNo,a.name,a.price,a.max_qty AS maxQty,a.required,
    a.shopify_variant_id AS shopifyVariantId
    FROM product_addons a JOIN products p ON p.id=a.product_id WHERE p.product_no=? AND a.active=1 ORDER BY a.name`).all(productNo);
  res.json({ addons });
});

proxyRouter.get("/cross-sell", (req, res) => {
  const productNo = String(req.query.productNo || "").trim();
  if (!productNo) return res.status(400).json({ error: "productNo required" });
  const suggestions = db.prepare(`SELECT cross_sell.kind,
    suggested.product_no AS productNo,suggested.name,suggested.type,
    suggested.default_unit_price AS defaultUnitPrice,
    cross_sell.shopify_product_id AS shopifyProductId,
    cross_sell.shopify_variant_id AS variantId,cross_sell.title,cross_sell.price,
    cross_sell.image_url AS imageUrl,cross_sell.handle
    FROM products source
    JOIN product_cross_sell cross_sell ON cross_sell.product_id=source.id
    LEFT JOIN products suggested ON cross_sell.kind='RESERVLY'
      AND suggested.product_no=cross_sell.suggested_product_no
    WHERE source.product_no=?
    ORDER BY COALESCE(suggested.name,cross_sell.title)`).all(productNo);
  res.json({ suggestions });
});

proxyRouter.post("/waitlist", (req, res) => {
  const { productNo, sessionId = null, storeId = null, from = "", to = "", name = "", email, phone = "", qty = 1 } = req.body ?? {};
  if (!productNo || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ""))) {
    return res.status(400).json({ error: "productNo and a valid email are required" });
  }
  const existing = db.prepare(`SELECT id FROM waitlist WHERE product_no=? AND COALESCE(session_id,'')=COALESCE(?,'')
    AND customer_email=? AND status IN ('WAITING','NOTIFIED')`).get(productNo, sessionId, String(email).toLowerCase()) as any;
  if (existing) return res.json({ id: existing.id, alreadyJoined: true });
  const id = uid();
  db.prepare(`INSERT INTO waitlist(id,product_no,session_id,store_id,date_from,date_to,customer_name,customer_email,
    customer_phone,qty,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'WAITING',?)`)
    .run(id, productNo, sessionId, storeId, from, to, String(name), String(email).toLowerCase(), String(phone), Math.max(1, Number(qty) || 1), now());
  auditLog("waitlist.joined", String(email), `${productNo}:${sessionId || `${from}-${to}`}`, "customer");
  res.json({ id });
});

proxyRouter.post("/holds", async (req, res) => {
  try {
    const { type: requestedType, productNo, sessionId, storeId, from, to, qty = 1 } = req.body ?? {};
    const type = requestedType || (sessionId ? "COURSE" : "RENTAL");
    if (!productNo || !from || !to) return res.status(400).json({ error: "productNo, from and to are required" });
    const n = Math.max(1, Number(qty) || 1);
    if (sessionId) {
      const session = db.prepare(`SELECT s.capacity FROM sessions s JOIN products p ON p.id=s.product_id
        WHERE s.id=? AND p.product_no=?`).get(sessionId, productNo) as any;
      if (!session) return res.status(404).json({ error: "Session not found" });
      const booked = db.prepare(`SELECT COALESCE(SUM(l.qty),0) n FROM booking_lines l JOIN bookings b ON b.id=l.booking_id
        WHERE l.session_id=? AND b.status IN ('RESERVED','POS_PENDING','PAID','PICKED_UP')`).get(sessionId) as any;
      const held = db.prepare("SELECT COALESCE(SUM(qty),0) n FROM booking_holds WHERE session_id=? AND expires_at>?").get(sessionId, now()) as any;
      if (booked.n + held.n + n > session.capacity) return res.status(409).json({ error: "This session no longer has enough seats" });
    } else if (type === "SERVICE") {
      const time = String(from).slice(11, 16);
      if (!storeId || !serviceSlots(productNo, storeId, String(from).slice(0, 10)).slots.includes(time)) {
        return res.status(409).json({ error: "This service slot is no longer available" });
      }
      const capacity = db.prepare(`SELECT COALESCE(q.qty,1) AS qty FROM products p
        LEFT JOIN product_store_qty q ON q.product_id=p.id AND q.store_id=?
        WHERE p.product_no=? AND p.type='SERVICE'`).get(storeId, productNo) as { qty: number } | undefined;
      const held = db.prepare(`SELECT COALESCE(SUM(qty),0) AS n FROM booking_holds
        WHERE product_no=? AND store_id=? AND date_from=? AND expires_at>?`).get(productNo, storeId, from, now()) as { n: number };
      if (held.n + n > Math.max(0, Number(capacity?.qty ?? 1))) {
        return res.status(409).json({ error: "This service slot is no longer available" });
      }
    } else {
      const availability = await rentalAvailability(productNo, storeId, from, to);
      if (!availability.perDay.every((d) => d.qty >= n)) return res.status(409).json({ error: "This rental is no longer available" });
    }
    db.prepare("DELETE FROM booking_holds WHERE expires_at<=?").run(now());
    const token = crypto.randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + Math.max(1, Number(getSettings().slotHoldMinutes) || 10) * 60_000).toISOString();
    db.prepare(`INSERT INTO booking_holds(token,product_no,session_id,store_id,date_from,date_to,qty,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(token, productNo, sessionId || null, storeId || null, from, to, n, expiresAt, now());
    res.json({ token, expiresAt });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message || err) });
  }
});
