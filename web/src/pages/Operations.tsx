import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs, type OperationsData, type OperationPhase } from "../api";
import { fmtTime, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { StatusPill } from "../components/StatusPill";
import { EmptyState, ErrorNote, Skeleton } from "../components/ui";
import { useI18n } from "../components/I18n";

const PHASES: { key: OperationPhase | "ALL"; label: string }[] = [
  { key: "ALL", label: "All activity" },
  { key: "PICKUP", label: "Pickups" },
  { key: "RETURN", label: "Returns" },
  { key: "CLASS", label: "Classes" },
  { key: "ON_RENT", label: "On rent" },
];

function shiftDate(value: string, days: number) {
  const d = new Date(`${value}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

export function Operations() {
  const { t } = useI18n();
  const { storeId, storeName } = useStores();
  const [date, setDate] = useState(todayISO());
  const [phase, setPhase] = useState<OperationPhase | "ALL">("ALL");
  const [data, setData] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<OperationsData>(`/api/operations${qs({ date, storeId })}`)
      .then(setData).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [date, storeId]);
  useEffect(load, [load]);

  const items = useMemo(
    () => data?.items.filter((item) => phase === "ALL" || item.phase === phase) ?? [],
    [data, phase],
  );
  const isToday = date === todayISO();

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Operations")}</h1>
          <div className="page-sub">{t("One view of today's work, readiness, and exceptions")}</div>
        </div>
        <div className="date-nav">
          <button className="btn btn-sm" onClick={() => setDate(shiftDate(date, -1))}>←</button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-sm" onClick={() => setDate(shiftDate(date, 1))}>→</button>
          {!isToday && <button className="btn btn-sm" onClick={() => setDate(todayISO())}>{t("Today")}</button>}
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}
      <div className="ops-layout">
        <div>
          <div className="ops-summary">
            {PHASES.slice(1).map(({ key, label }) => (
              <button key={key} className={`ops-stat ${phase === key ? "active" : ""}`} onClick={() => setPhase(key)}>
                <span>{label}</span>
                <strong>{data ? data.summary[key === "PICKUP" ? "pickups" : key === "RETURN" ? "returns" : key === "CLASS" ? "classes" : "onRent"] : "—"}</strong>
              </button>
            ))}
          </div>
          <div className="card">
            <div className="ops-card-head">
              <h2 className="card-title">{t("Daily agenda")}</h2>
              <div className="segmented">
                {PHASES.map((p) => <button key={p.key} className={phase === p.key ? "active" : ""} onClick={() => setPhase(p.key)}>{t(p.label)}</button>)}
              </div>
            </div>
            {loading ? <Skeleton rows={7} height={30} /> : items.length === 0 ? (
              <EmptyState title={t("Nothing scheduled")} hint="Try another activity filter or date." />
            ) : (
              <div className="agenda">
                {items.map((item) => (
                  <Link to={`/bookings/${item.bookingId}`} className="agenda-item" key={item.id}>
                    <div className="agenda-time">{item.phase === "ON_RENT" ? "All day" : fmtTime(item.startsAt)}</div>
                    <span className={`phase phase-${item.phase.toLowerCase()}`}>{item.phase.replace("_", " ")}</span>
                    <div className="agenda-main">
                      <strong>{item.productName}</strong>
                      <span>{item.customer.firstName} {item.customer.lastName} · <span className="mono">{item.ref}</span> · qty {item.qty}</span>
                    </div>
                    {item.phase === "PICKUP" && (
                      <div className="readiness" aria-label="Pickup readiness">
                        <span className={item.readiness.paid ? "ready" : ""}>Payment</span>
                        <span className={item.readiness.signed ? "ready" : ""}>Contract</span>
                        <span className={item.readiness.checklistTotal === item.readiness.checklistDone ? "ready" : ""}>Kit {item.readiness.checklistDone}/{item.readiness.checklistTotal}</span>
                      </div>
                    )}
                    <StatusPill status={item.status} />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="card attention-card">
          <div className="attention-title">
            <h2 className="card-title">{t("Needs attention")}</h2>
            <span className="attention-count">{data?.summary.needsAttention ?? 0}</span>
          </div>
          {loading ? <Skeleton rows={5} /> : !data?.attention.length ? (
            <EmptyState title={t("All clear")} hint="No operational exceptions for this day." />
          ) : data.attention.map((item) => (
            <Link to={`/bookings/${item.bookingId}`} className={`attention-item ${item.severity}`} key={item.id}>
              <span className="attention-dot" />
              <div><strong>{item.label}</strong><span>{item.customer.firstName} {item.customer.lastName} · {item.ref}</span></div>
            </Link>
          ))}
          <div className="attention-foot">Showing {storeId ? storeName(storeId) : "all stores"}</div>
        </aside>
      </div>
    </div>
  );
}
