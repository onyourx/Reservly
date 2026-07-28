import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { EmptyState, ErrorNote, Skeleton } from "../components/ui";
import { fmtDateTime } from "../format";

type Entry = {
  id: string; product_no: string; session_id?: string; store_id?: string;
  date_from: string; date_to: string; customer_name: string; customer_email: string;
  customer_phone: string; qty: number; status: string; notified_at?: string; created_at: string;
};

export function WaitlistPage() {
  const [rows, setRows] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    setLoading(true);
    api<{ waitlist: Entry[] }>("/api/waitlist").then((d) => setRows(d.waitlist)).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const remove = async (id: string) => { await api(`/api/waitlist/${id}`, { method: "DELETE" }); load(); };
  return <div className="page">
    <div className="page-head"><div><h1>Waitlist</h1><p>Customers waiting for rentals, classes, and events</p></div></div>
    {error ? <ErrorNote message={error} onRetry={load} /> : loading ? <div className="card"><Skeleton /></div> :
      !rows.length ? <div className="card"><EmptyState title="No customers waiting" /></div> :
      <div className="card"><div className="table-wrap"><table className="table">
        <thead><tr><th>Customer</th><th>Product / slot</th><th>Qty</th><th>Status</th><th>Joined</th><th></th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}>
          <td><strong>{r.customer_name || r.customer_email}</strong><div className="faint">{r.customer_email}{r.customer_phone ? ` · ${r.customer_phone}` : ""}</div></td>
          <td><span className="mono">{r.product_no}</span><div className="faint">{r.session_id || (r.date_from ? `${fmtDateTime(r.date_from)} → ${fmtDateTime(r.date_to)}` : "Any upcoming slot")}</div></td>
          <td>{r.qty}</td><td><span className="badge">{r.status}</span>{r.notified_at && <div className="faint">{fmtDateTime(r.notified_at)}</div>}</td>
          <td>{fmtDateTime(r.created_at)}</td><td><button className="btn btn-sm" onClick={() => void remove(r.id)}>Remove</button></td>
        </tr>)}</tbody>
      </table></div></div>}
  </div>;
}
