const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { createPlatformStore } = require("./backend/store");

const ROOT_DIR = __dirname;
const HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PORT = Number(process.env.PLATFORM_PORT || 4174);
const store = createPlatformStore();

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

function parseViewOptions(requestUrl) {
  const params = requestUrl.searchParams;
  return {
    q: params.get("q") || "",
    limit: params.get("limit") || "",
    category: params.get("category") || "",
    stock: params.get("stock") || "",
    enabled: params.get("enabled") || "",
    status: params.get("status") || "",
    channel: params.get("channel") || "",
    stylist: params.get("stylist") || "",
    clientId: params.get("clientId") || "",
    conversationId: params.get("conversationId") || "",
    appointmentId: params.get("appointmentId") || ""
  };
}

function pagePayload(screenSlug, requestUrl) {
  return store.getScreen(screenSlug, parseViewOptions(requestUrl));
}

function handleApiGet(requestUrl, response) {
  const screenSlug = requestUrl.pathname.replace(/^\/api\/platform\/?/, "");

  if (!screenSlug || screenSlug === "index") {
    return json(response, 200, {
      lastUpdated: store.getLastUpdated(),
      salon: store.getSalon(),
      screens: store.listScreens()
    });
  }

  if (screenSlug === "health") {
    return json(response, 200, store.health());
  }

  if (screenSlug === "reports/performance") {
    return json(response, 200, store.getPerformanceReport(parseViewOptions(requestUrl)));
  }

  const payload = pagePayload(screenSlug, requestUrl);
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

  if (request.method === "POST" && pathname === "/api/platform/inventory/restock-orders") {
    const touchedItems = store.createRestockOrder();
    return json(response, 200, {
      ok: true,
      action: "inventory_restock_order",
      touchedItems,
      page: store.getInventoryPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const inventoryMatch = pathname.match(/^\/api\/platform\/inventory\/items\/([^/]+)$/);
  if (inventoryMatch && request.method === "PATCH") {
    const sku = decodeURIComponent(inventoryMatch[1]);
    const item = store.updateInventoryItem(sku, body);
    if (!item) return sendNotFound(response, `Unknown inventory SKU: ${sku}`);
    return json(response, 200, {
      ok: true,
      action: "inventory_item_updated",
      item,
      page: store.getInventoryPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const workflowMatch = pathname.match(/^\/api\/platform\/automations\/workflows\/([^/]+)$/);
  if (workflowMatch && request.method === "PATCH") {
    if (typeof body.enabled !== "boolean") {
      return sendBadRequest(response, "`enabled` must be boolean.");
    }
    const workflowName = decodeURIComponent(workflowMatch[1]);
    const workflow = store.toggleWorkflow(workflowName, body.enabled);
    if (!workflow) return sendNotFound(response, `Unknown workflow: ${workflowName}`);
    return json(response, 200, {
      ok: true,
      action: "workflow_toggled",
      workflow,
      page: store.getAutomationsPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/test-run") {
    const page = store.upsertBuilderWorkflow(body);
    return json(response, 200, {
      ok: true,
      action: "builder_test_run",
      preview: `Preview sent for trigger "${page.builder.trigger}" via ${page.builder.action}.`,
      page,
      lastUpdated: store.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/activate") {
    const page = store.upsertBuilderWorkflow(body);
    return json(response, 200, {
      ok: true,
      action: "builder_activate",
      page,
      lastUpdated: store.getLastUpdated()
    });
  }

  const serviceMatch = pathname.match(/^\/api\/platform\/services\/([^/]+)$/);
  if (serviceMatch && request.method === "PATCH") {
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const updatedId = store.updateService(serviceId, body);
    if (!updatedId) return sendNotFound(response, `Unknown service: ${serviceId}`);
    return json(response, 200, {
      ok: true,
      action: "service_updated",
      page: store.getServicesPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/schedule/appointments") {
    const appointmentId = store.createAppointment(body);
    if (!appointmentId) return sendBadRequest(response, "Unable to create appointment.");
    return json(response, 201, {
      ok: true,
      action: "appointment_created",
      appointmentId,
      page: store.getSchedulePage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const appointmentMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)$/);
  if (appointmentMatch && request.method === "PATCH") {
    const appointmentId = decodeURIComponent(appointmentMatch[1]);
    const updatedId = store.updateAppointment(appointmentId, body);
    if (!updatedId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_updated",
      appointmentId: updatedId,
      page: store.getSchedulePage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const checkoutMatch = pathname.match(/^\/api\/platform\/schedule\/appointments\/([^/]+)\/checkout$/);
  if (checkoutMatch && request.method === "POST") {
    const appointmentId = decodeURIComponent(checkoutMatch[1]);
    const checkedOutId = store.checkoutAppointment(appointmentId);
    if (!checkedOutId) return sendNotFound(response, `Unknown appointment: ${appointmentId}`);
    return json(response, 200, {
      ok: true,
      action: "appointment_checked_out",
      appointmentId: checkedOutId,
      page: store.getSchedulePage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/clients") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendBadRequest(response, "`name` is required.");
    }
    const clientId = store.createClient(body);
    return json(response, 201, {
      ok: true,
      action: "client_created",
      clientId,
      client: store.getClientsPage().clients.find((client) => client.id === clientId),
      page: store.getClientsPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const clientMatch = pathname.match(/^\/api\/platform\/clients\/([^/]+)$/);
  if (clientMatch && request.method === "PATCH") {
    const clientId = decodeURIComponent(clientMatch[1]);
    const updatedId = store.updateClient(clientId, body);
    if (!updatedId) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_updated",
      clientId: updatedId,
      client: store.getClientsPage().clients.find((client) => client.id === updatedId),
      page: store.getClientsPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (clientMatch && request.method === "DELETE") {
    const clientId = decodeURIComponent(clientMatch[1]);
    const removed = store.deleteClient(clientId);
    if (!removed) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_deleted",
      clientId,
      client: removed,
      page: store.getClientsPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const clientBookingMatch = pathname.match(/^\/api\/platform\/clients\/([^/]+)\/bookings$/);
  if (clientBookingMatch && request.method === "POST") {
    const clientId = decodeURIComponent(clientBookingMatch[1]);
    const updatedId = store.createClientBooking(clientId, body);
    if (!updatedId) return sendNotFound(response, `Unknown client: ${clientId}`);
    return json(response, 200, {
      ok: true,
      action: "client_booking_created",
      clientId: updatedId,
      client: store.getClientsPage().clients.find((client) => client.id === updatedId),
      page: store.getClientsPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/inbox/conversations") {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return sendBadRequest(response, "`name` is required.");
    }
    const conversationId = store.createConversation(body);
    return json(response, 201, {
      ok: true,
      action: "conversation_created",
      conversationId,
      conversation: store.getInboxPage().conversations.find((conversation) => conversation.id === conversationId),
      page: store.getInboxPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const conversationMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)$/);
  if (conversationMatch && request.method === "PATCH") {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const updatedId = store.updateConversation(conversationId, body);
    if (!updatedId) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    return json(response, 200, {
      ok: true,
      action: "conversation_updated",
      conversationId: updatedId,
      conversation: store.getInboxPage().conversations.find((conversation) => conversation.id === updatedId),
      page: store.getInboxPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  if (conversationMatch && request.method === "DELETE") {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const removed = store.deleteConversation(conversationId);
    if (!removed) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    return json(response, 200, {
      ok: true,
      action: "conversation_deleted",
      conversationId,
      conversation: removed,
      page: store.getInboxPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const messageMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && request.method === "POST") {
    const conversationId = decodeURIComponent(messageMatch[1]);
    const result = store.createConversationMessage(conversationId, body);
    if (!result) return sendNotFound(response, `Unknown conversation: ${conversationId}`);
    if (result.error) return sendBadRequest(response, result.error);
    return json(response, 201, {
      ok: true,
      action: "conversation_message_created",
      conversationId: result,
      conversation: store.getInboxPage().conversations.find((conversation) => conversation.id === result),
      page: store.getInboxPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  const conversationBookingMatch = pathname.match(/^\/api\/platform\/inbox\/conversations\/([^/]+)\/bookings$/);
  if (conversationBookingMatch && request.method === "POST") {
    const conversationId = decodeURIComponent(conversationBookingMatch[1]);
    const result = store.createConversationBooking(conversationId, body);
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
      conversation: store.getInboxPage().conversations.find((conversation) => conversation.id === conversationId),
      page: store.getInboxPage(),
      lastUpdated: store.getLastUpdated()
    });
  }

  return sendNotFound(response, `Unknown platform mutation endpoint: ${pathname}`);
}

function safePathFromUrl(requestUrl) {
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/screens/salon-performance-luminous-core.html";
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

async function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.pathname.startsWith("/api/platform")) {
    if (request.method === "GET") return handleApiGet(requestUrl, response);
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

  serveFile(requestUrl, response);
}

function runCheckMode() {
  const missing = store.listScreens()
    .map((screen) => screen.id)
    .filter((screenId) => !store.getScreen(screenId));

  if (missing.length) {
    console.error(`Platform API payloads missing for: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Platform API check passed for ${store.listScreens().length} screens.`);
}

if (process.argv.includes("--check")) {
  runCheckMode();
} else if (process.argv.includes("--reset-state")) {
  store.reset();
  console.log("Platform state reset.");
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
