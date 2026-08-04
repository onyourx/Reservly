import { Router, raw } from "express";
import fs from "node:fs";
import path from "node:path";
import { db, uid, now, getSettings, pj, auditLog, currentTenant, putSettings } from "../db.js";
import { getActivityTypes, getActivityProducts, navMode, pushProductToNav } from "../lib/nav.js";
import { ensureMetafieldDefinitions, pushProductToShopify, publishToChannels, shopifyGql } from "../lib/shopifyAdmin.js";
import { emit } from "../lib/events.js";
import { sessionBooked } from "../engine/availability.js";
import { weeklyPrice } from "../engine/pricing.js";
import { createZoomMeeting } from "../lib/zoom.js";
import { deleteSessionEvent, pushSessionEvent } from "../lib/calendarSync.js";
import { serializeBooking } from "../lib/bookingService.js";
import { allowedStoreIds, requireOwner, requirePerm, staffAccess } from "../lib/auth.js";
import { DATA_DIR } from "../lib/platform.js";

export const catalogRouter = Router();

catalogRouter.get("/stores", (req, res) => {
  const allowed = allowedStoreIds(req);
  if (allowed === "*") {
    return res.json({ stores: db.prepare("SELECT * FROM stores ORDER BY name").all().map(serializeStore) });
  }
  if (!allowed.length) return res.json({ stores: [] });
  const placeholders = allowed.map(() => "?").join(",");
  return res.json({ stores: db.prepare(`SELECT * FROM stores WHERE id IN (${placeholders}) ORDER BY name`).all(...allowed).map(serializeStore) });
});

const serializeStore = (store: any) => ({
  id: store.id,
  code: store.code,
  name: store.name,
  city: store.city ?? "",
  posStoreId: store.pos_store_id ?? "",
  posTerminalId: store.pos_terminal_id ?? "",
  posStaffId: store.pos_staff_id ?? "",
});

catalogRouter.post("/stores", requireOwner, (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  const name = String(req.body?.name ?? "").trim();
  const city = String(req.body?.city ?? "").trim();
  const posStoreId = String(req.body?.posStoreId ?? "").trim();
  const posTerminalId = String(req.body?.posTerminalId ?? "").trim();
  const posStaffId = String(req.body?.posStaffId ?? "").trim();
  if (!code) return res.status(400).json({ error: "code_required" });
  if (!name) return res.status(400).json({ error: "name_required" });
  if (db.prepare("SELECT id FROM stores WHERE code=?").get(code)) {
    return res.status(409).json({ error: "code_exists" });
  }
  const store = { id: uid(), code, name, city, posStoreId, posTerminalId, posStaffId };
  const timestamp = now();
  db.prepare("INSERT INTO stores(id,code,name,city,pos_store_id,pos_terminal_id,pos_staff_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(store.id, store.code, store.name, store.city, store.posStoreId, store.posTerminalId, store.posStaffId, timestamp, timestamp);
  auditLog("store.created", code);
  return res.json({ store: serializeStore({ id: store.id, code: store.code, name: store.name, city: store.city, pos_store_id: store.posStoreId, pos_terminal_id: store.posTerminalId, pos_staff_id: store.posStaffId }) });
});

catalogRouter.put("/stores/:id", requireOwner, (req, res) => {
  const existing = db.prepare("SELECT * FROM stores WHERE id=?").get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "store_not_found" });

  let code = existing.code as string;
  let name = existing.name as string;
  let city = existing.city ?? "";
  let posStoreId = existing.pos_store_id ?? "";
  let posTerminalId = existing.pos_terminal_id ?? "";
  let posStaffId = existing.pos_staff_id ?? "";
  if (req.body?.code !== undefined) {
    code = String(req.body.code).trim();
    if (!code) return res.status(400).json({ error: "code_required" });
    if (db.prepare("SELECT id FROM stores WHERE code=? AND id<>?").get(code, existing.id)) {
      return res.status(409).json({ error: "code_exists" });
    }
  }
  if (req.body?.name !== undefined) {
    name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "name_required" });
  }
  if (req.body?.city !== undefined) city = String(req.body.city).trim();
  if (req.body?.posStoreId !== undefined) posStoreId = String(req.body.posStoreId).trim();
  if (req.body?.posTerminalId !== undefined) posTerminalId = String(req.body.posTerminalId).trim();
  if (req.body?.posStaffId !== undefined) posStaffId = String(req.body.posStaffId).trim();

  db.prepare("UPDATE stores SET code=?,name=?,city=?,pos_store_id=?,pos_terminal_id=?,pos_staff_id=?,updated_at=? WHERE id=?")
    .run(code, name, city, posStoreId, posTerminalId, posStaffId, now(), existing.id);
  auditLog("store.updated", code);
  return res.json({ store: serializeStore(db.prepare("SELECT * FROM stores WHERE id=?").get(existing.id)) });
});

