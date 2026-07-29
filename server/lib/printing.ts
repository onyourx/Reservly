import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tokens = new Map<string, number>();

export async function listPrinters(): Promise<{
  printers: { id: string; name: string }[];
  defaultPrinter: string | null;
}> {
  try {
    const [{ stdout: queues }, { stdout: defaultOutput }] = await Promise.all([
      execFileAsync("lpstat", ["-a"], { timeout: 5_000 }),
      execFileAsync("lpstat", ["-d"], { timeout: 5_000 }),
    ]);
    const printers = queues
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean)
      .map((id) => ({ id, name: id.replace(/_/g, " ") }));
    const match = defaultOutput.match(/system default destination:\s*(\S+)/i);
    return { printers, defaultPrinter: match?.[1] ?? null };
  } catch {
    return { printers: [], defaultPrinter: null };
  }
}

export function issuePrintToken(): string {
  const token = crypto.randomBytes(24).toString("base64url");
  tokens.set(token, Date.now() + 60_000);
  const timer = setTimeout(() => tokens.delete(token), 60_000);
  timer.unref();
  return token;
}

export function consumePrintToken(t: string): boolean {
  try {
    const expiresAt = tokens.get(t);
    if (expiresAt === undefined || expiresAt <= Date.now()) {
      if (expiresAt !== undefined) tokens.delete(t);
      return false;
    }
    tokens.delete(t);
    return true;
  } catch {
    return false;
  }
}

export async function renderDocumentPdf(docPath: string): Promise<Buffer> {
  const tmpfile = path.join(os.tmpdir(), `print-${crypto.randomBytes(12).toString("hex")}.pdf`);
  const separator = docPath.includes("?") ? "&" : "?";
  const port = process.env.PORT || "4646";
  const url = `http://127.0.0.1:${port}${docPath}${separator}ptoken=${issuePrintToken()}&bare=1`;
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

  try {
    try {
      await execFileAsync(chrome, [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        `--print-to-pdf=${tmpfile}`,
        url,
      ], { timeout: 30_000 });
    } catch (err) {
      throw new Error(`Failed to render print document: ${(err as Error).message}`);
    }

    return await readFile(tmpfile);
  } finally {
    await unlink(tmpfile).catch(() => undefined);
  }
}

export async function printDocument(docPath: string, printerId: string): Promise<string> {
  const { printers } = await listPrinters();
  if (!printers.some((printer) => printer.id === printerId)) {
    throw Object.assign(new Error(`Unknown printer: ${printerId}`), { status: 400 });
  }

  const tmpfile = path.join(os.tmpdir(), `print-${crypto.randomBytes(12).toString("hex")}.pdf`);

  try {
    await writeFile(tmpfile, await renderDocumentPdf(docPath));

    try {
      const { stdout } = await execFileAsync("lp", ["-d", printerId, tmpfile]);
      return stdout.match(/request id is\s+(\S+)/i)?.[1] ?? "sent";
    } catch (err) {
      throw new Error(`Failed to send document to printer ${printerId}: ${(err as Error).message}`);
    }
  } finally {
    await unlink(tmpfile).catch(() => undefined);
  }
}
