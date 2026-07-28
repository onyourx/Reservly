import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedIfEmpty } from "./seed.js";
import { requireAuth } from "./lib/auth.js";
import { startRetentionSchedule } from "./lib/privacy.js";
import { seedPlatform, tenantMiddleware } from "./lib/platform.js";
import { adminRouter } from "./routes/admin.js";
import { catalogRouter } from "./routes/catalog.js";
import { bookingRouter } from "./routes/booking.js";
import { settingsRouter, shopifyRouter, proxyRouter } from "./routes/integration.js";
import { printRouter } from "./routes/print.js";
import { signRouter } from "./routes/sign.js";
import { manageRouter } from "./routes/manage.js";
import { discoverRouter } from "./routes/discover.js";
import { usersRouter } from "./routes/users.js";
import { startNotificationSchedule } from "./lib/notifications.js";
import { consumePrintToken } from "./lib/printing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, "..", ".env")); } catch { /* no .env — mailer stays unconfigured */ }
const PORT = Number(process.env.PORT || 4646);
const HOST = process.env.HOST || "0.0.0.0";

seedPlatform();
seedIfEmpty();

const app = express();

// Shopify webhooks need the raw body for HMAC — mounted before express.json().
// (They serve the default tenant; per-tenant shops would pass ?t=<slug> in the
// webhook uri, which tenantMiddleware honors on all other routes.)
app.use("/webhooks/shopify", shopifyRouter);

app.use(express.json({ limit: "2mb" }));

// Tenant selection for everything below (super-admin override > ?t= > default).
app.use(tenantMiddleware);
app.use("/api/admin", adminRouter);

// Staff auth gate: everything under /api and /print except health/login/status.
// Shopify surfaces (/webhooks, /proxy) authenticate by signature instead.
const OPEN_API = new Set(["/health", "/auth", "/login", "/logout"]);
app.use("/api", (req, res, next) => (OPEN_API.has(req.path) ? next() : requireAuth(req, res, next)));
app.use("/print", (req, res, next) => {
  const token = req.query.ptoken;
  if (typeof token === "string" && ["::1", "127.0.0.1", "::ffff:127.0.0.1"].includes(req.ip ?? "") && consumePrintToken(token)) return next();
  return requireAuth(req, res, next);
});

app.use("/api", settingsRouter);
app.use("/api", catalogRouter);
app.use("/api", usersRouter);
app.use("/api", bookingRouter);
app.use("/proxy", proxyRouter); // Shopify App Proxy target (storefront widget)
app.use("/print", printRouter);
app.use("/sign", signRouter);   // public: customer e-signature (token-authenticated)
app.use("/manage", manageRouter); // public: customer cancel/reschedule (token-authenticated)
app.use("/discover", discoverRouter); // public: cross-product availability search

startRetentionSchedule();
startNotificationSchedule();

// Production: serve the built SPAs — staff mobile app at /m, admin everywhere else.
const dist = path.join(__dirname, "..", "web", "dist");
const mobileDist = path.join(__dirname, "..", "mobile", "dist");
app.use("/m", express.static(mobileDist));
app.get(/^\/m(\/.*)?$/, (_req, res) => {
  res.sendFile(path.join(mobileDist, "index.html"), (err) => {
    if (err) res.status(200).send("Staff mobile app not built yet — run: npx vite build mobile (dev: http://localhost:5647).");
  });
});
app.use(express.static(dist));
app.get(/^\/(?!api|proxy|print|sign|manage|discover|webhooks|m\b).*/, (_req, res) => {
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) res.status(200).send("Booking Desk API is running. In dev, the admin UI is on http://localhost:5646.");
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[booking] Gosselin Booking Desk API listening on http://${HOST}:${PORT}`);
});
