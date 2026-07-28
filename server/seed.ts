// Dev seed: a realistic Gosselin-style catalog so the app runs end-to-end in mock
// NAV mode. Idempotent — runs only when the stores table is empty.
import { db, uid, now, j } from "./db.js";

export function seedIfEmpty() {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM stores").get() as any).n;
  if (n > 0) {
    seedOperationalDemo();
    return;
  }

  const stores = [
    { code: "001", name: "Gosselin Québec", city: "Québec" },
    { code: "004", name: "Gosselin Sainte-Foy", city: "Québec" },
    { code: "091", name: "Gosselin Montréal", city: "Montréal" },
    { code: "012", name: "Gosselin Laval", city: "Laval" },
  ].map((s) => ({ id: uid(), ...s }));
  for (const s of stores) db.prepare("INSERT INTO stores (id, code, name, city) VALUES (?, ?, ?, ?)").run(s.id, s.code, s.name, s.city);

  const insertProduct = db.prepare(
    `INSERT INTO products (id, product_no, type, activity_type, name, name_fr, web_desc_en, web_desc_fr,
      duration_type, duration, default_unit_price, security_deposit, retail_item, available_on_web, min_qty, max_qty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  );
  const insertKit = db.prepare("INSERT INTO product_kit_items (id, product_id, item_no, description, qty) VALUES (?, ?, ?, ?, ?)");
  const insertPrice = db.prepare("INSERT INTO product_prices (id, product_id, description, price) VALUES (?, ?, ?, ?)");
  const insertQty = db.prepare("INSERT INTO product_store_qty (product_id, store_id, qty) VALUES (?, ?, ?)");

  const rentals: [string, string, string, number, number, number, string[][]][] = [
    // productNo, name EN, name FR, daily, weekly, deposit, kit [[itemNo, desc, qty]]
    ["RNT-D850", "Nikon D850 Body", "Nikon D850 Boîtier", 85, 425, 1500, [
      ["ACC-BAG01", "Padded camera bag", "1"], ["ACC-ENEL15", "EN-EL15 battery", "2"],
      ["ACC-CHG15", "MH-25a charger", "1"], ["ACC-CLEAN", "Cleaning kit", "1"], ["ACC-SD64", "64GB SD card", "1"]]],
    ["RNT-R5", "Canon EOS R5 Body", "Canon EOS R5 Boîtier", 110, 550, 2000, [
      ["ACC-BAG01", "Padded camera bag", "1"], ["ACC-LPE6", "LP-E6NH battery", "2"], ["ACC-CHGR5", "LC-E6 charger", "1"], ["ACC-CF128", "128GB CFexpress card", "1"]]],
    ["RNT-2470", "Canon RF 24-70mm f/2.8L", "Canon RF 24-70mm f/2.8L", 55, 275, 900, [
      ["ACC-LENSCAP", "Lens caps front/rear", "1"], ["ACC-HOOD247", "EW-88E lens hood", "1"], ["ACC-POUCH", "Lens pouch", "1"]]],
    ["RNT-FX3", "Sony FX3 Cinema Camera", "Sony FX3 Caméra Cinéma", 150, 750, 2500, [
      ["ACC-BAG02", "Video rig case", "1"], ["ACC-NPFZ100", "NP-FZ100 battery", "3"], ["ACC-CHGFZ", "Dual charger", "1"], ["ACC-XLR", "XLR handle unit", "1"], ["ACC-CF160", "160GB CFexpress A", "2"]]],
    ["RNT-TRIPOD", "Manfrotto 055 Tripod + Head", "Trépied Manfrotto 055 + rotule", 25, 125, 300, [
      ["ACC-PLATE", "Quick-release plate", "1"], ["ACC-TBAG", "Tripod bag", "1"]]],
    ["RNT-GODOX", "Godox AD600Pro Strobe Kit", "Kit flash Godox AD600Pro", 65, 325, 800, [
      ["ACC-STAND", "Light stand", "1"], ["ACC-SOFTBOX", "36\" softbox", "1"], ["ACC-TRIGGER", "X-Pro trigger", "1"], ["ACC-BATAD6", "WB87 battery", "2"]]],
  ];
  for (const [no, en, fr, daily, weekly, deposit, kit] of rentals) {
    const id = uid();
    insertProduct.run(id, no, "RENTAL", "RENTAL", en, fr,
      `Rent the ${en} by the day or week. Daily rate CA$${daily}.`, `Louez le ${fr} à la journée ou à la semaine.`,
      "Days", 1, daily, deposit, no.replace("RNT-", "LSR-"), 10, now());
    for (const [itemNo, desc, qty] of kit) insertKit.run(uid(), id, itemNo, desc, Number(qty));
    insertPrice.run(uid(), id, "DAILY", daily);
    insertPrice.run(uid(), id, "WEEKLY", weekly);
    for (const s of stores) insertQty.run(id, s.id, s.code === "091" ? 3 : 2);
  }

  const courses: [string, string, string, number, number][] = [
    // productNo, name EN, name FR, price, capacity
    ["CRS-INTRO", "Intro to Photography", "Initiation à la photographie", 129, 10],
    ["CRS-NIGHT", "Night Photography (3 evenings)", "Photo de nuit (3 soirées)", 249, 8],
    ["CRS-LIGHTROOM", "Lightroom Essentials", "Lightroom - les essentiels", 149, 12],
    ["CRS-VIDEO", "Video Fundamentals", "Fondements de la vidéo", 199, 8],
  ];
  const courseIds: Record<string, { id: string; capacity: number }> = {};
  for (const [no, en, fr, price, capacity] of courses) {
    const id = uid();
    insertProduct.run(id, no, "COURSE", "COURSE", en, fr,
      `${en} — hands-on class with a pro instructor.`, `${fr} — formation pratique avec un pro.`,
      "Hours", 3, price, 0, no.replace("CRS-", "LSC-"), 20, now());
    insertPrice.run(uid(), id, "STANDARD", price);
    courseIds[no] = { id, capacity };
  }

  // Rooms & trainers
  const mtl = stores.find((s) => s.code === "091")!;
  const qc = stores.find((s) => s.code === "001")!;
  const resources = [
    { type: "ROOM", name: "Studio A (Montréal)", store: mtl.id },
    { type: "ROOM", name: "Salle formation (Québec)", store: qc.id },
    { type: "TRAINER", name: "Marie Tremblay", store: mtl.id },
    { type: "TRAINER", name: "Jean-François Côté", store: qc.id },
    { type: "TRAINER", name: "Alex Nguyen", store: mtl.id },
  ].map((r) => ({ id: uid(), ...r }));
  for (const r of resources) db.prepare("INSERT INTO resources (id, type, name, store_id) VALUES (?, ?, ?, ?)").run(r.id, r.type, r.name, r.store);
  const room = (i: number) => resources.filter((r) => r.type === "ROOM")[i].id;
  const trainer = (i: number) => resources.filter((r) => r.type === "TRAINER")[i].id;

  // Sessions: singles + one 3-evening series (the "night photo over 3 Tuesdays" case)
  const insertSession = db.prepare(
    `INSERT INTO sessions (id, product_id, series_id, starts_at, ends_at, store_id, room_id, capacity, instance_no, instance_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTrainer = db.prepare("INSERT INTO session_trainers (session_id, resource_id) VALUES (?, ?)");
  // Session datetimes are stored store-local naive (like the datetime-local inputs
  // in the admin UI and storefront widget) so calendar-day queries stay in store time.
  const at = (daysAhead: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  };
  const single = (productNo: string, daysAhead: number, hour: number, dur: number, storeId: string, roomId: string, trainerId: string) => {
    const id = uid();
    const c = courseIds[productNo];
    insertSession.run(id, c.id, uid(), at(daysAhead, hour), at(daysAhead, hour + dur), storeId, roomId, c.capacity, 1, 1);
    insertTrainer.run(id, trainerId);
    return id;
  };
  single("CRS-INTRO", 0, 18, 3, mtl.id, room(0), trainer(0));
  single("CRS-INTRO", 9, 10, 3, qc.id, room(1), trainer(1));
  single("CRS-LIGHTROOM", 5, 13, 3, mtl.id, room(0), trainer(2));
  single("CRS-VIDEO", 12, 18, 3, mtl.id, room(0), trainer(2));
  {
    const seriesId = uid();
    const c = courseIds["CRS-NIGHT"];
    for (let i = 0; i < 3; i++) {
      const id = uid();
      insertSession.run(id, c.id, seriesId, at(7 + i * 7, 19), at(7 + i * 7, 22), mtl.id, room(0), c.capacity, i + 1, 3);
      insertTrainer.run(id, trainer(0));
    }
  }

  console.log("[seed] Seeded stores, rental catalog with kits, courses, resources & sessions.");
  seedOperationalDemo();
}

/** Adds an operationally useful demo fleet and bookings once. This is strictly
 * mock-mode data: live NAV tenants and explicitly disabled environments are
 * never touched. Existing customer/catalog records are preserved. */
function seedOperationalDemo() {
  if (process.env.BOOKING_SEED_DEMO === "false" || process.env.NAV_BASE_URL) return;
  const mode = db.prepare("SELECT value FROM settings WHERE key = 'navMode'").get() as { value: string } | undefined;
  if (mode?.value === "live") return;
  const marker = db.prepare("SELECT value FROM settings WHERE key = 'demoSeedVersion'").get() as { value: string } | undefined;
  if (Number(marker?.value || 0) >= 3) return;

  const stores = db.prepare("SELECT id, code FROM stores ORDER BY code").all() as { id: string; code: string }[];
  const rentals = db.prepare("SELECT id, product_no, name, default_unit_price, security_deposit FROM products WHERE type='RENTAL' ORDER BY product_no").all() as any[];
  if (!stores.length || !rentals.length) return;

  // Match the aggregate store quantities with individually traceable units.
  const addUnit = db.prepare(`INSERT OR IGNORE INTO rental_units
    (id, product_id, store_id, serial_no, barcode, status, condition, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, 'AVAILABLE', ?, ?, ?)`);
  for (const product of rentals) {
    for (const store of stores) {
      const q = db.prepare("SELECT qty FROM product_store_qty WHERE product_id=? AND store_id=?").get(product.id, store.id) as { qty: number } | undefined;
      for (let i = 1; i <= Math.min(q?.qty || 0, 3); i++) {
        const suffix = product.product_no.replace(/[^A-Z0-9]/gi, "").slice(-8);
        addUnit.run(uid(), product.id, store.id, `${suffix}-${store.code}-${String(i).padStart(3, "0")}`,
          `GOS-${store.code}-${suffix}-${String(i).padStart(3, "0")}`, i === 3 ? "FAIR" : "GOOD",
          i === 3 ? "Cosmetic wear; inspected and serviceable." : "", now());
      }
    }
  }

  const localAt = (days: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00:00`;
  };
  const customers = [
    ["amelie", "Amélie", "Roy", "514-555-0142"],
    ["marc", "Marc", "Gagnon", "418-555-0188"],
    ["sophie", "Sophie", "Lavoie", "450-555-0127"],
    ["noah", "Noah", "Williams", "514-555-0199"],
    ["studio", "Studio", "Nord", "514-555-0110"],
  ];
  const insertBooking = db.prepare(`INSERT OR IGNORE INTO bookings
    (id,ref,type,status,channel,store_id,customer_email,customer_first,customer_last,customer_phone,
     customer_b2b,subtotal,deposit,total,currency,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?, 'CAD',?,?,?)`);
  const insertLine = db.prepare(`INSERT INTO booking_lines
    (id,booking_id,type,product_no,product_name,session_id,store_id,date_from,date_to,qty,days,unit_price,line_total,deposit,status,checklist)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addEvent = db.prepare("INSERT INTO events (booking_id,type,detail,at) VALUES (?,?,?,?)");

  const demos = [
    { ref: "DEMO-PICKUP", status: "PAID", product: rentals[0], from: localAt(0, 10), to: localAt(2, 17), customer: 0, note: "Customer requested an extra battery." },
    { ref: "DEMO-RETURN", status: "PICKED_UP", product: rentals[1] || rentals[0], from: localAt(-2, 9), to: localAt(0, 11), customer: 1, note: "Inspect lens mount carefully on return." },
    { ref: "DEMO-FUTURE", status: "RESERVED", product: rentals[2] || rentals[0], from: localAt(1, 13), to: localAt(4, 13), customer: 2, note: "Web reservation awaiting payment." },
    { ref: "DEMO-B2B", status: "POS_PENDING", product: rentals[3] || rentals[0], from: localAt(0, 15), to: localAt(1, 15), customer: 4, b2b: true, note: "B2B pay-later account." },
  ];
  for (const demo of demos) {
    const existing = db.prepare("SELECT id FROM bookings WHERE ref=?").get(demo.ref) as { id: string } | undefined;
    if (existing) continue;
    const c = customers[demo.customer];
    const bookingId = uid();
    const lineId = uid();
    const qty = 1;
    const total = demo.product.default_unit_price * (demo.ref === "DEMO-FUTURE" ? 3 : 2);
    insertBooking.run(bookingId, demo.ref, "RENTAL", demo.status, demo.ref === "DEMO-FUTURE" ? "WEB" : "STAFF",
      stores[demo.customer % stores.length].id, `${c[0]}@example.com`, c[1], c[2], c[3], demo.b2b ? 1 : 0,
      total, demo.product.security_deposit, total, demo.note, localAt(-3, 12), now());
    const checklist = j([
      { itemNo: demo.product.product_no, description: `${demo.product.name} (main unit)`, qty, checked: demo.status === "PICKED_UP" },
      { itemNo: "ACC-BAG", description: "Protective case", qty, checked: demo.status === "PICKED_UP" },
      { itemNo: "ACC-POWER", description: "Battery and charger", qty, checked: false },
    ]);
    insertLine.run(lineId, bookingId, "RENTAL", demo.product.product_no, demo.product.name, null,
      stores[demo.customer % stores.length].id, demo.from, demo.to, qty, 2, demo.product.default_unit_price,
      total, demo.product.security_deposit, demo.status, checklist);
    addEvent.run(bookingId, "booking.created", j({ ref: demo.ref, channel: demo.ref === "DEMO-FUTURE" ? "WEB" : "STAFF" }), localAt(-3, 12));
    if (demo.status === "PAID") addEvent.run(bookingId, "booking.reconciled", j({ posTotal: total }), localAt(-1, 16));
    if (demo.status === "PICKED_UP") {
      const unit = db.prepare("SELECT id FROM rental_units WHERE product_id=? AND status='AVAILABLE' LIMIT 1").get(demo.product.id) as { id: string } | undefined;
      if (unit) {
        db.prepare("INSERT INTO booking_line_units (booking_line_id,unit_id,assigned_at) VALUES (?,?,?)").run(lineId, unit.id, localAt(-2, 9));
        db.prepare("UPDATE rental_units SET status='ON_RENT',updated_at=? WHERE id=?").run(now(), unit.id);
      }
      addEvent.run(bookingId, "booking.picked_up", j({ deposit: demo.product.security_deposit }), localAt(-2, 9));
    }
  }

  const session = db.prepare(`SELECT s.*,p.product_no,p.name,p.default_unit_price FROM sessions s
    JOIN products p ON p.id=s.product_id WHERE date(s.starts_at)=date(?) ORDER BY s.starts_at LIMIT 1`).get(localAt(0, 0)) as any;
  if (session && !db.prepare("SELECT 1 FROM bookings WHERE ref='DEMO-CLASS'").get()) {
    const bookingId = uid();
    const c = customers[3];
    insertBooking.run(bookingId, "DEMO-CLASS", "COURSE", "PAID", "WEB", session.store_id,
      `${c[0]}@example.com`, c[1], c[2], c[3], 0, session.default_unit_price, 0,
      session.default_unit_price, "First-time attendee; bilingual materials preferred.", localAt(-5, 10), now());
    insertLine.run(uid(), bookingId, "COURSE", session.product_no, session.name, session.id, session.store_id,
      session.starts_at, session.ends_at, 1, null, session.default_unit_price, session.default_unit_price, 0, "PAID", "[]");
    addEvent.run(bookingId, "booking.created", j({ ref: "DEMO-CLASS", channel: "WEB" }), localAt(-5, 10));
  }

  const spanish: Record<string, [string, string]> = {
    "RNT-D850": ["Cuerpo Nikon D850", "Cámara réflex profesional de alta resolución, ideal para retratos, eventos y fotografía comercial. Incluye bolsa protectora, baterías, cargador, tarjeta de memoria y kit de limpieza."],
    "RNT-R5": ["Cuerpo Canon EOS R5", "Cámara híbrida profesional de fotograma completo para fotografía de alta resolución y vídeo 8K. El kit incluye baterías, cargador, tarjeta CFexpress y bolsa protectora."],
    "RNT-2470": ["Canon RF 24-70 mm f/2.8L", "Objetivo zoom profesional luminoso para reportajes, retratos y eventos. Incluye tapas, parasol y funda acolchada."],
    "RNT-FX3": ["Cámara de cine Sony FX3", "Cámara de cine compacta de fotograma completo para producciones profesionales. Incluye asa XLR, baterías, cargador, tarjetas y estuche de transporte."],
    "RNT-TRIPOD": ["Trípode Manfrotto 055 con rótula", "Trípode estable de uso profesional con rótula y placa de liberación rápida. Adecuado para fotografía de estudio, paisaje y vídeo."],
    "RNT-GODOX": ["Kit de flash Godox AD600Pro", "Kit de iluminación portátil de alta potencia con soporte, softbox, disparador y baterías. Ideal para retratos en estudio o exteriores."],
    "CRS-INTRO": ["Introducción a la fotografía", "Curso práctico para dominar exposición, enfoque, composición y controles manuales. Diseñado para principiantes con cualquier cámara de objetivos intercambiables."],
    "CRS-NIGHT": ["Fotografía nocturna — 3 sesiones", "Programa de tres sesiones sobre exposición nocturna, trípode, enfoque en poca luz, estelas luminosas y edición de imágenes."],
    "CRS-LIGHTROOM": ["Fundamentos de Lightroom", "Flujo de trabajo práctico para importar, organizar, corregir color, editar y exportar fotografías con Adobe Lightroom."],
    "CRS-VIDEO": ["Fundamentos de vídeo", "Introducción práctica a velocidad de obturación, frecuencia de imagen, sonido, iluminación, composición y configuración de cámara para vídeo."],
  };
  const upsertTranslation = db.prepare(`INSERT INTO product_translations(product_id,locale,name,description)
    VALUES(?,?,?,?) ON CONFLICT(product_id,locale) DO UPDATE SET
    name=CASE WHEN product_translations.name='' THEN excluded.name ELSE product_translations.name END,
    description=CASE WHEN product_translations.description='' THEN excluded.description ELSE product_translations.description END`);
  for (const [productNo, [name, description]] of Object.entries(spanish)) {
    const product = db.prepare("SELECT id FROM products WHERE product_no=?").get(productNo) as { id: string } | undefined;
    if (product) upsertTranslation.run(product.id, "es", name, description);
  }

  db.prepare("INSERT INTO settings(key,value) VALUES('demoSeedVersion','3') ON CONFLICT(key) DO UPDATE SET value='3'").run();
  console.log("[seed] Added fleet, operational bookings, and multilingual catalog content.");
}
