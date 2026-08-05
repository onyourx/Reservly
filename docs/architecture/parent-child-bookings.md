# Parent/child bookings

Date: 2026-08-05
Status: accepted (v1 = server core; Desk/manage UI follows)

## Problem

A multi-product order (courses, services, rentals mixed) becomes one booking with
several lines. Operationally each item has its own lifecycle (pickup/return,
session attendance, no-show, cancellation), so staff want one booking per item,
grouped under the order.

## Split rule

Given the lines of one order/booking request:

- each **COURSE** line → its own child booking
- each **SERVICE** line → its own child booking
- **RENTAL** lines are grouped by identical `(date_from, date_to)` window —
  same pickup and return → one child booking together; different windows →
  separate children

If the rule yields **one** group, behavior is exactly as before: a single
booking, no parent. A parent is created only when there are ≥ 2 children.

Applies to every creation path: Shopify order ingest, the storefront proxy
booking endpoint, and staff-created Desk bookings.

## Data model

`bookings.parent_booking_id TEXT DEFAULT ''` (idempotent ALTER, same pattern as
other post-v1 columns). A parent is a normal `bookings` row (own ref, manage
token, type `MIXED`, customer/order fields, `subtotal/deposit/total` = sum of
children) with **no** `booking_lines`. Children are normal bookings carrying
their group's lines and `parent_booking_id`.

## Orchestration

`createBookings(input)` (new, exported from bookingService) partitions
`input.lines`, and:

- one group → delegates to `createBooking(input)` unchanged;
- else inserts the parent row, then calls `createBooking` per group with
  `parentBookingId` set. Order-level extras attach once: `addons` and
  `holdToken` go to the first rental group's child (or first child if no
  rentals). After the loop the parent totals are updated and a
  `booking.created` event is emitted for the parent. If a child creation
  throws, previously created children and the parent are cancelled
  (compensation — no cross-await SQLite transaction) and the error rethrows.

Reminders stay per child (`scheduleBookingReminders` runs inside
`createBooking`). Manage links: children each emit their own
`booking.management_link_created` as today; the parent emits none in v1 (the
manage page renders lines, which a parent doesn't have).

## Status aggregation

`setStatus` recomputes the parent when a child changes: all children
`CANCELLED` → parent `CANCELLED`; all children terminal
(`COMPLETED`/`RETURNED`/`CANCELLED`, ≥ 1 not cancelled) → parent `COMPLETED`;
otherwise the parent keeps its payment status. Parents are not directly
cancellable through the child-status path.

## Serialization

`serializeBooking` gains `parentBookingId`, `parentRef`, `isParent`, and for
parents `children: [{ id, ref, type, status, total }]`.

## v1.1 hardening (from adversarial review)

- `bookings.is_parent INTEGER NOT NULL DEFAULT 0` marks parents explicitly;
  indexed `parent_booking_id`. Money aggregates (reports summary, dashboard
  revenue, platform admin revenue, bookings CSV) filter `is_parent = 0` —
  children carry the truth, the parent total is derived convenience.
- Line-dependent routes (push-pos, cancel, refund-quote, no-show) reject
  parents with a explicit 400 rather than acting on zero lines.
- Class-ticket sending fans out to children when the created booking is a
  parent (webhook ingest and POS reconcile).
- Webhook idempotency guard ignores CANCELLED rows so a compensated
  (failed) paid order can be re-ingested on redelivery.
- Parents emit `order.created`, not `booking.created`, so downstream
  consumers (webhooks/Conduit) don't double-count orders.
- Compensation also cancels NAV reservations of already-created children.
- The flat per-product shipping fee is deduped across children
  (`shippingFeeExcludeProductNos` accumulates through the orchestration) so
  a split order totals exactly what one booking would have.

## Out of scope for v1

Desk UI grouping (list badges, parent detail with children), manage-page
rendering for parents, parent-level e-signature, refund aggregation across
children. Contracts, refunds, and reminders continue to work per child.
