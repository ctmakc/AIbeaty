#!/usr/bin/env node
// The self-serve owner's own surfaces over REAL HTTP (stub Telegram, stub LLM):
//   - demo (Luminous Core) screens redirect a self-serve owner to Bookings,
//     "/" goes to setup before launch and to Bookings after; the demo salon
//     keeps its screens;
//   - /api/bookings lists only this salon's real bookings (no test chats, no
//     other salon), with channel, who booked, and a "booked value" that skips
//     add-on prices and cancelled visits;
//   - cancelling tells the Telegram client through the salon bot;
//   - a busy block makes Maya's availability say the time is taken;
//   - /c/<slug> is a public short link to the chat page;
//   - the plan request confirms to the owner in Telegram.
//
// Run: node apps/platform/tests/owner-surfaces.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-owner-surfaces-"));
const TEST_DB = path.join(TEST_DIR, "platform.db");
// store.js reads PLATFORM_DB_PATH when it is first required: pin it before
// any in-process require so direct writes land in the test database.
process.env.PLATFORM_DB_PATH = TEST_DB;
process.env.SESSION_SECRET = "test-session-secret-owner-surfaces";
const BOT_TOKEN = "7200000001:AAtestTokenForOwnerSurfacesSuite_abcdefgh";

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

const telegramCalls = [];
let nextMessageId = 5000;
function startTelegramStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const method = match ? match[2] : "";
    telegramCalls.push({ method, body });
    response.setHeader("Content-Type", "application/json");
    if (method === "getMe") {
      response.end(JSON.stringify({ ok: true, result: { id: 7200000001, is_bot: true, username: "surfaces_salon_bot" } }));
      return;
    }
    if (method === "sendMessage") {
      nextMessageId += 1;
      response.end(JSON.stringify({ ok: true, result: { message_id: nextMessageId, chat: { id: body.chat_id }, text: body.text } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

// The stub LLM follows commands in the client's message, so the test drives
// Maya's real tools: "BOOKIT <date>" books Gel manicure at 10:00 with Olena,
// "CHECK <date> <time>" asks check_availability for that time. The tool
// result that comes back is kept in lastToolResult.
let lastToolResult = null;
function toolCall(name, args) {
  return { role: "assistant", content: null, tool_calls: [{ id: `call-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
function startLlmStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const messages = body.messages || [];
    const last = messages[messages.length - 1] || {};
    const lastUser = [...messages].reverse().find((message) => message.role === "user") || {};
    const said = String(lastUser.content || "");
    let message = { role: "assistant", content: "Hello! How can I help you today?" };
    if (last.role === "tool") {
      try { lastToolResult = JSON.parse(last.content); } catch (error) { lastToolResult = last.content; }
      message = { role: "assistant", content: "Gel manicure with Olena, shall I book it?" };
    } else if (/BOOKIT (\d{4}-\d{2}-\d{2})/.test(said)) {
      const day = said.match(/BOOKIT (\d{4}-\d{2}-\d{2})/)[1];
      message = toolCall("book_appointment", { service: "Gel manicure", day, time: "10:00", stylist: "Olena", client_name: "Rita Client", client_phone: "613-555-0101" });
    } else if (/CHECK (\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})/.test(said)) {
      const [, day, time] = said.match(/CHECK (\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2})/);
      message = toolCall("check_availability", { service: "Gel manicure", day, time, stylist: "Olena" });
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 6000) {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  return predicate();
}

const ALL_WEEK = { sun: "09:00-19:00", mon: "09:00-19:00", tue: "09:00-19:00", wed: "09:00-19:00", thu: "09:00-19:00", fri: "09:00-19:00", sat: "09:00-19:00" };
const SETUP = {
  salon: { name: "Rosa Nails", city: "Ottawa", timezone: "America/Toronto", phone: "(613) 555-0100", address: "1 Elgin St" },
  hours: ALL_WEEK,
  services: [
    { name: "Gel manicure", category: "Nails", durationMinutes: 60, price: "$55" },
    { name: "Pedicure", category: "Nails", durationMinutes: 60, price: "from $70" },
    { name: "Nail art add-on", category: "Nails", durationMinutes: 15, price: "+$15" }
  ],
  staff: [
    { name: "Olena", role: "Nail tech", services: [], workDays: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
    { name: "Ira", role: "Nail tech", services: [], workDays: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }
  ],
  faq: {}
};

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
      SESSION_SECRET: "test-session-secret-owner-surfaces",
      LLM_API_KEY: "stub",
      LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      LLM_MODEL: "stub-model",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      PUBLIC_BASE_URL: "https://salons.example.test",
      ALERT_EMAIL: "",
      PLATFORM_EMAIL: "",
      TENANCY_TICKER: "0",
      OWNER_ALERT_DELAY_MS: "200",
      SIGNUP_MAX_PER_IP: "50"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  child.stdout.on("data", (chunk) => { serverLog += chunk; });
  child.stderr.on("data", (chunk) => { serverLog += chunk; });

  let passed = 0;
  const check = (name, fn) => Promise.resolve().then(fn).then(() => { passed += 1; console.log(`  ✓ ${name}`); });

  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await fetch(`${base}/api/assistant/health`)).ok) break; } catch (error) { /* not up yet */ }
      await sleep(200);
    }
    const call = async (method, url, body, cookie, extraHeaders = {}) => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: Object.assign({ "Content-Type": "application/json", Cookie: cookie || "" }, extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual"
      });
      const text = await response.text();
      let data = null;
      try { data = JSON.parse(text); } catch (error) { data = text; }
      return { status: response.status, data, headers: response.headers };
    };
    const signup = async (body) => {
      const result = await call("POST", "/api/auth/signup", body);
      assert.strictEqual(result.status, 201, JSON.stringify(result.data));
      return { slug: result.data.salonSlug, cookie: String(result.headers.get("set-cookie") || "").split(";")[0] };
    };

    const rosa = await signup({ email: "owner@rosa.test", password: "long-enough-pass-1", salonName: "Rosa Nails", city: "Ottawa", timezone: "America/Toronto", businessType: "nails" });
    const other = await signup({ email: "owner@other.test", password: "long-enough-pass-2", salonName: "Other Salon", city: "Ottawa", timezone: "America/Toronto", businessType: "nails" });
    const html = { Accept: "text/html" };

    await check("before launch, / goes to setup; demo screens send the owner to Bookings", async () => {
      const root = await call("GET", "/", undefined, rosa.cookie, html);
      assert.strictEqual(root.status, 302);
      assert.strictEqual(root.headers.get("location"), "/screens/setup.html");
      for (const screen of ["salon-performance", "stylist-schedule", "services-pricing", "client-directory", "automations-marketing", "inventory-management"]) {
        const result = await call("GET", `/screens/${screen}-luminous-core.html`, undefined, rosa.cookie, html);
        assert.strictEqual(result.status, 302, screen);
        assert.strictEqual(result.headers.get("location"), "/screens/bookings.html", screen);
      }
      const digest = await call("GET", "/screens/digest.html", undefined, rosa.cookie, html);
      assert.strictEqual(digest.headers.get("location"), "/screens/bookings.html");
      const bookings = await call("GET", "/screens/bookings.html", undefined, rosa.cookie, html);
      assert.strictEqual(bookings.status, 200);
      assert.match(bookings.data, /id="bookings-screen"/);
    });

    await check("setup and inbox link to Bookings, never to a demo screen", async () => {
      for (const page of ["setup.html", "inbox.html", "bookings.html"]) {
        const source = fs.readFileSync(path.join(REPO_ROOT, "apps/platform/screens", page), "utf8");
        assert.ok(!/luminous-core\.html/.test(source.replace(/unified-inbox-luminous-core\.html/g, "")), `${page} links a demo screen`);
      }
      assert.match(fs.readFileSync(path.join(REPO_ROOT, "apps/platform/screens/setup.html"), "utf8"), /\/screens\/bookings\.html/);
      assert.match(fs.readFileSync(path.join(REPO_ROOT, "apps/platform/screens/inbox.html"), "utf8"), /\/screens\/bookings\.html/);
    });

    await check("after Go live, / goes to Bookings", async () => {
      const saved = await call("PUT", "/api/setup", { setup: SETUP }, rosa.cookie);
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
      const launched = await call("POST", "/api/setup/launch", undefined, rosa.cookie);
      assert.strictEqual(launched.status, 200, JSON.stringify(launched.data));
      const root = await call("GET", "/", undefined, rosa.cookie, html);
      assert.strictEqual(root.headers.get("location"), "/screens/bookings.html");
    });

    await check("the demo salon keeps its screens", async () => {
      const { createPlatformStore } = require("../backend/store");
      const { createAuth } = require("../backend/auth");
      process.env.PLATFORM_DB_PATH = TEST_DB;
      const store = createPlatformStore();
      createAuth({ store }).createOwner({ email: "demo@luminous.test", password: "demo-owner-pass-123", salonSlug: "luminous-core", displayName: "Demo" });
      store.db.close();
      const login = await call("POST", "/api/auth/login", { email: "demo@luminous.test", password: "demo-owner-pass-123" }, "");
      assert.strictEqual(login.status, 200, JSON.stringify(login.data));
      const demoCookie = String(login.headers.get("set-cookie") || "").split(";")[0];
      const screen = await call("GET", "/screens/salon-performance-luminous-core.html", undefined, demoCookie, html);
      assert.strictEqual(screen.status, 200);
      const root = await call("GET", "/", undefined, demoCookie, html);
      assert.strictEqual(root.headers.get("location"), "/screens/salon-performance-luminous-core.html");
    });

    await check("/c/<slug> is a public short link to the chat page", async () => {
      const result = await call("GET", `/c/${rosa.slug}`, undefined, "");
      assert.strictEqual(result.status, 302);
      assert.strictEqual(result.headers.get("location"), `/screens/chat.html?salon=${rosa.slug}`);
      const unknown = await call("GET", "/c/no-such-salon", undefined, "");
      assert.strictEqual(unknown.status, 404);
      const setup = await call("GET", "/api/setup", undefined, rosa.cookie);
      assert.strictEqual(setup.data.shortChatUrl, `https://salons.example.test/c/${rosa.slug}`);
    });

    // Telegram: the salon bot, the owner's chat, one client.
    const connected = await call("POST", "/api/setup/telegram", { token: BOT_TOKEN }, rosa.cookie);
    assert.strictEqual(connected.status, 200, JSON.stringify(connected.data));
    const hookSecret = telegramCalls.find((entry) => entry.method === "setWebhook").body.secret_token;
    const postHook = (update) => fetch(`${base}/api/telegram/hook/7200000001`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": hookSecret },
      body: JSON.stringify(update)
    });
    await postHook({ message: { chat: { id: 555, type: "private" }, from: { language_code: "en" }, text: `/start ${connected.data.ownerLink.split("start=")[1]}` } });
    await waitFor(() => telegramCalls.some((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "555"));

    const first = await call("GET", "/api/bookings", undefined, rosa.cookie);
    const today = first.data.today;
    const addDays = (iso, days) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
    const day2 = addDays(today, 2);
    const day3 = addDays(today, 3);
    let mayaBookingId = "";

    await check("a Telegram client books through Maya; Bookings shows channel, phone and who booked", async () => {
      const clientSays = async (text) => {
        telegramCalls.length = 0;
        await postHook({ message: { chat: { id: 777, type: "private" }, from: { language_code: "en", first_name: "Rita" }, text } });
        await waitFor(() => telegramCalls.some((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "777"));
      };
      await clientSays(`BOOKIT ${day2}`);
      await clientSays("yes");
      const result = await call("GET", "/api/bookings", undefined, rosa.cookie);
      assert.strictEqual(result.status, 200);
      const booking = result.data.bookings.find((entry) => entry.client === "Rita Client");
      assert.ok(booking, `Maya's booking is listed: ${JSON.stringify(result.data.bookings)} / ${serverLog.slice(-1500)}`);
      assert.strictEqual(booking.date, day2);
      assert.strictEqual(booking.start, 600);
      assert.strictEqual(booking.staff, "Olena");
      assert.strictEqual(booking.channel, "telegram");
      assert.strictEqual(booking.bookedBy, "maya");
      assert.strictEqual(booking.status, "booked");
      assert.match(booking.phone, /555.?0101/);
      mayaBookingId = booking.id;
    });

    await check("owner's test chats and other salons never show up, and the value skips add-ons and cancelled visits", async () => {
      const { createPlatformStore } = require("../backend/store");
      process.env.PLATFORM_DB_PATH = TEST_DB;
      const store = createPlatformStore();
      const scope = store.forSalon(rosa.slug);
      // An owner-made booking with a "from" price and an add-on booking.
      scope.createAppointment({ client: "Walk In", phone: "613-555-0199", service: "Pedicure", stylist: "Ira", date: "1:00 PM - 2:00 PM", dayOffset: 2 });
      scope.createAppointment({ client: "Addon Only", service: "Nail art add-on", stylist: "Ira", date: "3:00 PM - 3:15 PM", dayOffset: 3 });
      const cancelled = scope.createAppointment({ client: "Gone Client", service: "Gel manicure", stylist: "Ira", date: "4:00 PM - 5:00 PM", dayOffset: 3 });
      scope.cancelAppointment(cancelled, { reason: "client called" });
      // The owner's own web test chat books too: tagged as a preview session.
      const preview = await call("POST", "/api/assistant/chat", { salon: rosa.slug, sessionId: "web-owner-test-1", message: "hi" }, rosa.cookie);
      assert.strictEqual(preview.status, 200);
      const testId = scope.createAppointment({ client: "Owner Test", service: "Gel manicure", stylist: "Olena", date: "5:00 PM - 6:00 PM", dayOffset: 2 });
      store.db.prepare(`INSERT INTO assistant_events (salon_id, id, session_id, conversation_id, day, type, payload_json, created_at) VALUES (?, ?, ?, '', ?, 'booking', ?, ?)`)
        .run(rosa.slug, "aevt-test-1", "web-owner-test-1", today, JSON.stringify({ appointmentId: testId }), new Date().toISOString());
      // Another salon's booking.
      await call("PUT", "/api/setup", { setup: Object.assign({}, SETUP, { salon: Object.assign({}, SETUP.salon, { name: "Other Salon" }) }) }, other.cookie);
      store.syncDayAnchor(other.slug);
      store.forSalon(other.slug).createAppointment({ client: "Elsewhere Client", service: "Gel manicure", stylist: "Olena", date: "11:00 AM - 12:00 PM", dayOffset: 1 });
      store.db.close();

      const result = await call("GET", "/api/bookings", undefined, rosa.cookie);
      const names = result.data.bookings.map((entry) => entry.client).sort();
      assert.deepStrictEqual(names, ["Addon Only", "Gone Client", "Rita Client", "Walk In"]);
      assert.strictEqual(result.data.testCount, 1);
      const walkIn = result.data.bookings.find((entry) => entry.client === "Walk In");
      assert.strictEqual(walkIn.bookedBy, "owner");
      assert.strictEqual(result.data.bookings.find((entry) => entry.client === "Gone Client").status, "cancelled");
      // $55 (Rita) + at least $70 (Pedicure "from $70"); "+$15" is never a price.
      assert.deepStrictEqual(result.data.bookedValue, { amount: 125, counted: 2, atLeast: true, notCounted: 1, currency: "CAD" });
      const withTests = await call("GET", "/api/bookings?tests=1", undefined, rosa.cookie);
      assert.ok(withTests.data.bookings.some((entry) => entry.client === "Owner Test" && entry.test));
      const otherView = await call("GET", "/api/bookings", undefined, other.cookie);
      assert.deepStrictEqual(otherView.data.bookings.map((entry) => entry.client), ["Elsewhere Client"]);
      const cross = await call("GET", `/api/bookings?salon=${other.slug}`, undefined, rosa.cookie);
      assert.strictEqual(cross.status, 403, "an owner cannot read another salon's bookings");
      const anonymous = await call("GET", "/api/bookings", undefined, "");
      assert.strictEqual(anonymous.status, 401);
    });

    await check("rows flagged is_test are left out too (when the column exists)", async () => {
      const db = new (require("better-sqlite3"))(TEST_DB);
      const columns = db.prepare(`PRAGMA table_info(appointments)`).all().map((column) => column.name);
      if (!columns.includes("is_test")) db.prepare(`ALTER TABLE appointments ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`).run();
      db.prepare(`UPDATE appointments SET is_test = 1 WHERE salon_id = ? AND client_name = 'Walk In'`).run(rosa.slug);
      db.close();
      const result = await call("GET", "/api/bookings", undefined, rosa.cookie);
      assert.ok(!result.data.bookings.some((entry) => entry.client === "Walk In"));
      assert.strictEqual(result.data.bookedValue.amount, 55);
      const db2 = new (require("better-sqlite3"))(TEST_DB);
      db2.prepare(`UPDATE appointments SET is_test = 0 WHERE salon_id = ?`).run(rosa.slug);
      db2.close();
    });

    await check("a busy block makes Maya say the time is taken, and removing it frees it", async () => {
      const ask = async (session, time) => {
        lastToolResult = null;
        const result = await call("POST", "/api/assistant/chat", { salon: rosa.slug, sessionId: session, message: `CHECK ${day3} ${time}` }, "");
        assert.strictEqual(result.status, 200, JSON.stringify(result.data));
        assert.ok(lastToolResult && lastToolResult.requested_time, `tool result: ${JSON.stringify(lastToolResult)}`);
        return lastToolResult;
      };
      assert.strictEqual((await ask("web-block-1", "11:00")).requested_time.available, true, "free before the block");
      const bad = await call("POST", "/api/bookings/blocks", { staffId: "", date: day3, from: "14:00", to: "12:00" }, rosa.cookie);
      assert.strictEqual(bad.status, 422);
      const staff = (await call("GET", "/api/bookings", undefined, rosa.cookie)).data.staff;
      const olena = staff.find((entry) => entry.name === "Olena");
      const block = await call("POST", "/api/bookings/blocks", { staffId: olena.id, date: day3, from: "10:30", to: "12:30", reason: "Dentist" }, rosa.cookie);
      assert.strictEqual(block.status, 201, JSON.stringify(block.data));
      const taken = await ask("web-block-2", "11:00");
      assert.strictEqual(taken.requested_time.available, false, "Maya respects the block");
      assert.ok(!taken.slots.some((slot) => /^11:00 AM/.test(slot.time)), "no slot inside the block is offered");
      const listed = await call("GET", "/api/bookings", undefined, rosa.cookie);
      assert.strictEqual(listed.data.blocks.length, 1);
      assert.strictEqual(listed.data.blocks[0].staff, "Olena");
      assert.strictEqual(listed.data.blocks[0].reason, "Dentist");
      const removed = await call("DELETE", `/api/bookings/blocks/${block.data.id}`, undefined, rosa.cookie);
      assert.strictEqual(removed.status, 200);
      assert.strictEqual((await ask("web-block-3", "11:00")).requested_time.available, true, "free again");
      // A whole-salon block closes the time for everyone.
      const salonBlock = await call("POST", "/api/bookings/blocks", { staffId: "", date: day3, allDay: true, reason: "Holiday" }, rosa.cookie);
      assert.strictEqual(salonBlock.status, 201);
      assert.strictEqual((await ask("web-block-4", "15:00")).requested_time.available, false);
      const otherBlocks = await call("GET", "/api/bookings", undefined, other.cookie);
      assert.strictEqual(otherBlocks.data.blocks.length, 0, "blocks stay in their salon");
      await call("DELETE", `/api/bookings/blocks/${salonBlock.data.id}`, undefined, other.cookie).then((result) => assert.strictEqual(result.status, 404));
    });

    await check("cancelling a Telegram booking tells the client through the salon bot, Maya stays on", async () => {
      telegramCalls.length = 0;
      const result = await call("POST", `/api/bookings/${encodeURIComponent(mayaBookingId)}/cancel`, { reason: "Olena is sick." }, rosa.cookie);
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.told.channel, "telegram");
      assert.strictEqual(result.data.told.delivery, "delivered");
      const sent = telegramCalls.find((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "777");
      assert.ok(sent, "the client got a message");
      assert.match(sent.body.text, /cancel/i);
      assert.match(sent.body.text, /Olena is sick/);
      const again = await call("POST", `/api/bookings/${encodeURIComponent(mayaBookingId)}/cancel`, {}, rosa.cookie);
      assert.strictEqual(again.status, 409);
      const view = await call("GET", "/api/bookings", undefined, rosa.cookie);
      assert.strictEqual(view.data.bookings.find((entry) => entry.id === mayaBookingId).status, "cancelled");
      const inbox = await call("GET", "/api/inbox", undefined, rosa.cookie);
      const thread = inbox.data.conversations.find((conversation) => conversation.kind === "telegram");
      assert.notStrictEqual(thread.state, "takeover", "a cancellation notice does not pause Maya");
      const foreign = await call("POST", `/api/bookings/${encodeURIComponent(mayaBookingId)}/cancel`, {}, other.cookie);
      assert.strictEqual(foreign.status, 404, "another salon cannot cancel it");
    });

    await check("the plan request confirms to the owner in Telegram, with seller and invoice email", async () => {
      telegramCalls.length = 0;
      const result = await call("POST", "/api/setup/plan", { plan: "salon", addons: ["sms_reminders"], cycle: "monthly" }, rosa.cookie);
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.plan.sellerPlace, "Ottawa, Canada");
      assert.strictEqual(result.data.plan.ownerEmail, "owner@rosa.test");
      const sent = await waitFor(() => telegramCalls.find((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === "555"));
      assert.ok(sent, "the owner got a confirmation");
      assert.match(sent.body.text, /Salon/);
      assert.match(sent.body.text, /\$98/);
      assert.match(sent.body.text, /owner@rosa\.test/);
      assert.match(sent.body.text, /INNOVA CONSULT LTD, Ottawa, Canada/);
      assert.match(sent.body.text, /nothing stops/);
    });

    console.log(`owner-surfaces: ${passed} checks passed`);
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
