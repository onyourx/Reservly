import { createContext, useCallback, useContext, useEffect, useState } from "react";
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
  refreshStores: () => Promise<void>;
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

  const refreshStores = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ stores: Store[] }>("/api/stores");
        setStores(data.stores);
        const persistedStoreId = localStorage.getItem(STORAGE_KEY) ?? "";
        const persistedIsValid = data.stores.some((store) => store.id === persistedStoreId);
        if (!persistedIsValid && data.stores.length === 1) {
          const onlyStoreId = data.stores[0].id;
          setStoreIdState(onlyStoreId);
          localStorage.setItem(STORAGE_KEY, onlyStoreId);
        } else if (!persistedIsValid && persistedStoreId) {
          setStoreIdState("");
          localStorage.removeItem(STORAGE_KEY);
        }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStores().catch(() => {
      /* topbar will simply show no stores; pages surface their own errors */
    });
  }, [refreshStores]);

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
    <StoreContext.Provider value={{ stores, loading, storeId, setStoreId, storeName, refreshStores }}>
      {children}
    </StoreContext.Provider>
  );
}
