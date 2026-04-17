const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const DEMO_FILE = path.join(ROOT_DIR, "data", "demo-platform.json");
const STATE_FILE = path.join(ROOT_DIR, "data", "platform-state.json");
const HOST = process.env.PLATFORM_HOST || "127.0.0.1";
const PORT = Number(process.env.PLATFORM_PORT || 4174);

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readDemoPayload() {
  return JSON.parse(fs.readFileSync(DEMO_FILE, "utf8"));
}

function normalizeState(payload) {
  const next = clone(payload);
  next.salon = next.salon || {};
  next.salon.lastUpdated = next.salon.lastUpdated || new Date().toISOString();
  next.pages = next.pages || {};

  const inventoryKey = "inventory-management-luminous-core.html";
  if (next.pages[inventoryKey] && Array.isArray(next.pages[inventoryKey].items)) {
    next.pages[inventoryKey].items = next.pages[inventoryKey].items.map((item) => ({
      category: "professional",
      ...item
    }));
  }

  const automationsKey = "automations-marketing-luminous-core.html";
  if (next.pages[automationsKey] && Array.isArray(next.pages[automationsKey].workflows)) {
    next.pages[automationsKey].workflows = next.pages[automationsKey].workflows.map((workflow) => ({
      enabled: workflow.enabled !== false,
      ...workflow
    }));
    syncAutomationsSummary(next.pages[automationsKey]);
  }

  return next;
}

function ensureStateFile() {
  if (!fs.existsSync(STATE_FILE)) {
    const seed = normalizeState(readDemoPayload());
    fs.writeFileSync(STATE_FILE, JSON.stringify(seed, null, 2) + "\n", "utf8");
  }
}

function readState() {
  ensureStateFile();
  return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
}

