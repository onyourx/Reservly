# Reservly — Architecture

**Audience:** engineers and integrators working on or around Reservly.
Companion to [REQUIREMENTS.md](./REQUIREMENTS.md). Operational detail lives in
[../DEPLOYMENT.md](../DEPLOYMENT.md), [../RUNNING.md](../RUNNING.md),
[../API.md](../API.md), and [../PRIVACY.md](../PRIVACY.md).

---

## 1. System context

Reservly sits between the Shopify storefront (customers) and NAV / LS Central
(system of record), with staff surfaces on top and event fan-out to Conduit.

```mermaid
flowchart TB
  customer([Customer]):::actor
  staff([Store staff]):::actor
  admin([Super admin]):::actor

  subgraph shopify[Shopify]
    store[Storefront + Checkout]
    ext[Theme app extension<br/>booking widget]
    proxy[App Proxy]
    hooks[Webhooks]
  end

  subgraph reservly[Reservly service · Express :4646]
    api[REST API /api]
    pxy[/proxy · widget backend/]
    wh[/webhooks/shopify/]
    sign[/sign · e-signature/]
    print[/print · documents/]
    spa[Admin SPA /]
    m[Staff PWA /m]
  end

  subgraph nav[NAV / LS Central]
    lsact[WS LS Activity]
    webpos[WS WebPOS → LS Retail POS]
  end

  conduit[Conduit iPaaS]:::ext
  hubspot[HubSpot email]:::ext

  customer --> store
  store --- ext --> proxy --> pxy
  store -- orders/create --> hooks --> wh
  customer -- signing link --> sign
  staff --> spa
  staff --> m
  admin --> spa

  api --> lsact
  api --> webpos
  pxy --> lsact
  api -- catalog sync / publish --> shopify
  api -- booking.* events --> conduit --> hubspot

  classDef actor fill:#E4F6EE,stroke:#12A46B,color:#16181D;
  classDef ext fill:#f4f4f2,stroke:#9A9D96,color:#16181D;
```

---

## 2. Components

| Component | Tech | Path | Responsibility |
|---|---|---|---|
| **API server** | Express + better-sqlite3 (TS, ESM, `tsx`) | `server/` | Domain logic, integrations, all HTTP surfaces |
| **Booking Desk** | React + Vite SPA | `web/` | Staff/manager back office (`/`) |
| **Staff app** | React + Vite PWA | `mobile/` | Floor staff on phones (`/m`) |
| **Booking widget** | Shopify theme app extension (Liquid + vanilla JS) | `extensions/booking-widget/` | Storefront rental/course booking UI |
| **Shopify app config** | `shopify.app.toml` | root | App URLs, scopes, webhooks, app proxy |

One Node process serves everything on `PORT` (4646). The SPAs are built to
`web/dist` and `mobile/dist` and served statically; in dev they run on Vite
(`5646`/`5647`) and proxy `/api` to the server.

### Tech-stack rationale
- **SQLite (better-sqlite3)** — zero-ops, synchronous, fast; per-tenant files give
  hard isolation. Mirrors the sibling Conduit project's stack.
- **AsyncLocalStorage tenant proxy** — multi-tenancy without threading `tenant_id`
  through every query (see §4).
- **No ORM** — hand-written SQL in thin route/lib modules; the schema is small and
  stable.
- **PWA over native** — installable on Android/iOS from a URL, instant updates, one
  codebase; Capacitor wrap remains possible for store distribution.

---

## 3. Deployment topology

```mermaid
flowchart LR
  subgraph host[Host · Node 20+]
    node[Reservly service :4646]
    disk[(Encrypted disk<br/>platform.db<br/>booking-*.db + WAL)]
    node --- disk
  end
  tls[HTTPS reverse proxy / platform TLS] --> node
  shopify[Shopify] -- webhooks + app proxy --> tls
  phones[Staff phones · PWA] --> tls
  browsers[Staff browsers] --> tls
  nav[NAV / LS Central] <-- SOAP/NTLM --> node
```

State is entirely on-disk SQLite — no external database. The disk must be
persistent and encrypted; back up the `.db*` files (see DEPLOYMENT §5).

---

## 4. Multi-tenancy

