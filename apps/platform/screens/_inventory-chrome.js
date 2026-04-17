(function () {
  var fileName = window.location.pathname.split("/").pop() || "";

  var pageConfig = {
    "salon-performance-luminous-core.html": {
      nav: "dashboard",
      search: "Search performance..."
    },
    "stylist-schedule-luminous-core.html": {
      nav: "schedule",
      search: "Search schedule..."
    },
    "unified-inbox-luminous-core.html": {
      nav: "inbox",
      search: "Search messages..."
    },
    "client-directory-luminous-core.html": {
      nav: "clients",
      search: "Search clients..."
    },
    "services-pricing-luminous-core.html": {
      nav: "services",
      search: "Search services..."
    },
    "inventory-management-luminous-core.html": {
      nav: "inventory",
      search: "Search inventory..."
    },
    "automations-marketing-luminous-core.html": {
      nav: "automations",
      search: "Search automations..."
    }
  };

  var current = pageConfig[fileName];
  if (!current || fileName === "inventory-management-luminous-core.html") {
    return;
  }

  function navItem(label, icon, href, key) {
    var active = current.nav === key;
    var base =
      "flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-sm";
    var state = active
      ? " bg-surface-container-lowest text-primary font-bold shadow-sm"
      : " text-on-surface-variant hover:bg-surface-container hover:text-on-surface font-medium";
    var filled = active
      ? " style=\"font-variation-settings: 'FILL' 1;\""
      : "";

    return (
      "<a class=\"" +
      base +
      state +
      "\" href=\"" +
      href +
      "\">" +
      "<span class=\"material-symbols-outlined text-[22px]\"" +
      filled +
      ">" +
      icon +
      "</span>" +
      label +
      "</a>"
    );
  }

  var asideHtml =
    "<aside class=\"bg-surface-bright border-r border-surface-container-high h-screen w-64 flex flex-col py-6 px-4 shrink-0 hidden md:flex\">" +
    "<div class=\"mb-8 px-4 flex items-center gap-3\">" +
    "<div class=\"w-10 h-10 rounded-full bg-primary-container text-primary flex items-center justify-center font-bold text-xl\">L</div>" +
    "<div>" +
    "<h2 class=\"text-xl font-black tracking-tighter text-primary font-headline\">Luminous Core</h2>" +
    "<p class=\"text-xs text-on-surface-variant font-medium tracking-wide\">Precision OS</p>" +
    "</div>" +
    "</div>" +
    "<button class=\"mb-6 w-full py-3 px-4 bg-gradient-to-r from-primary to-primary-dim text-on-primary rounded-lg shadow-[0_4px_14px_0_rgba(77,42,250,0.39)] hover:shadow-[0_6px_20px_rgba(77,42,250,0.23)] transition-all font-medium text-sm flex items-center justify-center gap-2\">" +
    "<span class=\"material-symbols-outlined text-[20px]\">add</span>" +
    "New Booking" +
    "</button>" +
    "<nav class=\"flex-1 space-y-1\">" +
    navItem("Dashboard", "dashboard", "salon-performance-luminous-core.html", "dashboard") +
    navItem("Schedule", "calendar_month", "stylist-schedule-luminous-core.html", "schedule") +
    navItem("Inbox", "inbox", "unified-inbox-luminous-core.html", "inbox") +
    navItem("Clients", "group", "client-directory-luminous-core.html", "clients") +
    navItem("Services", "spa", "services-pricing-luminous-core.html", "services") +
    navItem("Inventory", "inventory_2", "inventory-management-luminous-core.html", "inventory") +
    navItem("Automations", "auto_awesome", "automations-marketing-luminous-core.html", "automations") +
    "</nav>" +
    "<div class=\"mt-auto pt-6 border-t border-surface-container-high space-y-1\">" +
    "<a class=\"flex items-center gap-3 px-4 py-2 text-on-surface-variant hover:bg-surface-container hover:text-on-surface rounded-lg transition-colors text-sm font-medium\" href=\"#\">" +
    "<span class=\"material-symbols-outlined text-[20px]\">settings</span>" +
    "Settings" +
    "</a>" +
    "<a class=\"flex items-center gap-3 px-4 py-2 text-on-surface-variant hover:bg-surface-container hover:text-on-surface rounded-lg transition-colors text-sm font-medium\" href=\"#\">" +
    "<span class=\"material-symbols-outlined text-[20px]\">help_outline</span>" +
    "Help" +
    "</a>" +
    "<div class=\"mt-4 flex items-center gap-3 px-4\">" +
    "<img alt=\"Salon Manager Profile\" class=\"w-8 h-8 rounded-full object-cover border border-surface-container-high\" data-alt=\"Professional headshot of a female salon manager with warm lighting\" src=\"https://lh3.googleusercontent.com/aida-public/AB6AXuB6471BCqh6zdEs248Am53uE2EdaOMRhLBikYDM6p3F9aga9ZxlOZsxc9ergA2rj4VEnK9X5_691IybnxjZbtzntDQm5iq2m1Qyzoml7MTJDmpPgoQro-1IV7kD9V-jG19aV5PI3l0JXKrDUCqRQkOpDZwXUl35AuGSc3N7FtCcquE_TI7oW4glBRbJZDxFi4yvlg1EK_h7G3SrdMbk8bA659pdKwm20Hm7lAq529DrGH6H4nnhyuU6mYTZxGTFZvbFxEJCQWZ9QqSB\"/>" +
    "<div class=\"flex flex-col\">" +
    "<span class=\"text-xs font-semibold text-on-surface\">Sarah J.</span>" +
    "<span class=\"text-[10px] text-on-surface-variant\">Manager</span>" +
    "</div>" +
    "</div>" +
    "</div>" +
    "</aside>";

  var headerHtml =
    "<header class=\"bg-surface-bright/80 backdrop-blur-xl border-b border-surface-container-high flex items-center justify-between px-8 h-16 w-full sticky top-0 z-10\">" +
    "<div class=\"flex items-center gap-6\">" +
    "<h1 class=\"text-xl font-headline font-semibold text-primary\">Salon Workspace</h1>" +
    "<div class=\"relative hidden md:block\">" +
    "<span class=\"material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-[20px]\">search</span>" +
    "<input class=\"pl-10 pr-4 py-2 bg-surface-container-lowest border border-outline-variant/20 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50 w-64 transition-all\" placeholder=\"" +
    current.search +
    "\" type=\"text\"/>" +
    "</div>" +
    "</div>" +
    "<div class=\"flex items-center gap-2 text-on-surface-variant\">" +
    "<button class=\"p-2 hover:bg-surface-container rounded-full transition-colors relative\">" +
    "<span class=\"material-symbols-outlined\">notifications</span>" +
    "<span class=\"absolute top-2 right-2 w-2 h-2 bg-error rounded-full\"></span>" +
    "</button>" +
    "<button class=\"p-2 hover:bg-surface-container rounded-full transition-colors\">" +
    "<span class=\"material-symbols-outlined\">dark_mode</span>" +
    "</button>" +
    "<button class=\"p-2 hover:bg-surface-container rounded-full transition-colors\">" +
    "<span class=\"material-symbols-outlined\">account_circle</span>" +
    "</button>" +
    "</div>" +
    "</header>";

  function directHeader(node) {
    if (!node || !node.children) {
      return null;
    }
    for (var i = 0; i < node.children.length; i += 1) {
      if (node.children[i].tagName === "HEADER") {
        return node.children[i];
      }
    }
    return null;
  }

  document.body.className = "bg-background text-on-surface flex h-screen overflow-hidden";

  var firstChrome = document.body.querySelector(":scope > nav, :scope > aside");
  if (firstChrome) {
    firstChrome.outerHTML = asideHtml;
  } else {
    document.body.insertAdjacentHTML("afterbegin", asideHtml);
  }

  var sidebar = document.body.querySelector(":scope > aside");
  var contentRoot = sidebar ? sidebar.nextElementSibling : document.body.lastElementChild;
  if (!contentRoot) {
    return;
  }

  if (contentRoot.tagName === "MAIN") {
    var wrapper = document.createElement("div");
    wrapper.className = "flex-1 flex flex-col h-screen overflow-hidden bg-background";
    contentRoot.parentNode.insertBefore(wrapper, contentRoot);
    wrapper.insertAdjacentHTML("beforeend", headerHtml);
    contentRoot.classList.remove("ml-64");
    contentRoot.classList.remove("w-[calc(100%-16rem)]");
    contentRoot.classList.add("flex-1");
    wrapper.appendChild(contentRoot);
  } else {
    contentRoot.classList.remove("ml-64");
    contentRoot.classList.remove("w-[calc(100%-16rem)]");
    contentRoot.classList.add("flex-1", "flex", "flex-col", "h-screen", "overflow-hidden", "bg-background");

    var existingHeader = directHeader(contentRoot);
    if (existingHeader) {
      existingHeader.outerHTML = headerHtml;
    } else {
      contentRoot.insertAdjacentHTML("afterbegin", headerHtml);
    }
  }
})();
