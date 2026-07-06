# Gosselin Bookings — rentals & course bookings

A booking platform that replaces Sesami in the Gosselin stack: customers rent
equipment and book classes **directly in Shopify** (same cart as retail products,
one checkout), staff run the in-store flow from a dedicated back office
(**Booking Desk**) that pushes transactions to **LS Retail POS** as suspended
transactions, and everything is registered in **NAV via LS Activity** web services.

```
                        ┌─────────────────────────────┐
   Shopify storefront   │  Booking app (this)         │        NAV / LS Central
  ┌──────────────────┐  │  ┌───────────┐ ┌──────────┐ │  ┌───────────────────────┐
  │ theme extension  │──┼─▶│ App Proxy │ │ Booking  │ │  │ WSLSActivity          │
  │ (booking widget) │  │  │ /proxy/*  │ │ engine   │─┼─▶│  GetActivityProducts  │
  └────────┬─────────┘  │  └───────────┘ │ pricing  │ │  │  Getavailabilityx     │
           │ checkout   │  ┌───────────┐ │ availab. │ │  │  ConfirmReservation   │
           ▼            │  │ webhooks/ │ │ lifecycle│ │  │  CancelReservation    │
  orders/create ────────┼─▶│ shopify   │ └────┬─────┘ │  ├───────────────────────┤
                        │  └───────────┘      │       │  │ WSWebPOS              │
  Booking Desk (React)──┼─▶ /api/* ───────────┤       │  │  WebPosPost (suspended│
  staff store view      │                     └───────┼─▶│  txn → LS Retail POS) │
                        │  events ─▶ Conduit ─▶ HubSpot  └───────────────────────┘
                        └─────────────────────────────┘   (transactional emails)
```

## Apps & pieces

| Piece | Where | What |
|---|---|---|
| API server | `server/` (Express + SQLite, port **4646**) | booking engine, NAV SOAP client, Shopify webhook + app proxy, printable paperwork |
| Booking Desk | `web/` (React + Vite, dev port **5646**) | staff back office: dashboard, bookings lifecycle, store view (POS flow), products/kits, sessions/resources, settings |
| Shopify app | `shopify.app.toml` + `extensions/booking-widget/` | theme app block: rental date-range / course session picker on product pages → line item properties |
| NAV connector | `server/lib/nav.ts` | same SOAP envelopes as `packages/connectors` (the Gosselin middleware) — LS Activity + WebPOS |
| Conduit | external (`CONDUIT_URL`) | receives all booking lifecycle events and owns cross-system flows (HubSpot emails, catalog sync recipes, monitoring) |

## Quick start

```bash
cd apps/booking
pnpm install          # standalone install (root lockfile is currently broken — see pnpm-workspace.yaml)
npm run dev           # server :4646 + admin UI :5646, seeded demo catalog, NAV in mock mode
```

`navMode=mock` (default without credentials) answers NAV calls locally so the whole
flow — quote → booking → POS push → pickup → return — runs end to end on a laptop.
Point it at real NAV in **Settings** (base URL + NTLM credentials) or via env
(`NAV_BASE_URL`, `NAV_USERNAME`, `NAV_PASSWORD`, `NAV_DOMAIN`).

Other env: `PORT`, `BOOKING_DB`, `BOOKING_ENC_KEY` (64-hex AES key for ID capture),
`SHOPIFY_API_SECRET` (webhook + proxy signatures), `SHOPIFY_SHOP`, `CONDUIT_URL`.

## One transaction for products + bookings

1. Catalog sync pulls LS Activity products from NAV (`POST /api/products/sync`) and
   maps them to Shopify products (`shopifyProductId`, metafields `booking.type`,
   `booking.product_no`).
2. On the product page the **booking widget** (theme app extension) checks live
   availability/pricing through the App Proxy and writes `_booking_*` line item
   properties. Retail items sit in the same cart; Shopify takes one payment.
3. `orders/create` webhook → booking created + `ActivityConfirmReservation` per line.
   NAV holds the reservation as unpaid/draft until POS posting or reconciliation.
4. **B2B customers** (tagged `B2B` in Shopify) check out on Shopify's native
   pay-later terms; the order arrives `pending` and the booking stays `RESERVED`.

