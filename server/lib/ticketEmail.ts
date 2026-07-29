import { db, now } from "../db.js";
import { sendMail } from "./mailer.js";
import { renderDocumentPdf } from "./printing.js";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatSession(from: string, to: string): string {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return `${from} – ${to}`;

  const date = new Intl.DateTimeFormat("en-CA", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(start);
  const endTime = new Intl.DateTimeFormat("en-CA", { timeStyle: "short" }).format(end);
  return `${date} – ${endTime}`;
}

export async function sendClassTicketEmail(bookingId: string): Promise<void> {
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as any;
  if (!booking || !String(booking.customer_email || "").trim()) return;
  if (booking.status !== "PAID") return;
  if (booking.ticket_emailed_at) return;

  const lines = db.prepare("SELECT * FROM booking_lines WHERE booking_id = ?").all(bookingId) as any[];
  const courseLines = lines.filter((line) => line.type === "COURSE");
  if (!courseLines.length) return;
  const session = courseLines
    .map((line) => line.session_id
      ? db.prepare("SELECT meeting_url FROM sessions WHERE id=?").get(line.session_id) as { meeting_url: string } | undefined
      : undefined)
    .find((candidate) => candidate?.meeting_url);
  const meetingUrl = session?.meeting_url || "";

  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await renderDocumentPdf(`/print/ticket/${bookingId}`);
  } catch (err) {
    console.warn(`[ticketEmail] Failed to render ticket PDF for ${bookingId}:`, err);
  }

  const store = booking.store_id
    ? db.prepare("SELECT name FROM stores WHERE id = ?").get(booking.store_id) as { name: string } | undefined
    : undefined;
  const sessions = courseLines.map((line) => ({
    name: line.product_name || line.product_no || "Class",
    when: formatSession(line.date_from, line.date_to),
  }));
  const paidAmount = Number(booking.pos_total ?? booking.total ?? 0).toLocaleString("en-CA", {
    style: "currency",
    currency: booking.currency || "CAD",
  });
  const subject = `Your class ticket — ${booking.ref}`;
  const sessionText = sessions.map((session) => `${session.name}: ${session.when}`).join("\n");
  const storeText = store?.name ? `\nStore: ${store.name}` : "";
  const text = `Your class ticket

Booking reference: ${booking.ref}
${sessionText}${storeText}${meetingUrl ? `\nJoin online: ${meetingUrl}` : ""}
Total paid: ${paidAmount}

Your ticket is attached — show it at check-in.`;
  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f4f4f4;font-family:Arial,sans-serif;color:#222">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border-radius:8px;padding:32px">
      <h1 style="font-size:24px;margin:0 0 24px">Your class ticket</h1>
      <p><strong>Booking reference:</strong> ${escapeHtml(booking.ref)}</p>
      <h2 style="font-size:18px;margin:24px 0 12px">Your classes</h2>
      <ul style="padding-left:20px">
        ${sessions.map((session) => `<li style="margin-bottom:10px"><strong>${escapeHtml(session.name)}</strong><br>${escapeHtml(session.when)}</li>`).join("")}
      </ul>
      ${store?.name ? `<p><strong>Store:</strong> ${escapeHtml(store.name)}</p>` : ""}
      ${meetingUrl ? `<p><strong>Join online:</strong> <a href="${escapeHtml(meetingUrl)}">${escapeHtml(meetingUrl)}</a></p>` : ""}
      <p><strong>Total paid:</strong> ${escapeHtml(paidAmount)}</p>
      <p style="margin-top:24px">Your ticket is attached — show it at check-in.</p>
    </div>
  </div>
</body>
</html>`;
  const attachments = pdfBuffer
    ? [{ filename: `ticket-${booking.ref}.pdf`, content: pdfBuffer }]
    : undefined;

  const sent = await sendMail({
    to: booking.customer_email,
    subject,
    text,
    html,
    attachments,
  });
  if (sent) {
    db.prepare("UPDATE bookings SET ticket_emailed_at = ? WHERE id = ?").run(now(), bookingId);
  }
}
