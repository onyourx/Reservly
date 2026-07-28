import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs, type RentalAvailability } from "../api";
import { useStores } from "./StoreContext";
import { ErrorNote, Skeleton } from "./ui";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface RentalAvailabilityCalendarProps {
  productNo: string;
  storeId?: string;
  selectable?: boolean;
  rangeFrom?: string;
  rangeTo?: string;
  onRange?: (fromISO: string, toISO: string) => void;
}

export function RentalAvailabilityCalendar({
  productNo,
  storeId: providedStoreId,
  selectable = false,
  rangeFrom,
  rangeTo,
  onRange,
}: RentalAvailabilityCalendarProps) {
  const { stores, storeId: globalStoreId } = useStores();
  const today = new Date();
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [internalStoreId, setInternalStoreId] = useState(globalStoreId);
  const storeId = providedStoreId ?? internalStoreId;
  const [selectionStart, setSelectionStart] = useState(rangeFrom ?? "");
  const [selectionEnd, setSelectionEnd] = useState(rangeTo ?? "");
  const [data, setData] = useState<RentalAvailability | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (providedStoreId !== undefined) return;
    if (globalStoreId) setInternalStoreId(globalStoreId);
    else if (!internalStoreId && stores[0]) setInternalStoreId(stores[0].id);
  }, [providedStoreId, globalStoreId, internalStoreId, stores]);

  useEffect(() => setSelectionStart(rangeFrom ?? ""), [rangeFrom]);
  useEffect(() => setSelectionEnd(rangeTo ?? ""), [rangeTo]);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const load = useCallback(() => {
    if (!storeId) return;
    setLoading(true); setError(null);
    api<RentalAvailability>(`/api/availability/rental${qs({ productNo, storeId, from: iso(first), to: iso(last) })}`)
      .then(setData).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productNo, storeId, month.getFullYear(), month.getMonth()]);
  useEffect(load, [load]);

  const cells = useMemo(() => {
    const out: ({ date: Date; inMonth: boolean } | null)[] = Array(first.getDay()).fill(null);
    for (let day = 1; day <= last.getDate(); day++) out.push({ date: new Date(month.getFullYear(), month.getMonth(), day), inMonth: true });
    while (out.length % 7) out.push(null);
    return out;
  }, [month]);
  const quantity = new Map(data?.perDay.map((x) => [x.date, x.qty]) || []);
  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1));
  const selectDay = (date: string, qty: number) => {
    if (!selectable || qty === 0) return;
    if (!selectionStart || selectionEnd || date < selectionStart) {
      setSelectionStart(date);
      setSelectionEnd("");
      return;
    }
    setSelectionEnd(date);
    onRange?.(selectionStart, date);
  };

  return (
    <div className="card rental-calendar">
      <div className="calendar-head">
        <div>
          <h2 className="card-title">Availability calendar</h2>
          <div className="faint">Available units after bookings, service status, and scheduled maintenance.</div>
        </div>
        <div className="calendar-controls">
          {providedStoreId === undefined && (
            <select value={storeId} onChange={(e) => setInternalStoreId(e.target.value)} aria-label="Calendar store">
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          )}
          <button className="btn btn-sm" onClick={() => shift(-1)} aria-label="Previous month">←</button>
          <strong>{MONTHS[month.getMonth()]} {month.getFullYear()}</strong>
          <button className="btn btn-sm" onClick={() => shift(1)} aria-label="Next month">→</button>
          {(month.getMonth() !== today.getMonth() || month.getFullYear() !== today.getFullYear()) &&
            <button className="btn btn-sm" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button>}
        </div>
      </div>
      {error && <ErrorNote message={error} onRetry={load} />}
      {loading ? <Skeleton rows={5} height={48} /> : (
        <div className="calendar-grid">
          {WEEKDAYS.map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
          {cells.map((cell, index) => {
            if (!cell) return <div className="calendar-day outside" key={`blank-${index}`} />;
            const key = iso(cell.date);
            const qty = quantity.get(key) ?? 0;
            const isToday = key === iso(today);
            const isStart = selectable && key === selectionStart;
            const isEnd = selectable && key === selectionEnd;
            const inRange = selectable && Boolean(selectionStart && selectionEnd && key > selectionStart && key < selectionEnd);
            return (
              <div
                className={`calendar-day ${qty === 0 ? "none" : qty === 1 ? "low" : "open"} ${isToday ? "today" : ""} ${isStart ? "sel-start" : ""} ${isEnd ? "sel-end" : ""} ${inRange ? "in-range" : ""} ${selectable ? "selectable" : ""}`}
                key={key}
                onClick={selectable ? () => selectDay(key, qty) : undefined}
                role={selectable && qty > 0 ? "button" : undefined}
                tabIndex={selectable && qty > 0 ? 0 : undefined}
                onKeyDown={selectable && qty > 0 ? (event) => {
                  if (event.key === "Enter" || event.key === " ") selectDay(key, qty);
                } : undefined}
              >
                <span className="calendar-date">{cell.date.getDate()}</span>
                <strong>{qty}</strong>
                <small>{qty === 1 ? "unit" : "units"} available</small>
              </div>
            );
          })}
        </div>
      )}
      <div className="calendar-legend"><span className="open">Available</span><span className="low">Last unit</span><span className="none">Unavailable</span></div>
    </div>
  );
}
