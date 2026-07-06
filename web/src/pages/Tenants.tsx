import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { money } from "../format";
import { useToast } from "../components/Toast";
import { Field, Skeleton, Spinner } from "../components/ui";

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  createdAt: string;
  stats: { bookings: number; revenue: number; products: number; upcoming: number };
}

/** Platform super-admin console: sign in with the platform account
 *  (serge@onyourx.com), then view/edit every tenant or operate one directly. */
export function TenantsPage() {
  const toast = useToast();
  const [me, setMe] = useState<{ email: string; tenant: string | null } | null>(null);
  const [checking, setChecking] = useState(true);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(false);

  // login form
  const [email, setEmail] = useState("serge@onyourx.com");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

  // create form
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // password change
  const [newPw, setNewPw] = useState("");

  const loadMe = useCallback(() => {
    setChecking(true);
    api<{ email: string; tenant: string | null }>("/api/admin/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);
  useEffect(loadMe, [loadMe]);

  const loadTenants = useCallback(() => {
    setLoading(true);
    api<{ tenants: TenantRow[] }>("/api/admin/tenants")
      .then((d) => setTenants(d.tenants))
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(() => {
    if (me) loadTenants();
  }, [me, loadTenants]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      await api("/api/admin/login", { body: { email, password } });
      setPassword("");
      loadMe();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoginBusy(false);
    }
  };

  const create = async () => {
    setCreating(true);
    try {
      await api("/api/admin/tenants", { body: { slug: newSlug.trim().toLowerCase(), name: newName.trim() } });
      toast.success(`Tenant '${newSlug}' created`);
      setNewSlug("");
      setNewName("");
      loadTenants();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const update = async (slug: string, patch: { name?: string; active?: boolean }) => {
    try {
      await api(`/api/admin/tenants/${slug}`, { method: "PUT", body: patch });
      loadTenants();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    }
  };

  const useTenant = async (slug: string | null) => {
    await api("/api/admin/use-tenant", { body: { slug } });
    window.location.href = "/"; // full reload: everything refetches as that tenant
  };

  const changePassword = async () => {
    try {
      await api("/api/admin/change-password", { body: { password: newPw } });
      setNewPw("");
      toast.success("Platform password changed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Change failed");
    }
  };

  if (checking) {
    return (
      <div className="page">
        <div className="card"><Skeleton rows={4} height={20} /></div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="page" style={{ maxWidth: 420 }}>
        <h1>Platform admin</h1>
        <div className="page-sub">Super-admin sign-in — separate from staff access.</div>
        <div style={{ height: 14 }} />
        <form className="card" onSubmit={(e) => void login(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Email">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="Password" hint="First-run password is printed in the server log on first boot.">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          </Field>
          {loginError && <div className="error-note">{loginError}</div>}
          <button type="submit" className="btn btn-primary" disabled={loginBusy || !password}>
            {loginBusy && <Spinner small />} Sign in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Tenants</h1>
          <div className="page-sub">Signed in as {me.email} (super admin)</div>
        </div>
        <button type="button" className="btn" onClick={() => void api("/api/admin/logout", { method: "POST" }).then(loadMe)}>
          Sign out
        </button>
      </div>

      {me.tenant && (
        <div className="error-note" style={{ marginBottom: 14 }}>
          Currently operating tenant <strong>{me.tenant}</strong>.{" "}
          <button type="button" className="btn btn-sm" onClick={() => void useTenant(null)}>Back to default</button>
        </div>
      )}

      <div className="card">
        <h2 className="card-title">All tenants</h2>
        {loading ? (
          <Skeleton rows={3} height={22} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tenant</th><th>Slug</th><th className="num">Bookings</th><th className="num">Revenue</th>
                  <th className="num">Products</th><th className="num">Upcoming</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <input
                        type="text"
                        defaultValue={t.name}
                        style={{ border: "1px solid transparent", background: "transparent", fontWeight: 600, width: 180 }}
                        onBlur={(e) => {
                          if (e.target.value.trim() && e.target.value !== t.name) void update(t.slug, { name: e.target.value.trim() });
                        }}
                        title="Click to rename; saves on blur"
                      />
                    </td>
                    <td className="mono">{t.slug}</td>
                    <td className="num">{t.stats.bookings}</td>
                    <td className="num">{money(t.stats.revenue)}</td>
                    <td className="num">{t.stats.products}</td>
                    <td className="num">{t.stats.upcoming}</td>
                    <td>
                      <label className="checkbox-row" title="Inactive tenants reject all traffic">
                        <input type="checkbox" checked={t.active} onChange={(e) => void update(t.slug, { active: e.target.checked })} />
                        {t.active ? "Active" : "Inactive"}
                      </label>
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" disabled={!t.active} onClick={() => void useTenant(t.slug)}>
                        Manage →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <hr className="divider" />
        <h2 className="card-title">New tenant</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Field label="Slug (lowercase)">
            <input type="text" value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="acme-outdoors" />
          </Field>
          <Field label="Name">
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Acme Outdoors" />
          </Field>
          <button type="button" className="btn btn-primary" disabled={creating || !newSlug} onClick={() => void create()}>
            {creating && <Spinner small />} Create tenant
          </button>
        </div>
        <div className="faint" style={{ marginTop: 6 }}>
          Each tenant gets its own isolated database (catalog, bookings, settings, staff password).
        </div>
      </div>

      <div style={{ height: 16 }} />
      <div className="card" style={{ maxWidth: 460 }}>
        <h2 className="card-title">Platform password</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            placeholder="New password (min 12 chars)"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            autoComplete="new-password"
            style={{ flex: 1 }}
          />
          <button type="button" className="btn" disabled={newPw.length < 12} onClick={() => void changePassword()}>
            Change
          </button>
        </div>
      </div>
    </div>
  );
}
