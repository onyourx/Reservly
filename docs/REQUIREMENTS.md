# Reservly — Requirements Specification

**Status:** v1.0 · Living document
**Origin:** Built for Gosselin Photo (photo/video equipment retailer, Québec) as a
native replacement for the third-party booking tool ("Sesami") originally evaluated.
Reservly fulfils the same rental & course-booking requirements directly, integrated
with Shopify and Microsoft Dynamics NAV / LS Central.

Source material:
- `Gosselin_Detailed_Booking_and_Rental_Requirements.xlsx` (business requirements)
- `Gosselin_Web_Services.pdf` (NAV LS Activity + WebPOS web-service specs)

---

## 1. Purpose & scope

Customers rent equipment and book courses **directly on the Shopify storefront**,
paying for rentals, classes, and regular retail products **in one checkout**. Store
staff run the in-store lifecycle (pickup, inspection, deposit, return) from a
back-office ("Booking Desk") and a phone app, pushing transactions to **LS Retail
POS**. Every reservation is registered in **NAV via LS Activity** web services.

In scope: equipment rentals, course bookings (incl. multi-session series),
one-cart checkout, in-store fulfilment, POS suspended transactions, contracts &
e-signature, NAV + HubSpot integration, multi-tenant operation, staff mobile app.

Out of scope (v1): payment processing itself (owned by Shopify + POS), NAV back-end
customisation, native iOS/Android store builds (the mobile app is an installable PWA).

---

## 2. Actors

| Actor | Description |
|---|---|
| **Customer** | Rents equipment / books courses on the storefront; signs contracts on their phone |
| **Floor staff** | Prepares kits, checks packing lists, records pickup/return, gets signatures |
| **Store manager** | Manages catalog, sessions, resources, pricing, settings |
| **Super admin** (`serge@onyourx.com`) | Platform operator — views/edits/creates tenants, operates any tenant |
| **NAV / LS Central** | System of record for inventory, activities, and POS |
| **Shopify** | Storefront, checkout, payment, product catalog surface |
| **HubSpot** (via Conduit) | Transactional email (confirmations) |

---

## 3. Business requirements — Rentals (traceability R0–R19)

Requirement IDs match the source flowchart. "Status" reflects the implementation.

| ID | Requirement | Implementation | Status |
|---|---|---|---|
| **R0** | Equipment, rental fees & availability loaded into Shopify. Kit items (bag, battery, cleaner…) invisible on web but part of the packing list. | NAV→app catalog sync; `product_kit_items` per product; publish to Shopify with price + metafields | ✅ |
| **R1A** | Customer selects equipment through a hierarchy of products | Shopify collections + booking widget on rental product pages | ✅ |
| **R2A** | Customer selects the store; show only where the item is available | Widget store picker limited to stores with stock (`product_store_qty`) | ✅ |
| **R3A** | Select start & end date. Price in **days or weeks, not hours** — <24h = 1 day, 25h = 2 days. | `engine/pricing.ts`: `days = max(1, ceil(hours/24))`; WEEKLY tier from NAV `ActivityProductPrice` | ✅ |
| **R1B–R2B** | In-store staff have a "store view" (steps inverted vs. web) | Booking Desk → New booking (staff store view) | ✅ |
| **R3B** | Staff push transaction to POS as a **suspended transaction**; POS coupons must reconcile back | WebPOS `EntryStatus=2`; `POST /bookings/:id/reconcile` adjusts financials | ✅ |
| **NAV** | Today no financial txn until pickup; future = pay at pickup. **B2B clients pay later** (Shopify default for B2B). | Booking stays `RESERVED` until POS/pickup; B2B (customer tag) orders arrive unpaid | ✅ |
| **R4–R5** | Booking created; Shopify→NAV transaction | `createBooking()` → `ActivityConfirmReservation` (stores activityNo, bookingRef) | ✅ |
| **R6–R7** | NAV → HubSpot → email confirmation | `booking.created` event → Conduit → HubSpot | ✅ |
| **R8** | Every morning staff print the day's contracts & packing lists | `GET /print/daily?date=&storeId=` batch (packing list + contract per pickup) | ✅ |
| **R9–R11** | Items picked up & inspected with customer; damages/missing marked on contract | Interactive **packing checklist** + pickup inspection notes; damage grid | ✅ |
| **R12–R13** | Deposit taken; contract signed. *Q: electronic contracts? deposit via POS?* | Deposit captured at pickup; **e-signature** (phone) or printed contract w/ signature block; deposit can ride POS suspended txn | ✅ |
| **R14** | Government-issued ID captured **and encrypted** | AES-256-GCM at rest (`BOOKING_ENC_KEY`); only last-4 ever displayed | ✅ |
| **R15–R17** | Equipment returned, inspected, marked complete | `POST /bookings/:id/return` (inspection + per-item damages) → `RETURNED` | ✅ |
| **R18** | Deposit refunded minus rental/damage charges | `refundDue = deposit − Σ damage charges` | ✅ |
| **R19** | HubSpot sends return confirmation email | `booking.returned` event → Conduit → HubSpot | ✅ |
| **Add'l** | One basket for multiple rentals | Bookings are multi-line (rentals + courses mixed in one transaction) | ✅ |