catalogRouter.delete("/stores/:id", requireOwner, (req, res) => {
  const store = db.prepare("SELECT id,code FROM stores WHERE id=?").get(req.params.id) as any;
  if (!store) return res.status(404).json({ error: "store_not_found" });
  const counts = {
    bookings: (db.prepare("SELECT COUNT(*) AS count FROM bookings WHERE store_id=?").get(store.id) as any).count as number,
    sessions: (db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE store_id=?").get(store.id) as any).count as number,
    rentalUnits: (db.prepare("SELECT COUNT(*) AS count FROM rental_units WHERE store_id=?").get(store.id) as any).count as number,
    productQty: (db.prepare("SELECT COUNT(*) AS count FROM product_store_qty WHERE store_id=?").get(store.id) as any).count as number,
  };
  if (Object.values(counts).some((count) => count > 0)) {
    return res.status(409).json({ error: "store_in_use", counts });
  }
  db.prepare("DELETE FROM stores WHERE id=?").run(store.id);
  auditLog("store.deleted", store.code || store.id);
  return res.json({ ok: true });
});

function serializeProduct(p: any) {
  return {
    id: p.id, productNo: p.product_no, type: p.type, activityType: p.activity_type,
    sku: p.sku,
    name: p.name, nameFr: p.name_fr, webDescEn: p.web_desc_en, webDescFr: p.web_desc_fr,
    imageUrl: p.image_url, durationType: p.duration_type, duration: p.duration,
    defaultUnitPrice: p.default_unit_price, securityDeposit: p.security_deposit,
    retailItem: p.retail_item, fixedLocation: p.fixed_location,
    online: !!p.online,
    availableOnWeb: !!p.available_on_web, minQty: p.min_qty, maxQty: p.max_qty,
    lateFeePerDay: p.late_fee_per_day || 0,
    shippingEnabled: !!p.shipping_enabled,
    shippingFee: Number(p.shipping_fee) || 0,
    shipBufferBeforeDays: Number(p.ship_buffer_before_days) || 0,
    shipBufferAfterDays: Number(p.ship_buffer_after_days) || 0,
    scheduling: {
      bufferBefore: p.buffer_before || 0, bufferAfter: p.buffer_after || 0,
      minNoticeHours: p.min_notice_hours || 0, maxAdvanceDays: p.max_advance_days || 365,
      cancellationHours: p.cancellation_hours || 24,
      customerCanCancel: !!p.customer_can_cancel, customerCanReschedule: !!p.customer_can_reschedule,
      depositPolicy: p.deposit_policy || "PICKUP",
    },
    shopifyProductId: p.shopify_product_id,
    navSyncedAt: p.nav_synced_at || "",
    kit: db.prepare("SELECT item_no AS itemNo, description, qty FROM product_kit_items WHERE product_id = ?").all(p.id),
    prices: db.prepare("SELECT description, price FROM product_prices WHERE product_id = ?").all(p.id),
    translations: db.prepare("SELECT locale, name, description FROM product_translations WHERE product_id = ? ORDER BY locale").all(p.id),
    storeQty: db.prepare("SELECT store_id AS storeId, qty FROM product_store_qty WHERE product_id = ?").all(p.id),
    bookingFields: (db.prepare(`SELECT id,label,type,options,required,sort FROM booking_fields
      WHERE product_id=? ORDER BY sort,id`).all(p.id) as any[]).map((field) => {
      const options = pj<string[]>(field.options, []);
      return {
        ...field, options, required: !!field.required,
        translations: (db.prepare(`SELECT locale,label,options FROM booking_field_translations
          WHERE field_id=? ORDER BY locale`).all(field.id) as any[]).map((translation) => {
          const translatedOptions = pj<string[]>(translation.options, []);
          return {
            ...translation,
            options: options.map((_, index) => translatedOptions[index] ?? ""),
          };
        }),
      };
    }),
    addons: db.prepare(`SELECT id,addon_product_no AS addonProductNo,name,price,max_qty AS maxQty,
      required,active,shopify_variant_id AS shopifyVariantId FROM product_addons WHERE product_id=? ORDER BY name`).all(p.id),
    crossSell: db.prepare(`SELECT cross_sell.kind,
      suggested.product_no AS productNo,suggested.name,suggested.type,
      suggested.default_unit_price AS defaultUnitPrice,
      cross_sell.shopify_product_id AS shopifyProductId,
      cross_sell.shopify_variant_id AS variantId,cross_sell.title,cross_sell.price,
      cross_sell.image_url AS imageUrl,cross_sell.handle
      FROM product_cross_sell cross_sell
      LEFT JOIN products suggested ON cross_sell.kind='RESERVLY'
        AND suggested.product_no=cross_sell.suggested_product_no
      WHERE cross_sell.product_id=? ORDER BY COALESCE(suggested.name,cross_sell.title)`).all(p.id),
  };
}

catalogRouter.post("/products", requirePerm("products"), (req, res) => {
  const productNo = String(req.body?.productNo ?? "").trim();
  const type = String(req.body?.type ?? "").trim().toUpperCase();
  const name = String(req.body?.name ?? "").trim();
  if (!productNo) return res.status(400).json({ error: "productNo_required" });
  if (db.prepare("SELECT id FROM products WHERE product_no = ?").get(productNo)) {
    return res.status(409).json({ error: "product_exists" });
  }
  if (!["RENTAL", "COURSE", "SERVICE"].includes(type)) {
    return res.status(400).json({ error: "type_invalid" });
  }
  if (!name) return res.status(400).json({ error: "name_required" });

  const timestamp = now();
  const product = {
    id: uid(),
    productNo,
    type: type as "RENTAL" | "COURSE" | "SERVICE",
    name,
    defaultUnitPrice: Number(req.body?.defaultUnitPrice) || 0,
    securityDeposit: type === "RENTAL" ? Number(req.body?.securityDeposit) || 0 : 0,
    durationType: type === "SERVICE" ? "Hours" : type === "RENTAL" ? String(req.body?.durationType ?? "").trim() : "",
    duration: type === "SERVICE" || type === "RENTAL" ? Number(req.body?.duration) || 0 : 0,
    retailItem: String(req.body?.retailItem ?? "").trim(),
    sku: String(req.body?.sku ?? "").trim(),
    minQty: Math.max(1, Number(req.body?.minQty) || 1),
    maxQty: Math.max(1, Number(req.body?.maxQty) || 10),
    availableOnWeb: req.body?.availableOnWeb !== false,
  };
  if (type === "SERVICE") {
    if (req.body?.durationType != null && req.body.durationType !== "Hours") {
      return res.status(400).json({ error: "durationType must be Hours" });
    }
    if (!Number.isFinite(Number(req.body?.duration)) || Number(req.body.duration) <= 0) {
      return res.status(400).json({ error: "duration must be greater than 0" });
    }
  }
  db.prepare(`INSERT INTO products (
      id,product_no,type,activity_type,name,name_fr,web_desc_en,web_desc_fr,image_url,
      duration_type,duration,default_unit_price,security_deposit,retail_item,fixed_location,
      available_on_web,min_qty,max_qty,shopify_product_id,sku,nav_synced_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(product.id, product.productNo, product.type, product.type, product.name, "", "", "", "",
      product.durationType, product.duration, product.defaultUnitPrice, product.securityDeposit,
      product.retailItem, "", product.availableOnWeb ? 1 : 0, product.minQty, product.maxQty,
      "", product.sku, "", timestamp);
  auditLog("product.created", productNo);

  void pushProductToNav(product)
    .then((result) => {
      if (!result.ok) {
        console.warn("[nav] NAV push failed", result.detail || "Unknown NAV error");
        return;
      }
      const syncedAt = now();
      db.prepare("UPDATE products SET nav_synced_at=? WHERE id=?").run(syncedAt, product.id);
      auditLog("product.nav_pushed", productNo);
    })
    .catch((err) => console.warn("[nav] NAV push failed", err));

  return res.json({
    product: serializeProduct(db.prepare("SELECT * FROM products WHERE id=?").get(product.id)),
  });
});

catalogRouter.get("/products", (req, res) => {
  const { type, q } = req.query as Record<string, string>;
  let sql = "SELECT * FROM products WHERE 1=1";
  const params: unknown[] = [];
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (q) {
    sql += " AND (name LIKE ? OR product_no LIKE ? OR sku LIKE ?)";
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += " ORDER BY type, name";
  res.json({ products: (db.prepare(sql).all(...params) as any[]).map(serializeProduct) });
});

catalogRouter.get("/shopify/products", requirePerm("products"), async (req, res) => {
  if (!getSettings().shopifyApiSecret) return res.json({ products: [], configured: false });
  try {
    const data = await shopifyGql<{
      products: { nodes: Array<{
        id: string; title: string; handle: string;
        images: { nodes: Array<{ url: string }> };
        variants: { nodes: Array<{ id: string; price: string }> };
      }> };
    }>(`query ShopifyProductSearch($q: String!) {
      products(first: 12, query: $q) {
        nodes {
          id title handle
          images(first: 1) { nodes { url } }
          variants(first: 1) { nodes { id price } }
        }
      }
    }`, { q: String(req.query.q ?? "").trim() });
    const products = (data.products?.nodes ?? []).map((product) => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      image: product.images.nodes[0]?.url ?? "",
      price: Number(product.variants.nodes[0]?.price) || 0,
      variantId: product.variants.nodes[0]?.id ?? "",
    }));
    return res.json({ products, configured: true });
  } catch (err) {
    console.warn("[shopify] product search failed", err);
    return res.json({ products: [], configured: false });
  }
});

catalogRouter.get("/localization", (_req, res) => {
  const languages = pj<string[]>(getSettings().enabledLanguages, ["en", "fr"]);
  const products = db.prepare("SELECT id,product_no AS productNo,type,name FROM products ORDER BY type,name").all() as any[];
  const rows = products.map((product) => {
    const translations = db.prepare("SELECT locale,name,description FROM product_translations WHERE product_id=?").all(product.id) as any[];
    const missing = languages.filter((locale) => {
      const tr = translations.find((x) => x.locale === locale);
      return !tr?.name?.trim() || !tr?.description?.trim();
    });
    return { ...product, missing, complete: missing.length === 0 };
  });
  res.json({
    languages,
    products: rows,
    summary: {
      complete: rows.filter((x) => x.complete).length,
      incomplete: rows.filter((x) => !x.complete).length,
      total: rows.length,
    },
  });
});

catalogRouter.get("/cross-sell", requirePerm("bookings"), (req, res) => {
  const raw = req.query.productNos;
  const productNos = [...new Set(
    (Array.isArray(raw) ? raw : raw == null ? [] : [raw])
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  if (!productNos.length) return res.json({ suggestions: [] });

  const placeholders = productNos.map(() => "?").join(",");
  const suggestions = db.prepare(`SELECT DISTINCT cross_sell.kind,
    suggested.product_no AS productNo,suggested.name,suggested.type,
    suggested.default_unit_price AS defaultUnitPrice,
    cross_sell.shopify_product_id AS shopifyProductId,
    cross_sell.shopify_variant_id AS variantId,cross_sell.title,cross_sell.price,
    cross_sell.image_url AS imageUrl,cross_sell.handle
    FROM products source
    JOIN product_cross_sell cross_sell ON cross_sell.product_id=source.id
    LEFT JOIN products suggested ON cross_sell.kind='RESERVLY'
      AND suggested.product_no=cross_sell.suggested_product_no
    WHERE source.product_no IN (${placeholders})
      AND (cross_sell.kind='SHOPIFY' OR suggested.product_no NOT IN (${placeholders}))
    ORDER BY COALESCE(suggested.name,cross_sell.title)`).all(...productNos, ...productNos);
  return res.json({ suggestions });
});

catalogRouter.get("/products/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ? OR product_no = ?").get(req.params.id, req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  const product: any = serializeProduct(p);
  if (p.type === "COURSE") {
    product.sessions = (db.prepare("SELECT * FROM sessions WHERE product_id = ? ORDER BY starts_at").all(p.id) as any[]).map(serializeSession);
  }
  res.json({ product });
});

catalogRouter.put("/products/:id/store-qty", requirePerm("products"), (req, res) => {
  const product = db.prepare("SELECT id,product_no FROM products WHERE id=? OR product_no=?")
    .get(req.params.id, req.params.id) as { id: string; product_no: string } | undefined;
  if (!product) return res.status(404).json({ error: "Product not found" });

  const rawEntries = req.body?.entries;
  if (!Array.isArray(rawEntries)) {
    return res.status(400).json({ error: "entries must be an array" });
  }

  const entries: { storeId: string; qty: number }[] = [];
  const seenStoreIds = new Set<string>();
  for (const entry of rawEntries) {
    const storeId = typeof entry?.storeId === "string" ? entry.storeId.trim() : "";
    const qty = entry?.qty;
    if (!storeId || !db.prepare("SELECT id FROM stores WHERE id=?").get(storeId)) {
      return res.status(400).json({ error: `Unknown store: ${storeId || "(empty)"}` });
    }
    if (!Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({ error: "qty must be an integer greater than or equal to 0" });
    }
    if (seenStoreIds.has(storeId)) {
      return res.status(400).json({ error: `Duplicate store: ${storeId}` });
    }
    seenStoreIds.add(storeId);
    entries.push({ storeId, qty });
  }

  const replaceStoreQty = db.transaction(() => {
    db.prepare("DELETE FROM product_store_qty WHERE product_id=?").run(product.id);
    const upsert = db.prepare(`INSERT INTO product_store_qty(product_id,store_id,qty)
      VALUES(?,?,?)
      ON CONFLICT(product_id,store_id) DO UPDATE SET qty=excluded.qty`);
    for (const entry of entries) {
      if (entry.qty > 0) upsert.run(product.id, entry.storeId, entry.qty);
    }
  });
  replaceStoreQty();

  auditLog("product.store_qty_updated", product.product_no);
  return res.json({
    storeQty: db.prepare(`SELECT store_id AS storeId,qty FROM product_store_qty
      WHERE product_id=? ORDER BY store_id`).all(product.id),
  });
});

catalogRouter.post("/products/:id/push-nav", requirePerm("products"), async (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id=? OR product_no=?").get(req.params.id, req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  const result = await pushProductToNav({
    productNo: p.product_no,
    type: p.type,
    name: p.name,
    defaultUnitPrice: p.default_unit_price,
    securityDeposit: p.security_deposit,
    durationType: p.duration_type,
    duration: p.duration,
    retailItem: p.retail_item,
    sku: p.sku,
    minQty: p.min_qty,
    maxQty: p.max_qty,
    availableOnWeb: !!p.available_on_web,
  });
  if (!result.ok) return res.json(result);
  const navSyncedAt = now();
  db.prepare("UPDATE products SET nav_synced_at=? WHERE id=?").run(navSyncedAt, p.id);
  auditLog("product.nav_pushed", p.product_no);
  return res.json({ ok: true, navSyncedAt });
});

catalogRouter.get("/products/:id/bookings", requirePerm("bookings"), (req, res) => {
  const product = db.prepare("SELECT id,product_no FROM products WHERE id=? OR product_no=?").get(req.params.id, req.params.id) as any;
  if (!product) return res.status(404).json({ error: "Product not found" });
  const rows = db.prepare(`SELECT DISTINCT b.id FROM bookings b JOIN booking_lines l ON l.booking_id=b.id
    WHERE l.product_no=? ORDER BY b.created_at DESC LIMIT 200`).all(product.product_no) as { id: string }[];
  res.json({ bookings: rows.map((row) => serializeBooking(row.id)).filter(Boolean) });
});

catalogRouter.put("/products/:id", requirePerm("products"), (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  const { imageUrl, webDescEn, webDescFr, translations, kit, shopifyProductId, availableOnWeb, online, defaultUnitPrice, securityDeposit, lateFeePerDay, shippingEnabled, shippingFee, shipBufferBeforeDays, shipBufferAfterDays, prices, scheduling, addons, crossSell, crossSellProductNos } = req.body ?? {};
  const sku = req.body?.sku === undefined ? null : String(req.body.sku).trim();
  if (p.type === "SERVICE" && securityDeposit != null && Number(securityDeposit) !== 0) {
    return res.status(400).json({ error: "SERVICE security_deposit must be 0" });
  }
  type NormalizedCrossSell = {
    kind: "RESERVLY" | "SHOPIFY"; productNo: string; shopifyProductId: string;
    variantId: string; title: string; price: number; imageUrl: string; handle: string;
  };
  let normalizedCrossSell: NormalizedCrossSell[] | undefined;
  if (crossSell !== undefined) {
    if (crossSell !== null && !Array.isArray(crossSell)) return res.status(400).json({ error: "crossSell must be an array" });
    normalizedCrossSell = [];
    const seen = new Set<string>();
    for (const entry of crossSell ?? []) {
      const kind = String(entry?.kind ?? "").toUpperCase();
      if (kind === "RESERVLY") {
        const productNo = String(entry?.productNo ?? "").trim();
        if (!productNo || productNo === p.product_no || seen.has(`R:${productNo}`)) continue;
        seen.add(`R:${productNo}`);
        normalizedCrossSell.push({ kind, productNo, shopifyProductId: "", variantId: "", title: "", price: 0, imageUrl: "", handle: "" });
      } else if (kind === "SHOPIFY") {
        const productId = String(entry?.shopifyProductId ?? "").trim();
        const variantId = String(entry?.variantId ?? "").trim();
        if (!productId || !variantId || seen.has(`S:${productId}`)) continue;
        seen.add(`S:${productId}`);
        normalizedCrossSell.push({
          kind, productNo: productId, shopifyProductId: productId, variantId,
          title: String(entry?.title ?? "").trim(), price: Number(entry?.price) || 0,
          imageUrl: String(entry?.imageUrl ?? "").trim(), handle: String(entry?.handle ?? "").trim(),
        });
      } else {
        return res.status(400).json({ error: "crossSell kind must be RESERVLY or SHOPIFY" });
      }
    }
  } else if (crossSellProductNos !== undefined) {
    if (crossSellProductNos !== null && !Array.isArray(crossSellProductNos)) {
      return res.status(400).json({ error: "crossSellProductNos must be an array" });
    }
    const productNos = [...new Set<string>(
      (crossSellProductNos ?? []).map((value: unknown) => String(value).trim()).filter(Boolean),
    )].filter((productNo) => productNo !== p.product_no && productNo !== String(req.body?.productNo ?? ""));
    normalizedCrossSell = productNos.map((productNo) => ({
      kind: "RESERVLY", productNo, shopifyProductId: "", variantId: "", title: "", price: 0, imageUrl: "", handle: "",
    }));
  }
  if (normalizedCrossSell !== undefined) {
    const reservlyNos = normalizedCrossSell.filter((entry) => entry.kind === "RESERVLY").map((entry) => entry.productNo);
    if (reservlyNos.length) {
      const placeholders = reservlyNos.map(() => "?").join(",");
      const existing = db.prepare(`SELECT product_no FROM products WHERE product_no IN (${placeholders})`)
        .all(...reservlyNos) as { product_no: string }[];
      const existingNos = new Set(existing.map((row) => row.product_no));
      const missing = reservlyNos.filter((productNo) => !existingNos.has(productNo));
      if (missing.length) return res.status(400).json({ error: `Unknown cross-sell products: ${missing.join(", ")}` });
    }
  }
  if (Array.isArray(translations)) {
    const required = pj<string[]>(getSettings().enabledLanguages, ["en", "fr"]);
    const missing = required.filter((locale) =>
      !translations.some((tr: any) => tr.locale === locale && String(tr.name || "").trim()),
    );
    if (missing.length) return res.status(400).json({ error: `Missing required translations: ${missing.join(", ")}` });
  }
  // Prices are editable here; in live NAV mode the next catalog sync will
  // overwrite them with NAV's — NAV stays the source of truth for pricing.
  db.prepare(
    `UPDATE products SET image_url = COALESCE(?, image_url), web_desc_en = COALESCE(?, web_desc_en),
     web_desc_fr = COALESCE(?, web_desc_fr), shopify_product_id = COALESCE(?, shopify_product_id),
     sku = COALESCE(?, sku),
     available_on_web = COALESCE(?, available_on_web),
     online = COALESCE(?, online),
     default_unit_price = COALESCE(?, default_unit_price),
     security_deposit = COALESCE(?, security_deposit),
     late_fee_per_day = COALESCE(?, late_fee_per_day),
     shipping_enabled = COALESCE(?, shipping_enabled),
     shipping_fee = COALESCE(?, shipping_fee),
     ship_buffer_before_days = COALESCE(?, ship_buffer_before_days),
     ship_buffer_after_days = COALESCE(?, ship_buffer_after_days),
     updated_at = ? WHERE id = ?`,
  ).run(imageUrl ?? null, webDescEn ?? null, webDescFr ?? null, shopifyProductId ?? null, sku,
    availableOnWeb == null ? null : availableOnWeb ? 1 : 0,
    online == null ? null : online ? 1 : 0,
    defaultUnitPrice == null ? null : Number(defaultUnitPrice),
    securityDeposit == null ? null : Number(securityDeposit),
    lateFeePerDay == null ? null : Number(lateFeePerDay),
    shippingEnabled == null || p.type !== "RENTAL" ? null : shippingEnabled ? 1 : 0,
    shippingFee == null || p.type !== "RENTAL" ? null : Math.max(0, Number(shippingFee) || 0),
    shipBufferBeforeDays == null || p.type !== "RENTAL" ? null : Math.max(0, Math.trunc(Number(shipBufferBeforeDays) || 0)),
    shipBufferAfterDays == null || p.type !== "RENTAL" ? null : Math.max(0, Math.trunc(Number(shipBufferAfterDays) || 0)),
    now(), p.id);
  if (scheduling && typeof scheduling === "object") {
    db.prepare(`UPDATE products SET buffer_before=?,buffer_after=?,min_notice_hours=?,max_advance_days=?,
      cancellation_hours=?,customer_can_cancel=?,customer_can_reschedule=?,deposit_policy=?,updated_at=? WHERE id=?`)
      .run(Math.max(0, Number(scheduling.bufferBefore) || 0), Math.max(0, Number(scheduling.bufferAfter) || 0),
        Math.max(0, Number(scheduling.minNoticeHours) || 0), Math.max(1, Number(scheduling.maxAdvanceDays) || 365),
        Math.max(0, Number(scheduling.cancellationHours) || 0), scheduling.customerCanCancel === false ? 0 : 1,
        scheduling.customerCanReschedule === false ? 0 : 1,
        ["ONLINE", "PICKUP", "NONE"].includes(scheduling.depositPolicy) ? scheduling.depositPolicy : "PICKUP", now(), p.id);
  }
  if (Array.isArray(kit)) {
    db.prepare("DELETE FROM product_kit_items WHERE product_id = ?").run(p.id);
    const ins = db.prepare("INSERT INTO product_kit_items (id, product_id, item_no, description, qty) VALUES (?, ?, ?, ?, ?)");
    for (const k of kit) ins.run(uid(), p.id, String(k.itemNo ?? ""), String(k.description ?? ""), Number(k.qty) || 1);
  }
  if (Array.isArray(prices) && p.type !== "SERVICE") {
    db.prepare("DELETE FROM product_prices WHERE product_id = ?").run(p.id);
    const ins = db.prepare("INSERT INTO product_prices (id, product_id, description, price) VALUES (?, ?, ?, ?)");
    for (const t of prices) {
      if (String(t.description ?? "").trim()) ins.run(uid(), p.id, String(t.description).trim().toUpperCase(), Number(t.price) || 0);
    }
  } else if (p.type === "SERVICE") {
    // Clean up any orphaned product_prices rows for SERVICE products
    db.prepare("DELETE FROM product_prices WHERE product_id = ?").run(p.id);
  }
  if (Array.isArray(addons)) {
    db.prepare("DELETE FROM product_addons WHERE product_id=?").run(p.id);
    const ins = db.prepare(`INSERT INTO product_addons(id,product_id,addon_product_no,name,price,max_qty,required,active,shopify_variant_id)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const a of addons) {
      if (!String(a.name || "").trim() || !String(a.addonProductNo || "").trim()) continue;
      ins.run(a.id || uid(), p.id, String(a.addonProductNo), String(a.name), Number(a.price) || 0,
        Math.max(1, Number(a.maxQty) || 1), a.required ? 1 : 0, a.active === false ? 0 : 1, String(a.shopifyVariantId || ""));
    }
  }
  if (normalizedCrossSell !== undefined) {
    const replaceCrossSell = db.transaction(() => {
      db.prepare("DELETE FROM product_cross_sell WHERE product_id=?").run(p.id);
      const insert = db.prepare(`INSERT INTO product_cross_sell(
        product_id,suggested_product_no,kind,shopify_product_id,shopify_variant_id,title,price,image_url,handle
      ) VALUES(?,?,?,?,?,?,?,?,?)`);
      for (const entry of normalizedCrossSell) {
        insert.run(p.id, entry.productNo, entry.kind, entry.shopifyProductId, entry.variantId,
          entry.title, entry.price, entry.imageUrl, entry.handle);
      }
    });
    replaceCrossSell();
  }
  if (Array.isArray(translations)) {
    const upsert = db.prepare(`INSERT INTO product_translations(product_id,locale,name,description)
      VALUES(?,?,?,?) ON CONFLICT(product_id,locale) DO UPDATE SET name=excluded.name,description=excluded.description`);
    for (const tr of translations) {
      const locale = String(tr.locale || "").toLowerCase();
      if (!/^[a-z]{2}(-[a-z]{2})?$/.test(locale)) continue;
      upsert.run(p.id, locale, String(tr.name || "").trim(), String(tr.description || ""));
    }
    const en = translations.find((tr: any) => tr.locale === "en");
    const fr = translations.find((tr: any) => tr.locale === "fr");
    if (en) db.prepare("UPDATE products SET name=?,web_desc_en=? WHERE id=?").run(String(en.name || p.name), String(en.description || ""), p.id);
    if (fr) db.prepare("UPDATE products SET name_fr=?,web_desc_fr=? WHERE id=?").run(String(fr.name || ""), String(fr.description || ""), p.id);
  }
  res.json({ product: serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)) });
});

