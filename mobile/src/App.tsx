import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDT, money, type Booking, type ChecklistItem } from "./api";

function LogoMark({ size = 64, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" style={muted ? { opacity: 0.45 } : undefined}>
      <rect width="96" height="96" rx="21" fill={muted ? "#1c1f1d" : "#12A46B"} />
      <rect x="18" y="28" width="60" height="17" rx="8.5" fill="#fff" fillOpacity="0.38" />
      <rect x="18" y="51" width="60" height="17" rx="8.5" fill="#fff" />
      <path d="M30 59.5 L36.5 66 L49 53.5" stroke={muted ? "#1c1f1d" : "#12A46B"} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STANDBY_AFTER_MS = 5 * 60 * 1000; // requirement: standby after 5 min idle

/** Idle tracker: any interaction resets the clock; going to a hidden tab counts
 *  as idle immediately. While in standby the app renders a black screen only —
 *  no timers, no polling, no repaints — so the battery cost is ~zero. */
function useStandby(): [boolean, () => void] {
  const [standby, setStandby] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const arm = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStandby(true), STANDBY_AFTER_MS);
    };
    const events = ["pointerdown", "touchstart", "keydown", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    const onVisibility = () => {
      if (document.hidden) setStandby(true);
      else arm();
    };
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      window.clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, arm));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return [standby, () => setStandby(false)];
}

type View =
  | { name: "list" }
  | { name: "detail"; id: string }
  | { name: "printers" };

export function App() {
  const [standby, wake] = useStandby();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>({ name: "list" });

  const checkAuth = useCallback(() => {
    api<{ required: boolean; authenticated: boolean }>("/api/auth")
      .then((d) => setAuthed(!d.required || d.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(checkAuth, [checkAuth]);
  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener("rsv:unauthorized", onUnauthorized);
    return () => window.removeEventListener("rsv:unauthorized", onUnauthorized);
  }, []);

  if (standby) {
    return (
      <div
        className="standby"
        onPointerDown={() => {
          wake();
          checkAuth(); // session may have expired while asleep
        }}
      >
        <LogoMark size={56} muted />
        <div className="standby-hint">Tap to resume</div>
      </div>
    );
  }
  if (authed === null) return <div className="center faint">…</div>;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  if (view.name === "list") {
    return (
      <BookingsList
        onOpen={(id) => setView({ name: "detail", id })}
        onPrinters={() => setView({ name: "printers" })}
      />
    );
  }
  if (view.name === "printers") {
    return <PrintersScreen onBack={() => setView({ name: "list" })} />;
  }
  return <BookingDetail id={view.id} onBack={() => setView({ name: "list" })} />;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { body: { username, password } });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="login" onSubmit={(e) => void submit(e)}>
      <LogoMark size={64} />
      <h1>Bagsy Staff</h1>
      <input
        type="text"
        placeholder="Email"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoFocus
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && <div className="error">{error}</div>}
      <button type="submit" disabled={busy || !password}>
        {busy ? "…" : "Sign in"}
      </button>
    </form>
  );
}

const STATUS_FILTERS = ["ALL", "RESERVED", "PAID", "PICKED_UP"] as const;

