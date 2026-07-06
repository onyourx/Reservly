import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "../api";
import type { AvailabilitySlot, Resource, ResourceType, Session } from "../api";
import { fmtDate, fmtDateTime, fmtTime, todayISO } from "../format";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

/* ---------------- Schedule tab ---------------- */

function ScheduleTab() {
  const toast = useToast();
  const { storeId, storeName } = useStores();
  const [sessions, setSessions] = useState<(Session & { productName?: string })[] | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const resourceName = useMemo(() => {
    const map = new Map(resources.map((r) => [r.id, r.name]));
    return (id: string | null | undefined) => (id ? map.get(id) ?? id : "—");
  }, [resources]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ sessions: (Session & { productName?: string })[] }>(
      `/api/sessions${qs({ from: `${todayISO()}T00:00:00`, storeId })}`,
    )
      .then((d) => setSessions(d.sessions))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [storeId]);

  useEffect(load, [load]);
  useEffect(() => {
    api<{ resources: Resource[] }>("/api/resources")
      .then((d) => setResources(d.resources))
      .catch(() => setResources([]));
  }, []);

  const remove = async (s: Session) => {
    if (!window.confirm(`Delete session on ${fmtDateTime(s.startsAt)}?`)) return;
    setDeleting(s.id);
    try {
      await api(`/api/sessions/${s.id}`, { method: "DELETE" });
      toast.success("Session deleted");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="card">
      {error && <ErrorNote message={error} onRetry={load} />}
      {loading ? (
        <Skeleton rows={5} height={20} />
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState
          title="No upcoming sessions"
          hint="Schedule sessions from a course product page."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Course</th>
                <th>Store</th>
                <th>Room</th>
                <th>Trainers</th>
                <th className="num">Booked / cap.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.startsAt)}</td>
                  <td className="muted">
                    {fmtTime(s.startsAt)}–{fmtTime(s.endsAt)}
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {s.productName ?? s.productNo}
                    {s.seriesId && (
                      <span className="faint"> ({s.instanceNo}/{s.instanceCount})</span>
                    )}
                  </td>
                  <td className="muted">{storeName(s.storeId)}</td>
                  <td className="muted">{resourceName(s.roomId)}</td>
                  <td className="muted">
                    {s.trainerIds.length > 0
                      ? s.trainerIds.map((t) => resourceName(t)).join(", ")
                      : "—"}
                  </td>
                  <td className="num">
                    {s.booked}/{s.capacity}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={deleting === s.id}
                      onClick={() => void remove(s)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------------- Resources tab ---------------- */

function AvailabilityPanel({ resource }: { resource: Resource }) {
  const toast = useToast();
  const [slots, setSlots] = useState<AvailabilitySlot[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [csv, setCsv] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api<{ slots: AvailabilitySlot[] }>(`/api/resources/${resource.id}/availability`)
      .then((d) => setSlots(d.slots))
      .catch(() => setSlots([]))
      .finally(() => setLoading(false));
  }, [resource.id]);

  useEffect(load, [load]);

  const importCsv = async () => {
    const parsed: AvailabilitySlot[] = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [date = "", from = "", to = ""] = line.split(",").map((p) => p.trim());
        return { date, from, to };
      })
      .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && s.from !== "" && s.to !== "");
    if (parsed.length === 0) {
      toast.error("No valid lines — expected: 2026-07-10,09:00,17:00");
      return;
    }
    setPosting(true);
    try {
      const { added } = await api<{ added: number }>(
        `/api/resources/${resource.id}/availability`,
        { body: { slots: parsed } },
      );
      toast.success(`Added ${added} availability slot${added === 1 ? "" : "s"}`);
      setCsv("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed");
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">Availability — {resource.name}</h2>
      <Field
        label="Paste CSV slots"
        hint="One slot per line: date,from,to — e.g. 2026-07-10,09:00,17:00"
      >
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"2026-07-10,09:00,17:00\n2026-07-11,09:00,12:00"}
          rows={4}
        />
      </Field>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={posting || !csv.trim()}
          onClick={() => void importCsv()}
        >
          {posting && <Spinner small />} Import slots
        </button>
      </div>

      <hr className="divider" />
      {loading ? (
        <Skeleton rows={3} />
      ) : !slots || slots.length === 0 ? (
        <EmptyState title="No availability slots yet" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s, i) => (
                <tr key={i}>
                  <td>{fmtDate(s.date)}</td>
                  <td className="muted">{s.from}</td>
                  <td className="muted">{s.to}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResourceColumn({
  type,
  title,
  resources,
  selectedId,
  onSelect,
  onChanged,
}: {
  type: ResourceType;
  title: string;
  resources: Resource[];
  selectedId: string | null;
  onSelect: (r: Resource) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { stores, storeName } = useStores();
  const [name, setName] = useState("");
  const [resStore, setResStore] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);

  const add = async () => {
    if (!name.trim() || !resStore) {
      toast.error("Name and store are required");
      return;
    }
    setAdding(true);
    try {
      await api<{ resource: Resource }>("/api/resources", {
        body: { type, name: name.trim(), storeId: resStore, notes: notes || undefined },
      });
      toast.success(`${title.slice(0, -1)} added`);
      setName("");
      setNotes("");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const remove = async (r: Resource) => {
    if (!window.confirm(`Delete ${r.name}?`)) return;
    try {
      await api(`/api/resources/${r.id}`, { method: "DELETE" });
      toast.success(`${r.name} deleted`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const list = resources.filter((r) => r.type === type);

  return (
    <div className="card">
      <h2 className="card-title">{title}</h2>
      {list.length === 0 && <div className="faint" style={{ marginBottom: 10 }}>None yet.</div>}
      {list.map((r) => (
        <div
          key={r.id}
          className={`resource-item ${selectedId === r.id ? "selected" : ""}`}
          onClick={() => onSelect(r)}
        >
          <div>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <div className="faint">
              {storeName(r.storeId)}
              {r.notes ? ` · ${r.notes}` : ""}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              void remove(r);
            }}
          >
            Delete
          </button>
        </div>
      ))}

      <hr className="divider" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <input
          type="text"
          placeholder={`${title.slice(0, -1)} name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={resStore} onChange={(e) => setResStore(e.target.value)}>
          <option value="">Select store…</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={adding}
          onClick={() => void add()}
        >
          {adding && <Spinner small />} Add {title.slice(0, -1).toLowerCase()}
        </button>
      </div>
    </div>
  );
}

function ResourcesTab() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Resource | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ resources: Resource[] }>("/api/resources")
      .then((d) => {
        setResources(d.resources);
        setSelected((prev) => (prev ? d.resources.find((r) => r.id === prev.id) ?? null : null));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (loading && resources.length === 0) {
    return (
      <div className="card">
        <Skeleton rows={5} height={20} />
      </div>
    );
  }

  return (
    <>
      {error && <ErrorNote message={error} onRetry={load} />}
      <div className="grid-2">
        <ResourceColumn
          type="ROOM"
          title="Rooms"
          resources={resources}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onChanged={load}
        />
        <ResourceColumn
          type="TRAINER"
          title="Trainers"
          resources={resources}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onChanged={load}
        />
      </div>
      <div style={{ height: 18 }} />
      {selected ? (
        <AvailabilityPanel key={selected.id} resource={selected} />
      ) : (
        <div className="card">
          <EmptyState
            title="Select a room or trainer"
            hint="Click a resource above to manage its availability."
          />
        </div>
      )}
    </>
  );
}

/* ---------------- Page ---------------- */

export function Courses() {
  const [tab, setTab] = useState<"schedule" | "resources">("schedule");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sessions &amp; Resources</h1>
          <div className="page-sub">Course schedule, rooms and trainers</div>
        </div>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${tab === "schedule" ? "active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          Schedule
        </button>
        <button
          type="button"
          className={`tab ${tab === "resources" ? "active" : ""}`}
          onClick={() => setTab("resources")}
        >
          Resources
        </button>
      </div>

      {tab === "schedule" ? <ScheduleTab /> : <ResourcesTab />}
    </div>
  );
}
