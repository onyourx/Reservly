// Staff access control (privacy declarations: "limit staff access", "strong
// password requirements", "log access"). Single shared staff credential for v1:
// when an admin password is set, /api and /print require a session cookie.
// When none is set (fresh dev install) the app stays open and Health shows it.
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, auditLog, currentTenant } from "../db.js";
import {
  adminSession,
  getTenant,
  issueAdminSession,
  listTenants,
  openTenantDb,
  verifyPlatformLogin,
} from "./platform.js";
import {
  staffTokenOf,
  createStaffSession,
  getStaffSession,
  deleteStaffSession,
  STAFF_COOKIE,
  SESSION_TTL_MS,
  ALL_PERMS,
  PERM_KEYS,
} from "./staffSessions.js";
import type { Perms } from "./staffSessions.js";

export type { Perms } from "./staffSessions.js";
export type Access = {
  role: "superadmin" | "legacy" | "owner" | "member";
  perms: Perms;
  storeIds: "*" | string[];
  userId: string | null;
  username: string | null;
};


type StaffUserRow = {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  perms: string;
  store_ids: string;
};

function parseStaffSessionAttrs(row: StaffUserRow): {
  perms: Perms;
  storeIds: "*" | string[];
} {
  let perms: Perms = Object.fromEntries(PERM_KEYS.map((key) => [key, false])) as Perms;
  let storeIds: "*" | string[] = "*";
  try {
    const parsed = JSON.parse(row.perms) as Record<string, unknown>;
    perms = Object.fromEntries(PERM_KEYS.map((key) => [key, parsed[key] === true])) as Perms;
  } catch { /* default to no permissions */ }
  try {
    if (row.store_ids !== "*") {
      const parsed = JSON.parse(row.store_ids);
      storeIds = Array.isArray(parsed) ? parsed.map(String) : "*";
    }
  } catch { /* default to all stores */ }
  return { perms, storeIds };
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pw, salt, 32);
  try {
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

export const authRequired = () => Boolean(
  db.prepare("SELECT 1 FROM staff_users WHERE active=1 LIMIT 1").get(),
);

/** First-run open mode: every request gets owner access until the first staff
 *  user exists. Dev/test convenience only — never active in production, where
 *  first-run setup is done by the platform super-admin, whose session passes
 *  every tenant gate. */
export const bootstrapOpen = () => !authRequired() && process.env.NODE_ENV !== "production";

export function isAuthenticated(req: Request): boolean {
  if (adminSession(req)) return true; // platform super admin passes every tenant gate
  if (bootstrapOpen()) return true;
  const session = getStaffSession(staffTokenOf(req));
  return Boolean(
    session
    && session.expiresAt > Date.now()
    && session.tenantSlug === currentTenant().slug
  );
}

export function staffAccess(req: Request): Access | null {
  const admin = adminSession(req);
  if (admin) {
    return { role: "superadmin", perms: ALL_PERMS, storeIds: "*", userId: null, username: admin.email };
  }
  const session = getStaffSession(staffTokenOf(req));
  if (session && session.tenantSlug === currentTenant().slug) {
    return {
      role: session.role,
      perms: session.role === "owner" || session.role === "legacy" ? ALL_PERMS : session.perms,
      storeIds: session.storeIds,
      userId: session.userId,
      username: session.username,
    };
  }
  if (bootstrapOpen()) {
    return { role: "legacy", perms: ALL_PERMS, storeIds: "*", userId: null, username: null };
  }
  return null;
}

export function requirePerm(area: keyof Perms) {
  return (req: Request, res: Response, next: NextFunction) => {
    const access = staffAccess(req);
    if (access && access.perms[area]) return next();
    return res.status(access ? 403 : 401).json({ error: access ? "forbidden" : "auth_required" });
  };
}

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  const access = staffAccess(req);
  if (access && ["superadmin", "legacy", "owner"].includes(access.role)) return next();
  return res.status(access ? 403 : 401).json({ error: access ? "forbidden" : "auth_required" });
}

export function allowedStoreIds(req: Request): "*" | string[] {
  return staffAccess(req)?.storeIds ?? [];
}

