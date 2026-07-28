import { useEffect, useState } from "react";
import { api, qs } from "../api";
import { money } from "../format";
import { useI18n } from "../components/I18n";
import { ErrorNote, Skeleton } from "../components/ui";

type Summary = {
  totals: { bookings: number; sales: number; averageOrder: number };
  topServices: { productNo: string; name: string; bookings: number; units: number; sales: number }[];
};

const ago = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);
const localToday = (() => {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
})();
const monthStart = `${localToday.slice(0, 8)}01`;
const validDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export function Reports() {
  const { t } = useI18n();
  const [from, setFrom] = useState(ago);
  const [to, setTo] = useState(today);
  const [exportFrom, setExportFrom] = useState(monthStart);
  const [exportTo, setExportTo] = useState(localToday);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const canDownload = validDate(exportFrom) && validDate(exportTo) && exportFrom <= exportTo;
  const load = () => {
    setError("");
    api<Summary>(`/api/reports/summary${qs({ from, to })}`).then(setData).catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);
  return <div className="page">
    <div className="page-head"><div><h1>Reports</h1><p>Bookings, sales, and service performance</p></div>
      <div className="btn-row">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button className="btn" onClick={load}>Apply</button>
        <a className="btn btn-primary" href={`/api/reports/appointments.csv${qs({ from, to })}`}>Export CSV</a>
        <a className="btn" target="_blank" rel="noreferrer" href={`/print/run-sheet${qs({ date: to })}`}>Run sheet</a>
      </div>
    </div>
    <div className="card" style={{ marginBottom: 18 }}>
      <h2 className="card-title">{t("Export booking log")}</h2>
      <div className="btn-row">
        <label className="field">
          <span className="field-label">{t("From")}</span>
          <input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t("To")}</span>
          <input type="date" value={exportTo} min={exportFrom} onChange={(e) => setExportTo(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canDownload}
          onClick={() => window.open(`/api/reports/bookings.csv${qs({ from: exportFrom, to: exportTo })}`, "_self")}
        >{t("Download")}</button>
      </div>
    </div>
    {error ? <ErrorNote message={error} onRetry={load} /> : !data ? <div className="card"><Skeleton /></div> : <>
      <div className="stats-grid">
        <div className="stat-card"><span>Bookings</span><strong>{data.totals.bookings}</strong></div>
        <div className="stat-card"><span>Sales</span><strong>{money(data.totals.sales)}</strong></div>
        <div className="stat-card"><span>Average booking</span><strong>{money(data.totals.averageOrder)}</strong></div>
      </div>
      <div className="card"><h2 className="card-title">Top services</h2><div className="table-wrap"><table className="table">
        <thead><tr><th>Service</th><th className="num">Bookings</th><th className="num">Units</th><th className="num">Sales</th></tr></thead>
        <tbody>{data.topServices.map((s) => <tr key={s.productNo}><td><strong>{s.name}</strong><div className="faint mono">{s.productNo}</div></td><td className="num">{s.bookings}</td><td className="num">{s.units}</td><td className="num">{money(s.sales)}</td></tr>)}</tbody>
      </table></div></div>
    </>}
  </div>;
}
