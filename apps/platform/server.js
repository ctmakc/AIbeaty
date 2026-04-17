const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const ROOT_DIR = __dirname;
const DATA_FILE = path.join(ROOT_DIR, "data", "demo-platform.json");
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

function readDemoPayload() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendNotFound(response, message) {
  json(response, 404, {
    error: "not_found",
    message
  });
}

function apiResponseFor(screenSlug) {
  const payload = readDemoPayload();
  const pageKey = `${screenSlug}.html`;
  const page = payload.pages[pageKey];

  if (!page) {
    return null;
  }

  return {
    lastUpdated: payload.salon.lastUpdated,
    salon: payload.salon,
    screen: screenSlug,
    page
  };
}

function handleApi(requestUrl, response) {
  const screenSlug = requestUrl.pathname.replace(/^\/api\/platform\/?/, "");

  if (!screenSlug || screenSlug === "index") {
    const payload = readDemoPayload();
    return json(response, 200, {
      lastUpdated: payload.salon.lastUpdated,
      salon: payload.salon,
      screens: Object.keys(payload.pages).map((key) => ({
        id: key.replace(/\.html$/, ""),
        file: key,
        title: payload.pages[key].title || payload.pages[key].searchPlaceholder || key
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

  const payload = apiResponseFor(screenSlug);
  if (!payload) {
    return sendNotFound(response, `Unknown platform screen: ${screenSlug}`);
  }

  return json(response, 200, payload);
}

function safePathFromUrl(requestUrl) {
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(ROOT_DIR, pathname));
  if (!filePath.startsWith(ROOT_DIR)) {
    return null;
  }
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

function requestHandler(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (request.method !== "GET") {
    json(response, 405, {
      error: "method_not_allowed",
      message: `Unsupported method: ${request.method}`
    });
    return;
  }

  if (requestUrl.pathname.startsWith("/api/platform")) {
    handleApi(requestUrl, response);
    return;
  }

  serveFile(requestUrl, response);
}

function runCheckMode() {
  const payload = readDemoPayload();
  const screens = Object.keys(payload.pages);
  const missing = screens.filter((key) => !apiResponseFor(key.replace(/\.html$/, "")));

  if (missing.length) {
    console.error(`Platform API payloads missing for: ${missing.join(", ")}`);
    process.exit(1);
  }

  console.log(`Platform API check passed for ${screens.length} screens.`);
}

if (process.argv.includes("--check")) {
  runCheckMode();
} else {
  const server = http.createServer(requestHandler);
  server.listen(PORT, HOST, () => {
    console.log(`Platform server running at http://${HOST}:${PORT}`);
  });
}
