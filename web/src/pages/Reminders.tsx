import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Settings } from "../api";
import { useI18n } from "../components/I18n";
import { RichTextEditor } from "../components/RichTextEditor";
import { useToast } from "../components/Toast";
import { ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

const PICKUP_SUBJECT = "Reminder: your rental pickup at {{store}}";
const RETURN_SUBJECT = "Reminder: your rental return to {{store}}";
const PICKUP_TEMPLATE = `<p>Hi {{firstName}},</p>
<p>We're looking forward to your rental pickup at <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>See you soon!</p>`;
const RETURN_TEMPLATE = `<p>Hi {{firstName}},</p>
<p>This is a reminder to return your rental to <strong>{{store}}</strong> on <strong>{{date}}</strong> at <strong>{{time}}</strong>.</p>
<p>Your reservation: <strong>{{ref}}</strong></p>
<p>Items: {{items}}</p>
<p>Thank you!</p>`;
const PLACEHOLDERS = "Placeholders: {{firstName}}, {{lastName}}, {{ref}}, {{store}}, {{date}}, {{time}}, {{items}}";

type ReminderSettings = Required<Pick<Settings,
  "reminderPickupEnabled" | "reminderReturnEnabled" |
  "reminderPickupHours" | "reminderReturnHours" |
  "reminderPickupSubject" | "reminderPickupTemplate" |
  "reminderReturnSubject" | "reminderReturnTemplate"
>>;

const DEFAULTS: ReminderSettings = {
  reminderPickupEnabled: "0",
  reminderReturnEnabled: "0",
  reminderPickupHours: "24",
  reminderReturnHours: "24",
  reminderPickupSubject: PICKUP_SUBJECT,
  reminderPickupTemplate: PICKUP_TEMPLATE,
  reminderReturnSubject: RETURN_SUBJECT,
  reminderReturnTemplate: RETURN_TEMPLATE,
};

const resolvedEnabled = (newValue: string | undefined, legacyValue: string | undefined) =>
  newValue === "1" || ((newValue ?? "") === "" && legacyValue === "1") ? "1" : "0";

const reminderSettings = (loaded: Partial<Settings>): ReminderSettings => ({
  reminderPickupEnabled: resolvedEnabled(loaded.reminderPickupEnabled, loaded.remindersEnabled),
  reminderReturnEnabled: resolvedEnabled(loaded.reminderReturnEnabled, loaded.remindersEnabled),
  reminderPickupHours: loaded.reminderPickupHours || DEFAULTS.reminderPickupHours,
  reminderReturnHours: loaded.reminderReturnHours || DEFAULTS.reminderReturnHours,
  reminderPickupSubject: loaded.reminderPickupSubject || DEFAULTS.reminderPickupSubject,
  reminderPickupTemplate: loaded.reminderPickupTemplate || DEFAULTS.reminderPickupTemplate,
  reminderReturnSubject: loaded.reminderReturnSubject || DEFAULTS.reminderReturnSubject,
  reminderReturnTemplate: loaded.reminderReturnTemplate || DEFAULTS.reminderReturnTemplate,
});

export function Reminders() {
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickupEnabled = settings.reminderPickupEnabled === "1";
  const returnEnabled = settings.reminderReturnEnabled === "1";

  const load = useCallback(() => {
    setLoading(true); setError(null);
    api<{ settings: Partial<Settings> }>("/api/settings")
      .then(({ settings: loaded }) => setSettings(reminderSettings(loaded)))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const set = <K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      const values = {
        ...settings,
        reminderPickupEnabled: pickupEnabled ? "1" : "0",
        reminderReturnEnabled: returnEnabled ? "1" : "0",
      };
      const { settings: saved } = await api<{ settings: Partial<Settings> }>("/api/settings", {
        method: "PUT",
        body: values,
      });
      setSettings(reminderSettings(saved));
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  return <div className="page">
    <div className="page-head">
      <div><h1>{t("Reservation reminders")}</h1><div className="page-sub">{t("Configure pickup and return reminder emails independently")}</div></div>
      <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>{saving && <Spinner small />} {t("Save")}</button>
    </div>
    {error && <ErrorNote message={error} onRetry={load} />}
    <div className={`card reminder-card ${pickupEnabled ? "" : "disabled"}`}>
      <h2 className="card-title">{t("Pickup reminder")}</h2>
      {loading ? <Skeleton rows={6} height={28} /> : <>
        <label className="checkbox-row">
          <input type="checkbox" checked={pickupEnabled} onChange={(event) => set("reminderPickupEnabled", event.target.checked ? "1" : "0")} />
          {t("Send pickup reminders")}
        </label>
        <div className="form-grid">
          <Field label={t("Hours before pickup")}><input disabled={!pickupEnabled} type="number" min="1" step="1" value={settings.reminderPickupHours} onChange={(e) => set("reminderPickupHours", e.target.value)} /></Field>
          <Field label={t("Subject")}><input disabled={!pickupEnabled} type="text" value={settings.reminderPickupSubject} onChange={(e) => set("reminderPickupSubject", e.target.value)} /></Field>
        </div>
        <div className="faint reminder-placeholders">{t(PLACEHOLDERS)}</div>
        <RichTextEditor disabled={!pickupEnabled} value={settings.reminderPickupTemplate} onChange={(value) => set("reminderPickupTemplate", value)} />
      </>}
    </div>
    <div className={`card reminder-card ${returnEnabled ? "" : "disabled"}`}>
      <h2 className="card-title">{t("Return reminder")}</h2>
      {loading ? <Skeleton rows={6} height={28} /> : <>
        <label className="checkbox-row">
          <input type="checkbox" checked={returnEnabled} onChange={(event) => set("reminderReturnEnabled", event.target.checked ? "1" : "0")} />
          {t("Send return reminders")}
        </label>
        <div className="form-grid">
          <Field label={t("Hours before return")}><input disabled={!returnEnabled} type="number" min="1" step="1" value={settings.reminderReturnHours} onChange={(e) => set("reminderReturnHours", e.target.value)} /></Field>
          <Field label={t("Subject")}><input disabled={!returnEnabled} type="text" value={settings.reminderReturnSubject} onChange={(e) => set("reminderReturnSubject", e.target.value)} /></Field>
        </div>
        <div className="faint reminder-placeholders">{t(PLACEHOLDERS)}</div>
        <RichTextEditor disabled={!returnEnabled} value={settings.reminderReturnTemplate} onChange={(value) => set("reminderReturnTemplate", value)} />
      </>}
    </div>
  </div>;
}
