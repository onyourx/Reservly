# Booking Desk — API contract (v1)

Server: Express on **:4646**. All JSON under `/api`. Dates are ISO strings; money is decimal CAD.
Errors: non-2xx with `{ "error": string }`.

## Reference data

- `GET /api/health` → `{ ok, navMode: "mock"|"live", shopifyConfigured: boolean }`
- `GET /api/stores` → `{ stores: [{ id, code, name, city }] }`

## Products (rental equipment + courses, synced from NAV LS Activity)

- `GET /api/products?type=RENTAL|COURSE&q=` →
  `{ products: [Product] }`
  where `Product = { id, productNo, type, name, nameFr, webDescEn, webDescFr, imageUrl,
  activityType, durationType, duration, defaultUnitPrice, securityDeposit, retailItem,
  fixedLocation, availableOnWeb, minQty, maxQty, shopifyProductId,
  kit: [{ itemNo, description, qty }],       // packing-list items (R0/R8)
  prices: [{ description, price }] }`
- `GET /api/products/:id` → `{ product: Product & { sessions?: [Session] } }`
- `PUT /api/products/:id` body `{ imageUrl?, webDescEn?, webDescFr?, kit?, shopifyProductId?, availableOnWeb? }` → `{ product }`
- `POST /api/products/sync` → `{ synced: number }` (pull from NAV GetActivityType + GetActivityProducts)

## Courses: sessions & resources

- `Session = { id, productId, productNo, seriesId, startsAt, endsAt, storeId, roomId,
  trainerIds: [string], capacity, booked, instanceNo, instanceCount }`
- `GET /api/sessions?productId=&from=&to=&storeId=` → `{ sessions: [Session & { productName }] }`
- `POST /api/sessions` body `{ productId, startsAt, endsAt, storeId, roomId?, trainerIds?, capacity,
  occurrences?: number, intervalDays?: number }` — occurrences>1 creates a series (e.g. 3 Tuesday evenings),
  all instances share `seriesId` and block their resources → `{ sessions: [Session] }`
- `DELETE /api/sessions/:id` → `{ ok }`
- `Resource = { id, type: "ROOM"|"TRAINER", name, storeId, notes }`
- `GET /api/resources?type=` → `{ resources: [Resource] }`
- `POST /api/resources` body `{ type, name, storeId, notes? }` → `{ resource }`
- `DELETE /api/resources/:id` → `{ ok }`
- `POST /api/resources/:id/availability` body `{ slots: [{ date, from, to }] }` (CSV import parsed client-side) → `{ added }`
- `GET /api/resources/:id/availability?from=&to=` → `{ slots: [{ date, from, to }] }`

## Availability & pricing

- `GET /api/availability/rental?productNo=&storeId=&from=&to=` →
  `{ available: boolean, perDay: [{ date, qty }] }`
- `GET /api/availability/course?productNo=&from=&days=` →
  `{ slots: [{ sessionId, date, time, endsAt, storeId, location, capacity, booked, remaining, trainers: [string] }] }`
- `POST /api/quote` body `{ lines: [QuoteLine] }`
  `QuoteLine = { type: "RENTAL", productNo, storeId, from, to, qty }
             | { type: "COURSE", sessionId, qty }`
  → `{ lines: [{ ...line, productName, days?, unitPrice, lineTotal, deposit }], subtotal, deposit, currency: "CAD" }`
  Rental pricing: billed in whole days — `days = max(1, ceil(hours/24))` (25h ⇒ 2 days). Weekly tier applied when defined.

## Bookings

- `Booking = { id, ref, type: "RENTAL"|"COURSE"|"MIXED", status, channel: "STAFF"|"WEB",
  storeId, customer: { email, firstName, lastName, phone, b2b },
  lines: [BookingLine], subtotal, deposit, total, posTotal, currency,
  navRefs: [{ lineId, activityNo, bookingRef, sellingItem }],
  posReceiptNo, shopifyOrderId, shopifyOrderName, idOnFile: boolean, contractSignedAt,
  notes, createdAt, events: [{ at, type, detail }] }`
- `BookingLine = { id, type, productNo, productName, sessionId?, storeId, from, to, qty,
  days?, unitPrice, lineTotal, deposit, status, activityNo?, bookingRef?,
  inspectionOut?, inspectionIn?, damages: [{ itemNo, note, charge }] }`
- Booking statuses: `RESERVED → POS_PENDING → PAID → PICKED_UP → RETURNED → COMPLETED`, plus `CANCELLED`.
  (Course bookings skip PICKED_UP/RETURNED: `PAID → COMPLETED`.)
- `GET /api/bookings?status=&type=&storeId=&q=&date=` → `{ bookings: [Booking-lite] }`
- `POST /api/bookings` body `{ customer, storeId, channel, notes?, lines: [QuoteLine] }`
  → creates booking `RESERVED`, sends each line to NAV (ActivityConfirmReservation) → `{ booking }`
- `GET /api/bookings/:id` → `{ booking }`
- `POST /api/bookings/:id/push-pos` → WebPOS suspended transaction (EntryStatus 2, Item line w/ manual price + FreeText line w/ BookingRef barcode) → `{ receiptNo, booking }`
- `POST /api/bookings/:id/pickup` body `{ idNumber?, depositAmount?, inspection?, signature? }` → `PICKED_UP` (ID encrypted at rest, R14)
- `POST /api/bookings/:id/return` body `{ inspection?, damages?: [{ itemNo, note, charge }] }` → `RETURNED`, computes `refundDue`
- `POST /api/bookings/:id/complete` → `COMPLETED`
- `POST /api/bookings/:id/cancel` body `{ reason? }` → NAV ActivityCancelReservation + `CANCELLED`
- `POST /api/bookings/:id/reconcile` body `{ posTotal, receiptNo? }` → adjust financials after POS coupons (R3B)

## Dashboard & printing

- `GET /api/dashboard/today?storeId=` → `{ date, pickups: [Booking-lite], returns: [Booking-lite],
  classes: [{ session, productName, booked, capacity }], stats: { activeRentals, todayRevenue, upcoming7d, openDeposits } }`
- Printable HTML (open in new tab): `GET /print/contract/:bookingId`, `GET /print/packing-list/:bookingId`,
  `GET /print/daily?date=&storeId=` (morning batch, R8), `GET /print/confirmation/:bookingId` (course, step 16)

## Settings & events

- `GET /api/settings` → `{ settings: { navBaseUrl, navMode, storeId POS mapping, shopifyShop, conduitUrl, ... } }`
- `PUT /api/settings` body: partial settings → `{ settings }`
- `GET /api/events?bookingId=&limit=` → `{ events: [{ at, type, bookingId, detail }] }`
  (Events `booking.created|cancelled|returned|reconciled` are also forwarded to Conduit → HubSpot for transactional email, R6/R19.)

## Shopify surfaces (server-owned, not used by admin UI)

- `POST /webhooks/shopify/orders-create` — HMAC-verified; reads `_booking_*` line item properties, creates bookings + NAV reservations.
- `GET /proxy/*` — Shopify App Proxy (signature-verified): `/proxy/availability`, `/proxy/quote`, `/proxy/sessions` for the storefront widget.
