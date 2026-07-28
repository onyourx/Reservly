import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, qs } from "../api";
import type { BookingLite, BookingStatus } from "../api";
import { fmtDateTime, money, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { StatusPill } from "../components/StatusPill";
import { EmptyState, ErrorNote, Skeleton } from "../components/ui";
import { useI18n } from "../components/I18n";

const STATUSES: BookingStatus[] = [
  "RESERVED",
  "POS_PENDING",
  "PAID",
  "PICKED_UP",
  "RETURNED",
  "COMPLETED",
  "CANCELLED",
];

function lineDates(b: BookingLite): string {
  if (!b.lines || b.lines.length === 0) return "—";
  const froms = b.lines.map((l) => l.from).filter(Boolean).sort();
  const tos = b.lines.map((l) => l.to).filter(Boolean).sort();
  const from = froms[0];
  const to = tos[tos.length - 1];
  if (!from) return "—";
  return to && to !== from ? `${fmtDateTime(from)} → ${fmtDateTime(to)}` : fmtDateTime(from);
}

export function BookingsList() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { stores, storeId: globalStoreId, storeName } = useStores();

  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [storeFilter, setStoreFilter] = useState(globalStoreId);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [dateFilter, setDateFilter] = useState("");

  const [bookings, setBookings] = useState<BookingLite[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Follow the global store selector when it changes.
  useEffect(() => {
    setStoreFilter(globalStoreId);
  }, [globalStoreId]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ bookings: BookingLite[] }>(
      `/api/bookings${qs({ status, type, storeId: storeFilter, q: debouncedQ, date: dateFilter })}`,
    )
      .then((d) => setBookings(d.bookings))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [status, type, storeFilter, debouncedQ, dateFilter]);

  useEffect(load, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Bookings")}</h1>
          <div className="page-sub">{t("Rentals and course reservations")}</div>
        </div>
        <div className="btn-row">
          <Link to="/bookings/new" className="btn btn-primary">
            {t("New booking")}
          </Link>
          <Link to="/waitlist" className="btn">
            {t("Waitlist")}
          </Link>
        </div>
      </div>

      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">{t("All statuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">{t("All types")}</option>
          <option value="RENTAL">{t("Rental")}</option>
          <option value="COURSE">{t("Course")}</option>
          <option value="MIXED">{t("Mixed")}</option>
        </select>
        <select
          value={storeFilter}
          onChange={(e) => setStoreFilter(e.target.value)}
          aria-label="Store"
        >
          <option value="">All stores</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Search ref, customer, email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          type="date"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          aria-label="Date"
        />
        <button
          type="button"
          className={`btn ${dateFilter === todayISO() ? "active" : ""}`}
          onClick={() => setDateFilter(dateFilter === todayISO() ? "" : todayISO())}
        >
          {t("Today")}
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="card">
        {loading ? (
          <Skeleton rows={6} height={20} />
        ) : !bookings || bookings.length === 0 ? (
          <EmptyState
            title="No bookings found"
            hint="Try clearing filters, or create a new booking."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Customer</th>
                  <th>Type</th>
                  <th>Store</th>
                  <th>Dates</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr
                    key={b.id}
                    className="clickable"
                    onClick={() => navigate(`/bookings/${b.id}`)}
                  >
                    <td className="mono">{b.ref}</td>
                    <td>
                      {b.customer ? `${b.customer.firstName} ${b.customer.lastName}` : "—"}
                      {b.customer?.b2b && (
                        <span className="badge" style={{ marginLeft: 6 }}>
                          B2B
                        </span>
                      )}
                    </td>
                    <td className="muted">{b.type}</td>
                    <td className="muted">{storeName(b.storeId)}</td>
                    <td className="muted">{lineDates(b)}</td>
                    <td className="num">{money(b.total)}</td>
                    <td>
                      <StatusPill status={b.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