function PrintersScreen({ onBack }: { onBack: () => void }) {
  const [printers, setPrinters] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ printers: { id: string; name: string }[]; defaultPrinter: string | null }>("/api/printers")
      .then((data) => {
        setPrinters(data.printers);
        const stored = localStorage.getItem("reservly.printer");
        setSelected(stored || data.defaultPrinter || "");
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== "403") {
          setError(e instanceof Error ? e.message : "Failed to load printers");
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = (printerId: string) => {
    setSelected(printerId);
    localStorage.setItem("reservly.printer", printerId);
  };

  return (
    <div className="screen">
      <header>
        <button type="button" className="ghost" onClick={onBack}>‹ Back</button>
        <span>Printers</span>
      </header>
      {error && <div className="error">{error}</div>}
      {loading && <div className="center faint">Loading…</div>}
      {!loading && printers.length === 0 && !error && (
        <div className="center faint">
          No printers found on the server — add the printer to the Mac&apos;s Printers &amp; Scanners first.
        </div>
      )}
      {printers.map((printer) => (
        <label
          key={printer.id}
          className="check"
          style={{ padding: "14px", background: "#fff", borderRadius: "12px", marginBottom: "8px", border: "1px solid #e5e7ee" }}
        >
          <input
            type="radio"
            name="printer"
            checked={selected === printer.id}
            onChange={() => handleSelect(printer.id)}
          />
          <span>{printer.name}</span>
        </label>
      ))}
    </div>
  );
}

function BookingsList({ onOpen, onPrinters }: { onOpen: (id: string) => void; onPrinters?: () => void }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status !== "ALL") params.set("status", status);
    api<{ bookings: Booking[] }>(`/api/bookings?${params}`)
      .then((d) => setBookings(d.bookings))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [q, status]);

  useEffect(() => {
    const t = window.setTimeout(load, q ? 300 : 0); // debounce typing
    return () => window.clearTimeout(t);
  }, [load, q]);

  return (
    <div className="screen">
      <header>
        <span className="brand">Bagsy</span>
        <div>
          <button type="button" className="ghost" onClick={load}>⟳</button>
          <button type="button" className="ghost" onClick={onPrinters} style={{ fontSize: "18px" }}>⚙</button>
        </div>
      </header>
      <input className="search" type="search" placeholder="Search ref, customer…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips">
        {STATUS_FILTERS.map((s) => (
          <button key={s} type="button" className={`chip ${status === s ? "on" : ""}`} onClick={() => setStatus(s)}>
            {s === "ALL" ? "All" : s.replace("_", " ").toLowerCase()}
          </button>
        ))}
      </div>
      {loading && <div className="center faint">Loading…</div>}
      {!loading && bookings.length === 0 && <div className="center faint">No bookings</div>}
      {bookings.map((b) => (
        <button type="button" key={b.id} className="row" onClick={() => onOpen(b.id)}>
          <div className="row-main">
            <span className="mono">{b.ref}</span>
            <span>{`${b.customer.firstName} ${b.customer.lastName}`.trim() || b.customer.email}</span>
            <span className="faint">{b.lines?.length ?? 0} line(s) · {fmtDT(b.createdAt)}</span>
          </div>
          <span className={`pill s-${b.status}`}>{b.status.replace("_", " ")}</span>
        </button>
      ))}
    </div>
  );
}

