import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BOOKING_DB || path.join(__dirname, "..", "booking.db");

// ---------------------------------------------------------------------------
// Multi-tenancy: one SQLite file per tenant. Request middleware selects the
// tenant and every existing `db.…` call transparently hits the right file via
// this AsyncLocalStorage-backed proxy — no per-query tenant_id plumbing.
// Outside a request context (boot, schedulers) the default tenant is used.
// ---------------------------------------------------------------------------

export interface TenantContext { slug: string; db: Database.Database }

export const tenantALS = new AsyncLocalStorage<TenantContext>();

function openDatabase(file: string): Database.Database {
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

export const DEFAULT_TENANT_SLUG = "gosselin";
const defaultDb = openDatabase(DB_PATH);

export const currentTenant = () => tenantALS.getStore() ?? { slug: DEFAULT_TENANT_SLUG, db: defaultDb };

export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const real = currentTenant().db as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

export const now = () => new Date().toISOString();
/** Store-local calendar date (YYYY-MM-DD) — "today" for pickups/returns/classes
 *  must follow the store clock, not UTC (en-CA locale formats as ISO). */
export const localDate = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.BOOKING_TZ || "America/Toronto" });
export const uid = () => crypto.randomBytes(9).toString("base64url");
export const j = (v: unknown) => JSON.stringify(v ?? null);
export function pj<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function initSchema(d: import("better-sqlite3").Database) {
  d.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- NAV location code (LS Activity FixedLocation / pLocationNo)
  name TEXT NOT NULL,
  city TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  product_no TEXT NOT NULL UNIQUE,  -- LS Activity ProductNo
  type TEXT NOT NULL,               -- RENTAL | COURSE
  activity_type TEXT DEFAULT '',
  name TEXT NOT NULL,
  name_fr TEXT DEFAULT '',
  web_desc_en TEXT DEFAULT '',
  web_desc_fr TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  duration_type TEXT DEFAULT '',    -- Hours | Days | Session
  duration REAL DEFAULT 0,
  default_unit_price REAL NOT NULL DEFAULT 0,
  security_deposit REAL NOT NULL DEFAULT 0,
  retail_item TEXT DEFAULT '',      -- NAV selling item pushed into carts/POS
  fixed_location TEXT DEFAULT '',
  available_on_web INTEGER NOT NULL DEFAULT 1,
  min_qty INTEGER DEFAULT 1,
  max_qty INTEGER DEFAULT 10,
  shopify_product_id TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  nav_synced_at TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_kit_items (   -- packing-list contents (R0/R8)
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_no TEXT NOT NULL,
  description TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_prices (      -- NAV ActivityProductPrice tiers (e.g. WEEKLY)
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS product_translations (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (product_id, locale)
);

CREATE TABLE IF NOT EXISTS booking_fields (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS booking_field_translations (
  field_id TEXT NOT NULL REFERENCES booking_fields(id) ON DELETE CASCADE,
  locale TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (field_id, locale)
);

CREATE TABLE IF NOT EXISTS product_store_qty (   -- rentable units per store
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, store_id)
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,               -- ROOM | TRAINER
  name TEXT NOT NULL,
  store_id TEXT REFERENCES stores(id),
  notes TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS resource_availability (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  date TEXT NOT NULL,               -- YYYY-MM-DD
  from_time TEXT NOT NULL,          -- HH:MM
  to_time TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (            -- course instances; series share series_id
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  series_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  store_id TEXT NOT NULL REFERENCES stores(id),
  room_id TEXT REFERENCES resources(id),
  capacity INTEGER NOT NULL DEFAULT 8,
  instance_no INTEGER NOT NULL DEFAULT 1,
  instance_count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS session_trainers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, resource_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,               -- RENTAL | COURSE | MIXED
  status TEXT NOT NULL,             -- RESERVED | POS_PENDING | PAID | PICKED_UP | RETURNED | COMPLETED | CANCELLED
  channel TEXT NOT NULL,            -- STAFF | WEB
  store_id TEXT REFERENCES stores(id),
  customer_email TEXT NOT NULL,
  customer_first TEXT DEFAULT '',
  customer_last TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_b2b INTEGER NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  pos_total REAL,
  refund_due REAL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  pos_receipt_no TEXT DEFAULT '',
  shopify_order_id TEXT DEFAULT '',
  shopify_order_name TEXT DEFAULT '',
  id_encrypted TEXT DEFAULT '',     -- AES-256-GCM government ID (R14)
  contract_signed_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ticket_emailed_at TEXT
);

CREATE TABLE IF NOT EXISTS booking_lines (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- RENTAL | COURSE
  product_no TEXT NOT NULL,
  product_name TEXT DEFAULT '',
  session_id TEXT,
  store_id TEXT,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  days INTEGER,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  deposit REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  activity_no TEXT DEFAULT '',      -- NAV reservation no (pReturnActivityNo)
  booking_ref TEXT DEFAULT '',      -- NAV pReturnBookingRef → POS FreeText barcode
  selling_item TEXT DEFAULT '',     -- NAV pReturnSellingItem
  inspection_out TEXT DEFAULT '',
  inspection_in TEXT DEFAULT '',
  damages TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS rental_units (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id TEXT REFERENCES stores(id),
  serial_no TEXT NOT NULL DEFAULT '',
  barcode TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'AVAILABLE', -- AVAILABLE | RESERVED | ON_RENT | SERVICE | RETIRED
  condition TEXT NOT NULL DEFAULT 'GOOD',   -- NEW | GOOD | FAIR | DAMAGED
  notes TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0,
  next_service_usage INTEGER,
  last_service_at TEXT,
  next_service_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_line_units (
  booking_line_id TEXT NOT NULL REFERENCES booking_lines(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES rental_units(id),
  assigned_at TEXT NOT NULL,
  returned_at TEXT,
  PRIMARY KEY (booking_line_id, unit_id)
);

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES rental_units(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'ROUTINE',
  notes TEXT NOT NULL DEFAULT '',
  usage_at_service INTEGER NOT NULL DEFAULT 0,
  serviced_at TEXT NOT NULL,
  next_service_usage INTEGER,
  next_service_at TEXT
);

CREATE TABLE IF NOT EXISTS rental_unit_unavailability (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES rental_units(id) ON DELETE CASCADE,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'Maintenance',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT,
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhooks (            -- outbound subscriptions (Conduit & friends)
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',              -- '*' or JSON array of event types (booking.created, …)
  secret TEXT DEFAULT '',                        -- HMAC-SHA256 of body → X-Booking-Signature
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_status TEXT DEFAULT ''                    -- e.g. "200 @ 2026-07-06T…" or error text
);

CREATE TABLE IF NOT EXISTS audit_log (          -- access log for personal data (privacy declaration: "log access")
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'staff',
  action TEXT NOT NULL,                          -- login | login_failed | booking.viewed | privacy.export | ...
  subject TEXT DEFAULT '',                       -- booking ref / customer email
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS booking_holds (
  token TEXT PRIMARY KEY,
  product_no TEXT NOT NULL,
  session_id TEXT,
  store_id TEXT,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_holds_expiry ON booking_holds(expires_at);

CREATE TABLE IF NOT EXISTS intake_forms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  fields TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_addons (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  addon_product_no TEXT NOT NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  max_qty INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_cross_sell (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  suggested_product_no TEXT NOT NULL,
  PRIMARY KEY (product_id, suggested_product_no)
);

CREATE TABLE IF NOT EXISTS waitlist (
  id TEXT PRIMARY KEY,
  product_no TEXT NOT NULL,
  session_id TEXT,
  store_id TEXT,
  date_from TEXT NOT NULL DEFAULT '',
  date_to TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'WAITING',
  notified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_slot ON waitlist(product_no,session_id,store_id,status,created_at);

CREATE TABLE IF NOT EXISTS availability_rules (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL, -- STORE | PRODUCT | RESOURCE
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,       -- OPENING | BLACKOUT
  weekday INTEGER,
  starts_at TEXT NOT NULL DEFAULT '',
  ends_at TEXT NOT NULL DEFAULT '',
  from_time TEXT NOT NULL DEFAULT '',
  to_time TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS availability_rules_scope ON availability_rules(scope_type,scope_id,kind);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_jobs_due ON notification_jobs(status,scheduled_at);

CREATE TABLE IF NOT EXISTS booking_addons (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  addon_product_no TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  shopify_variant_id TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS extension_requests (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  old_date_to TEXT NOT NULL,
  new_date_to TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|APPROVED|REJECTED|APPLIED|EXPIRED|CANCELLED
  shopify_draft_order_id TEXT DEFAULT '',
  invoice_url TEXT DEFAULT '',
  decided_at TEXT, paid_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',      -- 'owner' | 'member'
  perms TEXT NOT NULL DEFAULT '{}',         -- JSON {products,bookings,sessions,reports,availability: boolean}
  store_ids TEXT NOT NULL DEFAULT '*',      -- '*' or JSON array of store ids
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

  // Post-v1 columns (idempotent migrations for existing databases).
  for (const stmt of [
    "ALTER TABLE stores ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE stores ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE stores ADD COLUMN pos_store_id TEXT DEFAULT ''",
    "ALTER TABLE stores ADD COLUMN pos_terminal_id TEXT DEFAULT ''",
    "ALTER TABLE stores ADD COLUMN pos_staff_id TEXT DEFAULT ''",
    "ALTER TABLE booking_lines ADD COLUMN checklist TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE bookings ADD COLUMN sign_token TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN signature_png TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN signature_name TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN late_fee_per_day REAL NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN sku TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN nav_synced_at TEXT DEFAULT ''",
    "ALTER TABLE rental_units ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rental_units ADD COLUMN next_service_usage INTEGER",
    "ALTER TABLE rental_units ADD COLUMN last_service_at TEXT",
    "ALTER TABLE rental_units ADD COLUMN next_service_at TEXT",
    "ALTER TABLE sessions ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'IN_PERSON'",
    "ALTER TABLE sessions ADD COLUMN meeting_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE sessions ADD COLUMN meeting_host_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE sessions ADD COLUMN zoom_meeting_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE products ADD COLUMN buffer_before INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN buffer_after INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN min_notice_hours INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE products ADD COLUMN max_advance_days INTEGER NOT NULL DEFAULT 365",
    "ALTER TABLE products ADD COLUMN cancellation_hours INTEGER NOT NULL DEFAULT 24",
    "ALTER TABLE products ADD COLUMN customer_can_cancel INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE products ADD COLUMN customer_can_reschedule INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE products ADD COLUMN deposit_policy TEXT NOT NULL DEFAULT 'PICKUP'",
    "ALTER TABLE bookings ADD COLUMN manage_token TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN checked_in_at TEXT",
    "ALTER TABLE bookings ADD COLUMN no_show_at TEXT",
    "ALTER TABLE bookings ADD COLUMN no_show_fee REAL DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN no_show_fee_status TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN no_show_draft_order_id TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN intake_responses TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE bookings ADD COLUMN terms_accepted_at TEXT",
    "ALTER TABLE bookings ADD COLUMN reschedule_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN id_photo_ref TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN id_photo_at TEXT DEFAULT ''",
    "ALTER TABLE bookings ADD COLUMN ticket_emailed_at TEXT",
    "ALTER TABLE product_addons ADD COLUMN shopify_variant_id TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      d.exec(stmt);
    } catch {
      /* column already exists */
    }
  }
  // Backfill the legacy bilingual fields into the extensible translation model.
  d.exec(`INSERT OR IGNORE INTO product_translations(product_id,locale,name,description)
          SELECT id,'en',name,web_desc_en FROM products;
          INSERT OR IGNORE INTO product_translations(product_id,locale,name,description)
          SELECT id,'fr',COALESCE(NULLIF(name_fr,''),name),web_desc_fr FROM products;`);
}

initSchema(defaultDb);

const SETTING_DEFAULTS: Record<string, string> = {
  currency: "CAD",
  navMode: process.env.NAV_BASE_URL ? "live" : "mock",
  navBaseUrl: process.env.NAV_BASE_URL || "",
  navUsername: process.env.NAV_USERNAME || "",
  navPassword: process.env.NAV_PASSWORD || "",
  navDomain: process.env.NAV_DOMAIN || "",
  shopifyShop: process.env.SHOPIFY_SHOP || "",
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET || "",
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID || "",
  conduitUrl: process.env.CONDUIT_URL || "",
  posStoreId: "091",
  posTerminalId: "9101",
  posStaffId: "WEB",
  // Privacy: retention periods (days). Encrypted government IDs are purged soon
  // after a rental closes; whole bookings are anonymized after the long period.
  idRetentionDays: "30",
  dataRetentionDays: "730",
  adminPasswordHash: "",
  publicUrl: process.env.PUBLIC_URL || "", // base for customer-facing links (e-signature)
  contractTemplate: "",                    // custom contract HTML with {{placeholders}}; empty = built-in
  enabledLanguages: '["en","fr"]',         // tenant catalog/customer-content languages
  zoomAccountId: process.env.ZOOM_ACCOUNT_ID || "",
  zoomClientId: process.env.ZOOM_CLIENT_ID || "",
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET || "",
  zoomUserId: process.env.ZOOM_USER_ID || "me",
  slotHoldMinutes: "10",
  maxCustomerReschedules: "5",
  extensionsEnabled: "",
  extensionApproval: "auto",
  noShowFeeMode: "off",
  noShowFeeValue: "0",
  reminderHours: "[24]",
  remindersEnabled: "",
  reminderPickupEnabled: "",
  reminderReturnEnabled: "",
  reminderPickupHours: "24",
  reminderReturnHours: "24",
  reminderPickupSubject: "Reminder: your rental pickup at {{store}}",
  reminderPickupTemplate: `<p>Hi {{firstName}},</p>
<p>We're looking forward to your rental pickup at <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>See you soon!</p>`,
  reminderReturnSubject: "Reminder: your rental return to {{store}}",
  reminderReturnTemplate: `<p>Hi {{firstName}},</p>
<p>This is a reminder to return your rental to <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>Thank you!</p>`,
  cancelPolicyEnabled: "",
  cancelFullRefundDays: "7",
  cancelPartialRefundDays: "2",
  cancelPartialRefundPercent: "50",
  pickupEarliestTime: "",
  returnByTime: "",
  serviceOpenTime: "09:00",
  serviceCloseTime: "17:00",
  rentalIncrementUnit: "day",
  rentalIncrementValue: "1",
  termsRentalEnabled: "",
  termsCourseEnabled: "",
  termsServiceEnabled: "",
  termsRentalHtml: "",
  termsCourseHtml: "",
  termsServiceHtml: "",
  termsRentalPdf: "",
  termsCoursePdf: "",
  termsServicePdf: "",
  sftpHost: "",
  sftpPort: "22",
  sftpUser: "",
  sftpPassword: "",
  sftpPasswordEnc: "",
  sftpPath: "/reservly-ids",
};

export function getSettings(): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...SETTING_DEFAULTS, ...map };
}

export function putSettings(patch: Record<string, unknown>) {
  const stmt = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [k, v] of Object.entries(patch)) {
    if (k in SETTING_DEFAULTS) stmt.run(k, String(v ?? ""));
  }
}

export function auditLog(action: string, subject = "", detail = "", actor = "staff") {
  db.prepare("INSERT INTO audit_log (at, actor, action, subject, detail) VALUES (?, ?, ?, ?, ?)").run(
    now(), actor, action, subject, detail,
  );
}

export function logEvent(bookingId: string | null, type: string, detail: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO events (booking_id, type, detail, at) VALUES (?, ?, ?, ?)").run(
    bookingId, type, j(detail), now(),
  );
}
