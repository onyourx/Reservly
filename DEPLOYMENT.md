# Deploying Reservly to production

Reservly is a single Node service (Express + better-sqlite3) that serves the
admin SPA, staff PWA, Shopify surfaces, and e-signature pages. It has no external
database — state lives in SQLite files on disk (one per tenant, plus `platform.db`).

## 1. Host

Any always-on Node 20+ host works (VM, container, Fly, Render, a Mac mini in the
store). Requirements:

- A **persistent, encrypted disk** for the `.db` files (see `BOOKING_DATA_DIR`).
  SQLite needs a real filesystem — not an ephemeral container FS.
- A **public HTTPS** front (reverse proxy / platform TLS). Shopify webhooks, the
  app proxy, and customer e-signature links all require HTTPS.

Build and run:

```bash
npm install
npm run build          # builds admin + mobile SPAs, typechecks the server
npm start              # NODE_ENV=production, serves everything on $PORT (default 4646)
```

Point your reverse proxy at `$PORT`. The server binds all interfaces.

## 2. Environment

Secrets can also be set in-app (Settings → written to the tenant DB); env vars
are the boot defaults and are handy for the first run / infra-as-code.

| Var | Purpose |
|---|---|
| `PORT` | Listen port (default 4646) |
| `BOOKING_DATA_DIR` | Directory holding `platform.db` and per-tenant `booking-*.db` (default: app dir) |
| `BOOKING_DB` | Path to the **default** tenant DB (default `booking.db`) |
| `BOOKING_ENC_KEY` | **64 hex chars** — AES-256 key for government-ID encryption. Set this in prod; without it a weak dev key is used. Rotating it makes existing encrypted IDs unreadable. |
| `BOOKING_TZ` | Store timezone for "today" (default `America/Toronto`) |
| `PUBLIC_URL` | Base URL for customer-facing links (e-signature), e.g. `https://bookings.gosselin.ca` |
| `NAV_BASE_URL` / `NAV_USERNAME` / `NAV_PASSWORD` / `NAV_DOMAIN` | LS Central NTLM connection. Set `NAV_BASE_URL` to switch NAV out of mock mode. |
| `SHOPIFY_SHOP` | `your-store.myshopify.com` |
| `SHOPIFY_API_SECRET` | App client secret — verifies webhook HMAC + app-proxy signatures |
| `SHOPIFY_CLIENT_ID` | App client id (else read from `shopify.app.toml`) |
| `CONDUIT_URL` | Conduit base URL for event fan-out → HubSpot emails |

## 3. Shopify wiring (per production host)

`shopify.app.toml` uses placeholder URLs. For production, set the real host and
deploy once:

1. In `shopify.app.toml`, replace `bookings.example.com` in `application_url`,
   the webhook `uri`s, and `app_proxy.url` with your host.
2. `shopify app deploy` — pushes the theme extension, webhook subscriptions, and
   the app-proxy URL to Shopify.
3. Paste the **Client secret** into Settings → Shopify (or `SHOPIFY_API_SECRET`).

> **Dev gotcha:** `shopify app dev` updates the app URL on each run but **not**
> the app-proxy URL (Shopify CLI #990), and its tunnel URL changes every restart.
> That's why the storefront widget shows "Stores unavailable" in dev until you
> run `scripts/set-proxy-url.sh <tunnel-url>`. In production the URL is stable, so
> this is a one-time `shopify app deploy`.

Products become bookable when published from Booking Desk (sets price, image, and
the `booking.type` / `booking.product_no` metafields) and the Booking widget block
is added to the product template once.

## 4. Tenants

- The existing store is the `gosselin` tenant. Add more from Booking Desk →
  **Tenants** (super admin) — each gets an isolated `booking-<slug>.db`.
- Super-admin first-run password is printed to the server log on first boot;
  reset any time with `node scripts/set-platform-password.mjs '<password>'`.

## 5. Backups & privacy (operational — see PRIVACY.md)

- Back up `BOOKING_DATA_DIR` (all `.db` files) to **encrypted** storage on a
  schedule. SQLite WAL is on; copy `.db`, `.db-wal`, `.db-shm` together or use
  `sqlite3 <file> ".backup"`.
- Run on an encrypted volume (FileVault / LUKS / encrypted EBS).
- Retention sweeps (ID purge, booking anonymization) run daily in-process;
  periods are configurable per tenant in Settings.
- Rotate `SHOPIFY_API_SECRET` and `BOOKING_ENC_KEY` per your incident policy.

## 6. Health

`GET /api/health` → `{ ok, navMode, shopifyConfigured, authRequired }`. Point your
uptime monitor here.