---

## 4. Business requirements — Course bookings

| Step | Requirement | Implementation | Status |
|---|---|---|---|
| Create | Course SKU from NAV; classes have specific start/end (the "3h internal" is NAV-side, not customer-facing) | Catalog sync `type=COURSE`; explicit `sessions` with start/end | ✅ |
| 3A/3B | Trainers' availability provided; schedules uploaded as **CSV**. Courses need **two resource types: Rooms + Trainers**; a private class may have **multiple trainers**. | `resources` (ROOM/TRAINER) + `resource_availability` (CSV import); sessions take a room + N trainers | ✅ |
| Publish | Classes may run over **3 instances** (e.g. night photo, 3 Tuesday evenings). Booking the first instance must **block resources for the whole series**. | `POST /sessions` with `occurrences`/`intervalDays` creates a `series_id`; all instances block room+trainers | ✅ |
| 6–10 | Customer selects class and pays; Shopify→NAV transaction | Widget session picker (seats-aware) → one-cart checkout → webhook → NAV reservation | ✅ |
| 11 / 17 | Email confirmations via HubSpot | Events → Conduit → HubSpot | ✅ |
| 12–15 | In-store: suspended txn to NAV; coupons/promos reconciled | Same `push-pos` + `reconcile` path as rentals | ✅ |
| 16 | Printable booking confirmation | `GET /print/confirmation/:id` | ✅ |

---

## 5. Functional requirements (system)

### 5.1 Catalog & pricing
- Sync activity products (rentals & courses) from NAV LS Activity (`GetActivityType`,
  `GetActivityProducts`), including price tiers, security deposit, web descriptions.
- Publish a product to Shopify from Booking Desk in one action: creates/updates the
  Shopify product (title, price, description, image, `booking.type` /
  `booking.product_no` metafields) and publishes to selected sales channels
  (Online Store, POS).
- Edit price, deposit, and tiers in Booking Desk (NAV remains source of truth in live mode).
- Maintain per-product **kit** (packing-list contents) and per-store rentable quantity.

### 5.2 Availability
- Rentals: per-store units minus overlapping active bookings, per calendar day; in
  live mode cross-checked against NAV `GetActivityAvailability` (conservative min).
- Courses: session capacity minus booked seats.

### 5.3 Bookings lifecycle
- Create bookings from two channels — **WEB** (Shopify `orders/create` webhook) and
  **STAFF** (Booking Desk store view) — through one code path.
- Lifecycle: `RESERVED → POS_PENDING → PAID → PICKED_UP → RETURNED → COMPLETED`
  (+ `CANCELLED`); course-only bookings skip pickup/return.