const FIELD_TYPES = ["text", "textarea", "dropdown", "radio", "checkbox", "date", "number"];
const LOCALE_PATTERN = /^[a-z]{2}(-[a-z]{2})?$/;

function bookingFieldTranslations(fieldId: string) {
  return (db.prepare(`SELECT locale,label,options FROM booking_field_translations
    WHERE field_id=? ORDER BY locale`).all(fieldId) as any[]).map((translation) => ({
    ...translation,
    options: pj<string[]>(translation.options, []),
  }));
}

function writeBookingFieldTranslations(fieldId: string, translations: unknown) {
  if (!translations || typeof translations !== "object" || Array.isArray(translations)) return;
  const upsert = db.prepare(`INSERT INTO booking_field_translations(field_id,locale,label,options)
    VALUES(?,?,?,?) ON CONFLICT(field_id,locale) DO UPDATE SET
    label=excluded.label,options=excluded.options`);
  const remove = db.prepare("DELETE FROM booking_field_translations WHERE field_id=? AND locale=?");
  for (const [rawLocale, rawTranslation] of Object.entries(translations)) {
    const locale = rawLocale.trim().toLowerCase();
    if (!LOCALE_PATTERN.test(locale) || !rawTranslation || typeof rawTranslation !== "object") continue;
    const translation = rawTranslation as { label?: unknown; options?: unknown };
    const label = String(translation.label ?? "").trim();
    const options = Array.isArray(translation.options)
      ? translation.options.map((option) => String(option).trim())
      : [];
    if (!label && options.every((option) => !option)) remove.run(fieldId, locale);
    else upsert.run(fieldId, locale, label, JSON.stringify(options));
  }
}

