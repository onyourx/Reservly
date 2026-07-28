import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { Product, Resource, Store } from "../api";
import { useToast } from "../components/Toast";
import { EmptyState, Field, Skeleton } from "../components/ui";

type Rule = {
  id: string; scope_type: "STORE" | "PRODUCT" | "RESOURCE"; scope_id: string;
  kind: "OPENING" | "BLACKOUT"; weekday: number | null; starts_at: string; ends_at: string;
  from_time: string; to_time: string; label: string;
};
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export function AvailabilityRulesPage() {
  const toast = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeType, setScopeType] = useState<Rule["scope_type"]>("STORE");
  const [scopeId, setScopeId] = useState("");
  const [kind, setKind] = useState<Rule["kind"]>("OPENING");
  const [weekday, setWeekday] = useState(1);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [label, setLabel] = useState("");
  const load = useCallback(() => {
    Promise.all([
      api<{ rules: Rule[] }>("/api/availability-rules"),
      api<{ stores: Store[] }>("/api/stores"),
      api<{ products: Product[] }>("/api/products"),
      api<{ resources: Resource[] }>("/api/resources"),
    ]).then(([a,b,c,d]) => { setRules(a.rules); setStores(b.stores); setProducts(c.products); setResources(d.resources); })
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const options = scopeType === "STORE" ? stores.map((x) => ({ id: x.id, name: x.name }))
    : scopeType === "PRODUCT" ? products.map((x) => ({ id: x.id, name: `${x.name} (${x.productNo})` }))
    : resources.map((x) => ({ id: x.id, name: x.name }));
  useEffect(() => { if (!options.some((x) => x.id === scopeId)) setScopeId(options[0]?.id || ""); }, [scopeType, stores.length, products.length, resources.length]);
  const add = async () => {
    try {
      await api("/api/availability-rules", { body: { scopeType, scopeId, kind, weekday, from, to, startsAt, endsAt, label } });
      toast.success("Availability rule added"); setLabel(""); load();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not add rule"); }
  };
  const remove = async (id: string) => { await api(`/api/availability-rules/${id}`, { method: "DELETE" }); load(); };
  const scopeName = (r: Rule) => r.scope_type === "STORE" ? stores.find((x) => x.id === r.scope_id)?.name
    : r.scope_type === "PRODUCT" ? products.find((x) => x.id === r.scope_id)?.name : resources.find((x) => x.id === r.scope_id)?.name;
  return <div className="page">
    <div className="page-head"><div><h1>Hours & blackouts</h1><p>Store, product, and resource availability rules</p></div></div>
    <div className="card" style={{ marginBottom: 18 }}><div className="form-grid-3">
      <Field label="Scope"><select value={scopeType} onChange={(e) => setScopeType(e.target.value as typeof scopeType)}><option value="STORE">Store</option><option value="PRODUCT">Product</option><option value="RESOURCE">Resource</option></select></Field>
      <Field label="Applies to"><select value={scopeId} onChange={(e) => setScopeId(e.target.value)}>{options.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
      <Field label="Rule type"><select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="OPENING">Opening hours</option><option value="BLACKOUT">Blackout</option></select></Field>
      {kind === "OPENING" ? <>
        <Field label="Weekday"><select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{DAYS.map((d,i) => <option value={i} key={d}>{d}</option>)}</select></Field>
        <Field label="Opens"><input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Closes"><input type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </> : <>
        <Field label="Starts"><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></Field>
        <Field label="Ends"><input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></Field>
        <Field label="Reason"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Holiday, maintenance…" /></Field>
      </>}
    </div><button className="btn btn-primary" disabled={!scopeId} onClick={() => void add()}>Add rule</button></div>
    <div className="card">{loading ? <Skeleton /> : !rules.length ? <EmptyState title="No availability rules" /> :
      <div className="table-wrap"><table className="table"><thead><tr><th>Scope</th><th>Type</th><th>Schedule</th><th>Label</th><th></th></tr></thead>
        <tbody>{rules.map((r) => <tr key={r.id}><td>{r.scope_type} · {scopeName(r) || r.scope_id}</td><td>{r.kind}</td>
          <td>{r.kind === "OPENING" ? `${DAYS[r.weekday || 0]} ${r.from_time}–${r.to_time}` : `${r.starts_at} → ${r.ends_at}`}</td><td>{r.label || "—"}</td>
          <td><button className="btn btn-sm" onClick={() => void remove(r.id)}>Remove</button></td></tr>)}</tbody>
      </table></div>}</div>
  </div>;
}
