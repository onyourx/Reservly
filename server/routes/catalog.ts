import { Router } from "express";
import { db, uid, now } from "../db.js";
import { getActivityTypes, getActivityProducts, navMode } from "../lib/nav.js";
import { ensureMetafieldDefinitions, pushProductToShopify } from "../lib/shopifyAdmin.js";
import { emit } from "../lib/events.js";
import { sessionBooked } from "../engine/availability.js";

export const catalogRouter = Router();

catalogRouter.get("/stores", (_req, res) => {
  res.json({ stores: db.prepare("SELECT * FROM stores ORDER BY name").all() });
});

function serializeProduct(p: any) {
  return {
    id: p.id, productNo: p.product_no, type: p.type, activityType: p.activity_type,
    name: p.name, nameFr: p.name_fr, webDescEn: p.web_desc_en, webDescFr: p.web_desc_fr,
    imageUrl: p.image_url, durationType: p.duration_type, duration: p.duration,
    defaultUnitPrice: p.default_unit_price, securityDeposit: p.security_deposit,
    retailItem: p.retail_item, fixedLocation: p.fixed_location,
    availableOnWeb: !!p.available_on_web, minQty: p.min_qty, maxQty: p.max_qty,
    shopifyProductId: p.shopify_product_id,
    kit: db.prepare("SELECT item_no AS itemNo, description, qty FROM product_kit_items WHERE product_id = ?").all(p.id),
    prices: db.prepare("SELECT description, price FROM product_prices WHERE product_id = ?").all(p.id),
    storeQty: db.prepare("SELECT store_id AS storeId, qty FROM product_store_qty WHERE product_id = ?").all(p.id),
  };
}