**One SQLite database per tenant**, selected per request. Existing Gosselin data is
the `gosselin` tenant (`booking.db`); new tenants get `booking-<slug>.db`. A separate
`platform.db` holds the tenant registry and super-admin accounts.

The trick that keeps every existing query tenant-unaware: `db` is a **Proxy** backed
by `AsyncLocalStorage`. Request middleware runs the handler inside a tenant context;
`db.prepare(...)` transparently resolves to that tenant's database. Outside a request
(boot, schedulers) it falls back to the default tenant.

```mermaid
sequenceDiagram
  participant Req as HTTP request
  participant MW as tenantMiddleware
  participant ALS as AsyncLocalStorage
  participant H as Route handler
  participant P as db (Proxy)
  Req->>MW: cookie / x-tenant / ?t= / super-admin selection
  MW->>MW: resolve slug → open tenant DB (cached)
  MW->>ALS: als.run({slug, db}, handler)
  ALS->>H: handler executes in context
  H->>P: db.prepare("SELECT … FROM bookings")
  P->>ALS: getStore().db
  P-->>H: bound to this tenant's DB
```

Tenant resolution priority: **super-admin's selected tenant → `x-tenant` header /
`?t=` (public surfaces like signing links) → default (`gosselin`)**.

Files: `server/db.ts` (proxy + `initSchema`), `server/lib/platform.ts`
(registry, tenant DB cache, `tenantMiddleware`, super-admin sessions).

---

## 5. Data model

### Per-tenant database (`booking-<slug>.db`)

```mermaid
erDiagram
  stores ||--o{ product_store_qty : stocks
  stores ||--o{ sessions : hosts
  stores ||--o{ resources : has
  products ||--o{ product_kit_items : "packing list"
  products ||--o{ product_prices : "price tiers"
  products ||--o{ product_store_qty : "stock/store"
  products ||--o{ sessions : "course instances"
  resources ||--o{ resource_availability : "CSV slots"
  sessions ||--o{ session_trainers : "room + trainers"
  resources ||--o{ session_trainers : assigned
  bookings ||--o{ booking_lines : contains
  bookings ||--o{ events : "timeline"

  bookings {
    string id PK
    string ref UK
    string type "RENTAL|COURSE|MIXED"
    string status "lifecycle"
    string channel "STAFF|WEB"
    string customer_email
    int    customer_b2b
    real   subtotal
    real   deposit
    real   pos_total
    real   refund_due
    string id_encrypted "AES-256-GCM (R14)"
    string sign_token
    string signature_png
    string contract_signed_at
    string shopify_order_id
  }
  booking_lines {
    string id PK
    string booking_id FK
    string type
    string product_no
    string session_id
    string date_from
    string date_to
    int    days
    real   line_total
    real   deposit
    string activity_no "NAV reservation"
    string booking_ref "→ POS FreeText"
    string checklist "JSON packing list"
    string damages "JSON"
  }
```

Other tables: `settings` (per-tenant key/value: NAV/Shopify/POS config, retention,
staff password hash, contract template), `audit_log` (personal-data access),
`webhooks` (outbound subscriptions).

### Platform database (`platform.db`)

```mermaid
erDiagram
  tenants {
    string id PK
    string slug UK
    string name
    string db_file
    int    active
  }
  platform_users {
    string email PK
    string role "superadmin"
    string password_hash "scrypt"
  }
```

---

## 6. Booking lifecycle

```mermaid
stateDiagram-v2
  [*] --> RESERVED: createBooking()<br/>+ NAV ActivityConfirmReservation
  RESERVED --> POS_PENDING: push-pos (WebPOS suspended txn)
  RESERVED --> PAID: web order paid / reconcile
  POS_PENDING --> PAID: reconcile (POS total, coupons)
  PAID --> PICKED_UP: pickup (ID, deposit, contract) [rentals]
  PAID --> COMPLETED: [course-only]
  PICKED_UP --> RETURNED: return (inspection, damages → refund)
  RETURNED --> COMPLETED: complete
  RESERVED --> CANCELLED: cancel (NAV ActivityCancelReservation)
  POS_PENDING --> CANCELLED
  PAID --> CANCELLED
  COMPLETED --> [*]
  CANCELLED --> [*]
```

Each transition emits a `booking.*` event (§8). `bookingService.ts` owns creation
+ serialization for both channels; `routes/booking.ts` owns the transitions.

