// Super-admin API: tenant registry management + "operate as tenant".
// All endpoints (except login) require a platform super-admin session.
import { Router } from "express";
import {
  platformDb, listTenants, getTenant, createTenant, openTenantDb, validateDomain,
  adminLogin, adminLogout, adminChangePassword, adminSession, setAdminTenant, requireSuperadmin,
  createPasswordReset, consumePasswordReset,
} from "../lib/platform.js";
import { now, auditLog } from "../db.js";
import { sendMail } from "../lib/mailer.js";

export const adminRouter = Router();

adminRouter.post("/login", adminLogin);
adminRouter.post("/logout", adminLogout);

adminRouter.get("/me", (req, res) => {
  const s = adminSession(req);
  if (!s) return res.status(401).json({ error: "auth_required" });
  res.json({ email: s.email, tenant: s.tenantSlug });
});

adminRouter.post("/forgot-password", async (req, res) => {
  const email = String(req.body?.username ?? "").trim().toLowerCase();
  const token = email ? createPasswordReset(email) : null;

  if (token) {
    let link = "";
    try {
      const parsed = new URL(String(process.env.PUBLIC_URL ?? ""));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const origin = `${parsed.protocol}//${parsed.host}`;
        link = `${origin}/reset-password?token=${token}`;
      }
    } catch {
      /* unset or unparseable — handled below */
    }
    if (!link) {
      console.error("[platform] password reset requested but PUBLIC_URL is unset or not a valid absolute http(s) URL — no reset email sent");
    } else {
      const text = `Someone requested a password reset for your Bagsy platform account.\n\nReset your password (valid for 30 minutes):\n${link}\n\nIf you didn't request this, ignore this email.`;
      const html = `<p>Someone requested a password reset for your Bagsy platform account.</p>\n<p><a href="${link}">Reset your password</a> (valid for 30 minutes)</p>\n<p>If you didn't request this, ignore this email.</p>`;
      void sendMail({ to: email, subject: "Bagsy — password reset", text, html });
    }
    auditLog("password.reset_requested", "", req.ip ?? "", email);
  }

  res.json({ ok: true });
});

adminRouter.post("/reset-password", (req, res) => {
  const { token, password } = req.body ?? {};
  const result = consumePasswordReset(String(token ?? ""), String(password ?? ""));

  if (result.ok) {
    auditLog("password.reset_completed", "", req.ip ?? "", result.email);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: result.error });
  }
});

adminRouter.use(requireSuperadmin);

adminRouter.post("/change-password", adminChangePassword);

/** All tenants with headline stats (reads each tenant's own database). */
adminRouter.get("/tenants", (_req, res) => {
  const tenants = listTenants().map((t) => {
    let stats = { bookings: 0, revenue: 0, products: 0, upcoming: 0 };
    try {
      const d = openTenantDb(t.slug);
      if (d) {
        stats = {
          bookings: (d.prepare("SELECT COUNT(*) AS n FROM bookings").get() as any).n,
          revenue: (d.prepare("SELECT COALESCE(SUM(total),0) AS n FROM bookings WHERE status != 'CANCELLED'").get() as any).n,
          products: (d.prepare("SELECT COUNT(*) AS n FROM products").get() as any).n,
          upcoming: (d.prepare("SELECT COUNT(DISTINCT booking_id) AS n FROM booking_lines WHERE date(date_from) >= date('now')").get() as any).n,
        };
      }
    } catch {
      /* inactive tenants have no stats */
    }
    return { id: t.id, slug: t.slug, name: t.name, active: !!t.active, createdAt: t.created_at, domain: t.domain, stats };
  });
  res.json({ tenants });
});

adminRouter.post("/tenants", (req, res) => {
  try {
    const { slug, name, domain } = req.body ?? {};
    const t = createTenant(String(slug ?? "").trim(), String(name ?? "").trim(), String(domain ?? "").trim());
    res.json({ tenant: { id: t.id, slug: t.slug, name: t.name, active: true, createdAt: t.created_at, domain: t.domain } });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

adminRouter.put("/tenants/:slug", (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t) return res.status(404).json({ error: "Tenant not found" });
  const { name, active, domain } = req.body ?? {};
  platformDb.prepare("UPDATE tenants SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE slug = ?")
    .run(name ?? null, active == null ? null : active ? 1 : 0, t.slug);
  if (domain !== undefined) {
    let next: string;
    try {
      next = validateDomain(String(domain ?? ""));
    } catch (err) {
      return res.status(400).json({ error: String((err as Error).message ?? err) });
    }
    try {
      platformDb.prepare("UPDATE tenants SET domain = ? WHERE slug = ?").run(next, t.slug);
    } catch {
      return res.status(400).json({ error: `Domain '${next}' is already used by another tenant` });
    }
  }
  const updated = getTenant(t.slug)!;
  res.json({ tenant: { ...updated, active: !!updated.active } });
});

/** Operate the whole Booking Desk as this tenant (session-scoped). */
adminRouter.post("/use-tenant", (req, res) => {
  const slug = req.body?.slug == null ? null : String(req.body.slug);
  if (slug && !getTenant(slug)) return res.status(404).json({ error: "Tenant not found" });
  setAdminTenant(req, slug);
  res.json({ ok: true, tenant: slug, at: now() });
});
