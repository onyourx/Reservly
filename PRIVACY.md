# Privacy & data protection — how the app backs the Shopify declarations

This maps each "Protected customer data" questionnaire answer to what the app
actually does. Items marked **(ops)** are deployment/organizational duties that
code alone can't satisfy — they're listed so they end up in the runbook.

## Purpose

| Declaration | Implementation |
|---|---|
| Minimum personal data | We store only what a booking needs: email, name, phone, B2B flag. Government ID (rentals, R14) is AES-256-GCM encrypted, never displayed (last-4 only), never exported, and auto-purged (below). No addresses, no payment data (payments stay in Shopify/POS). |
| Merchants told what/why | This document + `README.md`; data is used solely to fulfil rentals/course bookings, contracts and transactional emails. |
| Purpose limitation | No analytics on personal data, no marketing use, no sharing beyond NAV (order fulfilment) and HubSpot via Conduit (transactional email). |

## Consent

| Declaration | Implementation |
|---|---|
| Privacy agreements with merchants | **(ops)** — single-merchant (Gosselin) custom app; covered by the service agreement. |
| Customer consent decisions | We send transactional messages only (booking confirmations/returns), which don't require marketing consent; the `buyer_accepts_marketing` flag is not used for anything. |
| Opt-out of data sale | We do not sell data — N/A. |
| Automated decision-making | None — N/A. |

## Storage

| Declaration | Implementation |
|---|---|
| Retention periods | Daily sweep (`server/lib/privacy.ts`): encrypted IDs purged **30 days** after a booking closes; whole bookings anonymized after **730 days** (both configurable in Settings). Manual sweep: `POST /api/privacy/sweep`. |
| Encryption in transit | Shopify/HubSpot/Conduit over HTTPS. **(ops)** NAV base URL must be HTTPS in production. |
| Encryption at rest | Government IDs: AES-256-GCM in app (`BOOKING_ENC_KEY`). Whole-database: **(ops)** run on an encrypted volume (FileVault/LUKS/EBS-encrypted). |
| Encrypted backups | **(ops)** back up `booking.db` to encrypted storage only. |
| Test/prod separation | Mock NAV mode + separate SQLite files per environment (`BOOKING_DB`); dev store ≠ production store. |
| Data-loss prevention | WAL journaling + **(ops)** scheduled encrypted backups. |

## Access

| Declaration | Implementation |
|---|---|
| Limit staff access | Staff password gate over the whole app and print pages (Settings → "Staff password"); Shopify surfaces authenticate by webhook HMAC / proxy signature instead. |
| Strong passwords | Minimum 12 characters, stored as scrypt hash, sessions expire after 12 h, all sessions revoked on rotation. |
| Log access to personal data | `audit_log` table: logins (incl. failures + IP), booking detail views (who looked at whose booking), privacy exports/redactions, retention sweeps. `GET /api/audit`. |
| Incident response policy | **(ops)** — document owner + rotation steps: rotate Shopify client secret, `BOOKING_ENC_KEY`, staff password; audit log provides the access trail. |

## Shopify mandatory compliance webhooks

`/webhooks/shopify/compliance` (HMAC-verified, 401 on failure — Shopify requirement):

- `customers/data_request` → audited; staff runs `GET /api/privacy/export?email=…` and delivers the JSON.
- `customers/redact` → all bookings for that customer anonymized immediately (totals kept, person unlinked).
- `shop/redact` → Shopify connection settings cleared.

Staff can also redact on request without Shopify: `POST /api/privacy/redact {email}`.
