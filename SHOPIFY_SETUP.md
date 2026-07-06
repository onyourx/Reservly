# Creating the "Reservly" Shopify app

One-time setup. Prereqs: a [Shopify Partner account](https://partners.shopify.com)
and a development store (Partner dashboard → Stores → Add store → development store).
Shopify CLI is already installed (`shopify version` → 4.x).

## 1. Create & link the app (interactive — run in your terminal)

```bash
cd apps/booking
shopify auth login            # opens the browser, sign into your Partner account
shopify app config link       # "Create this project as a new app" → yes, name: reservly
```

`config link` fills `client_id` in `shopify.app.toml`. Then grab the **Client secret**
(Partner dashboard → Apps → reservly → Overview → Client credentials) and
paste it into **Booking Desk → Settings → Shopify API secret** (it verifies webhook
HMACs and app-proxy signatures). Set **Shopify shop** to your dev store domain there too.

## 2. Develop against the dev store

```bash
shopify app dev --store <your-dev-store>.myshopify.com
```

This starts the booking backend (via `shopify.web.toml`), tunnels a public URL to it,
installs the app on the dev store, and serves the **booking widget** theme extension
with hot reload. Approve the install in the browser when prompted.

## 3. Deploy the extension + app config

```bash
shopify app deploy            # pushes the theme extension, webhooks and app proxy config
```

For production, first replace `bookings.example.com` in `shopify.app.toml`
(`application_url`, webhook `uri`, `app_proxy.url`) with the real host where the
booking server runs, then deploy again.

## 4. Wire up a bookable product (per product)

1. In Shopify admin, create the product (e.g. "Nikon D850 — Rental"), price = daily rate.
2. Add two **metafields** on it (Settings → Custom data → Products):
   - `booking.type` = `RENTAL` or `COURSE`
   - `booking.product_no` = the NAV LS Activity ProductNo (e.g. `RNT-D850`)
3. In the theme editor (Online store → Themes → Customize → product template),
   add the **Booking widget** app block to the product page.
4. In Booking Desk → Products → the product → set **Shopify product ID** so the
   catalog sync keeps them linked.

The widget then shows store + date pickers (rentals) or session slots (courses),
checks live availability through the app proxy, and adds `_booking_*` line item
properties. Checkout stays 100% native Shopify — retail items and bookings in one
payment — and the `orders/create` webhook creates the booking + NAV reservation.

## 5. Sanity checks

- `https://<tunnel-or-host>/api/health` → `{ ok: true, ... }`
- Product page shows the widget; picking dates shows price + availability.
- Place a test order → the booking appears in Booking Desk (channel WEB,
  Shopify order linked), with NAV refs on each line.
- B2B: tag a customer `B2B`, order arrives unpaid → booking stays RESERVED.
