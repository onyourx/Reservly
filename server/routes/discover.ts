import { Router } from "express";
import { db, getSettings } from "../db.js";
import { rentalAvailability, courseSlots } from "../engine/availability.js";

export const discoverRouter = Router();
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]!));

discoverRouter.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Find availability</title><style>
  body{font:15px/1.5 system-ui;margin:0;background:#f7f8fa;color:#18202b}.wrap{max-width:980px;margin:auto;padding:30px 18px}
  h1{font-size:30px}form,.result{background:#fff;border:1px solid #e0e4e9;border-radius:14px;padding:18px;margin:14px 0}
  form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;align-items:end}
  label{font-size:12px;font-weight:700}input,select,button{display:block;width:100%;box-sizing:border-box;padding:11px;border:1px solid #cbd2da;border-radius:8px;margin-top:5px}
  button{background:#12a46b;color:#fff;border:0;font-weight:700;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
  .result h2{font-size:18px;margin:0 0 6px}.muted{color:#647080}.tag{font-size:11px;background:#e4f6ee;color:#08764c;padding:3px 7px;border-radius:20px}
  </style></head><body><div class="wrap"><h1>Find an available booking</h1><p class="muted">Search rentals, classes, and experiences by date.</p>
  <form id="f"><label>From<input id="from" type="date" required></label><label>To<input id="to" type="date" required></label>
  <label>Store<select id="store"><option value="">All locations</option></select></label><label>Type<select id="type"><option value="">Everything</option><option value="RENTAL">Rentals</option><option value="COURSE">Classes & events</option></select></label>
  <button>Search availability</button></form><div id="status"></div><div id="results" class="grid"></div></div><script>
  const iso=new Date().toISOString().slice(0,10);from.value=iso;to.value=iso;
  fetch("/discover/stores").then(r=>r.json()).then(d=>d.stores.forEach(s=>store.add(new Option(s.name+(s.city?" — "+s.city:""),s.id))));
  f.onsubmit=e=>{e.preventDefault();status.textContent="Searching…";results.innerHTML="";
    const q=new URLSearchParams({from:from.value,to:to.value,storeId:store.value,type:type.value});
    fetch("/discover/search?"+q).then(r=>r.json()).then(d=>{status.textContent=d.results.length?d.results.length+" available":"No availability found";
      d.results.forEach(x=>{const el=document.createElement("article");el.className="result";
        el.innerHTML="<span class=tag>"+(x.type==="RENTAL"?"Rental":"Class / event")+"</span><h2>"+x.name+"</h2><div class=muted>"+(x.type==="RENTAL"?x.available+" available":x.slots.length+" upcoming time(s)")+"</div>"+(x.shopUrl?"<p><a href='"+x.shopUrl+"'>View in store →</a></p>":"");results.appendChild(el)})}).catch(e=>status.textContent=e.message)}
  </script></body></html>`);
});

discoverRouter.get("/stores", (_req, res) => {
  res.json({ stores: db.prepare("SELECT id,name,city FROM stores ORDER BY name").all() });
});

discoverRouter.get("/search", async (req, res) => {
  const { from, to, storeId, type } = req.query as Record<string, string>;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });
  let sql = `SELECT p.*,q.store_id FROM products p LEFT JOIN product_store_qty q ON q.product_id=p.id WHERE p.available_on_web=1`;
  const params: unknown[] = [];
  if (type) { sql += " AND p.type=?"; params.push(type); }
  if (storeId) { sql += " AND (q.store_id=? OR p.type='COURSE')"; params.push(storeId); }
  const products = db.prepare(sql + " ORDER BY p.name").all(...params) as any[];
  const results: any[] = [];
  const shop = getSettings().shopifyShop?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  for (const p of products) {
    const shopUrl = shop ? `https://${esc(shop)}/search?q=${encodeURIComponent(p.name)}` : "";
    if (p.type === "RENTAL" && p.store_id) {
      const a = await rentalAvailability(p.product_no, p.store_id, from, to);
      if (a.available) results.push({ type: p.type, productNo: p.product_no, name: p.name, storeId: p.store_id, available: Math.min(...a.perDay.map((d) => d.qty)), shopUrl });
    } else if (p.type === "COURSE") {
      const days = Math.max(1, Math.ceil((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1);
      const slots = courseSlots(p.product_no, `${from}T00:00:00.000Z`, days).filter((s) => !storeId || s.storeId === storeId);
      if (slots.length) results.push({ type: p.type, productNo: p.product_no, name: p.name, slots, shopUrl });
    }
  }
  res.json({ results });
});
