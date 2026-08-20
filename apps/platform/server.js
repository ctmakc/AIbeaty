const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { createPlatformStore } = require("./backend/store");
const { createLlmClient } = require("./backend/llm-client");
const { createAssistant } = require("./backend/assistant");
const { createAuth } = require("./backend/auth");
const { resolveSalonScope } = require("./backend/salon-scope");

const ROOT_DIR = __dirname;
const HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || process.env.PLATFORM_PORT || 4174);
const store = createPlatformStore();
const llm = createLlmClient();
const assistant = createAssistant({ store, llm });
const auth = createAuth({ store });

const LOGIN_PAGE = "/screens/login.html";

// Surfaces a salon's CLIENT must reach without any account: the assistant API, the
// chat page the widget frames, the widget itself, and the login door.
const PUBLIC_EXACT_PATHS = new Set([
  LOGIN_PAGE,
  "/screens/chat.html",
  "/assistant-widget.js",
  "/favicon.ico",
  "/mmix-logo.png"
]);

function isPublicPath(pathname) {
  if (pathname === "/api/assistant" || pathname.startsWith("/api/assistant/")) return true;
  if (pathname.startsWith("/api/auth/")) return true;
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  // Stylesheets are the login page's only asset dependency and carry no salon data.
  if (pathname.startsWith("/styles/")) return true;
  return false;
}

function wantsHtml(request) {
  return String(request.headers.accept || "").includes("text/html");
}

// CORS allowlist for the public assistant API (marketing site + demo host + local dev).
const CORS_ALLOWED = [
  "https://aibeaty.pages.dev",
  "https://aibeaty.remolda.com"
];

