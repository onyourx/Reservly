// Government-issued ID capture must be encrypted at rest (requirement R14).
// AES-256-GCM; key from BOOKING_ENC_KEY (64 hex chars) or derived from a dev passphrase.
import crypto from "node:crypto";

function key(): Buffer {
  const hex = process.env.BOOKING_ENC_KEY || "";
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  return crypto.scryptSync("booking-dev-only-key", "gosselin", 32);
}

export function encryptId(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const last4 = plain.replace(/[^a-zA-Z0-9]/g, "").slice(-4);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64"), last4].join(".");
}

/** Only the last 4 characters are ever shown back to staff. */
export function idLast4(stored: string): string {
  const parts = stored.split(".");
  return parts.length === 4 ? parts[3] : "";
}

export function decryptId(stored: string): string {
  const [ivB64, tagB64, dataB64] = stored.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
