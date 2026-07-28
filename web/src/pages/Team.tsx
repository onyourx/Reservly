import { useCallback, useEffect, useState } from "react";
import { api, type StaffUser } from "../api";
import { useI18n } from "../components/I18n";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";

type PermKey = keyof StaffUser["perms"];

interface UserForm {
  username: string;
  displayName: string;
  password: string;
  role: StaffUser["role"];
  perms: StaffUser["perms"];
  storeIds: "*" | string[];
}

const EMPTY_PERMS: StaffUser["perms"] = {
  products: false,
  bookings: false,
  sessions: false,
  reports: false,
  availability: false,
};

const FULL_PERMS: StaffUser["perms"] = {
  products: true,
  bookings: true,
  sessions: true,
  reports: true,
  availability: true,
};

const EMPTY_FORM: UserForm = {
  username: "",
  displayName: "",
  password: "",
  role: "member",
  perms: EMPTY_PERMS,
  storeIds: "*",
};

const PERMISSION_LABELS: { key: PermKey; label: string }[] = [
  { key: "products", label: "Products" },
  { key: "bookings", label: "Bookings" },
  { key: "sessions", label: "Sessions & Resources" },
  { key: "reports", label: "Reports" },
  { key: "availability", label: "Hours & blackouts" },
];

function apiErrorMessage(message: string): string {
  if (message === "username_exists") return "That username is already taken";
  if (message === "invalid_username") {
    return "Username must be a valid email address";
  }
  if (message === "password_too_short") return "Password must be at least 8 characters";
  if (message === "invalid_role") return "Invalid role selected";
  if (message.startsWith("Unknown store id:")) return "Store selection includes an unknown store";
  if (message === "cannot_lock_self_out") return "You can't remove your own owner access";
  return message;
}

