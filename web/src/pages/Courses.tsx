import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, qs } from "../api";
import type {
  AvailabilitySlot,
  Product,
  Resource,
  ResourceBlock,
  ResourceType,
  Session,
  SessionAttendees,
} from "../api";
import { fmtDate, fmtDateTime, fmtTime, todayISO } from "../format";
import { useI18n } from "../components/I18n";
import { Modal } from "../components/Modal";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

/* ---------------- Schedule tab ---------------- */

function ScheduleTab() {
  const toast = useToast();
  const navigate = useNavigate();
  const { language, t } = useI18n();
  const { storeId, storeName } = useStores();
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [sessions, setSessions] = useState<(Session & { productName?: string })[] | null>(null);
  const [courses, setCourses] = useState<Product[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [courseId, setCourseId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [trainerId, setTrainerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [attendeeData, setAttendeeData] = useState<SessionAttendees | null>(null);
  const [attendeesLoading, setAttendeesLoading] = useState(false);

  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [month]);

  const range = useMemo(() => {
    const from = calendarDays[0];
    const through = calendarDays[calendarDays.length - 1];
    return {
      from: `${dateKey(from)}T00:00:00`,
      to: `${dateKey(through)}T23:59:59.999`,
    };
  }, [calendarDays]);

  const resourceName = useMemo(() => {
    const map = new Map(resources.map((r) => [r.id, r.name]));
    return (id: string | null | undefined) => (id ? map.get(id) ?? id : "—");
  }, [resources]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ sessions: (Session & { productName?: string })[] }>(
      `/api/sessions${qs(
        view === "calendar"
          ? { from: range.from, to: range.to, storeId }
          : { from: `${todayISO()}T00:00:00`, storeId },
      )}`,
    )
      .then((d) => setSessions(d.sessions))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [range, storeId, view]);

  useEffect(load, [load]);
  useEffect(() => {
    api<{ resources: Resource[] }>("/api/resources")
      .then((d) => setResources(d.resources))
      .catch(() => setResources([]));
    api<{ products: Product[] }>("/api/products?type=COURSE")
      .then((d) => setCourses(d.products))
      .catch(() => setCourses([]));
  }, []);

  const rooms = useMemo(() => resources.filter((resource) => resource.type === "ROOM"), [resources]);
  const trainers = useMemo(() => resources.filter((resource) => resource.type === "TRAINER"), [resources]);
  const filtersActive = Boolean(courseId || roomId || trainerId);
  const filteredSessions = useMemo(
    () => (sessions ?? []).filter((session) =>
      (!courseId || session.productId === courseId)
      && (!roomId || session.roomId === roomId)
      && (!trainerId || session.trainers.some((trainer) => trainer.id === trainerId))),
    [courseId, roomId, sessions, trainerId],
  );

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

  const sessionsByDate = useMemo(() => {
    const grouped = new Map<string, (Session & { productName?: string })[]>();
    for (const session of filteredSessions) {
      const key = dateKey(new Date(session.startsAt));
      grouped.set(key, [...(grouped.get(key) ?? []), session]);
    }
    for (const daySessions of grouped.values()) {
      daySessions.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }
    return grouped;
  }, [filteredSessions]);

  const calendarFilterName = !courseId
    ? (roomId ? rooms.find((room) => room.id === roomId)?.name : trainers.find((trainer) => trainer.id === trainerId)?.name)
    : undefined;

  const openAttendees = async (sessionId: string) => {
    setAttendeesLoading(true);
    try {
      setAttendeeData(await api<SessionAttendees>(`/api/sessions/${sessionId}/attendees`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load attendees");
    } finally {
      setAttendeesLoading(false);
    }
  };

  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(language, { weekday: "short" });
    return Array.from({ length: 7 }, (_, day) =>
      formatter.format(new Date(2024, 0, 7 + day)),
    );
  }, [language]);

  return (
    <div className="card">
      <div className="filters">
        <label>
          <span>{t("Course")}</span>
          <select value={courseId} onChange={(event) => setCourseId(event.target.value)}>
            <option value="">{t("All courses")}</option>
            {courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Room")}</span>
          <select value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            <option value="">{t("All rooms")}</option>
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select>
        </label>
        <label>
          <span>{t("Trainer")}</span>
          <select value={trainerId} onChange={(event) => setTrainerId(event.target.value)}>
            <option value="">{t("All trainers")}</option>
            {trainers.map((trainer) => <option key={trainer.id} value={trainer.id}>{trainer.name}</option>)}
          </select>
        </label>
        {filtersActive && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setCourseId("");
              setRoomId("");
              setTrainerId("");
            }}
          >
            {t("Reset")}
          </button>
        )}
      </div>
      <div className="calendar-head">
        <div>
          {view === "calendar" && (
            <h2 className="card-title">
              {new Intl.DateTimeFormat(language, { month: "long", year: "numeric" }).format(month)}
            </h2>
          )}
        </div>
        <div className="calendar-controls">
          {view === "calendar" && (
            <>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={t("Previous month")}
                onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
              >
                ←
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  const now = new Date();
                  setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                }}
              >
                {t("Today")}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-label={t("Next month")}
                onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
              >
                →
              </button>
            </>
          )}
          <div className="segmented" aria-label={`${t("Calendar")} / ${t("List")}`}>
            <button
              type="button"
              className={view === "calendar" ? "active" : ""}
              onClick={() => setView("calendar")}
            >
              {t("Calendar")}
            </button>
            <button
              type="button"
              className={view === "list" ? "active" : ""}
              onClick={() => setView("list")}
            >
              {t("List")}
            </button>
          </div>
        </div>
      </div>
      {view === "calendar" && calendarFilterName && (
        <p className="muted calendar-filter-heading">
          {t("Calendar: {{name}}").replace("{{name}}", calendarFilterName)}
        </p>
      )}
      {error && <ErrorNote message={error} onRetry={load} />}
      {loading ? (
        <Skeleton rows={5} height={20} />
      ) : view === "calendar" ? (
        <div className="calendar-grid">
          {weekdays.map((weekday) => (
            <div className="calendar-weekday" key={weekday}>{weekday}</div>
          ))}
          {calendarDays.map((date) => {
            const key = dateKey(date);
            const isToday = key === todayISO();
            const outside = date.getMonth() !== month.getMonth();
            return (
              <div
                className={`calendar-day${outside ? " outside" : ""}${isToday ? " today" : ""}`}
                key={key}
              >
                <span className="calendar-date">{date.getDate()}</span>
                <div className="session-chip-list">
                  {(sessionsByDate.get(key) ?? []).map((session) => (
                    <button
                      type="button"
                      className={`session-chip${session.booked >= session.capacity ? " full" : ""}`}
                      key={session.id}
                      onClick={() => void openAttendees(session.id)}
                    >
                      <span>{fmtTime(session.startsAt)} {session.productName ?? session.productNo} ({session.booked}/{session.capacity})</span>
                      {(session.roomName || session.trainers.length > 0) && (
                        <span className="session-chip-hint">
                          {[session.roomName, session.trainers.map((trainer) => trainer.name).join(", ")].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : filteredSessions.length === 0 ? (
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
              {filteredSessions.map((s) => (
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
                  <td className="muted">{s.roomName || resourceName(s.roomId)}</td>
                  <td className="muted">
                    {s.trainers.length > 0
                      ? s.trainers.map((trainer) => trainer.name).join(", ")
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
      {attendeesLoading && (
        <div className="modal-overlay">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal-body"><Spinner /> {t("Attendees")}</div>
          </div>
        </div>
      )}
      {attendeeData && !attendeesLoading && (
        <Modal
          title={t("Session details")}
          onClose={() => setAttendeeData(null)}
          wide
          footer={
            <div className="btn-row">
              <a
                className="btn btn-primary"
                href={`/print/enrollment/${attendeeData.session.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {t("Print enrollment sheet")}
              </a>
              <button type="button" className="btn" onClick={() => setAttendeeData(null)}>
                {t("Close")}
              </button>
            </div>
          }
        >
          <h3>{attendeeData.session.productName}</h3>
          <p className="muted">
            {fmtDateTime(attendeeData.session.startsAt)} · {storeName(attendeeData.session.storeId)} · {attendeeData.attendees.reduce((sum, attendee) => sum + attendee.qty, 0)}/{attendeeData.session.capacity}
          </p>
          <h4>{t("Session attendee roster")}</h4>
          {attendeeData.attendees.length === 0 ? (
            <EmptyState title={t("Attendees")} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("Name")}</th>
                    <th>{t("Email")}</th>
                    <th>{t("Phone")}</th>
                    <th className="num">{t("Seats")}</th>
                    <th>{t("Status")}</th>
                    <th>{t("Check-in")}</th>
                    <th>{t("No-show")}</th>
                  </tr>
                </thead>
                <tbody>
                  {attendeeData.attendees.map((attendee) => (
                    <tr
                      key={attendee.bookingId}
                      className="clickable-row"
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/bookings/${attendee.bookingId}`)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          navigate(`/bookings/${attendee.bookingId}`);
                        }
                      }}
                    >
                      <td>{attendee.customerFirst} {attendee.customerLast}</td>
                      <td>{attendee.customerEmail || "—"}</td>
                      <td>{attendee.customerPhone || "—"}</td>
                      <td className="num">{attendee.qty}</td>
                      <td><span className="badge">{attendee.bookingStatus}</span></td>
                      <td>{attendee.checkedInAt ? fmtDateTime(attendee.checkedInAt) : "—"}</td>
                      <td>{attendee.noShowAt ? fmtDateTime(attendee.noShowAt) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/* ---------------- Resources tab ---------------- */

const isoDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function ResourceScheduleEditor({ resource, onChanged }: { resource: Resource; onChanged: () => void }) {
  const toast = useToast();
  const { t } = useI18n();
  const [capacity, setCapacity] = useState(String(resource.capacity ?? 0));
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [fromTime, setFromTime] = useState("09:00");
  const [toTime, setToTime] = useState("17:00");
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 56);
    return isoDate(date);
  });
  const [replace, setReplace] = useState(false);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [slots, setSlots] = useState<AvailabilitySlot[]>([]);
  const [blocks, setBlocks] = useState<ResourceBlock[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [windowFrom, setWindowFrom] = useState("09:00");
  const [windowTo, setWindowTo] = useState("17:00");
  const [blockFrom, setBlockFrom] = useState("14:00");
  const [blockTo, setBlockTo] = useState("16:00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const calendarDays = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [month]);
  const load = useCallback(async () => {
    const from = isoDate(calendarDays[0]);
    const to = isoDate(calendarDays[calendarDays.length - 1]);
    try {
      const [availability, blockData] = await Promise.all([
        api<{ slots: AvailabilitySlot[] }>(`/api/resources/${resource.id}/availability${qs({ from, to })}`),
        api<{ blocks: ResourceBlock[] }>(`/api/resources/${resource.id}/blocks${qs({ from, to })}`),
      ]);
      setSlots(availability.slots);
      setBlocks(blockData.blocks);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load schedule");
    }
  }, [calendarDays, resource.id, toast]);
  useEffect(() => { void load(); }, [load]);

  const execute = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message === "range_too_long"
          ? t("Range exceeds 26 weeks")
          : error instanceof Error
            ? error.message
            : "Schedule update failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const weekdayLabels = [
    [1, t("Monday")], [2, t("Tuesday")], [3, t("Wednesday")], [4, t("Thursday")],
    [5, t("Friday")], [6, t("Saturday")], [0, t("Sunday")],
  ] as const;
  const selectedSlots = slots.filter((slot) => slot.date === selectedDate);
  const selectedBlocks = blocks.filter((block) => block.date === selectedDate);

  return (
    <div>
      <div className="form-grid-3">
        <Field label={t("Room capacity")}>
          <input type="number" min={0} value={capacity} onChange={(event) => setCapacity(event.target.value)} />
        </Field>
        <div style={{ alignSelf: "end" }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void execute(
            async () => {
              await api(`/api/resources/${resource.id}`, { method: "PUT", body: { capacity: Number(capacity) || 0 } });
              onChanged();
            },
            t("Capacity") + " saved",
          )}>Save</button>
        </div>
      </div>

      <hr className="divider" />
      <h3>{t("Weekly pattern")}</h3>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {weekdayLabels.map(([value, label]) => (
          <label className="checkbox-row" key={value}>
            <input type="checkbox" checked={days.includes(value)} onChange={(event) =>
              setDays(event.target.checked ? [...days, value] : days.filter((day) => day !== value))} />
            {label}
          </label>
        ))}
      </div>
      <div className="form-grid-3">
        <Field label={t("From time")}><input type="time" value={fromTime} onChange={(event) => setFromTime(event.target.value)} /></Field>
        <Field label={t("To time")}><input type="time" value={toTime} onChange={(event) => setToTime(event.target.value)} /></Field>
        <Field label={t("Start date")}><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field>
        <Field label={t("End date")}><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field>
        <label className="checkbox-row" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
          {t("Replace existing")}
        </label>
        <button className="btn btn-primary btn-sm" style={{ alignSelf: "end" }} disabled={busy || days.length === 0}
          onClick={() => void execute(async () => {
            const result = await api<{ created: number }>(`/api/resources/${resource.id}/availability/bulk`, {
              body: { days, fromTime, toTime, startDate, endDate, replace },
            });
            toast.success(`${t("Availability slots created")}: ${result.created}`);
          })}>
          {t("Apply")}
        </button>
      </div>

      <hr className="divider" />
      <div className="calendar-head">
        <h3>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <div className="calendar-controls">
          <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button>
          <button className="btn btn-sm" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
          <button className="btn btn-sm" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button>
        </div>
      </div>
      <div className="calendar-grid">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <div className="calendar-weekday" key={day}>{day}</div>)}
        {calendarDays.map((date) => {
          const key = isoDate(date);
          return (
            <button type="button" key={key}
              className={`calendar-day selectable${date.getMonth() !== month.getMonth() ? " outside" : ""}${key === selectedDate ? " sel-start" : ""}`}
              onClick={() => setSelectedDate(key)}>
              <span className="calendar-date">{date.getDate()}</span>
              <span className="session-chip-list">
                {slots.filter((slot) => slot.date === key).map((slot) => (
                  <span className="session-chip" style={{ background: "var(--ok-soft)", borderColor: "var(--ok)" }} key={slot.id}>{slot.from}–{slot.to}</span>
                ))}
                {blocks.filter((block) => block.date === key).map((block) => (
                  <span className="session-chip full" style={{ background: "#fff4f3", borderColor: "var(--danger)", opacity: 1 }} title={block.reason} key={block.id}>
                    {block.fromTime}–{block.toTime}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>

      <hr className="divider" />
      <h3>{selectedDate}</h3>
      <div className="grid-2">
        <div>
          <h4>{t("Existing windows")}</h4>
          {selectedSlots.length === 0 ? <div className="faint">—</div> : selectedSlots.map((slot) => (
            <div className="btn-row" key={slot.id}>{slot.from}–{slot.to}
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void execute(
                () => api(`/api/resources/${resource.id}/availability/${slot.id}`, { method: "DELETE" }), "Deleted",
              )}>Delete</button>
            </div>
          ))}
          <h4>{t("Add window")}</h4>
          <div className="btn-row">
            <input type="time" value={windowFrom} onChange={(event) => setWindowFrom(event.target.value)} />
            <input type="time" value={windowTo} onChange={(event) => setWindowTo(event.target.value)} />
            <button className="btn btn-sm" disabled={busy} onClick={() => void execute(
              () => api(`/api/resources/${resource.id}/availability`, { body: { date: selectedDate, fromTime: windowFrom, toTime: windowTo } }),
              t("Add window"),
            )}>{t("Add window")}</button>
          </div>
        </div>
        <div>
          <h4>{t("Existing blocks")}</h4>
          {selectedBlocks.length === 0 ? <div className="faint">—</div> : selectedBlocks.map((block) => (
            <div className="btn-row" key={block.id}>{block.fromTime}–{block.toTime} {block.reason && `(${block.reason})`}
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void execute(
                () => api(`/api/resources/${resource.id}/blocks/${block.id}`, { method: "DELETE" }), "Deleted",
              )}>Delete</button>
            </div>
          ))}
          <h4>{t("Block time")}</h4>
          <div className="btn-row">
            <input type="time" value={blockFrom} onChange={(event) => setBlockFrom(event.target.value)} />
            <input type="time" value={blockTo} onChange={(event) => setBlockTo(event.target.value)} />
            <input type="text" value={reason} placeholder={t("Reason")} onChange={(event) => setReason(event.target.value)} />
            <button className="btn btn-sm" disabled={busy} onClick={() => void execute(
              () => api(`/api/resources/${resource.id}/blocks`, { body: { date: selectedDate, fromTime: blockFrom, toTime: blockTo, reason } }),
              t("Block time"),
            )}>{t("Block time")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
    const parsed: { date: string; from: string; to: string }[] = csv
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
  onSchedule,
}: {
  type: ResourceType;
  title: string;
  resources: Resource[];
  selectedId: string | null;
  onSelect: (r: Resource) => void;
  onChanged: () => void;
  onSchedule: (r: Resource) => void;
}) {
  const toast = useToast();
  const { stores, storeName } = useStores();
  const [name, setName] = useState("");
  const [resStore, setResStore] = useState("");
  const [notes, setNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [capacities, setCapacities] = useState<Record<string, string>>({});

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
            {type === "ROOM" && (
              <input type="number" min={0} aria-label="Capacity" style={{ marginTop: 6, width: 100 }}
                value={capacities[r.id] ?? String(r.capacity ?? 0)}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setCapacities({ ...capacities, [r.id]: event.target.value })}
                onBlur={() => void api(`/api/resources/${r.id}`, {
                  method: "PUT", body: { capacity: Number(capacities[r.id] ?? r.capacity) || 0 },
                }).then(onChanged).catch((error: Error) => toast.error(error.message))} />
            )}
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={(event) => {
              event.stopPropagation();
              onSchedule(r);
            }}>Schedule</button>
            <button type="button" className="btn btn-danger btn-sm" onClick={(e) => {
                e.stopPropagation();
                void remove(r);
              }}>Delete</button>
          </div>
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
  const [scheduledRoom, setScheduledRoom] = useState<Resource | null>(null);

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
          onSchedule={setScheduledRoom}
        />
        <ResourceColumn
          type="TRAINER"
          title="Trainers"
          resources={resources}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          onChanged={load}
          onSchedule={setScheduledRoom}
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
      {scheduledRoom && (
        <Modal title={`Schedule — ${scheduledRoom.name}`} onClose={() => setScheduledRoom(null)} wide>
          <ResourceScheduleEditor resource={scheduledRoom} onChanged={load} />
        </Modal>
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
