import path from "node:path";
import SftpClient from "ssh2-sftp-client";
import { getSettings, now, putSettings } from "../db.js";
import { decryptBinary, encryptBinary } from "./crypto.js";

const MAX_HEADER_BYTES = 4096;

export function encryptPasswordForSftp(password: string): string {
  const encrypted = encryptBinary(Buffer.from(password, "utf8"));
  return [encrypted.iv, encrypted.authTag, encrypted.encrypted].join(".");
}

function decryptPasswordForSftp(stored: string): string {
  const [iv, authTag, encrypted] = stored.split(".");
  if (!iv || !authTag || encrypted === undefined) throw new Error("Invalid encrypted SFTP password");
  return decryptBinary(encrypted, iv, authTag).toString("utf8");
}

function settings() {
  const value = getSettings();
  if (value.sftpPassword && !value.sftpPasswordEnc) {
    value.sftpPasswordEnc = encryptPasswordForSftp(value.sftpPassword);
    putSettings({ sftpPassword: "", sftpPasswordEnc: value.sftpPasswordEnc });
    value.sftpPassword = "";
  }
  return value;
}

export function sftpConfigured(): boolean {
  const value = settings();
  return Boolean(value.sftpHost.trim() && value.sftpUser.trim() && value.sftpPasswordEnc);
}

export async function getSftpClient(): Promise<SftpClient> {
  const value = settings();
  if (!value.sftpHost.trim() || !value.sftpUser.trim() || !value.sftpPasswordEnc) {
    throw new Error("sftp_not_configured");
  }
  const port = Number(value.sftpPort || "22");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SFTP port");
  const client = new SftpClient();
  try {
    await client.connect({
      host: value.sftpHost.trim(),
      port,
      username: value.sftpUser.trim(),
      password: decryptPasswordForSftp(value.sftpPasswordEnc),
      readyTimeout: 10_000,
    });
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

function remotePath(remoteName: string): string {
  const base = settings().sftpPath.trim() || "/reservly-ids";
  return path.posix.join(base, path.posix.basename(remoteName));
}

export async function uploadIdPhoto(bookingRef: string, imageBuffer: Buffer, mime: string): Promise<string> {
  const header = Buffer.from(JSON.stringify({ mime }), "utf8");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(header.length);
  const encrypted = encryptBinary(imageBuffer);
  const encryptedImage = Buffer.concat([
    Buffer.from(encrypted.iv, "base64"),
    Buffer.from(encrypted.authTag, "base64"),
    Buffer.from(encrypted.encrypted, "base64"),
  ]);
  const envelope = Buffer.concat([prefix, header, encryptedImage]);
  const safeRef = bookingRef.replace(/[^a-zA-Z0-9_-]/g, "_");
  const remoteName = `${safeRef}-${now().replace(/[^0-9]/g, "")}.bin`;
  const client = await getSftpClient();
  try {
    const base = settings().sftpPath.trim() || "/reservly-ids";
    await client.mkdir(base, true);
    await client.put(envelope, remotePath(remoteName));
    return remoteName;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function fetchIdPhoto(remoteName: string): Promise<{ buffer: Buffer; mime: string }> {
  const client = await getSftpClient();
  try {
    const downloaded = await client.get(remotePath(remoteName));
    const envelope = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
    if (envelope.length < 5) throw new Error("Invalid ID photo envelope");
    const headerLength = envelope.readUInt32BE(0);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || 4 + headerLength >= envelope.length) {
      throw new Error("Invalid ID photo envelope");
    }
    const header = JSON.parse(envelope.subarray(4, 4 + headerLength).toString("utf8")) as { mime?: unknown };
    if (typeof header.mime !== "string" || !/^image\/(jpeg|png|webp)$/.test(header.mime)) {
      throw new Error("Invalid ID photo mime type");
    }
    const encryptedImage = envelope.subarray(4 + headerLength);
    if (encryptedImage.length < 28) throw new Error("Invalid ID photo envelope");
    return {
      buffer: decryptBinary(
        encryptedImage.subarray(28).toString("base64"),
        encryptedImage.subarray(0, 12).toString("base64"),
        encryptedImage.subarray(12, 28).toString("base64"),
      ),
      mime: header.mime,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function deleteIdPhoto(remoteName: string): Promise<void> {
  const client = await getSftpClient();
  try {
    await client.delete(remotePath(remoteName));
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function testSftp(): Promise<{ ok: boolean; error?: string }> {
  if (!sftpConfigured()) return { ok: false, error: "sftp_not_configured" };
  let client: SftpClient | undefined;
  try {
    client = await getSftpClient();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.end().catch(() => undefined);
  }
}
