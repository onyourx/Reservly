import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type BookingLite } from "../api";
import { fmtDateTime, money } from "../format";
import { StatusPill } from "./StatusPill";
import { EmptyState, ErrorNote, Skeleton } from "./ui";

type View = "UPCOMING" | "ACTIVE" | "ALL";
const CLOSED = new Set(["COMPLETED", "CANCELLED", "RETURNED"]);

export function ProductBookings({ productId, productNo }: { productId: string; productNo: string }) {
  const [bookings, setBookings] = useState<BookingLite[] | null>(null);
  const [view, setView] = useState<View>("UPCOMING");
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api<{ bookings: BookingLite[] }>(`/api/products/${productId}/bookings`)
      .then((d) => setBookings(d.bookings)).catch((e: Error) => setError(e.message));
  };
  useEffect(load, [productId]);

  const filtered = useMemo(() => {
    if (!bookings) return [];
    if (view === "ALL") return bookings;
    if (view === "ACTIVE") return bookings.filter((b) => !CLOSED.has(b.status));
    const today = new Date().toISOString().slice(0, 10);
    return bookings.filter((b) => b.status !== "CANCELLED" && (b.lines || []).some((line) => line.to.slice(0, 10) >= today));
  }, [bookings, view]);

  return (
    <div className="card product-bookings">
      <div className="ops-card-head">
        <div>
          <h2 className="card-title">Bookings for this product</h2>
          <div className="faint mono">{productNo}</div>
        </div>
        <div className="segmented">
          {(["UPCOMING", "ACTIVE", "ALL"] as View[]).map((key) => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
              {key.charAt(0) + key.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      </div>
      {error && <ErrorNote message={error} onRetry={load} />}
      {bookings === null ? <Skeleton rows={5} /> : filtered.length === 0 ? (
        <EmptyState title="No matching bookings" hint="Bookings containing this product will appear here." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Booking</th><th>Customer</th><th>Dates</th><th className="num">Qty</th><th>Channel</th><th className="num">Total</th><th>Status</th></tr></thead>
            <tbody>{filtered.map((booking) => {
              const lines = (booking.lines || []).filter((line) => line.productNo === productNo);
              return <tr key={booking.id}>
                <td><Link className="mono" to={`/bookings/${booking.id}`}>{booking.ref}</Link></td>
                <td>{booking.customer.firstName} {booking.customer.lastName}<div className="faint">{booking.customer.email}</div></td>
                <td>{lines.map((line) => <div key={line.id}>{fmtDateTime(line.from)} → {fmtDateTime(line.to)}</div>)}</td>
                <td className="num">{lines.reduce((sum, line) => sum + line.qty, 0)}</td>
                <td><span className="badge">{booking.channel}</span></td>
                <td className="num">{money(booking.total)}</td>
                <td><StatusPill status={booking.status} /></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
