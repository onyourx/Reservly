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
import { getStaffSession, staffTokenOf } from "./staffSessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.BOOKING_DATA_DIR || path.join(__dirname, "..", "..");
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
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);

// Migrate existing databases: add domain column if not present
const tenantCols = platformDb.prepare("PRAGMA table_info(tenants)").all() as { name: string }[];
if (!tenantCols.some((c) => c.name === "domain")) {
  platformDb.exec("ALTER TABLE tenants ADD COLUMN domain TEXT NOT NULL DEFAULT ''");
}
platformDb.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_domain_unique ON tenants(domain) WHERE domain != ''");

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

export interface TenantRow { id: string; slug: string; name: string; db_file: string; active: number; created_at: string; domain: string }

export const listTenants = () => platformDb.prepare("SELECT * FROM tenants ORDER BY created_at").all() as TenantRow[];
export const getTenant = (slug: string) => platformDb.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug) as TenantRow | undefined;

/** Bare lowercase hostname: no port, no trailing dot. */
export const normalizeHost = (value: string) =>
  String(value ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** Normalised bare hostname, or "" to clear. Throws on anything else. */
export function validateDomain(value: string): string {
  const host = normalizeHost(value);
  if (host && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error("Domain must be a bare hostname, e.g. bookings.example.com");
  }
  return host;
}

export const tenantByDomain = (host: string) =>
  host ? platformDb.prepare("SELECT * FROM tenants WHERE domain = ?").get(host) as TenantRow | undefined : undefined;

/** Host routing only starts enforcing once at least one tenant has a domain,
 *  so single-host deployments keep working unchanged. */
const domainRoutingActive = () =>
  Boolean(platformDb.prepare("SELECT 1 FROM tenants WHERE domain != '' LIMIT 1").get());

/** Hosts that serve the platform itself rather than one tenant: the
 *  PUBLIC_URL host and loopback (dev, health checks, server-side calls). */
const isPlatformHost = (host: string) => {
  if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  try {
    return Boolean(process.env.PUBLIC_URL) && normalizeHost(new URL(process.env.PUBLIC_URL as string).host) === host;
  } catch {
    return false;
  }
};

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

export function createTenant(slug: string, name: string, domain = ""): TenantRow {
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) throw new Error("Slug must be lowercase letters/digits/dashes");
  if (getTenant(slug)) throw new Error(`Tenant '${slug}' already exists`);
  platformDb.prepare("INSERT INTO tenants (id, slug, name, db_file, active, created_at, domain) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .run(uid(), slug, name || slug, `booking-${slug}.db`, now(), validateDomain(domain));
  openTenantDb(slug); // create the file + schema right away
  return getTenant(slug)!;
}

// --- Super-admin sessions ------------------------------------------------------

const adminSessions = new Map<string, { email: string; tenantSlug: string | null; expiresAt: number }>();
const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const resetRateLimit = new Map<string, number>(); // email -> last request epoch ms

function adminToken(req: Request): string {
  const m = /(?:^|;\s*)bd_admin=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m?.[1] ?? "";
}

export function adminSession(req: Request) {
  const s = adminSessions.get(adminToken(req));
  return s && s.expiresAt > Date.now() ? s : null;
}

export function verifyPlatformLogin(email: string, pw: string): any {
  const user = platformDb.prepare("SELECT * FROM platform_users WHERE email = ?").get(email.toLowerCase().trim()) as any;
  return user && verifyPassword(pw, user.password_hash) ? user : null;
}

export function issueAdminSession(res: Response, email: string): void {
  const token = crypto.randomBytes(24).toString("base64url");
  adminSessions.set(token, { email, tenantSlug: null, expiresAt: Date.now() + ADMIN_TTL_MS });
  for (const [t, s] of adminSessions) if (s.expiresAt < Date.now()) adminSessions.delete(t);
  res.setHeader("Set-Cookie", `bd_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ADMIN_TTL_MS / 1000}`);
}

export function adminLogin(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  const user = verifyPlatformLogin(String(email ?? ""), String(password ?? ""));
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  issueAdminSession(res, user.email);
  res.json({ ok: true, email: user.email });
}

export function adminLogout(req: Request, res: Response) {
  adminSessions.delete(adminToken(req));
  res.setHeader("Set-Cookie", "bd_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
}

export function createPasswordReset(email: string): string | null {
  // Normalize email
  email = email.trim().toLowerCase();

  // Check if user exists
  const user = platformDb.prepare("SELECT * FROM platform_users WHERE email = ?").get(email) as any;
  if (!user) return null;

  // Rate limit: 60s minimum between requests
  const nowEpoch = Date.now();
  const lastRequest = resetRateLimit.get(email);
  if (lastRequest && nowEpoch - lastRequest < 60 * 1000) return null;

  // Update rate limit map
  resetRateLimit.set(email, nowEpoch);

  // Delete previous unused tokens
  platformDb.prepare("DELETE FROM password_resets WHERE email = ? AND used = 0").run(email);

  // Generate token
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  // Store token
  platformDb.prepare(
    "INSERT INTO password_resets (token_hash, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)"
  ).run(tokenHash, email, nowEpoch + RESET_TTL_MS, now());

  return token;
}

export function consumePasswordReset(
  token: string,
  newPassword: string
): { ok: true; email: string } | { ok: false; error: string } {
  // Validate password length
  if (newPassword.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters" };
  }

  // Check token
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const reset = platformDb.prepare(
    "SELECT * FROM password_resets WHERE token_hash = ?"
  ).get(tokenHash) as any;

  if (!reset || reset.used || reset.expires_at < Date.now()) {
    return { ok: false, error: "Reset link is invalid or has expired" };
  }

  // Update password
  platformDb.prepare("UPDATE platform_users SET password_hash = ? WHERE email = ?")
    .run(hashPassword(newPassword), reset.email);

  // Mark token as used
  platformDb.prepare("UPDATE password_resets SET used = 1 WHERE token_hash = ?").run(tokenHash);

  // Force logout all sessions for this email
  for (const [token, session] of adminSessions) {
    if (session.email === reset.email) {
      adminSessions.delete(token);
    }
  }

  return { ok: true, email: reset.email };
}

export function adminChangePassword(req: Request, res: Response) {
  const session = adminSession(req);
  if (!session) return res.status(401).json({ error: "auth_required" });
  const pw = String(req.body?.password ?? "");
  if (pw.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
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

/** Request middleware: pick the tenant DB for this request. */
export function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  const adminTenant = adminSession(req)?.tenantSlug;
  if (adminTenant) {
    // super admin has selected a specific tenant
    const d = openTenantDb(adminTenant);
    if (!d) return res.status(404).json({ error: `Unknown or inactive tenant '${adminTenant}'` });
    return tenantALS.run({ slug: adminTenant, db: d }, next);
  }

  const host = normalizeHost(String(req.headers.host ?? ""));
  const byDomain = tenantByDomain(host);
  if (byDomain && byDomain.active) {
    const d = openTenantDb(byDomain.slug);
    if (!d) return res.status(404).json({ error: `Unknown or inactive tenant '${byDomain.slug}'` });
    return tenantALS.run({ slug: byDomain.slug, db: d }, next);
  }
  // Fail closed: once any tenant owns a domain, an unrecognised host must not
  // silently fall through to the default tenant.
  if (domainRoutingActive() && host && !isPlatformHost(host)) {
    return res.status(404).json({ error: "Unknown host" });
  }

  const staffSession = getStaffSession(staffTokenOf(req));
  const staffTenant = staffSession && staffSession.expiresAt > Date.now() ? staffSession.tenantSlug : null;
  if (staffTenant) {
    const d = openTenantDb(staffTenant);
    if (d) return tenantALS.run({ slug: staffTenant, db: d }, next);
    // staff session references unknown/inactive tenant: fall through to default
  }

  const fromHeader = String(req.headers["x-tenant"] ?? "") || String(req.query.t ?? "");
  if (fromHeader) {
    const d = openTenantDb(fromHeader);
    if (!d) return res.status(404).json({ error: `Unknown or inactive tenant '${fromHeader}'` });
    return tenantALS.run({ slug: fromHeader, db: d }, next);
  }

  return tenantALS.run({ slug: DEFAULT_TENANT_SLUG, db: openTenantDb(DEFAULT_TENANT_SLUG)! }, next);
}
