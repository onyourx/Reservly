import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, copyToClipboard } from "../api";
import type { Booking, DamageRow, ExtensionRequest, ExtensionRequestsResponse, RentalUnit } from "../api";
import { fmtDate, fmtDateTime, money } from "../format";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { StatusPill } from "../components/StatusPill";
import { Modal } from "../components/Modal";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";
import { ScanButton } from "../components/BarcodeScanner";
import { useI18n } from "../components/I18n";
import { useAuth } from "../components/AuthGate";

type ModalKind = "pickup" | "return" | "cancel" | "reconcile" | null;
type RefundQuote = {
  enabled: boolean;
  daysBefore: number;
  percent: number;
  amount: number;
  tier: "full" | "partial" | "none";
  bookingRef: string;
};

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
  const { t } = useI18n();
  const { storeName } = useStores();
  const auth = useAuth();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [signatureUrl, setSignatureUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [extensionRequests, setExtensionRequests] = useState<ExtensionRequest[]>([]);
  const [extensionsLoading, setExtensionsLoading] = useState(true);
  const [rejectingExtensionId, setRejectingExtensionId] = useState<string | null>(null);
  const [extensionRejectReason, setExtensionRejectReason] = useState("");
  const [uploading, setUploading] = useState(false);
  const photoFileRef = useRef<HTMLInputElement>(null);
  const [sftpConfigured, setSftpConfigured] = useState(false);
  const [shopifyConfigured, setShopifyConfigured] = useState(false);
  const [noShowSettings, setNoShowSettings] = useState({ mode: "off", value: 0 });
  const [confirmWaive, setConfirmWaive] = useState(false);

  // Modal form state
  const [idNumber, setIdNumber] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [inspection, setInspection] = useState("");
  const [damages, setDamages] = useState<DamageRow[]>([]);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelQuote, setCancelQuote] = useState<RefundQuote | null>(null);
  const [posTotal, setPosTotal] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
  const [availableUnits, setAvailableUnits] = useState<Record<string, RentalUnit[]>>({});
  const [unitAssignments, setUnitAssignments] = useState<Record<string, string[]>>({});
  const [unitConditions, setUnitConditions] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ booking: Booking }>(`/api/bookings/${id}`)
      .then((d) => setBooking(d.booking))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    api<{ sftpConfigured: boolean; shopifyConfigured: boolean }>("/api/health")
      .then((health) => {
        setSftpConfigured(health.sftpConfigured);
        setShopifyConfigured(health.shopifyConfigured);
      })
      .catch(() => setSftpConfigured(false));
    api<{ settings: { noShowFeeMode?: string; noShowFeeValue?: string } }>("/api/settings")
      .then(({ settings }) => setNoShowSettings({
        mode: settings.noShowFeeMode || "off",
        value: Number(settings.noShowFeeValue) || 0,
      }))
      .catch(() => setNoShowSettings({ mode: "off", value: 0 }));
  }, []);

  const loadExtensions = useCallback(async () => {
    setExtensionsLoading(true);
    try {
      const result = await api<ExtensionRequestsResponse>("/api/extension-requests");
      setExtensionRequests(result.requests);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Extension requests"));
      setExtensionRequests([]);
    } finally {
      setExtensionsLoading(false);
    }
  // The request endpoint is independent of locale and booking state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadExtensions();
  }, [loadExtensions]);

  const approveExtension = async (requestId: string) => {
    setActing(`extension-${requestId}`);
    try {
      await api<{ ok: boolean }>(`/api/extension-requests/${requestId}/approve`, { method: "POST", body: {} });
      toast.success(t("Approved"));
      await loadExtensions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Approve"));
    } finally {
      setActing(null);
    }
  };

  const rejectExtension = async (requestId: string) => {
    setActing(`extension-${requestId}`);
    try {
      await api<{ ok: boolean }>(`/api/extension-requests/${requestId}/reject`, {
        method: "POST",
        body: { reason: extensionRejectReason || undefined },
      });
      toast.success(t("Rejected"));
      setRejectingExtensionId(null);
      setExtensionRejectReason("");
      await loadExtensions();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Reject"));
    } finally {
      setActing(null);
    }
  };

  const act = async (name: string, path: string, body?: unknown) => {
    setActing(name);
    try {
      const result = await api<{ lateFeeSuggested?: number }>(`/api/bookings/${id}/${path}`, { method: "POST", body: body ?? {} });
      toast.success(result.lateFeeSuggested ? `${name} done · suggested late fee ${money(result.lateFeeSuggested)}` : `${name} done`);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${name} failed`);
    } finally {
      setActing(null);
    }
  };

  const markNoShow = async () => {
    if (!booking) return;
    if (noShowSettings.mode !== "off" && noShowSettings.value > 0) {
      const amount = noShowSettings.mode === "percent"
        ? Math.round(booking.total * (noShowSettings.value / 100) * 100) / 100
        : noShowSettings.value;
      const message = t(shopifyConfigured
        ? "A no-show fee of $X will be invoiced"
        : "A no-show fee of $X will be charged (payable at the store)")
        .replace("$X", `$${amount.toFixed(2)}`);
      if (!window.confirm(message)) return;
    }
    await act("No-show", "no-show");
  };

  const waiveNoShowFee = async () => {
    if (!confirmWaive) {
      setConfirmWaive(true);
      return;
    }
    setActing("waive-no-show-fee");
    try {
      const result = await api<{ booking: Booking }>(`/api/bookings/${id}/waive-no-show-fee`, { method: "POST" });
      setBooking(result.booking);
      setConfirmWaive(false);
      toast.success(t("Fee waived"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Waive fee"));
    } finally {
      setActing(null);
    }
  };

  const requestSignature = async () => {
    setActing("signature");
    try {
      const d = await api<{ url: string }>(`/api/bookings/${id}/request-signature`, { method: "POST" });
      const copied = await copyToClipboard(d.url);
      setSignatureUrl(d.url);
      toast.success(
        copied
          ? "Signing link created & copied — emailed to the customer via HubSpot"
          : "Signing link created — emailed to the customer via HubSpot. Manual copy available below.",
      );
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create signing link");
    } finally {
      setActing(null);
    }
  };

  const toggleChecklistItem = async (lineId: string, itemNo: string) => {
    if (!booking) return;
    const line = booking.lines.find((l) => l.id === lineId);
    if (!line) return;
    const items = line.checklist.map((c) => (c.itemNo === itemNo ? { ...c, checked: !c.checked } : c));
    // optimistic update
    setBooking({ ...booking, lines: booking.lines.map((l) => (l.id === lineId ? { ...l, checklist: items } : l)) });
    try {
      await api(`/api/bookings/${id}/checklist`, { method: "PUT", body: { lineId, items } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Checklist save failed");
      load();
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
    setUnitAssignments({});
    const rentalLines = b.lines.filter((l) => l.type === "RENTAL" && !l.units.length);
    Promise.all(rentalLines.map(async (line) => {
      const d = await api<{ units: RentalUnit[] }>(`/api/rental-units?productNo=${encodeURIComponent(line.productNo)}&storeId=${encodeURIComponent(line.storeId)}&status=AVAILABLE`);
      return [line.id, d.units] as const;
    })).then((rows) => setAvailableUnits(Object.fromEntries(rows))).catch(() => setAvailableUnits({}));
    setModal("pickup");
  };
  const openReturn = () => {
    setInspection("");
    setDamages([]);
    setUnitConditions(Object.fromEntries(b.lines.flatMap((l) => l.units.map((u) => [u.id, u.condition]))));
    setModal("return");
  };
  const openCancel = async () => {
    setCancelReason("");
    setCancelQuote(null);
    try {
      setCancelQuote(await api<RefundQuote>(`/api/bookings/${id}/refund-quote`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load refund quote");
    }
    setModal("cancel");
  };
  const openReconcile = () => {
    setPosTotal(b.posTotal != null ? String(b.posTotal) : String(b.total ?? ""));
    setReceiptNo(b.posReceiptNo ?? "");
    setModal("reconcile");
  };

  const events = [...b.events].sort((a, c) => (a.at < c.at ? 1 : -1));
  const bookingExtensionRequests = extensionRequests.filter((request) => request.bookingRef === b.ref);
  const extensionStatusStyles: Record<ExtensionRequest["status"], React.CSSProperties> = {
    REQUESTED: { background: "#fef3c7", color: "#92400e" },
    APPROVED: { background: "#dbeafe", color: "#1e40af" },
    APPLIED: { background: "#dcfce7", color: "#166534" },
    REJECTED: { background: "#fee2e2", color: "#991b1b" },
  };

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
            <div className="meta-item">
              <span className="meta-label">{t("fulfillment_label")}</span>
              <span>{t(b.fulfillment === "SHIP" ? "fulfillment_ship" : "fulfillment_pickup")}</span>
              {b.fulfillment === "SHIP" && b.shipAddress && (
                <span className="faint" style={{ whiteSpace: "pre-line" }}>{b.shipAddress}</span>
              )}
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
            <div className="meta-item">
              <span className="meta-label">{t("ID photo")}</span>
              {b.idPhotoAt ? (
                <span>
                  {t("Captured")} {fmtDateTime(b.idPhotoAt)}{" "}
                  <button className="link-btn" onClick={() => window.open(`/api/bookings/${b.id}/id-photo`, "_blank")}>
                    {t("View")}
                  </button>
                  {auth.access?.canManageUsers && (
                    <button className="link-btn" onClick={() => {
                      if (confirm(t("Remove ID photo?")) && confirm(`${t("Remove ID photo?")} ${t("Remove")}`)) {
                        api(`/api/bookings/${b.id}/id-photo`, { method: "DELETE" })
                          .then(() => { toast.success(t("ID photo removed")); load(); })
                          .catch((e) => toast.error(e instanceof Error ? e.message : t("Remove failed")));
                      }
                    }}>
                      {t("Remove")}
                    </button>
                  )}
                </span>
              ) : sftpConfigured ? (
                <>
                  <input
                    ref={photoFileRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => {
                      const input = e.currentTarget;
                      const file = input.files?.[0];
                      if (!file) return;
                      setUploading(true);
                      file.arrayBuffer()
                        .then((buffer) => fetch(`/api/bookings/${b.id}/id-photo`, {
                          method: "POST",
                          body: buffer,
                          headers: { "content-type": file.type || "image/jpeg" },
                        }))
                        .then(async (response) => {
                          const result = await response.json() as { ok?: boolean; error?: string };
                          if (!response.ok || !result.ok) throw new Error(result.error || "Upload failed");
                          toast.success(t("Upload ID photo"));
                          load();
                        })
                        .catch((err) => toast.error(err instanceof Error ? err.message : t("Upload failed")))
                        .finally(() => {
                          setUploading(false);
                          input.value = "";
                        });
                    }}
                    style={{ display: "none" }}
                  />
                  <button type="button" className="btn btn-sm" onClick={() => photoFileRef.current?.click()} disabled={uploading}>
                    {uploading && <Spinner small />} {t("Upload ID photo")}
                  </button>
                </>
              ) : (
                <span className="faint">{t("SFTP not configured")}</span>
              )}
            </div>
            {b.checkedInAt && (
              <div className="meta-item">
                <span className="meta-label">Attendance</span>
                <span className="badge">Checked in</span>
              </div>
            )}
            {b.noShowAt && (
              <div className="meta-item">
                <span className="meta-label">Attendance</span>
                <span className="badge">No-show</span>
              </div>
            )}
            {b.noShowAt && Number(b.noShowFee) > 0 && (
              <div className="meta-item">
                <span className="meta-label">{t("No-show fee status")}</span>
                <span>
                  {money(Number(b.noShowFee), b.currency)}{" "}
                  <span className="badge">
                    {t(b.noShowFeeStatus === "PENDING_PAYMENT" ? "Payable at store"
                      : b.noShowFeeStatus === "INVOICED" ? "Invoiced"
                        : b.noShowFeeStatus === "PAID" ? "Paid"
                          : b.noShowFeeStatus === "WAIVED" ? "Waived" : b.noShowFeeStatus || "Pending payment")}
                  </span>
                  {auth.access?.canManageUsers && b.noShowFeeStatus !== "PAID" && b.noShowFeeStatus !== "WAIVED" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={acting !== null}
                      onClick={() => void waiveNoShowFee()}
                      onBlur={() => setConfirmWaive(false)}
                      style={{ marginLeft: 8 }}
                    >
                      {t(confirmWaive ? "Confirm waive" : "Waive fee")}
                    </button>
                  )}
                </span>
              </div>
            )}
            {(b.contractSignedAt || b.signaturePending) && (
              <div className="meta-item">
                <span className="meta-label">Contract</span>
                <span className="badge">
                  {b.contractSignedAt ? `Signed${b.signatureName ? ` — ${b.signatureName}` : ""}` : "Awaiting signature"}
                </span>
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
          {hasCourses && active && !b.checkedInAt && !b.noShowAt && (
            <>
              <button type="button" className="btn" disabled={acting !== null}
                onClick={() => void act("Check-in", "check-in")}>
                Check in
              </button>
              <button type="button" className="btn" disabled={acting !== null}
                onClick={() => void markNoShow()}>
                Mark no-show
              </button>
            </>
          )}
          {active && (
            <button type="button" className="btn btn-danger" onClick={openCancel}>
              Cancel
            </button>
          )}
        </div>
      </div>

      {(b.intakeResponses && Object.keys(b.intakeResponses).length > 0) && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 className="card-title">{t("Booking form answers")}</h2>
          <div className="detail-meta">
            {(Array.isArray(b.intakeResponses)
              ? b.intakeResponses.map((response) => {
                  const item = response as unknown as { fieldId?: string; label?: string; value?: unknown };
                  return [item.label || item.fieldId || "", item.value] as const;
                })
              : Object.entries(b.intakeResponses)
            ).map(([label, value]) => (
              <div className="meta-item" key={label}>
                <span className="meta-label">{label}</span>
                <span>{typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {b.termsAcceptedAt && (
        <div className="faint" style={{ marginBottom: 18 }}>
          {t("Terms accepted")} {fmtDateTime(b.termsAcceptedAt)}
        </div>
      )}

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
        {hasRentals && b.fulfillment === "SHIP" && (
          <a className="btn btn-sm" href={`/print/return-label/${b.id}`} target="_blank" rel="noreferrer">
            {t("print_return_label")}
          </a>
        )}
        {hasCourses && (
          <>
            <a className="btn btn-sm" href={`/print/confirmation/${b.id}`} target="_blank" rel="noreferrer">
              Print confirmation
            </a>
            <a className="btn btn-sm" href={`/print/ticket/${b.id}`} target="_blank" rel="noreferrer">
              eTicket
            </a>
          </>
        )}
        {hasRentals && active && !b.contractSignedAt && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={acting !== null}
            onClick={() => void requestSignature()}
          >
            {acting === "signature" && <Spinner small />} Request e-signature
          </button>
        )}
      </div>

      {signatureUrl && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 className="card-title">{t("Signing link")}</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            {t("Share or manually copy this link with the customer")}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              readOnly
              value={signatureUrl}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                copyToClipboard(signatureUrl).then((copied) => {
                  toast.success(copied ? "Link copied" : t("Could not copy to clipboard"));
                });
              }}
            >
              {t("Copy")}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSignatureUrl(null)}
            >
              {t("Close")}
            </button>
          </div>
        </div>
      )}

      {hasRentals && active && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 className="card-title">Packing checklist</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            Tick every item while preparing the kit and checking it with the customer.
          </div>
          {b.lines
            .filter((l) => l.type === "RENTAL")
            .map((l) => {
              const done = l.checklist.filter((c) => c.checked).length;
              return (
                <div key={l.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <strong>{l.productName}</strong>
                    <span className={done === l.checklist.length ? "avail avail-ok" : "muted"}>
                      {done}/{l.checklist.length} checked
                    </span>
                  </div>
                  {l.checklist.map((c) => (
                    <label key={c.itemNo} className="checkbox-row" style={{ display: "flex", padding: "3px 0" }}>
                      <input
                        type="checkbox"
                        checked={c.checked}
                        onChange={() => void toggleChecklistItem(l.id, c.itemNo)}
                      />
                      <span className="mono" style={{ width: 110 }}>{c.itemNo}</span>
                      <span style={{ flex: 1 }}>{c.description}</span>
                      <span className="muted">× {c.qty}</span>
                    </label>
                  ))}
                </div>
              );
            })}
        </div>
      )}

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
                    {l.type === "SERVICE" && l.meetingUrl && (
                      <div>
                        <strong>{t("Join online:")}</strong>{" "}
                        <a href={l.meetingUrl} target="_blank" rel="noreferrer">{l.meetingUrl}</a>
                      </div>
                    )}
                  </td>
                  <td className="muted">
                    {l.type === "RENTAL"
                      ? `${fmtDateTime(l.from)} → ${fmtDateTime(l.to)}`
                      : fmtDateTime(l.from)}
                  </td>
                  <td className="num">{l.days ?? "—"}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{money(l.unitPrice, b.currency)}</td>
                  <td className="num">{money(l.lineTotal, b.currency)}</td>
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
                  <span>{money(d.charge, b.currency)}</span>
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
            <span>{money(b.subtotal, b.currency)}</span>
          </div>
          <div className="fin-row">
            <span className="muted">Deposit</span>
            <span>{money(b.deposit, b.currency)}</span>
          </div>
          {b.fulfillment === "SHIP" && (
            <div className="fin-row">
              <span className="muted">{t("shipping_fee_label")}</span>
              <span>{money(b.shippingFee ?? 0, b.currency)}</span>
            </div>
          )}
          <div className="fin-row total">
            <span>Total</span>
            <span>{money(b.total, b.currency)}</span>
          </div>
          <div className="fin-row">
            <span className="muted">POS total</span>
            <span>{b.posTotal != null ? money(b.posTotal, b.currency) : "—"}</span>
          </div>
          {b.refundDue !== undefined && (
            <div className="fin-row">
              <span className="muted">Refund due</span>
              <span style={{ fontWeight: 650 }}>{money(b.refundDue, b.currency)}</span>
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
          {b.addons && b.addons.length > 0 && (
            <>
              <hr className="divider" />
              <div className="faint">Booking add-ons</div>
              {b.addons.map((a, i) => (
                <div className="fin-row" key={`${a.productNo}-${i}`}>
                  <span>{a.name} <span className="faint">× {a.qty}</span></span>
                  <span>{money(a.unitPrice * a.qty, b.currency)}</span>
                </div>
              ))}
            </>
          )}
          {hasRentals && b.lines.some((l) => l.units.length > 0) && (
            <>
              <hr className="divider" />
              <div className="faint">Assigned rental units</div>
              {b.lines.flatMap((l) => l.units).map((u) => (
                <div className="fin-row" key={u.id}>
                  <span className="mono">{u.barcode}</span>
                  <span>{u.serialNo || "No serial"} · {u.condition}</span>
                </div>
              ))}
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

        <div className="card">
          <h2 className="card-title">{t("Extension requests")}</h2>
          {extensionsLoading ? (
            <Skeleton rows={3} />
          ) : bookingExtensionRequests.length === 0 ? (
            <EmptyState title={t("No extension requests")} />
          ) : (
            bookingExtensionRequests.map((request) => (
              <div className="dash-item" key={request.id}>
                <div className="dash-item-main">
                  <div className="dash-item-title">
                    <span className="badge" style={extensionStatusStyles[request.status]}>
                      {t(request.status.charAt(0) + request.status.slice(1).toLowerCase())}
                    </span>
                    {" "}
                    {fmtDate(request.oldDateTo)} → {fmtDate(request.newDateTo)}
                  </div>
                  <div className="faint">{money(request.price, b.currency)}</div>
                  {rejectingExtensionId === request.id && (
                    <div style={{ marginTop: 8 }}>
                      <textarea
                        aria-label={t("Reason (optional)")}
                        placeholder={t("Reason (optional)")}
                        value={extensionRejectReason}
                        onChange={(event) => setExtensionRejectReason(event.target.value)}
                      />
                      <div className="btn-row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn btn-danger btn-sm" disabled={acting !== null} onClick={() => void rejectExtension(request.id)}>
                          {t("Confirm Reject")}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => { setRejectingExtensionId(null); setExtensionRejectReason(""); }}>
                          {t("Cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {request.status === "REQUESTED" && rejectingExtensionId !== request.id && (
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary btn-sm" disabled={acting !== null} onClick={() => void approveExtension(request.id)}>
                      {t("Approve")}
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" disabled={acting !== null} onClick={() => { setRejectingExtensionId(request.id); setExtensionRejectReason(""); }}>
                      {t("Reject")}
                    </button>
                  </div>
                )}
              </div>
            ))
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
                    unitAssignments,
                  })
                }
              >
                {acting === "Pickup" && <Spinner small />} Confirm pickup
              </button>
            </>
          }
        >
          {(() => {
            const rentalLines = b.lines.filter((l) => l.type === "RENTAL");
            const unchecked = rentalLines.reduce((a, l) => a + l.checklist.filter((c) => !c.checked).length, 0);
            return (
              <>
                {unchecked > 0 && (
                  <div className="error-note" style={{ marginBottom: 10 }}>
                    Packing checklist incomplete — {unchecked} item{unchecked > 1 ? "s" : ""} not checked.
                  </div>
                )}
                {!b.contractSignedAt && (
                  <div className="error-note" style={{ marginBottom: 10 }}>
                    Contract not e-signed — get a paper signature or send the signing link before handover.
                  </div>
                )}
              </>
            );
          })()}
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
          {b.lines.filter((l) => l.type === "RENTAL" && !l.units.length).map((line) => (
            <div key={line.id}>
              <div className="field-label">Assign {line.productName} units ({line.qty})</div>
              <div className="field-hint" style={{ marginBottom: 6 }}>{t("Scan a barcode or select each physical unit.")}</div>
              <div style={{ marginBottom: 8 }}>
                <ScanButton title={t("Scan unit barcode or serial number")} onScan={(rawCode) => {
                  const code = rawCode.trim().toLowerCase();
                  const unit = (availableUnits[line.id] || []).find((candidate) =>
                    candidate.barcode.toLowerCase() === code || candidate.serialNo?.toLowerCase() === code
                  );
                  if (!unit) {
                    toast.error(t("No available unit matches {code}").replace("{code}", rawCode.trim()));
                    return;
                  }
                  const assigned = unitAssignments[line.id] || [];
                  if (assigned.includes(unit.id)) {
                    toast.error(t("Unit already assigned"));
                    return;
                  }
                  if (assigned.filter(Boolean).length >= line.qty) {
                    toast.error(t("All units are already assigned"));
                    return;
                  }
                  const next = [...assigned];
                  const openIndex = Array.from({ length: line.qty }, (_, index) => index)
                    .find((index) => !next[index]);
                  if (openIndex === undefined) return;
                  next[openIndex] = unit.id;
                  setUnitAssignments((current) => ({ ...current, [line.id]: next }));
                  toast.success(t("Unit {barcode} assigned").replace("{barcode}", unit.barcode));
                }} />
              </div>
              {Array.from({ length: line.qty }, (_, index) => (
                <select key={index} value={unitAssignments[line.id]?.[index] || ""} onChange={(e) => {
                  const next = [...(unitAssignments[line.id] || Array(line.qty).fill(""))];
                  next[index] = e.target.value;
                  setUnitAssignments({ ...unitAssignments, [line.id]: next });
                }} style={{ marginBottom: 6 }}>
                  <option value="">Unit {index + 1}…</option>
                  {(availableUnits[line.id] || []).map((u) => (
                    <option key={u.id} value={u.id} disabled={(unitAssignments[line.id] || []).includes(u.id) && unitAssignments[line.id]?.[index] !== u.id}>
                      {u.barcode}{u.serialNo ? ` · ${u.serialNo}` : ""} · {u.condition}
                    </option>
                  ))}
                </select>
              ))}
              {(availableUnits[line.id] || []).length < line.qty && <div className="avail-no">Not enough serialized units available. Add units in Rental fleet.</div>}
            </div>
          ))}
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
                    unitConditions,
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
          {b.lines.flatMap((l) => l.units).filter((u) => !u.returnedAt).map((u) => (
            <Field key={u.id} label={`Condition · ${u.barcode}`} hint={u.serialNo || undefined}>
              <select value={unitConditions[u.id] || "GOOD"} onChange={(e) => setUnitConditions({ ...unitConditions, [u.id]: e.target.value })}>
                {["NEW", "GOOD", "FAIR", "DAMAGED"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </Field>
          ))}
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
          {cancelQuote?.enabled && (
            <p style={{ margin: 0, fontWeight: 650 }}>
              {cancelQuote.tier === "none"
                ? "No refund per policy"
                : `Refund: $${cancelQuote.amount.toFixed(2)} (${cancelQuote.percent}%)`}
            </p>
          )}
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
