import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

interface ToastItem {
  id: number;
  kind: "success" | "error";
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: "success" | "error", message: string) => {
    const id = nextId.current++;
    setToasts((list) => [...list, { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const success = useCallback((m: string) => push("success", m), [push]);
  const error = useCallback((m: string) => push("error", m), [push]);

  return (
    <ToastContext.Provider value={{ success, error }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span className="toast-dot" />
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