function validateBookingField(value: any, existing?: any): { value?: any; error?: string } {
  const merged = { ...existing, ...value };
  const label = String(merged.label ?? "").trim();
  const type = String(merged.type ?? "text");
  const options = value?.options === undefined ? pj<string[]>(existing?.options, []) : value.options;
  if (!label) return { error: "label_required" };
  if (!FIELD_TYPES.includes(type)) return { error: "type_invalid" };
  if (!Array.isArray(options) || options.some((option) => typeof option !== "string")) return { error: "options_invalid" };
  const cleanOptions = options.map((option: string) => option.trim()).filter(Boolean);
  const requiresOptions = ["dropdown", "radio"];
  if (requiresOptions.includes(type) && !cleanOptions.length) return { error: "options_required" };
  return { value: {
    label, type, options: cleanOptions, required: merged.required ? 1 : 0,
    sort: Number.isFinite(Number(merged.sort)) ? Number(merged.sort) : 0,
  } };
}

catalogRouter.post("/products/:id/fields", requirePerm("products"), (req, res) => {
  if (!db.prepare("SELECT id FROM products WHERE id=?").get(req.params.id)) {
    return res.status(404).json({ error: "Product not found" });
  }
  const checked = validateBookingField(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const id = uid();
  const field = checked.value;
  db.transaction(() => {
    db.prepare(`INSERT INTO booking_fields(id,product_id,label,type,options,required,sort)
      VALUES(?,?,?,?,?,?,?)`).run(id, req.params.id, field.label, field.type, JSON.stringify(field.options), field.required, field.sort);
    writeBookingFieldTranslations(id, req.body?.translations);
  })();
  return res.json({ id, translations: bookingFieldTranslations(id) });
});

catalogRouter.put("/products/:id/fields/:fieldId", requirePerm("products"), (req, res) => {
  const existing = db.prepare("SELECT * FROM booking_fields WHERE id=? AND product_id=?")
    .get(req.params.fieldId, req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "Field not found" });
  const checked = validateBookingField(req.body, existing);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const field = checked.value;
  db.transaction(() => {
    db.prepare(`UPDATE booking_fields SET label=?,type=?,options=?,required=?,sort=? WHERE id=? AND product_id=?`)
      .run(field.label, field.type, JSON.stringify(field.options), field.required, field.sort, existing.id, req.params.id);
    if (req.body?.translations !== undefined) writeBookingFieldTranslations(existing.id, req.body.translations);
  })();
  return res.json({ ok: true, translations: bookingFieldTranslations(existing.id) });
});

catalogRouter.delete("/products/:id/fields/:fieldId", requirePerm("products"), (req, res) => {
  db.prepare("DELETE FROM booking_fields WHERE id=? AND product_id=?").run(req.params.fieldId, req.params.id);
  res.json({ ok: true });
});