export function login(req: Request, res: Response) {
  const username = String(req.body?.username ?? "").trim().toLowerCase();
  const pw = String(req.body?.password ?? "");

  // Path A: platform super-admin login (non-empty username)
  if (username) {
    const loginResult = verifyPlatformLogin(username, pw);
    if (loginResult) {
      issueAdminSession(res, username);
      auditLog("login", "", req.ip ?? "", username);
      return res.json({ ok: true, role: "superadmin" });
    }
    // Fall through to staff login paths if platform lookup fails
  }

  // Path B: email-only staff login
  if (username.includes("@") && !username.includes("/")) {
    const matches: { slug: string; row: StaffUserRow }[] = [];
    for (const tenant of listTenants().filter((t) => t.active === 1)) {
      const tenantDb = openTenantDb(tenant.slug);
      if (!tenantDb) continue;
      const row = tenantDb.prepare(
        "SELECT id, username, password_hash, role, perms, store_ids FROM staff_users WHERE username=? AND active=1",
      ).get(username) as StaffUserRow | undefined;
      if (row && verifyPassword(pw, row.password_hash)) {
        matches.push({ slug: tenant.slug, row });
      }
    }

    if (matches.length === 1) {
      const { slug, row } = matches[0];
      const { perms, storeIds } = parseStaffSessionAttrs(row);
      const token = createStaffSession(slug, {
        id: row.id,
        username: row.username,
        role: row.role === "owner" ? "owner" : "member",
        perms,
        storeIds,
      });
      res.setHeader("Set-Cookie", `${STAFF_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
      auditLog("login", "", req.ip ?? "", `${slug}/${row.username}`);
      return res.json({ ok: true, role: "staff", tenant: slug, username: row.username });
    }

    if (matches.length > 1) {
      return res.status(401).json({ error: "Your email exists in multiple workspaces — sign in as tenant/email" });
    }
  }

  // Path C: named tenant staff user (tenant/username)
  const staffParts = username.split("/");
  if (staffParts.length === 2 && staffParts[0] && staffParts[1]) {
    const [slug, staffUsername] = staffParts;
    const tenant = getTenant(slug);
    if (tenant?.active) {
      const tenantDb = openTenantDb(slug);
      if (tenantDb) {
        const row = tenantDb.prepare(
          "SELECT id, username, password_hash, role, perms, store_ids FROM staff_users WHERE username=? AND active=1",
        ).get(staffUsername) as StaffUserRow | undefined;
        if (row && verifyPassword(pw, row.password_hash)) {
          const { perms, storeIds } = parseStaffSessionAttrs(row);
          const token = createStaffSession(slug, {
            id: row.id,
            username: row.username,
            role: row.role === "owner" ? "owner" : "member",
            perms,
            storeIds,
          });
          res.setHeader("Set-Cookie", `${STAFF_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
          auditLog("login", "", req.ip ?? "", `${slug}/${staffUsername}`);
          return res.json({ ok: true, role: "staff", tenant: slug, username: staffUsername });
        }
      }
    }
  }

  // Authentication failed: do not reveal whether username exists
  if (username) {
    auditLog("login_failed", "", req.ip ?? "", username);
    return res.status(401).json({ error: "Invalid username or password" });
  }

  // Legacy behavior when username empty and auth not required
  if (bootstrapOpen()) {
    return res.json({ ok: true, required: false });
  }

  // Username empty and auth required: authentication failed
  auditLog("login_failed", "", req.ip ?? "", "");
  return res.status(401).json({ error: "Invalid username or password" });
}

export function logout(req: Request, res: Response) {
  deleteStaffSession(staffTokenOf(req));
  res.setHeader("Set-Cookie", `${STAFF_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
}

/** Gate for /api and /print. Health, auth status and login stay open. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthenticated(req)) return next();
  if (String(req.headers.accept ?? "").includes("text/html")) {
    return res.status(401).send("<h3>Booking Desk: sign in in the app first, then reload this page.</h3>");
  }
  res.status(401).json({ error: "auth_required" });
}
