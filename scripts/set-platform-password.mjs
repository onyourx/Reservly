#!/usr/bin/env node
// Reset the platform super-admin password (local server access = platform trust).
// Usage: node scripts/set-platform-password.mjs 'new-password-min-8-chars'
import Database from "better-sqlite3";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error("Usage: node scripts/set-platform-password.mjs '<password, min 8 chars>'");
  process.exit(1);
}
const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.BOOKING_DATA_DIR || path.join(dir, "..");
const db = new Database(path.join(dataDir, "platform.db"));
const salt = crypto.randomBytes(16).toString("hex");
const hash = salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
const info = db.prepare("UPDATE platform_users SET password_hash = ? WHERE role = 'superadmin'").run(hash);
console.log(info.changes ? "Super-admin password updated." : "No super-admin user found — boot the server once first.");
