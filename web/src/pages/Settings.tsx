import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Health, Settings, Store } from "../api";
import { languageName, useI18n } from "../components/I18n";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { ErrorNote, Field, Skeleton, Spinner } from "../components/ui";
import { RichTextEditor } from "../components/RichTextEditor";
import { setDisplayCurrency } from "../format";

type Tab = "store" | "access" | "policies" | "integrations" | "webhooks" | "health";

const EMPTY = {
  currency: "CAD",
  navBaseUrl: "", navMode: "mock", navUsername: "", navDomain: "",
  shopifyShop: "", conduitUrl: "", posStoreId: "", posTerminalId: "", posStaffId: "",
  idRetentionDays: "30", dataRetentionDays: "730", publicUrl: "",
  enabledLanguages: '["en","fr"]', zoomAccountId: "", zoomClientId: "", zoomUserId: "me",
  slotHoldMinutes: "10", maxCustomerReschedules: "5", reminderHours: "[24]",
  cancelPolicyEnabled: "", cancelFullRefundDays: "7", cancelPartialRefundDays: "2", cancelPartialRefundPercent: "50",
  pickupEarliestTime: "", returnByTime: "", rentalIncrementUnit: "day", rentalIncrementValue: "1",
  extensionsEnabled: "", extensionApproval: "manual",
  noShowFeeMode: "off", noShowFeeValue: "0",
  shippingFeeDefault: "0", shipBufferPricePerDay: "0", shipReturnAddress: "",
  termsRentalEnabled: "", termsCourseEnabled: "", termsServiceEnabled: "",
  termsRentalHtml: "", termsCourseHtml: "", termsServiceHtml: "",
  termsRentalPdf: "", termsCoursePdf: "", termsServicePdf: "",
  sftpHost: "", sftpPort: "22", sftpUser: "", sftpPassword: "", sftpPath: "/reservly-ids",
  googleClientId: "", googleClientSecret: "", msClientId: "", msTenantId: "common", msClientSecret: "",
  calendarSyncEnabled: "", calendarPublicUrl: "",
  zoomClientSecret: "", navPassword: "", shopifyApiSecret: "",
};
type GeneralSettings = typeof EMPTY;

const generalSettings = (loaded: Partial<Settings>): GeneralSettings => {
  const result = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof GeneralSettings)[]) {
    const value = loaded[key];
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
};

const WRITE_ONLY: (keyof GeneralSettings)[] = ["navPassword", "shopifyApiSecret", "zoomClientSecret", "sftpPassword", "googleClientSecret", "msClientSecret"];
const TABS: { id: Tab; label: string }[] = [
  { id: "store", label: "Stores" },
  { id: "access", label: "Access & privacy" },
  { id: "policies", label: "Policies" },
  { id: "integrations", label: "Integrations" },
  { id: "webhooks", label: "Webhooks" },
  { id: "health", label: "Health" },
];
const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.id === value);

