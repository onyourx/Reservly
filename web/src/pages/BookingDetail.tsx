import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api";
import type { Booking, DamageRow } from "../api";
import { fmtDateTime, money } from "../format";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { StatusPill } from "../components/StatusPill";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

type ModalKind = "pickup" | "return" | "cancel" | "reconcile" | null;

/** Event detail arrives as a JSON object from the server; render it as `k: v` pairs. */
function formatEventDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail !== "object") return String(detail);
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

export function BookingDetail() {
  const { id = "" } = useParams();
  const toast = useToast();
  const { storeName } = useStores();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Modal form state
  const [idNumber, setIdNumber] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [inspection, setInspection] = useState("");
  const [damages, setDamages] = useState<DamageRow[]>([]);
  const [cancelReason, setCancelReason] = useState("");
  const [posTotal, setPosTotal] = useState("");
  const [receiptNo, setReceiptNo] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ booking: Booking }>(`/api/bookings/${id}`)
      .then((d) => setBooking(d.booking))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  const act = async (name: string, path: string, body?: unknown) => {
    setActing(name);
    try {
      await api(`/api/bookings/${id}/${path}`, { method: "POST", body: body ?? {} });
      toast.success(`${name} done`);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${name} failed`);
    } finally {
      setActing(null);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="card">
          <Skeleton rows={6} height={20} />
        </div>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="page">
        <h1>Booking</h1>
        <div style={{ height: 16 }} />
        <ErrorNote message={error ?? "Booking not found"} onRetry={load} />
      </div>
    );
  }

  const b = booking;
  const hasRentals = b.lines.some((l) => l.type === "RENTAL");
  const hasCourses = b.lines.some((l) => l.type === "COURSE");
  const active = b.status !== "COMPLETED" && b.status !== "CANCELLED";

  const openPickup = () => {
    setIdNumber("");
    setDepositAmount(String(b.deposit ?? ""));
    setInspection("");
    setModal("pickup");
  };
  const openReturn = () => {
    setInspection("");
    setDamages([]);
    setModal("return");
  };
  const openCancel = () => {
    setCancelReason("");
    setModal("cancel");
  };
  const openReconcile = () => {
    setPosTotal(b.posTotal != null ? String(b.posTotal) : String(b.total ?? ""));
    setReceiptNo(b.posReceiptNo ?? "");
    setModal("reconcile");
  };

  const events = [...b.events].sort((a, c) => (a.at < c.at ? 1 : -1));

  return (
    <div className="page">
      <div className="detail-head">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h1 className="mono">{b.ref}</h1>
            <StatusPill status={b.status} />
          </div>
          <div className="detail-meta">
            <div className="meta-item">
              <span className="meta-label">Customer</span>
              <span>
                {b.customer.firstName} {b.customer.lastName}
                {b.customer.b2b ? " (B2B)" : ""}
              </span>
              <span className="faint">
                {b.customer.email}
                {b.customer.phone ? ` · ${b.customer.phone}` : ""}
              </span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Store</span>
              <span>{storeName(b.storeId)}</span>
            </div>
            <div className="meta-item">
              <span className="meta-label">Channel</span>
              <span>{b.channel}</span>
            </div>
            {b.shopifyOrderId && (
              <div className="meta-item">
                <span className="meta-label">Shopify order</span>
                <span className="mono">{b.shopifyOrderName ?? b.shopifyOrderId}</span>
              </div>
            )}
            <div className="meta-item">
              <span className="meta-label">Created</span>
              <span>{fmtDateTime(b.createdAt)}</span>
            </div>
            {b.idOnFile && (
              <div className="meta-item">
                <span className="meta-label">ID</span>
                <span className="badge">On file</span>
              </div>
            )}
          </div>
        </div>

        <div className="btn-row">
          {b.status === "RESERVED" && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={acting !== null}
              onClick={() => void act("Push to POS", "push-pos")}
            >
              {acting === "Push to POS" && <Spinner small />} Push to POS
            </button>
          )}
          {(b.status === "POS_PENDING" || b.status === "PAID") && (
            <button type="button" className="btn" onClick={openReconcile}>
              Reconcile POS
            </button>
          )}
          {b.status === "PAID" && hasRentals && (
            <button type="button" className="btn btn-primary" onClick={openPickup}>
              Record pickup
            </button>
          )}
          {b.status === "PICKED_UP" && (
            <button type="button" className="btn btn-primary" onClick={openReturn}>
              Record return
            </button>
          )}
          {(b.status === "RETURNED" || (b.status === "PAID" && !hasRentals)) && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={acting !== null}
              onClick={() => void act("Complete", "complete")}
            >
              {acting === "Complete" && <Spinner small />} Complete
            </button>
          )}
          {active && (
            <button type="button" className="btn btn-danger" onClick={openCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="btn-row" style={{ marginBottom: 18 }}>
        <a
          className="btn btn-sm"
          href={`/print/contract/${b.id}`}
          target="_blank"
          rel="noreferrer"
        >
          Print contract
        </a>
        {hasRentals && (
          <a
            className="btn btn-sm"
            href={`/print/packing-list/${b.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Print packing list
          </a>
        )}
        {hasCourses && (
          <a
            className="btn btn-sm"
            href={`/print/confirmation/${b.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Print confirmation
          </a>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Lines</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Dates</th>
                <th className="num">Days</th>
                <th className="num">Qty</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
                <th>NAV refs</th>
              </tr>
            </thead>
            <tbody>
              {b.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{l.productName}</div>
                    <div className="faint mono">{l.productNo}</div>
                  </td>
                  <td className="muted">
                    {l.type === "RENTAL"
                      ? `${fmtDateTime(l.from)} → ${fmtDateTime(l.to)}`
                      : fmtDateTime(l.from)}
                  </td>
                  <td className="num">{l.days ?? "—"}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{money(l.unitPrice)}</td>
                  <td className="num">{money(l.lineTotal)}</td>
                  <td className="mono faint">
                    {l.activityNo ? `Act ${l.activityNo}` : ""}
                    {l.activityNo && l.bookingRef ? " · " : ""}
                    {l.bookingRef ? `Ref ${l.bookingRef}` : ""}
                    {!l.activityNo && !l.bookingRef && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {b.lines.some((l) => l.damages && l.damages.length > 0) && (
          <>
            <hr className="divider" />
            <h2 className="card-title">Damages</h2>
            {b.lines.flatMap((l) =>
              (l.damages ?? []).map((d, i) => (
                <div className="fin-row" key={`${l.id}-${i}`}>
                  <span>
                    <span className="mono">{d.itemNo}</span> — {d.note}
                  </span>
                  <span>{money(d.charge)}</span>
                </div>
              )),
            )}
          </>
        )}
      </div>

      <div style={{ height: 18 }} />
      <div className="grid-2">
        <div className="card">
          <h2 className="card-title">Financials</h2>
          <div className="fin-row">
            <span className="muted">Subtotal</span>
            <span>{money(b.subtotal)}</span>
          </div>
          <div className="fin-row">
            <span className="muted">Deposit</span>
            <span>{money(b.deposit)}</span>
          </div>
          <div className="fin-row total">
            <span>Total</span>
            <span>{money(b.total)}</span>
          </div>
          <div className="fin-row">
            <span className="muted">POS total</span>
            <span>{b.posTotal != null ? money(b.posTotal) : "—"}</span>
          </div>
          {b.refundDue !== undefined && (
            <div className="fin-row">
              <span className="muted">Refund due</span>
              <span style={{ fontWeight: 650 }}>{money(b.refundDue)}</span>
            </div>
          )}
          {b.posReceiptNo && (
            <div className="fin-row">
              <span className="muted">POS receipt</span>
              <span className="mono">{b.posReceiptNo}</span>
            </div>
          )}
          {b.notes && (
            <>
              <hr className="divider" />
              <div className="faint">Notes</div>
              <div>{b.notes}</div>
            </>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Timeline</h2>
          {events.length === 0 ? (
            <EmptyState title="No events yet" />
          ) : (
            <ul className="timeline">
              {events.map((e, i) => (
                <li key={i}>
                  <span className="tl-type">{e.type}</span>
                  {formatEventDetail(e.detail) && <span className="muted"> — {formatEventDetail(e.detail)}</span>}
                  <div className="faint">{fmtDateTime(e.at)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ---------- Modals ---------- */}

      {modal === "pickup" && (
        <Modal
          title="Record pickup"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting !== null}
                onClick={() =>
                  void act("Pickup", "pickup", {
                    idNumber: idNumber || undefined,
                    depositAmount: depositAmount === "" ? undefined : Number(depositAmount),
                    inspection: inspection || undefined,
                  })
                }
              >
                {acting === "Pickup" && <Spinner small />} Confirm pickup
              </button>
            </>
          }
        >
          <Field label="ID number" hint="Stored encrypted at rest — never shown again in full.">
            <input
              type="text"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value)}
              placeholder="Driver's licence / ID no."
            />
          </Field>
          <Field label="Deposit amount (CAD)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
            />
          </Field>
          <Field label="Inspection notes (out)">
            <textarea
              value={inspection}
              onChange={(e) => setInspection(e.target.value)}
              placeholder="Condition of equipment at pickup…"
            />
          </Field>
        </Modal>
      )}

      {modal === "return" && (
        <Modal
          title="Record return"
          onClose={() => setModal(null)}
          wide
          footer={
            <>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting !== null}
                onClick={() =>
                  void act("Return", "return", {
                    inspection: inspection || undefined,
                    damages: damages.filter((d) => d.itemNo || d.note || d.charge),
                  })
                }
              >
                {acting === "Return" && <Spinner small />} Confirm return
              </button>
            </>
          }
        >
          <Field label="Inspection notes (in)">
            <textarea
              value={inspection}
              onChange={(e) => setInspection(e.target.value)}
              placeholder="Condition of equipment at return…"
            />
          </Field>
          <div>
            <div className="field-label" style={{ marginBottom: 8 }}>
              Damages
            </div>
            {damages.length === 0 && <div className="faint">No damages recorded.</div>}
            {damages.map((d, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}
              >
                <input
                  type="text"
                  placeholder="Item no."
                  value={d.itemNo}
                  style={{ width: 130 }}
                  onChange={(e) =>
                    setDamages(damages.map((x, j) => (j === i ? { ...x, itemNo: e.target.value } : x)))
                  }
                />
                <input
                  type="text"
                  placeholder="Damage note"
                  value={d.note}
                  onChange={(e) =>
                    setDamages(damages.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))
                  }
                />
                <input
                  type="number"
                  placeholder="Charge"
                  step="0.01"
                  min="0"
                  value={d.charge || ""}
                  style={{ width: 110 }}
                  onChange={(e) =>
                    setDamages(
                      damages.map((x, j) =>
                        j === i ? { ...x, charge: Number(e.target.value) || 0 } : x,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove damage row"
                  onClick={() => setDamages(damages.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDamages([...damages, { itemNo: "", note: "", charge: 0 }])}
            >
              Add damage row
            </button>
          </div>
        </Modal>
      )}

      {modal === "cancel" && (
        <Modal
          title="Cancel booking"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Keep booking
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={acting !== null}
                onClick={() => void act("Cancel", "cancel", { reason: cancelReason || undefined })}
              >
                {acting === "Cancel" && <Spinner small />} Cancel booking
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This cancels the NAV reservation for <strong className="mono">{b.ref}</strong>. This
            cannot be undone.
          </p>
          <Field label="Reason">
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Why is this booking being cancelled?"
            />
          </Field>
        </Modal>
      )}

      {modal === "reconcile" && (
        <Modal
          title="Reconcile POS"
          onClose={() => setModal(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={acting !== null || posTotal === ""}
                onClick={() =>
                  void act("Reconcile", "reconcile", {
                    posTotal: Number(posTotal),
                    receiptNo: receiptNo || undefined,
                  })
                }
              >
                {acting === "Reconcile" && <Spinner small />} Reconcile
              </button>
            </>
          }
        >
          <Field
            label="POS total (CAD)"
            hint="Actual amount charged at POS after coupons/discounts."
          >
            <input
              type="number"
              step="0.01"
              min="0"
              value={posTotal}
              onChange={(e) => setPosTotal(e.target.value)}
            />
          </Field>
          <Field label="Receipt no.">
            <input
              type="text"
              value={receiptNo}
              onChange={(e) => setReceiptNo(e.target.value)}
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
