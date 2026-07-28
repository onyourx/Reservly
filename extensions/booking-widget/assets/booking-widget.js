// Storefront booking widget. Talks to the middleware through the Shopify App
// Proxy (/apps/booking/* → server /proxy/*, signature-verified server-side).
// Self-contained: no external libraries.
(function () {
  var root = document.querySelector(".gsl-booking");
  if (!root) return;
  var proxy = root.dataset.proxy;
  var type = root.dataset.type;
  var productNo = root.dataset.productNo;
  var addBtn = root.querySelector(".gsl-add");
  var form = root.querySelector(".gsl-add-form");
  var configuredAddons = [];

  function get(path, params) {
    var q = new URLSearchParams(params || {});
    return fetch(proxy + path + "?" + q.toString(), { headers: { accept: "application/json" } }).then(function (r) {
      // A non-JSON reply means the app proxy isn't reaching the booking server
      // (wrong proxy URL, tunnel down) — fail loudly instead of hanging.
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("json") === -1) throw new Error("booking service unreachable (HTTP " + r.status + ")");
      return r.json();
    });
  }
  function post(path, body) {
    return fetch(proxy + path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      });
    });
  }
  function showError(msg) {
    var el = document.createElement("div");
    el.className = "gsl-error";
    el.textContent = msg;
    root.insertBefore(el, form);
    addBtn.disabled = true;
  }
  function offerWaitlist(details) {
    if (root.querySelector(".gsl-waitlist")) return;
    var box = document.createElement("div");
    box.className = "gsl-waitlist";
    box.innerHTML = '<strong>Fully booked?</strong><span> Join the waitlist and we’ll let you know when space opens.</span>' +
      '<button type="button">Join waitlist</button>';
    box.querySelector("button").onclick = function () {
      var name = window.prompt("Your name") || "";
      var email = window.prompt("Email address") || "";
      if (!email) return;
      box.querySelector("button").disabled = true;
      post("/waitlist", Object.assign({ productNo: productNo, name: name, email: email }, details || {}))
        .then(function () { box.innerHTML = "<strong>✓ You’re on the waitlist.</strong> We’ll contact you when availability opens."; })
        .catch(function (e) { box.querySelector("button").disabled = false; window.alert(e.message); });
    };
    form.parentNode.insertBefore(box, form);
  }
  function renderAddons() {
    get("/addons", { productNo: productNo }).then(function (d) {
      configuredAddons = (d.addons || []).filter(function (a) { return a.shopifyVariantId; });
      if (!configuredAddons.length) return;
      var box = document.createElement("div");
      box.className = "gsl-addons";
      box.innerHTML = "<strong>Enhance your booking</strong>";
      configuredAddons.forEach(function (addon, index) {
        var row = document.createElement("label");
        row.className = "gsl-addon";
        row.innerHTML = '<input type="checkbox" data-addon="' + index + '"' + (addon.required ? " checked disabled" : "") + ">" +
          '<span>' + addon.name + '<small>+' + money(addon.price) + "</small></span>" +
          (addon.maxQty > 1 ? '<input type="number" class="gsl-addon-qty" min="1" max="' + addon.maxQty + '" value="1">' : "");
        box.appendChild(row);
      });
      form.parentNode.insertBefore(box, form);
    }).catch(function () {});
  }
  function selectedAddonItems() {
    return Array.prototype.slice.call(root.querySelectorAll(".gsl-addon")).filter(function (row) {
      return row.querySelector('input[type="checkbox"]').checked;
    }).map(function (row) {
      var addon = configuredAddons[Number(row.querySelector("[data-addon]").dataset.addon)];
      var qty = row.querySelector(".gsl-addon-qty");
      return {
        id: Number(addon.shopifyVariantId), quantity: qty ? Number(qty.value) || 1 : 1,
        properties: { _booking_addon_for: productNo, _addon_product_no: addon.productNo },
      };
    });
  }
  function cartProperties() {
    var result = {};
    Array.prototype.slice.call(form.querySelectorAll('input[name^="properties["]')).forEach(function (input) {
      var key = input.name.slice(11, -1);
      if (input.value) result[key] = input.value;
    });
    return result;
  }
  function submitCart() {
    var extras = selectedAddonItems();
    if (!extras.length) { submitting = true; form.submit(); return; }
    var main = {
      id: Number(form.querySelector('input[name="id"]').value),
      quantity: Number(form.querySelector('input[name="quantity"]').value) || 1,
      properties: cartProperties(),
    };
    fetch(window.Shopify && Shopify.routes ? Shopify.routes.root + "cart/add.js" : "/cart/add.js", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ items: [main].concat(extras) }),
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d.description || "Could not add booking"); });
      window.location.href = "/cart";
    }).catch(function (e) {
      addBtn.disabled = false; addBtn.textContent = "Try again"; showError(e.message);
    });
  }
  function money(n) {
    return "CA$" + Number(n).toFixed(2);
  }
  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function iso(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  // ---------------------------------------------------------------- rentals --
  if (type === "RENTAL") {
    var storeSel = root.querySelector(".gsl-store");
    var quoteBox = root.querySelector(".gsl-quote");
    var calTitle = root.querySelector(".gsl-cal-title");
    var calGrid = root.querySelector(".gsl-cal-grid");
    var calDow = root.querySelector(".gsl-cal-dow");
    var calHint = root.querySelector(".gsl-cal-hint");
    var timeFrom = root.querySelector(".gsl-time-from");
    var timeTo = root.querySelector(".gsl-time-to");

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var view = new Date(today.getFullYear(), today.getMonth(), 1);
    var start = null; // "YYYY-MM-DD"
    var end = null;
    var availCache = {}; // "storeId|YYYY-MM" -> { "YYYY-MM-DD": qty }

    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (d) {
      var el = document.createElement("span");
      el.textContent = d;
      calDow.appendChild(el);
    });
    ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"].forEach(function (t) {
      timeFrom.add(new Option(t, t));
      timeTo.add(new Option(t, t));
    });
    timeFrom.value = "10:00";
    timeTo.value = "17:00";

    function monthAvailability(cb) {
      if (!storeSel.value) return cb({});
      var key = storeSel.value + "|" + view.getFullYear() + "-" + pad(view.getMonth() + 1);
      if (availCache[key]) return cb(availCache[key]);
      var first = new Date(view.getFullYear(), view.getMonth(), 1);
      var last = new Date(view.getFullYear(), view.getMonth() + 1, 0);
      get("/availability", { productNo: productNo, storeId: storeSel.value, from: iso(first), to: iso(last) })
        .then(function (d) {
          var map = {};
          (d.perDay || []).forEach(function (p) {
            map[p.date] = p.qty;
          });
          availCache[key] = map;
          cb(map);
        })
        .catch(function () {
          cb({});
        });
    }

    function renderCalendar() {
      calTitle.textContent = view.toLocaleDateString("en-CA", { month: "long", year: "numeric" });
      monthAvailability(function (avail) {
        calGrid.innerHTML = "";
        var firstDow = new Date(view.getFullYear(), view.getMonth(), 1).getDay();
        var daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
        for (var i = 0; i < firstDow; i++) calGrid.appendChild(document.createElement("span"));
        for (var day = 1; day <= daysInMonth; day++) {
          var date = new Date(view.getFullYear(), view.getMonth(), day);
          var dstr = iso(date);
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = String(day);
          btn.dataset.date = dstr;
          var isPast = date < today;
          var soldOut = storeSel.value && avail[dstr] === 0;
          if (isPast || soldOut) {
            btn.disabled = true;
            if (soldOut) btn.classList.add("gsl-soldout");
          }
          if (dstr === start) btn.classList.add("gsl-sel-start");
          if (dstr === end) btn.classList.add("gsl-sel-end");
          if (start && end && dstr > start && dstr < end) btn.classList.add("gsl-in-range");
          if (dstr === iso(today)) btn.classList.add("gsl-today");
          btn.addEventListener("click", onDayClick);
          calGrid.appendChild(btn);
        }
      });
    }

    function onDayClick(e) {
      var d = e.currentTarget.dataset.date;
      if (!start || (start && end) || d < start) {
        start = d;
        end = null;
        calHint.textContent = "Now select the return day";
      } else if (d === start) {
        end = d; // same-day rental = 1 day
        calHint.textContent = "";
      } else {
        end = d;
        calHint.textContent = "";
      }
      renderCalendar();
      refreshQuote();
    }

    function selection() {
      if (!start || !end || !storeSel.value) return null;
      return {
        from: start + "T" + timeFrom.value + ":00",
        to: end + "T" + timeTo.value + ":00",
      };
    }

    function refreshQuote() {
      var sel = selection();
      addBtn.disabled = true;
      addBtn.textContent = "Select dates to book";
      quoteBox.hidden = true;
      if (!sel) return;
      Promise.all([
        get("/quote", { productNo: productNo, storeId: storeSel.value, from: sel.from, to: sel.to, qty: 1 }),
        get("/availability", { productNo: productNo, storeId: storeSel.value, from: sel.from, to: sel.to }),
      ]).then(function (res) {
        var quote = res[0], avail = res[1];
        if (quote.error || !quote.lines) return;
        var line = quote.lines[0];
        quoteBox.hidden = false;
        root.querySelector(".gsl-days").textContent =
          line.days + (line.days > 1 ? " days" : " day") + " · pick up " + start + " " + timeFrom.value;
        root.querySelector(".gsl-price").textContent = money(line.lineTotal);
        root.querySelector(".gsl-deposit").textContent = line.deposit
          ? "+ " + money(line.deposit) + " refundable deposit, taken at pick-up"
          : "";
        var ok = !!avail.available;
        var availEl = root.querySelector(".gsl-avail");
        availEl.textContent = ok ? "✓ Available at this store" : "✗ Not available for these dates";
        availEl.className = "gsl-avail " + (ok ? "ok" : "no");
        if (ok) {
          addBtn.disabled = false;
          addBtn.textContent = "Add booking to cart — " + money(line.lineTotal);
          root.querySelector(".gsl-p-store").value = storeSel.value;
          root.querySelector(".gsl-p-from").value = sel.from;
          root.querySelector(".gsl-p-to").value = sel.to;
          root.querySelector(".gsl-p-label").value =
            line.days + "-day rental · " + start + " " + timeFrom.value + " → " + end + " " + timeTo.value;
        } else {
          offerWaitlist({ storeId: storeSel.value, from: sel.from, to: sel.to, qty: 1 });
        }
      });
    }

    get("/stores")
      .then(function (d) {
        storeSel.innerHTML = "";
        (d.stores || []).forEach(function (s) {
          storeSel.add(new Option(s.name + (s.city ? " — " + s.city : ""), s.id));
        });
        renderCalendar();
        refreshQuote();
      })
      .catch(function () {
        storeSel.innerHTML = "<option value=''>Stores unavailable</option>";
        showError("Online booking is temporarily unavailable — please call the store or try again shortly.");
      });

    storeSel.addEventListener("change", function () {
      availCache = {};
      renderCalendar();
      refreshQuote();
    });
    root.querySelector(".gsl-cal-prev").addEventListener("click", function () {
      if (view.getFullYear() === today.getFullYear() && view.getMonth() === today.getMonth()) return;
      view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
      renderCalendar();
    });
    root.querySelector(".gsl-cal-next").addEventListener("click", function () {
      view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
      renderCalendar();
    });
    [timeFrom, timeTo].forEach(function (el) {
      el.addEventListener("change", refreshQuote);
    });
  }

  // ---------------------------------------------------------------- courses --
  if (type === "COURSE") {
    var slotsBox = root.querySelector(".gsl-slots");
    get("/sessions", { productNo: productNo }).catch(function () {
      slotsBox.innerHTML = "";
      showError("Online booking is temporarily unavailable — please call the store or try again shortly.");
      return { slots: [] };
    }).then(function (d) {
      var slots = d.slots || [];
      if (!slots.length) {
        if (!root.querySelector(".gsl-error")) slotsBox.innerHTML = "<em>No upcoming sessions — check back soon.</em>";
        offerWaitlist({});
        return;
      }
      slotsBox.innerHTML = "";
      slots.forEach(function (s) {
        var label = document.createElement("label");
        label.className = "gsl-slot";
        var dateStr = new Date(s.date + "T" + s.time).toLocaleDateString("en-CA", {
          weekday: "short", month: "short", day: "numeric",
        });
        var series = s.instanceCount > 1 ? '<span class="gsl-slot-series">Series · session 1 of ' + s.instanceCount + "</span>" : "";
        label.innerHTML =
          '<input type="radio" name="gsl-slot" value="' + s.sessionId + '">' +
          '<span class="gsl-slot-main"><strong>' + dateStr + " · " + s.time + "</strong>" +
          '<span class="gsl-slot-loc">' + s.location + "</span>" + series + "</span>" +
          '<span class="gsl-slot-seats' + (s.remaining <= 2 ? " low" : "") + '">' + s.remaining + " seats left</span>";
        label.querySelector("input").addEventListener("change", function () {
          root.querySelector(".gsl-p-session").value = s.sessionId;
          root.querySelector(".gsl-p-from").value = s.date + "T" + s.time + ":00";
          root.querySelector(".gsl-p-to").value = s.endsAt;
          root.querySelector(".gsl-p-label").value = dateStr + " " + s.time + " @ " + s.location;
          addBtn.disabled = false;
          addBtn.textContent = "Add booking to cart";
        });
        slotsBox.appendChild(label);
      });
    });
  }
  renderAddons();

  var submitting = false;
  form.addEventListener("submit", function (event) {
    if (submitting) return;
    event.preventDefault();
    addBtn.disabled = true;
    addBtn.textContent = "Reserving your slot…";
    post("/holds", {
      productNo: productNo,
      sessionId: root.querySelector(".gsl-p-session").value || undefined,
      storeId: root.querySelector(".gsl-p-store").value || undefined,
      from: root.querySelector(".gsl-p-from").value,
      to: root.querySelector(".gsl-p-to").value,
      qty: Number(root.querySelector(".gsl-qty").value) || 1,
    }).then(function (hold) {
      root.querySelector(".gsl-p-hold").value = hold.token;
      addBtn.textContent = "Adding…";
      submitCart();
    }).catch(function (err) {
      addBtn.disabled = false;
      addBtn.textContent = "Try again";
      showError(err.message || "That slot is no longer available.");
    });
  });
})();