function corsOriginAllowed(origin) {
  if (!origin) return false;
  if (CORS_ALLOWED.includes(origin)) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function applyCors(request, headers = {}) {
  const origin = request.headers.origin;
  if (corsOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendNotFound(response, message) {
  json(response, 404, { error: "not_found", message });
}

function sendBadRequest(response, message) {
  json(response, 400, { error: "bad_request", message });
}

function parseRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

// Which salon's data does this request get?
//
// On every gated route the answer was already decided — and authorised — by
// enforceAuth() via backend/salon-scope.js, which is the single source of truth
// for that question. Re-deriving it from the query string here would ignore the
// session's salon: an owner of salon B who omits ?salon= would silently be
// served the default salon. So the gate's verdict always wins.
//
// Only the PUBLIC assistant routes (no session, no gate) resolve from the
// request itself, and an unknown slug there is a 404 rather than a fallback.
function resolveSalonStore(request, requestUrl, body) {
  if (request && request.salonSlug) {
    return { slug: request.salonSlug, scope: store.forSalon(request.salonSlug) };
  }
  const requested = String(
    (requestUrl && requestUrl.searchParams.get("salon")) ||
    (body && body.salon) ||
    ""
  ).trim();
  const slug = requested || store.DEFAULT_SALON_SLUG;
  return { slug, scope: store.forSalon(slug) };
}

function sendUnknownSalon(response, slug) {
  return json(response, 404, {
    error: "unknown_salon",
    message: `Unknown salon: ${slug}`,
    salons: store.listSalons().map((salon) => salon.slug)
  });
}

function parseViewOptions(requestUrl) {
  const params = requestUrl.searchParams;
  return {
    q: params.get("q") || "",
    limit: params.get("limit") || "",
    category: params.get("category") || "",
    stock: params.get("stock") || "",
    enabled: params.get("enabled") || "",
    tone: params.get("tone") || "",
    view: params.get("view") || "",
    dayOffset: params.get("dayOffset") || "",
    weekOffset: params.get("weekOffset") || "",
    status: params.get("status") || "",
    channel: params.get("channel") || "",
    stylist: params.get("stylist") || "",
    clientId: params.get("clientId") || "",
    conversationId: params.get("conversationId") || "",
    appointmentId: params.get("appointmentId") || ""
  };
}

function handleApiGet(request, requestUrl, response) {
  const screenSlug = requestUrl.pathname.replace(/^\/api\/platform\/?/, "");

  if (screenSlug === "health") {
    return json(response, 200, store.health());
  }

  // Salon directory. A signed-in owner sees ONLY the salon their account is
  // bound to — listing every salon here would tell one client who the other
  // clients are. Ops gets the full list from the box with `npm run salon:list`.
  if (screenSlug === "salons") {
    const visible = request && request.salonSlug ? [request.salonSlug] : [store.DEFAULT_SALON_SLUG];
    return json(response, 200, {
      defaultSalon: store.DEFAULT_SALON_SLUG,
      salons: visible
        .filter((slug) => store.salonExists(slug))
        .map((slug) => {
          const salon = store.getSalonRecord(slug);
          const summary = store.forSalon(slug).summary();
          return {
            slug: salon.slug,
            name: salon.name,
            city: salon.city,
            timezone: salon.timezone,
            services: summary.services,
            staff: summary.staff
          };
        })
    });
  }

  const { slug, scope } = resolveSalonStore(request, requestUrl, null);
  if (!scope) return sendUnknownSalon(response, slug);

  if (!screenSlug || screenSlug === "index") {
    return json(response, 200, {
      lastUpdated: scope.getLastUpdated(),
      salon: scope.getSalon(),
      screens: scope.listScreens()
    });
  }

  if (screenSlug === "reports/performance") {
    return json(response, 200, scope.getPerformanceReport(parseViewOptions(requestUrl)));
  }

  if (screenSlug === "reports/activity") {
    return json(response, 200, scope.getActivityReport(parseViewOptions(requestUrl)));
  }

  const payload = scope.getScreen(screenSlug, parseViewOptions(requestUrl));
  if (!payload) {
    return sendNotFound(response, `Unknown platform screen: ${screenSlug}`);
  }

  return json(response, 200, payload);
}

async function handleApiMutation(request, requestUrl, response) {
  let body = {};
  try {
    body = await parseRequestBody(request);
  } catch (error) {
    return sendBadRequest(response, "Request body must be valid JSON.");
  }

  const pathname = requestUrl.pathname;
  const { slug, scope } = resolveSalonStore(request, requestUrl, body);
  if (!scope) return sendUnknownSalon(response, slug);

  if (request.method === "POST" && pathname === "/api/platform/inventory/restock-orders") {
    const touchedItems = scope.createRestockOrder();
    return json(response, 200, {
      ok: true,
      action: "inventory_restock_order",
      touchedItems,
      page: scope.getInventoryPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const inventoryMatch = pathname.match(/^\/api\/platform\/inventory\/items\/([^/]+)$/);
  if (inventoryMatch && request.method === "PATCH") {
    const sku = decodeURIComponent(inventoryMatch[1]);
    const item = scope.updateInventoryItem(sku, body);
    if (!item) return sendNotFound(response, `Unknown inventory SKU: ${sku}`);
    return json(response, 200, {
      ok: true,
      action: "inventory_item_updated",
      item,
      page: scope.getInventoryPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const workflowMatch = pathname.match(/^\/api\/platform\/automations\/workflows\/([^/]+)$/);
  if (workflowMatch && request.method === "PATCH") {
    if (typeof body.enabled !== "boolean") {
      return sendBadRequest(response, "`enabled` must be boolean.");
    }
    const workflowName = decodeURIComponent(workflowMatch[1]);
    const workflow = scope.toggleWorkflow(workflowName, body.enabled);
    if (!workflow) return sendNotFound(response, `Unknown workflow: ${workflowName}`);
    return json(response, 200, {
      ok: true,
      action: "workflow_toggled",
      workflow,
      page: scope.getAutomationsPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/test-run") {
    const page = scope.upsertBuilderWorkflow(body);
    return json(response, 200, {
      ok: true,
      action: "builder_test_run",
      preview: `Preview sent for trigger "${page.builder.trigger}" via ${page.builder.action}.`,
      page,
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/activate") {
    const page = scope.upsertBuilderWorkflow(body);
    return json(response, 200, {
      ok: true,
      action: "builder_activate",
      page,
      lastUpdated: scope.getLastUpdated()
    });
  }

  const serviceMatch = pathname.match(/^\/api\/platform\/services\/([^/]+)$/);
  if (serviceMatch && request.method === "PATCH") {
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const updatedId = scope.updateService(serviceId, body);
    if (!updatedId) return sendNotFound(response, `Unknown service: ${serviceId}`);
    return json(response, 200, {
      ok: true,
      action: "service_updated",
      page: scope.getServicesPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/schedule/appointments") {
    const appointmentId = scope.createAppointment(body);
    if (!appointmentId) return sendBadRequest(response, "Unable to create appointment.");
    return json(response, 201, {
      ok: true,
      action: "appointment_created",
      appointmentId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const appointmentMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)$/);
  if (appointmentMatch && request.method === "PATCH") {
    const appointmentId = decodeURIComponent(appointmentMatch[1]);
    const updatedId = scope.updateAppointment(appointmentId, body);
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_updated",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const checkoutMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/checkout$/);
  if (checkoutMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(checkoutMatch[1]);
    const checkedOutId = scope.checkoutAppointment(appointmentId, body);
    if (checkedOutId && checkedOutId.error === "checked_out") {
      return sendBadRequest(response, "Appointment is already checked out.");
    }
    if (!checkedOutId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_checked_out",
      appointmentId: checkedOutId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const depositMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/deposit$/);
  if (depositMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(depositMatch[1]);
    const updatedId = scope.captureAppointmentDeposit(appointmentId, body);
    if (updatedId && updatedId.error === "checked_out") {
      return sendBadRequest(response, "Cannot capture deposit after checkout.");
    }
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_deposit_captured",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const refundMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/refund$/);
  if (refundMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(refundMatch[1]);
    const updatedId = scope.refundAppointment(appointmentId, body);
    if (updatedId && updatedId.error === "not_checked_out") {
      return sendBadRequest(response, "Cannot refund an appointment before checkout.");
    }
    if (updatedId && updatedId.error === "invalid_refund") {
      return sendBadRequest(response, "Refund amount is invalid.");
    }
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_refunded",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const rescheduleMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/reschedule$/);
  if (rescheduleMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(rescheduleMatch[1]);
    const updatedId = scope.rescheduleAppointment(appointmentId, body);
    if (updatedId && updatedId.error === "checked_out") {
      return sendBadRequest(response, "Cannot reschedule a checked-out appointment.");
    }
    if (updatedId && updatedId.error === "canceled") {
      return sendBadRequest(response, "Cannot reschedule a canceled appointment.");
    }
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_rescheduled",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const cancelMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(cancelMatch[1]);
    const updatedId = scope.cancelAppointment(appointmentId, body);
    if (updatedId && updatedId.error === "checked_out") {
      return sendBadRequest(response, "Cannot cancel a checked-out appointment.");
    }
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_canceled",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const noShowMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/no-show$/);
  if (noShowMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(noShowMatch[1]);
    const updatedId = scope.markAppointmentNoShow(appointmentId, body);
    if (updatedId && updatedId.error === "checked_out") {
      return sendBadRequest(response, "Cannot mark a checked-out appointment as no-show.");
    }
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_no_show",
      appointmentId: updatedId,
      page: scope.getSchedulePage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/clients") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendBadRequest(response, "`name` is required.");
    }
    const clientId = scope.createClient(body);
    return json(response, 201, {
      ok: true,
      action: "client_created",
      clientId,
      client: scope.getClientsPage().clients.find((client) => client.id === clientId),
      page: scope.getClientsPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const clientMatch = pathname.match(/^\/api\/platform\/clients\/([^/]+)$/);
  if (clientMatch && request.method === "PATCH") {
    const clientId = decodeURIComponent(clientMatch[1]);
    const updatedId = scope.updateClient(clientId, body);
    if (!updatedId) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_updated",
      clientId: updatedId,
      client: scope.getClientsPage().clients.find((client) => client.id === updatedId),
      page: scope.getClientsPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (clientMatch && request.method === "DELETE") {
    const clientId = decodeURIComponent(clientMatch[1]);
    const removed = scope.deleteClient(clientId);
    if (!removed) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_deleted",
      clientId,
      client: removed,
      page: scope.getClientsPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const clientBookingMatch = pathname.match(/^\/api\/platform\/clients\/([^/]+)\/bookings$/);
  if (clientBookingMatch && request.method === "POST") {
    const clientId = decodeURIComponent(clientBookingMatch[1]);
    const updatedId = scope.createClientBooking(clientId, body);
    if (!updatedId) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_booking_created",
      clientId: updatedId,
      client: scope.getClientsPage().clients.find((client) => client.id === updatedId),
      page: scope.getClientsPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/inbox/conversations") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendBadRequest(response, "`name` is required.");
    }
    const conversationId = scope.createConversation(body);
    return json(response, 201, {
      ok: true,
      action: "conversation_created",
      conversationId,
      conversation: scope.getInboxPage().conversations.find((conversation) => conversation.id === conversationId),
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const conversationMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)$/);
  if (conversationMatch && request.method === "PATCH") {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const updatedId = scope.updateConversation(conversationId, body);
    if (!updatedId) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    return json(response, 200, {
      ok: true,
      action: "conversation_updated",
      conversationId: updatedId,
      conversation: scope.getInboxPage().conversations.find((conversation) => conversation.id === updatedId),
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  if (conversationMatch && request.method === "DELETE") {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const removed = scope.deleteConversation(conversationId);
    if (!removed) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    return json(response, 200, {
      ok: true,
      action: "conversation_deleted",
      conversationId,
      conversation: removed,
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const messageMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && request.method === "POST") {
    const conversationId = decodeURIComponent(messageMatch[1]);
    const result = scope.createConversationMessage(conversationId, body);
    if (!result) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    if (result.error) return sendBadRequest(response, result.error);
    // Staff replied manually in an assistant thread → human takeover, Maya goes silent.
    if (body.type !== "incoming" && body.type !== "system") {
      assistant.noteStaffMessage(conversationId);
    }
    return json(response, 201, {
      ok: true,
      action: "conversation_message_created",
      conversationId: result,
      conversation: scope.getInboxPage().conversations.find((conversation) => conversation.id === result),
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const recoveryMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)\/recovery-offer$/);
  if (recoveryMatch && request.method === "POST") {
    const conversationId = decodeURIComponent(recoveryMatch[1]);
    const result = scope.sendRecoveryOffer(conversationId, body);
    if (!result) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    if (result.error === "no_recovery_state") {
      return sendBadRequest(response, "Conversation is not in a recovery state.");
    }
    return json(response, 200, {
      ok: true,
      action: "conversation_recovery_offer_sent",
      conversationId: result,
      conversation: scope.getInboxPage().conversations.find((conversation) => conversation.id === result),
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  const conversationBookingMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)\/bookings$/);
  if (conversationBookingMatch && request.method === "POST") {
    const conversationId = decodeURIComponent(conversationBookingMatch[1]);
    const result = scope.createConversationBooking(conversationId, body);
    if (!result) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    return json(response, 201, {
      ok: true,
      action: "conversation_booking_created",
      appointmentId: result.appointmentId,
      booking: {
        clientId: result.clientId,
        service: result.service,
        slot: result.slot,
        amount: result.amount,
        stylist: result.stylist
      },
      conversation: scope.getInboxPage().conversations.find((conversation) => conversation.id === conversationId),
      page: scope.getInboxPage(),
      lastUpdated: scope.getLastUpdated()
    });
  }

  return sendNotFound(response, `Unknown platform mutation endpoint: ${pathname}`);
}

function jsonCors(request, response, statusCode, payload) {
  response.writeHead(statusCode, applyCors(request, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }));
  response.end(JSON.stringify(payload, null, 2));
}

async function handleAssistantRoutes(request, requestUrl, response) {
  const pathname = requestUrl.pathname;

  if (request.method === "OPTIONS") {
    response.writeHead(204, applyCors(request, {}));
    response.end();
    return;
  }

  if (request.method === "GET" && pathname === "/api/assistant/health") {
    const { slug, scope } = resolveSalonStore(request, requestUrl, null);
    if (!scope) {
      return jsonCors(request, response, 404, { error: "unknown_salon", message: `Unknown salon: ${slug}` });
    }
    const salon = scope.getSalon();
    return jsonCors(request, response, 200, {
      ok: true,
      service: "assistant-api",
      persona: "Maya",
      salon: salon.name,
      salonSlug: salon.slug,
      city: salon.city,
      timezone: salon.timezone,
      model: llm.model,
      baseUrl: llm.baseUrl
    });
  }

  if (request.method === "GET" && pathname === "/api/assistant/digest") {
    const salonSlug = requestUrl.searchParams.get("salon") || store.DEFAULT_SALON_SLUG;
    const digest = assistant.getDigest(requestUrl.searchParams.get("day"), salonSlug);
    if (!digest) return jsonCors(request, response, 404, { error: "unknown_salon", message: `Unknown salon: ${salonSlug}` });
    return jsonCors(request, response, 200, digest);
  }

  if (request.method === "GET" && pathname === "/api/assistant/usage") {
    const salonSlug = requestUrl.searchParams.get("salon") || store.DEFAULT_SALON_SLUG;
    const usage = assistant.getUsage(requestUrl.searchParams.get("day"), salonSlug);
    if (!usage) return jsonCors(request, response, 404, { error: "unknown_salon", message: `Unknown salon: ${salonSlug}` });
    return jsonCors(request, response, 200, usage);
  }

  if (request.method === "POST" && pathname === "/api/assistant/chat") {
    let body = {};
    try {
      body = await parseRequestBody(request);
    } catch (error) {
      return jsonCors(request, response, 400, { error: "bad_request", message: "Request body must be valid JSON." });
    }
    const result = await assistant.chat({
      // Optional: which salon this guest is talking to. Absent → default salon.
      salon: body.salon || requestUrl.searchParams.get("salon") || "",
      sessionId: body.sessionId,
      message: body.message,
      channel: body.channel,
      clientPhone: body.clientPhone
    });
    if (result.error === "unknown_salon") return jsonCors(request, response, 404, result);
    if (result.error === "bad_request") return jsonCors(request, response, 400, result);
    if (result.error === "rate_limited") return jsonCors(request, response, 429, result);
    return jsonCors(request, response, 200, result);
  }

  const takeoverMatch = pathname.match(/^\/api\/assistant\/conversations\/([^/]+)\/takeover$/);
  if (takeoverMatch && request.method === "PATCH") {
    let body = {};
    try {
      body = await parseRequestBody(request);
    } catch (error) {
      return jsonCors(request, response, 400, { error: "bad_request", message: "Request body must be valid JSON." });
    }
    const result = assistant.setTakeover(decodeURIComponent(takeoverMatch[1]), Boolean(body.enabled));
    if (!result) return jsonCors(request, response, 404, { error: "not_found", message: "Unknown conversation." });
    return jsonCors(request, response, 200, Object.assign({ ok: true }, result));
  }

  return jsonCors(request, response, 404, { error: "not_found", message: `Unknown assistant endpoint: ${pathname}` });
}

function safePathFromUrl(requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const filePath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!filePath.startsWith(ROOT_DIR)) return null;
  return filePath;
}

function serveFile(requestUrl, response) {
  const filePath = safePathFromUrl(requestUrl);
  if (!filePath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const finalPath = stats.isDirectory() ? path.join(filePath, "index.html") : filePath;
    fs.readFile(finalPath, (readError, fileBuffer) => {
      if (readError) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const ext = path.extname(finalPath).toLowerCase();
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=60"
      });
      response.end(fileBuffer);
    });
  });
}

async function handleAuthRoutes(request, requestUrl, response) {
  const pathname = requestUrl.pathname;

  if (pathname === "/api/auth/session" && request.method === "GET") {
    const session = auth.readSession(request);
    if (!session) return json(response, 200, { authenticated: false });
    return json(response, 200, {
      authenticated: true,
      owner: {
        email: session.email,
        displayName: session.displayName,
        role: session.role,
        salonSlug: session.salonSlug
      }
    });
  }

  if (pathname === "/api/auth/login" && request.method === "POST") {
    let body = {};
    try {
      body = await parseRequestBody(request);
    } catch (error) {
      return json(response, 400, { error: "bad_request", message: auth.GENERIC_LOGIN_ERROR });
    }
    const result = auth.login({ email: body.email, password: body.password, request });
    if (!result.ok) {
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (result.retryAfter) headers["Retry-After"] = String(result.retryAfter);
      response.writeHead(result.status, headers);
      // Same body for "no such account", "wrong password" and "too many tries" —
      // the status code differs, the text never does.
      response.end(JSON.stringify({ error: result.error, message: result.message }, null, 2));
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": result.setCookie
    });
    response.end(JSON.stringify({ ok: true, owner: result.owner }, null, 2));
    return;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const session = auth.readSession(request);
    if (session) auth.revokeSession(session.sessionId);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": auth.clearCookieHeader(request)
    });
    response.end(JSON.stringify({ ok: true }, null, 2));
    return;
  }

  return json(response, 404, { error: "not_found", message: `Unknown auth endpoint: ${pathname}` });
}

// The gate. Everything that is not explicitly public needs a session, and a session
// may only ever touch its own salon.
function enforceAuth(request, requestUrl, response) {
  const pathname = requestUrl.pathname;
  if (isPublicPath(pathname)) return true;

  const session = auth.readSession(request);
  if (!session) {
    if (wantsHtml(request) && request.method === "GET") {
      const next = requestUrl.pathname + (requestUrl.search || "");
      response.writeHead(302, {
        Location: `${LOGIN_PAGE}?next=${encodeURIComponent(next)}`,
        "Cache-Control": "no-store"
      });
      response.end();
      return false;
    }
    json(response, 401, { error: "unauthorized", message: "Sign in to continue." });
    return false;
  }

  request.session = session;

  const scope = resolveSalonScope(store, request, requestUrl);
  if (!scope.ok) {
    json(response, 403, {
      error: "forbidden",
      reason: scope.reason,
      message: "This account has no access to that salon."
    });
    return false;
  }
  request.salonSlug = scope.slug;
  return true;
}

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.pathname.startsWith("/api/auth/")) {
    await handleAuthRoutes(request, requestUrl, response);
    return;
  }

  if (!enforceAuth(request, requestUrl, response)) return;

  if (requestUrl.pathname.startsWith("/api/assistant")) {
    await handleAssistantRoutes(request, requestUrl, response);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/platform")) {
    if (request.method === "GET") return handleApiGet(request, requestUrl, response);
    if (request.method === "POST" || request.method === "PATCH" || request.method === "DELETE") {
      await handleApiMutation(request, requestUrl, response);
      return;
    }
    json(response, 405, {
      error: "method_not_allowed",
      message: `Unsupported method: ${request.method}`
    });
    return;
  }

  if (request.method !== "GET") {
    json(response, 405, {
      error: "method_not_allowed",
      message: `Unsupported method: ${request.method}`
    });
    return;
  }

  // Bare root used to serve the dashboard HTML in place, which broke its
  // relative ./_*.js and ../styles/ paths (silent static placeholder data).
  // Redirect instead so the screen loads from its real /screens/ base.
  // (/index.html still serves the self-contained launcher page.)
  if (requestUrl.pathname === "/") {
    response.writeHead(302, { Location: "/screens/salon-performance-luminous-core.html" });
    response.end();
    return;
  }

  serveFile(requestUrl, response);
}

function runCheckMode() {
  const scope = store.forSalon(store.DEFAULT_SALON_SLUG);
  const missing = scope.listScreens()
    .map((screen) => screen.id)
    .filter((screenId) => !scope.getScreen(screenId));

  if (missing.length) {
    console.error(`Platform API payloads missing for: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Platform API check passed for ${scope.listScreens().length} screens across ${store.listSalons().length} salon(s).`);
}

if (process.argv.includes("--check")) {
  runCheckMode();
} else if (process.argv.includes("--reset-state")) {
  // Resets the demo salon only — a salon created by the intake importer keeps
  // its data unless --reset-salon names it explicitly.
  const salonArg = process.argv.find((arg) => arg.startsWith("--salon="));
  const targetSlug = salonArg ? salonArg.split("=")[1] : store.DEFAULT_SALON_SLUG;
  const scope = store.forSalon(targetSlug);
  if (!scope) {
    console.error(`Unknown salon: ${targetSlug}. Known: ${store.listSalons().map((salon) => salon.slug).join(", ")}`);
    process.exit(1);
  }
  scope.reset();
  console.log(`Platform state reset for salon "${targetSlug}".`);
} else {
  const server = http.createServer((request, response) => {
    requestHandler(request, response).catch((error) => {
      json(response, 500, {
        error: "internal_error",
        message: error && error.message ? error.message : "Unexpected server error"
      });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Platform server running at http://${HOST}:${PORT}`);
  });
}
