import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedIfEmpty } from "./seed.js";
import { requireAuth } from "./lib/auth.js";
import { startRetentionSchedule } from "./lib/privacy.js";
import { catalogRouter } from "./routes/catalog.js";
import { bookingRouter } from "./routes/booking.js";
import { settingsRouter, shopifyRouter, proxyRouter } from "./routes/integration.js";
import { printRouter } from "./routes/print.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4646);

seedIfEmpty();

const app = express();

// Shopify webhooks need the raw body for HMAC — mounted before express.json().
app.use("/webhooks/shopify", shopifyRouter);

app.use(express.json({ limit: "2mb" }));

// Staff auth gate: everything under /api and /print except health/login/status.
// Shopify surfaces (/webhooks, /proxy) authenticate by signature instead.
const OPEN_API = new Set(["/health", "/auth", "/login", "/logout"]);
app.use("/api", (req, res, next) => (OPEN_API.has(req.path) ? next() : requireAuth(req, res, next)));
app.use("/print", requireAuth);

app.use("/api", settingsRouter);
app.use("/api", catalogRouter);
app.use("/api", bookingRouter);
app.use("/proxy", proxyRouter); // Shopify App Proxy target (storefront widget)
app.use("/print", printRouter);

startRetentionSchedule();

// Production: serve the built admin SPA.
const dist = path.join(__dirname, "..", "web", "dist");
app.use(express.static(dist));
app.get(/^\/(?!api|proxy|print|webhooks).*/, (_req, res) => {
  res.sendFile(path.join(dist, "index.html"), (err) => {
    if (err) res.status(200).send("Booking Desk API is running. In dev, the admin UI is on http://localhost:5646.");
  });
});

app.listen(PORT, () => {
  console.log(`[booking] Gosselin Booking Desk API on http://localhost:${PORT}`);
});
