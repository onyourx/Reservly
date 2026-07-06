// Staff access control (privacy declarations: "limit staff access", "strong
// password requirements", "log access"). Single shared staff credential for v1:
// when an admin password is set, /api and /print require a session cookie.
// When none is set (fresh dev install) the app stays open and Health shows it.
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db, getSettings, auditLog, now } from "../db.js";
import { adminSession } from "./platform.js";

const MIN_PASSWORD_LENGTH = 12;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one shift
const COOKIE = "bd_session";

const sessions = new Map<string, number>(); // token -> expiresAt (epoch ms)

function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}

function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(pw, salt, 32);
  try {
    return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

export function setAdminPassword(pw: string) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Admin password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('adminPasswordHash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(hashPassword(pw));
  sessions.clear(); // force re-login everywhere on rotation
  auditLog("password.changed");
}

export const authRequired = () => Boolean(getSettings().adminPasswordHash);

function tokenOf(req: Request): string {
  const cookies = String(req.headers.cookie ?? "");
  const m = /(?:^|;\s*)bd_session=([^;]+)/.exec(cookies);
  return m?.[1] ?? "";
}

export function isAuthenticated(req: Request): boolean {
  if (adminSession(req)) return true; // platform super admin passes every tenant gate
  if (!authRequired()) return true;
  const expires = sessions.get(tokenOf(req));
  return Boolean(expires && expires > Date.now());
}

export function login(req: Request, res: Response) {
  const pw = String(req.body?.password ?? "");
  if (!authRequired()) return res.json({ ok: true, required: false });
  if (!verifyPassword(pw, getSettings().adminPasswordHash)) {
    auditLog("login_failed", "", req.ip ?? "", "anonymous");
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = crypto.randomBytes(24).toString("base64url");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  // prune expired sessions opportunistically
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
  auditLog("login", "", req.ip ?? "");
  res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
}

export function logout(req: Request, res: Response) {
  sessions.delete(tokenOf(req));
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
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
