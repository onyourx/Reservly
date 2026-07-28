import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import type { Health, KitItem, Product, ProductAddon, ProductTranslation, Resource, Session, Settings } from "../api";
import { fmtDateTime, localToISO, money } from "../format";
import { useStores } from "../components/StoreContext";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorNote, Field, Skeleton, Spinner } from "../components/ui";
import { languageName, useI18n } from "../components/I18n";
import { RentalAvailabilityCalendar } from "../components/RentalAvailabilityCalendar";
import { ProductBookings } from "../components/ProductBookings";

export function ProductDetail() {
  const { id = "" } = useParams();
  const toast = useToast();
  const { t } = useI18n();
  const { stores, storeName } = useStores();

  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [syncedAt, setSyncedAt] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [chanOnlineStore, setChanOnlineStore] = useState(true);
  const [chanPos, setChanPos] = useState(true);

  // Editable fields
  const [imageUrl, setImageUrl] = useState("");
  const [translations, setTranslations] = useState<ProductTranslation[]>([]);
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(["en", "fr"]);
  const [availableOnWeb, setAvailableOnWeb] = useState(false);
  const [shopifyProductId, setShopifyProductId] = useState("");
  const [sku, setSku] = useState("");
  const [kit, setKit] = useState<KitItem[]>([]);
  const [defaultUnitPrice, setDefaultUnitPrice] = useState("0");
  const [securityDeposit, setSecurityDeposit] = useState("0");
  const [lateFeePerDay, setLateFeePerDay] = useState("0");
  const [priceTiers, setPriceTiers] = useState<{ description: string; price: number }[]>([]);
  const [addons, setAddons] = useState<ProductAddon[]>([]);
  const [crossSellProductNos, setCrossSellProductNos] = useState<string[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [crossSellSelection, setCrossSellSelection] = useState("");

  // Session form (COURSE only)
  const [rooms, setRooms] = useState<Resource[]>([]);
  const [trainers, setTrainers] = useState<Resource[]>([]);
  const [sessStart, setSessStart] = useState("");
  const [sessEnd, setSessEnd] = useState("");
  const [sessStore, setSessStore] = useState("");
  const [sessRoom, setSessRoom] = useState("");
  const [sessTrainers, setSessTrainers] = useState<string[]>([]);
  const [sessCapacity, setSessCapacity] = useState(8);
  const [occurrences, setOccurrences] = useState(1);
  const [intervalDays, setIntervalDays] = useState(7);
  const [deliveryMode, setDeliveryMode] = useState<"IN_PERSON" | "VIRTUAL" | "HYBRID">("IN_PERSON");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [createZoom, setCreateZoom] = useState(false);
  const [addingSessions, setAddingSessions] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<{ product: Product }>(`/api/products/${id}`)
      .then((d) => {
        const p = d.product;
        setProduct(p);
        setSyncedAt(p.navSyncedAt ?? "");
        setImageUrl(p.imageUrl ?? "");
        setTranslations(p.translations?.length ? p.translations : [
          { locale: "en", name: p.name, description: p.webDescEn || "" },
          { locale: "fr", name: p.nameFr || p.name, description: p.webDescFr || "" },
        ]);
        setAvailableOnWeb(Boolean(p.availableOnWeb));
        setShopifyProductId(p.shopifyProductId ?? "");
        setSku(p.sku ?? "");
        setKit(p.kit ?? []);
        setDefaultUnitPrice(String(p.defaultUnitPrice ?? 0));
        setSecurityDeposit(String(p.securityDeposit ?? 0));
        setLateFeePerDay(String(p.lateFeePerDay ?? 0));
        setPriceTiers(p.prices ?? []);
        setAddons(p.addons ?? []);
        setCrossSellProductNos((p.crossSell ?? []).map((suggestion) => suggestion.productNo));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    api<Health>("/api/health").then(setHealth).catch(() => setHealth(null));
    api<{ settings: Partial<Settings> }>("/api/settings").then((d) => {
      try { setEnabledLanguages(JSON.parse(d.settings.enabledLanguages || '["en","fr"]')); } catch { /* defaults */ }
    }).catch(() => {});
    api<{ resources: Resource[] }>("/api/resources?type=ROOM")
      .then((d) => setRooms(d.resources))
      .catch(() => setRooms([]));
    api<{ resources: Resource[] }>("/api/resources?type=TRAINER")
      .then((d) => setTrainers(d.resources))
      .catch(() => setTrainers([]));
    api<{ products: Product[] }>("/api/products?type=RENTAL")
      .then((d) => setAllProducts(d.products))
      .catch(() => setAllProducts([]));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const { product: updated } = await api<{ product: Product }>(`/api/products/${id}`, {
        method: "PUT",
        body: {
          imageUrl,
          translations,
          availableOnWeb,
          shopifyProductId: shopifyProductId || null,
          sku: sku.trim() || "",
          kit,
          defaultUnitPrice: Number(defaultUnitPrice) || 0,
          securityDeposit: Number(securityDeposit) || 0,
          lateFeePerDay: Number(lateFeePerDay) || 0,
          prices: priceTiers,
          addons,
          crossSellProductNos: crossSellProductNos.length ? crossSellProductNos : null,
        },
      });
      setProduct((prev) => (prev ? { ...prev, ...updated, sessions: prev.sessions } : updated));
      toast.success("Product saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const publishToShopify = async () => {
    setPublishing(true);
    try {
      const d = await api<{
        product: Product;
        shopifyProductId: string;
        handle: string;
        publishedTo: string[];
        publishWarning?: string;
      }>(`/api/products/${id}/push-shopify`, {
        method: "POST",
        body: { channels: { onlineStore: chanOnlineStore, pos: chanPos } },
      });
      setProduct((prev) => (prev ? { ...prev, ...d.product, sessions: prev.sessions } : d.product));
      setShopifyProductId(d.shopifyProductId);
      const channels = d.publishedTo.length ? ` · live on ${d.publishedTo.join(" + ")}` : "";
      toast.success(`Published to Shopify (${d.handle})${channels}`);
      if (d.publishWarning) toast.error(`Channel publish warning: ${d.publishWarning}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const pushToNav = async () => {
    setPushing(true);
    try {
      const result = await api<{ ok: boolean; navSyncedAt?: string; detail?: string }>(
        `/api/products/${id}/push-nav`,
        { method: "POST", body: {} },
      );
      if (!result.ok || !result.navSyncedAt) {
        toast.error(result.detail || "NAV push failed");
        return;
      }
      setSyncedAt(result.navSyncedAt);
      setProduct((current) => current ? { ...current, navSyncedAt: result.navSyncedAt } : current);
      toast.success(t("Synced to NAV"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "NAV push failed");
    } finally {
      setPushing(false);
    }
  };

  const addSessions = async () => {
    if (!product || !sessStart || !sessEnd || !sessStore) {
      toast.error("Start, end and store are required");
      return;
    }
    setAddingSessions(true);
    try {
      const { sessions } = await api<{ sessions: Session[] }>("/api/sessions", {
        body: {
          productId: product.id,
          startsAt: localToISO(sessStart),
          endsAt: localToISO(sessEnd),
          storeId: sessStore,
          roomId: sessRoom || undefined,
          trainerIds: sessTrainers.length ? sessTrainers : undefined,
          capacity: sessCapacity,
          occurrences: occurrences > 1 ? occurrences : undefined,
          intervalDays: occurrences > 1 ? intervalDays : undefined,
          deliveryMode,
          meetingUrl: deliveryMode === "IN_PERSON" || createZoom ? undefined : meetingUrl,
          createZoom: deliveryMode === "IN_PERSON" ? false : createZoom,
        },
      });
      toast.success(
        sessions.length === 1 ? "Session added" : `${sessions.length} sessions added (series)`,
      );
      setSessStart("");
      setSessEnd("");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add sessions");
    } finally {
      setAddingSessions(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="card">
          <Skeleton rows={7} height={20} />
        </div>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="page">
        <h1>Product</h1>
        <div style={{ height: 16 }} />
        <ErrorNote message={error ?? "Product not found"} onRetry={load} />
      </div>
    );
  }

  const p = product;
  const translation = (locale: string) =>
    translations.find((tr) => tr.locale === locale) || { locale, name: "", description: "" };
  const setTranslation = (locale: string, patch: Partial<ProductTranslation>) =>
    setTranslations((current) => {
      const found = current.some((tr) => tr.locale === locale);
      return found
        ? current.map((tr) => tr.locale === locale ? { ...tr, ...patch } : tr)
        : [...current, { locale, name: "", description: "", ...patch }];
    });
  const missingLanguages = enabledLanguages.filter((locale) => !translation(locale).name.trim());

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="faint">
            <Link to={`/products?type=${p.type}`}>Products</Link> /{" "}
            <span className="mono">{p.productNo}</span>
          </div>
          <h1>{p.name}</h1>
          <div className="page-sub">
            {p.type === "RENTAL" ? "Rental equipment" : "Course"} · {money(p.defaultUnitPrice)}
            {p.securityDeposit > 0 && ` · deposit ${money(p.securityDeposit)}`}
          </div>
        </div>
        <div className="btn-row" style={{ alignItems: "center" }}>
          <label className="checkbox-row" title="Publish to the Online Store sales channel">
            <input type="checkbox" checked={chanOnlineStore} onChange={(e) => setChanOnlineStore(e.target.checked)} />
            Online Store
          </label>
          <label className="checkbox-row" title="Publish to the Point of Sale channel">
            <input type="checkbox" checked={chanPos} onChange={(e) => setChanPos(e.target.checked)} />
            POS
          </label>
          <button
            type="button"
            className="btn"
            disabled={publishing}
            onClick={() => void publishToShopify()}
            title="Create or update this product in Shopify with price, description, image, booking metafields — and publish it to the selected channels"
          >
            {publishing && <Spinner small />}{" "}
            {shopifyProductId ? "Update in Shopify" : "Publish to Shopify"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || missingLanguages.length > 0}
            onClick={() => void save()}
          >
            {saving && <Spinner small />} Save changes
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2 className="card-title">Web content</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="Image URL">
              <input
                type="url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="https://…"
              />
            </Field>
            {enabledLanguages.map((locale) => {
              const tr = translation(locale);
              return (
                <div className="translation-panel" key={locale}>
                  <div className="translation-head">
                    <strong>{languageName(locale)}</strong>
                    {!tr.name.trim() && <span className="avail-no">Required</span>}
                  </div>
                  <Field label={`${p.type === "COURSE" ? "Course" : "Product"} name`}>
                    <input value={tr.name} onChange={(e) => setTranslation(locale, { name: e.target.value })} />
                  </Field>
                  <Field label="Web description">
                    <textarea value={tr.description} onChange={(e) => setTranslation(locale, { description: e.target.value })} />
                  </Field>
                </div>
              );
            })}
            <Field label="Shopify product ID">
              <input
                type="text"
                value={shopifyProductId}
                onChange={(e) => setShopifyProductId(e.target.value)}
                placeholder="gid://shopify/Product/…"
              />
            </Field>
            <Field label="SKU">
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="Stock Keeping Unit"
              />
            </Field>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={availableOnWeb}
                onChange={(e) => setAvailableOnWeb(e.target.checked)}
              />
              Available on web
            </label>
          </div>
          {missingLanguages.length > 0 && (
            <div className="error-note" style={{ marginTop: 12 }}>
              Missing required names: {missingLanguages.map(languageName).join(", ")}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Kit contents</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            Kit items appear on packing lists.
          </div>
          {kit.length === 0 && <div className="faint">No kit items.</div>}
          {kit.map((item, i) => (
            <div
              key={i}
              style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}
            >
              <input
                type="text"
                placeholder="Item no."
                value={item.itemNo}
                style={{ width: 120 }}
                onChange={(e) =>
                  setKit(kit.map((x, j) => (j === i ? { ...x, itemNo: e.target.value } : x)))
                }
              />
              <input
                type="text"
                placeholder="Description"
                value={item.description}
                onChange={(e) =>
                  setKit(kit.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                }
              />
              <input
                type="number"
                min={1}
                value={item.qty}
                style={{ width: 70 }}
                onChange={(e) =>
                  setKit(
                    kit.map((x, j) =>
                      j === i ? { ...x, qty: Math.max(1, Number(e.target.value) || 1) } : x,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove kit item"
                onClick={() => setKit(kit.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setKit([...kit, { itemNo: "", description: "", qty: 1 }])}
          >
            Add kit item
          </button>

          <hr className="divider" />
          <h2 className="card-title">Pricing</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            {p.type === "RENTAL" ? "Daily rate; a WEEKLY tier is applied per 7-day block when cheaper." : "Price per seat."}
            {" "}In live NAV mode, the next catalog sync overwrites these with NAV prices.
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <Field label={p.type === "RENTAL" ? "Price per day" : "Price"}>
              <input
                type="number"
                min={0}
                step="0.01"
                value={defaultUnitPrice}
                onChange={(e) => setDefaultUnitPrice(e.target.value)}
              />
            </Field>
            {p.type === "RENTAL" && (
              <Field label="Security deposit">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={securityDeposit}
                  onChange={(e) => setSecurityDeposit(e.target.value)}
                />
              </Field>
            )}
            {p.type === "RENTAL" && (
              <Field label="Late fee / day" hint="0 uses the regular daily rate.">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={lateFeePerDay}
                  onChange={(e) => setLateFeePerDay(e.target.value)}
                />
              </Field>
            )}
          </div>
          {priceTiers.map((tier, i) => (
            <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <input
                type="text"
                placeholder="Tier (e.g. WEEKLY)"
                value={tier.description}
                style={{ width: 140 }}
                onChange={(e) =>
                  setPriceTiers(priceTiers.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                }
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={tier.price}
                onChange={(e) =>
                  setPriceTiers(priceTiers.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) || 0 } : x)))
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove price tier"
                onClick={() => setPriceTiers(priceTiers.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setPriceTiers([...priceTiers, { description: "WEEKLY", price: 0 }])}
          >
            Add price tier
          </button>

          <hr className="divider" />
          <h2 className="card-title">Customer add-ons</h2>
          <div className="faint" style={{ marginBottom: 10 }}>
            Optional Shopify products offered with this booking. Use the numeric variant ID from Shopify.
          </div>
          {addons.map((addon, i) => (
            <div className="translation-panel" key={addon.id || i} style={{ marginBottom: 10 }}>
              <div className="form-grid-3">
                <Field label="Name"><input value={addon.name} onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, name: e.target.value } : a))} /></Field>
                <Field label="Product / SKU"><input value={addon.addonProductNo} onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, addonProductNo: e.target.value } : a))} /></Field>
                <Field label="Shopify variant ID"><input value={addon.shopifyVariantId} placeholder="1234567890" onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, shopifyVariantId: e.target.value } : a))} /></Field>
                <Field label="Display price"><input type="number" min={0} step="0.01" value={addon.price} onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, price: Number(e.target.value) || 0 } : a))} /></Field>
                <Field label="Maximum quantity"><input type="number" min={1} value={addon.maxQty} onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, maxQty: Math.max(1, Number(e.target.value) || 1) } : a))} /></Field>
                <div className="btn-row" style={{ alignItems: "end" }}>
                  <label className="checkbox-row"><input type="checkbox" checked={addon.required} onChange={(e) => setAddons(addons.map((a, j) => j === i ? { ...a, required: e.target.checked } : a))} />Required</label>
                  <button className="icon-btn" type="button" onClick={() => setAddons(addons.filter((_, j) => j !== i))}>×</button>
                </div>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-sm" onClick={() => setAddons([...addons, {
            addonProductNo: "", name: "", price: 0, maxQty: 1, required: false, active: true, shopifyVariantId: "",
          }])}>Add customer add-on</button>

          <hr className="divider" />
          <h2 className="card-title">{t("Suggested with this product")}</h2>
          {crossSellProductNos.map((productNo) => {
            const suggestion = allProducts.find((candidate) => candidate.productNo === productNo)
              ?? product?.crossSell?.find((candidate) => candidate.productNo === productNo);
            return (
              <div className="btn-row" key={productNo} style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <span>{suggestion?.name ?? productNo}</span>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => setCrossSellProductNos((current) => current.filter((value) => value !== productNo))}>
                  {t("Remove suggestion")}
                </button>
              </div>
            );
          })}
          <div className="btn-row">
            <select value={crossSellSelection} onChange={(e) => setCrossSellSelection(e.target.value)}>
              <option value="">{t("Select a product…")}</option>
              {allProducts.filter((candidate) =>
                candidate.productNo !== product?.productNo && !crossSellProductNos.includes(candidate.productNo)
              ).map((candidate) => (
                <option key={candidate.id} value={candidate.productNo}>{candidate.name} ({candidate.productNo})</option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" disabled={!crossSellSelection} onClick={() => {
              setCrossSellProductNos((current) => [...current, crossSellSelection]);
              setCrossSellSelection("");
            }}>{t("Add suggestion")}</button>
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />
      <div className="card">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="card-title">NAV Integration</h2>
            <div>
              {syncedAt
                ? t("Synced to NAV at {{date}}").replace("{{date}}", fmtDateTime(syncedAt))
                : t("Not synced to NAV")}
            </div>
            {health?.navMode === "mock" && (
              <div className="faint" style={{ marginTop: 6 }}>
                {t("NAV is in mock mode — push is simulated")}
              </div>
            )}
          </div>
          <button type="button" className="btn" disabled={pushing} onClick={() => void pushToNav()}>
            {pushing && <Spinner small />} {t("Push to NAV")}
          </button>
        </div>
      </div>

      {p.type === "RENTAL" && (
        <>
          <div style={{ height: 18 }} />
          <RentalAvailabilityCalendar productNo={p.productNo} />
        </>
      )}

      {p.type === "COURSE" && (
        <>
          <div style={{ height: 18 }} />
          <div className="card">
            <h2 className="card-title">Sessions</h2>
            {!p.sessions || p.sessions.length === 0 ? (
              <EmptyState title="No sessions scheduled" hint="Add sessions below." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Starts</th>
                      <th>Ends</th>
                      <th>Store</th>
                      <th>Delivery</th>
                      <th>Series</th>
                      <th className="num">Booked / capacity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.sessions.map((s) => (
                      <tr key={s.id}>
                        <td>{fmtDateTime(s.startsAt)}</td>
                        <td>{fmtDateTime(s.endsAt)}</td>
                        <td className="muted">{storeName(s.storeId)}</td>
                        <td><span className="badge">{s.deliveryMode?.replace("_", " ") || "IN PERSON"}</span>{s.meetingUrl && <div><a href={s.meetingUrl} target="_blank" rel="noreferrer">Join link</a></div>}</td>
                        <td className="muted">
                          {s.seriesId ? `${s.instanceNo}/${s.instanceCount}` : "—"}
                        </td>
                        <td className="num">
                          {s.booked}/{s.capacity}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <hr className="divider" />
            <h2 className="card-title">Add sessions</h2>
            <div className="form-grid-3">
              <Field label="Start">
                <input
                  type="datetime-local"
                  value={sessStart}
                  onChange={(e) => setSessStart(e.target.value)}
                />
              </Field>
              <Field label="End">
                <input
                  type="datetime-local"
                  value={sessEnd}
                  onChange={(e) => setSessEnd(e.target.value)}
                />
              </Field>
              <Field label="Store">
                <select value={sessStore} onChange={(e) => setSessStore(e.target.value)}>
                  <option value="">Select store…</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Room">
                <select value={sessRoom} onChange={(e) => setSessRoom(e.target.value)}>
                  <option value="">No room</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({storeName(r.storeId)})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Delivery">
                <select value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as typeof deliveryMode)}>
                  <option value="IN_PERSON">In person</option><option value="VIRTUAL">Virtual</option><option value="HYBRID">Hybrid</option>
                </select>
              </Field>
              {deliveryMode !== "IN_PERSON" && (
                <Field label="Video meeting">
                  <select value={createZoom ? "ZOOM" : "MANUAL"} onChange={(e) => setCreateZoom(e.target.value === "ZOOM")}>
                    <option value="ZOOM">Create automatically in Zoom</option><option value="MANUAL">Use a meeting link</option>
                  </select>
                </Field>
              )}
              {deliveryMode !== "IN_PERSON" && !createZoom && (
                <Field label="Meeting URL"><input type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://zoom.us/j/…" /></Field>
              )}
              <Field label="Capacity">
                <input
                  type="number"
                  min={1}
                  value={sessCapacity}
                  onChange={(e) => setSessCapacity(Math.max(1, Number(e.target.value) || 1))}
                />
              </Field>
              <Field
                label="Occurrences"
                hint="More than 1 creates a series, e.g. 3 weekly evenings."
              >
                <input
                  type="number"
                  min={1}
                  value={occurrences}
                  onChange={(e) => setOccurrences(Math.max(1, Number(e.target.value) || 1))}
                />
              </Field>
              {occurrences > 1 && (
                <Field label="Interval (days)">
                  <input
                    type="number"
                    min={1}
                    value={intervalDays}
                    onChange={(e) => setIntervalDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </Field>
              )}
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="field-label" style={{ marginBottom: 6 }}>
                Trainers
              </div>
              {trainers.length === 0 ? (
                <div className="faint">No trainers defined — add them under Sessions &amp; Resources.</div>
              ) : (
                <div className="btn-row">
                  {trainers.map((t) => (
                    <label key={t.id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={sessTrainers.includes(t.id)}
                        onChange={(e) =>
                          setSessTrainers(
                            e.target.checked
                              ? [...sessTrainers, t.id]
                              : sessTrainers.filter((x) => x !== t.id),
                          )
                        }
                      />
                      {t.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={addingSessions}
                onClick={() => void addSessions()}
              >
                {addingSessions && <Spinner small />}{" "}
                {occurrences > 1 ? `Add ${occurrences} sessions` : "Add session"}
              </button>
            </div>
          </div>
        </>
      )}

      <div style={{ height: 18 }} />
      <ProductBookings productId={p.id} productNo={p.productNo} />
    </div>
  );
}
