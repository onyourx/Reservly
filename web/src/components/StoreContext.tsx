import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import type { Store } from "../api";

const STORAGE_KEY = "bookingdesk.storeId";

interface StoreCtx {
  stores: Store[];
  loading: boolean;
  /** Currently selected store id, or "" for all stores. */
  storeId: string;
  setStoreId: (id: string) => void;
  storeName: (id: string | null | undefined) => string;
}

const StoreContext = createContext<StoreCtx | null>(null);

export function useStores(): StoreCtx {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStores must be used within <StoreProvider>");
  return ctx;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [storeId, setStoreIdState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );

  useEffect(() => {
    let cancelled = false;
    api<{ stores: Store[] }>("/api/stores")
      .then((data) => {
        if (!cancelled) setStores(data.stores);
      })
      .catch(() => {
        /* topbar will simply show no stores; pages surface their own errors */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setStoreId = (id: string) => {
    setStoreIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  };

  const storeName = (id: string | null | undefined): string => {
    if (!id) return "—";
    const s = stores.find((st) => st.id === id);
    return s ? s.name : id;
  };

  return (
    <StoreContext.Provider value={{ stores, loading, storeId, setStoreId, storeName }}>
      {children}
    </StoreContext.Provider>
  );
}
