import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, qs } from "../api";
import type { Product, ProductType } from "../api";
import { money } from "../format";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Skeleton, Spinner } from "../components/ui";

export function ProductsList() {
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const type = (searchParams.get("type") as ProductType | null) ?? "RENTAL";

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ products: Product[] }>(`/api/products${qs({ type, q: debouncedQ })}`)
      .then((d) => setProducts(d.products))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [type, debouncedQ]);

  useEffect(load, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { synced } = await api<{ synced: number }>("/api/products/sync", {
        method: "POST",
        body: {},
      });
      toast.success(`Synced ${synced} products from NAV`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <div className="page-sub">Rental equipment and courses synced from NAV</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing && <Spinner small />} Sync from NAV
        </button>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab ${type === "RENTAL" ? "active" : ""}`}
          onClick={() => setSearchParams({ type: "RENTAL" })}
        >
          Rentals
        </button>
        <button
          type="button"
          className={`tab ${type === "COURSE" ? "active" : ""}`}
          onClick={() => setSearchParams({ type: "COURSE" })}
        >
          Courses
        </button>
      </div>

      <div className="filters">
        <input
          type="text"
          placeholder="Search name or product no…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {error && <ErrorNote message={error} onRetry={load} />}

      {loading ? (
        <div className="card">
          <Skeleton rows={5} height={22} />
        </div>
      ) : !products || products.length === 0 ? (
        <div className="card">
          <EmptyState
            title={`No ${type === "RENTAL" ? "rental" : "course"} products`}
            hint='Use "Sync from NAV" to pull the catalogue.'
          />
        </div>
      ) : (
        <div className="product-grid">
          {products.map((p) => (
            <div
              key={p.id}
              className="product-card"
              onClick={() => navigate(`/products/${p.id}`)}
            >
              <div className="product-thumb">
                {p.imageUrl ? (
                  <img src={p.imageUrl} alt={p.name} loading="lazy" />
                ) : (
                  <span>{p.type === "RENTAL" ? "📷" : "🎓"}</span>
                )}
              </div>
              <div className="product-body">
                <div className="faint mono">{p.productNo}</div>
                <div className="product-name">{p.name}</div>
                <div className="product-meta">
                  <div>
                    <div style={{ fontWeight: 650 }}>{money(p.defaultUnitPrice)}</div>
                    {p.securityDeposit > 0 && (
                      <div className="faint">deposit {money(p.securityDeposit)}</div>
                    )}
                  </div>
                  <span className={`badge ${p.availableOnWeb ? "" : "badge-off"}`}>
                    {p.availableOnWeb ? "On web" : "Store only"}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
