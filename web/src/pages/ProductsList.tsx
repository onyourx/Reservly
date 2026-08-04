import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs } from "../api";
import type { Health, Product, ProductType } from "../api";
import { money } from "../format";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";
import { useI18n } from "../components/I18n";

const emptyForm = {
  productNo: "",
  type: "RENTAL" as ProductType,
  name: "",
  defaultUnitPrice: "0",
  securityDeposit: "0",
  durationType: "Days",
  duration: "1",
  sku: "",
  minQty: "1",
  maxQty: "10",
  availableOnWeb: true,
};

export function ProductsList({ typeFilter = "RENTAL" }: { typeFilter?: ProductType }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ ...emptyForm, type: typeFilter });
  const [health, setHealth] = useState<Health | null>(null);
  const [localization, setLocalization] = useState<{
    languages: string[]; summary: { complete: number; incomplete: number; total: number };
    products: { productNo: string; missing: string[] }[];
  } | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ products: Product[] }>(`/api/products${qs({ type: typeFilter, q: debouncedQ })}`)
      .then((d) => setProducts(d.products))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [typeFilter, debouncedQ]);

  useEffect(() => {
    setForm({ ...emptyForm, type: typeFilter });
  }, [typeFilter]);

  useEffect(load, [load]);
  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    api<typeof localization>("/api/localization").then(setLocalization).catch(() => setLocalization(null));
  }, [products]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { synced } = await api<{ synced: number }>("/api/products/sync", {
        method: "POST",
        body: {},
      });
      toast.success(`Synced ${synced} products from NAV`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const createProduct = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      const { product } = await api<{ product: Product }>("/api/products", {
        method: "POST",
        body: {
          ...form,
          productNo: form.productNo.trim(),
          name: form.name.trim(),
          sku: form.sku.trim(),
          defaultUnitPrice: Number(form.defaultUnitPrice) || 0,
          securityDeposit: Number(form.securityDeposit) || 0,
          duration: Number(form.duration) || 0,
          minQty: Number(form.minQty) || 1,
          maxQty: Number(form.maxQty) || 10,
        },
      });
      toast.success(t("Product created"));
      setAdding(false);
      setForm({ ...emptyForm, type: typeFilter });
      navigate(`/products/${product.id}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not create product";
      toast.error(message === "product_exists" ? t("Product already exists") : message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t(typeFilter === "RENTAL" ? "Rentals" : typeFilter === "COURSE" ? "Courses" : "Services")}</h1>
          <div className="page-sub">{t("Rental equipment and courses synced from NAV")}</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            {t("New product")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={syncing}
            onClick={() => void sync()}
          >
            {syncing && <Spinner small />} {t("Sync from ERP")}
          </button>
        </div>
      </div>

      {localization && (
        <div className={`localization-bar ${localization.summary.incomplete ? "has-missing" : ""}`}>
          <div>
            <strong>Localization</strong>
            <span>{localization.summary.complete}/{localization.summary.total} products complete across {localization.languages.map((x) => x.toUpperCase()).join(", ")}</span>
          </div>
          {localization.summary.incomplete > 0 && <span className="badge">{localization.summary.incomplete} need attention</span>}
        </div>
      )}

      <div className="filters">
        <input
          type="text"
          placeholder="Search name or product no…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <div className="card">
          <Skeleton rows={5} height={22} />
        </div>
      ) : !products || products.length === 0 ? (
        <div className="card">
          <EmptyState
            title={`No ${typeFilter === "RENTAL" ? "rental" : typeFilter === "COURSE" ? "course" : "service"} products`}
            hint='Use "Sync from ERP" to pull the catalogue.'
          />
        </div>
      ) : (
        <div className="product-grid">
          {products.map((p) => (
            <div
              key={p.id}
              className="product-card"
              onClick={() => navigate(`/products/${p.id}`)}
            >
              <div className="product-thumb">
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt={p.name} loading="lazy" />
                ) : (
                  <span>{p.type === "RENTAL" ? "📷" : "🎓"}</span>
                )}
              </div>
              <div className="product-body">
                <div className="faint mono">{p.productNo}</div>
                <div className="faint mono">{p.sku ? p.sku : "—"}</div>
                <div className="product-name">{p.name}</div>
                <div className="product-meta">
                  <div>
                    <div style={{ fontWeight: 650 }}>{money(p.defaultUnitPrice)}</div>
                    {p.securityDeposit > 0 && (
                      <div className="faint">deposit {money(p.securityDeposit)}</div>
                    )}
                  </div>
                  <span className={`badge ${p.availableOnWeb ? "" : "badge-off"}`}>
                    {p.availableOnWeb ? "On web" : "Store only"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && (
        <Modal
          title={t("New product")}
          onClose={() => !creating && setAdding(false)}
          wide
          footer={
            <div className="btn-row">
              <button type="button" className="btn" disabled={creating} onClick={() => setAdding(false)}>
                {t("Cancel")}
              </button>
              <button type="submit" form="create-product-form" className="btn btn-primary" disabled={creating}>
                {creating && <Spinner small />} {t("Create product")}
              </button>
            </div>
          }
        >
          <form id="create-product-form" onSubmit={(event) => void createProduct(event)}>
            <div className="grid-2">
              <Field label={t("Type")}>
                <select
                  value={form.type}
                  disabled
                >
                  <option value="RENTAL">RENTAL</option>
                  <option value="COURSE">COURSE</option>
                  <option value="SERVICE">SERVICE</option>
                </select>
              </Field>
              <Field label={t("Product number")}>
                <input required value={form.productNo} onChange={(e) => setForm({ ...form, productNo: e.target.value })} />
              </Field>
              <Field label={t("Name")}>
                <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="Price">
                <input type="number" min="0" step="0.01" value={form.defaultUnitPrice} onChange={(e) => setForm({ ...form, defaultUnitPrice: e.target.value })} />
              </Field>
              {form.type === "RENTAL" ? (
                <>
                  <Field label="Security deposit">
                    <input type="number" min="0" step="0.01" value={form.securityDeposit} onChange={(e) => setForm({ ...form, securityDeposit: e.target.value })} />
                  </Field>
                  <Field label="Duration type">
                    <select value={form.durationType} onChange={(e) => setForm({ ...form, durationType: e.target.value })}>
                      <option value="Hours">Hours</option>
                      <option value="Days">Days</option>
                      <option value="Weeks">Weeks</option>
                    </select>
                  </Field>
                  <Field label="Duration">
                    <input type="number" min="0" step="1" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value })} />
                  </Field>
                </>
              ) : form.type === "COURSE" ? (
                <div className="faint">Course scheduling is configured on the Courses page.</div>
              ) : (
                <Field label="Duration (hours)" hint="Appointment length in hours">
                  <input type="number" min="0" step="0.25" value={form.duration} onChange={(e) => setForm({ ...form, duration: e.target.value, durationType: "Hours" })} />
                </Field>
              )}
              <Field label={t("SKU")}>
                <input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
              </Field>
              {form.type !== "SERVICE" && <>
                <Field label="Minimum quantity">
                  <input type="number" min="1" value={form.minQty} onChange={(e) => setForm({ ...form, minQty: e.target.value })} />
                </Field>
                <Field label="Maximum quantity">
                  <input type="number" min="1" value={form.maxQty} onChange={(e) => setForm({ ...form, maxQty: e.target.value })} />
                </Field>
              </>}
            </div>
            <label className="checkbox-row" style={{ marginTop: 14 }}>
              <input type="checkbox" checked={form.availableOnWeb} onChange={(e) => setForm({ ...form, availableOnWeb: e.target.checked })} />
              Available on web
            </label>
            {health?.navMode === "mock" && (
              <div className="faint" style={{ marginTop: 10 }}>{t("NAV is in mock mode — push is simulated")}</div>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