export function Team() {
  const { t } = useI18n();
  const { stores, storeName } = useStores();
  const toast = useToast();
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffUser | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<UserForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api<{ users: StaffUser[] }>("/api/users")
      .then((data) => setUsers(data.users))
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(load, [load]);

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const startAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const startEdit = (user: StaffUser) => {
    setEditing(user);
    setForm({
      username: user.username,
      displayName: user.displayName,
      password: "",
      role: user.role,
      perms: { ...user.perms },
      storeIds: user.storeIds === "*" ? "*" : [...user.storeIds],
    });
    setFormOpen(true);
  };

  const save = async () => {
    setBusy(true);
    const perms = form.role === "owner" ? FULL_PERMS : form.perms;
    const base = {
      displayName: form.displayName,
      role: form.role,
      perms,
      storeIds: form.storeIds,
    };
    try {
      if (editing) {
        const body = form.password ? { ...base, password: form.password } : base;
        await api(`/api/users/${editing.id}`, { method: "PUT", body });
        toast.success(t("User updated"));
      } else {
        await api("/api/users", {
          body: { ...base, username: form.username, password: form.password },
        });
        toast.success(t("User added"));
      }
      closeForm();
      load();
    } catch (error) {
      const message = error instanceof Error ? apiErrorMessage(error.message) : "Could not save user";
      toast.error(t(message));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (user: StaffUser) => {
    setActionId(user.id);
    try {
      await api(`/api/users/${user.id}`, { method: "PUT", body: { active: !user.active } });
      toast.success(t(user.active ? "User disabled" : "User enabled"));
      load();
    } catch (error) {
      const message = error instanceof Error ? apiErrorMessage(error.message) : "Could not update user";
      toast.error(t(message));
    } finally {
      setActionId(null);
    }
  };

  const remove = async (user: StaffUser) => {
    if (confirmDeleteId !== user.id) {
      setConfirmDeleteId(user.id);
      return;
    }
    setActionId(user.id);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      toast.success(t("User deleted"));
      setConfirmDeleteId(null);
      if (editing?.id === user.id) closeForm();
      load();
    } catch (error) {
      const message = error instanceof Error ? apiErrorMessage(error.message) : "Could not delete user";
      toast.error(t(message));
    } finally {
      setActionId(null);
    }
  };

  const accessLabel = (user: StaffUser) => {
    if (user.role === "owner") return t("Full access");
    const enabled = PERMISSION_LABELS
      .filter(({ key }) => user.perms[key])
      .map(({ label }) => t(label));
    return enabled.length ? enabled.join(", ") : t("No access");
  };

  const storesLabel = (user: StaffUser) =>
    user.storeIds === "*" ? t("All stores") : user.storeIds.map(storeName).join(", ") || t("No stores");

  const valid = form.username.trim() !== ""
    && (editing !== null || form.password.length > 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("Team")}</h1>
          <div className="page-sub">{t("Manage staff accounts, permissions, and store access")}</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={startAdd}>
          {t("Add user")}
        </button>
      </div>

      {formOpen && (
        <div className="card team-form">
          <h2 className="card-title">{t(editing ? "Edit user" : "Add user")}</h2>
          <div className="form-grid">
            <Field label={t("Email (username)")}>
              <input
                type="email"
                value={form.username}
                placeholder="anna@example.com"
                autoComplete="off"
                readOnly={editing !== null}
                autoFocus={!editing}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
              />
            </Field>
            <Field label={t("Name")}>
              <input
                type="text"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              />
            </Field>
            <Field
              label={t("Password")}
              hint={editing ? t("Leave empty to keep current password") : undefined}
            >
              <input
                type="password"
                value={form.password}
                placeholder={editing ? t("Leave empty to keep current password") : ""}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
              />
            </Field>
            <Field label={t("Role")}>
              <select
                value={form.role}
                onChange={(event) => setForm({ ...form, role: event.target.value as StaffUser["role"] })}
              >
                <option value="member">{t("Member")}</option>
                <option value="owner">{t("Owner")}</option>
              </select>
            </Field>
          </div>

          <fieldset className="team-fieldset">
            <legend>{t("Store access")}</legend>
            <label className="checkbox-row">
              <input
                type="radio"
                name="store-access"
                checked={form.storeIds === "*"}
                onChange={() => setForm({ ...form, storeIds: "*" })}
              />
              {t("All stores")}
            </label>
            <label className="checkbox-row">
              <input
                type="radio"
                name="store-access"
                checked={form.storeIds !== "*"}
                onChange={() => setForm({ ...form, storeIds: [] })}
              />
              {t("Specific stores")}
            </label>
            {form.storeIds !== "*" && (
              <div className="team-options">
                {stores.map((store) => (
                  <label className="checkbox-row" key={store.id}>
                    <input
                      type="checkbox"
                      checked={form.storeIds !== "*" && form.storeIds.includes(store.id)}
                      onChange={(event) => {
                        if (form.storeIds === "*") return;
                        const storeIds = event.target.checked
                          ? [...form.storeIds, store.id]
                          : form.storeIds.filter((id) => id !== store.id);
                        setForm({ ...form, storeIds });
                      }}
                    />
                    {store.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="team-fieldset">
            <legend>{t("Permissions")}</legend>
            {form.role === "owner" ? (
              <div className="faint">{t("Owners have full access to everything")}</div>
            ) : (
              <div className="team-options">
                {PERMISSION_LABELS.map(({ key, label }) => (
                  <label className="checkbox-row" key={key}>
                    <input
                      type="checkbox"
                      checked={form.perms[key]}
                      onChange={(event) => setForm({
                        ...form,
                        perms: { ...form.perms, [key]: event.target.checked },
                      })}
                    />
                    {t(label)}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <div className="btn-row team-form-actions">
            <button type="button" className="btn" onClick={closeForm} disabled={busy}>
              {t("Cancel")}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !valid}>
              {busy && <Spinner small />}
              {t(editing ? "Save Changes" : "Add User")}
            </button>
          </div>
        </div>
      )}

      {loadError && <ErrorNote message={t(apiErrorMessage(loadError))} onRetry={load} />}
      <div className="card">
        {users === null ? (
          <Skeleton rows={6} />
        ) : users.length === 0 ? (
          <EmptyState title={t("No team members")} hint={t("Add a user to create a personal staff account.")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Username")}</th>
                  <th>{t("Name")}</th>
                  <th>{t("Role")}</th>
                  <th>{t("Access")}</th>
                  <th>{t("Stores")}</th>
                  <th>{t("Status")}</th>
                  <th>{t("Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="mono">{user.username}</td>
                    <td>{user.displayName || "—"}</td>
                    <td>{t(user.role === "owner" ? "Owner" : "Member")}</td>
                    <td>{accessLabel(user)}</td>
                    <td>{storesLabel(user)}</td>
                    <td>
                      <span className={`badge ${user.active ? "" : "badge-off"}`}>
                        {t(user.active ? "Active" : "Disabled")}
                      </span>
                    </td>
                    <td>
                      <div className="btn-row">
                        <button type="button" className="btn btn-sm" onClick={() => startEdit(user)}>
                          {t("Edit")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={actionId === user.id}
                          onClick={() => void toggleActive(user)}
                        >
                          {t(user.active ? "Disable" : "Enable")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={actionId === user.id}
                          onClick={() => void remove(user)}
                          onBlur={() => setConfirmDeleteId((id) => id === user.id ? null : id)}
                        >
                          {t(confirmDeleteId === user.id ? "Confirm delete" : "Delete")}
                        </button>
                      </div>
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