const imageRaw = raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" });
catalogRouter.post("/products/:id/image", requirePerm("products"), imageRaw, (req, res) => {
  const product = db.prepare("SELECT id FROM products WHERE id=?").get(req.params.id) as any;
  if (!product) return res.status(404).json({ error: "Product not found" });
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = extensions[String(req.headers["content-type"] || "").split(";")[0].toLowerCase()];
  if (!ext || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Invalid file type" });
  const dir = path.join(DATA_DIR, "uploads", "products");
  fs.mkdirSync(dir, { recursive: true });
  const base = `${currentTenant().slug}-${product.id}`;
  for (const oldExt of Object.values(extensions)) {
    if (oldExt !== ext) fs.rmSync(path.join(dir, `${base}.${oldExt}`), { force: true });
  }
  const filename = `${base}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), req.body);
  const imageUrl = `/uploads/products/${filename}`;
  db.prepare("UPDATE products SET image_url=?,updated_at=? WHERE id=?").run(imageUrl, now(), product.id);
  res.json({ imageUrl });
});

catalogRouter.delete("/products/:id/image", requirePerm("products"), (req, res) => {
  const product = db.prepare("SELECT id,image_url FROM products WHERE id=?").get(req.params.id) as any;
  if (!product) return res.status(404).json({ error: "Product not found" });
  const dir = path.join(DATA_DIR, "uploads", "products");
  const base = `${currentTenant().slug}-${product.id}`;
  for (const ext of ["jpg", "png", "webp"]) fs.rmSync(path.join(dir, `${base}.${ext}`), { force: true });
  db.prepare("UPDATE products SET image_url='',updated_at=? WHERE id=?").run(now(), product.id);
  res.json({ ok: true });
});

const termNames: Record<string, string> = { rental: "Rental", course: "Course", service: "Service" };
const pdfRaw = raw({ type: "application/pdf", limit: "10mb" });
catalogRouter.post("/terms/:type/pdf", requireOwner, pdfRaw, (req, res) => {
  const name = termNames[req.params.type];
  if (!name) return res.status(400).json({ error: "Invalid terms type" });
  if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Invalid file type" });
  const dir = path.join(DATA_DIR, "uploads", "terms");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${currentTenant().slug}-${req.params.type}.pdf`), req.body);
  putSettings({ [`terms${name}Pdf`]: "1" });
  res.json({ ok: true });
});

catalogRouter.delete("/terms/:type/pdf", requireOwner, (req, res) => {
  const name = termNames[req.params.type];
  if (!name) return res.status(400).json({ error: "Invalid terms type" });
  fs.rmSync(path.join(DATA_DIR, "uploads", "terms", `${currentTenant().slug}-${req.params.type}.pdf`), { force: true });
  putSettings({ [`terms${name}Pdf`]: "" });
  res.json({ ok: true });
});

catalogRouter.get("/intake-forms", (_req, res) => {
  const forms = (db.prepare(`SELECT f.*,p.product_no FROM intake_forms f LEFT JOIN products p ON p.id=f.product_id
    ORDER BY f.name`).all() as any[]).map((f) => ({
      id: f.id, name: f.name, productId: f.product_id, productNo: f.product_no,
      enabled: !!f.enabled, fields: pj(f.fields, []),
    }));
  res.json({ forms });
});

catalogRouter.post("/intake-forms", requirePerm("products"), (req, res) => {
  const { id = uid(), name, productId, enabled = true, fields = [] } = req.body ?? {};
  if (!String(name || "").trim() || !Array.isArray(fields)) return res.status(400).json({ error: "name and fields[] are required" });
  const clean = fields.map((f: any) => ({
    id: String(f.id || uid()), label: String(f.label || "").slice(0, 160),
    type: ["text", "textarea", "select", "checkbox", "date"].includes(f.type) ? f.type : "text",
    required: !!f.required, options: Array.isArray(f.options) ? f.options.map(String) : [],
  })).filter((f: any) => f.label);
  db.prepare(`INSERT INTO intake_forms(id,name,product_id,enabled,fields,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,product_id=excluded.product_id,enabled=excluded.enabled,
    fields=excluded.fields,updated_at=excluded.updated_at`)
    .run(id, String(name).trim(), productId || null, enabled ? 1 : 0, JSON.stringify(clean), now(), now());
  res.json({ id });
});

