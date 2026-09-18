#!/usr/bin/env node
// Self-serve over REAL HTTP: sign up → setup wizard → chat → Telegram bot →
// owner alerts → add-on request. Telegram and the LLM are local stub servers,
// so this runs offline and asserts exactly what we send them.
//
// Run: node apps/platform/tests/self-serve-http.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-selfserve-"));
const TEST_DB = path.join(TEST_DIR, "platform.db");
const BOT_TOKEN = "7000000001:AAtestTokenForTheSelfServeSuite_abcdefgh";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch (error) { resolve({}); }
    });
  });
}

// --- stub Telegram Bot API -------------------------------------------------
const telegramCalls = [];
function startTelegramStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const method = match ? match[2] : "";
    const token = match ? match[1] : "";
    telegramCalls.push({ method, token, body });
    response.setHeader("Content-Type", "application/json");
    if (token !== BOT_TOKEN) {
      response.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      return;
    }
    if (method === "getMe") {
      response.end(JSON.stringify({ ok: true, result: { id: 7000000001, is_bot: true, username: "test_salon_bot", first_name: "Test Salon" } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// --- stub LLM (OpenAI-compatible) ------------------------------------------
function startLlmStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const system = String((body.messages || [])[0] && body.messages[0].content || "");
    let content = "Hello! How can I help you today?";
    if (system.includes("price list")) {
      content = JSON.stringify({
        salon: { name: "Petal Nails", phone: "(613) 555-0199" },
        hours: { mon: "closed", tue: "10:00-19:00", wed: "" },
        services: [
          { name: "Gel manicure", category: "Nails", durationMinutes: 60, price: "$55", keywords: ["gel"] },
          { name: "Pedicure", category: "Nails", durationMinutes: 75, price: "from $70" }
        ],
        staff: [{ name: "Olena", role: "Nail tech" }],
        faq: { parking: "Free lot behind the building." }
      });
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function waitForServer(base) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/assistant/health`);
      if (response.ok) return;
    } catch (error) { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not start");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const [appPort, tgPort, llmPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const tgServer = await startTelegramStub(tgPort);
  const llmServer = await startLlmStub(llmPort);
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(appPort),
      PLATFORM_DB_PATH: TEST_DB,
      SESSION_SECRET: "test-session-secret-not-a-real-one",
      LLM_API_KEY: "stub",
      LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      LLM_MODEL: "stub-model",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      PUBLIC_BASE_URL: "https://salons.example.test",
      ALERT_EMAIL: "",
      PLATFORM_EMAIL: "",
      TENANCY_TICKER: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => { serverLog += chunk; });
  child.stderr.on("data", (chunk) => { serverLog += chunk; });

  let passed = 0;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => { passed += 1; console.log(`  ✓ ${name}`); });

  try {
    await waitForServer(base);
    let cookie = "";
    const call = async (method, url, body, extraHeaders = {}) => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: Object.assign({ "Content-Type": "application/json", Cookie: cookie }, extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual"
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = text; }
      return { status: response.status, data, headers: response.headers };
    };

    const signupBody = { email: "Owner@Petal.test", password: "long-enough-pass-1", salonName: "Petal Nails", city: "Ottawa", timezone: "America/Toronto", businessType: "nails" };
    let slug = "";

    await check("sign-up creates a salon, an owner and a signed-in session", async () => {
      const result = await call("POST", "/api/auth/signup", signupBody);
      assert.strictEqual(result.status, 201, JSON.stringify(result.data));
      assert.strictEqual(result.data.salonSlug, "petal-nails");
      slug = result.data.salonSlug;
      cookie = String(result.headers.get("set-cookie") || "").split(";")[0];
      assert.ok(cookie.startsWith("aibeaty_session="));
    });

    await check("the same email cannot sign up twice (no account takeover)", async () => {
      const result = await call("POST", "/api/auth/signup", Object.assign({}, signupBody, { salonName: "Hijack", password: "another-password-2" }), { Cookie: "" });
      assert.strictEqual(result.status, 409);
      const login = await call("POST", "/api/auth/login", { email: "owner@petal.test", password: "long-enough-pass-1" }, { Cookie: "" });
      assert.strictEqual(login.status, 200, "the original password still works");
    });

    await check("sign-up validates fields in plain words", async () => {
      const result = await call("POST", "/api/auth/signup", { email: "nope", password: "short", salonName: "" }, { Cookie: "" });
      assert.strictEqual(result.status, 400);
      const fields = result.data.errors.map((error) => error.field).sort();
      assert.deepStrictEqual(fields, ["email", "password", "salonName"]);
    });

    await check("a new salon lands on the setup wizard", async () => {
      const result = await call("GET", "/", undefined, { Accept: "text/html" });
      assert.strictEqual(result.status, 302);
      assert.strictEqual(result.headers.get("location"), "/screens/setup.html");
      const setup = await call("GET", "/api/setup");
      assert.strictEqual(setup.status, 200);
      assert.strictEqual(setup.data.tenant.plan, "trial");
      assert.strictEqual(setup.data.tenant.trialDaysLeft, 14);
      assert.strictEqual(setup.data.tenant.setupComplete, false);
      assert.strictEqual(setup.data.setup.salon.name, "Petal Nails");
    });

    await check("the assistant stays quiet about prices until setup is done", async () => {
      const result = await call("POST", "/api/assistant/chat", { salon: slug, sessionId: "web-1", message: "how much is a manicure?" }, { Cookie: "" });
      assert.strictEqual(result.status, 200);
      assert.match(result.data.reply, /still being set up/);
    });

    await check("an owner cannot open another salon", async () => {
      const result = await call("GET", "/api/setup?salon=luminous-core");
      assert.strictEqual(result.status, 403);
    });

    let draft = null;
    await check("pasting a price list drafts services, staff and hours", async () => {
      const result = await call("POST", "/api/setup/extract", { text: "Petal Nails. Gel manicure $55 (1h). Pedicure from $70. Olena, nail tech. Parking behind the building." });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      draft = result.data.draft;
      assert.strictEqual(draft.services.length, 2);
      assert.strictEqual(draft.services[1].price, "from $70");
      assert.strictEqual(draft.staff[0].name, "Olena");
      assert.strictEqual(draft.hours.tue, "10:00-19:00");
      assert.ok(!("wed" in draft.hours), "an hour the text did not state is left out, not marked closed");
    });

    await check("website import refuses private addresses", async () => {
      for (const url of ["http://127.0.0.1/", "http://localhost:4174/", "http://169.254.169.254/latest", "ftp://example.com"]) {
        const result = await call("POST", "/api/setup/extract", { url });
        assert.strictEqual(result.status, 422, url);
      }
    });

    await check("an incomplete setup is kept as a draft and explained", async () => {
      const result = await call("PUT", "/api/setup", { setup: { salon: { name: "Petal Nails", timezone: "America/Toronto" }, hours: { tue: "10-19" }, services: [{ name: "Gel manicure", price: "?", durationMinutes: 0 }], staff: [] } });
      assert.strictEqual(result.status, 422);
      const fields = result.data.errors.map((error) => error.field);
      assert.ok(fields.includes("services.0.durationMinutes"));
      assert.ok(fields.includes("services.0.price"));
      assert.ok(fields.includes("staff"));
      const again = await call("GET", "/api/setup");
      assert.strictEqual(again.data.setup.services[0].name, "Gel manicure", "the draft survived");
      assert.strictEqual(again.data.tenant.setupComplete, false);
    });

    await check("a complete setup goes live without a restart", async () => {
      const setup = {
        salon: { name: "Petal Nails", city: "Ottawa", timezone: "America/Toronto", phone: "(613) 555-0199", address: "12 Bank St" },
        hours: { sun: "closed", mon: "closed", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" },
        services: draft.services,
        staff: [{ name: "Olena", role: "Nail tech", services: [], workDays: ["tue", "wed", "thu", "fri", "sat"] }],
        faq: { parking: "Free lot behind the building.", custom: [{ q: "Do you do kids?", a: "Yes, from age 8." }] }
      };
      const result = await call("PUT", "/api/setup", { setup });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      const state = await call("GET", "/api/setup");
      assert.strictEqual(state.data.tenant.setupComplete, true);
      assert.strictEqual(state.data.tenant.launched, false);
      const preview = await call("POST", "/api/assistant/chat", { salon: slug, sessionId: "web-2", message: "hi there" });
      assert.ok(preview.data.reply && !/still being set up/.test(preview.data.reply), `the owner previews Maya: ${JSON.stringify(preview.data)}`);
    });

    await check("clients see Maya only after the owner presses Go live", async () => {
      const before = await call("POST", "/api/assistant/chat", { salon: slug, sessionId: "web-3", message: "hi there" }, { Cookie: "" });
      assert.match(before.data.reply, /still being set up/);
      const launched = await call("POST", "/api/setup/launch");
      assert.strictEqual(launched.status, 200, JSON.stringify(launched.data));
      assert.strictEqual(launched.data.tenant.live, true);
      const after = await call("POST", "/api/assistant/chat", { salon: slug, sessionId: "web-4", message: "hi there" }, { Cookie: "" });
      assert.ok(after.data.reply && !/still being set up/.test(after.data.reply), JSON.stringify(after.data));
    });

    await check("the widget snippet carries the API base the widget needs", async () => {
      const state = await call("GET", "/api/setup");
      assert.match(state.data.widgetSnippet, /AIBEATY_API_BASE = "https:\/\/salons\.example\.test"/);
      assert.match(state.data.widgetSnippet, /AIBEATY_SALON = "petal-nails"/);
    });

    let hookSecret = "";
    let ownerLink = "";
    await check("a wrong bot token is refused in plain words", async () => {
      const result = await call("POST", "/api/setup/telegram", { token: "hello" });
      assert.strictEqual(result.status, 422);
      assert.match(result.data.message, /BotFather/);
      const rejected = await call("POST", "/api/setup/telegram", { token: "7000000002:AAwrongTokenThatTelegramWillRefuse_xyz12" });
      assert.strictEqual(rejected.status, 422);
    });

    await check("connecting the salon's own bot registers a secret webhook", async () => {
      const result = await call("POST", "/api/setup/telegram", { token: BOT_TOKEN });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.username, "test_salon_bot");
      ownerLink = result.data.ownerLink;
      const hook = telegramCalls.find((entry) => entry.method === "setWebhook");
      assert.strictEqual(hook.body.url, "https://salons.example.test/api/telegram/hook/7000000001");
      assert.ok(hook.body.secret_token.length >= 32);
      hookSecret = hook.body.secret_token;
      const db = new (require("better-sqlite3"))(TEST_DB, { readonly: true });
      const row = db.prepare("SELECT token_sealed FROM tenant_telegram").get();
      db.close();
      assert.ok(!row.token_sealed.includes(BOT_TOKEN.split(":")[1]), "the token is not stored in the clear");
    });

    const postHook = (update, secret) => fetch(`${base}/api/telegram/hook/7000000001`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
      body: JSON.stringify(update)
    });

    await check("the webhook rejects callers without the bot's secret", async () => {
      const response = await postHook({ message: { chat: { id: 1, type: "private" }, text: "hi" } }, "forged");
      assert.strictEqual(response.status, 403);
    });

    await check("the owner links their chat through the deep link", async () => {
      const code = ownerLink.split("start=")[1];
      telegramCalls.length = 0;
      const response = await postHook({ message: { chat: { id: 555, type: "private" }, from: { language_code: "en" }, text: `/start ${code}` } }, hookSecret);
      assert.strictEqual(response.status, 200);
      await sleep(300);
      const sent = telegramCalls.find((entry) => entry.method === "sendMessage");
      assert.strictEqual(String(sent.body.chat_id), "555");
      assert.match(sent.body.text, /New bookings/);
      const state = await call("GET", "/api/setup");
      assert.strictEqual(state.data.telegram.ownerLinked, true);
    });

    await check("a client's /start gets the salon greeting, a message gets Maya's answer", async () => {
      telegramCalls.length = 0;
      await postHook({ message: { chat: { id: 777, type: "private" }, from: { language_code: "en" }, text: "/start" } }, hookSecret);
      await sleep(300);
      const greeting = telegramCalls.find((entry) => entry.method === "sendMessage");
      assert.match(greeting.body.text, /Petal Nails/);
      telegramCalls.length = 0;
      await postHook({ message: { chat: { id: 777, type: "private" }, from: { language_code: "en" }, text: "hello" } }, hookSecret);
      for (let wait = 0; wait < 40 && !telegramCalls.some((entry) => entry.method === "sendMessage"); wait += 1) await sleep(100);
      const answer = telegramCalls.find((entry) => entry.method === "sendMessage");
      assert.ok(answer, "Maya answered in Telegram");
      assert.strictEqual(String(answer.body.chat_id), "777");
    });

    await check("asking for a human pings the owner's Telegram", async () => {
      telegramCalls.length = 0;
      await postHook({ message: { chat: { id: 778, type: "private" }, from: { language_code: "en" }, text: "I want to talk to a human please" } }, hookSecret);
      for (let wait = 0; wait < 40 && !telegramCalls.some((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "555"); wait += 1) await sleep(100);
      const alert = telegramCalls.find((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "555");
      assert.ok(alert, `owner was alerted; calls: ${JSON.stringify(telegramCalls.map((entry) => [entry.method, entry.body.chat_id]))}`);
      assert.match(alert.body.text, /human/);
    });

    await check("add-ons: the owner requests one, automatic ones show as active", async () => {
      const result = await call("POST", "/api/setup/addons", { addon: "instagram_dm", note: "@petalnails" });
      assert.strictEqual(result.status, 200);
      const byKey = Object.fromEntries(result.data.addons.map((addon) => [addon.key, addon.status]));
      assert.strictEqual(byKey.instagram_dm, "requested");
      assert.strictEqual(byKey.telegram, "active");
      assert.strictEqual(byKey.owner_alerts, "active");
      const bad = await call("POST", "/api/setup/addons", { addon: "telegram" });
      assert.strictEqual(bad.status, 422, "self-serve items are not 'requested'");
    });

    await check("the demo salon keeps working and is not gated", async () => {
      const result = await call("POST", "/api/assistant/chat", { sessionId: "watchdog-x", message: "ping" }, { Cookie: "" });
      assert.strictEqual(result.data.reply, "pong");
    });

    console.log(`self-serve-http: ${passed} checks passed`);
  } catch (error) {
    console.error(error);
    console.error("--- server log ---\n" + serverLog.slice(-3000));
    process.exitCode = 1;
  } finally {
    child.kill();
    tgServer.close();
    llmServer.close();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

main();
