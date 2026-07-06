import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Spinner } from "./ui";
import { LogoMark } from "./Logo";

/** Blocks the app behind the staff password when one is configured; also
 *  re-locks when any API call comes back 401 (session expiry). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    api<{ required: boolean; authenticated: boolean }>("/api/auth")
      .then((d) => setState(d.required && !d.authenticated ? "locked" : "open"))
      .catch(() => setState("open")); // API down: let the app render its own errors
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    const onUnauthorized = () => setState("locked");
    window.addEventListener("bd:unauthorized", onUnauthorized);
    return () => window.removeEventListener("bd:unauthorized", onUnauthorized);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", { body: { password } });
      setPassword("");
      setState("open");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (state === "checking") {
    return (
      <div className="login-screen">
        <Spinner />
      </div>
    );
  }
  if (state === "locked") {
    return (
      <div className="login-screen">
        <form className="login-card" onSubmit={(e) => void submit(e)}>
          <div className="logo" style={{ marginBottom: 16 }}>
            <LogoMark size={40} />
            <span className="logo-text">
              Reservly
              <small>Booking Desk</small>
            </span>
          </div>
          <input
            type="password"
            autoFocus
            placeholder="Staff password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error-note" style={{ marginTop: 10 }}>{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy || !password} style={{ marginTop: 12, width: "100%" }}>
            {busy && <Spinner small />} Sign in
          </button>
        </form>
      </div>
    );
  }
  return <>{children}</>;
}
