import crypto from "node:crypto";

export const STAFF_COOKIE = "bd_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one shift

export const PERM_KEYS = ["products", "bookings", "sessions", "reports", "availability"] as const;
export type Perms = Record<(typeof PERM_KEYS)[number], boolean>;
export const ALL_PERMS: Perms = {
  products: true,
  bookings: true,
  sessions: true,
  reports: true,
  availability: true,
};

export type StaffSession = {
  tenantSlug: string;
  expiresAt: number;
  userId: string | null;
  username: string | null;
  role: "legacy" | "owner" | "member";
  perms: Perms;
  storeIds: "*" | string[];
};

type StaffSessionUser = {
  id: string;
  username: string;
  role: "owner" | "member";
  perms: Perms;
  storeIds: "*" | string[];
};

const staffSessions = new Map<string, StaffSession>();

export function staffTokenOf(req: { headers: { cookie?: string | string[] } }): string {
  const m = /(?:^|;\s*)bd_session=([^;]+)/.exec(String(req.headers.cookie ?? ""));
  return m?.[1] ?? "";
}

export function createStaffSession(tenantSlug: string, user?: StaffSessionUser): string {
  const token = crypto.randomBytes(24).toString("base64url");
  const currentTime = Date.now();
  staffSessions.set(token, {
    tenantSlug,
    expiresAt: currentTime + SESSION_TTL_MS,
    userId: user?.id ?? null,
    username: user?.username ?? null,
    role: user?.role ?? "legacy",
    perms: user?.perms ?? ALL_PERMS,
    storeIds: user?.storeIds ?? "*",
  });
  for (const [sessionToken, session] of staffSessions) {
    if (session.expiresAt < currentTime) staffSessions.delete(sessionToken);
  }
  return token;
}

export function getStaffSession(token: string): StaffSession | null {
  const session = staffSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    staffSessions.delete(token);
    return null;
  }
  return session;
}

export function deleteStaffSession(token: string): void {
  staffSessions.delete(token);
}

export function clearStaffSessionsForTenant(slug: string): void {
  for (const [token, session] of staffSessions) {
    if (session.tenantSlug === slug) staffSessions.delete(token);
  }
}

export function clearStaffSessionsForUser(tenantSlug: string, userId: string): void {
  for (const [token, session] of staffSessions) {
    if (session.tenantSlug === tenantSlug && session.userId === userId) staffSessions.delete(token);
  }
}
