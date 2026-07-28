import { useCallback, useEffect, useState } from "react";
import { api, qs, type Product, type RentalUnit } from "../api";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton } from "../components/ui";
import { Modal } from "../components/Modal";
import { useI18n } from "../components/I18n";
import { ScanButton } from "../components/BarcodeScanner";

export function Fleet() {
  const { t } = useI18n();
  const { stores, storeId, storeName } = useStores();
  const toast = useToast();
  const [units, setUnits] = useState<RentalUnit[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [filterStoreId, setFilterStoreId] = useState(storeId || "");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ productId: "", storeId, serialNo: "", barcode: "", condition: "GOOD", nextServiceUsage: 25, nextServiceAt: "" });
  const [activeUnit, setActiveUnit] = useState<RentalUnit | null>(null);
  const [unitModal, setUnitModal] = useState<"block" | "service" | null>(null);
  const [blockForm, setBlockForm] = useState({ startsAt: "", endsAt: "", reason: "Maintenance" });
  const [serviceForm, setServiceForm] = useState({ notes: "", nextServiceUsage: 25, nextServiceAt: "" });

  const load = useCallback(() => {
    setError(null);
    api<{ units: RentalUnit[] }>(`/api/rental-units${qs({ storeId: filterStoreId, status, q })}`)
      .then((d) => setUnits(d.units)).catch((e: Error) => setError(e.message));
  }, [filterStoreId, status, q]);
  useEffect(load, [load]);
  useEffect(() => { api<{ products: Product[] }>("/api/products?type=RENTAL").then((d) => setProducts(d.products)); }, []);

  const add = async () => {
    try {
      await api("/api/rental-units", { body: form });
      setAdding(false); setForm({ productId: "", storeId, serialNo: "", barcode: "", condition: "GOOD", nextServiceUsage: 25, nextServiceAt: "" });
      toast.success("Rental unit added"); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not add unit"); }
  };
  const update = async (unit: RentalUnit, patch: Partial<RentalUnit>) => {
    try { await api(`/api/rental-units/${unit.id}`, { method: "PUT", body: patch }); load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); }
  };
  const addBlock = async () => {
    if (!activeUnit) return;
    try {
      await api(`/api/rental-units/${activeUnit.id}/unavailability`, { body: blockForm });
      toast.success("Unavailable dates scheduled"); setUnitModal(null); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not schedule dates"); }
  };
  const recordService = async () => {
    if (!activeUnit) return;
    try {
      await api(`/api/rental-units/${activeUnit.id}/maintenance`, { body: serviceForm });
      toast.success("Maintenance recorded"); setUnitModal(null); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not record maintenance"); }
  };
  const removeBlock = async (unit: RentalUnit, id: string) => {
    await api(`/api/rental-units/${unit.id}/unavailability/${id}`, { method: "DELETE" });
    load();
  };

  return <div className="page">
    <div className="page-head"><div><h1>{t("Rental fleet")}</h1><div className="page-sub">{t("Serialized units, location, condition, and availability")}</div></div>
      <button className="btn btn-primary" onClick={() => { setForm((f) => ({ ...f, storeId })); setAdding(true); }}>{t("Add unit")}</button></div>
    <div className="filters">
      <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{["AVAILABLE","ON_RENT","SERVICE","RETIRED"].map((s) => <option key={s}>{s}</option>)}</select>
      <select aria-label={t("Store")} value={filterStoreId} onChange={(e) => setFilterStoreId(e.target.value)}>
        <option value="">{t("All stores")}</option>
        {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
      </select>
      <input type="text" placeholder="Barcode, serial, product…" value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
    {error && <ErrorNote message={error} onRetry={load} />}
    {units && units.some((u) => u.maintenanceDue) && <div className="error-note" style={{ marginBottom: 12 }}>
      {units.filter((u) => u.maintenanceDue).length} unit{units.filter((u) => u.maintenanceDue).length === 1 ? "" : "s"} due for maintenance
    </div>}
    <div className="card">{units === null ? <Skeleton rows={7} /> : units.length === 0 ? <EmptyState title="No rental units" hint="Add serialized units or clear the filters." /> :
      <div className="table-wrap"><table className="table"><thead><tr><th>Barcode</th><th>Product</th><th>Serial</th><th>Store</th><th>Usage</th><th>Condition</th><th>Status</th><th>Unavailable dates</th><th></th></tr></thead>
      <tbody>{units.map((u) => <tr key={u.id}><td className="mono">{u.barcode}</td><td>{u.productName}<div className="faint mono">{u.productNo}</div></td><td className="mono">{u.serialNo || "—"}</td><td>{storeName(u.storeId)}</td>
        <td><span className={u.maintenanceDue ? "avail-no" : ""}>{u.usageCount || 0}</span>{u.nextServiceUsage != null && <div className="faint">service at {u.nextServiceUsage}</div>}</td>
        <td><select value={u.condition} disabled={u.status === "ON_RENT"} onChange={(e) => void update(u, { condition: e.target.value as RentalUnit["condition"] })}>{["NEW","GOOD","FAIR","DAMAGED"].map((x) => <option key={x}>{x}</option>)}</select></td>
        <td><select value={u.status} disabled={u.status === "ON_RENT"} onChange={(e) => void update(u, { status: e.target.value as RentalUnit["status"] })}>{["AVAILABLE","SERVICE","RETIRED"].concat(u.status === "ON_RENT" ? ["ON_RENT"] : []).map((x) => <option key={x}>{x}</option>)}</select></td>
        <td>{(u.unavailability || []).length === 0 ? "—" : u.unavailability.map((x) => <div className="unit-block" key={x.id}><span>{x.startsAt.slice(0,10)} → {x.endsAt.slice(0,10)}<small>{x.reason}</small></span><button className="icon-btn" aria-label="Remove unavailable dates" onClick={() => void removeBlock(u, x.id)}>×</button></div>)}</td>
        <td><div className="btn-row"><button className="btn btn-sm" onClick={() => { setActiveUnit(u); setBlockForm({ startsAt: "", endsAt: "", reason: "Maintenance" }); setUnitModal("block"); }}>Block dates</button><button className="btn btn-sm" onClick={() => { setActiveUnit(u); setServiceForm({ notes: "", nextServiceUsage: (u.usageCount || 0) + 25, nextServiceAt: "" }); setUnitModal("service"); }}>Service done</button></div></td></tr>)}</tbody></table></div>}</div>
    {adding && <Modal title="Add rental unit" onClose={() => setAdding(false)} footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" disabled={!form.productId || !form.barcode} onClick={() => void add()}>Add unit</button></>}>
      <Field label="Product"><select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}><option value="">Select…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Store"><select value={form.storeId} onChange={(e) => setForm({ ...form, storeId: e.target.value })}><option value="">Select…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <Field label="Barcode"><div className="scanner-button-row"><input type="text" value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} autoFocus /><ScanButton title={t("Scan barcode")} onScan={(code) => setForm((current) => ({ ...current, barcode: code }))} /></div></Field>
      <Field label="Serial number"><div className="scanner-button-row"><input type="text" value={form.serialNo} onChange={(e) => setForm({ ...form, serialNo: e.target.value })} /><ScanButton title={t("Scan serial number")} onScan={(code) => setForm((current) => ({ ...current, serialNo: code }))} /></div></Field>
      <Field label="Condition"><select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>{["NEW","GOOD","FAIR","DAMAGED"].map((x) => <option key={x}>{x}</option>)}</select></Field>
      <div className="form-grid"><Field label="Service every uses"><input type="number" min={1} value={form.nextServiceUsage} onChange={(e) => setForm({ ...form, nextServiceUsage: Number(e.target.value) || 25 })} /></Field><Field label="First service date (optional)"><input type="date" value={form.nextServiceAt} onChange={(e) => setForm({ ...form, nextServiceAt: e.target.value })} /></Field></div>
    </Modal>}
    {unitModal === "block" && activeUnit && <Modal title={`Schedule unavailability · ${activeUnit.barcode}`} onClose={() => setUnitModal(null)} footer={<><button className="btn" onClick={() => setUnitModal(null)}>Cancel</button><button className="btn btn-primary" disabled={!blockForm.startsAt || !blockForm.endsAt} onClick={() => void addBlock()}>Block dates</button></>}>
      <div className="form-grid"><Field label="Unavailable from"><input type="date" value={blockForm.startsAt} onChange={(e) => setBlockForm({ ...blockForm, startsAt: e.target.value })} /></Field><Field label="Unavailable through"><input type="date" value={blockForm.endsAt} min={blockForm.startsAt} onChange={(e) => setBlockForm({ ...blockForm, endsAt: e.target.value })} /></Field></div>
      <Field label="Reason"><input value={blockForm.reason} onChange={(e) => setBlockForm({ ...blockForm, reason: e.target.value })} placeholder="Maintenance, calibration, inspection…" /></Field>
      <div className="faint">The unit remains available before and after this window. Rental availability is reduced only on these dates.</div>
    </Modal>}
    {unitModal === "service" && activeUnit && <Modal title={`Record maintenance · ${activeUnit.barcode}`} onClose={() => setUnitModal(null)} footer={<><button className="btn" onClick={() => setUnitModal(null)}>Cancel</button><button className="btn btn-primary" onClick={() => void recordService()}>Record service</button></>}>
      <Field label="Work completed"><textarea value={serviceForm.notes} onChange={(e) => setServiceForm({ ...serviceForm, notes: e.target.value })} placeholder="Cleaning, calibration, parts replaced…" /></Field>
      <div className="form-grid"><Field label="Next service at usage count"><input type="number" min={(activeUnit.usageCount || 0) + 1} value={serviceForm.nextServiceUsage} onChange={(e) => setServiceForm({ ...serviceForm, nextServiceUsage: Number(e.target.value) })} /></Field><Field label="Next service date (optional)"><input type="date" value={serviceForm.nextServiceAt} onChange={(e) => setServiceForm({ ...serviceForm, nextServiceAt: e.target.value })} /></Field></div>
    </Modal>}
  </div>;
}
