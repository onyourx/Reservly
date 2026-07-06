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
import { db, getSettings, putSettings, pj, auditLog } from "../db.js";
import { navMode } from "../lib/nav.js";
import { ensureMetafieldDefinitions } from "../lib/shopifyAdmin.js";
import { authRequired, isAuthenticated, login, logout, setAdminPassword } from "../lib/auth.js";
import { collectCustomerData, redactCustomer, sweepRetention } from "../lib/privacy.js";
import { createBooking } from "../lib/bookingService.js";
import { quoteLines } from "../engine/pricing.js";
import { rentalAvailability, courseSlots } from "../engine/availability.js";

export const settingsRouter = Router();
export const shopifyRouter = Router(); // mounted at /webhooks/shopify with raw body
export const proxyRouter = Router();   // mounted at /proxy (Shopify App Proxy)

// --- Settings / health / events ---------------------------------------------

const SAFE_KEYS = ["navMode", "navBaseUrl", "navUsername", "navDomain", "shopifyShop", "shopifyClientId", "conduitUrl", "posStoreId", "posTerminalId", "posStaffId", "idRetentionDays", "dataRetentionDays"];

settingsRouter.get("/health", (_req, res) => {
  res.json({
    ok: true,
    navMode: navMode(),
    shopifyConfigured: Boolean(getSettings().shopifyApiSecret),
    authRequired: authRequired(),
  });
});

// --- Staff auth (open endpoints; everything else behind requireAuth) ----------

settingsRouter.get("/auth", (req, res) => {
  res.json({ required: authRequired(), authenticated: isAuthenticated(req) });
});
settingsRouter.post("/login", login);
settingsRouter.post("/logout", logout);

settingsRouter.get("/settings", (_req, res) => {
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SAFE_KEYS.map((k) => [k, s[k] ?? ""])) });
});

settingsRouter.put("/settings", (req, res) => {
  const { adminPassword, ...rest } = req.body ?? {};
  try {
    if (adminPassword) setAdminPassword(String(adminPassword));
  } catch (err) {
    return res.status(400).json({ error: String((err as Error).message ?? err) });
  }
  putSettings(rest);
  const s = getSettings();
  res.json({ settings: Object.fromEntries(SAFE_KEYS.map((k) => [k, s[k] ?? ""])) });
});

// --- Privacy tooling (staff-facing, audited) -----------------------------------

settingsRouter.get("/privacy/export", (req, res) => {
  const email = String(req.query.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  res.json(collectCustomerData(email));
});

settingsRouter.post("/privacy/redact", (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  res.json({ redactedBookings: redactCustomer(email) });
});

settingsRouter.post("/privacy/sweep", (_req, res) => {
  res.json(sweepRetention());
});

settingsRouter.get("/audit", (req, res) => {
  const rows = db.prepare("SELECT at, actor, action, subject, detail FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(Number(req.query.limit) || 100);
  res.json({ audit: rows });
});

/** One-click Shopify store setup: metafield definitions the widget reads. */
settingsRouter.post("/shopify/setup", async (_req, res) => {
  try {
    res.json({ results: await ensureMetafieldDefinitions() });
  } catch (err) {
    res.status(502).json({ error: String((err as Error).message ?? err) });
  }
});

settingsRouter.get("/events", (req, res) => {
  const { bookingId, limit } = req.query as Record<string, string>;
  const rows = bookingId
    ? db.prepare("SELECT * FROM events WHERE booking_id = ? ORDER BY id DESC LIMIT ?").all(bookingId, Number(limit) || 100)
    : db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(Number(limit) || 100);
  res.json({ events: (rows as any[]).map((e) => ({ at: e.at, type: e.type, bookingId: e.booking_id, detail: pj(e.detail, {}) })) });
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
    const existing = db.prepare("SELECT id FROM bookings WHERE shopify_order_id = ?").get(String(order.id)) as any;
    if (existing) return;

    const lines: any[] = [];
    for (const item of order.line_items ?? []) {
      const props: Record<string, string> = Object.fromEntries((item.properties ?? []).map((p: any) => [p.name, String(p.value)]));
      if (!props._booking_type) continue; // plain retail item in the same cart — NAV order flow handles it
      if (props._booking_type === "RENTAL") {
        lines.push({ type: "RENTAL", productNo: props._product_no, storeId: props._store_id, from: props._from, to: props._to, qty: item.quantity || 1 });
      } else if (props._booking_type === "COURSE") {
        lines.push({ type: "COURSE", sessionId: props._session_id, qty: item.quantity || 1 });
      }
    }
    if (!lines.length) return;

    const isB2B = (order.customer?.tags ?? "").split(",").map((t: string) => t.trim().toUpperCase()).includes("B2B");
    const paid = order.financial_status === "paid"; // B2B pay-later arrives 'pending'
    await createBooking({
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
    });
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

proxyRouter.get("/quote", (req, res) => {
  try {
    const { productNo, storeId, from, to, qty } = req.query as Record<string, string>;
    const q = quoteLines([{ type: "RENTAL", productNo, storeId, from, to, qty: Number(qty) || 1 }]);
    res.json({ ...q, currency: "CAD" });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

proxyRouter.get("/stores", (_req, res) => {
  res.json({ stores: db.prepare("SELECT id, code, name, city FROM stores ORDER BY name").all() });
});
