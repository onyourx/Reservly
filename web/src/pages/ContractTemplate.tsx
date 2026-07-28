import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Settings } from "../api";
import { useI18n } from "../components/I18n";
import { RichTextEditor } from "../components/RichTextEditor";
import { useToast } from "../components/Toast";
import { ErrorNote, Skeleton, Spinner } from "../components/ui";

const TEMPLATE_PLACEHOLDERS =
  "{{ref}} {{customerName}} {{customerEmail}} {{customerPhone}} {{store}} {{createdAt}} {{lines}} {{subtotal}} {{deposit}} {{idLast4}} {{signature}} {{date}}";
const STARTER_CONTRACT = `<div style="text-align:center"><h1>Rental Contract — {{ref}}</h1><p>{{store}}</p></div>
<h2>Customer</h2>
<p><strong>{{customerName}}</strong><br>{{customerEmail}} · {{customerPhone}}</p>
<h2>Rental details</h2>
{{lines}}
<p><strong>Rental total:</strong> {{subtotal}} &nbsp; <strong>Security deposit:</strong> {{deposit}}</p>
<h2>Terms</h2>
<p>The customer acknowledges receiving the equipment in the stated condition and agrees to return it by the due date. Late, damaged, or missing items may result in additional charges.</p>
{{signature}}`;

export function ContractTemplate() {
  const { t } = useI18n();
  const toast = useToast();
  const [contractTemplate, setContractTemplate] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    api<{ settings: Partial<Settings> }>("/api/settings")
      .then(({ settings }) => setContractTemplate(settings.contractTemplate || ""))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const { settings } = await api<{ settings: Partial<Settings> }>("/api/settings", {
        method: "PUT", body: { contractTemplate },
      });
      setContractTemplate(settings.contractTemplate ?? contractTemplate);
      toast.success("Settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };

  return <div className="page">
    <div className="page-head">
      <div><h1>{t("Contract template")}</h1><div className="page-sub">{t("Custom HTML for printed & e-signed contracts. Leave empty for built-in layout.")}</div></div>
      <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>{saving && <Spinner small />} {t("Save")}</button>
    </div>
    {error && <ErrorNote message={error} onRetry={load} />}
    <div className="card">
      <h2 className="card-title">{t("Template")}</h2>
      <div className="faint" style={{ marginBottom: 8 }}>Placeholders: <span className="mono" style={{ fontSize: 11 }}>{TEMPLATE_PLACEHOLDERS}</span></div>
      {!loading && !contractTemplate && <button type="button" className="btn btn-sm" style={{ marginBottom: 8 }} onClick={() => setContractTemplate(STARTER_CONTRACT)}>{t("Load editable starter contract")}</button>}
      {loading ? <Skeleton rows={6} height={28} /> : <RichTextEditor value={contractTemplate} onChange={setContractTemplate} />}
    </div>
  </div>;
}
