import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs } from "../api";
import type {
  Booking,
  CourseSlot,
  CrossSellSuggestion,
  Customer,
  Product,
  Quote,
  QuoteLine,
  RentalAvailability,
} from "../api";
import { fmtDate, fmtDateTime, localToISO, money, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { Field, Spinner } from "../components/ui";
import { RentalAvailabilityCalendar } from "../components/RentalAvailabilityCalendar";
import { useI18n } from "../components/I18n";

interface BasketLine {
  key: number;
  ql: QuoteLine;
  label: string;
  sub: string;
}

let nextKey = 1;

/* ---------------- Rental line builder ---------------- */

function RentalBuilder({
  defaultStoreId,
  onAdd,
}: {
  defaultStoreId: string;
  onAdd: (line: BasketLine) => void;
}) {
  const { stores, storeName } = useStores();
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState("");
  const [storeId, setStoreId] = useState(defaultStoreId);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [qty, setQty] = useState(1);
  const [rentalRules, setRentalRules] = useState({
    pickupEarliestTime: "",
    returnByTime: "",
    rentalIncrementUnit: "day",
    rentalIncrementValue: "",
  });
  const { t } = useI18n();

  const [quote, setQuote] = useState<Quote | null>(null);
  const [avail, setAvail] = useState<RentalAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    api<{ products: Product[] }>("/api/products?type=RENTAL")
      .then((d) => setProducts(d.products))
      .catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    api<{ settings: typeof rentalRules }>("/api/settings")
      .then(({ settings }) => setRentalRules((current) => ({ ...current, ...settings })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (defaultStoreId) setStoreId(defaultStoreId);
  }, [defaultStoreId]);

  const fromISO = localToISO(from);
  const toISO = localToISO(to);
  const ready = Boolean(productNo && storeId && fromISO && toISO && qty > 0);

  useEffect(() => {
    setQuote(null);
    setAvail(null);
    setCheckError(null);
    if (!ready) return;
    let cancelled = false;
    setBusy(true);
    const line: QuoteLine = { type: "RENTAL", productNo, storeId, from: fromISO, to: toISO, qty };
    Promise.all([
      api<Quote>("/api/quote", { body: { lines: [line] } }),
      api<RentalAvailability>(
        `/api/availability/rental${qs({ productNo, storeId, from: fromISO, to: toISO })}`,
      ),
    ])
      .then(([q, a]) => {
        if (cancelled) return;
        setQuote(q);
        setAvail(a);
      })
      .catch((e: Error) => {
        if (!cancelled) setCheckError(e.message);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, productNo, storeId, fromISO, toISO, qty]);

  const quoted = quote?.lines[0];
  const product = products.find((p) => p.productNo === productNo);

  const add = () => {
    if (!ready || !quoted) return;
    onAdd({
      key: nextKey++,
      ql: { type: "RENTAL", productNo, storeId, from: fromISO, to: toISO, qty },
      label: quoted.productName || product?.name || productNo,
      sub: `${storeName(storeId)} · ${fmtDateTime(fromISO)} → ${fmtDateTime(toISO)} · qty ${qty}`,
    });
    setProductNo("");
    setFrom("");
    setTo("");
    setQty(1);
  };

  const applyCalendarRange = (fromDate: string, toDate: string) => {
    const timeFor = (value: string, fallback: string) => {
      const time = value.includes("T") ? value.split("T")[1] : "";
      return time || fallback;
    };
    setFrom(`${fromDate}T${timeFor(from, rentalRules.pickupEarliestTime || "09:00")}`);
    setTo(`${toDate}T${timeFor(to, rentalRules.returnByTime || "17:00")}`);
  };

  const increment = Number(rentalRules.rentalIncrementValue);
  const incrementHint = Number.isInteger(increment) && increment > 0
    ? `${t("Rentals are booked in blocks of")} ${increment} ${t(
        rentalRules.rentalIncrementUnit === "hour"
          ? (increment === 1 ? "Hour" : "Hours")
          : (increment === 1 ? "Day" : "Days"),
      ).toLowerCase()}`
    : "";

  return (
    <div className="card">
      <h2 className="card-title">Add rental line</h2>
      {(rentalRules.pickupEarliestTime || rentalRules.returnByTime || incrementHint) && (
        <div className="faint" style={{ marginBottom: 12 }}>
          {[
            rentalRules.pickupEarliestTime ? `${t("Earliest pickup time")}: ${rentalRules.pickupEarliestTime}` : "",
            rentalRules.returnByTime ? `${t("Return by")}: ${rentalRules.returnByTime}` : "",
            incrementHint,
          ].filter(Boolean).join(" · ")}
        </div>
      )}
      <div className="form-grid-3">
        <Field label="Equipment">
          <select value={productNo} onChange={(e) => setProductNo(e.target.value)}>
            <option value="">Select product…</option>
            {products.map((p) => (
              <option key={p.id} value={p.productNo}>
                {p.name} ({p.productNo})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Store">
          <select value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">Select store…</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity">
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
        <Field label="From">
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      {productNo && storeId && (
        <RentalAvailabilityCalendar
          productNo={productNo}
          storeId={storeId}
          selectable
          rangeFrom={from ? from.slice(0, 10) : undefined}
          rangeTo={to ? to.slice(0, 10) : undefined}
          onRange={applyCalendarRange}
        />
      )}

      {checkError && <div className="quote-preview avail-no">{checkError}</div>}

      {ready && !checkError && (
        <div className="quote-preview">
          {busy ? (
            <>
              <Spinner small /> Checking price &amp; availability…
            </>
          ) : (
            <>
              {quoted && (
                <>
                  <span>
                    <strong>{quoted.days ?? "—"}</strong> day{quoted.days === 1 ? "" : "s"}
                  </span>
                  <span>
                    Price <strong>{money(quoted.lineTotal)}</strong>
                  </span>
                  <span>
                    Deposit <strong>{money(quoted.deposit)}</strong>
                  </span>
                </>
              )}
              {avail && (
                <span className={`avail ${avail.available ? "avail-ok" : "avail-no"}`}>
                  {avail.available ? "● Available" : "● Not available"}
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button
          type="button"
          className="btn"
          disabled={!ready || busy || !quoted || avail?.available === false}
          onClick={add}
        >
          Add to basket
        </button>
      </div>
    </div>
  );
}

/* ---------------- Course line builder ---------------- */

function CourseBuilder({ onAdd }: { onAdd: (line: BasketLine) => void }) {
  const { storeName } = useStores();
  const [products, setProducts] = useState<Product[]>([]);
  const [productNo, setProductNo] = useState("");
  const [slots, setSlots] = useState<CourseSlot[] | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [qty, setQty] = useState(1);

  useEffect(() => {
    api<{ products: Product[] }>("/api/products?type=COURSE")
      .then((d) => setProducts(d.products))
      .catch(() => setProducts([]));
  }, []);

  useEffect(() => {
    setSlots(null);
    setSessionId("");
    setSlotsError(null);
    if (!productNo) return;
    let cancelled = false;
    setSlotsLoading(true);
    api<{ slots: CourseSlot[] }>(
      `/api/availability/course${qs({ productNo, from: todayISO(), days: 90 })}`,
    )
      .then((d) => {
        if (!cancelled) setSlots(d.slots);
      })
      .catch((e: Error) => {
        if (!cancelled) setSlotsError(e.message);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productNo]);

  const selected = slots?.find((s) => s.sessionId === sessionId);
  const product = products.find((p) => p.productNo === productNo);

  const add = () => {
    if (!selected || !product) return;
    onAdd({
      key: nextKey++,
      ql: { type: "COURSE", sessionId: selected.sessionId, qty },
      label: product.name,
      sub: `${fmtDate(selected.date)} ${selected.time} · ${storeName(selected.storeId)} · ${qty} seat${qty === 1 ? "" : "s"}`,
    });
    setProductNo("");
    setSlots(null);
    setSessionId("");
    setQty(1);
  };

  return (
    <div className="card">
      <h2 className="card-title">Add course line</h2>
      <div className="form-grid">
        <Field label="Course">
          <select value={productNo} onChange={(e) => setProductNo(e.target.value)}>
            <option value="">Select course…</option>
            {products.map((p) => (
              <option key={p.id} value={p.productNo}>
                {p.name} ({p.productNo})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Seats">
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          />
        </Field>
      </div>

      {slotsLoading && (
        <div className="quote-preview">
          <Spinner small /> Loading upcoming sessions…
        </div>
      )}
      {slotsError && <div className="quote-preview avail-no">{slotsError}</div>}
      {slots && slots.length === 0 && (
        <div className="quote-preview">No upcoming sessions in the next 90 days.</div>
      )}

      {slots && slots.length > 0 && (
        <div className="slot-list">
          {slots.map((s) => {
            const full = s.remaining < qty;
            return (
              <label
                key={s.sessionId}
                className={`slot-item ${sessionId === s.sessionId ? "selected" : ""} ${full ? "slot-full" : ""}`}
              >
                <input
                  type="radio"
                  name="course-slot"
                  checked={sessionId === s.sessionId}
                  disabled={full}
                  onChange={() => setSessionId(s.sessionId)}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {fmtDate(s.date)} at {s.time}
                  </div>
                  <div className="faint">
                    {storeName(s.storeId)}
                    {s.location ? ` · ${s.location}` : ""}
                    {s.trainers.length > 0 ? ` · ${s.trainers.join(", ")}` : ""}
                  </div>
                </div>
                <span className={`avail ${s.remaining > 0 ? "avail-ok" : "avail-no"}`}>
                  {s.remaining} seat{s.remaining === 1 ? "" : "s"} left
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button type="button" className="btn" disabled={!selected} onClick={add}>
          Add to basket
        </button>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */

export function BookingNew() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { stores, storeId: globalStoreId } = useStores();

  const [customer, setCustomer] = useState<Customer>({
    email: "",
    firstName: "",
    lastName: "",
    phone: "",
    b2b: false,
  });
  const [bookingStoreId, setBookingStoreId] = useState(globalStoreId);
  const [notes, setNotes] = useState("");
  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [crossSellSuggestions, setCrossSellSuggestions] = useState<CrossSellSuggestion[]>([]);
  const [totals, setTotals] = useState<Quote | null>(null);
  const [totalsBusy, setTotalsBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [customerLookup, setCustomerLookup] = useState<"loading" | "shopify" | "local" | "new" | null>(null);
  const customerLookupSequence = useRef(0);

  useEffect(() => {
    if (globalStoreId && !bookingStoreId) setBookingStoreId(globalStoreId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalStoreId]);

  // Re-quote the whole basket whenever it changes.
  const basketKey = useMemo(() => JSON.stringify(basket.map((b) => b.ql)), [basket]);
  const basketProductNos = useMemo(
    () => [...new Set(basket.map((line) => line.ql.type === "RENTAL" ? line.ql.productNo : "").filter(Boolean))].sort(),
    [basketKey],
  );
  const basketProductNosKey = basketProductNos.join(",");
  useEffect(() => {
    if (!basketProductNosKey) {
      setCrossSellSuggestions([]);
      return;
    }
    let cancelled = false;
    api<{ suggestions: CrossSellSuggestion[] }>(
      `/api/cross-sell${qs({ productNos: basketProductNosKey })}`,
    ).then(({ suggestions }) => {
      if (!cancelled) setCrossSellSuggestions(suggestions);
    }).catch(() => {
      if (!cancelled) setCrossSellSuggestions([]);
    });
    return () => { cancelled = true; };
  }, [basketProductNosKey]);
  useEffect(() => {
    if (basket.length === 0) {
      setTotals(null);
      return;
    }
    let cancelled = false;
    setTotalsBusy(true);
    api<Quote>("/api/quote", { body: { lines: basket.map((b) => b.ql) } })
      .then((q) => {
        if (!cancelled) setTotals(q);
      })
      .catch((e: Error) => {
        if (!cancelled) toast.error(e.message);
      })
      .finally(() => {
        if (!cancelled) setTotalsBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketKey]);

  const customerOk =
    customer.email.trim() !== "" &&
    customer.firstName.trim() !== "" &&
    customer.lastName.trim() !== "";
  const canCreate = customerOk && bookingStoreId !== "" && basket.length > 0 && !creating;

  const handleQuickAddCrossSell = (suggestion: CrossSellSuggestion) => {
    if (suggestion.type === "RENTAL") {
      setBasket((current) => [...current, {
        key: nextKey++,
        ql: { type: "RENTAL", productNo: suggestion.productNo, storeId: bookingStoreId, from: "", to: "", qty: 1 },
        label: suggestion.name,
        sub: `${stores.find((store) => store.id === bookingStoreId)?.name ?? bookingStoreId} · confirm dates · qty 1`,
      }]);
    } else {
      setBasket((current) => [...current, {
        key: nextKey++,
        ql: { type: "COURSE", sessionId: "", qty: 1 },
        label: suggestion.name,
        sub: "Confirm session · qty 1",
      }]);
    }
    toast.success(t("Item added to basket — confirm dates"));
  };

  const lookupCustomer = async () => {
    const email = customer.email.trim();
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      setCustomerLookup(null);
      return;
    }
    const sequence = ++customerLookupSequence.current;
    setCustomerLookup("loading");
    try {
      const result = await api<{
        found: boolean;
        source?: "shopify" | "local";
        customer?: { email: string; firstName: string; lastName: string; phone: string };
      }>(`/api/customers/lookup${qs({ email })}`);
      if (sequence !== customerLookupSequence.current) return;
      if (!result.found || !result.customer) {
        setCustomerLookup("new");
        return;
      }
      setCustomer((current) => ({
        ...current,
        firstName: current.firstName || result.customer?.firstName || "",
        lastName: current.lastName || result.customer?.lastName || "",
        phone: current.phone || result.customer?.phone || "",
      }));
      setCustomerLookup(result.source === "shopify" ? "shopify" : "local");
    } catch {
      if (sequence === customerLookupSequence.current) setCustomerLookup(null);
    }
  };

  const lookupHint = customerLookup === "shopify"
    ? t("Customer found in Shopify")
    : customerLookup === "local"
      ? t("Returning customer")
      : customerLookup === "new"
        ? t("New customer — will be added to Shopify with this booking")
        : null;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    try {
      const { booking } = await api<{ booking: Booking }>("/api/bookings", {
        body: {
          customer,
          storeId: bookingStoreId,
          channel: "STAFF",
          notes: notes || undefined,
          lines: basket.map((b) => b.ql),
        },
      });
      toast.success(`Booking ${booking.ref} created`);
      navigate(`/bookings/${booking.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create booking");
      setCreating(false);
    }
  };

  const grandTotal = totals ? totals.subtotal + totals.deposit : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>New booking</h1>
          <div className="page-sub">Staff store view — build a basket, then create</div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Customer</h2>
        <div className="form-grid">
          <Field label="Email">
            <input
              type="email"
              value={customer.email}
              onChange={(e) => {
                customerLookupSequence.current += 1;
                setCustomer({ ...customer, email: e.target.value });
                setCustomerLookup(null);
              }}
              onBlur={() => void lookupCustomer()}
              placeholder="customer@example.com"
            />
            {customerLookup === "loading" && (
              <span className="faint"><Spinner small /> {t("Looking up…")}</span>
            )}
            {lookupHint && <span className="faint">{lookupHint}</span>}
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              value={customer.phone}
              onChange={(e) => setCustomer({ ...customer, phone: e.target.value })}
              placeholder="514-555-0100"
            />
          </Field>
          <Field label="First name">
            <input
              type="text"
              value={customer.firstName}
              onChange={(e) => setCustomer({ ...customer, firstName: e.target.value })}
            />
          </Field>
          <Field label="Last name">
            <input
              type="text"
              value={customer.lastName}
              onChange={(e) => setCustomer({ ...customer, lastName: e.target.value })}
            />
          </Field>
          <Field label="Booking store">
            <select value={bookingStoreId} onChange={(e) => setBookingStoreId(e.target.value)}>
              <option value="">Select store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">&nbsp;</span>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={customer.b2b}
                onChange={(e) => setCustomer({ ...customer, b2b: e.target.checked })}
              />
              B2B customer (business account)
            </label>
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />
      <div className="grid-2">
        <RentalBuilder
          defaultStoreId={bookingStoreId}
          onAdd={(l) => setBasket((b) => [...b, l])}
        />
        <CourseBuilder onAdd={(l) => setBasket((b) => [...b, l])} />
      </div>

      <div style={{ height: 18 }} />
      <div className="card">
        <h2 className="card-title">Basket</h2>
        {basket.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">Basket is empty</div>
            <div className="empty-hint">Add rental or course lines above.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Details</th>
                  <th className="num">Price</th>
                  <th className="num">Deposit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {basket.map((line, i) => {
                  const quoted = totals?.lines[i];
                  return (
                    <tr key={line.key}>
                      <td style={{ fontWeight: 600 }}>{line.label}</td>
                      <td className="muted">{line.sub}</td>
                      <td className="num">
                        {totalsBusy ? "…" : quoted ? money(quoted.lineTotal) : "—"}
                      </td>
                      <td className="num">
                        {totalsBusy ? "…" : quoted ? money(quoted.deposit) : "—"}
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() =>
                            setBasket((b) => b.filter((x) => x.key !== line.key))
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {basket.length > 0 && (
          <>
            <hr className="divider" />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 34 }}>
              <div className="meta-item">
                <span className="meta-label">Subtotal</span>
                <span>{totals ? money(totals.subtotal) : "—"}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Deposit</span>
                <span>{totals ? money(totals.deposit) : "—"}</span>
              </div>
              <div className="meta-item">
                <span className="meta-label">Total</span>
                <span className="basket-total">
                  {grandTotal !== null ? money(grandTotal) : "—"}
                </span>
              </div>
            </div>
          </>
        )}

        {crossSellSuggestions.length > 0 && (
          <>
            <hr className="divider" />
            <div className="field-label">{t("Customers also rent")}</div>
            <div className="btn-row" style={{ overflowX: "auto", flexWrap: "nowrap", paddingBottom: 4 }}>
              {crossSellSuggestions.map((suggestion) => (
                <div className="btn-row" key={suggestion.productNo} style={{ flexWrap: "nowrap" }}>
                  <span>{suggestion.name} · {money(suggestion.defaultUnitPrice)}</span>
                  <button type="button" className="btn btn-sm" onClick={() => handleQuickAddCrossSell(suggestion)}>
                    {t("Add to basket")}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <hr className="divider" />
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <textarea
            placeholder="Internal notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ flex: 1, minHeight: 42 }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {creating && <Spinner small />} Create booking
          </button>
        </div>
        {!customerOk && basket.length > 0 && (
          <div className="faint" style={{ textAlign: "right", marginTop: 8 }}>
            Email, first and last name are required to create the booking.
          </div>
        )}
      </div>
    </div>
  );
}