catalogRouter.delete("/intake-forms/:id", requirePerm("products"), (req, res) => {
  db.prepare("DELETE FROM intake_forms WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

catalogRouter.post("/products/:id/addons", requirePerm("products"), (req, res) => {
  const product = db.prepare("SELECT id FROM products WHERE id=?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  const { id = uid(), addonProductNo, name, price = 0, maxQty = 1, required = false, active = true, shopifyVariantId = "" } = req.body ?? {};
  if (!addonProductNo || !name) return res.status(400).json({ error: "addonProductNo and name are required" });
  db.prepare(`INSERT INTO product_addons(id,product_id,addon_product_no,name,price,max_qty,required,active,shopify_variant_id)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET addon_product_no=excluded.addon_product_no,
    name=excluded.name,price=excluded.price,max_qty=excluded.max_qty,required=excluded.required,active=excluded.active,
    shopify_variant_id=excluded.shopify_variant_id`)
    .run(id, req.params.id, String(addonProductNo), String(name), Number(price) || 0, Math.max(1, Number(maxQty) || 1), required ? 1 : 0, active ? 1 : 0, String(shopifyVariantId));
  res.json({ id });
});

catalogRouter.delete("/products/:productId/addons/:id", requirePerm("products"), (req, res) => {
  db.prepare("DELETE FROM product_addons WHERE id=? AND product_id=?").run(req.params.id, req.params.productId);
  res.json({ ok: true });
});

catalogRouter.get("/availability-rules", requirePerm("availability"), (req, res) => {
  const { scopeType, scopeId } = req.query as Record<string, string>;
  let sql = "SELECT * FROM availability_rules WHERE 1=1";
  const params: unknown[] = [];
  if (scopeType) { sql += " AND scope_type=?"; params.push(scopeType); }
  if (scopeId) { sql += " AND scope_id=?"; params.push(scopeId); }
  res.json({ rules: db.prepare(sql + " ORDER BY kind,weekday,starts_at").all(...params) });
});

catalogRouter.post("/availability-rules", requirePerm("availability"), (req, res) => {
  const { id = uid(), scopeType, scopeId, kind, weekday = null, startsAt = "", endsAt = "", from = "", to = "", label = "" } = req.body ?? {};
  if (!["STORE", "PRODUCT", "RESOURCE"].includes(scopeType) || !scopeId || !["OPENING", "BLACKOUT"].includes(kind)) {
    return res.status(400).json({ error: "Valid scopeType, scopeId and kind are required" });
  }
  if (kind === "OPENING" && (!Number.isInteger(Number(weekday)) || !from || !to)) return res.status(400).json({ error: "Opening rules require weekday, from and to" });
  if (kind === "BLACKOUT" && (!startsAt || !endsAt)) return res.status(400).json({ error: "Blackouts require startsAt and endsAt" });
  db.prepare(`INSERT INTO availability_rules(id,scope_type,scope_id,kind,weekday,starts_at,ends_at,from_time,to_time,label,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,scope_id=excluded.scope_id,
    kind=excluded.kind,weekday=excluded.weekday,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
    from_time=excluded.from_time,to_time=excluded.to_time,label=excluded.label`)
    .run(id, scopeType, scopeId, kind, weekday, startsAt, endsAt, from, to, label, now());
  res.json({ id });
});

catalogRouter.delete("/availability-rules/:id", requirePerm("availability"), (req, res) => {
  db.prepare("DELETE FROM availability_rules WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// --- Serialized rental fleet -------------------------------------------------

function serializeUnit(u: any) {
  const maintenanceDue = (u.next_service_usage != null && u.usage_count >= u.next_service_usage)
    || (u.next_service_at && u.next_service_at <= now());
  return {
    id: u.id, productId: u.product_id, productNo: u.product_no, productName: u.product_name,
    storeId: u.store_id, serialNo: u.serial_no, barcode: u.barcode,
    status: u.status, condition: u.condition, notes: u.notes, updatedAt: u.updated_at,
    usageCount: u.usage_count || 0, nextServiceUsage: u.next_service_usage,
    lastServiceAt: u.last_service_at, nextServiceAt: u.next_service_at,
    maintenanceDue: Boolean(maintenanceDue),
    unavailability: db.prepare(`SELECT id,starts_at AS startsAt,ends_at AS endsAt,reason
      FROM rental_unit_unavailability WHERE unit_id=? AND ends_at>=? ORDER BY starts_at`)
      .all(u.id, now().slice(0, 10)),
  };
}

catalogRouter.get("/rental-units", requirePerm("products"), (req, res) => {
  const { productId, productNo, storeId, status, q } = req.query as Record<string, string>;
  let sql = `SELECT u.*, p.product_no, p.name AS product_name FROM rental_units u
             JOIN products p ON p.id = u.product_id WHERE 1=1`;
  const params: unknown[] = [];
  if (productId) { sql += " AND u.product_id = ?"; params.push(productId); }
  if (productNo) { sql += " AND p.product_no = ?"; params.push(productNo); }
  if (storeId) { sql += " AND u.store_id = ?"; params.push(storeId); }
  if (status) { sql += " AND u.status = ?"; params.push(status); }
  if (q) { sql += " AND (u.barcode LIKE ? OR u.serial_no LIKE ? OR p.name LIKE ?)"; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY p.name, u.barcode";
  res.json({ units: (db.prepare(sql).all(...params) as any[]).map(serializeUnit) });
});

catalogRouter.post("/rental-units", requirePerm("products"), (req, res) => {
  const { productId, storeId, serialNo = "", barcode, condition = "GOOD", notes = "", nextServiceUsage = 25, nextServiceAt = null } = req.body ?? {};
  if (!productId || !barcode) return res.status(400).json({ error: "productId and barcode are required" });
  const product = db.prepare("SELECT id FROM products WHERE id = ? AND type = 'RENTAL'").get(productId);
  if (!product) return res.status(400).json({ error: "Rental product not found" });
  try {
    const id = uid();
    db.prepare(`INSERT INTO rental_units
      (id, product_id, store_id, serial_no, barcode, status, condition, notes,next_service_usage,next_service_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?, ?, ?)`)
      .run(id, productId, storeId || null, String(serialNo), String(barcode).trim(), condition, notes,
        Number(nextServiceUsage) || 25, nextServiceAt || null, now());
    const unit = db.prepare(`SELECT u.*, p.product_no, p.name AS product_name FROM rental_units u
      JOIN products p ON p.id = u.product_id WHERE u.id = ?`).get(id);
    res.json({ unit: serializeUnit(unit) });
  } catch (err: any) {
    res.status(400).json({ error: String(err.message).includes("UNIQUE") ? "Barcode already exists" : String(err.message) });
  }
});

catalogRouter.put("/rental-units/:id", requirePerm("products"), (req, res) => {
  const unit = db.prepare("SELECT id FROM rental_units WHERE id = ?").get(req.params.id);
  if (!unit) return res.status(404).json({ error: "Rental unit not found" });
  const { storeId, serialNo, barcode, status, condition, notes, nextServiceUsage, nextServiceAt } = req.body ?? {};
  db.prepare(`UPDATE rental_units SET store_id=COALESCE(?,store_id), serial_no=COALESCE(?,serial_no),
    barcode=COALESCE(?,barcode), status=COALESCE(?,status), condition=COALESCE(?,condition),
    notes=COALESCE(?,notes), next_service_usage=COALESCE(?,next_service_usage),
    next_service_at=COALESCE(?,next_service_at), updated_at=? WHERE id=?`)
    .run(storeId ?? null, serialNo ?? null, barcode ?? null, status ?? null, condition ?? null, notes ?? null,
      nextServiceUsage ?? null, nextServiceAt ?? null, now(), req.params.id);
  const updated = db.prepare(`SELECT u.*, p.product_no, p.name AS product_name FROM rental_units u
    JOIN products p ON p.id = u.product_id WHERE u.id = ?`).get(req.params.id);
  res.json({ unit: serializeUnit(updated) });
});

catalogRouter.get("/rental-units/:id/maintenance", requirePerm("products"), (req, res) => {
  const unit = db.prepare("SELECT id FROM rental_units WHERE id=?").get(req.params.id);
  if (!unit) return res.status(404).json({ error: "Rental unit not found" });
  res.json({ logs: db.prepare(`SELECT id,kind,notes,usage_at_service AS usageAtService,
    serviced_at AS servicedAt,next_service_usage AS nextServiceUsage,next_service_at AS nextServiceAt
    FROM maintenance_logs WHERE unit_id=? ORDER BY serviced_at DESC`).all(req.params.id) });
});

catalogRouter.post("/rental-units/:id/maintenance", requirePerm("products"), (req, res) => {
  const unit = db.prepare("SELECT * FROM rental_units WHERE id=?").get(req.params.id) as any;
  if (!unit) return res.status(404).json({ error: "Rental unit not found" });
  const { kind = "ROUTINE", notes = "", nextServiceUsage, nextServiceAt } = req.body ?? {};
  const nextUsage = Number(nextServiceUsage) > unit.usage_count ? Number(nextServiceUsage) : unit.usage_count + 25;
  const nextDate = String(nextServiceAt || "");
  db.transaction(() => {
    db.prepare(`INSERT INTO maintenance_logs
      (id,unit_id,kind,notes,usage_at_service,serviced_at,next_service_usage,next_service_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(uid(), unit.id, String(kind), String(notes), unit.usage_count, now(), nextUsage, nextDate || null);
    db.prepare(`UPDATE rental_units SET status='AVAILABLE',
      condition=CASE WHEN condition='DAMAGED' THEN 'GOOD' ELSE condition END,
      last_service_at=?,next_service_usage=?,next_service_at=?,updated_at=? WHERE id=?`)
      .run(now(), nextUsage, nextDate || null, now(), unit.id);
  })();
  const updated = db.prepare(`SELECT u.*,p.product_no,p.name AS product_name FROM rental_units u
    JOIN products p ON p.id=u.product_id WHERE u.id=?`).get(unit.id);
  res.json({ unit: serializeUnit(updated) });
});

catalogRouter.post("/rental-units/:id/unavailability", requirePerm("products"), (req, res) => {
  const unit = db.prepare("SELECT id FROM rental_units WHERE id=?").get(req.params.id);
  if (!unit) return res.status(404).json({ error: "Rental unit not found" });
  const { startsAt, endsAt, reason = "Maintenance" } = req.body ?? {};
  if (!startsAt || !endsAt || String(endsAt) < String(startsAt)) {
    return res.status(400).json({ error: "A valid start and end date are required" });
  }
  const id = uid();
  db.prepare(`INSERT INTO rental_unit_unavailability(id,unit_id,starts_at,ends_at,reason,created_at)
    VALUES(?,?,?,?,?,?)`).run(id, req.params.id, String(startsAt), String(endsAt), String(reason), now());
  res.json({ block: { id, startsAt, endsAt, reason } });
});

catalogRouter.delete("/rental-units/:unitId/unavailability/:id", requirePerm("products"), (req, res) => {
  db.prepare("DELETE FROM rental_unit_unavailability WHERE id=? AND unit_id=?").run(req.params.id, req.params.unitId);
  res.json({ ok: true });
});

/** Pull the activity catalog from NAV (R0 / class step 2: NAV → app → Shopify). */
catalogRouter.post("/products/sync", requirePerm("products"), async (_req, res) => {
  try {
    if (navMode() === "mock") {
      const count = (db.prepare("SELECT COUNT(*) AS n FROM products").get() as any).n;
      return res.json({ synced: count, mode: "mock" });
    }
    const types = await getActivityTypes();
    let synced = 0;
    for (const t of types) {
      const products = await getActivityProducts(t.ActivityCode);
      for (const np of products) {
        const type = /RENT|LOC/i.test(np.ActivityType) || /RENT|LOC/i.test(np.ProductType) ? "RENTAL" : "COURSE";
        const existing = db.prepare("SELECT id FROM products WHERE product_no = ?").get(np.ProductNo) as any;
        const id = existing?.id ?? uid();
        db.prepare(
          `INSERT INTO products (id, product_no, type, activity_type, name, name_fr, web_desc_en, web_desc_fr,
             duration_type, duration, default_unit_price, security_deposit, retail_item, fixed_location,
             available_on_web, min_qty, max_qty, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(product_no) DO UPDATE SET
             activity_type=excluded.activity_type, name=excluded.name, name_fr=excluded.name_fr,
             web_desc_en=excluded.web_desc_en, web_desc_fr=excluded.web_desc_fr,
             duration_type=excluded.duration_type, duration=excluded.duration,
             default_unit_price=excluded.default_unit_price, security_deposit=excluded.security_deposit,
             retail_item=excluded.retail_item, fixed_location=excluded.fixed_location, updated_at=excluded.updated_at`,
        ).run(
          id, np.ProductNo, type, np.ActivityType, np.DescriptionEn || np.Description, np.Description,
          np.WebDescEN ?? "", np.WebDescFR ?? "", String(np.DurationType ?? ""), Number(np.Duration) || 0,
          Number(np.DefaultUnitPrice) || 0, Number(np.SecurityDeposit) || 0, np.RetailItem ?? "",
          np.FixedLocation ?? "", String(np.AvailableOnWeb).toLowerCase() === "true" ? 1 : 0,
          Number(np.MinQty) || 1, Number(np.MaxQty) || 10, now(),
        );
        db.prepare("DELETE FROM product_prices WHERE product_id = ?").run(id);
        for (const pp of np.ActivityProductPrice ?? []) {
          db.prepare("INSERT INTO product_prices (id, product_id, description, price) VALUES (?, ?, ?, ?)")
            .run(uid(), id, pp.Description, Number(pp.Price) || 0);
        }
        synced++;
      }
    }
    res.json({ synced, mode: "live" });
  } catch (err) {
    res.status(502).json({ error: `NAV sync failed: ${String(err)}` });
  }
});

/** Create/update this product in Shopify (title, price, description, image) with
 *  the booking.* metafields the storefront widget reads — the "publish" half of
 *  R0's NAV → Shopify flow, no manual product creation needed. */
let metafieldDefsEnsured = false;
catalogRouter.post("/products/:id/push-shopify", requirePerm("products"), async (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  try {
    if (!metafieldDefsEnsured) {
      await ensureMetafieldDefinitions();
      metafieldDefsEnsured = true;
    }
    p.weekly_price = weeklyPrice(p.id);
    const result = await pushProductToShopify(p);
    db.prepare("UPDATE products SET shopify_product_id = ?, updated_at = ? WHERE id = ?").run(result.id, now(), p.id);
    // Publish to sales channels (default: both Online Store and POS).
    const channels = {
      onlineStore: req.body?.channels?.onlineStore !== false,
      pos: req.body?.channels?.pos !== false,
    };
    let publishedTo: string[] = [];
    let publishWarning = "";
    try {
      publishedTo = await publishToChannels(result.id, channels);
    } catch (err) {
      publishWarning = String((err as Error).message ?? err); // product exists; channels can be fixed in admin
    }
    emit(null, "shopify.product_pushed", { productNo: p.product_no, shopifyProductId: result.id, publishedTo });
    res.json({
      product: serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)),
      shopifyProductId: result.id,
      handle: result.handle,
      publishedTo,
      ...(publishWarning ? { publishWarning } : {}),
    });
  } catch (err) {
    console.warn("[shopify] product push failed", p.product_no, err);
    res.status(502).json({ error: String((err as Error).message ?? err) });
  }
});

// --- Sessions (course instances) -------------------------------------------

function serializeSession(s: any) {
  const room = s.room_id
    ? db.prepare("SELECT name FROM resources WHERE id = ?").get(s.room_id) as { name: string } | undefined
    : undefined;
  const trainers = db.prepare(
    `SELECT r.id, r.name
     FROM session_trainers st
     JOIN resources r ON r.id = st.resource_id
     WHERE st.session_id = ? AND r.type = 'TRAINER'
     ORDER BY r.name`,
  ).all(s.id) as { id: string; name: string }[];
  return {
    id: s.id, productId: s.product_id, seriesId: s.series_id, startsAt: s.starts_at, endsAt: s.ends_at,
    storeId: s.store_id, roomId: s.room_id, roomName: room?.name ?? "", capacity: s.capacity, booked: sessionBooked(s.id),
    instanceNo: s.instance_no, instanceCount: s.instance_count,
    trainerIds: trainers.map((trainer) => trainer.id),
    trainers,
    online: s.online ? 1 : 0,
    deliveryMode: s.delivery_mode || "IN_PERSON", meetingUrl: s.meeting_url || "",
    meetingHostUrl: s.meeting_host_url || "", zoomMeetingId: s.zoom_meeting_id || "",
  };
}

catalogRouter.get("/sessions", (req, res) => {
  const { productId, from, to, storeId } = req.query as Record<string, string>;
  let sql = "SELECT s.*, p.name AS product_name, p.product_no FROM sessions s JOIN products p ON p.id = s.product_id WHERE 1=1";
  const params: unknown[] = [];
  if (productId) { sql += " AND s.product_id = ?"; params.push(productId); }
  if (storeId) { sql += " AND s.store_id = ?"; params.push(storeId); }
  if (from) { sql += " AND s.starts_at >= ?"; params.push(from); }
  if (to) { sql += " AND s.starts_at <= ?"; params.push(to); }
  sql += " ORDER BY s.starts_at LIMIT 500";
  res.json({
    sessions: (db.prepare(sql).all(...params) as any[]).map((s) => ({ ...serializeSession(s), productName: s.product_name, productNo: s.product_no })),
  });
});

/** Create one session, or a series (occurrences > 1) — e.g. a night class over 3
 *  Tuesday evenings. All instances share seriesId and block room+trainers. */
catalogRouter.post("/sessions", requirePerm("sessions"), async (req, res) => {
  const { productId, startsAt, endsAt, storeId, roomId, trainerIds = [], capacity = 8, occurrences = 1, intervalDays = 7,
    deliveryMode = "IN_PERSON", meetingUrl = "", createZoom = false, online = false } = req.body ?? {};
  if (!productId || !startsAt || !endsAt || !storeId) return res.status(400).json({ error: "productId, startsAt, endsAt, storeId are required" });
  const seriesId = uid();
  const n = Math.max(1, Math.min(12, Number(occurrences) || 1));
  const out: any[] = [];
  const product = db.prepare("SELECT name FROM products WHERE id=?").get(productId) as { name: string } | undefined;
  const isOnline = online === true || Number(online) === 1;
  const settings = getSettings();
  const zoomConfigured = !!(settings.zoomAccountId && settings.zoomClientId && settings.zoomClientSecret);
  const occurrenceTimes = Array.from({ length: n }, (_, i) => {
    const offset = i * (Number(intervalDays) || 7) * 86_400_000;
    return {
      start: new Date(new Date(startsAt).getTime() + offset).toISOString(),
      end: new Date(new Date(endsAt).getTime() + offset).toISOString(),
    };
  });
  const resourceIds = [
    ...(!isOnline && roomId ? [String(roomId)] : []),
    ...((Array.isArray(trainerIds) ? trainerIds : []).map(String)),
  ];
  const localParts = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.BOOKING_TZ || "America/Toronto",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(iso));
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}` };
  };
  for (const occurrence of occurrenceTimes) {
    const start = localParts(occurrence.start);
    const end = localParts(occurrence.end);
    for (const resourceId of resourceIds) {
      const blocked = db.prepare(
        `SELECT b.reason, r.id, r.name
         FROM resource_blocks b JOIN resources r ON r.id = b.resource_id
         WHERE b.resource_id = ? AND b.date = ? AND b.from_time < ? AND b.to_time > ?
         ORDER BY b.from_time LIMIT 1`,
      ).get(resourceId, start.date, end.time, start.time) as { reason: string; id: string; name: string } | undefined;
      if (blocked) {
        return res.status(409).json({
          error: "resource_blocked",
          resource: { id: blocked.id, name: blocked.name },
          reason: blocked.reason ?? "",
        });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const id = uid();
    const occurrenceStart = occurrenceTimes[i].start;
    const occurrenceEnd = occurrenceTimes[i].end;
    let joinUrl = String(meetingUrl || ""), hostUrl = "", zoomId = "";
    if (isOnline && createZoom && zoomConfigured) {
      try {
        const date = localParts(occurrenceStart).date;
        const zoom = await createZoomMeeting({ topic: `${product?.name || "Class"} (${date})`, startsAt: occurrenceStart, endsAt: occurrenceEnd });
        joinUrl = zoom.joinUrl; hostUrl = zoom.startUrl; zoomId = zoom.id;
      } catch (err) {
        console.warn("[sessions] Zoom meeting creation failed for session", { sessionId: id, error: String(err) });
      }
    }
    db.prepare(
      `INSERT INTO sessions (id, product_id, series_id, starts_at, ends_at, store_id, room_id, capacity, instance_no, instance_count,
        delivery_mode,meeting_url,meeting_host_url,zoom_meeting_id,online)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, productId, seriesId, occurrenceStart, occurrenceEnd,
      storeId, isOnline ? null : roomId ?? null, Number(capacity) || 8, i + 1, n, deliveryMode, joinUrl, hostUrl, zoomId,
      isOnline ? 1 : 0);
    for (const t of trainerIds) db.prepare("INSERT OR IGNORE INTO session_trainers (session_id, resource_id) VALUES (?, ?)").run(id, t);
    const stored = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    out.push(serializeSession(stored));
    for (const resourceId of [...(stored.room_id ? [stored.room_id] : []), ...trainerIds.map(String)]) {
      void pushSessionEvent(stored, resourceId);
    }
  }
  res.json({ sessions: out });
});

catalogRouter.delete("/sessions/:id", requirePerm("sessions"), (req, res) => {
  const session = db.prepare("SELECT room_id FROM sessions WHERE id=?").get(req.params.id) as { room_id: string | null } | undefined;
  const trainers = db.prepare("SELECT resource_id FROM session_trainers WHERE session_id=?").all(req.params.id) as { resource_id: string }[];
  for (const resourceId of [...(session?.room_id ? [session.room_id] : []), ...trainers.map((item) => item.resource_id)]) {
    void deleteSessionEvent(req.params.id, resourceId);
  }
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/**
 * Attendee roster for a session (staff: bookings OR sessions perms).
 * Returns session info + attendee list with check-in/no-show status.
 * Access: store-scoped.
 */
catalogRouter.get("/sessions/:id/attendees", (req, res) => {
  const access = staffAccess(req);
  if (!access) return res.status(401).json({ error: "auth_required" });
  if (!access.perms.sessions && !access.perms.bookings) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const session = db.prepare(`SELECT s.*, p.name AS product_name FROM sessions s
    JOIN products p ON p.id = s.product_id WHERE s.id = ?`).get(req.params.id) as any;
  if (!session) return res.status(404).json({ error: "Session not found" });

  const allowed = allowedStoreIds(req);
  if (allowed !== "*" && session.store_id && !allowed.includes(session.store_id)) {
    return res.status(404).json({ error: "not_found" });
  }

  const attendees = db.prepare(`
    SELECT
      b.id AS bookingId,
      b.ref AS bookingRef,
      b.customer_first AS customerFirst,
      b.customer_last AS customerLast,
      b.customer_email AS customerEmail,
      b.customer_phone AS customerPhone,
      l.qty,
      b.status AS bookingStatus,
      b.checked_in_at AS checkedInAt,
      b.no_show_at AS noShowAt
    FROM booking_lines l
    JOIN bookings b ON b.id = l.booking_id
    WHERE l.session_id = ? AND b.status NOT IN ('CANCELLED')
    ORDER BY b.created_at DESC
  `).all(session.id) as any[];

  res.json({
    session: {
      id: session.id,
      productName: session.product_name,
      startsAt: session.starts_at,
      endsAt: session.ends_at,
      storeId: session.store_id,
      capacity: session.capacity,
      meetingUrl: session.meeting_url || "",
    },
    attendees: attendees.map((attendee) => ({
      ...attendee,
      checkedInAt: attendee.checkedInAt || null,
      noShowAt: attendee.noShowAt || null,
    })),
  });
});

// --- Resources (rooms & trainers, class step 3A/3B) --------------------------

catalogRouter.get("/resources", requirePerm("sessions"), (req, res) => {
  const { type } = req.query as Record<string, string>;
  const rows = type
    ? db.prepare("SELECT * FROM resources WHERE type = ? ORDER BY name").all(type)
    : db.prepare("SELECT * FROM resources ORDER BY type, name").all();
  res.json({ resources: (rows as any[]).map((r) => ({ id: r.id, type: r.type, name: r.name, storeId: r.store_id, notes: r.notes, capacity: Number(r.capacity) || 0 })) });
});

catalogRouter.post("/resources", requirePerm("sessions"), (req, res) => {
  const { type, name, storeId, notes = "", capacity = 0 } = req.body ?? {};
  if (!type || !name) return res.status(400).json({ error: "type and name are required" });
  if (!["ROOM", "TRAINER"].includes(type)) return res.status(400).json({ error: "invalid resource type" });
  if (!Number.isInteger(Number(capacity)) || Number(capacity) < 0) return res.status(400).json({ error: "capacity must be a non-negative integer" });
  const id = uid();
  db.prepare("INSERT INTO resources (id, type, name, store_id, notes, capacity) VALUES (?, ?, ?, ?, ?, ?)").run(id, type, String(name).trim(), storeId ?? null, String(notes), Number(capacity));
  res.json({ resource: { id, type, name: String(name).trim(), storeId, notes: String(notes), capacity: Number(capacity) } });
});

catalogRouter.put("/resources/:id", requirePerm("sessions"), (req, res) => {
  const existing = db.prepare("SELECT * FROM resources WHERE id = ?").get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: "resource_not_found" });
  const name = req.body?.name === undefined ? existing.name : String(req.body.name).trim();
  const notes = req.body?.notes === undefined ? existing.notes : String(req.body.notes);
  const capacity = req.body?.capacity === undefined ? Number(existing.capacity) || 0 : Number(req.body.capacity);
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!Number.isInteger(capacity) || capacity < 0) return res.status(400).json({ error: "capacity must be a non-negative integer" });
  db.prepare("UPDATE resources SET name = ?, notes = ?, capacity = ? WHERE id = ?").run(name, notes, capacity, existing.id);
  res.json({ resource: { id: existing.id, type: existing.type, name, storeId: existing.store_id, notes, capacity } });
});

catalogRouter.delete("/resources/:id", requirePerm("sessions"), (req, res) => {
  db.prepare("DELETE FROM resources WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/** Bulk availability upload (class step 3B: trainers' schedules come in as CSV). */
catalogRouter.post("/resources/:id/availability", requirePerm("sessions"), (req, res) => {
  const slots: { date: string; from: string; to: string }[] = Array.isArray(req.body?.slots)
    ? req.body.slots
    : req.body?.date ? [{ date: req.body.date, from: req.body.fromTime, to: req.body.toTime }] : [];
  const ins = db.prepare("INSERT INTO resource_availability (id, resource_id, date, from_time, to_time) VALUES (?, ?, ?, ?, ?)");
  let added = 0;
  for (const s of slots) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !/^\d{2}:\d{2}$/.test(s.from) || !/^\d{2}:\d{2}$/.test(s.to) || s.from >= s.to) continue;
    ins.run(uid(), req.params.id, s.date, s.from, s.to);
    added++;
  }
  if (slots.length === 1 && added === 0) return res.status(400).json({ error: "invalid availability window" });
  res.json({ added });
});

catalogRouter.get("/resources/:id/availability", requirePerm("sessions"), (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  let sql = "SELECT id, date, from_time AS \"from\", to_time AS \"to\" FROM resource_availability WHERE resource_id = ?";
  const params: unknown[] = [req.params.id];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date LIMIT 500";
  res.json({ slots: db.prepare(sql).all(...params) });
});

catalogRouter.delete("/resources/:id/availability/:rowId", requirePerm("sessions"), (req, res) => {
  db.prepare("DELETE FROM resource_availability WHERE id = ? AND resource_id = ?").run(req.params.rowId, req.params.id);
  res.json({ ok: true });
});

catalogRouter.post("/resources/:id/availability/bulk", requirePerm("sessions"), (req, res) => {
  const { days, fromTime, toTime, startDate, endDate, replace = false } = req.body ?? {};
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const timePattern = /^\d{2}:\d{2}$/;
  if (!Array.isArray(days) || days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return res.status(400).json({ error: "days must be an array of weekdays from 0 to 6" });
  }
  if (!timePattern.test(fromTime) || !timePattern.test(toTime) || fromTime >= toTime) return res.status(400).json({ error: "invalid time range" });
  if (!datePattern.test(startDate) || !datePattern.test(endDate) || startDate > endDate) return res.status(400).json({ error: "invalid date range" });
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const maxDate = new Date(start);
  maxDate.setUTCDate(maxDate.getUTCDate() + (26 * 7) - 1);
  if (end > maxDate) {
    return res.status(400).json({ error: "range_too_long", maxWeeks: 26 });
  }
  const matchingDates: string[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    if (days.includes(cursor.getUTCDay())) matchingDates.push(cursor.toISOString().slice(0, 10));
  }
  if (matchingDates.length > 400) return res.status(400).json({ error: "availability range exceeds 400 rows" });
  const apply = db.transaction(() => {
    if (replace) {
      db.prepare("DELETE FROM resource_availability WHERE resource_id = ? AND date BETWEEN ? AND ?")
        .run(req.params.id, startDate, end.toISOString().slice(0, 10));
    }
    const insert = db.prepare("INSERT INTO resource_availability (id, resource_id, date, from_time, to_time) VALUES (?, ?, ?, ?, ?)");
    for (const date of matchingDates) insert.run(uid(), req.params.id, date, fromTime, toTime);
  });
  apply();
  res.json({ created: matchingDates.length });
});

catalogRouter.get("/resources/:id/blocks", requirePerm("sessions"), (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  let sql = `SELECT id, date, from_time AS fromTime, to_time AS toTime, reason, source,
    external_event_id AS externalEventId, created_at AS createdAt
    FROM resource_blocks WHERE resource_id = ?`;
  const params: unknown[] = [req.params.id];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date, from_time";
  res.json({ blocks: db.prepare(sql).all(...params) });
});

catalogRouter.post("/resources/:id/blocks", requirePerm("sessions"), (req, res) => {
  const { date, fromTime, toTime, reason = "" } = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(fromTime) || !/^\d{2}:\d{2}$/.test(toTime) || fromTime >= toTime) {
    return res.status(400).json({ error: "invalid block date or time range" });
  }
  const block = { id: uid(), date, fromTime, toTime, reason: String(reason), source: "MANUAL", createdAt: now() };
  db.prepare(`INSERT INTO resource_blocks (id, resource_id, date, from_time, to_time, reason, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(block.id, req.params.id, block.date, block.fromTime, block.toTime, block.reason, block.source, block.createdAt);
  res.json({ block });
});

catalogRouter.delete("/resources/:id/blocks/:blockId", requirePerm("sessions"), (req, res) => {
  db.prepare("DELETE FROM resource_blocks WHERE id = ? AND resource_id = ?").run(req.params.blockId, req.params.id);
  res.json({ ok: true });
});