catalogRouter.get("/products", (req, res) => {
  const { type, q } = req.query as Record<string, string>;
  let sql = "SELECT * FROM products WHERE 1=1";
  const params: unknown[] = [];
  if (type) { sql += " AND type = ?"; params.push(type); }
  if (q) { sql += " AND (name LIKE ? OR product_no LIKE ?)"; params.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY type, name";
  res.json({ products: (db.prepare(sql).all(...params) as any[]).map(serializeProduct) });
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

catalogRouter.put("/products/:id", (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  const { imageUrl, webDescEn, webDescFr, kit, shopifyProductId, availableOnWeb } = req.body ?? {};
  db.prepare(
    `UPDATE products SET image_url = COALESCE(?, image_url), web_desc_en = COALESCE(?, web_desc_en),
     web_desc_fr = COALESCE(?, web_desc_fr), shopify_product_id = COALESCE(?, shopify_product_id),
     available_on_web = COALESCE(?, available_on_web), updated_at = ? WHERE id = ?`,
  ).run(imageUrl ?? null, webDescEn ?? null, webDescFr ?? null, shopifyProductId ?? null,
    availableOnWeb == null ? null : availableOnWeb ? 1 : 0, now(), p.id);
  if (Array.isArray(kit)) {
    db.prepare("DELETE FROM product_kit_items WHERE product_id = ?").run(p.id);
    const ins = db.prepare("INSERT INTO product_kit_items (id, product_id, item_no, description, qty) VALUES (?, ?, ?, ?, ?)");
    for (const k of kit) ins.run(uid(), p.id, String(k.itemNo ?? ""), String(k.description ?? ""), Number(k.qty) || 1);
  }
  res.json({ product: serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)) });
});

/** Pull the activity catalog from NAV (R0 / class step 2: NAV → app → Shopify). */
catalogRouter.post("/products/sync", async (_req, res) => {
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
catalogRouter.post("/products/:id/push-shopify", async (req, res) => {
  const p = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id) as any;
  if (!p) return res.status(404).json({ error: "Product not found" });
  try {
    if (!metafieldDefsEnsured) {
      await ensureMetafieldDefinitions();
      metafieldDefsEnsured = true;
    }
    const result = await pushProductToShopify(p);
    db.prepare("UPDATE products SET shopify_product_id = ?, updated_at = ? WHERE id = ?").run(result.id, now(), p.id);
    emit(null, "shopify.product_pushed", { productNo: p.product_no, shopifyProductId: result.id });
    res.json({
      product: serializeProduct(db.prepare("SELECT * FROM products WHERE id = ?").get(p.id)),
      shopifyProductId: result.id,
      handle: result.handle,
    });
  } catch (err) {
    res.status(502).json({ error: String((err as Error).message ?? err) });
  }
});

// --- Sessions (course instances) -------------------------------------------

function serializeSession(s: any) {
  return {
    id: s.id, productId: s.product_id, seriesId: s.series_id, startsAt: s.starts_at, endsAt: s.ends_at,
    storeId: s.store_id, roomId: s.room_id, capacity: s.capacity, booked: sessionBooked(s.id),
    instanceNo: s.instance_no, instanceCount: s.instance_count,
    trainerIds: (db.prepare("SELECT resource_id FROM session_trainers WHERE session_id = ?").all(s.id) as any[]).map((t) => t.resource_id),
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
catalogRouter.post("/sessions", (req, res) => {
  const { productId, startsAt, endsAt, storeId, roomId, trainerIds = [], capacity = 8, occurrences = 1, intervalDays = 7 } = req.body ?? {};
  if (!productId || !startsAt || !endsAt || !storeId) return res.status(400).json({ error: "productId, startsAt, endsAt, storeId are required" });
  const seriesId = uid();
  const n = Math.max(1, Math.min(12, Number(occurrences) || 1));
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const offset = i * (Number(intervalDays) || 7) * 86_400_000;
    const id = uid();
    db.prepare(
      `INSERT INTO sessions (id, product_id, series_id, starts_at, ends_at, store_id, room_id, capacity, instance_no, instance_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, productId, seriesId,
      new Date(new Date(startsAt).getTime() + offset).toISOString(),
      new Date(new Date(endsAt).getTime() + offset).toISOString(),
      storeId, roomId ?? null, Number(capacity) || 8, i + 1, n,
    );
    for (const t of trainerIds) db.prepare("INSERT OR IGNORE INTO session_trainers (session_id, resource_id) VALUES (?, ?)").run(id, t);
    out.push(serializeSession(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)));
  }
  res.json({ sessions: out });
});

catalogRouter.delete("/sessions/:id", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// --- Resources (rooms & trainers, class step 3A/3B) --------------------------

catalogRouter.get("/resources", (req, res) => {
  const { type } = req.query as Record<string, string>;
  const rows = type
    ? db.prepare("SELECT * FROM resources WHERE type = ? ORDER BY name").all(type)
    : db.prepare("SELECT * FROM resources ORDER BY type, name").all();
  res.json({ resources: (rows as any[]).map((r) => ({ id: r.id, type: r.type, name: r.name, storeId: r.store_id, notes: r.notes })) });
});

catalogRouter.post("/resources", (req, res) => {
  const { type, name, storeId, notes = "" } = req.body ?? {};
  if (!type || !name) return res.status(400).json({ error: "type and name are required" });
  const id = uid();
  db.prepare("INSERT INTO resources (id, type, name, store_id, notes) VALUES (?, ?, ?, ?, ?)").run(id, type, name, storeId ?? null, notes);
  res.json({ resource: { id, type, name, storeId, notes } });
});

catalogRouter.delete("/resources/:id", (req, res) => {
  db.prepare("DELETE FROM resources WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/** Bulk availability upload (class step 3B: trainers' schedules come in as CSV). */
catalogRouter.post("/resources/:id/availability", (req, res) => {
  const slots: { date: string; from: string; to: string }[] = req.body?.slots ?? [];
  const ins = db.prepare("INSERT INTO resource_availability (id, resource_id, date, from_time, to_time) VALUES (?, ?, ?, ?, ?)");
  let added = 0;
  for (const s of slots) {
    if (!s.date || !s.from || !s.to) continue;
    ins.run(uid(), req.params.id, s.date, s.from, s.to);
    added++;
  }
  res.json({ added });
});

catalogRouter.get("/resources/:id/availability", (req, res) => {
  const { from, to } = req.query as Record<string, string>;
  let sql = "SELECT date, from_time AS \"from\", to_time AS \"to\" FROM resource_availability WHERE resource_id = ?";
  const params: unknown[] = [req.params.id];
  if (from) { sql += " AND date >= ?"; params.push(from); }
  if (to) { sql += " AND date <= ?"; params.push(to); }
  sql += " ORDER BY date LIMIT 500";
  res.json({ slots: db.prepare(sql).all(...params) });
});
