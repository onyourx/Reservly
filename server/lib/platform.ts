// Platform layer: the tenant registry and super-admin accounts live in their
// own database (platform.db), above all tenant databases. The super admin
// (serge@onyourx.com) can list/create/edit tenants and operate any tenant's
// Booking Desk. Each tenant's data is a separate SQLite file — hard isolation.
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, NextFunction } from "express";
import { tenantALS, initSchema, DEFAULT_TENANT_SLUG, now, uid } from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BOOKING_DATA_DIR || path.join(__dirname, "..", "..");
const SUPERADMIN_EMAIL = "serge@onyourx.com";

export const platformDb = new Database(path.join(DATA_DIR, "platform.db"));
platformDb.pragma("journal_mode = WAL");
platformDb.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  db_file TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_users (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'superadmin',
  password_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`);

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  try {
    return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

/** Seed: register the existing database as the first tenant, and the super
 *  admin account. A generated first-run password is printed to the server log
 *  once — change it right after signing in. */
export function seedPlatform() {
  const hasDefault = platformDb.prepare("SELECT 1 FROM tenants WHERE slug = ?").get(DEFAULT_TENANT_SLUG);
  if (!hasDefault) {
    platformDb.prepare("INSERT INTO tenants (id, slug, name, db_file, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
      .run(uid(), DEFAULT_TENANT_SLUG, "Gosselin Photo", "booking.db", now());
  }
  const admin = platformDb.prepare("SELECT * FROM platform_users WHERE email = ?").get(SUPERADMIN_EMAIL) as any;
  if (!admin) {
    const firstPassword = "reservly-" + crypto.randomBytes(6).toString("hex");
    platformDb.prepare("INSERT INTO platform_users (email, role, password_hash, created_at) VALUES (?, 'superadmin', ?, ?)")
      .run(SUPERADMIN_EMAIL, hashPassword(firstPassword), now());
    console.log(`[platform] Super admin created: ${SUPERADMIN_EMAIL} — first-run password: ${firstPassword} (change it in the Tenants page)`);
  }
}

// --- Tenant databases --------------------------------------------------------

const tenantDbs = new Map<string, Database.Database>();

export interface TenantRow { id: string; slug: string; name: string; db_file: string; active: number; created_at: string }

export const listTenants = () => platformDb.prepare("SELECT * FROM tenants ORDER BY created_at").all() as TenantRow[];
export const getTenant = (slug: string) => platformDb.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug) as TenantRow | undefined;

export function openTenantDb(slug: string): Database.Database | null {
  const t = getTenant(slug);
  if (!t || !t.active) return null;
  let d = tenantDbs.get(slug);
  if (!d) {
    d = new Database(path.isAbsolute(t.db_file) ? t.db_file : path.join(DATA_DIR, t.db_file));
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    initSchema(d);
    tenantDbs.set(slug, d);
  }
  return d;
}

export function createTenant(slug: string, name: string): TenantRow {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) throw new Error("Slug must be lowercase letters/digits/dashes");
  if (getTenant(slug)) throw new Error(`Tenant '${slug}' already exists`);
  platformDb.prepare("INSERT INTO tenants (id, slug, name, db_file, active, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .run(uid(), slug, name || slug, `booking-${slug}.db`, now());
  openTenantDb(slug); // create the file + schema right away
  return getTenant(slug)!;
}

// --- Super-admin sessions ------------------------------------------------------

const adminSessions = new Map<string, { email: string; tenantSlug: string | null; expiresAt: number }>();
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;

function adminToken(req: Request): string {
  const m = /(?:^|;\s*)bd_admin=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m?.[1] ?? "";
}

export function adminSession(req: Request) {
  const s = adminSessions.get(adminToken(req));
  return s && s.expiresAt > Date.now() ? s : null;
}

export function adminLogin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  const user = platformDb.prepare("SELECT * FROM platform_users WHERE email = ?").get(String(email ?? "").toLowerCase().trim()) as any;
  if (!user || !verifyPassword(String(password ?? ""), user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = crypto.randomBytes(24).toString("base64url");
  adminSessions.set(token, { email: user.email, tenantSlug: null, expiresAt: Date.now() + ADMIN_TTL_MS });
  for (const [t, s] of adminSessions) if (s.expiresAt < Date.now()) adminSessions.delete(t);
  res.setHeader("Set-Cookie", `bd_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_TTL_MS / 1000}`);
  res.json({ ok: true, email: user.email });
}

export function adminLogout(req: Request, res: Response) {
  adminSessions.delete(adminToken(req));
  res.setHeader("Set-Cookie", "bd_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
}

export function adminChangePassword(req: Request, res: Response) {
  const session = adminSession(req);
  if (!session) return res.status(401).json({ error: "auth_required" });
  const pw = String(req.body?.password ?? "");
  if (pw.length < 12) return res.status(400).json({ error: "Password must be at least 12 characters" });
  platformDb.prepare("UPDATE platform_users SET password_hash = ? WHERE email = ?").run(hashPassword(pw), session.email);
  res.json({ ok: true });
}

export function setAdminTenant(req: Request, slug: string | null) {
  const s = adminSessions.get(adminToken(req));
  if (s) s.tenantSlug = slug;
}

export function requireSuperadmin(req: Request, res: Response, next: NextFunction) {
  if (!adminSession(req)) return res.status(401).json({ error: "auth_required" });
  next();
}

/** Request middleware: pick the tenant DB for this request.
 *  Priority: super-admin's selected tenant → x-tenant header / ?t= (public
 *  surfaces like signing links) → default tenant. */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  const fromAdmin = adminSession(req)?.tenantSlug;
  const fromHeader = String(req.headers["x-tenant"] ?? "") || String(req.query.t ?? "");
  const slug = fromAdmin || fromHeader || DEFAULT_TENANT_SLUG;
  if (slug === DEFAULT_TENANT_SLUG) return tenantALS.run({ slug, db: openTenantDb(slug)! }, next);
  const d = openTenantDb(slug);
  if (!d) return res.status(404).json({ error: `Unknown or inactive tenant '${slug}'` });
  tenantALS.run({ slug, db: d }, next);
}
