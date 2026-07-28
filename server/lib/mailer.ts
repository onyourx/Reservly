import nodemailer from "nodemailer";

let transport: nodemailer.Transporter | null = null;

function getTransport(): nodemailer.Transporter | null {
  if (transport) return transport;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  transport = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  return transport;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const t = getTransport();
  if (!t) {
    console.log(`[mailer] SMTP not configured — mail to ${opts.to}: ${opts.subject}\n${opts.text}`);
    return false;
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    console.log(`[mailer] sent "${opts.subject}" to ${opts.to}`);
    return true;
  } catch (err) {
    console.error("[mailer] send failed:", err);
    return false;
  }
}
