import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api";
import type { BookingLite, DashboardData, ExtensionRequest, ExtensionRequestsResponse } from "../api";
import { fmtDate, fmtTime, money, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { StatusPill } from "../components/StatusPill";
import { EmptyState, ErrorNote, Skeleton } from "../components/ui";
import { useI18n } from "../components/I18n";
import { useToast } from "../components/Toast";

function BookingMini({ b }: { b: BookingLite }) {
  return (
    <div className="dash-item">
      <div className="dash-item-main">
        <div className="dash-item-title">
          <Link to={`/bookings/${b.id}`}>{b.ref}</Link>
          {" · "}
          {b.customer ? `${b.customer.firstName} ${b.customer.lastName}` : "—"}
        </div>
        <div className="faint">{money(b.total, b.currency)}</div>
      </div>
      <StatusPill status={b.status} />
    </div>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const toast = useToast();
  const { storeId, storeName } = useStores();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [extensionRequests, setExtensionRequests] = useState<ExtensionRequest[]>([]);
  const [extensionBookingIds, setExtensionBookingIds] = useState<Record<string, string>>({});
  const [extensionsLoaded, setExtensionsLoaded] = useState(false);
  const [extensionsError, setExtensionsError] = useState(false);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [extensionActing, setExtensionActing] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<DashboardData>(`/api/dashboard/today${qs({ storeId })}`)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [storeId]);

  useEffect(load, [load]);

  const loadExtensions = useCallback(async () => {
    try {
      const [extensionData, bookingData] = await Promise.all([
        api<ExtensionRequestsResponse>("/api/extension-requests?status=REQUESTED"),
        api<{ bookings: BookingLite[] }>("/api/bookings?type=RENTAL,COURSE"),
      ]);
      setExtensionRequests(extensionData.requests.filter((request) => request.status === "REQUESTED"));
      setExtensionBookingIds(Object.fromEntries(bookingData.bookings.map((booking) => [booking.ref, booking.id])));
      setExtensionsError(false);
    } catch {
      setExtensionsError(true);
    } finally {
      setExtensionsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadExtensions();
    const interval = window.setInterval(() => void loadExtensions(), 60_000);
    return () => window.clearInterval(interval);
  }, [loadExtensions]);

  const approveExtension = async (requestId: string) => {
    setExtensionActing(requestId);
    try {
      await api<{ ok: boolean }>(`/api/extension-requests/${requestId}/approve`, { method: "POST", body: {} });
      toast.success(t("Approved"));
      await loadExtensions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Approve"));
    } finally {
      setExtensionActing(null);
    }
  };

  const rejectExtension = async (requestId: string) => {
    setExtensionActing(requestId);
    try {
      await api<{ ok: boolean }>(`/api/extension-requests/${requestId}/reject`, {
        method: "POST",
        body: { reason: rejectReason || undefined },
      });
      toast.success(t("Rejected"));
      setRejectingId(null);
      setRejectReason("");
      await loadExtensions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Reject"));
    } finally {
      setExtensionActing(null);
    }
  };

  const printDaily = () => {
    window.open(`/print/daily${qs({ date: todayISO(), storeId })}`, "_blank");
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Dashboard")}</h1>
          <div className="page-sub">
            {t("Today at")} {storeId ? storeName(storeId) : t("All stores").toLowerCase()}
          </div>
        </div>
        <div className="btn-row">
          <Link to="/operations" className="btn">
            {t("Operations")}
          </Link>
          <button type="button" className="btn btn-primary" onClick={printDaily}>
            Print today&apos;s packing lists
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="stat-grid">
        {(
          [
            [t("Active rentals"), data ? String(data.stats.activeRentals) : null],
            [t("Today revenue"), data ? money(data.stats.todayRevenue) : null],
            [t("Upcoming 7 days"), data ? String(data.stats.upcoming7d) : null],
            [t("Open deposits"), data ? money(data.stats.openDeposits) : null],
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
          <h2 className="card-title">{t("Today's pickups")}</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.pickups.length === 0 ? (
            <EmptyState title={t("No pickups today")} />
          ) : (
            data.pickups.map((b) => <BookingMini key={b.id} b={b} />)
          )}
        </div>

        <div className="card">
          <h2 className="card-title">{t("Today's returns")}</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.returns.length === 0 ? (
            <EmptyState title={t("No returns today")} />
          ) : (
            data.returns.map((b) => <BookingMini key={b.id} b={b} />)
          )}
        </div>

        <div className="card">
          <h2 className="card-title">{t("Today's classes")}</h2>
          {loading ? (
            <Skeleton rows={4} />
          ) : !data || data.classes.length === 0 ? (
            <EmptyState title={t("No classes today")} />
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

        {extensionsLoaded && !extensionsError && extensionRequests.length > 0 && (
          <div className="card">
            <h2 className="card-title">{t("Extension requests")}</h2>
            {extensionRequests.length === 0 ? (
              <EmptyState title={t("No extension requests")} />
            ) : (
              extensionRequests.map((request) => (
                <div className="dash-item" key={request.id}>
                  <div className="dash-item-main">
                    <div className="dash-item-title">
                      {extensionBookingIds[request.bookingRef] ? (
                        <Link to={`/bookings/${extensionBookingIds[request.bookingRef]}`}>{request.bookingRef}</Link>
                      ) : (
                        <span className="mono">{request.bookingRef}</span>
                      )}
                      {" · "}
                      {request.productName}
                    </div>
                    <div className="faint">
                      {fmtDate(request.oldDateTo)} → {fmtDate(request.newDateTo)} · {money(request.price)}
                    </div>
                    {rejectingId === request.id && (
                      <div style={{ marginTop: 8 }}>
                        <textarea
                          aria-label={t("Reason (optional)")}
                          placeholder={t("Reason (optional)")}
                          value={rejectReason}
                          onChange={(event) => setRejectReason(event.target.value)}
                        />
                        <div className="btn-row" style={{ marginTop: 6 }}>
                          <button type="button" className="btn btn-danger btn-sm" disabled={extensionActing !== null} onClick={() => void rejectExtension(request.id)}>
                            {t("Confirm Reject")}
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => { setRejectingId(null); setRejectReason(""); }}>
                            {t("Cancel")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {rejectingId !== request.id && (
                    <div className="btn-row">
                      <button type="button" className="btn btn-primary btn-sm" disabled={extensionActing !== null} onClick={() => void approveExtension(request.id)}>
                        {t("Approve")}
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={extensionActing !== null} onClick={() => { setRejectingId(request.id); setRejectReason(""); }}>
                        {t("Reject")}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