---

## 7. Engines

### Pricing (`engine/pricing.ts`) — R3A
Rentals bill in whole days: `days = max(1, ceil(hours / 24))` (25h ⇒ 2 days). A
`WEEKLY` tier from NAV `ActivityProductPrice` is applied per full 7-day block when it
beats 7× the daily rate. Deposits come from the product's `security_deposit`.

### Availability (`engine/availability.ts`)
- **Rental:** per-store stock minus overlapping active booking lines, evaluated per
  calendar day. In live mode, cross-checked against NAV `GetActivityAvailability`
  (takes the conservative minimum) so unpaid web carts can't double-book.
- **Course:** session capacity minus booked seats across active bookings.

---

## 8. Integrations

### 8.1 NAV / LS Central (SOAP over NTLM) — `server/lib/nav.ts`
Envelopes mirror the Gosselin middleware connector (`packages/connectors`).
`navMode=mock` (default without credentials) answers locally so the whole flow runs
offline; `live` sends NTLM-authenticated SOAP.

| Operation | NAV function | Use |
|---|---|---|
| Catalog | `GetActivityType`, `GetActivityProducts` | Sync rentals/courses (R0) |
| Availability | `GetActivityAvailability` | Live rental availability |
| Reserve | `ActivityConfirmReservation` | On booking create (R4–R5); returns activityNo + BookingRef |
| Cancel | `ActivityCancelReservation` | On booking cancel |
| POS | `WebPosPost` (WSWebPOS) | Suspended transaction (R3B): Item line at reserved amount + FreeText line carrying BookingRef (payment trigger) |

### 8.2 Shopify — `server/lib/shopifyAdmin.ts` + `routes/integration.ts`
- **Admin API** via **client-credentials grant** (own-org app on own store → the
  server mints its own 24h token; no OAuth redirect). Used to ensure metafield
  definitions, create/update products (`productSet`), and publish to channels
  (`publishablePublish`).
- **App Proxy** (`/proxy/*`) — storefront widget calls `/apps/booking/*` on the shop;
  Shopify signs and forwards. Signature verified server-side.
- **`orders/create` webhook** (`/webhooks/shopify/orders-create`) — HMAC-verified;
  reads `_booking_*` line-item properties and creates the booking + NAV reservation
  (WEB channel). B2B (customer tag) orders arrive unpaid → stay `RESERVED`.
- **Mandatory GDPR webhooks** (`/webhooks/shopify/compliance`) —
  `customers/data_request`, `customers/redact`, `shop/redact`; 401 on bad HMAC.
- **Theme app extension** — the booking widget (metafield-gated: renders only for
  products carrying `booking.type`).

### 8.3 Conduit / HubSpot — `server/lib/events.ts`
Every `booking.*` event is logged locally, dispatched to outbound webhooks (§8.4),
and POSTed to Conduit (`CONDUIT_URL`), which owns HubSpot transactional email
(R6/R19, class steps 11/17). Fire-and-forget — never blocks the in-store flow.

### 8.4 Outbound webhooks — `server/lib/webhooks.ts`
Any URL can subscribe (event filter + optional HMAC secret). Each delivery carries
the **full booking snapshot** (no callback needed), `X-Booking-Signature` when a
secret is set, one retry, last-status recorded. This is how Conduit (or any system)
extracts bookings to publish onward.

---

## 9. Key flows

### 9.1 Web booking (one-cart checkout)

```mermaid
sequenceDiagram
  participant C as Customer
  participant W as Booking widget
  participant PX as /proxy (App Proxy)
  participant S as Shopify checkout
  participant WH as orders/create webhook
  participant BS as bookingService
  participant NAV as NAV LS Activity
  C->>W: pick store + dates / session
  W->>PX: /availability, /quote (signed)
  PX-->>W: price + availability
  C->>S: Add booking + retail to cart → pay once
  S->>WH: orders/create (HMAC)
  WH->>BS: createBooking(_booking_* props)
  BS->>NAV: ActivityConfirmReservation (per line)
  NAV-->>BS: activityNo + BookingRef
  BS-->>WH: booking (RESERVED / PAID if paid)
```

### 9.2 In-store fulfilment → POS

