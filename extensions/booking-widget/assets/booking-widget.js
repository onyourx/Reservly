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
  function showError(msg) {
    var el = document.createElement("div");
    el.className = "gsl-error";
    el.textContent = msg;
    root.insertBefore(el, form);
    addBtn.disabled = true;
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
          root.querySelector(".gsl-p-label").value = dateStr + " " + s.time + " @ " + s.location;
          addBtn.disabled = false;
          addBtn.textContent = "Add booking to cart";
        });
        slotsBox.appendChild(label);
      });
    });
  }

  form.addEventListener("submit", function () {
    addBtn.textContent = "Adding…";
  });
})();
