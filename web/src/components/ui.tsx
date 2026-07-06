import type { ReactNode } from "react";

/** Loading placeholder rows. */
export function Skeleton({ rows = 3, height = 16 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{ height, width: `${100 - (i % 3) * 12}%` }}
        />
      ))}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={`spinner ${small ? "spinner-sm" : ""}`} aria-label="Loading" />;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-note">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Labelled form field wrapper. */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
