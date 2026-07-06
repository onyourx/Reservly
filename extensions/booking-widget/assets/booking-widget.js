// Storefront booking widget: talks to the middleware through the Shopify App Proxy
// (/apps/booking/* → server /proxy/*, signature-verified server-side).
(function () {
  var root = document.querySelector(".gsl-booking");
  if (!root) return;
  var proxy = root.dataset.proxy;
  var type = root.dataset.type;
  var productNo = root.dataset.productNo;
  var addBtn = root.querySelector(".gsl-add");
  var form = root.querySelector(".gsl-add-form");

  function get(path, params) {
    var q = new URLSearchParams(params || {});
    return fetch(proxy + path + "?" + q.toString(), { headers: { accept: "application/json" } }).then(function (r) {
      return r.json();
    });
  }
  function money(n) { return "CA$" + Number(n).toFixed(2); }

  if (type === "RENTAL") {
    var storeSel = root.querySelector(".gsl-store");
    var fromEl = root.querySelector(".gsl-from");
    var toEl = root.querySelector(".gsl-to");
    var quoteBox = root.querySelector(".gsl-quote");

    get("/stores").then(function (d) {
      storeSel.innerHTML = (d.stores || [])
        .map(function (s) { return '<option value="' + s.id + '">' + s.name + "</option>"; })
        .join("");
      refresh();
    });

    function refresh() {
      addBtn.disabled = true;
      quoteBox.hidden = true;
      if (!storeSel.value || !fromEl.value || !toEl.value) return;
      Promise.all([
        get("/quote", { productNo: productNo, storeId: storeSel.value, from: fromEl.value, to: toEl.value, qty: 1 }),
        get("/availability", { productNo: productNo, storeId: storeSel.value, from: fromEl.value, to: toEl.value }),
      ]).then(function (res) {
        var quote = res[0], avail = res[1];
        if (quote.error) return;
        var line = quote.lines[0];
        quoteBox.hidden = false;
        root.querySelector(".gsl-days").textContent = line.days + (line.days > 1 ? " days" : " day");
        root.querySelector(".gsl-price").textContent = money(line.lineTotal);
        root.querySelector(".gsl-deposit").textContent = line.deposit ? " + " + money(line.deposit) + " refundable deposit (in store)" : "";
        var ok = !!avail.available;
        root.querySelector(".gsl-avail").textContent = ok ? "✓ Available at this store" : "✗ Not available for these dates";
        root.querySelector(".gsl-avail").className = "gsl-avail " + (ok ? "ok" : "no");
        if (ok) {
          addBtn.disabled = false;
          root.querySelector(".gsl-p-store").value = storeSel.value;
          root.querySelector(".gsl-p-from").value = fromEl.value;
          root.querySelector(".gsl-p-to").value = toEl.value;
          root.querySelector(".gsl-p-label").value = line.days + " day rental, pickup " + fromEl.value.replace("T", " ");
        }
      });
    }
    [storeSel, fromEl, toEl].forEach(function (el) { el.addEventListener("change", refresh); });
  } else {
    var slotsBox = root.querySelector(".gsl-slots");
    get("/sessions", { productNo: productNo }).then(function (d) {
      var slots = d.slots || [];
      if (!slots.length) { slotsBox.innerHTML = "<em>No upcoming sessions — check back soon.</em>"; return; }
      slotsBox.innerHTML = slots
        .map(function (s) {
          var series = s.instanceCount > 1 ? " (session 1 of " + s.instanceCount + " — series)" : "";
          return '<label class="gsl-slot"><input type="radio" name="gsl-slot" value="' + s.sessionId + '" data-label="' +
            s.date + " " + s.time + " @ " + s.location + '">' +
            "<span>" + s.date + " " + s.time + " · " + s.location + series + " · " + s.remaining + " seats left</span></label>";
        })
        .join("");
      slotsBox.addEventListener("change", function (e) {
        var r = e.target;
        root.querySelector(".gsl-p-session").value = r.value;
        root.querySelector(".gsl-p-label").value = r.dataset.label;
        addBtn.disabled = false;
      });
    });
  }

  form.addEventListener("submit", function () {
    addBtn.textContent = "Adding…";
  });
})();
