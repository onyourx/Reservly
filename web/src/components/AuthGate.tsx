import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { Spinner } from "./ui";
import { LogoMark } from "./Logo";

export type AuthAccess = {
  role: "superadmin" | "legacy" | "owner" | "member";
  permissions: {
    products: boolean;
    bookings: boolean;
    sessions: boolean;
    reports: boolean;
    availability: boolean;
  };
  storeIds: "*" | string[];
  canManageUsers: boolean;
};

interface AuthResponse {
  required: boolean;
  authenticated: boolean;
  role?: "superadmin" | "staff" | null;
  tenant?: string | null;
  username?: string | null;
  access?: AuthAccess | null;
}

interface AuthContextValue {
  access: AuthAccess | null;
  username: string | null;
  tenant: string | null;
}

const FULL_ACCESS: AuthAccess = {
  role: "legacy",
  permissions: {
    products: true,
    bookings: true,
    sessions: true,
    reports: true,
    availability: true,
  },
  storeIds: "*",
  canManageUsers: true,
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within <AuthGate>");
  return context;
}

/** Blocks the app behind the staff password when one is configured; also
 *  re-locks when any API call comes back 401 (session expiry). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "locked" | "open">("checking");
  const [auth, setAuth] = useState<AuthResponse | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotConfirm, setForgotConfirm] = useState(false);

  const check = useCallback(() => {
    api<AuthResponse>("/api/auth")
      .then((d) => {
        setAuth(d);
        setState(d.required && !d.authenticated ? "locked" : "open");
      })
      .catch(() => {
        setAuth(null);
        setState("open");
      }); // API down: let the app render its own errors
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuth(null);
      setState("locked");
    };
    window.addEventListener("bd:unauthorized", onUnauthorized);
    return () => window.removeEventListener("bd:unauthorized", onUnauthorized);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ role?: "superadmin" | "staff" }>("/api/login", { body: { username, password } });
      window.location.href = result.role === "superadmin" ? "/tenants" : "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (window.location.pathname === "/reset-password") {
    return <ResetPassword />;
  }

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
          {!forgotMode ? (
            // Login form
            <>
              <div className="logo" style={{ marginBottom: 16 }}>
                <LogoMark size={40} />
                <span className="logo-text">
                  Bagsy
                  <small>Booking Desk</small>
                </span>
              </div>
              <input
                type="text"
                autoFocus
                autoComplete="username"
                placeholder="Email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              <input
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {error && <div className="error-note" style={{ marginTop: 10 }}>{error}</div>}
              <button type="submit" className="btn btn-primary" disabled={busy || !username || !password} style={{ marginTop: 12, width: "100%" }}>
                {busy && <Spinner small />} Sign in
              </button>
              <button type="button" className="linklike" onClick={() => setForgotMode(true)} style={{ marginTop: 12 }}>
                Forgot password?
              </button>
            </>
          ) : (
            // Forgot password form
            <>
              <div className="logo" style={{ marginBottom: 16 }}>
                <LogoMark size={40} />
                <span className="logo-text">
                  Bagsy
                  <small>Booking Desk</small>
                </span>
              </div>
              <p style={{ color: "var(--text-soft)", marginTop: 0 }}>
                Enter your account email — if it has an email on file, you'll receive a reset link.
              </p>
              <input
                type="email"
                autoFocus
                autoComplete="username"
                placeholder="Email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
              />
              {forgotConfirm && (
                <div style={{ color: "var(--text-soft)", fontSize: "13px", textAlign: "center", marginTop: 10 }}>
                  If that account has an email on file, a reset link has been sent.
                </div>
              )}
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={forgotBusy || !forgotEmail}
                  style={{ flex: 1 }}
                  onClick={async () => {
                    setForgotBusy(true);
                    setForgotConfirm(false);
                    try {
                      await api("/api/admin/forgot-password", { body: { username: forgotEmail } });
                      setForgotConfirm(true);
                    } catch {
                      // errors treated same as success — no account enumeration
                      setForgotConfirm(true);
                    } finally {
                      setForgotBusy(false);
                    }
                  }}
                >
                  {forgotBusy && <Spinner small />} Send reset link
                </button>
                <button
                  type="button"
                  className="linklike"
                  onClick={() => {
                    setForgotMode(false);
                    setForgotEmail("");
                    setForgotConfirm(false);
                  }}
                >
                  Back to sign in
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    );
  }
  const access = auth?.access ?? FULL_ACCESS;
  return (
    <AuthContext.Provider
      value={{
        access,
        username: auth?.username ?? null,
        tenant: auth?.tenant ?? null,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  const token = new URLSearchParams(window.location.search).get("token");

  if (!token) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="logo" style={{ marginBottom: 16 }}>
            <LogoMark size={40} />
            <span className="logo-text">
              Bagsy
              <small>Booking Desk</small>
            </span>
          </div>
          <p style={{ color: "var(--text-soft)" }}>This reset link is incomplete.</p>
          <a href="/" className="btn btn-primary" style={{ width: "100%", textAlign: "center" }}>
            Back to sign in
          </a>
        </div>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setBusy(true);
    try {
      await api("/api/admin/reset-password", { body: { token, password } });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="logo" style={{ marginBottom: 16 }}>
            <LogoMark size={40} />
            <span className="logo-text">
              Bagsy
              <small>Booking Desk</small>
            </span>
          </div>
          <p style={{ color: "var(--text-soft)", textAlign: "center" }}>
            Password updated — sign in with your new password.
          </p>
          <a href="/" className="btn btn-primary" style={{ width: "100%", textAlign: "center" }}>
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="logo" style={{ marginBottom: 16 }}>
          <LogoMark size={40} />
          <span className="logo-text">
            Bagsy
            <small>Booking Desk</small>
          </span>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="new-password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        {error && <div className="error-note" style={{ marginTop: 10 }}>{error}</div>}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || password.length < 8 || password !== confirmPassword}
          style={{ marginTop: 12, width: "100%" }}
        >
          {busy && <Spinner small />} Reset password
        </button>
      </form>
    </div>
  );
}