- Push to LS Retail POS as a suspended transaction (Item line at reserved amount +
  FreeText line carrying the NAV BookingRef as payment trigger).
- Reconcile POS-adjusted totals (coupons) back to the booking.
- Cancel → NAV `ActivityCancelReservation`.

### 5.4 In-store fulfilment
- Interactive packing checklist (auto-derived from the kit) with tick-off.
- Pickup: encrypted government-ID capture, deposit amount, inspection notes,
  contract signing (paper or e-signature).
- Return: inspection, per-item damage charges, automatic deposit-refund computation.

### 5.5 Contracts & e-signature
- Editable contract template (placeholders) in Settings; falls back to a built-in layout.
- Printable contracts, packing lists, course confirmations, and a daily batch.
- Customer e-signature: one-time tokenised link (emailed via HubSpot or shown/texted
  by staff) → mobile signing page with a signature pad → signature stored and rendered
  on the contract.

### 5.6 Staff mobile app
- Installable PWA: login, bookings list (search + status filters), booking detail,
  packing checklist tick-off, hand-the-phone customer signature capture.
- **Battery standby after 5 minutes idle** (or when backgrounded): black screen,
  all timers/polling stopped; tap to resume re-validates the session.

### 5.7 Multi-tenancy & platform admin
- Isolated database per tenant (catalog, bookings, settings, staff password).
- Super-admin console (`serge@onyourx.com`): list tenants with cross-tenant stats,
  create/rename/(de)activate, and operate any tenant's full Booking Desk.

### 5.8 Integrations & extensibility
- Outbound webhooks: any URL can subscribe to `booking.*` events; each delivery
  carries the **full booking snapshot**, HMAC-signed. Consumed by Conduit → external
  systems.
- Event fan-out to Conduit for HubSpot transactional email.

---

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | Staff password gate (scrypt, ≥12 chars, 12h sessions) over admin + print + mobile; Shopify surfaces authenticated by HMAC / proxy signature; super-admin sessions separate. |
| **Privacy / compliance** | Minimum personal data; AES-256-GCM ID encryption; configurable retention with daily purge/anonymization; access audit log; Shopify mandatory GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`). See `PRIVACY.md`. |
| **Data isolation** | One SQLite file per tenant; a query bug cannot cross tenants. |
| **Battery** | Mobile app standby (§5.6) — pure-black OLED-friendly, zero background work. |
| **Localization** | Bilingual product data (EN/FR); store-local timezone for "today" calculations. |
| **Resilience** | Integrations are fire-and-forget; NAV/Conduit failures never block the in-store flow. Widget fails loud (not silent) if the proxy is unreachable. |
| **Deployability** | Single Node service, no external DB; one-command build+serve; reachable across the LAN; see `DEPLOYMENT.md`. |

---

## 7. Open questions carried from the source spec

- **Deposit on POS** — currently recorded in-app at pickup and refunded at return
  (R18). If Gosselin wants the deposit itself tendered through the POS, add a second
  FreeText/deposit line to the suspended transaction.
- **Course availability by trainer subset** — sessions are explicit instances (staff
  create them against a room + trainers), so "either trainer available" scenarios are
  handled by creating the session with whoever is actually available, rather than
  solving a constraint over trainer sets.
- **True external multi-merchant onboarding** — current tenancy suits one org running
  multiple brands. A public "install on your own Shopify store" flow needs the Shopify
  OAuth authorization-code grant + tenant routing by shop domain (see ARCHITECTURE §9).

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **LS Activity** | LS Central module NAV uses for bookings/activities (rentals & courses) |
| **WebPOS** | NAV web service for pushing mobile/web transactions to LS Retail POS |
| **Suspended transaction** | A POS transaction parked (EntryStatus 2) for staff to complete at the till |
| **BookingRef** | NAV reference returned on reservation; placed on the POS FreeText line to trigger payment |
| **Tenant** | An isolated Reservly customer (one store group) with its own database |
| **Conduit** | The sibling iPaaS that fans booking events out to HubSpot and other systems |
