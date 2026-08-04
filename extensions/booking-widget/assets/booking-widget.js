// Bagsy storefront booking modal. Shopify remains the cart/checkout owner;
// this file only selects a booking, obtains a short hold, and fills line properties.
(function () {
  "use strict";

  Array.prototype.forEach.call(document.querySelectorAll(".gsl-booking"), initWidget);

  function initWidget(root) {
    if (root.dataset.gslReady) return;
    root.dataset.gslReady = "true";

    var proxy = root.dataset.proxy;
    var type = root.dataset.type;
    var productNo = root.dataset.productNo;
    var locale = root.dataset.locale || "";
    var productTitle = root.dataset.productTitle || "Booking";
    var modal = root.querySelector(".gsl-modal");
    var dialog = root.querySelector(".gsl-dialog");
    var body = root.querySelector(".gsl-modal-body");
    var progress = root.querySelector(".gsl-progress");
    var nextBtn = root.querySelector(".gsl-next");
    var backBtn = root.querySelector(".gsl-back");
    var form = root.querySelector(".gsl-add-form");
    var launch = root.querySelector(".gsl-launch");
    var priorFocus = null;
    var submitting = false;
    var step = 1;
    var detailsNeeded = false;
    var fieldsLoaded = false;
    var customFields = [];
    var customFieldOptionValues = {};
    var fieldResponses = {};
    var termsRequired = false;
    var termsAccepted = false;
    var quantityMin = 1;
    var quantityMax = 1;
    var shippingEnabled = false;
    var shippingFee = 0;
    var shipBufferBeforeDays = 0;
    var shipBufferAfterDays = 0;
    var shipBufferPricePerDay = 0;
    var configuredAddons = [];
    var shopifyCrossSell = [];
    var stores = [];
    var sessions = [];
    var availability = {};
    var quote = null;
    var quoteRequest = 0;
    var selected = {
      storeId: "",
      date: "",
      start: "",
      end: "",
      timeFrom: "10:00",
      timeTo: "17:00",
      session: null,
      serviceTime: "",
      qty: 1,
      fulfillment: "PICKUP",
      shipAddress: "",
    };
    var today = localDate(new Date());
    var view = new Date();
    view = new Date(view.getFullYear(), view.getMonth(), 1);

    function t(key) {
      var values = {
        fulfillment: root.dataset.i18nFulfillment || "Fulfillment",
        pickup: root.dataset.i18nPickup || "Pick up",
        ship: root.dataset.i18nShip || "Ship to me",
        address: root.dataset.i18nAddress || "Shipping Address",
        shippingFee: root.dataset.i18nShippingFee || "Shipping",
      };
      return values[key] || key;
    }

    root.querySelector(".gsl-timezone").textContent =
      "Times shown in " + (Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone");

    function request(path, params) {
      var query = new URLSearchParams(params || {});
      return fetch(proxy + path + (query.toString() ? "?" + query.toString() : ""), {
        headers: { accept: "application/json" },
      }).then(parseResponse);
    }

    function post(path, value) {
      return fetch(proxy + path, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(value || {}),
      }).then(parseResponse);
    }

    function parseResponse(response) {
      var contentType = response.headers.get("content-type") || "";
      if (contentType.indexOf("json") === -1) {
        throw new Error("Booking service unreachable (HTTP " + response.status + ")");
      }
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
        return data;
      });
    }

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function field(label, control) {
      var wrapper = el("label", "gsl-field");
      wrapper.appendChild(el("span", "", label));
      wrapper.appendChild(control);
      return wrapper;
    }

    function money(value) {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: (quote && quote.currency) || "CAD",
      }).format(Number(value) || 0);
    }

    function pad(value) {
      return (value < 10 ? "0" : "") + value;
    }

    function localDate(date) {
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
    }

    function readableDate(value) {
      if (!value) return "";
      return new Date(value.slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric", year: "numeric",
      });
    }

    function readableTime(value) {
      var parts = String(value || "").slice(0, 5).split(":");
      var date = new Date(2000, 0, 1, Number(parts[0]), Number(parts[1]));
      return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    }

    function showError(message, container) {
      var old = (container || body).querySelector(".gsl-error");
      if (old) old.remove();
      (container || body).prepend(el("div", "gsl-error", message));
    }

    function openModal() {
      priorFocus = document.activeElement;
      modal.hidden = false;
      document.documentElement.classList.add("gsl-modal-open");
      step = 1;
      renderStep();
      dialog.focus();
      loadMetadata();
      loadWhenData();
    }

    function closeModal() {
      if (submitting) return;
      modal.hidden = true;
      document.documentElement.classList.remove("gsl-modal-open");
      if (priorFocus && priorFocus.focus) priorFocus.focus();
    }

    function focusTrap(event) {
      if (event.key === "Escape") {
        closeModal();
        return;
      }
      if (event.key !== "Tab" || modal.hidden) return;
      var focusable = Array.prototype.filter.call(
        dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
        function (node) { return node.offsetParent !== null; },
      );
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    launch.addEventListener("click", openModal);
    Array.prototype.forEach.call(root.querySelectorAll("[data-gsl-close]"), function (node) {
      node.addEventListener("click", closeModal);
    });
    dialog.addEventListener("keydown", focusTrap);
    backBtn.addEventListener("click", function () {
      step = step === 3 && detailsNeeded ? 2 : 1;
      renderStep();
    });
    nextBtn.addEventListener("click", function () {
      if (step === 1) {
        if (!selectionComplete()) return;
        step = detailsNeeded ? 2 : 3;
        renderStep();
      } else if (step === 2) {
        if (!validateDetails()) return;
        step = 3;
        renderStep();
      } else {
        reserveAndSubmit();
      }
    });

    function loadMetadata() {
      if (fieldsLoaded) return;
      request("/product-fields", { productNo: productNo, locale: locale }).then(function (data) {
        fieldsLoaded = true;
        customFields = data.customFields || [];
        customFieldOptionValues = {};
        customFields.forEach(function (definition) {
          customFieldOptionValues[definition.id] = definition.optionValues || definition.options || [];
        });
        termsRequired = !!(data.termsEnabled && data.termsEnabled[type]);
        quantityMin = Math.max(1, Number(data.quantity && data.quantity.min) || 1);
        quantityMax = Math.max(quantityMin, Number(data.quantity && data.quantity.max) || quantityMin);
        shippingEnabled = type === "RENTAL" && !!data.shippingEnabled;
        shippingFee = Number(data.shippingFee) || 0;
        shipBufferBeforeDays = Number(data.shipBufferBeforeDays) || 0;
        shipBufferAfterDays = Number(data.shipBufferAfterDays) || 0;
        shipBufferPricePerDay = Number(data.shipBufferPricePerDay) || 0;
        selected.qty = quantityMin;
        detailsNeeded = customFields.length > 0 || termsRequired || configuredAddons.length > 0 || quantityMax > quantityMin;
        if (step !== 1) step = detailsNeeded ? 2 : 3;
        updateNavigation();
      }).catch(function (error) {
        fieldsLoaded = true;
        showError(error.message);
      });
    }

    function loadWhenData() {
      if (type === "COURSE" && !sessions.length) {
        request("/sessions", { productNo: productNo }).then(function (data) {
          sessions = data.slots || [];
          if (!selected.date && sessions.length) {
            selected.date = sessions[0].date;
            var firstSessionDate = new Date(selected.date + "T12:00:00");
            view = new Date(firstSessionDate.getFullYear(), firstSessionDate.getMonth(), 1);
          }
          renderWhen();
        }).catch(function (error) { showError(error.message); });
      } else if ((type === "RENTAL" || type === "SERVICE") && !stores.length) {
        request("/stores").then(function (data) {
          stores = data.stores || [];
          if (!selected.storeId && stores.length) selected.storeId = String(stores[0].id);
          renderWhen();
          if (type === "RENTAL") loadMonthAvailability();
          else if (selected.date) loadServiceSlots();
        }).catch(function (error) { showError(error.message); });
      }
    }

    function renderStep() {
      body.innerHTML = "";
      progress.textContent = "Step " + step + "/3 — " + (step === 1 ? "When" : step === 2 ? "Details" : "Confirm");
      backBtn.hidden = step === 1;
      if (step === 1) renderWhen();
      else if (step === 2) renderDetails();
      else renderConfirm();
      updateNavigation();
    }

    function updateNavigation() {
      if (step === 1) {
        nextBtn.textContent = "Next";
        nextBtn.disabled = !selectionComplete() || !quote;
      } else if (step === 2) {
        nextBtn.textContent = "Review booking";
        nextBtn.disabled = !quote;
      } else {
        var total = quote && quote.lines && quote.lines[0] ? quote.lines[0].lineTotal : quote && quote.subtotal;
        if (type === "RENTAL" && selected.fulfillment === "SHIP") {
          total += shippingFee + (shipBufferBeforeDays + shipBufferAfterDays) * shipBufferPricePerDay;
        }
        nextBtn.textContent = "Add to cart — " + money(total);
        nextBtn.disabled = submitting;
      }
    }

    function selectionComplete() {
      if (type === "RENTAL") return !!(selected.storeId && selected.start && selected.end
        && (selected.fulfillment !== "SHIP" || selected.shipAddress.trim()));
      if (type === "COURSE") return !!selected.session;
      return !!(selected.storeId && selected.date && selected.serviceTime);
    }

    function renderWhen() {
      if (step !== 1) return;
      body.innerHTML = "";
      if (type === "RENTAL" || type === "SERVICE") body.appendChild(renderStorePicker());
      var layout = el("div", "gsl-when-grid");
      layout.appendChild(renderCalendar());
      var panel = el("div", "gsl-when-panel");
      if (type === "RENTAL") renderRentalPanel(panel);
      else if (type === "COURSE") renderCoursePanel(panel);
      else renderServicePanel(panel);
      layout.appendChild(panel);
      body.appendChild(layout);
      updateNavigation();
    }

    function renderStorePicker() {
      var select = el("select", "gsl-store");
      if (!stores.length) select.appendChild(new Option("Loading stores…", ""));
      stores.forEach(function (store) {
        select.appendChild(new Option(store.name + (store.city ? " — " + store.city : ""), store.id));
      });
      select.value = selected.storeId;
      select.addEventListener("change", function () {
        selected.storeId = select.value;
        quote = null;
        if (type === "RENTAL") {
          availability = {};
          loadMonthAvailability();
        } else {
          selected.serviceTime = "";
          loadServiceSlots();
        }
        renderWhen();
      });
      return field(type === "RENTAL" ? "Pick-up store" : "Location", select);
    }

    function renderCalendar() {
      var calendar = el("div", "gsl-cal");
      var head = el("div", "gsl-cal-head");
      var prev = el("button", "gsl-cal-prev", "‹");
      var next = el("button", "gsl-cal-next", "›");
      prev.type = next.type = "button";
      prev.setAttribute("aria-label", "Previous month");
      next.setAttribute("aria-label", "Next month");
      prev.disabled = view.getFullYear() === new Date().getFullYear() && view.getMonth() === new Date().getMonth();
      prev.addEventListener("click", function () {
        view = new Date(view.getFullYear(), view.getMonth() - 1, 1);
        renderWhen();
        if (type === "RENTAL") loadMonthAvailability();
      });
      next.addEventListener("click", function () {
        view = new Date(view.getFullYear(), view.getMonth() + 1, 1);
        renderWhen();
        if (type === "RENTAL") loadMonthAvailability();
      });
      head.appendChild(prev);
      head.appendChild(el("strong", "gsl-cal-title", view.toLocaleDateString(undefined, { month: "long", year: "numeric" })));
      head.appendChild(next);
      calendar.appendChild(head);
      var dow = el("div", "gsl-cal-dow");
      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (day) {
        dow.appendChild(el("span", "", day));
      });
      calendar.appendChild(dow);
      var grid = el("div", "gsl-cal-grid");
      grid.setAttribute("role", "grid");
      var firstDay = new Date(view.getFullYear(), view.getMonth(), 1).getDay();
      var days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      for (var blank = 0; blank < firstDay; blank++) grid.appendChild(el("span"));
      for (var day = 1; day <= days; day++) {
        var date = localDate(new Date(view.getFullYear(), view.getMonth(), day));
        var button = el("button", "", String(day));
        button.type = "button";
        button.dataset.date = date;
        var unavailableRental = type === "RENTAL" && selected.storeId && availability[date] === 0;
        var unavailableCourse = type === "COURSE" && !sessions.some(function (slot) { return slot.date === date; });
        button.disabled = date < today || unavailableRental || unavailableCourse;
        if (unavailableRental) button.classList.add("gsl-soldout");
        if (date === today) button.classList.add("gsl-today");
        if (date === selected.date || date === selected.start) button.classList.add("gsl-sel-start");
        if (date === selected.end) button.classList.add("gsl-sel-end");
        if (selected.start && selected.end && date > selected.start && date < selected.end) button.classList.add("gsl-in-range");
        button.addEventListener("click", selectDay);
        grid.appendChild(button);
      }
      calendar.appendChild(grid);
      if (type === "RENTAL") {
        calendar.appendChild(el("p", "gsl-cal-hint", selected.start && !selected.end
          ? "Now select the return day"
          : "Select a pick-up day, then a return day"));
        calendar.appendChild(renderRentalTimes());
      }
      return calendar;
    }

    function selectDay(event) {
      var date = event.currentTarget.dataset.date;
      selected.date = date;
      quote = null;
      if (type === "RENTAL") {
        if (!selected.start || selected.end || date < selected.start) {
          selected.start = date;
          selected.end = "";
        } else {
          selected.end = date;
        }
        renderWhen();
        if (selectionComplete()) refreshQuote();
      } else if (type === "COURSE") {
        selected.session = null;
        renderWhen();
      } else {
        selected.serviceTime = "";
        renderWhen();
        loadServiceSlots();
      }
    }

    function renderRentalTimes() {
      var times = el("div", "gsl-times");
      var from = el("select");
      var to = el("select");
      for (var hour = 9; hour <= 18; hour++) {
        var value = pad(hour) + ":00";
        from.appendChild(new Option(readableTime(value), value));
        to.appendChild(new Option(readableTime(value), value));
      }
      from.value = selected.timeFrom;
      to.value = selected.timeTo;
      from.addEventListener("change", function () {
        selected.timeFrom = from.value;
        quote = null;
        if (selectionComplete()) refreshQuote();
      });
      to.addEventListener("change", function () {
        selected.timeTo = to.value;
        quote = null;
        if (selectionComplete()) refreshQuote();
      });
      times.appendChild(field("Pick-up time", from));
      times.appendChild(field("Return time", to));
      return times;
    }

    function renderRentalPanel(panel) {
      panel.appendChild(el("h3", "", "Your rental"));
      if (shippingEnabled) {
        var fulfillment = el("div", "gsl-custom-field");
        fulfillment.appendChild(el("div", "gsl-field-label", t("fulfillment")));
        ["PICKUP", "SHIP"].forEach(function (value) {
          var choice = el("label", "gsl-check-row");
          var radio = el("input");
          radio.type = "radio";
          radio.name = "gsl-fulfillment";
          radio.value = value;
          radio.checked = selected.fulfillment === value;
          radio.addEventListener("change", function () {
            selected.fulfillment = value;
            renderWhen();
          });
          choice.appendChild(radio);
          choice.appendChild(document.createTextNode(value === "SHIP" ? t("ship") : t("pickup")));
          fulfillment.appendChild(choice);
        });
        if (selected.fulfillment === "SHIP") {
          var address = el("textarea");
          address.required = true;
          address.value = selected.shipAddress;
          address.addEventListener("input", function () {
            selected.shipAddress = address.value;
            updateNavigation();
          });
          fulfillment.appendChild(field(t("address"), address));
        }
        panel.appendChild(fulfillment);
      }
      if (!selected.start) {
        panel.appendChild(el("p", "gsl-empty", "Choose a pick-up date on the calendar."));
        return;
      }
      panel.appendChild(el("p", "gsl-range-summary",
        readableDate(selected.start) + (selected.end ? " → " + readableDate(selected.end) : " → Select return date")));
      var list = el("div", "gsl-availability-list");
      Object.keys(availability).filter(function (date) {
        return date >= selected.start && (!selected.end || date <= selected.end);
      }).sort().forEach(function (date) {
        list.appendChild(el("p", "", availability[date] + " available on " + readableDate(date)));
      });
      panel.appendChild(list);
      renderQuote(panel);
    }

    function renderCoursePanel(panel) {
      panel.appendChild(el("h3", "", selected.date ? readableDate(selected.date) : "Select a date"));
      var daySlots = sessions.filter(function (slot) { return slot.date === selected.date; });
      if (!daySlots.length) {
        panel.appendChild(el("p", "gsl-empty", "No timeslots available — please select another date."));
        return;
      }
      renderGroupedSlots(panel, daySlots, function (slot) {
        var row = el("button", "gsl-slot-row" + (selected.session && selected.session.sessionId === slot.sessionId ? " is-selected" : ""));
        row.type = "button";
        var copy = el("span");
        copy.appendChild(el("strong", "", readableTime(slot.time)));
        copy.appendChild(el("small", "", slot.location || productTitle));
        row.appendChild(copy);
        row.appendChild(el("span", "gsl-seats" + (slot.remaining <= 2 ? " low" : ""), slot.remaining + " seats left"));
        row.addEventListener("click", function () {
          selected.session = slot;
          selected.storeId = slot.storeId || "";
          quote = null;
          renderWhen();
          refreshQuote();
        });
        return row;
      });
      renderQuote(panel);
    }

    function renderServicePanel(panel) {
      panel.appendChild(el("h3", "", selected.date ? readableDate(selected.date) : "Select a date"));
      var slots = panel.dataset.slots ? JSON.parse(panel.dataset.slots) : [];
      slots = root._gslServiceSlots || slots;
      if (!selected.date || !slots.length) {
        panel.appendChild(el("p", "gsl-empty", "No timeslots available — please select another date."));
        return;
      }
      renderGroupedSlots(panel, slots.map(function (time) { return { time: time }; }), function (slot) {
        var chip = el("button", "gsl-time-chip" + (selected.serviceTime === slot.time ? " is-selected" : ""), readableTime(slot.time));
        chip.type = "button";
        chip.addEventListener("click", function () {
          selected.serviceTime = slot.time;
          quote = null;
          renderWhen();
          refreshQuote();
        });
        return chip;
      });
      renderQuote(panel);
    }

    function renderGroupedSlots(panel, slots, renderer) {
      ["AM", "PM"].forEach(function (group) {
        var matching = slots.filter(function (slot) {
          return Number(slot.time.slice(0, 2)) < 12 ? group === "AM" : group === "PM";
        });
        if (!matching.length) return;
        panel.appendChild(el("h4", "gsl-slot-group", group));
        var list = el("div", "gsl-slot-list");
        matching.forEach(function (slot) { list.appendChild(renderer(slot)); });
        panel.appendChild(list);
      });
    }

    function renderQuote(panel) {
      if (!quote || !quote.lines || !quote.lines[0]) return;
      var line = quote.lines[0];
      var box = el("div", "gsl-quote");
      box.appendChild(el("span", "", "Estimated total"));
      box.appendChild(el("strong", "", money(line.lineTotal)));
      if (line.deposit) box.appendChild(el("small", "", money(line.deposit) + " refundable deposit at pick-up"));
      panel.appendChild(box);
    }

    function loadMonthAvailability() {
      if (!selected.storeId) return;
      var first = localDate(new Date(view.getFullYear(), view.getMonth(), 1));
      var last = localDate(new Date(view.getFullYear(), view.getMonth() + 1, 0));
      request("/availability", {
        productNo: productNo, storeId: selected.storeId, from: first, to: last,
      }).then(function (data) {
        availability = {};
        (data.perDay || []).forEach(function (entry) { availability[entry.date] = entry.qty; });
        renderWhen();
      }).catch(function (error) { showError(error.message); });
    }

    function loadServiceSlots() {
      root._gslServiceSlots = [];
      if (!selected.storeId || !selected.date) return;
      request("/service-slots", {
        productNo: productNo, storeId: selected.storeId, date: selected.date,
      }).then(function (data) {
        root._gslServiceSlots = data.slots || [];
        renderWhen();
      }).catch(function (error) { showError(error.message); });
    }

    function quoteParams() {
      var params = { type: type, productNo: productNo, qty: selected.qty };
      if (type === "RENTAL") {
        params.storeId = selected.storeId;
        params.from = selected.start + "T" + selected.timeFrom + ":00";
        params.to = selected.end + "T" + selected.timeTo + ":00";
      } else if (type === "COURSE") {
        params.sessionId = selected.session.sessionId;
      } else {
        params.storeId = selected.storeId;
        params.from = selected.date + "T" + selected.serviceTime + ":00.000Z";
      }
      return params;
    }

    function refreshQuote() {
      if (!selectionComplete()) return;
      var current = ++quoteRequest;
      var params = quoteParams();
      var requests = [request("/quote", params)];
      if (type === "RENTAL") {
        requests.push(request("/availability", {
          productNo: productNo,
          storeId: selected.storeId,
          from: params.from,
          to: params.to,
        }));
      }
      Promise.all(requests).then(function (results) {
        if (current !== quoteRequest) return;
        if (type === "RENTAL" && !results[1].available) {
          quote = null;
          renderWhen();
          showError("This rental is not available for the entire selected range.");
          return;
        }
        quote = results[0];
        renderWhen();
        updateNavigation();
      }).catch(function (error) {
        if (current !== quoteRequest) return;
        quote = null;
        showError(error.message);
        updateNavigation();
      });
    }

    function renderDetails() {
      var wrap = el("div", "gsl-details");
      if (customFields.length) wrap.appendChild(el("h3", "", "Booking details"));
      customFields.forEach(function (definition) {
        wrap.appendChild(renderCustomField(definition));
      });
      if (quantityMax > quantityMin) {
        var quantity = el("input");
        quantity.type = "number";
        quantity.min = String(quantityMin);
        quantity.max = String(quantityMax);
        quantity.value = String(selected.qty);
        quantity.addEventListener("change", function () {
          selected.qty = Math.min(quantityMax, Math.max(quantityMin, Number(quantity.value) || quantityMin));
          quantity.value = String(selected.qty);
          quote = null;
          updateNavigation();
          refreshQuote();
        });
        wrap.appendChild(field("Quantity", quantity));
      }
      if (termsRequired) {
        var termsRow = el("label", "gsl-check-row");
        var checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.checked = termsAccepted;
        checkbox.addEventListener("change", function () { termsAccepted = checkbox.checked; });
        var text = el("span");
        text.appendChild(document.createTextNode("I accept the "));
        var link = el("a", "", "Terms and Conditions");
        link.href = "/api/terms/" + type.toLowerCase();
        link.target = "_blank";
        link.rel = "noopener";
        text.appendChild(link);
        termsRow.appendChild(checkbox);
        termsRow.appendChild(text);
        wrap.appendChild(termsRow);
      }
      if (configuredAddons.length) {
        var addonsBox = el("div", "gsl-addons");
        addonsBox.appendChild(el("h3", "", "Enhance your booking"));
        configuredAddons.forEach(function (addon) {
          var addonRow = el("label", "gsl-check-row gsl-addon");
          var addonCheck = el("input");
          addonCheck.type = "checkbox";
          addonCheck.checked = addon.required || !!addon.selected;
          addonCheck.disabled = !!addon.required;
          addonCheck.addEventListener("change", function () { addon.selected = addonCheck.checked; });
          addonRow.appendChild(addonCheck);
          addonRow.appendChild(el("span", "", addon.name + " · +" + money(addon.price)));
          if (Number(addon.maxQty) > 1) {
            var addonQty = el("input", "gsl-addon-qty");
            addonQty.type = "number";
            addonQty.min = "1";
            addonQty.max = String(addon.maxQty);
            addonQty.value = String(addon.qty || 1);
            addonQty.addEventListener("change", function () {
              addon.qty = Math.min(Number(addon.maxQty), Math.max(1, Number(addonQty.value) || 1));
              addonQty.value = String(addon.qty);
            });
            addonRow.appendChild(addonQty);
          }
          addonsBox.appendChild(addonRow);
        });
        wrap.appendChild(addonsBox);
      }
      body.appendChild(wrap);
    }

    function renderCustomField(definition) {
      var wrapper = el("div", "gsl-custom-field");
      var label = el("label", "gsl-field-label", definition.name + (definition.required ? " ★" : ""));
      label.htmlFor = "gsl-field-" + definition.id;
      wrapper.appendChild(label);
      var control;
      if (definition.type === "textarea") {
        control = el("textarea");
      } else if (definition.type === "dropdown") {
        control = el("select");
        control.appendChild(new Option("Select…", ""));
        (definition.options || []).forEach(function (option, index) {
          var values = customFieldOptionValues[definition.id] || [];
          control.appendChild(new Option(option, values[index] == null ? option : values[index]));
        });
      } else if (definition.type === "radio") {
        control = el("div", "gsl-options");
        (definition.options || []).forEach(function (option, index) {
          var values = customFieldOptionValues[definition.id] || [];
          var optionValue = values[index] == null ? option : values[index];
          var optionLabel = el("label", "gsl-check-row");
          var radio = el("input");
          radio.type = "radio";
          radio.name = "gsl-field-" + definition.id;
          radio.value = optionValue;
          radio.checked = fieldResponses[definition.id] === optionValue;
          radio.addEventListener("change", function () { fieldResponses[definition.id] = optionValue; });
          optionLabel.appendChild(radio);
          optionLabel.appendChild(document.createTextNode(option));
          control.appendChild(optionLabel);
        });
        wrapper.appendChild(control);
        return wrapper;
      } else if (definition.type === "checkbox") {
        control = el("input");
        control.type = "checkbox";
        control.checked = fieldResponses[definition.id] === true;
        control.addEventListener("change", function () { fieldResponses[definition.id] = control.checked; });
        var checkLabel = el("label", "gsl-check-row");
        checkLabel.appendChild(control);
        checkLabel.appendChild(document.createTextNode(definition.name));
        wrapper.innerHTML = "";
        wrapper.appendChild(checkLabel);
        return wrapper;
      } else {
        control = el("input");
        control.type = ["text", "date", "number"].indexOf(definition.type) >= 0 ? definition.type : "text";
      }
      control.id = "gsl-field-" + definition.id;
      control.value = fieldResponses[definition.id] == null ? "" : String(fieldResponses[definition.id]);
      control.placeholder = definition.placeholder || "";
      if (definition.validation && definition.validation.min != null) control.min = definition.validation.min;
      if (definition.validation && definition.validation.max != null) control.max = definition.validation.max;
      control.addEventListener("input", function () { fieldResponses[definition.id] = control.value; });
      wrapper.appendChild(control);
      return wrapper;
    }

    function validateDetails() {
      var valid = true;
      Array.prototype.forEach.call(body.querySelectorAll(".gsl-field-error"), function (node) { node.remove(); });
      customFields.forEach(function (definition) {
        var value = fieldResponses[definition.id];
        var missing = definition.type === "checkbox" ? value !== true : String(value == null ? "" : value).trim() === "";
        var control = body.querySelector("#gsl-field-" + cssEscape(definition.id))
          || body.querySelector('[name="gsl-field-' + cssEscape(definition.id) + '"]');
        if (definition.required && missing) {
          valid = false;
          var error = el("p", "gsl-field-error", definition.name + " is required.");
          (control ? control.closest(".gsl-custom-field") : body).appendChild(error);
        } else if (definition.type === "number" && !missing && control && !control.checkValidity()) {
          valid = false;
          control.closest(".gsl-custom-field").appendChild(el("p", "gsl-field-error", "Enter a number within the allowed range."));
        }
      });
      if (termsRequired && !termsAccepted) {
        valid = false;
        body.appendChild(el("p", "gsl-field-error", "Please accept the Terms and Conditions."));
      }
      return valid;
    }

    function cssEscape(value) {
      return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
    }

    function renderConfirm() {
      var summary = el("div", "gsl-confirm");
      summary.appendChild(el("h3", "", "Review your booking"));
      addSummary(summary, "Booking", productTitle);
      if (type === "RENTAL") {
        addSummary(summary, "Dates", readableDate(selected.start) + " at " + readableTime(selected.timeFrom)
          + " → " + readableDate(selected.end) + " at " + readableTime(selected.timeTo));
      } else if (type === "COURSE") {
        addSummary(summary, "Session", readableDate(selected.session.date) + " at " + readableTime(selected.session.time));
      } else {
        addSummary(summary, "Appointment", readableDate(selected.date) + " at " + readableTime(selected.serviceTime));
      }
      if (type === "RENTAL" && selected.fulfillment === "SHIP") {
        addSummary(summary, t("fulfillment"), t("ship"));
        addSummary(summary, t("address"), selected.shipAddress);
        addSummary(summary, t("shippingFee"), money(shippingFee));
      }
      addSummary(summary, "Quantity", String(selected.qty));
      customFields.forEach(function (definition) {
        var value = fieldResponses[definition.id];
        if (value !== "" && value != null && value !== false) addSummary(summary, definition.name, value === true ? "Yes" : String(value));
      });
      if (termsRequired) addSummary(summary, "Terms", termsAccepted ? "✓ Accepted" : "Not accepted");
      var total = quote && quote.lines && quote.lines[0] ? quote.lines[0].lineTotal : 0;
      if (type === "RENTAL" && selected.fulfillment === "SHIP") {
        total += shippingFee + (shipBufferBeforeDays + shipBufferAfterDays) * shipBufferPricePerDay;
      }
      addSummary(summary, "Total", money(total), "gsl-confirm-total");
      if (shopifyCrossSell.length) {
        var crossSellBox = el("div", "gsl-cross-sell");
        crossSellBox.appendChild(el("h3", "", "Frequently added together"));
        shopifyCrossSell.forEach(function (suggestion) {
          var row = el("label", "gsl-check-row gsl-cross-sell-card");
          var checkbox = el("input");
          checkbox.type = "checkbox";
          checkbox.checked = !!suggestion.required || !!suggestion.selected;
          checkbox.disabled = !!suggestion.required;
          checkbox.addEventListener("change", function () { suggestion.selected = checkbox.checked; });
          row.appendChild(checkbox);
          if (suggestion.imageUrl) {
            var image = el("img", "gsl-cross-sell-image");
            image.src = suggestion.imageUrl;
            image.alt = "";
            row.appendChild(image);
          }
          row.appendChild(el("span", "", suggestion.title + " · " + money(suggestion.price)));
          crossSellBox.appendChild(row);
        });
        summary.appendChild(crossSellBox);
      }
      body.appendChild(summary);
    }

    function addSummary(parent, label, value, className) {
      var row = el("div", "gsl-summary-row" + (className ? " " + className : ""));
      row.appendChild(el("span", "", label));
      row.appendChild(el("strong", "", value));
      parent.appendChild(row);
    }

    function syncForm() {
      var params = quoteParams();
      form.querySelector(".gsl-qty").value = String(selected.qty);
      form.querySelector(".gsl-p-store").value = selected.storeId || "";
      form.querySelector(".gsl-p-session").value = selected.session ? selected.session.sessionId : "";
      form.querySelector(".gsl-p-from").value = quote.lines[0].from || params.from || "";
      form.querySelector(".gsl-p-to").value = quote.lines[0].to || params.to || "";
      form.querySelector(".gsl-p-terms").value = termsAccepted ? "true" : "false";
      form.querySelector(".gsl-p-fulfillment").value = selected.fulfillment;
      form.querySelector(".gsl-p-ship-address").value = selected.fulfillment === "SHIP" ? selected.shipAddress.trim() : "";
      form.querySelector(".gsl-p-label").value = type === "RENTAL"
        ? readableDate(selected.start) + " → " + readableDate(selected.end)
        : readableDate((selected.session && selected.session.date) || selected.date) + " at "
          + readableTime((selected.session && selected.session.time) || selected.serviceTime);
      Array.prototype.forEach.call(form.querySelectorAll(".gsl-dynamic-property"), function (node) { node.remove(); });
      customFields.forEach(function (definition) {
        if (!Object.prototype.hasOwnProperty.call(fieldResponses, definition.id)) return;
        var input = el("input", "gsl-dynamic-property");
        input.type = "hidden";
        input.name = "properties[_field_" + definition.id + "]";
        input.value = String(fieldResponses[definition.id]);
        form.appendChild(input);
      });
    }

    function reserveAndSubmit() {
      if (submitting || !quote) return;
      submitting = true;
      nextBtn.disabled = true;
      nextBtn.textContent = "Reserving your slot…";
      syncForm();
      var line = quote.lines[0];
      post("/holds", {
        type: type,
        productNo: productNo,
        sessionId: selected.session ? selected.session.sessionId : undefined,
        storeId: selected.storeId || undefined,
        from: line.from,
        to: line.to,
        qty: selected.qty,
      }).then(function (hold) {
        form.querySelector(".gsl-p-hold").value = hold.token;
        nextBtn.textContent = "Adding…";
        submitCart();
      }).catch(function (error) {
        submitting = false;
        nextBtn.disabled = false;
        nextBtn.textContent = "Try again";
        showError(error.message || "That slot is no longer available.");
      });
    }

    function cartProperties() {
      var result = {};
      Array.prototype.forEach.call(form.querySelectorAll('input[name^="properties["]'), function (input) {
        var key = input.name.slice(11, -1);
        if (input.value !== "") result[key] = input.value;
      });
      return result;
    }

    function submitCart() {
      var extras = selectedAddonItems().concat(selectedCrossSellItems());
      if (!extras.length) {
        form.submit();
        return;
      }
      var main = {
        id: Number(form.querySelector('input[name="id"]').value),
        quantity: selected.qty,
        properties: cartProperties(),
      };
      var cartUrl = window.Shopify && window.Shopify.routes
        ? window.Shopify.routes.root + "cart/add.js" : "/cart/add.js";
      fetch(cartUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ items: [main].concat(extras) }),
      }).then(function (response) {
        if (!response.ok) return response.json().then(function (data) {
          throw new Error(data.description || "Could not add booking");
        });
        window.location.href = "/cart";
      }).catch(function (error) {
        submitting = false;
        nextBtn.disabled = false;
        nextBtn.textContent = "Try again";
        showError(error.message);
      });
    }

    function selectedAddonItems() {
      return configuredAddons.filter(function (addon) { return addon.required || addon.selected; }).map(function (addon) {
        return {
          id: Number(addon.shopifyVariantId),
          quantity: Math.max(1, Number(addon.qty) || 1),
          properties: { _booking_addon_for: productNo, _addon_product_no: addon.productNo },
        };
      });
    }

    function selectedCrossSellItems() {
      return shopifyCrossSell.filter(function (suggestion) {
        return suggestion.required || suggestion.selected;
      }).map(function (suggestion) {
        return {
          id: Number(String(suggestion.variantId).replace(/^gid:\/\/shopify\/ProductVariant\//, "")),
          quantity: 1,
          properties: { _cross_sell: "1" },
        };
      });
    }

    request("/addons", { productNo: productNo }).then(function (data) {
      configuredAddons = (data.addons || []).filter(function (addon) { return addon.shopifyVariantId; });
      if (configuredAddons.length) detailsNeeded = true;
      if (step === 2 && !modal.hidden) renderStep();
      else updateNavigation();
    }).catch(function () {});
    request("/cross-sell", { productNo: productNo }).then(function (data) {
      shopifyCrossSell = (data.suggestions || []).filter(function (suggestion) {
        return suggestion.kind === "SHOPIFY" && suggestion.variantId;
      });
      if (step === 3 && !modal.hidden) renderStep();
    }).catch(function () {});
  }
})();