export function SettingsPage() {
  const { t } = useI18n();
  const { refreshStores: refreshGlobalStores } = useStores();
  const toast = useToast();
  const showStoreLoadError = toast.error;
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const value = new URLSearchParams(window.location.search).get("tab");
    return isTab(value) ? value : "store";
  });
  const [settings, setSettings] = useState<GeneralSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [settingUp, setSettingUp] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storeForm, setStoreForm] = useState({
    code: "", name: "", city: "", posStoreId: "", posTerminalId: "", posStaffId: "",
  });
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [storeActionId, setStoreActionId] = useState<string | null>(null);
  const [confirmStoreDeleteId, setConfirmStoreDeleteId] = useState<string | null>(null);
  const termsInputs = {
    rental: useRef<HTMLInputElement>(null),
    course: useRef<HTMLInputElement>(null),
    service: useRef<HTMLInputElement>(null),
  };
  const [termsBusy, setTermsBusy] = useState<string | null>(null);

  type Hook = { id: string; url: string; events: string[]; active: boolean; lastStatus: string; hasSecret: boolean };
  type WebhookPreset = { name: string; label: string; events: string[] };
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [hookPresets, setHookPresets] = useState<WebhookPreset[]>([]);
  const [hookPresetsError, setHookPresetsError] = useState(false);
  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState("*");
  const [hookSecret, setHookSecret] = useState("");

  const selectTab = (tab: Tab) => {
    setActiveTab(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const loadHooks = useCallback(() => {
    api<{ webhooks: Hook[] }>("/api/webhooks").then((d) => setHooks(d.webhooks)).catch(() => setHooks([]));
  }, []);
  useEffect(loadHooks, [loadHooks]);
  useEffect(() => {
    api<{ presets: WebhookPreset[] }>("/api/webhook-presets")
      .then((data) => {
        setHookPresets(Array.isArray(data.presets) ? data.presets : []);
        setHookPresetsError(false);
      })
      .catch(() => {
        setHookPresets([]);
        setHookPresetsError(true);
      });
  }, []);

  const parsedHookEvents = (value: string) =>
    value.trim() === "*" ? ["*"] : value.split(",").map((item) => item.trim()).filter(Boolean);
  const matchingHookPreset = (events: string[]) => {
    const normalized = Array.from(new Set(events)).sort();
    return hookPresets.find((preset) => {
      const presetEvents = Array.from(new Set(preset.events)).sort();
      return normalized.length === presetEvents.length
        && normalized.every((event, index) => event === presetEvents[index]);
    }) ?? null;
  };

  const refreshStores = useCallback(async () => {
    setStoresLoading(true);
    try {
      const data = await api<{ stores: Store[] }>("/api/stores");
      setStores(data.stores);
      await refreshGlobalStores();
    } catch (e) {
      showStoreLoadError(t(e instanceof Error ? e.message : "Could not load locations"));
    } finally {
      setStoresLoading(false);
    }
  }, [refreshGlobalStores, showStoreLoadError, t]);
  useEffect(() => { void refreshStores(); }, [refreshStores]);

  const createStore = async () => {
    if (!storeForm.code.trim() || !storeForm.name.trim()) return;
    setStoreActionId("new");
    try {
      await api("/api/stores", { method: "POST", body: storeForm });
      setStoreForm({ code: "", name: "", city: "", posStoreId: "", posTerminalId: "", posStaffId: "" });
      toast.success(t("Location created"));
      await refreshStores();
    } catch (e) {
      toast.error(t(e instanceof Error ? e.message : "Could not create location"));
    } finally {
      setStoreActionId(null);
    }
  };

  const updateStore = async () => {
    if (!editingStore || !editingStore.code.trim() || !editingStore.name.trim()) return;
    setStoreActionId(editingStore.id);
    try {
      await api(`/api/stores/${editingStore.id}`, { method: "PUT", body: {
        code: editingStore.code, name: editingStore.name, city: editingStore.city,
        posStoreId: editingStore.posStoreId, posTerminalId: editingStore.posTerminalId, posStaffId: editingStore.posStaffId,
      } });
      setEditingStore(null);
      toast.success(t("Location updated"));
      await refreshStores();
    } catch (e) {
      toast.error(t(e instanceof Error ? e.message : "Could not update location"));
    } finally {
      setStoreActionId(null);
    }
  };

  const deleteStore = async (store: Store) => {
    if (confirmStoreDeleteId !== store.id) {
      setConfirmStoreDeleteId(store.id);
      return;
    }
    setStoreActionId(store.id);
    try {
      const response = await fetch(`/api/stores/${store.id}`, { method: "DELETE" });
      const data = await response.json() as {
        error?: string;
        counts?: { bookings: number; sessions: number; rentalUnits: number; productQty: number };
      };
      if (!response.ok) {
        if (response.status === 409 && data.error === "store_in_use" && data.counts) {
          const values = [data.counts.bookings, data.counts.sessions, data.counts.rentalUnits, data.counts.productQty];
          let message = t("Can't delete — {{count}} bookings, {{count}} sessions, {{count}} rental units, {{count}} products still reference this location");
          for (const count of values) message = message.replace("{{count}}", String(count));
          throw new Error(message);
        }
        throw new Error(data.error || response.statusText);
      }
      setConfirmStoreDeleteId(null);
      if (editingStore?.id === store.id) setEditingStore(null);
      toast.success(t("Location deleted"));
      await refreshStores();
    } catch (e) {
      toast.error(t(e instanceof Error ? e.message : "Could not delete location"));
    } finally {
      setStoreActionId(null);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ settings: Partial<Settings> }>("/api/settings")
      .then(async ({ settings: loaded }) => {
        const next = generalSettings(loaded);
        const types = ["rental", "course", "service"] as const;
        const pdfStates = await Promise.all(types.map(async (type) => {
          const response = await fetch(`/api/terms/${type}`, { method: "HEAD" }).catch(() => null);
          return response?.ok && response.headers.get("content-type")?.includes("application/pdf");
        }));
        types.forEach((type, index) => {
          const key = `terms${type[0].toUpperCase()}${type.slice(1)}Pdf` as keyof GeneralSettings;
          Object.assign(next, { [key]: pdfStates[index] ? "1" : "" });
        });
        setDisplayCurrency(next.currency || "CAD");
        setSettings(next);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    setHealthLoading(true);
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null)).finally(() => setHealthLoading(false));
  }, []);
  useEffect(load, [load]);

  const set = <K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const contentLanguages = (() => {
    try { return JSON.parse(settings.enabledLanguages) as string[]; } catch { return ["en", "fr"]; }
  })();
  const toggleLanguage = (locale: string) => {
    const next = contentLanguages.includes(locale)
      ? contentLanguages.filter((item) => item !== locale)
      : [...contentLanguages, locale];
    if (next.length) set("enabledLanguages", JSON.stringify(next));
  };

  const save = async () => {
    setSaving(true);
    try {
      const body: Partial<GeneralSettings> = { ...settings };
      for (const key of WRITE_ONLY) if (!body[key]) delete body[key];
      const { settings: updated } = await api<{ settings: Partial<Settings> }>("/api/settings", { method: "PUT", body });
      const currentPdf = {
        termsRentalPdf: settings.termsRentalPdf,
        termsCoursePdf: settings.termsCoursePdf,
        termsServicePdf: settings.termsServicePdf,
      };
      setSettings({ ...generalSettings(updated), ...currentPdf });
      setDisplayCurrency(updated.currency || "CAD");
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const syncCalendars = async () => {
    setTesting(true);
    try {
      const { results } = await api<{ results: { resourceId: string; ok: boolean; error?: string }[] }>("/api/calendars/sync", { method: "POST" });
      const ok = results.filter((result) => result.ok).length;
      const failed = results.length - ok;
      toast[failed ? "error" : "success"](`${t("calendarSync.syncResults")}: ${ok} OK${failed ? `, ${failed} failed` : ""}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Calendar sync failed");
    } finally {
      setTesting(false);
    }
  };

  const setupShopify = async () => {
    setSettingUp(true);
    try {
      const { results } = await api<{ results: string[] }>("/api/shopify/setup", { method: "POST" });
      toast.success(results.join(" · ") || "Metafield definitions ready");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Setup failed");
    } finally { setSettingUp(false); }
  };
  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api<{ ok: boolean; error?: string }>("/api/sftp/test", { method: "POST" });
      setTestResult({ ok: result.ok, message: result.ok ? "Connected successfully" : result.error || "Connection failed" });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };
  const addHook = async () => {
    try {
      await api("/api/webhooks", { body: {
        url: hookUrl,
        events: parsedHookEvents(hookEvents),
        secret: hookSecret || undefined,
      } });
      setHookUrl(""); setHookSecret(""); toast.success("Webhook added"); loadHooks();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to add webhook"); }
  };
  const deleteHook = async (id: string) => {
    await api(`/api/webhooks/${id}`, { method: "DELETE" }).catch(() => {});
    loadHooks();
  };
  const testHook = async (id: string) => {
    try {
      await api(`/api/webhooks/${id}/test`, { method: "POST" });
      toast.success("Test event sent — refresh to see delivery status");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Test failed"); }
  };

  const uploadTermsPdf = async (type: "rental" | "course" | "service", file?: File) => {
    if (!file) return;
    if (file.type !== "application/pdf") {
      toast.error("Choose a PDF file");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("PDF must be 10 MB or smaller");
      return;
    }
    setTermsBusy(type);
    try {
      const response = await fetch(`/api/terms/${type}/pdf`, {
        method: "POST", headers: { "Content-Type": "application/pdf" }, body: file,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || response.statusText);
      }
      const pdfKey = `terms${type[0].toUpperCase()}${type.slice(1)}Pdf` as keyof GeneralSettings;
      set(pdfKey, "1");
      toast.success(t("PDF uploaded"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "PDF upload failed");
    } finally {
      setTermsBusy(null);
      if (termsInputs[type].current) termsInputs[type].current.value = "";
    }
  };

  const removeTermsPdf = async (type: "rental" | "course" | "service") => {
    setTermsBusy(type);
    try {
      await api(`/api/terms/${type}/pdf`, { method: "DELETE" });
      const pdfKey = `terms${type[0].toUpperCase()}${type.slice(1)}Pdf` as keyof GeneralSettings;
      set(pdfKey, "");
      toast.success(t("PDF removed"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove PDF");
    } finally {
      setTermsBusy(null);
    }
  };

  const fields = (children: React.ReactNode, rows = 6) => loading
    ? <Skeleton rows={rows} height={20} />
    : <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{t("Settings")}</h1><div className="page-sub">{t("Integration endpoints and POS mapping")}</div></div>
        {activeTab !== "health" && activeTab !== "webhooks" && (
          <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>
            {saving && <Spinner small />} {t("Save")}
          </button>
        )}
      </div>
      <div className="tabs">
        {TABS.map((tab) => (
          <button type="button" key={tab.id} className={`tab ${activeTab === tab.id ? "active" : ""}`} onClick={() => selectTab(tab.id)}>
            {t(tab.label)}
          </button>
        ))}
      </div>
      {error && <ErrorNote message={error} onRetry={load} />}

      {activeTab === "store" && <>
        <div className="card">
          <h2 className="card-title">{t("Locations")}</h2>
          {storesLoading ? <Skeleton rows={4} /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th>{t("Code")}</th><th>{t("Name")}</th><th>{t("City")}</th><th>{t("POS mapping")}</th><th>{t("Actions")}</th>
                </tr></thead>
                <tbody>
                  {stores.map((store) => {
                    const editing = editingStore?.id === store.id;
                    return (
                      <tr key={store.id}>
                        <td className={editing ? undefined : "mono"}>
                          {editing
                            ? <input aria-label={t("Location code")} value={editingStore.code} onChange={(e) => setEditingStore({ ...editingStore, code: e.target.value })} />
                            : store.code}
                        </td>
                        <td>{editing
                          ? <input aria-label={t("Name")} value={editingStore.name} onChange={(e) => setEditingStore({ ...editingStore, name: e.target.value })} />
                          : store.name}</td>
                        <td>{editing
                          ? <input aria-label={t("City")} value={editingStore.city} onChange={(e) => setEditingStore({ ...editingStore, city: e.target.value })} />
                          : store.city || "—"}</td>
                        <td>{editing ? (
                          <div style={{ display: "grid", gap: 6 }}>
                            <strong>{t("POS mapping")}</strong>
                            <input aria-label={t("POS store ID")} placeholder={t("POS store ID")} value={editingStore.posStoreId ?? ""} onChange={(e) => setEditingStore({ ...editingStore, posStoreId: e.target.value })} />
                            <input aria-label={t("POS terminal ID")} placeholder={t("POS terminal ID")} value={editingStore.posTerminalId ?? ""} onChange={(e) => setEditingStore({ ...editingStore, posTerminalId: e.target.value })} />
                            <input aria-label={t("POS staff ID")} placeholder={t("POS staff ID")} value={editingStore.posStaffId ?? ""} onChange={(e) => setEditingStore({ ...editingStore, posStaffId: e.target.value })} />
                          </div>
                        ) : (
                          <span className="faint">
                            {[store.posStoreId, store.posTerminalId, store.posStaffId].some((value) => value?.trim())
                              ? [store.posStoreId, store.posTerminalId, store.posStaffId].map((value) => value || "—").join(" / ")
                              : t("Defaults")}
                          </span>
                        )}</td>
                        <td><div className="btn-row">
                          {editing ? <>
                            <button type="button" className="btn btn-sm btn-primary" disabled={storeActionId === store.id || !editingStore.code.trim() || !editingStore.name.trim()} onClick={() => void updateStore()}>{t("Save")}</button>
                            <button type="button" className="btn btn-sm" onClick={() => setEditingStore(null)}>{t("Cancel")}</button>
                          </> : <>
                            <button type="button" className="btn btn-sm" onClick={() => setEditingStore({ ...store })}>{t("Edit location")}</button>
                            <button type="button" className="btn btn-sm" disabled={storeActionId === store.id} onClick={() => void deleteStore(store)} onBlur={() => setConfirmStoreDeleteId((id) => id === store.id ? null : id)}>
                              {t(confirmStoreDeleteId === store.id ? "Confirm delete" : "Delete location")}
                            </button>
                          </>}
                        </div></td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td><input className="mono" required aria-label={t("Location code")} title={t("POS / NAV location code")} placeholder={t("POS / NAV location code")} value={storeForm.code} onChange={(e) => setStoreForm({ ...storeForm, code: e.target.value })} /></td>
                    <td><input required aria-label={t("Name")} placeholder={t("Name")} value={storeForm.name} onChange={(e) => setStoreForm({ ...storeForm, name: e.target.value })} /></td>
                    <td><input aria-label={t("City")} placeholder={t("City")} value={storeForm.city} onChange={(e) => setStoreForm({ ...storeForm, city: e.target.value })} /></td>
                    <td><div style={{ display: "grid", gap: 6 }}>
                      <strong>{t("POS mapping")}</strong>
                      <input aria-label={t("POS store ID")} placeholder={t("POS store ID")} value={storeForm.posStoreId} onChange={(e) => setStoreForm({ ...storeForm, posStoreId: e.target.value })} />
                      <input aria-label={t("POS terminal ID")} placeholder={t("POS terminal ID")} value={storeForm.posTerminalId} onChange={(e) => setStoreForm({ ...storeForm, posTerminalId: e.target.value })} />
                      <input aria-label={t("POS staff ID")} placeholder={t("POS staff ID")} value={storeForm.posStaffId} onChange={(e) => setStoreForm({ ...storeForm, posStaffId: e.target.value })} />
                    </div></td>
                    <td><button type="button" className="btn btn-sm btn-primary" disabled={storeActionId === "new" || !storeForm.code.trim() || !storeForm.name.trim()} onClick={() => void createStore()}>
                      {t("Add location")}
                    </button></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2 className="card-title">{t("Currency")}</h2>
          {fields(<Field
            label={t("Currency")}
            hint={t("Applies to new bookings and displays in the Booking Desk. Shopify payments always settle in your shop's currency.")}
          >
            <select
              value={["CAD", "USD", "EUR", "GBP", "MXN", "AUD"].includes(settings.currency) ? settings.currency : "OTHER"}
              onChange={(e) => set("currency", e.target.value === "OTHER" ? "" : e.target.value)}
            >
              {["CAD", "USD", "EUR", "GBP", "MXN", "AUD"].map((code) => <option key={code} value={code}>{code}</option>)}
              <option value="OTHER">{t("Other...")}</option>
            </select>
            {!["CAD", "USD", "EUR", "GBP", "MXN", "AUD"].includes(settings.currency) && (
              <input
                aria-label={t("Other currency (ISO 3-letter code)")}
                placeholder={t("Other currency (ISO 3-letter code)")}
                value={settings.currency}
                maxLength={3}
                pattern="[A-Z]{3}"
                onChange={(e) => set("currency", e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))}
              />
            )}
          </Field>, 1)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("Content languages")}</h2>
          <div className="faint" style={{ marginBottom: 10 }}>Every product and course will expose a required name and description for each enabled language.</div>
          <div className="btn-row">{["en", "fr", "es"].map((locale) => (
            <label className="checkbox-row" key={locale}>
              <input type="checkbox" checked={contentLanguages.includes(locale)} onChange={() => toggleLanguage(locale)} />{languageName(locale)}
            </label>
          ))}</div>
        </div>
        <div className="card">
          <h2 className="card-title">Public URL</h2>
          {fields(<Field label="Public URL" hint="Base for customer-facing links (e-signature). In dev, your tunnel URL.">
            <input type="url" value={settings.publicUrl} onChange={(e) => set("publicUrl", e.target.value)} placeholder="https://bookings.gosselin.ca" />
          </Field>, 1)}
        </div>
      </>}

      {activeTab === "access" && <>
      <div className="card">
        <h2 className="card-title">Staff access &amp; privacy</h2>
        {fields(<>
          <Field label="ID retention (days after booking closes)"><input type="number" min={1} value={settings.idRetentionDays} onChange={(e) => set("idRetentionDays", e.target.value)} /></Field>
          <Field label="Booking data retention (days)" hint="Older completed/cancelled bookings are anonymized; totals are kept.">
            <input type="number" min={30} value={settings.dataRetentionDays} onChange={(e) => set("dataRetentionDays", e.target.value)} />
          </Field>
        </>, 3)}
      </div>
      <div className="card">
        <h2 className="card-title">ID photo storage (SFTP)</h2>
        {fields(<>
          <Field label="SFTP host"><input value={settings.sftpHost} onChange={(e) => set("sftpHost", e.target.value)} /></Field>
          <Field label="SFTP port"><input type="number" value={settings.sftpPort} onChange={(e) => set("sftpPort", e.target.value)} /></Field>
          <Field label="SFTP user"><input value={settings.sftpUser} onChange={(e) => set("sftpUser", e.target.value)} /></Field>
          <Field label="SFTP password (write-only)"><input type="password" value={settings.sftpPassword ?? ""} onChange={(e) => set("sftpPassword", e.target.value)} /></Field>
          <Field label="Remote path"><input value={settings.sftpPath} onChange={(e) => set("sftpPath", e.target.value)} /></Field>
          <button type="button" className="btn" onClick={() => void testConnection()} disabled={testing}>
            {testing && <Spinner small />} Test connection
          </button>
          {testResult && <div className={`faint ${testResult.ok ? "success" : "error"}`}>{testResult.message}</div>}
        </>, 6)}
      </div>
      </>}

      {activeTab === "policies" && <>
        <div className="card">
          <h2 className="card-title">{t("Cancellation refund policy")}</h2>
          {fields(<>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.cancelPolicyEnabled === "1"}
              onChange={(e) => set("cancelPolicyEnabled", e.target.checked ? "1" : "")}
            />
            {t("Enforce a cancellation refund policy")}
          </label>
          <Field label={t("Days for full refund")}>
            <input type="number" value={settings.cancelFullRefundDays} onChange={(e) => set("cancelFullRefundDays", e.target.value)} />
          </Field>
          <Field label={t("Days for partial refund threshold")}>
            <input type="number" value={settings.cancelPartialRefundDays} onChange={(e) => set("cancelPartialRefundDays", e.target.value)} />
          </Field>
          <Field label={t("Partial refund percentage")}>
            <input type="number" min={0} max={100} value={settings.cancelPartialRefundPercent} onChange={(e) => set("cancelPartialRefundPercent", e.target.value)} />
          </Field>
          <div className="faint">
            ≥{settings.cancelFullRefundDays || "7"} days before pickup: full refund · {settings.cancelPartialRefundDays || "2"}–{settings.cancelFullRefundDays || "7"} days: {settings.cancelPartialRefundPercent || "50"}% · &lt;{settings.cancelPartialRefundDays || "2"} days: no refund
          </div>
          </>, 5)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("Rental extensions")}</h2>
          {fields(<>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.extensionsEnabled === "1"}
                onChange={(e) => set("extensionsEnabled", e.target.checked ? "1" : "")}
              />
              {t("Let customers request rental extensions")}
            </label>
            {settings.extensionsEnabled === "1" && (
              <Field label={t("Approval mode")}>
                <select value={settings.extensionApproval} onChange={(e) => set("extensionApproval", e.target.value)}>
                  <option value="auto">{t("Approve automatically when the dates are available")}</option>
                  <option value="manual">{t("Staff review each request")}</option>
                </select>
              </Field>
            )}
          </>, 2)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("No-show fee")}</h2>
          {fields(<>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.noShowFeeMode !== "off"}
                onChange={(e) => set("noShowFeeMode", e.target.checked ? "percent" : "off")}
              />
              {t("Enable no-show fees")}
            </label>
            <Field label={t("Mode")}>
              <select
                value={settings.noShowFeeMode}
                onChange={(e) => set("noShowFeeMode", e.target.value as GeneralSettings["noShowFeeMode"])}
              >
                <option value="off">{t("Off")}</option>
                <option value="percent">{t("Percent of booking")}</option>
                <option value="fixed">{t("Fixed amount")}</option>
              </select>
            </Field>
            {settings.noShowFeeMode !== "off" && (
              <Field label={t("Fee amount")}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="number"
                    min={0}
                    step={settings.noShowFeeMode === "percent" ? 1 : 0.01}
                    value={settings.noShowFeeValue}
                    onChange={(e) => set("noShowFeeValue", e.target.value)}
                  />
                  <span className="faint">{t(settings.noShowFeeMode === "percent" ? "%" : "$")}</span>
                </div>
              </Field>
            )}
            <div className="faint">
              {settings.noShowFeeMode === "off"
                ? t("Mode is off")
                : settings.noShowFeeMode === "percent"
                  ? `${settings.noShowFeeValue || "0"}${t("%")} ${t("of booking total")}`
                  : `${t("$")}${settings.noShowFeeValue || "0"} ${t("per booking")}`}
            </div>
          </>, 4)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("shipping_defaults_title")}</h2>
          {fields(<>
            <Field label={t("shipping_fee_default_label")}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={settings.shippingFeeDefault}
                onChange={(e) => set("shippingFeeDefault", e.target.value)}
              />
            </Field>
            <Field label={t("shipping_buffer_price_label")}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={settings.shipBufferPricePerDay}
                onChange={(e) => set("shipBufferPricePerDay", e.target.value)}
              />
            </Field>
            <Field
              label={t("shipping_return_address_label")}
              hint={t("shipping_return_address_hint")}
            >
              <textarea
                rows={4}
                value={settings.shipReturnAddress}
                onChange={(e) => set("shipReturnAddress", e.target.value)}
              />
            </Field>
          </>, 3)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("Booking times & increments")}</h2>
          {fields(<>
            <Field label={t("Earliest pickup time")}>
              <input type="time" value={settings.pickupEarliestTime} onChange={(e) => set("pickupEarliestTime", e.target.value)} />
            </Field>
            <Field label={t("Return by")}>
              <input type="time" value={settings.returnByTime} onChange={(e) => set("returnByTime", e.target.value)} />
            </Field>
            <Field label={t("Rental increment")}>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={settings.rentalIncrementValue}
                  onChange={(e) => set("rentalIncrementValue", e.target.value)}
                />
                <select value={settings.rentalIncrementUnit} onChange={(e) => set("rentalIncrementUnit", e.target.value)}>
                  <option value="day">{t("Days")}</option>
                  <option value="hour">{t("Hours")}</option>
                </select>
              </div>
            </Field>
          </>, 3)}
        </div>
        <div className="card">
          <h2 className="card-title">{t("Terms & conditions")}</h2>
          {fields(<>
            {([
              { type: "rental", label: "Rentals", enabled: "termsRentalEnabled", html: "termsRentalHtml", pdf: "termsRentalPdf" },
              { type: "course", label: "Courses", enabled: "termsCourseEnabled", html: "termsCourseHtml", pdf: "termsCoursePdf" },
              { type: "service", label: "Services", enabled: "termsServiceEnabled", html: "termsServiceHtml", pdf: "termsServicePdf" },
            ] as const).map((section) => (
              <div className="translation-panel" key={section.type}>
                <h3 className="card-title">{t(section.label)}</h3>
                <label className="checkbox-row" style={{ marginBottom: 12 }}>
                  <input type="checkbox" checked={settings[section.enabled] === "1"} onChange={(e) => set(section.enabled, e.target.checked ? "1" : "")} />
                  {t("Enable")}
                </label>
                <RichTextEditor
                  disabled={settings[section.enabled] !== "1" || Boolean(settings[section.pdf])}
                  value={settings[section.html]}
                  onChange={(value) => set(section.html, value)}
                />
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <input
                    ref={termsInputs[section.type]}
                    hidden
                    type="file"
                    accept="application/pdf"
                    onChange={(event) => void uploadTermsPdf(section.type, event.target.files?.[0])}
                  />
                  {settings[section.pdf] ? (
                    <>
                      <strong>{t("PDF uploaded")}</strong>
                      <a className="btn btn-sm" href={`/api/terms/${section.type}`} target="_blank" rel="noreferrer">{t("View PDF")}</a>
                      <button type="button" className="btn btn-sm" disabled={termsBusy === section.type} onClick={() => void removeTermsPdf(section.type)}>{t("Remove PDF")}</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={termsBusy === section.type} onClick={() => termsInputs[section.type].current?.click()}>
                      {termsBusy === section.type && <Spinner small />} {t("Upload PDF")}
                    </button>
                  )}
                </div>
                <div className="faint" style={{ marginTop: 8 }}>{t("PDF replaces the text when uploaded")}</div>
              </div>
            ))}
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving && <Spinner small />} {t("Save")}
            </button>
          </>, 8)}
        </div>
      </>}

      {activeTab === "integrations" && <>
        <div className="card"><h2 className="card-title">{t("LS Central / NAV")}</h2>{fields(<>
          <Field label="NAV base URL"><input type="url" value={settings.navBaseUrl} onChange={(e) => set("navBaseUrl", e.target.value)} placeholder="https://nav.example.com:7047/…" /></Field>
          <Field label="NAV mode"><select value={settings.navMode} onChange={(e) => set("navMode", e.target.value as Settings["navMode"])}><option value="mock">mock</option><option value="live">live</option></select></Field>
          <Field label="NAV username"><input value={settings.navUsername} onChange={(e) => set("navUsername", e.target.value)} placeholder="WEBSERVICE" /></Field>
          <Field label="NAV domain"><input value={settings.navDomain} onChange={(e) => set("navDomain", e.target.value)} placeholder="GOSSELIN" /></Field>
          <Field label="NAV password (write-only, blank = unchanged)"><input type="password" value={settings.navPassword ?? ""} onChange={(e) => set("navPassword", e.target.value)} autoComplete="new-password" /></Field>
          <hr className="divider" /><h3 className="card-title">{t("POS mapping defaults")}</h3>
          <div className="faint">{t("Used when a location has no mapping of its own")} ({t("Settings")} → {t("Stores")})</div>
          <Field label={t("POS store ID")}><input value={settings.posStoreId} onChange={(e) => set("posStoreId", e.target.value)} /></Field>
          <Field label={t("POS terminal ID")}><input value={settings.posTerminalId} onChange={(e) => set("posTerminalId", e.target.value)} /></Field>
          <Field label={t("POS staff ID")}><input value={settings.posStaffId} onChange={(e) => set("posStaffId", e.target.value)} /></Field>
        </>, 8)}</div>
        <div className="card"><h2 className="card-title">{t("Shopify")}</h2>{fields(<>
          <Field label="Shopify shop"><input value={settings.shopifyShop} onChange={(e) => set("shopifyShop", e.target.value)} placeholder="my-shop.myshopify.com" /></Field>
          <Field label="Shopify API secret (write-only, blank = unchanged)"><input type="password" value={settings.shopifyApiSecret ?? ""} onChange={(e) => set("shopifyApiSecret", e.target.value)} placeholder="Partner dashboard → app → Client secret" autoComplete="new-password" /></Field>
          <hr className="divider" /><h3 className="card-title">Shopify store setup</h3>
          <div className="faint">Creates the <span className="mono">booking.type</span> and <span className="mono">booking.product_no</span> product metafield definitions the storefront widget reads. Idempotent — safe to re-run.</div>
          <button type="button" className="btn" disabled={settingUp} onClick={() => void setupShopify()}>{settingUp && <Spinner small />} Set up metafield definitions</button>
        </>, 4)}</div>
        <div className="card"><h2 className="card-title">{t("Zoom")}</h2>{fields(<>
          <Field label="Zoom account ID"><input value={settings.zoomAccountId} onChange={(e) => set("zoomAccountId", e.target.value)} /></Field>
          <Field label="Zoom client ID"><input value={settings.zoomClientId} onChange={(e) => set("zoomClientId", e.target.value)} /></Field>
          <Field label="Zoom client secret (write-only)"><input type="password" value={settings.zoomClientSecret || ""} onChange={(e) => set("zoomClientSecret", e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Zoom host user" hint='Email, user ID, or "me" for the account owner.'><input value={settings.zoomUserId} onChange={(e) => set("zoomUserId", e.target.value)} /></Field>
        </>, 4)}</div>
        <div className="card"><h2 className="card-title">{t("calendarSync.title")}</h2>{fields(<>
          <label className="checkbox-row">
            <input type="checkbox" checked={settings.calendarSyncEnabled === "1"} onChange={(event) => set("calendarSyncEnabled", event.target.checked ? "1" : "")} />
            {t("calendarSync.enabledToggle")}
          </label>
          <Field label={t("calendarSync.redirectUrl")} hint={`${(settings.calendarPublicUrl || settings.publicUrl).replace(/\/+$/, "")}/api/calendars/oauth/callback`}>
            <input type="url" value={settings.calendarPublicUrl} onChange={(event) => set("calendarPublicUrl", event.target.value)} placeholder={settings.publicUrl || "https://booking.example.com"} />
          </Field>
          <hr className="divider" /><h3 className="card-title">{t("calendarSync.google.title")}</h3>
          <Field label={t("calendarSync.google.clientId")}><input value={settings.googleClientId} onChange={(event) => set("googleClientId", event.target.value)} /></Field>
          <Field label={t("calendarSync.google.clientSecret")}><input type="password" value={settings.googleClientSecret} onChange={(event) => set("googleClientSecret", event.target.value)} autoComplete="new-password" placeholder="Write-only" /></Field>
          <hr className="divider" /><h3 className="card-title">{t("calendarSync.microsoft.title")}</h3>
          <Field label={t("calendarSync.microsoft.clientId")}><input value={settings.msClientId} onChange={(event) => set("msClientId", event.target.value)} /></Field>
          <Field label={t("calendarSync.microsoft.tenantId")}><input value={settings.msTenantId} onChange={(event) => set("msTenantId", event.target.value)} /></Field>
          <Field label={t("calendarSync.microsoft.clientSecret")}><input type="password" value={settings.msClientSecret} onChange={(event) => set("msClientSecret", event.target.value)} autoComplete="new-password" placeholder="Write-only" /></Field>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>{saving && <Spinner small />} {t("Save")}</button>
            <button type="button" className="btn" disabled={testing} onClick={() => void syncCalendars()}>{testing && <Spinner small />} {t("calendarSync.syncNow")}</button>
          </div>
        </>, 9)}</div>
        <div className="card"><h2 className="card-title">{t("Conduit")}</h2>{fields(
          <Field label="Conduit URL"><input type="url" value={settings.conduitUrl} onChange={(e) => set("conduitUrl", e.target.value)} placeholder="https://conduit.example.com" /></Field>, 1
        )}</div>
      </>}

      {activeTab === "webhooks" && <div className="card">
        <h2 className="card-title">Outbound webhooks</h2>
        <div className="faint" style={{ marginBottom: 10 }}>Every <span className="mono">booking.*</span> event is POSTed with the full booking snapshot — point Conduit (or any system) here. Events: created, pos_pushed, reconciled, picked_up, returned, completed, cancelled, signature_requested, contract_signed. Use <span className="mono">*</span> for all; bodies are HMAC-signed (<span className="mono">X-Booking-Signature</span>) when a secret is set.</div>
        {hooks.map((hook) => <div key={hook.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: "1px solid #eef" }}>
          <div style={{ flex: 1, minWidth: 0 }}><div className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{hook.url}</div><div className="faint" style={{ fontSize: 11 }}>{matchingHookPreset(hook.events) ? t(matchingHookPreset(hook.events)!.label) : `${t("Custom")} (${hook.events.length} events)`} · {hook.events.join(", ")}{hook.hasSecret ? " · signed" : ""}{hook.lastStatus ? ` · last: ${hook.lastStatus}` : ""}</div></div>
          <button type="button" className="btn btn-sm" onClick={() => void testHook(hook.id)}>Test</button>
          <button type="button" className="icon-btn" aria-label="Delete webhook" onClick={() => void deleteHook(hook.id)}>×</button>
        </div>)}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
          <input type="url" placeholder="https://conduit.example.com/api/pub/hooks/bookings" value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
          <Field label={t("Webhook preset")}><select
            value={matchingHookPreset(parsedHookEvents(hookEvents))?.name ?? ""}
            onChange={(e) => {
              const preset = hookPresets.find((item) => item.name === e.target.value);
              if (preset) setHookEvents(preset.events.join(", "));
            }}
          >
            <option value="">{t("Custom")}</option>
            {hookPresets.map((preset) => <option key={preset.name} value={preset.name}>{t(preset.label)}</option>)}
          </select></Field>
          {hookPresetsError && <ErrorNote message={t("Webhook presets could not be loaded. You can still enter events manually.")} />}
          <div style={{ display: "flex", gap: 8 }}><input placeholder="Events (* or comma-separated)" value={hookEvents} onChange={(e) => setHookEvents(e.target.value)} style={{ flex: 1 }} /><input type="password" placeholder="Secret (optional)" value={hookSecret} onChange={(e) => setHookSecret(e.target.value)} style={{ flex: 1 }} autoComplete="new-password" /></div>
          <button type="button" className="btn" disabled={!hookUrl} onClick={() => void addHook()}>Add webhook</button>
        </div>
      </div>}

      {activeTab === "health" && <div className="card"><h2 className="card-title">{t("Health")}</h2>
        {healthLoading ? <Skeleton rows={3} /> : !health ? <div className="error-note">API unreachable</div> : <>
          <div className="health-row"><span className="muted">Server</span><span className={`avail ${health.ok ? "avail-ok" : "avail-no"}`}>{health.ok ? "● OK" : "● Down"}</span></div>
          <div className="health-row"><span className="muted">NAV mode</span><span className="badge">{health.navMode}</span></div>
          <div className="health-row"><span className="muted">Shopify</span><span className={`avail ${health.shopifyConfigured ? "avail-ok" : "avail-no"}`}>{health.shopifyConfigured ? "● Configured" : "● Not configured"}</span></div>
        </>}
      </div>}
    </div>
  );
}
