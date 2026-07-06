import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BOOKING_DB || path.join(__dirname, "..", "booking.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

db.exec(`
CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,        -- NAV location code (LS Activity FixedLocation / pLocationNo)
  name TEXT NOT NULL,
  city TEXT DEFAULT ''
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
  updated_at TEXT NOT NULL
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
`);

const SETTING_DEFAULTS: Record<string, string> = {
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

export function logEvent(bookingId: string | null, type: string, detail: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO events (booking_id, type, detail, at) VALUES (?, ?, ?, ?)").run(
    bookingId, type, j(detail), now(),
  );
}
