import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, qs } from "../api";
import type { BookingField, CrossSellSuggestion, Health, KitItem, Product, ProductAddon, ProductTranslation, Resource, Session, Settings } from "../api";
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
  const imageInput = useRef<HTMLInputElement>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [confirmImageRemove, setConfirmImageRemove] = useState(false);
  const [fieldForm, setFieldForm] = useState<{
    id?: string; label: string; type: BookingField["type"]; options: string; required: boolean; sort: string;
    translations: Record<string, { label: string; options: string[] }>;
  } | null>(null);
  const [fieldLanguage, setFieldLanguage] = useState("");
  const [savingField, setSavingField] = useState(false);
  const [confirmFieldDelete, setConfirmFieldDelete] = useState<string | null>(null);

  // Editable fields
  const [imageUrl, setImageUrl] = useState("");
  const [translations, setTranslations] = useState<ProductTranslation[]>([]);
  const [enabledLanguages, setEnabledLanguages] = useState<string[]>(["en", "fr"]);
  const [availableOnWeb, setAvailableOnWeb] = useState(false);
  const [productOnline, setProductOnline] = useState(false);
  const [shopifyProductId, setShopifyProductId] = useState("");
  const [sku, setSku] = useState("");
  const [kit, setKit] = useState<KitItem[]>([]);
  const [defaultUnitPrice, setDefaultUnitPrice] = useState("0");
  const [securityDeposit, setSecurityDeposit] = useState("0");
  const [lateFeePerDay, setLateFeePerDay] = useState("0");
  const [shippingEnabled, setShippingEnabled] = useState(false);
  const [shippingFee, setShippingFee] = useState("0");
  const [shipBufferBeforeDays, setShipBufferBeforeDays] = useState("0");
  const [shipBufferAfterDays, setShipBufferAfterDays] = useState("0");
  const [priceTiers, setPriceTiers] = useState<{ description: string; price: number }[]>([]);
  const [addons, setAddons] = useState<ProductAddon[]>([]);
  const [crossSell, setCrossSell] = useState<CrossSellSuggestion[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [crossSellSelection, setCrossSellSelection] = useState("");
  const [shopifyProducts, setShopifyProducts] = useState<Array<{
    id: string; title: string; handle: string; image: string; price: number; variantId: string;
  }>>([]);
  const [shopifySearchQuery, setShopifySearchQuery] = useState("");
  const [shopifySearchLoading, setShopifySearchLoading] = useState(false);
  const [shopifyConfigured, setShopifyConfigured] = useState<boolean | null>(null);
  const [storeQtyInputs, setStoreQtyInputs] = useState<Record<string, string>>({});
  const [savingStoreQty, setSavingStoreQty] = useState(false);

  // Session form (COURSE only)
  const [rooms, setRooms] = useState<Resource[]>([]);
  const [trainers, setTrainers] = useState<Resource[]>([]);
  const [sessStart, setSessStart] = useState("");
  const [sessEnd, setSessEnd] = useState("");
  const [sessStore, setSessStore] = useState("");
  const [sessRoom, setSessRoom] = useState("");
  const [sessTrainers, setSessTrainers] = useState<string[]>([]);
  const [sessCapacity, setSessCapacity] = useState(8);
  const [sessCapacityTouched, setSessCapacityTouched] = useState(false);
  const [occurrences, setOccurrences] = useState(1);
  const [intervalDays, setIntervalDays] = useState(7);
  const [deliveryMode, setDeliveryMode] = useState<"IN_PERSON" | "VIRTUAL" | "HYBRID">("IN_PERSON");
  const [sessOnline, setSessOnline] = useState(false);
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
        setProductOnline(Boolean(p.online));
        setShopifyProductId(p.shopifyProductId ?? "");
        setSku(p.sku ?? "");
        setKit(p.kit ?? []);
        setDefaultUnitPrice(String(p.defaultUnitPrice ?? 0));
        setSecurityDeposit(String(p.securityDeposit ?? 0));
        setLateFeePerDay(String(p.lateFeePerDay ?? 0));
        setShippingEnabled(Boolean(p.shippingEnabled));
        setShippingFee(String(p.shippingFee ?? 0));
        setShipBufferBeforeDays(String(p.shipBufferBeforeDays ?? 0));
        setShipBufferAfterDays(String(p.shipBufferAfterDays ?? 0));
        setPriceTiers(p.prices ?? []);
        setAddons(p.addons ?? []);
        setCrossSell(p.crossSell ?? []);
        setStoreQtyInputs(Object.fromEntries(
          (p.storeQty ?? []).map((entry) => [entry.storeId, String(entry.qty)]),
        ));
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

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setShopifySearchLoading(true);
      api<{ products: typeof shopifyProducts; configured: boolean }>(
        `/api/shopify/products${qs({ q: shopifySearchQuery })}`,
        { signal: controller.signal },
      ).then((result) => {
        setShopifyConfigured(result.configured);
        setShopifyProducts(result.products);
      }).catch((searchError: Error) => {
        if (searchError.name !== "AbortError") {
          setShopifyProducts([]);
          setShopifyConfigured(false);
        }
      }).finally(() => setShopifySearchLoading(false));
    }, shopifySearchQuery ? 300 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [shopifySearchQuery]);

  const save = async () => {
    setSaving(true);
    try {
      const { product: updated } = await api<{ product: Product }>(`/api/products/${id}`, {
        method: "PUT",
        body: {
          imageUrl,
          translations,
          availableOnWeb,
          online: productOnline ? 1 : 0,
          shopifyProductId: shopifyProductId || null,
          sku: sku.trim() || "",
          kit,
          defaultUnitPrice: Number(defaultUnitPrice) || 0,
          securityDeposit: Number(securityDeposit) || 0,
          lateFeePerDay: Number(lateFeePerDay) || 0,
          shippingEnabled,
          shippingFee: Number(shippingFee) || 0,
          shipBufferBeforeDays: Math.max(0, Number(shipBufferBeforeDays) || 0),
          shipBufferAfterDays: Math.max(0, Number(shipBufferAfterDays) || 0),
          ...(p.type !== "SERVICE" ? { prices: priceTiers } : {}),
          addons,
          crossSell,
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

  const saveStoreQty = async () => {
    setSavingStoreQty(true);
    try {
      await api<{ storeQty: Product["storeQty"] }>(`/api/products/${id}/store-qty`, {
        method: "PUT",
        body: {
          entries: stores.map((store) => ({
            storeId: store.id,
            qty: Number(storeQtyInputs[store.id] || 0),
          })),
        },
      });
      toast.success(t("Locations & units"));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingStoreQty(false);
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

  const uploadImage = async (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Choose a JPEG, PNG, or WebP image");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be 5 MB or smaller");
      return;
    }
    setUploadingImage(true);
    try {
      const response = await fetch(`/api/products/${id}/image`, {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || response.statusText);
      }
      toast.success("Image uploaded");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Image upload failed");
    } finally {
      setUploadingImage(false);
      if (imageInput.current) imageInput.current.value = "";
    }
  };

  const removeImage = async () => {
    try {
      await api(`/api/products/${id}/image`, { method: "DELETE" });
      setConfirmImageRemove(false);
      toast.success("Image removed");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove image");
    }
  };

  const openFieldForm = (field?: BookingField) => {
    const additionalLanguages = enabledLanguages.slice(1);
    setFieldLanguage(additionalLanguages[0] || "");
    setFieldForm(field ? {
      id: field.id, label: field.label, type: field.type, options: field.options.join(", "),
      required: field.required, sort: String(field.sort),
      translations: Object.fromEntries((field.translations ?? []).map((translation) => [
        translation.locale,
        { label: translation.label, options: translation.options },
      ])),
    } : {
      label: "", type: "text", options: "", required: false,
      sort: String(Math.max(-1, ...(product?.bookingFields ?? []).map((item) => item.sort)) + 1),
      translations: {},
    });
  };

  const saveField = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!fieldForm) return;
    const options = fieldForm.options.split(",").map((option) => option.trim()).filter(Boolean);
    if (["dropdown", "radio"].includes(fieldForm.type) && !options.length) {
      toast.error("Options are required");
      return;
    }
    setSavingField(true);
    try {
      await api(fieldForm.id
        ? `/api/products/${id}/fields/${fieldForm.id}`
        : `/api/products/${id}/fields`, {
        method: fieldForm.id ? "PUT" : "POST",
        body: {
          label: fieldForm.label.trim(), type: fieldForm.type, options,
          required: fieldForm.required, sort: Number(fieldForm.sort) || 0,
          translations: Object.fromEntries(enabledLanguages.slice(1).map((locale) => {
            const translation = fieldForm.translations[locale] ?? { label: "", options: [] };
            return [locale, {
              label: translation.label.trim(),
              options: options.map((_, index) => translation.options[index]?.trim() ?? ""),
            }];
          })),
        },
      });
      toast.success(t(fieldForm.id ? "Field updated" : "Field added"));
      setFieldForm(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save field");
    } finally {
      setSavingField(false);
    }
  };

  const deleteField = async (fieldId: string) => {
    try {
      await api(`/api/products/${id}/fields/${fieldId}`, { method: "DELETE" });
      setConfirmFieldDelete(null);
      toast.success(t("Field deleted"));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete field");
    }
  };

  const moveField = async (field: BookingField, direction: -1 | 1) => {
    if (!product) return;
    const fields = [...(product.bookingFields ?? [])].sort((a, b) => a.sort - b.sort);
    const index = fields.findIndex((item) => item.id === field.id);
    const other = fields[index + direction];
    if (!other) return;
    try {
      await Promise.all([
        api(`/api/products/${id}/fields/${field.id}`, { method: "PUT", body: { sort: other.sort } }),
        api(`/api/products/${id}/fields/${other.id}`, { method: "PUT", body: { sort: field.sort } }),
      ]);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reorder fields");
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
          online: sessOnline ? 1 : 0,
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
            <Link to={`/products/${p.type === "RENTAL" ? "rentals" : p.type === "COURSE" ? "courses" : "services"}`}>{t(p.type === "RENTAL" ? "Rentals" : p.type === "COURSE" ? "Courses" : "Services")}</Link> /{" "}
            <span className="mono">{p.productNo}</span>
          </div>
          <h1>{p.name}</h1>
          <div className="page-sub">
            {p.type === "RENTAL" ? "Rental equipment" : p.type === "COURSE" ? "Course" : "Service"} · {money(p.defaultUnitPrice)}
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

      <div className="card" style={{ marginBottom: 18 }}>
        <h2 className="card-title">{t("Product image")}</h2>
        {p.imageUrl ? (
          <img src={p.imageUrl} alt={p.name} style={{ display: "block", maxWidth: "100%", maxHeight: 240, objectFit: "contain", marginBottom: 12 }} />
        ) : (
          <div className="faint" style={{ marginBottom: 12 }}>{t("No image")}</div>
        )}
        <input
          ref={imageInput}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => void uploadImage(event.target.files?.[0])}
        />
        <div className="btn-row">
          <button type="button" className="btn" disabled={uploadingImage} onClick={() => imageInput.current?.click()}>
            {uploadingImage && <Spinner small />} {t("Upload image")}
          </button>
          {p.imageUrl && (
            confirmImageRemove ? (
              <>
                <button type="button" className="btn btn-danger" onClick={() => void removeImage()}>{t("Confirm remove")}</button>
                <button type="button" className="btn" onClick={() => setConfirmImageRemove(false)}>{t("Cancel")}</button>
              </>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmImageRemove(true)}>{t("Remove image")}</button>
            )
          )}
        </div>
      </div>

      {p.type === "RENTAL" && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 className="card-title">{t("product_shipping_title")}</h2>
          <label className="checkbox-row">
            <input type="checkbox" checked={shippingEnabled} onChange={(event) => setShippingEnabled(event.target.checked)} />
            {t("product_shipping_toggle")}
          </label>
          {shippingEnabled && (
            <>
              <div className="form-grid-3" style={{ marginTop: 14 }}>
                <Field label={t("product_shipping_fee")}>
                  <input type="number" min={0} step="0.01" value={shippingFee} onChange={(event) => setShippingFee(event.target.value)} />
                </Field>
                <Field label={t("product_shipping_buffer_before")}>
                  <input type="number" min={0} step={1} value={shipBufferBeforeDays} onChange={(event) => setShipBufferBeforeDays(event.target.value)} />
                </Field>
                <Field label={t("product_shipping_buffer_after")}>
                  <input type="number" min={0} step={1} value={shipBufferAfterDays} onChange={(event) => setShipBufferAfterDays(event.target.value)} />
                </Field>
              </div>
              <div className="faint">
                {t("product_shipping_buffer_hint")
                  .replace("[N]", String(Math.max(0, Number(shipBufferBeforeDays) || 0)))
                  .replace("[N]", String(Math.max(0, Number(shipBufferAfterDays) || 0)))}
              </div>
            </>
          )}
        </div>
      )}

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
            {p.type === "SERVICE" && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={productOnline}
                  onChange={(e) => setProductOnline(e.target.checked)}
                />
                {t("Online service (video appointment)")}
              </label>
            )}
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
            {p.type === "RENTAL"
              ? t("Daily rate; a WEEKLY tier is applied per 7-day block when cheaper.")
              : p.type === "COURSE"
                ? t("Price per seat.")
                : t("Price per appointment.")}
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
          {p.type !== "SERVICE" && (
            <>
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
            </>
          )}

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
          {crossSell.map((suggestion) => {
            const reservlyProduct = suggestion.kind === "RESERVLY"
              ? allProducts.find((candidate) => candidate.productNo === suggestion.productNo)
              : undefined;
            const key = suggestion.kind === "SHOPIFY"
              ? `SHOPIFY:${suggestion.shopifyProductId}`
              : `RESERVLY:${suggestion.productNo}`;
            return (
              <div className="btn-row" key={key} style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <div className="btn-row">
                  <span className="badge">{suggestion.kind === "SHOPIFY" ? "Shopify" : "Bagsy"}</span>
                  {suggestion.kind === "SHOPIFY" && suggestion.imageUrl && (
                    <img src={suggestion.imageUrl} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4 }} />
                  )}
                  <span>
                    {suggestion.kind === "SHOPIFY"
                      ? `${suggestion.title ?? ""} · ${money(suggestion.price ?? 0)}`
                      : reservlyProduct?.name ?? suggestion.name ?? suggestion.productNo}
                  </span>
                </div>
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => setCrossSell((current) => current.filter((value) =>
                    value.kind !== suggestion.kind ||
                    (value.kind === "SHOPIFY" ? value.shopifyProductId !== suggestion.shopifyProductId : value.productNo !== suggestion.productNo)
                  ))}>
                  {t("Remove suggestion")}
                </button>
              </div>
            );
          })}
          <div className="btn-row">
            <select value={crossSellSelection} onChange={(e) => setCrossSellSelection(e.target.value)}>
              <option value="">{t("Select a product…")}</option>
              {allProducts.filter((candidate) =>
                candidate.productNo !== product?.productNo &&
                !crossSell.some((entry) => entry.kind === "RESERVLY" && entry.productNo === candidate.productNo)
              ).map((candidate) => (
                <option key={candidate.id} value={candidate.productNo}>{candidate.name} ({candidate.productNo})</option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" disabled={!crossSellSelection} onClick={() => {
              const selected = allProducts.find((candidate) => candidate.productNo === crossSellSelection);
              if (selected) setCrossSell((current) => [...current, {
                kind: "RESERVLY", productNo: selected.productNo, name: selected.name,
                type: selected.type, defaultUnitPrice: selected.defaultUnitPrice,
              }]);
              setCrossSellSelection("");
            }}>{t("Add suggestion")}</button>
          </div>
          <div style={{ marginTop: 16 }}>
            {shopifyConfigured === false ? (
              <div className="faint">{t("Shopify catalog not configured")}</div>
            ) : (
              <>
                <input
                  value={shopifySearchQuery}
                  onChange={(event) => setShopifySearchQuery(event.target.value)}
                  placeholder={t("Search your Shopify catalog")}
                />
                {shopifySearchLoading && <Spinner small />}
                {shopifySearchQuery && shopifyProducts.length > 0 && (
                  <div className="translation-panel" style={{ marginTop: 8 }}>
                    <div className="field-label">{t("Shopify products")}</div>
                    {shopifyProducts.map((candidate) => {
                      const added = crossSell.some((entry) =>
                        entry.kind === "SHOPIFY" && entry.shopifyProductId === candidate.id);
                      return (
                        <div className="btn-row" key={candidate.id} style={{ justifyContent: "space-between", marginTop: 8 }}>
                          <div className="btn-row">
                            {candidate.image && <img src={candidate.image} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4 }} />}
                            <span>{candidate.title} · {money(candidate.price)}</span>
                          </div>
                          <button type="button" className="btn btn-sm" disabled={added || !candidate.variantId} onClick={() => {
                            setCrossSell((current) => [...current, {
                              kind: "SHOPIFY", shopifyProductId: candidate.id, variantId: candidate.variantId,
                              title: candidate.title, price: candidate.price, imageUrl: candidate.image, handle: candidate.handle,
                            }]);
                          }}>{t("Add suggestion")}</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />
      <div className="card">
        <div className="page-head" style={{ marginBottom: 12 }}>
          <h2 className="card-title">{t("Booking form fields")}</h2>
          {!fieldForm && <button type="button" className="btn btn-sm" onClick={() => openFieldForm()}>{t("Add field")}</button>}
        </div>
        {fieldForm && (
          <form onSubmit={(event) => void saveField(event)} className="translation-panel" style={{ marginBottom: 14 }}>
            <div className="form-grid-3">
              <Field label="Label"><input required value={fieldForm.label} onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })} /></Field>
              <Field label={t("Type")}>
                <select value={fieldForm.type} onChange={(e) => setFieldForm({ ...fieldForm, type: e.target.value as BookingField["type"] })}>
                  {(["text", "textarea", "dropdown", "radio", "checkbox", "date", "number"] as const).map((type) => (
                    <option key={type} value={type}>{t({ text: "Text", textarea: "Text area", dropdown: "Dropdown", radio: "Radio buttons", checkbox: "Checkboxes", date: "Date", number: "Number" }[type])}</option>
                  ))}
                </select>
              </Field>
              {["dropdown", "radio"].includes(fieldForm.type) && (
                <Field label="Options" hint="Comma-separated">
                  <input required value={fieldForm.options} onChange={(e) => setFieldForm({ ...fieldForm, options: e.target.value })} />
                </Field>
              )}
              <Field label="Sort"><input type="number" value={fieldForm.sort} onChange={(e) => setFieldForm({ ...fieldForm, sort: e.target.value })} /></Field>
              <label className="checkbox-row"><input type="checkbox" checked={fieldForm.required} onChange={(e) => setFieldForm({ ...fieldForm, required: e.target.checked })} />Required</label>
            </div>
            {enabledLanguages.length > 1 && (
              <div style={{ marginTop: 14 }}>
                <div className="btn-row" style={{ marginBottom: 12 }}>
                  {enabledLanguages.slice(1).map((locale) => (
                    <button key={locale} type="button"
                      className={`btn btn-sm ${fieldLanguage === locale ? "btn-primary" : ""}`}
                      onClick={() => setFieldLanguage(locale)}>
                      {languageName(locale)}
                    </button>
                  ))}
                </div>
                {enabledLanguages.slice(1).filter((locale) => locale === fieldLanguage).map((locale) => {
                  const translated = fieldForm.translations[locale] ?? { label: "", options: [] };
                  const canonicalOptions = fieldForm.options.split(",").map((option) => option.trim()).filter(Boolean);
                  const updateTranslation = (patch: Partial<typeof translated>) =>
                    setFieldForm({
                      ...fieldForm,
                      translations: {
                        ...fieldForm.translations,
                        [locale]: { ...translated, ...patch },
                      },
                    });
                  return (
                    <div className="translation-panel" key={locale}>
                      <Field label="Translated label">
                        <input value={translated.label} onChange={(e) => updateTranslation({ label: e.target.value })} />
                      </Field>
                      {["dropdown", "radio"].includes(fieldForm.type) && canonicalOptions.map((option, index) => (
                        <Field key={`${locale}-${index}`} label={`Display text for “${option}”`}>
                          <input
                            value={translated.options[index] ?? ""}
                            onChange={(e) => {
                              const nextOptions = [...translated.options];
                              nextOptions[index] = e.target.value;
                              updateTranslation({ options: nextOptions });
                            }}
                          />
                        </Field>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="submit" className="btn btn-primary" disabled={savingField}>{savingField && <Spinner small />} {t("Save field")}</button>
              <button type="button" className="btn" disabled={savingField} onClick={() => setFieldForm(null)}>{t("Cancel")}</button>
            </div>
          </form>
        )}
        {!p.bookingFields?.length ? (
          <EmptyState title={t("No booking form fields")} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Label</th><th>{t("Type")}</th><th>Required</th><th>Options</th><th>Sort</th><th>Actions</th></tr></thead>
              <tbody>
                {[...p.bookingFields].sort((a, b) => a.sort - b.sort).map((field, index, fields) => (
                  <tr key={field.id}>
                    <td>{field.label}</td><td>{t({ text: "Text", textarea: "Text area", dropdown: "Dropdown", radio: "Radio buttons", checkbox: "Checkboxes", date: "Date", number: "Number" }[field.type])}</td>
                    <td>{field.required ? "Yes" : "No"}</td><td className="muted">{field.options.join(", ") || "—"}</td><td>{field.sort}</td>
                    <td><div className="btn-row">
                      <button type="button" className="btn btn-sm" disabled={index === 0} onClick={() => void moveField(field, -1)}>↑</button>
                      <button type="button" className="btn btn-sm" disabled={index === fields.length - 1} onClick={() => void moveField(field, 1)}>↓</button>
                      <button type="button" className="btn btn-sm" onClick={() => openFieldForm(field)}>{t("Edit")}</button>
                      {confirmFieldDelete === field.id ? (
                        <><button type="button" className="btn btn-sm btn-danger" onClick={() => void deleteField(field.id)}>{t("Confirm remove")}</button><button type="button" className="btn btn-sm" onClick={() => setConfirmFieldDelete(null)}>{t("Cancel")}</button></>
                      ) : <button type="button" className="btn btn-sm" onClick={() => setConfirmFieldDelete(field.id)}>{t("Delete")}</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

      {p.type !== "COURSE" && (
        <>
          <div style={{ height: 18 }} />
          <div className="card">
            <h2 className="card-title">{t("Locations & units")}</h2>
            <div className="faint" style={{ marginBottom: 12 }}>
              {t(p.type === "RENTAL"
                ? "Units available to rent at each location."
                : "Concurrent appointments per location.")}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t("Locations")}</th><th className="num">{t("Number")}</th></tr></thead>
                <tbody>
                  {stores.map((store) => (
                    <tr key={store.id}>
                      <td>{store.name}</td>
                      <td className="num">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={storeQtyInputs[store.id] ?? ""}
                          onChange={(event) => setStoreQtyInputs((current) => ({
                            ...current,
                            [store.id]: event.target.value,
                          }))}
                          style={{ width: 100 }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {stores.every((store) => (Number(storeQtyInputs[store.id]) || 0) === 0) && (
              <div className="faint" style={{ marginTop: 10 }}>
                {t("This product isn't bookable anywhere yet.")}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-primary" disabled={savingStoreQty} onClick={() => void saveStoreQty()}>
                {savingStoreQty && <Spinner small />} {t("Save")}
              </button>
            </div>
          </div>
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
                        <td><span className="badge">{s.online ? t("Online session") : s.deliveryMode?.replace("_", " ") || "IN PERSON"}</span>{s.meetingUrl && <div><a href={s.meetingUrl} target="_blank" rel="noreferrer">{t("Join online:")}</a></div>}</td>
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
                <select value={sessRoom} disabled={sessOnline} onChange={(e) => {
                  const nextRoomId = e.target.value;
                  setSessRoom(nextRoomId);
                  const room = rooms.find((candidate) => candidate.id === nextRoomId);
                  if (!sessCapacityTouched && room && room.capacity > 0) setSessCapacity(room.capacity);
                }}>
                  <option value="">No room</option>
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({storeName(r.storeId)}){r.capacity > 0 ? ` (cap ${r.capacity})` : ""}
                    </option>
                  ))}
                </select>
                {sessOnline && <div className="faint">{t("Online — no room needed")}</div>}
              </Field>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={sessOnline}
                  onChange={(e) => setSessOnline(e.target.checked)}
                />
                {t("Online session")}
              </label>
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
                  onChange={(e) => {
                    setSessCapacityTouched(true);
                    setSessCapacity(Math.max(1, Number(e.target.value) || 1));
                  }}
                />
                {(() => {
                  const room = rooms.find((candidate) => candidate.id === sessRoom);
                  return !sessOnline && room && room.capacity > 0 && sessCapacity > room.capacity
                    ? <div style={{ color: "#9a6700", fontSize: 12, marginTop: 4 }}>{t("Exceeds room capacity")} ({room.capacity})</div>
                    : null;
                })()}
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
