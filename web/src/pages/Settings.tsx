import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Health, Settings } from "../api";
import { useToast } from "../components/Toast";
import { ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

const EMPTY: Settings = {
  navBaseUrl: "",
  navMode: "mock",
  shopifyShop: "",
  conduitUrl: "",
  posStoreId: "",
  posTerminalId: "",
  posStaffId: "",
};

export function SettingsPage() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ settings: Partial<Settings> }>("/api/settings")
      .then((d) => setSettings({ ...EMPTY, ...d.settings }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));

    setHealthLoading(true);
    api<Health>("/api/health")
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setHealthLoading(false));
  }, []);

  useEffect(load, [load]);

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const { settings: updated } = await api<{ settings: Partial<Settings> }>("/api/settings", {
        method: "PUT",
        body: settings,
      });
      setSettings({ ...EMPTY, ...updated });
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-sub">Integration endpoints and POS mapping</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || loading}
          onClick={() => void save()}
        >
          {saving && <Spinner small />} Save
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="grid-2">
        <div className="card">
          <h2 className="card-title">Integrations</h2>
          {loading ? (
            <Skeleton rows={6} height={20} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Field label="NAV base URL">
                <input
                  type="url"
                  value={settings.navBaseUrl}
                  onChange={(e) => set("navBaseUrl", e.target.value)}
                  placeholder="https://nav.example.com:7047/…"
                />
              </Field>
              <Field label="NAV mode">
                <select
                  value={settings.navMode}
                  onChange={(e) => set("navMode", e.target.value as Settings["navMode"])}
                >
                  <option value="mock">mock</option>
                  <option value="live">live</option>
                </select>
              </Field>
              <Field label="Shopify shop">
                <input
                  type="text"
                  value={settings.shopifyShop}
                  onChange={(e) => set("shopifyShop", e.target.value)}
                  placeholder="my-shop.myshopify.com"
                />
              </Field>
              <Field label="Conduit URL">
                <input
                  type="url"
                  value={settings.conduitUrl}
                  onChange={(e) => set("conduitUrl", e.target.value)}
                  placeholder="https://conduit.example.com"
                />
              </Field>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h2 className="card-title">POS mapping</h2>
            {loading ? (
              <Skeleton rows={3} height={20} />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Field label="POS store ID">
                  <input
                    type="text"
                    value={settings.posStoreId}
                    onChange={(e) => set("posStoreId", e.target.value)}
                  />
                </Field>
                <Field label="POS terminal ID">
                  <input
                    type="text"
                    value={settings.posTerminalId}
                    onChange={(e) => set("posTerminalId", e.target.value)}
                  />
                </Field>
                <Field label="POS staff ID">
                  <input
                    type="text"
                    value={settings.posStaffId}
                    onChange={(e) => set("posStaffId", e.target.value)}
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="card">
            <h2 className="card-title">Health</h2>
            {healthLoading ? (
              <Skeleton rows={3} />
            ) : !health ? (
              <div className="error-note">API unreachable</div>
            ) : (
              <>
                <div className="health-row">
                  <span className="muted">Server</span>
                  <span className={`avail ${health.ok ? "avail-ok" : "avail-no"}`}>
                    {health.ok ? "● OK" : "● Down"}
                  </span>
                </div>
                <div className="health-row">
                  <span className="muted">NAV mode</span>
                  <span className="badge">{health.navMode}</span>
                </div>
                <div className="health-row">
                  <span className="muted">Shopify</span>
                  <span className={`avail ${health.shopifyConfigured ? "avail-ok" : "avail-no"}`}>
                    {health.shopifyConfigured ? "● Configured" : "● Not configured"}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
