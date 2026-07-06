// Dev seed: a realistic Gosselin-style catalog so the app runs end-to-end in mock
// NAV mode. Idempotent — runs only when the stores table is empty.
import { db, uid, now } from "./db.js";

export function seedIfEmpty() {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM stores").get() as any).n;
  if (n > 0) return;

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
}
