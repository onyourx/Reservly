// Public e-signature flow: the customer opens the one-time link from their
// confirmation email (or texted by staff) and signs the rental contract on
// their phone. No staff auth here — the unguessable token IS the credential.
import { Router } from "express";
import { db, now, auditLog } from "../db.js";
import { serializeBooking } from "../lib/bookingService.js";
import { emit } from "../lib/events.js";
import { contractBody, page } from "./print.js";

export const signRouter = Router();

function bookingByToken(token: string) {
  if (!token || token.length < 20) return null;
  const row = db.prepare("SELECT id FROM bookings WHERE sign_token = ?").get(token) as any;
  return row ? serializeBooking(row.id) : null;
}

signRouter.get("/:token", (req, res) => {
  const b = bookingByToken(req.params.token);
  if (!b) return res.status(404).send(page("Link expired", "<h1>Link expired</h1><p>This signing link is no longer valid. Please contact the store.</p>"));
  if (b.contractSignedAt) return res.send(page("Already signed", `<h1>All set!</h1><p>This contract was signed on ${new Date(b.contractSignedAt).toLocaleString("en-CA")}. See you at pick-up.</p>`));

  const padUi = `
    <h2>Sign here</h2>
    <p class="small">By signing you agree to the rental terms above.</p>
    <input type="text" id="sig-name" placeholder="Your full name"
      value="${(b.customer.firstName + " " + b.customer.lastName).trim().replace(/"/g, "&quot;")}"
      style="width:100%;padding:12px;font-size:16px;border:1px solid #ccc;border-radius:8px;margin-bottom:10px">
    <canvas id="sig-pad" width="640" height="220"
      style="width:100%;height:180px;border:2px dashed #bbb;border-radius:10px;touch-action:none;background:#fff"></canvas>
    <div style="display:flex;gap:10px;margin-top:12px">
      <button id="sig-clear" style="flex:1;padding:14px;border:1px solid #ccc;border-radius:10px;background:#fff;font-size:15px">Clear</button>
      <button id="sig-submit" style="flex:2;padding:14px;border:0;border-radius:10px;background:#1f4fd8;color:#fff;font-size:15px;font-weight:700" disabled>Sign contract</button>
    </div>
    <p id="sig-status" class="small"></p>
    <script>
    (function () {
      var canvas = document.getElementById("sig-pad");
      var ctx = canvas.getContext("2d");
      ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#1a1a2e";
      var drawing = false, hasInk = false;
      var submit = document.getElementById("sig-submit");
      function pos(e) {
        var r = canvas.getBoundingClientRect();
        var p = e.touches ? e.touches[0] : e;
        return { x: (p.clientX - r.left) * (canvas.width / r.width), y: (p.clientY - r.top) * (canvas.height / r.height) };
      }
      function start(e) { drawing = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
      function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); hasInk = true; submit.disabled = false; e.preventDefault(); }
      function end() { drawing = false; }
      canvas.addEventListener("pointerdown", start); canvas.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      document.getElementById("sig-clear").onclick = function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; submit.disabled = true;
      };
      submit.onclick = function () {
        if (!hasInk) return;
        submit.disabled = true; submit.textContent = "Sending…";
        fetch(location.pathname, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: document.getElementById("sig-name").value, image: canvas.toDataURL("image/png") }),
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) { document.body.innerHTML = "<h1 style='font-family:sans-serif;text-align:center;margin-top:80px'>Thank you! ✓</h1><p style='text-align:center;font-family:sans-serif'>Your contract is signed. See you at pick-up.</p>"; }
          else { document.getElementById("sig-status").textContent = d.error || "Something went wrong"; submit.disabled = false; submit.textContent = "Sign contract"; }
        });
      };
    })();
    </script>`;
  res.send(page(`Sign contract ${b.ref}`, contractBody(b) + padUi));
});

signRouter.post("/:token", (req, res) => {
  const b = bookingByToken(req.params.token);
  if (!b) return res.status(404).json({ error: "This signing link is no longer valid" });
  if (b.contractSignedAt) return res.json({ ok: true });
  const { name, image } = req.body ?? {};
  if (typeof image !== "string" || !image.startsWith("data:image/png;base64,") || image.length > 400_000) {
    return res.status(400).json({ error: "Invalid signature image" });
  }
  db.prepare(
    "UPDATE bookings SET signature_png = ?, signature_name = ?, contract_signed_at = ?, sign_token = '', updated_at = ? WHERE id = ?",
  ).run(image, String(name ?? "").slice(0, 120), now(), now(), b.id);
  emit(b.id, "booking.contract_signed", { name: String(name ?? ""), email: b.customer.email });
  auditLog("signature.completed", b.ref, b.customer.email, "customer");
  res.json({ ok: true });
});
