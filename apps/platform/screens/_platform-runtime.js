(function () {
  var pageFile = window.location.pathname.split("/").pop() || "";
  var searchParams = new URLSearchParams(window.location.search);
  var apiBase =
    searchParams.get("api") ||
    window.localStorage.getItem("aibeaty_api_base") ||
    "/api/platform";
  var demoUrl = "../data/demo-platform.json";

  function formatUpdated(value) {
    try {
      return new Date(value).toLocaleString();
    } catch (error) {
      return value || "";
    }
  }

  function ensureRuntimeStyle() {
    if (document.getElementById("aibeaty-runtime-style")) return;
    var style = document.createElement("style");
    style.id = "aibeaty-runtime-style";
    style.textContent =
      ".aibeaty-status{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;font-size:12px;font-weight:700;line-height:1;background:rgba(77,42,250,.08);color:#4d2afa;border:1px solid rgba(77,42,250,.16)}" +
      ".aibeaty-status__dot{width:8px;height:8px;border-radius:999px;background:currentColor}" +
      ".aibeaty-status--demo{background:rgba(122,37,219,.08);color:#7a25db;border-color:rgba(122,37,219,.16)}" +
      ".aibeaty-status--live{background:rgba(0,99,132,.08);color:#006384;border-color:rgba(0,99,132,.16)}" +
      ".aibeaty-status--error{background:rgba(180,19,64,.08);color:#b41340;border-color:rgba(180,19,64,.16)}" +
      ".aibeaty-status--loading{background:rgba(117,119,120,.08);color:#595c5d;border-color:rgba(117,119,120,.16)}" +
      ".aibeaty-meta{font-size:11px;color:#757778;font-weight:600}" +
      ".aibeaty-empty{padding:16px;border:1px dashed rgba(171,173,174,.45);border-radius:12px;color:#595c5d;font-size:13px;background:rgba(239,241,242,.5)}" +
      ".aibeaty-toast-stack{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:10px;z-index:9999}" +
      ".aibeaty-toast{max-width:360px;padding:12px 14px;border-radius:14px;background:rgba(255,255,255,.96);border:1px solid rgba(171,173,174,.26);box-shadow:0 20px 50px rgba(44,47,48,.12);color:#2c2f30;font-size:13px;font-weight:600}" +
      ".aibeaty-toast--error{border-color:rgba(180,19,64,.24);color:#b41340}" +
      ".aibeaty-overlay{position:absolute;inset:0;background:rgba(245,246,247,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:60}" +
      ".aibeaty-overlay-card{min-width:280px;max-width:420px;padding:18px 20px;border-radius:18px;background:rgba(255,255,255,.96);border:1px solid rgba(171,173,174,.26);box-shadow:0 24px 60px rgba(44,47,48,.12)}" +
      ".aibeaty-spinner{width:18px;height:18px;border-radius:999px;border:2px solid rgba(77,42,250,.15);border-top-color:#4d2afa;animation:aibeaty-spin 1s linear infinite}" +
      ".aibeaty-action-muted{opacity:.55;pointer-events:none}" +
      ".aibeaty-modal-backdrop{position:fixed;inset:0;background:rgba(44,47,48,.24);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;z-index:10000}" +
      ".aibeaty-modal{width:min(560px,100%);max-height:min(90vh,820px);overflow:auto;border-radius:24px;background:rgba(255,255,255,.98);border:1px solid rgba(171,173,174,.24);box-shadow:0 30px 80px rgba(44,47,48,.18)}" +
      ".aibeaty-modal__header{padding:24px 24px 12px;border-bottom:1px solid rgba(171,173,174,.16)}" +
      ".aibeaty-modal__body{padding:20px 24px;display:grid;gap:16px}" +
      ".aibeaty-modal__footer{padding:16px 24px 24px;display:flex;justify-content:flex-end;gap:12px}" +
      ".aibeaty-modal__label{display:grid;gap:8px}" +
      ".aibeaty-modal__label span{font-size:12px;font-weight:700;color:#595c5d;text-transform:uppercase;letter-spacing:.04em}" +
      ".aibeaty-modal__input,.aibeaty-modal__select,.aibeaty-modal__textarea{width:100%;border:1px solid rgba(171,173,174,.28);border-radius:14px;background:#fff;padding:12px 14px;font-size:14px;color:#2c2f30;outline:none;transition:border-color .15s ease,box-shadow .15s ease}" +
      ".aibeaty-modal__textarea{min-height:120px;resize:vertical}" +
      ".aibeaty-modal__input:focus,.aibeaty-modal__select:focus,.aibeaty-modal__textarea:focus{border-color:#4d2afa;box-shadow:0 0 0 3px rgba(77,42,250,.12)}" +
      ".aibeaty-modal__actions button{border-radius:999px;padding:10px 16px;font-size:13px;font-weight:700}" +
      ".aibeaty-modal__cancel{background:transparent;border:1px solid rgba(171,173,174,.28);color:#595c5d}" +
      ".aibeaty-modal__submit{background:#4d2afa;border:1px solid #4d2afa;color:#fff}" +
      "@keyframes aibeaty-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function notify(message, tone) {
    ensureRuntimeStyle();
    var stack = document.getElementById("aibeaty-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.id = "aibeaty-toast-stack";
      stack.className = "aibeaty-toast-stack";
      document.body.appendChild(stack);
    }
    var toast = document.createElement("div");
    toast.className = "aibeaty-toast" + (tone === "error" ? " aibeaty-toast--error" : "");
    toast.textContent = message;
    stack.appendChild(toast);
    window.setTimeout(function () {
      toast.remove();
    }, 2600);
  }

  function presentForm(options) {
    ensureRuntimeStyle();
    options = options || {};
    var fields = Array.isArray(options.fields) ? options.fields : [];
    return new Promise(function (resolve) {
      var backdrop = document.createElement("div");
      backdrop.className = "aibeaty-modal-backdrop";
      var bodyHtml = fields.map(function (field, index) {
        var label = escapeHtml(field.label || field.name || ("Field " + (index + 1)));
        var name = escapeHtml(field.name || ("field_" + index));
        var value = escapeHtml(field.value || "");
        if (field.type === "select") {
          var choices = (field.options || []).map(function (option) {
            var optionValue = typeof option === "string" ? option : option.value;
            var optionLabel = typeof option === "string" ? option : (option.label || option.value);
            return '<option value="' + escapeHtml(optionValue) + '"' + (String(optionValue) === String(field.value || "") ? " selected" : "") + '>' + escapeHtml(optionLabel) + "</option>";
          }).join("");
          return '<label class="aibeaty-modal__label"><span>' + label + '</span><select class="aibeaty-modal__select" name="' + name + '">' + choices + "</select></label>";
        }
        if (field.type === "textarea") {
          return '<label class="aibeaty-modal__label"><span>' + label + '</span><textarea class="aibeaty-modal__textarea" name="' + name + '" placeholder="' + escapeHtml(field.placeholder || "") + '">' + value + "</textarea></label>";
        }
        return '<label class="aibeaty-modal__label"><span>' + label + '</span><input class="aibeaty-modal__input" type="' + escapeHtml(field.type || "text") + '" name="' + name + '" value="' + value + '" placeholder="' + escapeHtml(field.placeholder || "") + '"/></label>';
      }).join("");
      backdrop.innerHTML =
        '<div class="aibeaty-modal" role="dialog" aria-modal="true">' +
        '<div class="aibeaty-modal__header"><div class="font-headline font-bold text-xl text-on-surface">' + escapeHtml(options.title || "Edit") + '</div>' +
        (options.description ? '<div class="text-sm text-on-surface-variant mt-2">' + escapeHtml(options.description) + "</div>" : "") +
        '</div><form class="aibeaty-modal__form"><div class="aibeaty-modal__body">' + bodyHtml + '</div><div class="aibeaty-modal__footer aibeaty-modal__actions">' +
        '<button type="button" class="aibeaty-modal__cancel">' + escapeHtml(options.cancelLabel || "Cancel") + '</button>' +
        '<button type="submit" class="aibeaty-modal__submit">' + escapeHtml(options.submitLabel || "Save") + "</button>" +
        "</div></form></div>";
      document.body.appendChild(backdrop);
      var form = qs("form", backdrop);
      var cancel = qs(".aibeaty-modal__cancel", backdrop);
      var inputs = qsa("input, select, textarea", backdrop);
      var done = function (result) {
        backdrop.remove();
        resolve(result);
      };
      cancel.addEventListener("click", function () { done(null); });
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) done(null);
      });
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var values = {};
        inputs.forEach(function (input) {
          values[input.name] = input.value;
        });
        done(values);
      });
      if (inputs[0]) {
        inputs[0].focus();
        if (inputs[0].select) inputs[0].select();
      }
    });
  }

  function presentReport(options) {
    ensureRuntimeStyle();
    options = options || {};
    return new Promise(function (resolve) {
      var backdrop = document.createElement("div");
      backdrop.className = "aibeaty-modal-backdrop";
      backdrop.innerHTML =
        '<div class="aibeaty-modal" role="dialog" aria-modal="true">' +
        '<div class="aibeaty-modal__header"><div class="font-headline font-bold text-xl text-on-surface">' + escapeHtml(options.title || "Report") + '</div>' +
        (options.description ? '<div class="text-sm text-on-surface-variant mt-2">' + escapeHtml(options.description) + "</div>" : "") +
        '</div><div class="aibeaty-modal__body">' +
        '<label class="aibeaty-modal__label"><span>Summary</span><textarea class="aibeaty-modal__textarea" readonly>' + escapeHtml(options.content || "") + '</textarea></label>' +
        "</div><div class=\"aibeaty-modal__footer aibeaty-modal__actions\">" +
        '<button type="button" class="aibeaty-modal__cancel">Close</button>' +
        '<button type="button" class="aibeaty-modal__submit">Copy Report</button>' +
        "</div></div>";
      document.body.appendChild(backdrop);
      var cancel = qs(".aibeaty-modal__cancel", backdrop);
      var submit = qs(".aibeaty-modal__submit", backdrop);
      var textarea = qs("textarea", backdrop);
      var done = function (result) {
        backdrop.remove();
        resolve(result);
      };
      cancel.addEventListener("click", function () { done(null); });
      submit.addEventListener("click", function () {
        if (navigator.clipboard && textarea) {
          navigator.clipboard.writeText(textarea.value).then(function () {
            notify("Report copied.");
            done("copied");
          }).catch(function () {
            notify("Copy failed.", "error");
          });
        } else {
          textarea.select();
          done("selected");
        }
      });
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) done(null);
      });
    });
  }

  function presentActivityFeed(options) {
    ensureRuntimeStyle();
    options = options || {};
    return new Promise(function (resolve) {
      var state = {
        q: options.q || "",
        tone: options.tone || "all",
        limit: String(options.limit || "50")
      };
      var latestPayload = null;
      var debounceId = null;
      var backdrop = document.createElement("div");
      backdrop.className = "aibeaty-modal-backdrop";
      backdrop.innerHTML =
        '<div class="aibeaty-modal" role="dialog" aria-modal="true">' +
        '<div class="aibeaty-modal__header"><div class="font-headline font-bold text-xl text-on-surface">Activity Feed</div>' +
        '<div class="text-sm text-on-surface-variant mt-2">Live operator activity with search, tone filters, and deep-links.</div></div>' +
        '<div class="aibeaty-modal__body">' +
        '<div class="grid gap-4 md:grid-cols-3">' +
        '<label class="aibeaty-modal__label md:col-span-2"><span>Search</span><input class="aibeaty-modal__input" name="activity-search" type="text" placeholder="Search titles, meta, screens"/></label>' +
        '<label class="aibeaty-modal__label"><span>Tone</span><select class="aibeaty-modal__select" name="activity-tone"><option value="all">all</option><option value="secondary">secondary</option><option value="tertiary">tertiary</option><option value="error">error</option></select></label>' +
        '</div>' +
        '<div class="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-4">' +
        '<div class="flex items-center justify-between gap-3 mb-4"><div class="text-sm text-on-surface-variant" data-activity-summary>Loading activity...</div><button type="button" class="px-3 py-1.5 rounded-md border border-outline-variant/20 text-xs font-semibold text-on-surface hover:bg-surface-container-low transition-colors" data-activity-export>Copy Summary</button></div>' +
        '<div class="space-y-3 max-h-[52vh] overflow-y-auto pr-1" data-activity-entries></div>' +
        '</div></div>' +
        '<div class="aibeaty-modal__footer aibeaty-modal__actions"><button type="button" class="aibeaty-modal__cancel">Close</button></div></div>';
      document.body.appendChild(backdrop);

      var searchInput = qs('[name="activity-search"]', backdrop);
      var toneSelect = qs('[name="activity-tone"]', backdrop);
      var summary = qs("[data-activity-summary]", backdrop);
      var entriesWrap = qs("[data-activity-entries]", backdrop);
      var cancel = qs(".aibeaty-modal__cancel", backdrop);
      var exportButton = qs("[data-activity-export]", backdrop);

      function finish(result) {
        backdrop.remove();
        resolve(result);
      }

      function renderEntries(payload) {
        latestPayload = payload;
        if (summary) {
          summary.textContent = "Showing " + payload.summary.shown + " of " + payload.summary.matched + " matched events (" + payload.summary.total + " total).";
        }
        if (!entriesWrap) return;
        entriesWrap.innerHTML = payload.entries.length
          ? payload.entries.map(function (item) {
              return '<button type="button" class="w-full text-left rounded-xl border border-outline-variant/15 bg-white p-4 hover:bg-surface-container-low transition-colors" data-activity-screen="' + escapeHtml(item.route.screen || "") + '" data-activity-query="' + escapeHtml(item.route.query || "") + '">' +
                '<div class="flex items-start gap-3"><div class="w-9 h-9 rounded-full ' + toneClasses(item.tone) + ' flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px]">' + escapeHtml(item.icon || "bolt") + '</span></div>' +
                '<div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-3"><div><div class="text-sm font-semibold text-on-surface">' + escapeHtml(item.title) + '</div><div class="text-xs text-on-surface-variant mt-1">' + escapeHtml(item.meta) + '</div></div><div class="text-[11px] text-outline whitespace-nowrap">' + escapeHtml(item.time) + '</div></div>' +
                '<div class="mt-3 text-[11px] text-primary font-medium">Open ' + escapeHtml(String(item.route.screen || "").replace(".html", "")) + '</div></div></div></button>';
            }).join("")
          : '<div class="aibeaty-empty">No activity matches the current filters.</div>';
        qsa("[data-activity-screen]", entriesWrap).forEach(function (button) {
          button.addEventListener("click", function () {
            navigateToScreen(button.dataset.activityScreen, { q: button.dataset.activityQuery });
            finish("navigated");
          });
        });
      }

      function loadFeed() {
        if (summary) summary.textContent = "Loading activity...";
        if (entriesWrap) entriesWrap.innerHTML = '<div class="aibeaty-empty">Loading activity feed...</div>';
        var params = new URLSearchParams({
          q: state.q || "",
          tone: state.tone || "all",
          limit: state.limit || "50"
        });
        fetchJson(apiBase.replace(/\/$/, "") + "/reports/activity?" + params.toString())
          .then(renderEntries)
          .catch(function () {
            if (summary) summary.textContent = "Activity feed failed to load.";
            if (entriesWrap) entriesWrap.innerHTML = '<div class="aibeaty-empty">Could not load activity feed.</div>';
          });
      }

      if (searchInput) {
        searchInput.value = state.q;
        searchInput.addEventListener("input", function () {
          state.q = searchInput.value;
          window.clearTimeout(debounceId);
          debounceId = window.setTimeout(loadFeed, 180);
        });
      }
      if (toneSelect) {
        toneSelect.value = state.tone;
        toneSelect.addEventListener("change", function () {
          state.tone = toneSelect.value;
          loadFeed();
        });
      }
      if (exportButton) {
        exportButton.addEventListener("click", function () {
          if (!latestPayload || !navigator.clipboard) {
            notify("Summary not ready yet.", "error");
            return;
          }
          navigator.clipboard.writeText(latestPayload.summaryText || "").then(function () {
            notify("Activity summary copied.");
          }).catch(function () {
            notify("Copy failed.", "error");
          });
        });
      }
      if (cancel) cancel.addEventListener("click", function () { finish(null); });
      backdrop.addEventListener("click", function (event) {
        if (event.target === backdrop) finish(null);
      });
      loadFeed();
      if (searchInput) searchInput.focus();
    });
  }

  function setStatus(state) {
    ensureRuntimeStyle();
    var header = document.querySelector("header");
    if (!header) return;
    var right = header.lastElementChild;
    if (!right) return;
    var wrapper = document.getElementById("aibeaty-runtime-badge");
    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.id = "aibeaty-runtime-badge";
      wrapper.className = "flex items-center gap-3";
      right.prepend(wrapper);
    }
    var tone = state.mode || "demo";
    wrapper.innerHTML =
      '<span class="aibeaty-status aibeaty-status--' +
      tone +
      '"><span class="aibeaty-status__dot"></span>' +
      state.label +
      "</span>" +
      '<span class="aibeaty-meta">' +
      state.meta +
      "</span>";
  }

  function mountLoading() {
    setStatus({ mode: "loading", label: "Loading", meta: "Resolving page data" });
    var main = document.querySelector("main");
    if (!main || document.getElementById("aibeaty-overlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "aibeaty-overlay";
    overlay.className = "aibeaty-overlay";
    overlay.innerHTML =
      '<div class="aibeaty-overlay-card flex items-center gap-3"><div class="aibeaty-spinner"></div><div><div class="font-semibold text-on-surface">Loading platform state</div><div class="text-sm text-on-surface-variant">Checking backend, then falling back to demo if needed.</div></div></div>';
    main.style.position = "relative";
    main.appendChild(overlay);
  }

  function unmountLoading() {
    var overlay = document.getElementById("aibeaty-overlay");
    if (overlay) overlay.remove();
  }

  function bindStaticButtons() {
    qsa("button, a").forEach(function (node) {
      if (node.dataset.actionBound === "true") return;
      var text = (node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      var href = node.tagName === "A" ? node.getAttribute("href") : "";
      var iconText = qsa(".material-symbols-outlined", node)
        .map(function (icon) {
          return (icon.textContent || "").trim().toLowerCase();
        })
        .join(" ");
      var message = null;
      if (text.includes("export report")) message = "Export queue stubbed. Wire this to reporting API next.";
      else if (text.includes("view all activity")) message = "Full activity feed view is queued for backend wiring.";
      else if (text.includes("create po")) message = "PO creation is ready for inventory backend action.";
      else if (text.includes("download")) message = "Export/download action stubbed for backend file generation.";
      else if (text === "filter" || text.includes("filter list")) message = "Advanced filters are next once backend query params land.";
      else if (text.includes("receipt")) message = "Receipt viewer stubbed. Hook this to invoice/order endpoint.";
      else if (text.includes("check out")) message = "Checkout action stubbed. Connect this to booking completion endpoint.";
      else if (text === "edit" || text.includes("edit notes") || text.includes("edit profile")) message = "Inline edit is frontend-ready; persistence comes from backend.";
      else if (text.includes("activate")) message = "Workflow activation stubbed. POST to automations endpoint next.";
      else if (text.includes("test run")) message = "Test run stubbed. Use this to preview automation on backend.";
      else if (text.includes("view all hair") || text.includes("view all")) message = "Expanded list view is pending backend pagination.";
      else if (text.includes("new booking")) message = "Booking drawer stubbed. Wire this to appointment creation flow.";
      else if (text.includes("new client")) message = "New client flow stubbed. POST this to CRM backend next.";
      else if (text.includes("save") || text.includes("save changes")) message = "Changes stored locally for now. Persist them through the backend mutation next.";
      else if (text.includes("duplicate")) message = "Duplicate action stubbed. Clone this entity through backend when ready.";
      else if (text.includes("book") && !text.includes("new booking")) message = "Booking action stubbed. Route this to booking flow after backend wiring.";
      else if (text.includes("close")) message = "Drawer close action kept intentionally local for now.";
      else if (iconText.includes("notifications")) message = "Notifications center is shell-only until backend events land.";
      else if (iconText.includes("dark_mode")) message = "Theme toggle is intentionally held until shared app preferences exist.";
      else if (iconText.includes("account_circle")) message = "Profile menu shell is ready for auth/account wiring.";
      else if (!text && (iconText.includes("edit") || iconText.includes("more_horiz"))) message = "Inline actions are stubbed until backend mutations are connected.";
      else if (href === "#") message = "This control is reserved for the next backend integration step.";
      if (!message) return;
      node.addEventListener("click", function (event) {
        if (node.tagName === "A" && href && href !== "#") return;
        event.preventDefault();
        notify(message);
      });
      node.dataset.actionBound = "true";
    });
  }

  function toneClasses(tone) {
    if (tone === "low") return "bg-error-container/20 text-error border border-error/20";
    if (tone === "ok") return "bg-secondary-container/30 text-secondary-dim border border-secondary-dim/20";
    return "text-on-surface-variant border border-outline-variant/30";
  }

  function tagClasses(tone) {
    if (tone === "vip") return "bg-tertiary-container/30 text-tertiary-dim";
    if (tone === "regular") return "bg-secondary-container/50 text-secondary-dim";
    if (tone === "new") return "bg-primary/10 text-primary-dim";
    if (tone === "at-risk") return "bg-error-container/20 text-error-dim";
    return "bg-surface-container text-on-surface-variant";
  }

  function getNumericStockValue(stockLabel) {
    var match = String(stockLabel || "").match(/[\d.]+/);
    return match ? Number(match[0]) : 0;
  }

  function setSearchPlaceholder(value) {
    var input = qs("header input[type='text']");
    if (input && value) input.placeholder = value;
  }

  function screenApiUrl(query) {
    var base = apiBase.replace(/\/$/, "") + "/" + pageFile.replace(".html", "");
    var params = new URLSearchParams();
    Object.keys(query || {}).forEach(function (key) {
      var value = query[key];
      if (value === null || value === undefined) return;
      value = String(value).trim();
      if (!value || value === "all") return;
      params.set(key, value);
    });
    var queryString = params.toString();
    return queryString ? base + "?" + queryString : base;
  }

  function debounce(fn, wait) {
    var timeoutId = null;
    return function () {
      var args = arguments;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(function () {
        fn.apply(null, args);
      }, wait);
    };
  }

  function fetchJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function mutateJson(url, method, payload) {
    return fetch(url, {
      method: method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    });
  }

  function loadLivePage(query) {
    return fetchJson(screenApiUrl(query)).then(function (payload) {
      return payload.page || payload;
    });
  }

  function buildScreenHref(file, query) {
    var params = new URLSearchParams();
    Object.keys(query || {}).forEach(function (key) {
      var value = query[key];
      if (value === null || value === undefined) return;
      value = String(value).trim();
      if (!value || value === "all") return;
      params.set(key, value);
    });
    if (apiBase && apiBase !== "/api/platform") {
      params.set("api", apiBase);
    }
    var queryString = params.toString();
    return file + (queryString ? "?" + queryString : "");
  }

  function navigateToScreen(file, query) {
    window.location.href = buildScreenHref(file, query);
  }

  function syncCurrentScreenQuery(query) {
    if (!window.history || !window.history.replaceState || !pageFile) return;
    window.history.replaceState({}, "", buildScreenHref(pageFile, query));
  }

  function ensureActionButton(container, key, label, className) {
    if (!container) return null;
    var button = qs('[data-runtime-action="' + key + '"]', container);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.dataset.runtimeAction = key;
      container.appendChild(button);
    }
    button.textContent = label;
    button.className = className;
    return button;
  }

  function setButtonDisabled(button, disabled) {
    if (!button) return;
    button.disabled = !!disabled;
    button.classList.toggle("aibeaty-action-muted", !!disabled);
  }

  function wireClickable(node, handler) {
    if (!node) return;
    node.style.cursor = "pointer";
    node.tabIndex = 0;
    node.addEventListener("click", handler);
    node.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler(event);
      }
    });
  }

  function renderPerformance(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      limit: page.liveQuery && page.liveQuery.limit ? page.liveQuery.limit : "6"
    };

    function syncPage(nextPage) {
      renderPerformance(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    var title = qs(".max-w-7xl h1");
    var subtitle = title && title.parentElement ? title.parentElement.querySelector("p") : null;
    if (title) title.textContent = page.title;
    if (subtitle) subtitle.textContent = page.subtitle;
    setSearchPlaceholder(page.searchPlaceholder);

    var cards = qsa(".max-w-7xl > .grid.grid-cols-1.md\\:grid-cols-2.lg\\:grid-cols-4 > div");
    page.kpis.forEach(function (kpi, index) {
      var card = cards[index];
      if (!card) return;
      var label = qs("span.text-on-surface-variant", card);
      var value = qs(".font-headline.text-2xl", card);
      var trend = qs(".text-xs", card);
      if (label) label.textContent = kpi.label;
      if (value) value.textContent = kpi.value;
      if (trend) {
        trend.className =
          "text-xs font-medium flex items-center gap-1 mt-1 " +
          (kpi.trendTone === "negative"
            ? "text-error"
            : kpi.trendTone === "positive"
              ? "text-secondary"
              : "text-on-surface-variant");
        trend.innerHTML =
          '<span class="material-symbols-outlined" style="font-size: 14px;">' +
          (kpi.trendTone === "negative"
            ? "trending_down"
            : kpi.trendTone === "positive"
              ? "trending_up"
              : "horizontal_rule") +
          "</span>" +
          kpi.trend;
      }
    });
    if (cards[0]) wireClickable(cards[0], function () { navigateToScreen("stylist-schedule-luminous-core.html"); });
    if (cards[1]) wireClickable(cards[1], function () { navigateToScreen("stylist-schedule-luminous-core.html"); });
    if (cards[2]) wireClickable(cards[2], function () { navigateToScreen("unified-inbox-luminous-core.html"); });
    if (cards[3]) wireClickable(cards[3], function () { navigateToScreen("client-directory-luminous-core.html"); });

    var stylistCard = qsa(".bg-surface-container-lowest.rounded-lg.border.border-outline-variant\\/20.p-6")[0];
    var stylistList = stylistCard ? qs(".space-y-4", stylistCard) : null;
    if (stylistList) {
      stylistList.innerHTML = page.stylists
        .map(function (stylist) {
          return (
            '<div class="flex items-center justify-between py-2 border-b border-surface-container-high/50 last:border-0" data-performance-stylist="' + escapeHtml(stylist.name) + '">' +
            '<div class="flex items-center gap-3">' +
            '<div class="w-10 h-10 rounded-full bg-surface-dim overflow-hidden border border-outline-variant/20"><img alt="Stylist" class="w-full h-full object-cover" src="' +
            stylist.avatar +
            '"/></div><div><p class="text-sm font-semibold text-on-surface">' +
            stylist.name +
            '</p><p class="text-xs text-on-surface-variant">' +
            stylist.role +
            "</p></div></div><div class=\"text-right\"><p class=\"text-sm font-semibold text-on-surface\">" +
            stylist.revenue +
            '</p><p class="text-xs text-secondary">' +
            stylist.appointments +
            "</p></div></div>"
          );
        })
        .join("");
      qsa("[data-performance-stylist]", stylistList).forEach(function (node) {
        wireClickable(node, function () {
          navigateToScreen("stylist-schedule-luminous-core.html", { stylist: node.dataset.performanceStylist });
        });
      });
    }

    var activityCard = qsa(".bg-surface-container-lowest.rounded-lg.border.border-outline-variant\\/20.p-6")[1];
    var activityList = activityCard ? qs(".space-y-5", activityCard) : null;
    if (activityList) {
      activityList.innerHTML = page.activity
        .map(function (item) {
          var toneClass =
            item.tone === "secondary"
              ? "bg-secondary-container text-on-secondary-container"
              : item.tone === "tertiary"
                ? "bg-tertiary-container text-on-tertiary-container"
                : "bg-surface-container text-on-surface";
          return (
            '<div class="flex gap-3" data-activity-screen="' + escapeHtml(item.route && item.route.screen ? item.route.screen : "salon-performance-luminous-core.html") + '" data-activity-query="' + escapeHtml(item.route && item.route.query ? item.route.query : "") + '">' +
            '<div class="w-8 h-8 rounded-full ' +
            toneClass +
            ' flex items-center justify-center shrink-0"><span class="material-symbols-outlined" style="font-size: 16px;">' +
            item.icon +
            "</span></div><div><p class=\"text-sm text-on-surface font-medium\">" +
            item.title +
            '</p><p class="text-xs text-on-surface-variant">' +
            item.meta +
            '</p><p class="text-xs text-outline mt-1">' +
            item.time +
            "</p></div></div>"
          );
        })
        .join("");
      qsa("[data-activity-screen]", activityList).forEach(function (node) {
        wireClickable(node, function () {
          navigateToScreen(node.dataset.activityScreen, { q: node.dataset.activityQuery });
        });
      });
    }

    var search = qs("header input[type='text']");
    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        reload({ q: search.value });
      }, 180));
    }

    var mainActions = qsa(".max-w-7xl .flex.gap-2 button");
    var exportButton = mainActions.filter(function (button) {
      return (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "export report";
    })[0];
    if (exportButton) {
      exportButton.dataset.actionBound = "true";
      exportButton.onclick = function () {
        fetchJson(apiBase.replace(/\/$/, "") + "/reports/performance?" + new URLSearchParams({ q: currentQuery.q || "", limit: "12" }).toString())
          .then(function (payload) {
            return presentReport({
              title: "Performance Report",
              description: "Live summary generated from current platform state",
              content: payload.summaryText || ""
            });
          })
          .catch(function () {
            notify("Report export failed.", "error");
          });
      };
    }

    var activityButtons = qsa("button", document).filter(function (button) {
      return (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "view all activity";
    });
    if (activityButtons[0]) {
      activityButtons[0].dataset.actionBound = "true";
      activityButtons[0].onclick = function () {
        presentActivityFeed({
          q: currentQuery.q || "",
          tone: "all",
          limit: "50"
        });
      };
      activityButtons[0].textContent = "View All Activity";
    }
  }

  function renderInventory(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      category: page.liveQuery && page.liveQuery.category ? page.liveQuery.category : "professional",
      stock: page.liveQuery && page.liveQuery.stock ? page.liveQuery.stock : "all"
    };

    function syncPage(nextPage) {
      renderInventory(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    var title = qs(".max-w-7xl h2.text-3xl");
    var subtitle = title && title.parentElement ? title.parentElement.querySelector("p") : null;
    if (title) title.textContent = page.title;
    if (subtitle) subtitle.textContent = page.subtitle;
    setSearchPlaceholder(page.searchPlaceholder);

    var cards = qsa(".grid.grid-cols-1.md\\:grid-cols-4 > div");
    page.kpis.forEach(function (kpi, index) {
      var card = cards[index];
      if (!card) return;
      if (index < 3) {
        var label = qs(".text-sm.text-on-surface-variant", card);
        var value = qs(".text-2xl", card);
        var detail = qs(".text-xs", card);
        if (label) label.textContent = kpi.label;
        if (value) value.textContent = kpi.value;
        if (detail) detail.textContent = kpi.detail;
      } else {
        var h3 = qs("h3", card);
        var p = qs("p", card);
        var button = qs("button", card);
        if (h3) h3.textContent = kpi.label;
        if (p) p.textContent = kpi.detail;
        if (button) button.textContent = kpi.value;
      }
    });

    var tbody = qs("table tbody");
    var paginationLabel = qs(".p-4.border-t span");
    var items = page.items.slice();
    var currentTab = currentQuery.category || "professional";
    var pageIndex = 0;
    var pageSize = 5;

    function renderTable(filteredItems) {
      var pageItems = filteredItems.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
      tbody.innerHTML = pageItems.length
        ? pageItems
            .map(function (item) {
              return (
                '<tr class="hover:bg-surface-bright transition-colors group">' +
                '<td class="px-5 py-4 flex items-center gap-3"><div class="w-10 h-10 rounded-md bg-surface-container-low flex items-center justify-center border border-outline-variant/10"><span class="material-symbols-outlined text-on-surface-variant text-[20px]">' +
                item.icon +
                "</span></div><div><p class=\"font-medium text-on-surface\">" +
                item.name +
                '</p><p class="text-xs text-on-surface-variant">SKU: ' +
                item.sku +
                "</p></div></td><td class=\"px-5 py-4 text-on-surface-variant\">" +
                item.brand +
                '</td><td class="px-5 py-4"><span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ' +
                toneClasses(item.stockTone) +
                '"><span class="w-1.5 h-1.5 rounded-full bg-current"></span>' +
                item.stock +
                '</span></td><td class="px-5 py-4 text-on-surface-variant">' +
                item.reorderPoint +
                '</td><td class="px-5 py-4 text-right font-medium text-on-surface">' +
                item.cost +
                '</td><td class="px-5 py-4 text-right"><button class="text-primary hover:text-primary-dim opacity-0 group-hover:opacity-100 transition-opacity" data-edit-item="' +
                item.name +
                '"><span class="material-symbols-outlined">edit</span></button></td></tr>'
              );
            })
            .join("")
        : '<tr><td colspan="6"><div class="aibeaty-empty m-4">No inventory items match this filter.</div></td></tr>';
      if (paginationLabel) {
        var start = filteredItems.length ? pageIndex * pageSize + 1 : 0;
        var end = Math.min(filteredItems.length, (pageIndex + 1) * pageSize);
        paginationLabel.textContent = "Showing " + start + "-" + end + " of " + filteredItems.length + " items";
      }
      qsa("[data-edit-item]").forEach(function (button) {
        button.addEventListener("click", function () {
          var itemName = button.dataset.editItem;
          var item = items.find(function (entry) { return entry.name === itemName; });
          if (!item) return;
          var currentStock = getNumericStockValue(item.stock);
          presentForm({
            title: "Update Inventory",
            description: item.name,
            submitLabel: "Save Stock",
            fields: [
              { name: "stock", label: "Stock Quantity", value: String(currentStock), type: "number" }
            ]
          }).then(function (values) {
            if (!values || !String(values.stock).trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/inventory/items/" + encodeURIComponent(item.sku), "PATCH", {
              stock: values.stock
            }).then(function () {
              notify("Inventory updated for " + item.name + ".");
              reload();
            }).catch(function () {
              notify("Inventory update failed.", "error");
            });
          });
        });
      });
    }

    var search = qs("header input[type='text']");
    var tabButtons = qsa(".flex.items-center.gap-2.bg-surface-container-low button");
    var navButtons = qsa(".p-1.rounded.hover\\:bg-surface-container");
    function update() {
      if (pageIndex * pageSize >= items.length) pageIndex = 0;
      renderTable(items);
    }

    update();

    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        pageIndex = 0;
        reload({ q: search.value });
      }, 180));
    }

    tabButtons.forEach(function (button, index) {
      button.addEventListener("click", function () {
        currentTab = index === 0 ? "professional" : "retail";
        tabButtons.forEach(function (node, nodeIndex) {
          node.className =
            "px-5 py-2 text-sm font-medium rounded-md transition-all " +
            (nodeIndex === index
              ? "bg-surface-container-lowest text-primary shadow-sm"
              : "text-on-surface-variant hover:text-on-surface");
        });
        pageIndex = 0;
        reload({ category: currentTab });
      });
      if ((index === 0 && currentTab === "professional") || (index === 1 && currentTab === "retail")) {
        button.className =
          "px-5 py-2 text-sm font-medium rounded-md transition-all bg-surface-container-lowest text-primary shadow-sm";
      }
    });

    if (navButtons[0]) {
      navButtons[0].addEventListener("click", function () {
        if (pageIndex > 0) pageIndex -= 1;
        update();
      });
    }
    if (navButtons[1]) {
      navButtons[1].addEventListener("click", function () {
        if ((pageIndex + 1) * pageSize < items.length) pageIndex += 1;
        update();
      });
    }

    var headerButtons = qsa("header button");
    var filterButton = headerButtons.filter(function (button) {
      var text = (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return text === "filter" || text === "filter list";
    })[0];
    if (filterButton) {
      filterButton.dataset.actionBound = "true";
      filterButton.onclick = function () {
        presentForm({
          title: "Filter Inventory",
          submitLabel: "Apply",
          fields: [
            { name: "stock", label: "Stock Status", type: "select", value: currentQuery.stock || "all", options: ["all", "low", "watch", "ok"] }
          ]
        }).then(function (values) {
          if (!values) return;
          pageIndex = 0;
          reload({ stock: values.stock });
        });
      };
    }

    var shipmentWrap = qs(".flex-1.overflow-y-auto.pr-2.space-y-6");
    if (shipmentWrap) {
      shipmentWrap.innerHTML = page.shipments
        .map(function (item) {
          return (
            '<div class="relative pl-8"><div class="absolute left-0 top-1 w-6 h-6 rounded-full bg-surface-container-lowest border-2 border-primary flex items-center justify-center z-10"><div class="w-2 h-2 rounded-full bg-primary"></div></div><div class="bg-surface-container-lowest p-3 rounded-lg border border-surface-container-highest shadow-sm"><div class="flex justify-between items-start mb-1"><p class="text-sm font-medium text-on-surface">' +
            item.title +
            '</p><span class="text-xs text-on-surface-variant">' +
            item.time +
            '</span></div><p class="text-xs text-on-surface-variant">' +
            item.meta +
            '</p><div class="mt-2 flex gap-2"><span class="px-2 py-1 rounded-full bg-surface-container text-[10px] font-bold text-on-surface-variant">' +
            item.status +
            "</span></div></div></div>"
          );
        })
        .join("");
    }

    var createPoButton = qsa(".grid.grid-cols-1.md\\:grid-cols-4 > div button")[0];
    if (createPoButton) {
      createPoButton.dataset.actionBound = "true";
      createPoButton.addEventListener("click", function () {
        mutateJson(apiBase.replace(/\/$/, "") + "/inventory/restock-orders", "POST", {
          scope: currentTab
        }).then(function () {
          notify("Restock order created from live backend.");
          reload();
        }).catch(function () {
          notify("Restock order request failed.", "error");
        });
      });
    }
  }

  function renderServices(page) {
    function syncPage(nextPage) {
      renderServices(nextPage);
      bindStaticButtons();
    }

    var title = qs("main h2.text-3xl");
    var subtitle = title && title.parentElement ? title.parentElement.querySelector("p") : null;
    if (title) title.textContent = page.title;
    if (subtitle) subtitle.textContent = page.subtitle;
    setSearchPlaceholder(page.searchPlaceholder);

    var categoryWrap = qs("main .space-y-6");
    var panel = qs(".w-96.shrink-0");
    var editor = page.editor;
    var selectedServiceId = editor && editor.id ? editor.id : null;

    function fillEditor(service, categoryName) {
      if (!panel) return;
      var inputs = qsa("input, textarea, select", panel);
      selectedServiceId = service.id || selectedServiceId;
      if (inputs[0]) inputs[0].value = service.name;
      if (inputs[1]) inputs[1].value = categoryName;
      if (inputs[2]) inputs[2].value = service.description || editor.description;
      if (inputs[3]) inputs[3].value = (service.duration || "60").replace(/\D/g, "");
      if (inputs[4]) inputs[4].value = service.processingTime || editor.processingTime;
      if (inputs[5]) inputs[5].value = (service.price || "").replace(/[^0-9.]/g, "");
      if (inputs[6]) inputs[6].value = (service.commission || "").replace("%", "");
    }

    if (categoryWrap) {
      categoryWrap.innerHTML = page.categories
        .map(function (category, categoryIndex) {
          var toneBg = category.tone === "tertiary" ? "bg-tertiary-container text-tertiary" : "bg-primary-container text-primary";
          var rows = category.services
            .map(function (service, serviceIndex) {
              var active = categoryIndex === 0 && serviceIndex === 0;
              return (
                '<button class="service-row group grid grid-cols-12 gap-4 px-4 py-3 items-center rounded-lg w-full text-left ' +
                (active
                  ? "bg-surface-container-low/50 border border-outline-variant/20"
                  : "hover:bg-surface-container-low transition-colors cursor-pointer border border-transparent") +
                '" data-service-name="' +
                service.name.toLowerCase() +
                '" data-service-id="' +
                (service.id || "") +
                '" data-category-name="' +
                category.name +
                '">' +
                '<div class="col-span-5 flex items-center gap-3"><div class="w-2 h-2 rounded-full ' +
                (active ? "bg-primary" : "bg-surface-container-high group-hover:bg-outline-variant transition-colors") +
                '"></div><span class="font-body text-sm font-medium text-on-surface">' +
                service.name +
                '</span></div><div class="col-span-2 text-right font-body text-sm text-on-surface-variant">' +
                service.duration +
                '</div><div class="col-span-2 text-right font-headline text-sm font-semibold text-on-surface">' +
                service.price +
                '</div><div class="col-span-2 text-right font-body text-sm ' +
                (category.tone === "tertiary" ? "text-tertiary" : "text-secondary") +
                ' font-medium">' +
                service.commission +
                '</div><div class="col-span-1 flex justify-end"><span class="text-slate-400 group-hover:text-primary transition-colors p-1"><span class="material-symbols-outlined text-lg">edit</span></span></div></button>'
              );
            })
            .join("");
          return (
            '<div class="service-category bg-surface-container-lowest rounded-xl p-6 shadow-sm border border-outline-variant/10" data-category-name="' +
            category.name.toLowerCase() +
            '"><div class="flex items-center justify-between mb-4 border-b border-surface-container-low pb-4"><h3 class="font-headline text-lg font-bold text-on-surface flex items-center gap-2"><div class="w-8 h-8 rounded ' +
            toneBg +
            ' flex items-center justify-center"><span class="material-symbols-outlined text-lg">' +
            category.icon +
            '</span></div>' +
            category.name +
            '</h3><span class="px-2.5 py-1 rounded-full bg-surface-container-low text-on-surface-variant font-body text-xs font-semibold">' +
            category.badge +
            '</span></div><div class="space-y-0"><div class="grid grid-cols-12 gap-4 px-4 py-2 text-xs font-headline font-semibold text-on-surface-variant uppercase tracking-wider"><div class="col-span-5">Service Name</div><div class="col-span-2 text-right">Duration</div><div class="col-span-2 text-right">Price</div><div class="col-span-2 text-right">Commission</div><div class="col-span-1 text-center"></div></div>' +
            rows +
            '</div><button class="w-full mt-2 py-3 flex items-center justify-center gap-2 text-primary text-sm font-headline font-semibold hover:bg-primary-container/20 rounded-md transition-colors" data-expand-category="' +
            category.name +
            '">View All ' +
            category.name +
            ' <span class="material-symbols-outlined text-sm">expand_more</span></button></div>'
          );
        })
        .join("");
    }

    if (panel && editor) {
      fillEditor(
        {
          id: editor.id,
          name: editor.name,
          duration: editor.duration + " min",
          price: "$" + editor.price,
          commission: editor.commission + "%",
          description: editor.description,
          processingTime: editor.processingTime
        },
        editor.category
      );
    }

    qsa(".service-row").forEach(function (button) {
      button.addEventListener("click", function () {
        var categoryName = button.dataset.categoryName;
        var serviceName = button.dataset.serviceName;
        var category = page.categories.find(function (item) {
          return item.name === categoryName;
        });
        var service = category && category.services.find(function (item) {
          return item.name.toLowerCase() === serviceName;
        });
        qsa(".service-row").forEach(function (row) {
          row.classList.remove("bg-surface-container-low/50", "border-outline-variant/20");
          row.classList.add("border-transparent");
        });
        button.classList.add("bg-surface-container-low/50", "border-outline-variant/20");
        if (service) fillEditor(service, categoryName);
      });
    });

    qsa("[data-expand-category]").forEach(function (button) {
      button.addEventListener("click", function () {
        notify("Full category table for " + button.dataset.expandCategory + " is queued for backend pagination.");
      });
    });

    var search = qs("header input[type='text']");
    if (search) {
      search.addEventListener("input", function () {
        var term = search.value.trim().toLowerCase();
        qsa(".service-category").forEach(function (category) {
          var matched = false;
          qsa(".service-row", category).forEach(function (row) {
            var visible = !term || row.dataset.serviceName.indexOf(term) !== -1;
            row.style.display = visible ? "" : "none";
            if (visible) matched = true;
          });
          category.style.display = matched ? "" : "none";
        });
      });
    }

    if (panel) {
      var actionButtons = qsa(".p-6.border-t button", panel);
      var cancelButton = actionButtons[0];
      var saveButton = actionButtons[1];
      if (cancelButton) {
        cancelButton.dataset.actionBound = "true";
        cancelButton.onclick = function () {
          notify("Editor changes discarded.");
          if (editor) {
            fillEditor(
              {
                id: editor.id,
                name: editor.name,
                duration: editor.duration + " min",
                price: "$" + editor.price,
                commission: editor.commission + "%",
                description: editor.description,
                processingTime: editor.processingTime
              },
              editor.category
            );
          }
        };
      }
      if (saveButton) {
        saveButton.dataset.actionBound = "true";
        saveButton.onclick = function () {
          if (!selectedServiceId) {
            notify("Select a service first.", "error");
            return;
          }
          var inputs = qsa("input, textarea, select", panel);
          mutateJson(apiBase.replace(/\/$/, "") + "/services/" + encodeURIComponent(selectedServiceId), "PATCH", {
            name: inputs[0] ? inputs[0].value.trim() : "",
            category: inputs[1] ? inputs[1].value.trim() : "",
            description: inputs[2] ? inputs[2].value.trim() : "",
            duration: inputs[3] ? inputs[3].value.trim() : "",
            processingTime: inputs[4] ? inputs[4].value.trim() : "",
            price: inputs[5] ? inputs[5].value.trim() : "",
            commission: inputs[6] ? inputs[6].value.trim() : ""
          }).then(function (payload) {
            notify("Service saved on live backend.");
            syncPage(payload.page);
          }).catch(function () {
            notify("Service save failed.", "error");
          });
        };
      }
    }
  }

  function renderClients(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      status: page.liveQuery && page.liveQuery.status ? page.liveQuery.status : "all",
      clientId: page.liveQuery && page.liveQuery.clientId ? page.liveQuery.clientId : ""
    };

    function syncPage(nextPage) {
      renderClients(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    var title = qs("main h1.text-3xl");
    var subtitle = title && title.parentElement ? title.parentElement.querySelector("p") : null;
    if (title) title.textContent = page.title;
    if (subtitle) subtitle.textContent = page.subtitle;
    setSearchPlaceholder(page.searchPlaceholder);

    var listWrap = qs(".flex-1.overflow-y-auto.pr-2.space-y-3.pb-8");
    var detail = qs(".hidden.lg\\:flex.flex-1.flex-col.h-full");
    if (!listWrap || !detail) return;
    var listHeader = listWrap.parentElement;
    var headerActions = listHeader ? qs(".flex.justify-between.items-end.mb-6.shrink-0", listHeader) : null;
    if (headerActions && !qs("[data-create-client]", headerActions)) {
      var createButton = document.createElement("button");
      createButton.className = "px-4 py-2 bg-gradient-to-r from-primary to-primary-dim text-on-primary rounded-md font-medium text-sm hover:opacity-90 transition-opacity shadow-sm";
      createButton.textContent = "New Client";
      createButton.dataset.createClient = "true";
      headerActions.appendChild(createButton);
    }

    function renderClientList(clients, selectedId) {
      listWrap.innerHTML = clients.length
        ? clients
            .map(function (client) {
              var active = client.id === selectedId;
              return (
                '<button class="' +
                (active
                  ? "bg-surface-container-lowest p-4 rounded-xl cursor-pointer shadow-[0_2px_8px_rgba(44,47,48,0.04)] border border-primary/20 relative overflow-hidden group w-full text-left"
                  : "bg-surface-container-lowest p-4 rounded-xl cursor-pointer hover:bg-surface-bright transition-colors border border-outline-variant/10 group w-full text-left") +
                '" data-client-id="' +
                client.id +
                '">' +
                (active ? '<div class="absolute left-0 top-0 bottom-0 w-1 bg-primary"></div>' : "") +
                '<div class="flex items-center justify-between"><div class="flex items-center gap-4"><img alt="Client" class="w-12 h-12 rounded-full object-cover" src="' +
                client.avatar +
                '"/><div><h3 class="font-headline font-semibold text-base text-on-surface">' +
                client.name +
                '</h3><p class="text-sm text-on-surface-variant">Last visit: ' +
                client.lastVisit +
                '</p></div></div><div class="flex flex-col items-end gap-2"><span class="px-2 py-1 text-xs font-semibold rounded-md tracking-wide ' +
                tagClasses(client.statusTone) +
                '">' +
                client.status +
                "</span></div></div></button>"
              );
            })
            .join("")
        : '<div class="aibeaty-empty">No clients match this search.</div>';
    }

    function renderClientDetail(client) {
      var avatar = qs(".p-8.border-b img", detail);
      var name = qs(".p-8.border-b h2", detail);
      var badge = qs(".p-8.border-b .px-2\\.5");
      var meta = qs(".p-8.border-b p.text-on-surface-variant");
      var stats = qsa(".grid.grid-cols-3 .text-2xl", detail);
      var formulaBoxes = qsa(".font-mono", detail);
      var prefsWrap = qsa("section", detail)[1];
      var historyWrap = qs(".relative.border-l", detail);
      if (avatar) avatar.src = client.avatar;
      if (name) name.textContent = client.name;
      if (badge) {
        badge.textContent = client.status;
        badge.className = "px-2.5 py-1 text-xs font-semibold rounded-md tracking-wide " + tagClasses(client.statusTone);
      }
      if (meta) {
        meta.innerHTML =
          '<span class="material-symbols-outlined text-sm">phone_iphone</span> ' +
          client.phone +
          '<span class="text-outline-variant">•</span><span class="material-symbols-outlined text-sm">mail</span> ' +
          client.email;
      }
      if (stats[0]) stats[0].textContent = client.ltv;
      if (stats[1]) stats[1].textContent = client.visitsYtd;
      if (stats[2]) stats[2].textContent = client.avgTicket;
      if (formulaBoxes[0]) formulaBoxes[0].textContent = client.formulaBase;
      if (formulaBoxes[1]) formulaBoxes[1].textContent = client.formulaHighlights;
      if (prefsWrap) {
        var chipContainer = qs(".flex.flex-wrap.gap-2", prefsWrap);
        if (chipContainer) {
          chipContainer.innerHTML = client.preferences
            .map(function (pref) {
              return '<span class="px-3 py-1.5 bg-surface-container text-on-surface text-sm rounded-full border border-outline-variant/20">' + pref + "</span>";
            })
            .join("");
        }
      }
      if (historyWrap) {
        historyWrap.innerHTML = client.history.length
          ? client.history
              .map(function (item, index) {
                return (
                  '<div class="relative pl-6"><div class="absolute w-3 h-3 ' +
                  (index === 0 ? "bg-primary" : "bg-surface-container-high") +
                  ' rounded-full -left-[6.5px] top-1.5 ring-4 ring-background"></div><div class="bg-surface-container-lowest p-4 rounded-xl border border-outline-variant/10 ' +
                  (index === 0 ? "shadow-[0_2px_8px_rgba(44,47,48,0.02)]" : "") +
                  '"><div class="flex justify-between items-start mb-2"><p class="font-medium text-on-surface text-sm">' +
                  item.service +
                  '</p><p class="text-xs text-on-surface-variant">' +
                  item.date +
                  '</p></div><p class="text-xs text-on-surface-variant mb-3">Stylist: ' +
                  item.stylist +
                  '</p><div class="flex justify-between items-center mt-3 pt-3 border-t border-outline-variant/10"><span class="text-sm font-semibold text-on-surface">' +
                  item.amount +
                  "</span></div></div></div>"
                );
              })
              .join("")
          : '<div class="aibeaty-empty">No visit history yet.</div>';
      }
    }

    var selectedId = page.selectedClientId || currentQuery.clientId || (page.clients[0] ? page.clients[0].id : null);
    var filtered = page.clients.slice();

    function bindDetailActions(client) {
      var headerButtons = qsa(".p-8.border-b button", detail);
      var editProfileButton = headerButtons[0];
      var bookButton = headerButtons[1];
      var actionRow = editProfileButton ? editProfileButton.parentElement : null;
      var formulaEditButton = qsa("section button", detail)[0];

      if (editProfileButton) {
        editProfileButton.dataset.actionBound = "true";
        editProfileButton.onclick = function () {
          presentForm({
            title: "Edit Client",
            submitLabel: "Save Client",
            fields: [
              { name: "name", label: "Client Name", value: client.name },
              { name: "email", label: "Email", value: client.email, type: "email" },
              { name: "phone", label: "Phone", value: client.phone, type: "tel" },
              { name: "status", label: "Status", type: "select", value: client.status, options: ["VIP", "REGULAR", "NEW", "AT-RISK"] },
              { name: "preferences", label: "Preferences", value: (client.preferences || []).join(", ") }
            ]
          }).then(function (values) {
            if (!values || !values.name.trim() || !values.email.trim() || !values.phone.trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/clients/" + encodeURIComponent(client.id), "PATCH", {
              name: values.name,
              email: values.email,
              phone: values.phone,
              status: values.status,
              preferences: values.preferences
            }).then(function (payload) {
              notify("Client updated on live backend.");
              reload({ clientId: payload.clientId || client.id });
            }).catch(function () {
              notify("Client update failed.", "error");
            });
          });
        };
      }

      if (bookButton) {
        bookButton.dataset.actionBound = "true";
        bookButton.onclick = function () {
          presentForm({
            title: "Book Client Visit",
            description: client.name,
            submitLabel: "Create Booking",
            fields: [
              { name: "service", label: "Service", value: "Signature Color Refresh" },
              { name: "stylist", label: "Stylist", value: "Sarah J." },
              { name: "date", label: "Booking Date", value: new Date().toISOString().slice(0, 10), type: "date" },
              { name: "slot", label: "Time Slot", value: "11:00-12:00" },
              { name: "amount", label: "Ticket Amount", value: String((client.avgTicket || "$0").replace(/[^0-9.]/g, "") || "120"), type: "number" }
            ]
          }).then(function (values) {
            if (!values || !values.service.trim() || !values.stylist.trim() || !values.date.trim() || !values.slot.trim() || !values.amount.trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/clients/" + encodeURIComponent(client.id) + "/bookings", "POST", {
              service: values.service,
              stylist: values.stylist,
              date: values.date,
              slot: values.slot,
              amount: values.amount
            }).then(function (payload) {
              notify("Booking saved on live backend.");
              reload({ clientId: payload.clientId || client.id });
            }).catch(function () {
              notify("Booking creation failed.", "error");
            });
          });
        };
      }

      var openInboxButton = ensureActionButton(
        actionRow,
        "client-open-inbox",
        "Open Inbox",
        "px-4 py-2 bg-surface-container-lowest border border-outline-variant/20 rounded-md text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors shadow-sm"
      );
      if (openInboxButton) {
        openInboxButton.onclick = function () {
          navigateToScreen("unified-inbox-luminous-core.html", { clientId: client.id });
        };
      }

      var openScheduleButton = ensureActionButton(
        actionRow,
        "client-open-schedule",
        "View Schedule",
        "px-4 py-2 bg-surface-container-lowest border border-outline-variant/20 rounded-md text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors shadow-sm"
      );
      if (openScheduleButton) {
        openScheduleButton.onclick = function () {
          navigateToScreen("stylist-schedule-luminous-core.html", { clientId: client.id });
        };
      }

      if (formulaEditButton) {
        formulaEditButton.dataset.actionBound = "true";
        formulaEditButton.onclick = function () {
          presentForm({
            title: "Edit Formula Notes",
            description: client.name,
            submitLabel: "Save Formula",
            fields: [
              { name: "formulaBase", label: "Base Formula", value: client.formulaBase, type: "textarea" },
              { name: "formulaHighlights", label: "Highlights / Notes", value: client.formulaHighlights, type: "textarea" }
            ]
          }).then(function (values) {
            if (!values) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/clients/" + encodeURIComponent(client.id), "PATCH", {
              formulaBase: values.formulaBase,
              formulaHighlights: values.formulaHighlights
            }).then(function (payload) {
              notify("Formula notes saved on live backend.");
              reload({ clientId: payload.clientId || client.id });
            }).catch(function () {
              notify("Formula update failed.", "error");
            });
          });
        };
      }
    }

    function update() {
      renderClientList(filtered, selectedId);
      var client = filtered.find(function (item) { return item.id === selectedId; }) || filtered[0];
      if (client) {
        selectedId = client.id;
        currentQuery.clientId = selectedId;
        syncCurrentScreenQuery(currentQuery);
        renderClientDetail(client);
        bindDetailActions(client);
      }
      qsa("[data-client-id]", listWrap).forEach(function (button) {
        button.addEventListener("click", function () {
          selectedId = button.dataset.clientId;
          update();
        });
      });
    }

    update();

    var createClientButton = qs("[data-create-client]", headerActions);
    if (createClientButton) {
      createClientButton.dataset.actionBound = "true";
      createClientButton.onclick = function () {
        presentForm({
          title: "New Client",
          submitLabel: "Create Client",
          fields: [
            { name: "name", label: "Client Name", value: "" },
            { name: "email", label: "Email", value: "", type: "email" },
            { name: "phone", label: "Phone", value: "", type: "tel" },
            { name: "status", label: "Status", type: "select", value: "NEW", options: ["VIP", "REGULAR", "NEW", "AT-RISK"] },
            { name: "preferences", label: "Preferences", value: "Text confirmations" }
          ]
        }).then(function (values) {
          if (!values || !values.name.trim() || !values.email.trim() || !values.phone.trim()) return;
          mutateJson(apiBase.replace(/\/$/, "") + "/clients", "POST", {
            name: values.name,
            email: values.email,
            phone: values.phone,
            status: values.status,
            preferences: values.preferences
          }).then(function (payload) {
            notify("Client created on live backend.");
            reload({ clientId: payload.clientId || "" });
          }).catch(function () {
            notify("Client creation failed.", "error");
          });
        });
      };
    }

    if (headerActions && !qs("[data-client-filter]", headerActions)) {
      var filterButton = document.createElement("button");
      filterButton.className = "px-4 py-2 rounded-md border border-outline-variant/20 text-on-surface-variant font-medium text-sm hover:bg-surface-container-low transition-colors";
      filterButton.textContent = "Filter";
      filterButton.dataset.clientFilter = "true";
      headerActions.appendChild(filterButton);
    }
    var clientFilterButton = headerActions ? qs("[data-client-filter]", headerActions) : null;
    if (clientFilterButton) {
      clientFilterButton.dataset.actionBound = "true";
      clientFilterButton.onclick = function () {
        presentForm({
          title: "Filter Clients",
          submitLabel: "Apply Filter",
          fields: [
            { name: "status", label: "Status", type: "select", value: currentQuery.status || "all", options: ["all", "vip", "regular", "new", "at-risk"] }
          ]
        }).then(function (values) {
          if (!values) return;
          reload({ status: values.status });
        });
      };
    }

    var search = qs("header input[type='text']");
    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        reload({ q: search.value });
      }, 180));
    }
  }

  function renderInbox(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      channel: page.liveQuery && page.liveQuery.channel ? page.liveQuery.channel : "all",
      clientId: page.liveQuery && page.liveQuery.clientId ? page.liveQuery.clientId : "",
      conversationId: page.liveQuery && page.liveQuery.conversationId ? page.liveQuery.conversationId : ""
    };

    function syncPage(nextPage) {
      renderInbox(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    var leftPane = qs("main > aside");
    var centerPane = qsa("main > section")[0];
    var rightPane = qsa("main > aside")[1];
    if (!leftPane || !centerPane || !rightPane) return;
    setSearchPlaceholder(page.searchPlaceholder);

    var listWrap = qs(".flex-1.overflow-y-auto", leftPane);
    var activeId = page.selectedConversationId || currentQuery.conversationId || (page.conversations[0] ? page.conversations[0].id : null);
    var filtered = page.conversations.slice();
    var paneHeader = qs(".h-16.flex.items-center.justify-between", leftPane);
    if (paneHeader && !qs("[data-create-conversation]", paneHeader)) {
      var newThreadButton = document.createElement("button");
      newThreadButton.className = "px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-semibold hover:bg-primary/15 transition-colors";
      newThreadButton.textContent = "New Thread";
      newThreadButton.dataset.createConversation = "true";
      paneHeader.insertBefore(newThreadButton, paneHeader.lastElementChild);
    }

    function renderConversationList(items, selectedId) {
      listWrap.innerHTML = items.length
        ? items
            .map(function (conversation) {
              var active = conversation.id === selectedId;
              var channelBadge =
                conversation.channelTone === "instagram"
                  ? '<div class="absolute -bottom-1 -right-1 w-4 h-4 bg-gradient-to-tr from-[#f9ce34] via-[#ee2a7b] to-[#6228d7] rounded-full border border-surface-container-lowest flex items-center justify-center"><span class="material-symbols-outlined text-[10px] text-white" style="font-variation-settings: \'FILL\' 1;">photo_camera</span></div>'
                  : '<div class="absolute -bottom-1 -right-1 w-4 h-4 bg-[#25D366] rounded-full border border-surface-container-lowest flex items-center justify-center"><span class="material-symbols-outlined text-[10px] text-white" style="font-variation-settings: \'FILL\' 1;">chat</span></div>';
              var avatar =
                conversation.avatar
                  ? '<img alt="Client Avatar" class="w-10 h-10 rounded-full object-cover" src="' + conversation.avatar + '"/>'
                  : '<div class="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center text-on-secondary-container font-headline font-bold">' + conversation.avatarText + "</div>";
              return (
                '<div class="px-3 py-1"><button class="w-full text-left flex items-start gap-3 p-3 rounded-lg ' +
                (active ? "bg-primary-container/10 border-l-2 border-primary" : "hover:bg-surface-container-low transition-colors group") +
                '" data-conversation-id="' +
                conversation.id +
                '">' +
                '<div class="relative flex-shrink-0">' +
                avatar +
                channelBadge +
                '</div><div class="flex-1 min-w-0"><div class="flex justify-between items-center mb-0.5"><span class="font-semibold text-sm text-on-surface truncate">' +
                conversation.name +
                '</span><span class="text-[11px] ' +
                (active ? "font-medium text-primary" : "text-on-surface-variant") +
                '">' +
                conversation.time +
                '</span></div><p class="text-xs text-on-surface-variant truncate">' +
                conversation.preview +
                "</p></div></button></div>"
              );
            })
            .join("")
        : '<div class="px-3"><div class="aibeaty-empty">No conversations match this search.</div></div>';
    }

    function renderMessages(conversation) {
      var centerChildren = qsa(":scope > *", centerPane);
      var header = centerChildren[0];
      var messageArea = centerChildren[1];
      var inputArea = centerChildren[2];
      qs("h2", header).textContent = conversation.name;
      var status = qs(".text-xs.font-medium", header);
      if (status) status.textContent = conversation.status;
      var inputButtons = qsa("button", inputArea);
      var textarea = qs("textarea", inputArea);
      if (textarea) {
        textarea.disabled = false;
        textarea.placeholder = "Type a message...";
      }
      inputButtons.forEach(function (button) {
        setButtonDisabled(button, false);
      });
      messageArea.innerHTML = conversation.messages
        .map(function (message) {
          if (message.type === "system") {
            return '<div class="flex justify-center"><div class="bg-surface-container-low text-xs text-on-surface-variant px-4 py-2 rounded-lg text-center max-w-sm">' + message.text + "</div></div>";
          }
          if (message.type === "outgoing") {
            return '<div class="flex justify-end gap-3"><div class="flex flex-col items-end gap-1 max-w-[70%]"><div class="bg-surface text-on-surface px-4 py-3 rounded-2xl rounded-tr-sm text-sm border border-outline-variant/10">' + message.text + '</div><span class="text-[10px] text-on-surface-variant font-medium">' + message.meta + "</span></div></div>";
          }
          return '<div class="flex justify-start gap-3">' +
            (conversation.avatar ? '<img alt="' + conversation.name + '" class="w-8 h-8 rounded-full object-cover mt-1" src="' + conversation.avatar + '"/>' : '<div class="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center text-xs font-bold text-on-secondary-container mt-1">' + conversation.avatarText + '</div>') +
            '<div class="flex flex-col items-start gap-1 max-w-[70%]"><div class="bg-surface-container-low text-on-surface px-4 py-3 rounded-2xl rounded-tl-sm text-sm">' + message.text + '</div><span class="text-[10px] text-on-surface-variant font-medium">' + message.meta + "</span></div></div>";
        })
        .join("");

      var suggestionsWrap = qs(".flex.gap-2.mb-3", inputArea);
      if (suggestionsWrap) {
        suggestionsWrap.innerHTML =
          '<span class="material-symbols-outlined text-tertiary text-[18px] flex-shrink-0 mt-0.5">auto_awesome</span>' +
          conversation.suggestions
            .map(function (text) {
              return '<button class="aibeaty-suggestion flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-full bg-tertiary-container/30 text-on-tertiary-container border border-tertiary-container/50 hover:bg-tertiary-container/50 transition-colors" data-text="' + text.replace(/"/g, "&quot;") + '">' + text + "</button>";
            })
            .join("");
        textarea = qs("textarea", inputArea);
        qsa(".aibeaty-suggestion", suggestionsWrap).forEach(function (button) {
          button.addEventListener("click", function () {
            if (textarea) textarea.value = button.dataset.text;
          });
        });
        var sendButton = qsa("button", inputArea).slice(-1)[0];
        if (sendButton && textarea) {
          sendButton.dataset.actionBound = "true";
          sendButton.onclick = function () {
            var text = textarea.value.trim();
            if (!text) {
              notify("Type a reply first.");
              return;
            }
            mutateJson(apiBase.replace(/\/$/, "") + "/inbox/conversations/" + encodeURIComponent(conversation.id) + "/messages", "POST", {
              text: text,
              type: "outgoing"
            }).then(function (payload) {
              textarea.value = "";
              notify("Reply sent through live backend.");
              reload({ conversationId: payload.conversationId || conversation.id, clientId: conversation.clientId || currentQuery.clientId || "" });
            }).catch(function () {
              notify("Reply send failed.", "error");
            });
          };
        }
      }
    }

    function renderEmptyConversationState() {
      var centerChildren = qsa(":scope > *", centerPane);
      var header = centerChildren[0];
      var messageArea = centerChildren[1];
      var inputArea = centerChildren[2];
      var title = qs("h2", header);
      var status = qs(".text-xs.font-medium", header);
      if (title) title.textContent = currentQuery.clientId ? "No linked thread" : "No conversation selected";
      if (status) {
        status.textContent = currentQuery.clientId
          ? "This client has no matching inbox thread yet."
          : "No conversations match the current filters.";
      }
      if (messageArea) {
        messageArea.innerHTML = '<div class="h-full flex items-center justify-center"><div class="aibeaty-empty">' +
          (currentQuery.clientId
            ? "No inbox thread is linked to this client yet."
            : "No conversations match this search.") +
          "</div></div>";
      }
      if (inputArea) {
        var suggestionsWrap = qs(".flex.gap-2.mb-3", inputArea);
        var textarea = qs("textarea", inputArea);
        if (suggestionsWrap) suggestionsWrap.innerHTML = "";
        if (textarea) {
          textarea.value = "";
          textarea.disabled = true;
          textarea.placeholder = "No conversation selected";
        }
        qsa("button", inputArea).forEach(function (button) {
          setButtonDisabled(button, true);
        });
      }

      var heading = qs(".font-headline.font-extrabold.text-xl", rightPane);
      var stats = qsa(".font-headline.font-extrabold.text-2xl", rightPane);
      var cadence = qs(".text-\\[10px\\].text-on-surface-variant.mt-1", rightPane);
      var todayService = qs(".font-headline.font-bold.text-sm", rightPane);
      var visitRow = qsa(".flex.justify-between.items-center.text-sm", rightPane)[0];
      var stylistText = qs(".text-xs.text-on-surface-variant", rightPane);
      var detailRows = qsa(".space-y-3 > div.flex.items-center.gap-3", rightPane);
      var pref = qs(".inline-flex.items-center", rightPane);
      var historyWrap = qsa(".space-y-3", rightPane).slice(-1)[0];
      if (heading) heading.textContent = currentQuery.clientId ? "No linked client thread" : "No conversation selected";
      if (stats[0]) stats[0].textContent = "--";
      if (stats[1]) stats[1].textContent = "--";
      if (cadence) cadence.textContent = currentQuery.clientId ? "Create a thread from inbox to start continuity." : "Adjust filters or search to find a conversation.";
      if (todayService) todayService.textContent = "No active booking";
      if (visitRow) {
        var visitSpans = qsa("span", visitRow);
        if (visitSpans[0]) visitSpans[0].textContent = "--";
        if (visitSpans[1]) visitSpans[1].textContent = "--";
      }
      if (stylistText) stylistText.textContent = "with no stylist assigned";
      if (detailRows[0]) qs("span.text-sm", detailRows[0]).textContent = "--";
      if (detailRows[1]) qs("span.text-sm", detailRows[1]).textContent = "--";
      if (pref) pref.textContent = "No preference";
      if (historyWrap) historyWrap.innerHTML = '<div class="aibeaty-empty">No visit history for this selection.</div>';
      qsa("button", rightPane).forEach(function (button) {
        setButtonDisabled(button, true);
      });
    }

    function renderProfile(conversation) {
      qsa("button", rightPane).forEach(function (button) {
        setButtonDisabled(button, false);
      });
      qs(".font-headline.font-extrabold.text-xl", rightPane).textContent = conversation.name;
      var stats = qsa(".font-headline.font-extrabold.text-2xl", rightPane);
      if (stats[0]) stats[0].textContent = conversation.ltv;
      if (stats[1]) stats[1].textContent = conversation.visits;
      var cadence = qs(".text-\\[10px\\].text-on-surface-variant.mt-1", rightPane);
      if (cadence) cadence.textContent = conversation.visitCadence;
      var todayService = qs(".font-headline.font-bold.text-sm", rightPane);
      if (todayService) todayService.textContent = conversation.todayVisit.service;
      var visitRow = qsa(".flex.justify-between.items-center.text-sm", rightPane)[0];
      if (visitRow) {
        var spans = qsa("span", visitRow);
        if (spans[0]) spans[0].textContent = conversation.todayVisit.time;
        if (spans[1]) spans[1].textContent = conversation.todayVisit.amount;
      }
      var stylistText = qs(".text-xs.text-on-surface-variant", rightPane);
      if (stylistText) stylistText.textContent = "with " + conversation.todayVisit.stylist;
      var detailRows = qsa(".space-y-3 > div.flex.items-center.gap-3", rightPane);
      if (detailRows[0]) qs("span.text-sm", detailRows[0]).textContent = conversation.contact.phone;
      if (detailRows[1]) qs("span.text-sm", detailRows[1]).textContent = conversation.contact.email;
      var pref = qs(".inline-flex.items-center", rightPane);
      if (pref) pref.textContent = conversation.contact.preference;
      var historyWrap = qsa(".space-y-3", rightPane).slice(-1)[0];
      if (historyWrap) {
        historyWrap.innerHTML = conversation.history.length
          ? conversation.history
              .map(function (item) {
                return '<div class="flex gap-3 items-start"><div class="w-8 h-8 rounded bg-surface-container flex flex-col items-center justify-center flex-shrink-0"><span class="text-[10px] font-bold text-on-surface-variant uppercase">' + item.date.split(" ")[0] + '</span><span class="text-sm font-headline font-bold text-on-surface leading-none">' + item.date.split(" ")[1] + '</span></div><div><h4 class="text-sm font-semibold text-on-surface">' + item.service + '</h4><p class="text-xs text-on-surface-variant mt-0.5">' + item.notes + "</p></div></div>";
              })
              .join("")
          : '<div class="aibeaty-empty">No history yet.</div>';
      }

      var actionButtons = qsa("button", rightPane);
      var viewProfileButton = actionButtons.filter(function (button) {
        return button.textContent.trim().toLowerCase() === "view profile";
      })[0];
      var actionRow = viewProfileButton ? viewProfileButton.parentElement : null;
      if (viewProfileButton) {
        viewProfileButton.textContent = "View Profile";
        viewProfileButton.dataset.actionBound = "true";
        viewProfileButton.onclick = function () {
          if (!conversation.clientId) {
            notify("No linked client profile for this thread.", "error");
            return;
          }
          navigateToScreen("client-directory-luminous-core.html", { clientId: conversation.clientId });
        };
      }

      var bookVisitButton = ensureActionButton(
        actionRow,
        "inbox-book-visit",
        "Book Visit",
        "px-4 py-1.5 bg-surface-container-lowest border border-outline-variant/20 rounded-md text-xs font-semibold text-on-surface hover:bg-surface-container-high transition-colors shadow-sm"
      );
      if (bookVisitButton) {
        bookVisitButton.onclick = function () {
          var defaultService = conversation.todayVisit && conversation.todayVisit.service && conversation.todayVisit.service !== "No service booked"
            ? conversation.todayVisit.service
            : "Consultation";
          var defaultStylist = conversation.todayVisit && conversation.todayVisit.stylist && conversation.todayVisit.stylist !== "TBD"
            ? conversation.todayVisit.stylist
            : "Front Desk";
          var defaultSlot = conversation.todayVisit && conversation.todayVisit.time && conversation.todayVisit.time !== "No active booking"
            ? conversation.todayVisit.time
            : "11:00-12:00";
          var defaultAmount = conversation.todayVisit && conversation.todayVisit.amount && conversation.todayVisit.amount !== "$0"
            ? conversation.todayVisit.amount.replace(/^\$/, "")
            : "95";
          presentForm({
            title: "Book Visit From Thread",
            description: conversation.name,
            submitLabel: "Book Visit",
            fields: [
              { name: "service", label: "Service", value: defaultService },
              { name: "stylist", label: "Stylist", value: defaultStylist },
              { name: "slot", label: "Time Slot", value: defaultSlot },
              { name: "amount", label: "Amount", value: defaultAmount, type: "number" }
            ]
          }).then(function (values) {
            if (!values || !values.service.trim() || !values.stylist.trim() || !values.slot.trim() || !values.amount.trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/inbox/conversations/" + encodeURIComponent(conversation.id) + "/bookings", "POST", {
              service: values.service,
              stylist: values.stylist,
              slot: values.slot,
              amount: values.amount
            }).then(function (payload) {
              notify("Inbox booking created on live backend.");
              reload({
                conversationId: payload.conversationId || conversation.id,
                clientId: payload.booking && payload.booking.clientId ? payload.booking.clientId : (conversation.clientId || currentQuery.clientId || "")
              });
            }).catch(function () {
              notify("Inbox booking failed.", "error");
            });
          });
        };
      }
      var editNotesButton = actionButtons.filter(function (button) {
        return button.textContent.trim().toLowerCase() === "edit notes";
      })[0];
      if (editNotesButton) {
        editNotesButton.dataset.actionBound = "true";
        editNotesButton.onclick = function () {
          var currentNote = conversation.history[0] ? conversation.history[0].notes : "";
          presentForm({
            title: "Update Conversation Notes",
            description: conversation.name,
            submitLabel: "Save Notes",
            fields: [
              { name: "note", label: "Latest Note", value: currentNote, type: "textarea" },
              { name: "preference", label: "Drink / Contact Preference", value: conversation.contact.preference }
            ]
          }).then(function (values) {
            if (!values || !values.note.trim() || !values.preference.trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/inbox/conversations/" + encodeURIComponent(conversation.id), "PATCH", {
              note: values.note,
              preference: values.preference
            }).then(function (payload) {
              notify("Conversation notes saved on live backend.");
              reload({ conversationId: payload.conversationId || conversation.id, clientId: conversation.clientId || currentQuery.clientId || "" });
            }).catch(function () {
              notify("Conversation update failed.", "error");
            });
          });
        };
      }
    }

    function update() {
      renderConversationList(filtered, activeId);
      var current = filtered.find(function (item) { return item.id === activeId; }) || filtered[0];
      if (!current) {
        renderEmptyConversationState();
        return;
      }
      activeId = current.id;
      currentQuery.conversationId = activeId;
      syncCurrentScreenQuery(currentQuery);
      renderMessages(current);
      renderProfile(current);
      qsa("[data-conversation-id]", listWrap).forEach(function (button) {
        button.addEventListener("click", function () {
          activeId = button.dataset.conversationId;
          update();
        });
      });
    }

    update();

    var createConversationButton = qs("[data-create-conversation]", paneHeader);
    if (createConversationButton) {
      createConversationButton.dataset.actionBound = "true";
      createConversationButton.onclick = function () {
        presentForm({
          title: "New Thread",
          submitLabel: "Create Thread",
          fields: [
            { name: "name", label: "Client or Conversation Name", value: "" },
            { name: "channel", label: "Channel", type: "select", value: "WhatsApp", options: ["WhatsApp", "Instagram"] },
            { name: "email", label: "Email", value: "", type: "email" },
            { name: "phone", label: "Phone", value: "", type: "tel" },
            { name: "message", label: "Initial Message", value: "Hi, reaching out from Precision Studio.", type: "textarea" }
          ]
        }).then(function (values) {
          if (!values || !values.name.trim() || !values.channel.trim() || !values.email.trim() || !values.phone.trim() || !values.message.trim()) return;
          mutateJson(apiBase.replace(/\/$/, "") + "/inbox/conversations", "POST", {
            name: values.name,
            channel: values.channel,
            contact: {
              email: values.email,
              phone: values.phone,
              preference: "Text updates"
            },
            preview: values.message,
            messages: [
              {
                type: "outgoing",
                text: values.message,
                meta: "Just now • Sent"
              }
            ]
          }).then(function (payload) {
            notify("Conversation created on live backend.");
            reload({ conversationId: payload.conversationId || "" });
          }).catch(function () {
            notify("Conversation creation failed.", "error");
          });
        });
      };
    }

    if (paneHeader && !qs("[data-channel-filter]", paneHeader)) {
      var channelFilterButton = document.createElement("button");
      channelFilterButton.className = "px-3 py-1.5 rounded-md border border-outline-variant/20 text-on-surface-variant text-xs font-semibold hover:bg-surface-container-low transition-colors";
      channelFilterButton.textContent = "Filter";
      channelFilterButton.dataset.channelFilter = "true";
      paneHeader.insertBefore(channelFilterButton, paneHeader.lastElementChild);
    }
    var inboxFilterButton = paneHeader ? qs("[data-channel-filter]", paneHeader) : null;
    if (inboxFilterButton) {
      inboxFilterButton.dataset.actionBound = "true";
      inboxFilterButton.onclick = function () {
        presentForm({
          title: "Filter Inbox",
          submitLabel: "Apply Filter",
          fields: [
            { name: "channel", label: "Channel", type: "select", value: currentQuery.channel || "all", options: ["all", "whatsapp", "instagram"] }
          ]
        }).then(function (values) {
          if (!values) return;
          reload({ channel: values.channel });
        });
      };
    }

    var search = qs("header input[type='text']");
    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        reload({ q: search.value });
      }, 180));
    }
  }

  function renderSchedule(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      stylist: page.liveQuery && page.liveQuery.stylist ? page.liveQuery.stylist : "all",
      clientId: page.liveQuery && page.liveQuery.clientId ? page.liveQuery.clientId : "",
      appointmentId: page.liveQuery && page.liveQuery.appointmentId ? page.liveQuery.appointmentId : ""
    };

    function syncPage(nextPage) {
      renderSchedule(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    setSearchPlaceholder(page.searchPlaceholder);
    var dateTitle = qs("header h2.font-headline");
    if (dateTitle) dateTitle.textContent = page.title;
    var headerColumns = qsa(".grid.grid-cols-3.divide-x.divide-outline-variant\\/20 > div");
    page.stylists.forEach(function (stylist, index) {
      var column = headerColumns[index];
      if (!column) return;
      var img = qs("img", column);
      var name = qs("h3", column);
      var role = qs("p", column);
      if (img) img.src = stylist.avatar;
      if (name) name.textContent = stylist.name;
      if (role) role.textContent = stylist.role;
    });

    var columns = qsa(".flex-1.grid.grid-cols-3.divide-x.divide-outline-variant\\/20.relative > div.relative.px-2");
    var drawer = qs("main > aside");
    function renderDrawer(selected) {
      if (!drawer) return;
      if (!selected) {
        drawer.dataset.selectedAppointmentId = "";
        var emptyHeaderName = qs("h2.font-headline.font-bold.text-xl", drawer);
        var emptySince = qs(".text-sm.text-on-surface-variant.mt-0\\.5", drawer);
        var emptyServiceRows = qsa(".bg-surface-container-lowest .flex.justify-between.text-sm", drawer);
        var emptyAmount = qs(".pt-2.mt-2.border-t.border-dashed span:last-child", drawer);
        var emptyNotes = qsa("p.text-sm.text-on-surface.leading-relaxed", drawer)[0];
        var emptyHistoryWrap = qs(".space-y-3.relative", drawer);
        if (emptyHeaderName) emptyHeaderName.textContent = currentQuery.clientId ? "No linked appointment" : "No appointment selected";
        if (emptySince) emptySince.textContent = currentQuery.clientId ? "This client has no active appointment in the current schedule view." : "Choose an appointment card to inspect details.";
        emptyServiceRows.forEach(function (row) {
          var spans = qsa("span", row);
          if (spans[1]) spans[1].textContent = "--";
        });
        if (emptyAmount) emptyAmount.textContent = "--";
        if (emptyNotes) emptyNotes.innerHTML = '<span class="font-semibold text-tertiary-dim block mb-1">Formula & Notes:</span>No notes for this selection.';
        if (emptyHistoryWrap) emptyHistoryWrap.innerHTML = '<div class="aibeaty-empty">No linked visit history available.</div>';
        qsa("button", drawer).forEach(function (button) {
          if ((button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "close") return;
          setButtonDisabled(button, true);
        });
        return;
      }
      drawer.dataset.selectedAppointmentId = selected.id || "";
      var headerName = qs("h2.font-headline.font-bold.text-xl", drawer);
      var since = qs(".text-sm.text-on-surface-variant.mt-0\\.5", drawer);
      var serviceRows = qsa(".bg-surface-container-lowest .flex.justify-between.text-sm", drawer);
      if (headerName) headerName.textContent = selected.client;
      if (since) since.textContent = selected.since;
      if (serviceRows[0]) qsa("span", serviceRows[0])[1].textContent = selected.service;
      if (serviceRows[1]) qsa("span", serviceRows[1])[1].textContent = selected.time;
      if (serviceRows[2]) qsa("span", serviceRows[2])[1].textContent = selected.stylist;
      var amount = qs(".pt-2.mt-2.border-t.border-dashed span:last-child", drawer);
      if (amount) amount.textContent = selected.amount;
      var notes = qsa("p.text-sm.text-on-surface.leading-relaxed", drawer)[0];
      if (notes) {
        notes.innerHTML = '<span class="font-semibold text-tertiary-dim block mb-1">Color Formula:</span>' + selected.notes + '<br/><br/><span class="italic text-on-surface-variant text-xs">' + selected.quietPreference + "</span>";
      }
      var historyWrap = qs(".space-y-3.relative", drawer);
      if (historyWrap) {
        historyWrap.innerHTML = selected.history
          .map(function (item, index) {
            return '<div class="relative pl-6"><div class="absolute left-0 top-1.5 w-6 h-6 bg-surface-container-lowest rounded-full border-2 ' + (index === 0 ? "border-primary-container" : "border-outline-variant/30") + ' flex items-center justify-center -ml-[3px]"><div class="' + (index === 0 ? "w-2 h-2 bg-primary" : "w-1.5 h-1.5 bg-outline-variant/50") + ' rounded-full"></div></div><div class="bg-surface-container-lowest p-3 rounded-lg ghost-border"><div class="flex justify-between items-start mb-1"><span class="text-xs font-bold text-on-surface">' + item.service + '</span><span class="text-[10px] text-on-surface-variant">' + item.date + '</span></div><p class="text-[11px] text-on-surface-variant">with ' + item.stylist + "</p></div></div>";
          })
          .join("");
      }
      qsa("button", drawer).forEach(function (button) {
        if ((button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "close") return;
        setButtonDisabled(button, false);
      });
    }

    function renderCards(list) {
      columns.forEach(function (column) {
        column.innerHTML = "";
      });
      list.forEach(function (appointment) {
        var column = columns[appointment.column];
        if (!column) return;
        var html = '<button class="absolute w-[calc(100%-1rem)] rounded-r-md p-2 flex flex-col transition-shadow cursor-pointer text-left ' +
          (appointment.tone === "primary"
            ? "bg-primary-container/20 border-l-4 border-primary shadow-md ring-1 ring-primary/20 z-10"
            : appointment.tone === "secondary"
              ? "bg-secondary-container/30 border-l-4 border-secondary hover:shadow-md"
              : appointment.tone === "tertiary"
                ? "bg-tertiary-container/30 border-l-4 border-tertiary hover:shadow-md"
                : "bg-surface-container-high border-l-4 border-outline opacity-70 hover:shadow-md") +
          '" style="top:' + appointment.top + "px;height:" + appointment.height + 'px" data-schedule-card data-appointment-id="' + appointment.id + '" data-client="' + appointment.client + '">' +
          (appointment.active ? '<div class="absolute top-2 right-2 flex gap-1"><span class="w-2 h-2 rounded-full bg-secondary animate-pulse"></span></div>' : "") +
          '<div class="flex justify-between items-start mb-0.5"><h4 class="font-headline font-bold ' + (appointment.tone === "primary" ? "text-primary" : "text-on-surface") + ' text-sm pr-4">' + appointment.service + "</h4>" +
          (appointment.price ? '<span class="text-xs font-semibold ' + (appointment.tone === "primary" ? "text-primary bg-surface-container-high" : "text-secondary bg-surface-container-lowest") + ' px-1.5 py-0.5 rounded ghost-border">' + appointment.price + "</span>" : appointment.badge ? '<span class="text-[10px] uppercase font-bold text-error bg-error-container/20 px-1 rounded">' + appointment.badge + "</span>" : "") +
          '</div><p class="text-[10px] font-medium ' + (appointment.tone === "primary" ? "text-primary-dim" : "text-on-surface-variant") + ' mb-1">' + appointment.time + "</p>" +
          (appointment.tags ? '<div class="mt-2 space-y-1">' + appointment.tags.map(function (tag) { return '<span class="inline-block ' + (tag === "VIP" ? "bg-surface-container-high text-on-surface" : "bg-primary-container/40 text-on-primary-container") + ' text-[10px] px-1.5 py-0.5 rounded font-semibold">' + tag + "</span>"; }).join(" ") + "</div>" : "") +
          '<div class="flex items-center gap-1.5 mt-auto"><span class="text-xs font-medium text-on-surface truncate">' + appointment.client + "</span></div></button>";
        column.insertAdjacentHTML("beforeend", html);
      });
    }

    var currentSelected = page.selectedAppointment || null;
    renderCards(page.appointments);
    renderDrawer(currentSelected);
    qsa("[data-schedule-card]").forEach(function (button) {
      button.addEventListener("click", function () {
        var appointmentId = button.dataset.appointmentId;
        var found = page.appointments.find(function (item) { return item.id === appointmentId; });
        if (found) {
          var fallbackSelected = page.selectedAppointment || {};
          currentSelected = {
            id: found.id,
            client: found.client,
            clientId: found.clientId || "",
            since: found.since || (found.tags && found.tags.indexOf("VIP") !== -1 ? "Since Oct 2021 • VIP" : "Recent client"),
            service: found.service,
            time: found.time,
            stylist: found.stylist || page.stylists[found.column].name,
            amount: found.price || "$0.00",
            notes: found.notes || fallbackSelected.notes || "",
            quietPreference: found.quietPreference || fallbackSelected.quietPreference || "",
            history: found.history || fallbackSelected.history || []
          };
          currentQuery.appointmentId = currentSelected.id;
          syncCurrentScreenQuery(currentQuery);
          renderDrawer(currentSelected);
        }
      });
    });

    var search = qs("header input[type='text']");
    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        reload({ q: search.value });
      }, 180));
    }

    var toggleButtons = qsa("header .flex.bg-surface-container-highest button");
    if (toggleButtons[1]) {
      toggleButtons[1].addEventListener("click", function () {
        notify("Week view is queued after backend schedule aggregation lands.");
      });
    }

    var shellButtons = qsa("button", document);
    var newBookingButton = shellButtons.filter(function (button) {
      return button.textContent.trim().toLowerCase() === "new booking";
    })[0];
    if (newBookingButton) {
      newBookingButton.dataset.actionBound = "true";
      newBookingButton.onclick = function () {
        presentForm({
          title: "New Booking",
          submitLabel: "Create Booking",
          fields: [
            { name: "client", label: "Client", value: "Walk-in Client" },
            { name: "service", label: "Service", value: "Women's Precision Cut" },
            { name: "stylist", label: "Stylist", value: page.stylists[0] ? page.stylists[0].name : "Sarah Jenkins" },
            { name: "slot", label: "Time Slot", value: "14:00-15:00" },
            { name: "amount", label: "Amount", value: "120", type: "number" }
          ]
        }).then(function (values) {
          if (!values || !values.client.trim() || !values.service.trim() || !values.stylist.trim() || !values.slot.trim() || !values.amount.trim()) return;
          mutateJson(apiBase.replace(/\/$/, "") + "/schedule/appointments", "POST", {
            client: values.client,
            service: values.service,
            stylist: values.stylist,
            date: values.slot,
            amount: values.amount,
            since: "New client",
            notes: "Booked from live schedule panel.",
            quietPreference: "No special preference recorded."
          }).then(function (payload) {
            notify("Appointment created on live backend.");
            reload({ appointmentId: payload.appointmentId || "" });
          }).catch(function () {
            notify("Appointment creation failed.", "error");
          });
        });
      };
    }

    if (drawer) {
      var drawerButtons = qsa("button", drawer);
      var checkoutButton = drawerButtons.filter(function (button) {
        return button.textContent.trim().toLowerCase() === "check out";
      })[0];
      var editButton = drawerButtons.filter(function (button) {
        return button.textContent.trim().toLowerCase() === "edit";
      })[0];
      var historyButton = drawerButtons.filter(function (button) {
        return button.textContent.trim().toLowerCase() === "view full history";
      })[0];
      if (checkoutButton) {
        checkoutButton.dataset.actionBound = "true";
        checkoutButton.onclick = function () {
          var appointmentId = drawer.dataset.selectedAppointmentId;
          if (!appointmentId) return;
          mutateJson(apiBase.replace(/\/$/, "") + "/schedule/appointments/" + encodeURIComponent(appointmentId) + "/checkout", "POST", {})
            .then(function (payload) {
              notify("Appointment checked out on live backend.");
              reload({ appointmentId: payload.appointmentId || "" });
            })
            .catch(function () {
              notify("Checkout failed.", "error");
            });
        };
      }
      if (editButton) {
        editButton.dataset.actionBound = "true";
        editButton.onclick = function () {
          var appointmentId = drawer.dataset.selectedAppointmentId;
          if (!appointmentId || !currentSelected) return;
          presentForm({
            title: "Edit Appointment Notes",
            description: currentSelected.client,
            submitLabel: "Save Notes",
            fields: [
              { name: "notes", label: "Formula / Appointment Notes", value: currentSelected.notes, type: "textarea" },
              { name: "quietPreference", label: "Quiet Preference", value: currentSelected.quietPreference }
            ]
          }).then(function (values) {
            if (!values || !values.notes.trim() || !values.quietPreference.trim()) return;
            mutateJson(apiBase.replace(/\/$/, "") + "/schedule/appointments/" + encodeURIComponent(appointmentId), "PATCH", {
              notes: values.notes,
              quietPreference: values.quietPreference
            }).then(function (payload) {
              notify("Appointment notes saved on live backend.");
              reload({ appointmentId: payload.appointmentId || appointmentId, clientId: currentSelected.clientId || currentQuery.clientId || "" });
            }).catch(function () {
              notify("Appointment update failed.", "error");
            });
          });
        };
      }
      if (historyButton) {
        historyButton.textContent = "Open Client";
        historyButton.dataset.actionBound = "true";
        historyButton.onclick = function () {
          if (!currentSelected || !currentSelected.clientId) {
            notify("No linked client profile for this appointment.", "error");
            return;
          }
          navigateToScreen("client-directory-luminous-core.html", { clientId: currentSelected.clientId });
        };
        var openInboxButton = ensureActionButton(
          historyButton.parentElement,
          "schedule-open-inbox",
          "Open Inbox",
          "mt-2 w-full py-1.5 text-xs font-medium text-secondary hover:bg-secondary-container/20 rounded-md transition-colors"
        );
        if (openInboxButton) {
          openInboxButton.onclick = function () {
            if (!currentSelected || !currentSelected.clientId) {
              notify("No linked inbox thread for this appointment.", "error");
              return;
            }
            navigateToScreen("unified-inbox-luminous-core.html", { clientId: currentSelected.clientId });
          };
        }
      }
    }

    var headerButtons = qsa("header button");
    var scheduleFilterButton = headerButtons.filter(function (button) {
      return (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "filter";
    })[0];
    if (scheduleFilterButton) {
      scheduleFilterButton.dataset.actionBound = "true";
      scheduleFilterButton.onclick = function () {
        presentForm({
          title: "Filter Schedule",
          submitLabel: "Apply Filter",
          fields: [
            { name: "stylist", label: "Stylist", type: "select", value: currentQuery.stylist || "all", options: ["all"].concat(page.stylists.map(function (item) { return item.name; })) }
          ]
        }).then(function (values) {
          if (!values) return;
          reload({ stylist: values.stylist });
        });
      };
    }
  }

  function renderAutomations(page) {
    var currentQuery = {
      q: page.liveQuery && page.liveQuery.q ? page.liveQuery.q : "",
      enabled: page.liveQuery && page.liveQuery.enabled ? page.liveQuery.enabled : "all"
    };

    function syncPage(nextPage) {
      renderAutomations(nextPage);
      bindStaticButtons();
    }

    function reload(nextQuery) {
      currentQuery = Object.assign({}, currentQuery, nextQuery || {});
      return loadLivePage(currentQuery).then(syncPage);
    }

    var title = qs("main h2.text-3xl");
    var subtitle = title && title.parentElement ? title.parentElement.querySelector("p") : null;
    if (title) title.textContent = page.title;
    if (subtitle) subtitle.textContent = page.subtitle;
    setSearchPlaceholder(page.searchPlaceholder);
    var badge = qs(".text-xs.font-bold.text-primary.bg-primary\\/10");
    if (badge) badge.textContent = page.summaryBadge;
    var workflowsWrap = qs(".xl\\:col-span-8.space-y-6");
    var workflows = page.workflows.slice();

    function renderWorkflows(list) {
      if (!workflowsWrap) return;
      var enabledCount = list.filter(function (workflow) { return workflow.enabled !== false; }).length;
      var listHeader = '<div class="flex items-center justify-between mb-2"><h3 class="font-headline font-bold text-lg text-on-surface">Active Workflows</h3><span class="text-xs font-bold text-primary bg-primary/10 px-3 py-1 rounded-full">' + enabledCount + " Running</span></div>";
      workflowsWrap.innerHTML =
        listHeader +
        (list.length
          ? list
              .map(function (workflow) {
                var toneClass = workflow.tone === "error" ? "bg-error/10 text-error" : "bg-tertiary/10 text-tertiary";
                var enabled = workflow.enabled !== false;
                return '<div class="workflow-card bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-transparent hover:border-outline-variant/10 transition-colors group" data-workflow-name="' + workflow.name.toLowerCase() + '"><div class="flex items-center justify-between mb-5"><div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl ' + toneClass + ' flex items-center justify-center"><span class="material-symbols-outlined" style="font-variation-settings: \'FILL\' 1;">' + workflow.icon + '</span></div><div><h4 class="font-headline font-bold text-on-surface">' + workflow.name + '</h4><p class="text-xs text-on-surface-variant mt-0.5">' + workflow.subtitle + '</p></div></div><button class="workflow-toggle w-11 h-6 ' + (enabled ? "bg-primary" : "bg-surface-container-high") + ' rounded-full relative transition-colors shadow-inner flex items-center px-1" data-enabled="' + (enabled ? "true" : "false") + '" data-workflow-name="' + workflow.name + '"><div class="w-4 h-4 bg-white rounded-full ' + (enabled ? "translate-x-5" : "translate-x-0") + ' transition-transform shadow-sm"></div></button></div><div class="bg-surface-container-low rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 mb-6"><div class="flex items-center gap-2 flex-1"><span class="font-headline font-black text-xs text-primary uppercase tracking-widest bg-white px-2 py-1 rounded-lg shadow-sm">If</span><span class="font-body text-sm font-medium text-on-surface">' + workflow.trigger + '</span></div><span class="material-symbols-outlined text-outline-variant hidden sm:block">arrow_right_alt</span><div class="flex items-center gap-2 flex-1"><span class="font-headline font-black text-xs text-tertiary uppercase tracking-widest bg-white px-2 py-1 rounded-lg shadow-sm">Then</span><span class="font-body text-sm font-medium text-on-surface">' + workflow.action + '</span></div></div><div class="grid grid-cols-3 gap-4"><div class="bg-surface px-4 py-3 rounded-xl flex flex-col"><span class="text-xs text-on-surface-variant font-medium mb-1">Sent (30d)</span><span class="font-headline font-extrabold text-xl text-on-surface">' + workflow.sent + '</span></div><div class="bg-surface px-4 py-3 rounded-xl flex flex-col"><span class="text-xs text-on-surface-variant font-medium mb-1">Converted</span><div class="flex items-baseline gap-2"><span class="font-headline font-extrabold text-xl text-on-surface">' + workflow.converted + '</span><span class="text-xs font-bold text-secondary">' + workflow.conversionRate + '</span></div></div><div class="bg-surface px-4 py-3 rounded-xl flex flex-col"><span class="text-xs text-on-surface-variant font-medium mb-1">Revenue Recovered</span><span class="font-headline font-extrabold text-xl text-secondary">' + workflow.revenue + '</span></div></div></div>';
              })
              .join("")
          : '<div class="aibeaty-empty">No workflows match this search.</div>');
      qsa(".workflow-toggle").forEach(function (button) {
        button.addEventListener("click", function () {
          var enabled = button.dataset.enabled === "true";
          mutateJson(apiBase.replace(/\/$/, "") + "/automations/workflows/" + encodeURIComponent(button.dataset.workflowName), "PATCH", {
            enabled: !enabled
          }).then(function () {
            notify("Workflow " + (enabled ? "paused" : "enabled") + " on live backend.");
            reload();
          }).catch(function () {
            notify("Workflow update failed.", "error");
          });
        });
      });
    }

    renderWorkflows(workflows);
    var form = qs("form");
    if (form) {
      var controls = qsa("select, textarea", form);
      if (controls[0]) controls[0].value = page.builder.trigger;
      if (controls[1]) controls[1].value = page.builder.action;
      if (controls[2]) controls[2].value = page.builder.message;
      var actionButtons = qsa("button[type='button']", form);
      var payloadForBuilder = function () {
        return {
          trigger: controls[0] ? controls[0].value : "",
          action: controls[1] ? controls[1].value : "",
          message: controls[2] ? controls[2].value : ""
        };
      };
      if (actionButtons[0]) {
        actionButtons[0].dataset.actionBound = "true";
        actionButtons[0].addEventListener("click", function () {
          mutateJson(apiBase.replace(/\/$/, "") + "/automations/builder/test-run", "POST", payloadForBuilder())
            .then(function (payload) {
              notify(payload.preview || "Automation preview created.");
              reload();
            })
            .catch(function () {
              notify("Automation test run failed.", "error");
            });
        });
      }
      if (actionButtons[1]) {
        actionButtons[1].dataset.actionBound = "true";
        actionButtons[1].addEventListener("click", function () {
          mutateJson(apiBase.replace(/\/$/, "") + "/automations/builder/activate", "POST", payloadForBuilder())
            .then(function () {
              notify("Automation activated on live backend.");
              reload();
            })
            .catch(function () {
              notify("Automation activation failed.", "error");
            });
        });
      }
    }
    var search = qs("header input[type='text']");
    if (search) {
      search.value = currentQuery.q || "";
      search.addEventListener("input", debounce(function () {
        reload({ q: search.value });
      }, 180));
    }

    var headerButtons = qsa("header button");
    var filterButton = headerButtons.filter(function (button) {
      return (button.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "filter";
    })[0];
    if (filterButton) {
      filterButton.dataset.actionBound = "true";
      filterButton.onclick = function () {
        presentForm({
          title: "Filter Automations",
          submitLabel: "Apply Filter",
          fields: [
            { name: "enabled", label: "Workflow State", type: "select", value: currentQuery.enabled || "all", options: ["all", "enabled", "disabled"] }
          ]
        }).then(function (values) {
          if (!values) return;
          reload({ enabled: values.enabled });
        });
      };
    }
  }

  var renderers = {
    "salon-performance-luminous-core.html": renderPerformance,
    "inventory-management-luminous-core.html": renderInventory,
    "services-pricing-luminous-core.html": renderServices,
    "client-directory-luminous-core.html": renderClients,
    "unified-inbox-luminous-core.html": renderInbox,
    "stylist-schedule-luminous-core.html": renderSchedule,
    "automations-marketing-luminous-core.html": renderAutomations
  };

  function loadData() {
    return fetchJson(screenApiUrl())
      .then(function (payload) {
        return {
          mode: "live",
          label: "Live backend",
          meta: "Updated " + formatUpdated(payload.lastUpdated || new Date().toISOString()),
          page: payload.page || payload
        };
      })
      .catch(function () {
        return fetchJson(demoUrl).then(function (payload) {
          return {
            mode: "demo",
            label: "Demo data",
            meta: "Updated " + formatUpdated(payload.salon.lastUpdated),
            page: payload.pages[pageFile]
          };
        });
      })
      .catch(function (error) {
        return {
          mode: "error",
          label: "No data",
          meta: error && error.message ? error.message : "Failed to load page data",
          page: null
        };
      });
  }

  window.addEventListener("DOMContentLoaded", function () {
    mountLoading();
    loadData().then(function (state) {
      unmountLoading();
      setStatus(state);
      if (state.page && renderers[pageFile]) {
        renderers[pageFile](state.page);
      } else if (!state.page) {
        var main = document.querySelector("main");
        if (main) {
          main.insertAdjacentHTML("afterbegin", '<div class="p-8"><div class="aibeaty-empty">This screen has no data payload yet. Wire its endpoint or keep the demo JSON in sync.</div></div>');
        }
      }
      bindStaticButtons();
      if (state.mode === "error") {
        notify("Backend and demo payload both failed. Screen is in fallback shell mode.", "error");
      }
    });
  });
})();
