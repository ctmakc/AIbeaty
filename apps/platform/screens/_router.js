(function () {
  var routes = {
    dashboard: "salon-performance-luminous-core.html",
    performance: "salon-performance-luminous-core.html",
    overview: "salon-performance-luminous-core.html",
    schedule: "stylist-schedule-luminous-core.html",
    calendar: "stylist-schedule-luminous-core.html",
    book: "stylist-schedule-luminous-core.html",
    appointment: "stylist-schedule-luminous-core.html",
    inbox: "unified-inbox-luminous-core.html",
    messages: "unified-inbox-luminous-core.html",
    clients: "client-directory-luminous-core.html",
    client: "client-directory-luminous-core.html",
    directory: "client-directory-luminous-core.html",
    inventory: "inventory-management-luminous-core.html",
    stock: "inventory-management-luminous-core.html",
    services: "services-pricing-luminous-core.html",
    pricing: "services-pricing-luminous-core.html",
    automations: "automations-marketing-luminous-core.html",
    automation: "automations-marketing-luminous-core.html",
    marketing: "automations-marketing-luminous-core.html"
  };

  var currentPath = window.location.pathname.split("/").pop() || "";

  function normalize(value) {
    return (value || "")
      .toLowerCase()
      .replace(/&/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function routeFor(text) {
    var label = normalize(text);
    var keys = Object.keys(routes);
    for (var i = 0; i < keys.length; i += 1) {
      if (label.includes(keys[i])) {
        return routes[keys[i]];
      }
    }
    return null;
  }

  function wireAnchor(anchor) {
    if (!anchor || anchor.dataset.wiredRoute === "true") {
      return;
    }

    var href = anchor.getAttribute("href");
    var text = normalize(anchor.textContent);

    if (
      text.includes("support") ||
      text.includes("logout") ||
      text.includes("settings") ||
      text.includes("help")
    ) {
      anchor.href = "../index.html";
      anchor.dataset.wiredRoute = "true";
      return;
    }

    if (href && href !== "#") {
      anchor.dataset.wiredRoute = "true";
      return;
    }

    var target = routeFor(text);
    if (!target) {
      return;
    }

    anchor.href = target;
    if (target === currentPath) {
      anchor.setAttribute("aria-current", "page");
    }
    anchor.dataset.wiredRoute = "true";
  }

  function wireButton(button) {
    if (!button || button.dataset.wiredRoute === "true") {
      return;
    }

    var text = normalize(button.textContent);
    var target = null;

    if (
      text.includes("new appointment") ||
      text.includes("quick book") ||
      text.includes("book")
    ) {
      target = "stylist-schedule-luminous-core.html";
    } else if (text.includes("export report")) {
      target = "salon-performance-luminous-core.html";
    }

    if (!target) {
      return;
    }

    button.style.cursor = "pointer";
    button.addEventListener("click", function () {
      window.location.href = target;
    });
    button.dataset.wiredRoute = "true";
  }

  function wireBrand() {
    var candidates = Array.prototype.slice.call(
      document.querySelectorAll("h1, h2, span, div")
    );

    candidates.forEach(function (node) {
      var text = normalize(node.textContent);
      if (
        text === "precision studio" ||
        text === "salon os" ||
        text === "aura ai salon os"
      ) {
        var clickable = node.closest("a, button, div") || node;
        clickable.style.cursor = "pointer";
        clickable.addEventListener("click", function () {
          window.location.href = "../index.html";
        });
      }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll("a"), wireAnchor);
  Array.prototype.forEach.call(document.querySelectorAll("button"), wireButton);
  wireBrand();
})();