## In-store flow (LS Retail POS)

Staff use **Bookings → New** (the "store view"): build a multi-line basket (rentals
+ classes), create the booking, then **Push to POS** — a WebPOS *suspended
transaction* (EntryStatus 2) containing, per line, an Item line (NAV selling item at
the reserved amount as manual price) and a FreeText line whose **barcode is the NAV
BookingRef** — posting that line on the POS flips the reservation to paid in NAV.
Coupons applied at the POS are pulled back with **Reconcile** (`posTotal`), keeping
the app's financials in sync (requirement R3B).

## Requirements traceability

### Rentals (R0–R19)

| Req | Coverage |
|---|---|
| R0 equipment + fees + availability in Shopify | catalog sync (NAV → app → Shopify), per-store stock (`product_store_qty`), **kit items** per product (`kit` editor) |
| R1A/R2A hierarchy + store selection | widget: store dropdown limited to stores with stock; Shopify collections handle hierarchy |
| R3A day-based pricing | `engine/pricing.ts`: `days = max(1, ceil(hours/24))` → 25 h = 2 days; WEEKLY tier from NAV `ActivityProductPrice` |
| R1B–R3B staff store view + suspended POS txn | Booking Desk store view + `push-pos` (WebPOS EntryStatus 2) |
| R3B POS coupon reconciliation | `POST /bookings/:id/reconcile` stores `posTotal`, emits `booking.reconciled` |
| NAV pay-on-pickup; B2B pay later | booking `RESERVED` until POS/pickup; B2B orders stay unpaid via Shopify terms |
| R4–R5 booking recorded + NAV transaction | `createBooking` → `ActivityConfirmReservation` (stores `activityNo`, `bookingRef`) |
| R6–R7 HubSpot confirmation email | `booking.created` event forwarded to Conduit → HubSpot (emails stay in HubSpot) |
| R8 morning packing lists/contracts | `/print/daily?date=&storeId=` — batch packing list + contract per pickup, kit checklists |
| R9–R11 pickup & inspection | `pickup` action: inspection notes on lines, damages grid on contract |
| R12–R13 deposit + contract | deposit captured at pickup (`SecurityDeposit` from NAV), printable contract w/ signature blocks; POS deposit line rides the same suspended-transaction rails |
| R14 encrypted government ID | AES-256-GCM at rest, only last-4 ever displayed |
| R15–R17 return & inspect | `return` action: inspection + per-item damage charges |
| R18 deposit refund minus charges | `refundDue = deposit − damage charges`, shown on booking + in events |
| R19 return confirmation email | `booking.returned` event → Conduit → HubSpot |
| multi-rental basket | bookings are multi-line (rentals + courses mixed in one transaction) |

### Class bookings (steps 2–17)

| Step | Coverage |
|---|---|
| 2 course SKU from NAV | catalog sync (`type=COURSE`), specific start/end per session (no 3-h interval needed) |
| 3A/3B trainers & rooms | resources (ROOM/TRAINER) with CSV availability import; sessions take a room + **multiple trainers** |
| 4–5 class published, series support | sessions with `occurrences` create a series (e.g. 3 Tuesday evenings) — one purchase blocks all instances' resources |
| 6–10 customer selects & pays in Shopify | widget session picker (seats left) → one-cart checkout → webhook → NAV reservation |
| 11/17 confirmation emails via HubSpot | events → Conduit → HubSpot |
| 12–15 in-store: suspended txn + reconciliation | same `push-pos` + `reconcile` path as rentals |
| 16 printable confirmation | `/print/confirmation/:id` |

## Open questions carried from the requirements

- **Deposit on POS**: currently the deposit is recorded in the app at pickup and the
  refund computed at return (R18); if Gosselin wants the deposit itself tendered
  through the POS, add a second FreeText/deposit line to the suspended transaction.
- **Electronic contracts**: contract is print-ready HTML with signature blocks;
  e-signature would be an add-on (the `contractSignedAt` field is already there).
- **Course availability by trainer subset**: sessions are explicit instances (staff
  create them against room + trainers), so "either trainer" scenarios are handled by
  creating the session with whichever trainer is actually available.
