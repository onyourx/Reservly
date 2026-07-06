// Super-admin API: tenant registry management + "operate as tenant".
// All endpoints (except login) require a platform super-admin session.
import { Router } from "express";
import {
  platformDb, listTenants, getTenant, createTenant, openTenantDb,
  adminLogin, adminLogout, adminChangePassword, adminSession, setAdminTenant, requireSuperadmin,
} from "../lib/platform.js";
import { now } from "../db.js";

export const adminRouter = Router();

adminRouter.post("/login", adminLogin);
adminRouter.post("/logout", adminLogout);

adminRouter.get("/me", (req, res) => {
  const s = adminSession(req);
  if (!s) return res.status(401).json({ error: "auth_required" });
  res.json({ email: s.email, tenant: s.tenantSlug });
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
    return { id: t.id, slug: t.slug, name: t.name, active: !!t.active, createdAt: t.created_at, stats };
  });
  res.json({ tenants });
});

adminRouter.post("/tenants", (req, res) => {
  try {
    const { slug, name } = req.body ?? {};
    const t = createTenant(String(slug ?? "").trim(), String(name ?? "").trim());
    res.json({ tenant: { id: t.id, slug: t.slug, name: t.name, active: true, createdAt: t.created_at } });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

adminRouter.put("/tenants/:slug", (req, res) => {
  const t = getTenant(req.params.slug);
  if (!t) return res.status(404).json({ error: "Tenant not found" });
  const { name, active } = req.body ?? {};
  platformDb.prepare("UPDATE tenants SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE slug = ?")
    .run(name ?? null, active == null ? null : active ? 1 : 0, t.slug);
  res.json({ tenant: { ...getTenant(t.slug)!, active: !!getTenant(t.slug)!.active } });
});

/** Operate the whole Booking Desk as this tenant (session-scoped). */
adminRouter.post("/use-tenant", (req, res) => {
  const slug = req.body?.slug == null ? null : String(req.body.slug);
  if (slug && !getTenant(slug)) return res.status(404).json({ error: "Tenant not found" });
  setAdminTenant(req, slug);
  res.json({ ok: true, tenant: slug, at: now() });
});
