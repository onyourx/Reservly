import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api";
import type { BookingLite, DashboardData } from "../api";
import { fmtTime, money, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { StatusPill } from "../components/StatusPill";
import { EmptyState, ErrorNote, Skeleton } from "../components/ui";

function BookingMini({ b }: { b: BookingLite }) {
  return (
    <div className="dash-item">
      <div className="dash-item-main">
        <div className="dash-item-title">
          <Link to={`/bookings/${b.id}`}>{b.ref}</Link>
          {" · "}
          {b.customer ? `${b.customer.firstName} ${b.customer.lastName}` : "—"}
        </div>
        <div className="faint">{money(b.total)}</div>
      </div>
      <StatusPill status={b.status} />
    </div>
  );
}

export function Dashboard() {
  const { storeId, storeName } = useStores();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<DashboardData>(`/api/dashboard/today${qs({ storeId })}`)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [storeId]);

  useEffect(load, [load]);

  const printDaily = () => {
    window.open(`/print/daily${qs({ date: todayISO(), storeId })}`, "_blank");
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="page-sub">
            Today at {storeId ? storeName(storeId) : "all stores"}
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={printDaily}>
          Print today&apos;s packing lists
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="stat-grid">
        {(
          [
            ["Active rentals", data ? String(data.stats.activeRentals) : null],
            ["Today revenue", data ? money(data.stats.todayRevenue) : null],
            ["Upcoming 7 days", data ? String(data.stats.upcoming7d) : null],
            ["Open deposits", data ? money(data.stats.openDeposits) : null],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="stat-card">
            <div className="stat-label">{label}</div>
            {loading || value === null ? (
              <div className="skeleton" style={{ height: 28, width: "60%", marginTop: 8 }} />
            ) : (
              <div className="stat-value">{value}</div>
            )}
          </div>
        ))}
      </div>

      <div className="dash-cols">
        <div className="card">
          <h2 className="card-title">Today&apos;s pickups</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.pickups.length === 0 ? (
            <EmptyState title="No pickups today" />
          ) : (
            data.pickups.map((b) => <BookingMini key={b.id} b={b} />)
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Today&apos;s returns</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.returns.length === 0 ? (
            <EmptyState title="No returns today" />
          ) : (
            data.returns.map((b) => <BookingMini key={b.id} b={b} />)
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Today&apos;s classes</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.classes.length === 0 ? (
            <EmptyState title="No classes today" />
          ) : (
            data.classes.map((c) => (
              <div className="dash-item" key={c.session.id}>
                <div className="dash-item-main">
                  <div className="dash-item-title">{c.productName}</div>
                  <div className="faint">
                    {fmtTime(c.session.startsAt)}–{fmtTime(c.session.endsAt)} ·{" "}
                    {storeName(c.session.storeId)}
                  </div>
                </div>
                <span className="badge">
                  {c.booked}/{c.capacity} booked
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