function PrintSection({ bookingId }: { bookingId: string }) {
  const [printState, setPrintState] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [jobId, setJobId] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const selectedPrinter = localStorage.getItem("reservly.printer");

  const doPrint = async (doc: "contract" | "packing-list") => {
    if (!selectedPrinter) return;
    setPrintState("pending");
    setErrorMsg("");
    try {
      const response = await api<{ ok: boolean; jobId: string }>("/api/print", {
        body: { doc, id: bookingId, printer: selectedPrinter },
      });
      setJobId(response.jobId);
      setPrintState("success");
      window.setTimeout(() => setPrintState("idle"), 3000);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Print failed");
      setPrintState("error");
    }
  };

  const preview = (doc: "contract" | "packing-list") => {
    window.open(`/print/${doc}/${bookingId}`, "_blank");
  };

  return (
    <div className="card">
      <div style={{ marginBottom: "12px", fontWeight: "600" }}>Print</div>
      {!selectedPrinter && (
        <div className="faint" style={{ marginBottom: "12px" }}>Choose a printer first in Settings</div>
      )}
      {printState === "success" && (
        <div style={{ color: "#157347", fontSize: "14px", marginBottom: "12px" }}>
          Sent to printer (job {jobId})
        </div>
      )}
      {printState === "error" && <div className="error">{errorMsg}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {(["contract", "packing-list"] as const).map((doc) => (
          <div key={doc} style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="primary"
              disabled={!selectedPrinter || printState === "pending"}
              onClick={() => void doPrint(doc)}
              style={{ flex: 1 }}
            >
              {printState === "pending" ? "Printing…" : `Print ${doc === "contract" ? "contract" : "packing list"}`}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => preview(doc)}
              style={{ padding: "15px 12px" }}
            >
              Preview
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function BookingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [b, setB] = useState<Booking | null>(null);
  const [error, setError] = useState("");
  const [signBusy, setSignBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [sftpConfigured, setSftpConfigured] = useState(false);
  const [canManageUsers, setCanManageUsers] = useState(false);
  const photoFileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<{ booking: Booking }>(`/api/bookings/${id}`)
      .then((d) => setB(d.booking))
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ sftpConfigured: boolean }>("/api/health")
      .then((health) => setSftpConfigured(health.sftpConfigured))
      .catch(() => setSftpConfigured(false));
    api<{ access?: { canManageUsers?: boolean } | null }>("/api/auth")
      .then((auth) => setCanManageUsers(Boolean(auth.access?.canManageUsers)))
      .catch(() => setCanManageUsers(false));
  }, []);

  const toggle = async (lineId: string, itemNo: string) => {
    if (!b) return;
    const line = b.lines.find((l) => l.id === lineId);
    if (!line) return;
    const items: ChecklistItem[] = line.checklist.map((c) => (c.itemNo === itemNo ? { ...c, checked: !c.checked } : c));
    setB({ ...b, lines: b.lines.map((l) => (l.id === lineId ? { ...l, checklist: items } : l)) });
    api(`/api/bookings/${id}/checklist`, { method: "PUT", body: { lineId, items } }).catch(() => load());
  };

  /** Hand the phone to the customer: mint a signing link and open it right here.
   *  The signing page returns to the app when done. */
  const signNow = async () => {
    setSignBusy(true);
    try {
      const d = await api<{ url: string }>(`/api/bookings/${id}/request-signature`, { method: "POST" });
      const url = new URL(d.url);
      url.searchParams.set("return", "/m/");
      window.location.href = `${url.pathname}${url.search}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start signing");
      setSignBusy(false);
    }
  };

  if (error) return <div className="screen"><header><button type="button" className="ghost" onClick={onBack}>‹ Back</button></header><div className="error">{error}</div></div>;
  if (!b) return <div className="center faint">Loading…</div>;

  const rentals = b.lines.filter((l) => l.type === "RENTAL");
  return (
    <div className="screen">
      <header>
        <button type="button" className="ghost" onClick={onBack}>‹ Back</button>
        <span className={`pill s-${b.status}`}>{b.status.replace("_", " ")}</span>
      </header>
      <h1 className="mono">{b.ref}</h1>
      <div className="card">
        <strong>{`${b.customer.firstName} ${b.customer.lastName}`.trim() || b.customer.email}</strong>
        <div className="faint">{b.customer.email}{b.customer.phone ? ` · ${b.customer.phone}` : ""}{b.customer.b2b ? " · B2B" : ""}</div>
        <div className="faint">Total {money(b.subtotal)}{b.deposit ? ` · deposit ${money(b.deposit)}` : ""}</div>
      </div>
      <div className="card">
        <strong>ID photo</strong>
        {b.idPhotoAt ? (
          <div>
            <div className="faint">Captured {fmtDT(b.idPhotoAt)}</div>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => window.open(`/api/bookings/${b.id}/id-photo`, "_blank")}>View</button>
              {canManageUsers && (
                <button type="button" className="ghost" onClick={() => {
                  if (!confirm("Remove ID photo?")) return;
                  setPhotoBusy(true);
                  api(`/api/bookings/${b.id}/id-photo`, { method: "DELETE" })
                    .then(() => load())
                    .catch((e: Error) => setError(e.message))
                    .finally(() => setPhotoBusy(false));
                }} disabled={photoBusy}>Remove</button>
              )}
            </div>
          </div>
        ) : sftpConfigured ? (
          <>
            <input
              ref={photoFileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(event) => {
                const input = event.currentTarget;
                const file = input.files?.[0];
                if (!file) return;
                setPhotoBusy(true);
                file.arrayBuffer()
                  .then((buffer) => fetch(`/api/bookings/${b.id}/id-photo`, {
                    method: "POST",
                    body: buffer,
                    headers: { "content-type": file.type || "image/jpeg" },
                  }))
                  .then(async (response) => {
                    const result = await response.json() as { ok?: boolean; error?: string };
                    if (!response.ok || !result.ok) throw new Error(result.error || "Upload failed");
                    load();
                  })
                  .catch((e: Error) => setError(e.message))
                  .finally(() => {
                    setPhotoBusy(false);
                    input.value = "";
                  });
              }}
            />
            <button type="button" className="primary" onClick={() => photoFileRef.current?.click()} disabled={photoBusy}>
              {photoBusy ? "Uploading…" : "Capture ID photo"}
            </button>
          </>
        ) : (
          <div className="faint">SFTP not configured</div>
        )}
      </div>

      {b.lines.map((l) => (
        <div className="card" key={l.id}>
          <strong>{l.productName}</strong>
          <div className="faint">{fmtDT(l.from)} → {fmtDT(l.to)}{l.days ? ` · ${l.days}d` : ""} · ×{l.qty}</div>
          {l.type === "RENTAL" && l.checklist.length > 0 && (
            <div className="checklist">
              <div className="faint" style={{ margin: "6px 0" }}>
                Packing list — {l.checklist.filter((c) => c.checked).length}/{l.checklist.length}
              </div>
              {l.checklist.map((c) => (
                <label key={c.itemNo} className={`check ${c.checked ? "done" : ""}`}>
                  <input type="checkbox" checked={c.checked} onChange={() => void toggle(l.id, c.itemNo)} />
                  <span>{c.description}</span>
                  <span className="faint">×{c.qty}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      ))}

      {rentals.length > 0 && (
        <div className="card">
          {b.contractSignedAt ? (
            <div className="signed">✓ Contract signed{b.signatureName ? ` — ${b.signatureName}` : ""}</div>
          ) : (
            <button type="button" className="primary" disabled={signBusy} onClick={() => void signNow()}>
              {signBusy ? "…" : "Customer signs here ✍"}
            </button>
          )}
        </div>
      )}
      {rentals.length > 0 && <PrintSection bookingId={id} />}
    </div>
  );
}