function writeState(nextState) {
  const normalized = normalizeState(nextState);
  normalized.salon.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

function resetState() {
  const seed = normalizeState(readDemoPayload());
  fs.writeFileSync(STATE_FILE, JSON.stringify(seed, null, 2) + "\n", "utf8");
  return seed;
}

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

function screenResponse(state, screenSlug) {
  const pageKey = `${screenSlug}.html`;
  const page = state.pages[pageKey];
  if (!page) return null;

  return {
    lastUpdated: state.salon.lastUpdated,
    salon: state.salon,
    screen: screenSlug,
    page
  };
}

function getNumericStockValue(stockLabel) {
  const match = String(stockLabel || "").match(/[\d.]+/);
  return match ? Number(match[0]) : 0;
}

function getStockUnit(stockLabel) {
  const cleaned = String(stockLabel || "").replace(/^[\d.\s]+/, "").trim();
  return cleaned || "Units";
}

function syncInventoryPage(page) {
  const items = Array.isArray(page.items) ? page.items : [];
  const lowCount = items.filter((item) => item.stockTone === "low").length;
  const totalProducts = items.length;
  const totalValue = items.reduce((sum, item) => sum + getNumericStockValue(item.stock) * Number(String(item.cost || "").replace(/[^0-9.]/g, "") || 0), 0);

  if (Array.isArray(page.kpis)) {
    if (page.kpis[0]) page.kpis[0].value = `$${totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    if (page.kpis[1]) {
      page.kpis[1].value = String(lowCount);
      page.kpis[1].detail = lowCount ? "Requires immediate action" : "Stock is within target levels";
    }
    if (page.kpis[2]) page.kpis[2].value = String(totalProducts);
  }
}

function syncAutomationsSummary(page) {
  const workflows = Array.isArray(page.workflows) ? page.workflows : [];
  const enabledCount = workflows.filter((workflow) => workflow.enabled !== false).length;
  page.summaryBadge = `${enabledCount} Running`;
}

function inventoryRestockMutation(state) {
  const page = state.pages["inventory-management-luminous-core.html"];
  if (!page) return null;

  let touched = 0;
  page.items = page.items.map((item) => {
    if (item.stockTone !== "low") return item;
    touched += 1;
    return {
      ...item,
      stock: item.reorderPoint,
      stockTone: "ok"
    };
  });

  page.shipments = [
    {
      title: `Restock Order Created${touched ? `: ${touched} low items` : ""}`,
      meta: `PO-${new Date().toISOString().slice(0, 10)} • Generated from control layer`,
      time: "Just now",
      status: touched ? "Ordered" : "No Action"
    }
  ].concat(page.shipments || []).slice(0, 6);

  syncInventoryPage(page);
  return page;
}

function updateInventoryItem(state, sku, updates) {
  const page = state.pages["inventory-management-luminous-core.html"];
  if (!page || !Array.isArray(page.items)) return null;
  const targetIndex = page.items.findIndex((item) => item.sku === sku);
  if (targetIndex === -1) return null;

  const current = page.items[targetIndex];
  let next = { ...current };
  if (typeof updates.stock === "string" && updates.stock.trim()) {
    const quantity = getNumericStockValue(updates.stock);
    const unit = getStockUnit(current.stock);
    next.stock = `${quantity} ${unit}`;
    const reorderThreshold = getNumericStockValue(current.reorderPoint);
    next.stockTone = quantity <= reorderThreshold / 2 ? "low" : quantity <= reorderThreshold ? "watch" : "ok";
  }
  page.items[targetIndex] = next;
  syncInventoryPage(page);
  return next;
}

function toggleWorkflow(state, workflowName, enabled) {
  const page = state.pages["automations-marketing-luminous-core.html"];
  if (!page || !Array.isArray(page.workflows)) return null;
  const workflow = page.workflows.find((item) => item.name.toLowerCase() === workflowName.toLowerCase());
  if (!workflow) return null;
  workflow.enabled = Boolean(enabled);
  syncAutomationsSummary(page);
  return workflow;
}

function upsertBuilderWorkflow(state, builderInput) {
  const page = state.pages["automations-marketing-luminous-core.html"];
  if (!page) return null;
  page.builder = {
    ...page.builder,
    ...builderInput
  };

  const workflowName = `${page.builder.trigger} Flow`;
  const existing = page.workflows.find((item) => item.name === workflowName);
  if (existing) {
    existing.subtitle = `Custom ${page.builder.action}`;
    existing.trigger = page.builder.trigger;
    existing.action = `${page.builder.action} • ${page.builder.message.slice(0, 40)}${page.builder.message.length > 40 ? "..." : ""}`;
    existing.enabled = true;
  } else {
    page.workflows.unshift({
      name: workflowName,
      subtitle: `Custom ${page.builder.action}`,
      trigger: page.builder.trigger,
      action: `${page.builder.action} • ${page.builder.message.slice(0, 40)}${page.builder.message.length > 40 ? "..." : ""}`,
      sent: "0",
      converted: "0",
      conversionRate: "0%",
      revenue: "$0",
      icon: "auto_awesome",
      tone: "tertiary",
      enabled: true
    });
  }

  syncAutomationsSummary(page);
  return page;
}

function parseRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function handleApiGet(requestUrl, response) {
  const state = readState();
  const screenSlug = requestUrl.pathname.replace(/^\/api\/platform\/?/, "");

  if (!screenSlug || screenSlug === "index") {
    return json(response, 200, {
      lastUpdated: state.salon.lastUpdated,
      salon: state.salon,
      screens: Object.keys(state.pages).map((key) => ({
        id: key.replace(/\.html$/, ""),
        file: key,
        title: state.pages[key].title || state.pages[key].searchPlaceholder || key
      }))
    });
  }

  if (screenSlug === "health") {
    return json(response, 200, {
      ok: true,
      service: "platform-api",
      lastUpdated: new Date().toISOString()
    });
  }

  const payload = screenResponse(state, screenSlug);
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
  const state = readState();

  if (request.method === "POST" && pathname === "/api/platform/inventory/restock-orders") {
    const page = inventoryRestockMutation(state);
    const nextState = writeState(state);
    return json(response, 200, {
      ok: true,
      action: "inventory_restock_order",
      touchedItems: page.items.filter((item) => item.stockTone === "ok").length,
      page: nextState.pages["inventory-management-luminous-core.html"],
      lastUpdated: nextState.salon.lastUpdated
    });
  }

  const inventoryMatch = pathname.match(/^\/api\/platform\/inventory\/items\/([^/]+)$/);
  if (request.method === "PATCH" && inventoryMatch) {
    const sku = decodeURIComponent(inventoryMatch[1]);
    const item = updateInventoryItem(state, sku, body);
    if (!item) {
      return sendNotFound(response, `Unknown inventory SKU: ${sku}`);
    }
    const nextState = writeState(state);
    return json(response, 200, {
      ok: true,
      action: "inventory_item_updated",
      item,
      page: nextState.pages["inventory-management-luminous-core.html"],
      lastUpdated: nextState.salon.lastUpdated
    });
  }

  const workflowMatch = pathname.match(/^\/api\/platform\/automations\/workflows\/([^/]+)$/);
  if (request.method === "PATCH" && workflowMatch) {
    const workflowName = decodeURIComponent(workflowMatch[1]);
    if (typeof body.enabled !== "boolean") {
      return sendBadRequest(response, "`enabled` must be boolean.");
    }
    const workflow = toggleWorkflow(state, workflowName, body.enabled);
    if (!workflow) {
      return sendNotFound(response, `Unknown workflow: ${workflowName}`);
    }
    const nextState = writeState(state);
    return json(response, 200, {
      ok: true,
      action: "workflow_toggled",
      workflow,
      page: nextState.pages["automations-marketing-luminous-core.html"],
      lastUpdated: nextState.salon.lastUpdated
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/test-run") {
    const page = upsertBuilderWorkflow(state, body);
    if (!page) {
      return sendNotFound(response, "Automations page is missing.");
    }
    const nextState = writeState(state);
    return json(response, 200, {
      ok: true,
      action: "builder_test_run",
      preview: `Preview sent for trigger "${page.builder.trigger}" via ${page.builder.action}.`,
      page: nextState.pages["automations-marketing-luminous-core.html"],
      lastUpdated: nextState.salon.lastUpdated
    });
  }

  if (request.method === "POST" && pathname === "/api/platform/automations/builder/activate") {
    const page = upsertBuilderWorkflow(state, body);
    if (!page) {
      return sendNotFound(response, "Automations page is missing.");
    }
    const nextState = writeState(state);
    return json(response, 200, {
      ok: true,
      action: "builder_activate",
      page: nextState.pages["automations-marketing-luminous-core.html"],
      lastUpdated: nextState.salon.lastUpdated
    });
  }

  return sendNotFound(response, `Unknown platform mutation endpoint: ${pathname}`);
}

function safePathFromUrl(requestUrl) {
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";
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
    if (request.method === "GET") {
      handleApiGet(requestUrl, response);
      return;
    }
    if (request.method === "POST" || request.method === "PATCH") {
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
  const state = readState();
  const screens = Object.keys(state.pages);
  const missing = screens.filter((key) => !screenResponse(state, key.replace(/\.html$/, "")));

  if (missing.length) {
    console.error(`Platform API payloads missing for: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Platform API check passed for ${screens.length} screens.`);
}

if (process.argv.includes("--check")) {
  runCheckMode();
} else if (process.argv.includes("--reset-state")) {
  resetState();
  console.log("Platform state reset.");
} else {
  ensureStateFile();
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
