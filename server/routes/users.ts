import { Router } from "express";
import { auditLog, currentTenant, db, now, uid } from "../db.js";
import {
  hashPassword,
  requireOwner,
  staffAccess,
  type Perms,
} from "../lib/auth.js";
import {
  clearStaffSessionsForUser,
  PERM_KEYS,
} from "../lib/staffSessions.js";

export const usersRouter = Router();

type StaffUserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: string;
  perms: string;
  store_ids: string;
  active: number;
  created_at: string;
  updated_at: string;
};

const noPerms = (): Perms =>
  Object.fromEntries(PERM_KEYS.map((key) => [key, false])) as Perms;

function cleanPerms(value: unknown): Perms {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(PERM_KEYS.map((key) => [key, source[key] === true])) as Perms;
}

function parsePerms(value: string): Perms {
  try {
    return cleanPerms(JSON.parse(value));
  } catch {
    return noPerms();
  }
}

function parseStoreIds(value: string): "*" | string[] {
  if (value === "*") return "*";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : "*";
  } catch {
    return "*";
  }
}

function serializeUser(row: StaffUserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role === "owner" ? "owner" : "member",
    perms: parsePerms(row.perms),
    storeIds: parseStoreIds(row.store_ids),
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateStoreIds(value: unknown): { value: "*" | string[]; error?: string } {
  if (value === "*") return { value: "*" };
  if (!Array.isArray(value)) return { value: [], error: "storeIds must be '*' or an array" };
  const ids = [...new Set(value.map(String))];
  for (const id of ids) {
    if (!db.prepare("SELECT 1 FROM stores WHERE id=?").get(id)) {
      return { value: [], error: `Unknown store id: ${id}` };
    }
  }
  return { value: ids };
}

usersRouter.get("/users", requireOwner, (_req, res) => {
  const rows = db.prepare("SELECT * FROM staff_users ORDER BY username").all() as StaffUserRow[];
  res.json({ users: rows.map(serializeUser) });
});

usersRouter.post("/users", requireOwner, (req, res) => {
  const username = String(req.body?.username ?? "").trim().toLowerCase();
  const displayName = String(req.body?.displayName ?? "");
  const password = String(req.body?.password ?? "");
  const role = req.body?.role == null ? "member" : String(req.body.role);
  if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(username) || username.length > 254) {
    return res.status(400).json({ error: "invalid_username" });
  }
  if (password.length < 8) return res.status(400).json({ error: "password_too_short" });
  if (!["owner", "member"].includes(role)) return res.status(400).json({ error: "invalid_role" });
  if (db.prepare("SELECT 1 FROM staff_users WHERE username=? COLLATE NOCASE").get(username)) {
    return res.status(409).json({ error: "username_exists" });
  }
  const stores = validateStoreIds(req.body?.storeIds ?? "*");
  if (stores.error) return res.status(400).json({ error: stores.error });
  const id = uid();
  const timestamp = now();
  db.prepare(`INSERT INTO staff_users
    (id,username,display_name,password_hash,role,perms,store_ids,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, username, displayName, hashPassword(password), role,
      JSON.stringify(cleanPerms(req.body?.perms)), stores.value === "*" ? "*" : JSON.stringify(stores.value),
      1, timestamp, timestamp);
  auditLog("user.created", username);
  const created = db.prepare("SELECT * FROM staff_users WHERE id=?").get(id) as StaffUserRow;
  return res.status(201).json({ user: serializeUser(created) });
});

usersRouter.put("/users/:id", requireOwner, (req, res) => {
  const existing = db.prepare("SELECT * FROM staff_users WHERE id=?").get(req.params.id) as StaffUserRow | undefined;
  if (!existing) return res.status(404).json({ error: "not_found" });

  const role = req.body?.role == null ? existing.role : String(req.body.role);
  if (!["owner", "member"].includes(role)) return res.status(400).json({ error: "invalid_role" });
  const active = req.body?.active == null ? !!existing.active : req.body.active === true;
  const access = staffAccess(req);
  if (access?.userId === existing.id && (role !== "owner" || !active)) {
    return res.status(400).json({ error: "cannot_lock_self_out" });
  }

  const passwordChanged = Object.prototype.hasOwnProperty.call(req.body ?? {}, "password");
  const password = passwordChanged ? String(req.body.password ?? "") : "";
  if (passwordChanged && password.length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }

  let storeIds = existing.store_ids;
  if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "storeIds")) {
    const stores = validateStoreIds(req.body.storeIds);
    if (stores.error) return res.status(400).json({ error: stores.error });
    storeIds = stores.value === "*" ? "*" : JSON.stringify(stores.value);
  }

  const displayName = req.body?.displayName == null ? existing.display_name : String(req.body.displayName);
  const perms = req.body?.perms == null ? existing.perms : JSON.stringify(cleanPerms(req.body.perms));
  const passwordHash = passwordChanged ? hashPassword(password) : existing.password_hash;
  db.prepare(`UPDATE staff_users SET display_name=?,password_hash=?,role=?,perms=?,store_ids=?,
    active=?,updated_at=? WHERE id=?`)
    .run(displayName, passwordHash, role, perms, storeIds, active ? 1 : 0, now(), existing.id);

  const roleDowngrade = existing.role === "owner" && role === "member";
  if (passwordChanged || !active || roleDowngrade) {
    clearStaffSessionsForUser(currentTenant().slug, existing.id);
  }
  auditLog("user.updated", existing.username);
  const updated = db.prepare("SELECT * FROM staff_users WHERE id=?").get(existing.id) as StaffUserRow;
  return res.json({ user: serializeUser(updated) });
});

usersRouter.delete("/users/:id", requireOwner, (req, res) => {
  const existing = db.prepare("SELECT * FROM staff_users WHERE id=?").get(req.params.id) as StaffUserRow | undefined;
  if (!existing) return res.status(404).json({ error: "not_found" });
  if (staffAccess(req)?.userId === existing.id) {
    return res.status(400).json({ error: "cannot_lock_self_out" });
  }
  db.prepare("DELETE FROM staff_users WHERE id=?").run(existing.id);
  clearStaffSessionsForUser(currentTenant().slug, existing.id);
  auditLog("user.deleted", existing.username);
  return res.json({ ok: true });
});