```mermaid
sequenceDiagram
  participant St as Staff (Desk / PWA)
  participant API as /api
  participant POS as WebPOS → LS Retail POS
  St->>API: push-pos
  API->>POS: suspended txn (Item + FreeText BookingRef)
  Note over St,POS: staff completes at till;<br/>coupons may change total
  St->>API: reconcile(posTotal)
  St->>API: pickup(ID enc, deposit, checklist, signature)
  St->>API: return(inspection, damages) → refundDue
  St->>API: complete
```

### 9.3 Customer e-signature — `routes/sign.ts`
`request-signature` mints a one-time token → link (emailed via Conduit/HubSpot or
shown by staff) → public `/sign/:token` page renders the contract + a canvas
signature pad → `POST` stores the PNG + name, marks `contract_signed_at`, emits
`booking.contract_signed`. Token-authenticated (no staff login); carries `?t=<slug>`
for non-default tenants.

---

## 10. Security model

| Surface | Auth |
|---|---|
| Booking Desk `/`, mobile `/m`, `/api`, `/print` | Staff password (scrypt, ≥12 chars, 12h HttpOnly session cookie). Open endpoints: `health`, `auth`, `login`, `logout`. |
| `/api/admin/*` | Platform super-admin session (separate cookie); passes every tenant's staff gate. |
| `/proxy/*` | Shopify App Proxy signature (HMAC). |
| `/webhooks/shopify/*` | Shopify webhook HMAC; 401 on mismatch. |
| `/sign/:token` | Unguessable 24-byte token = the credential; no login. |
| Government ID | AES-256-GCM at rest (`BOOKING_ENC_KEY`); last-4 only surfaced. |

Access to personal data (logins incl. failures, booking views, exports, redactions)
is written to `audit_log`. Retention sweeps run daily. Full mapping in PRIVACY.md.

---

## 11. Module map

```
server/
  index.ts            app wiring, tenant middleware, static SPA serving, schedulers
  db.ts               tenant proxy + schema (initSchema), settings, audit, helpers
  seed.ts             dev catalog seed (mock NAV)
  engine/
    pricing.ts        day-based pricing + weekly tiers (R3A)
    availability.ts   rental (per-store) + course (capacity) availability
  lib/
    platform.ts       tenant registry, tenant DB cache, super-admin, tenantMiddleware
    bookingService.ts createBooking + serialize (WEB + STAFF), status transitions
    nav.ts            LS Activity + WebPOS SOAP client (mock/live)
    shopifyAdmin.ts   Admin API (client-credentials), product publish, channels
    events.ts         emit → audit + outbound webhooks + Conduit
    webhooks.ts       outbound webhook delivery (HMAC, retry)
    crypto.ts         AES-256-GCM government-ID encryption
    auth.ts           staff password gate + sessions
    privacy.ts        retention sweep, redact, data export (GDPR)
  routes/
    catalog.ts        stores, products, sync, publish, sessions, resources
    booking.ts        availability, quote, bookings + lifecycle, dashboard, checklist, sign request
    integration.ts    settings, health, auth, privacy, audit, webhooks, Shopify webhooks + proxy
    print.ts          contract / packing-list / confirmation / daily (+ template)
    sign.ts           public e-signature page + submit
    admin.ts          super-admin: tenants CRUD, use-tenant
web/     Booking Desk SPA (pages/, components/)
mobile/  Staff PWA (App.tsx = login, list, detail, checklist, sign, standby)
extensions/booking-widget/  storefront theme app extension
```

Full endpoint list: [../API.md](../API.md).

---

## 12. Known constraints & roadmap

- **Storefront widget in dev** — `shopify app dev` doesn't update the app-proxy URL
  and the tunnel URL is ephemeral (Shopify CLI #990); run `scripts/set-proxy-url.sh`
  after restarts. Stable in production (one-time `shopify app deploy`).
- **External multi-merchant onboarding** — current tenancy fits one org/many brands.
  A public install flow needs the Shopify **authorization-code OAuth grant** + tenant
  routing by **shop domain** (map `shop → tenant` instead of defaulting), and
  per-tenant Shopify credentials (already stored per-tenant in `settings`).
- **Single shared staff credential per tenant** — v1 uses one staff password per
  tenant; per-user staff accounts + roles are a future addition.
