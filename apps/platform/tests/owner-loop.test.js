#!/usr/bin/env node
// The owner ↔ client loop over REAL HTTP, with a stub Telegram and a stub LLM:
//   - an owner's answer from the inbox reaches the client's Telegram chat
//     (delivered / failed recorded) or the web chat (waiting → seen);
//   - the owner's own Telegram chat is never a client: a reply to an alert is
//     forwarded to that client, anything else gets help and never reaches Maya;
//   - alerts are one readable message per event, in the owner's language, with
//     the client's name, no internal codes, and no health text for a medspa.
//
// Run: node apps/platform/tests/owner-loop.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-owner-loop-"));
const TEST_DB = path.join(TEST_DIR, "platform.db");
const BOT_TOKEN = "7100000001:AAtestTokenForTheOwnerLoopSuite_abcdefgh";
const BLOCKED_CHAT = "999"; // the stub refuses to deliver here (client blocked the bot)

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

// --- stub Telegram: sendMessage returns a real-looking message with an id ---
const telegramCalls = [];
let nextMessageId = 1000;
function startTelegramStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const method = match ? match[2] : "";
    const entry = { method, body };
    telegramCalls.push(entry);
    response.setHeader("Content-Type", "application/json");
    if (method === "getMe") {
      response.end(JSON.stringify({ ok: true, result: { id: 7100000001, is_bot: true, username: "loop_salon_bot" } }));
      return;
    }
    if (method === "sendMessage") {
      if (String(body.chat_id) === BLOCKED_CHAT) {
        response.end(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }));
        return;
      }
      nextMessageId += 1;
      entry.resultId = nextMessageId;
      response.end(JSON.stringify({ ok: true, result: { message_id: nextMessageId, chat: { id: body.chat_id }, text: body.text } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: true }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

let llmCalls = 0;
function startLlmStub(port) {
  const server = http.createServer(async (request, response) => {
    await readJson(request);
    llmCalls += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello! How can I help you today?" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, ms = 5000) {
  for (let waited = 0; waited < ms; waited += 50) {
    const value = predicate();
    if (value) return value;
    await sleep(50);
  }
  return predicate();
}

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
      SESSION_SECRET: "test-session-secret-owner-loop",
      LLM_API_KEY: "stub",
      LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
      LLM_MODEL: "stub-model",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      PUBLIC_BASE_URL: "https://salons.example.test",
      ALERT_EMAIL: "",
      PLATFORM_EMAIL: "",
      TENANCY_TICKER: "0",
      OWNER_ALERT_DELAY_MS: "300"
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
      try {
        if ((await fetch(`${base}/api/assistant/health`)).ok) break;
      } catch (error) { /* not up yet */ }
      await sleep(200);
    }

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
    const openDb = () => new (require("better-sqlite3"))(TEST_DB);

    // --- a launched salon with a bot and a linked owner chat ---------------
    const signup = await call("POST", "/api/auth/signup", { email: "owner@loop.test", password: "long-enough-pass-1", salonName: "Loop Lashes", timezone: "America/Toronto", businessType: "lashes_brows" });
    assert.strictEqual(signup.status, 201, JSON.stringify(signup.data));
    cookie = String(signup.headers.get("set-cookie") || "").split(";")[0];
    const slug = signup.data.salonSlug;
    const saved = await call("PUT", "/api/setup", {
      salon: { name: "Loop Lashes", timezone: "America/Toronto" },
      hours: { mon: "10:00-19:00", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00", sun: "closed" },
      services: [{ name: "Classic lash set", durationMinutes: 90, price: "$120" }],
      staff: [{ name: "Anna", workDays: ["mon", "tue", "wed", "thu", "fri", "sat"] }]
    });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
    assert.strictEqual((await call("POST", "/api/setup/launch", {})).status, 200);
    const connected = await call("POST", "/api/setup/telegram", { token: BOT_TOKEN });
    assert.strictEqual(connected.status, 200, JSON.stringify(connected.data));
    const hookSecret = telegramCalls.find((entry) => entry.method === "setWebhook").body.secret_token;
    const postHook = (update) => fetch(`${base}/api/telegram/hook/7100000001`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": hookSecret },
      body: JSON.stringify({ update_id: Date.now(), message: Object.assign({ message_id: Math.floor(Math.random() * 1e6), date: 0 }, update) })
    });
    const toChat = (chatId) => telegramCalls.filter((entry) => entry.method === "sendMessage" && String(entry.body.chat_id) === String(chatId));

    await check("linking the owner chat explains replies and points testing to the web chat", async () => {
      const code = connected.data.ownerLink.split("start=")[1];
      telegramCalls.length = 0;
      await postHook({ chat: { id: 555, type: "private" }, from: { id: 555, language_code: "en" }, text: `/start ${code}` });
      const sent = await waitFor(() => toChat(555)[0]);
      assert.ok(sent, "owner got a confirmation");
      assert.match(sent.body.text, /reply to their alert/i);
      assert.match(sent.body.text, /chat\.html\?salon=/);
      assert.doesNotMatch(sent.body.text, /message this bot as a client/i);
    });

    let alert = null;
    await check("a client asking for a person: one readable alert with their name, no internal code", async () => {
      telegramCalls.length = 0;
      await postHook({ chat: { id: 777, type: "private" }, from: { id: 777, first_name: "Olena", last_name: "K", language_code: "en" }, text: "I want to talk to a human please" });
      alert = await waitFor(() => toChat(555)[0]);
      assert.ok(alert, `owner alerted; calls: ${JSON.stringify(telegramCalls.map((entry) => [entry.method, entry.body.chat_id]))}`);
      assert.match(alert.body.text, /Olena K needs a person/);
      assert.match(alert.body.text, /asked to talk to a person/);
      assert.match(alert.body.text, /Reply to this message/);
      assert.match(alert.body.text, /unified-inbox-luminous-core\.html\?conversationId=/);
      assert.doesNotMatch(alert.body.text, /explicit_request|Резюме|Веб-гость/);
      await sleep(700);
      assert.strictEqual(toChat(555).length, 1, "one alert per event, not several");
    });

    await check("the owner replies to the alert in Telegram → the text reaches the client's chat", async () => {
      telegramCalls.length = 0;
      const llmBefore = llmCalls;
      await postHook({
        chat: { id: 555, type: "private" },
        from: { id: 555, language_code: "en" },
        text: "Hi Olena, this is Anna. I can see you Saturday at 11.",
        reply_to_message: { message_id: alert.resultId, chat: { id: 555 } }
      });
      const toClient = await waitFor(() => toChat(777)[0]);
      assert.ok(toClient, `client got the owner's words; calls: ${JSON.stringify(telegramCalls.map((entry) => [entry.method, entry.body.chat_id, entry.body.text]))}`);
      assert.strictEqual(toClient.body.text, "Hi Olena, this is Anna. I can see you Saturday at 11.");
      const confirmation = await waitFor(() => toChat(555)[0]);
      assert.match(confirmation.body.text, /Sent to Olena K/);
      assert.strictEqual(llmCalls, llmBefore, "Maya was not asked");
      const inbox = await call("GET", "/api/inbox");
      const thread = inbox.data.conversations.find((conversation) => conversation.name === "Olena K");
      const staff = thread.messages.filter((message) => message.author === "staff");
      assert.strictEqual(staff.length, 1);
      assert.strictEqual(staff[0].delivery, "delivered");
      assert.strictEqual(thread.kind, "telegram");
    });

    await check("owner free text in their chat gets help, never Maya", async () => {
      telegramCalls.length = 0;
      const llmBefore = llmCalls;
      await postHook({ chat: { id: 555, type: "private" }, from: { id: 555, language_code: "en" }, text: "hello? is this working" });
      const help = await waitFor(() => toChat(555)[0]);
      assert.match(help.body.text, /Maya does not answer here/);
      assert.match(help.body.text, /unified-inbox-luminous-core\.html/);
      assert.match(help.body.text, /chat\.html\?salon=/);
      await sleep(300);
      assert.strictEqual(llmCalls, llmBefore, "the owner's message did not reach the LLM");
      assert.strictEqual(toChat(555).length, 1);
      const inbox = await call("GET", "/api/inbox");
      assert.ok(!inbox.data.conversations.some((conversation) => /555/.test(conversation.name)), "the owner is not a client thread");
    });

    await check("a reply to an unknown message tells the owner how to answer", async () => {
      telegramCalls.length = 0;
      await postHook({ chat: { id: 555, type: "private" }, from: { id: 555 }, text: "ok", reply_to_message: { message_id: 1, chat: { id: 555 } } });
      const note = await waitFor(() => toChat(555)[0]);
      assert.match(note.body.text, /can't tell which client/);
    });

    let threadId = "";
    await check("an answer from the inbox reaches the Telegram client and is marked delivered", async () => {
      const inbox = await call("GET", "/api/inbox");
      threadId = inbox.data.conversations.find((conversation) => conversation.name === "Olena K").id;
      telegramCalls.length = 0;
      const sent = await call("POST", `/api/inbox/conversations/${encodeURIComponent(threadId)}/reply`, { text: "See you Saturday!" });
      assert.strictEqual(sent.status, 201, JSON.stringify(sent.data));
      assert.strictEqual(sent.data.delivery, "delivered");
      assert.strictEqual(toChat(777).slice(-1)[0].body.text, "See you Saturday!");
      // The Luminous Core console route delivers too.
      telegramCalls.length = 0;
      const legacy = await call("POST", `/api/platform/inbox/conversations/${encodeURIComponent(threadId)}/messages`, { text: "Parking is behind the building." });
      assert.strictEqual(legacy.status, 201, JSON.stringify(legacy.data));
      assert.strictEqual(legacy.data.delivery.status, "delivered");
      assert.strictEqual(toChat(777).slice(-1)[0].body.text, "Parking is behind the building.");
    });

    await check("an answer Telegram refuses is marked failed with the reason", async () => {
      await postHook({ chat: { id: Number(BLOCKED_CHAT), type: "private" }, from: { id: 9, first_name: "Marc", language_code: "en" }, text: "I want to talk to a human please" });
      await waitFor(() => false, 400);
      const inbox = await call("GET", "/api/inbox");
      const thread = inbox.data.conversations.find((conversation) => conversation.name === "Marc");
      assert.ok(thread, "Marc's thread exists");
      const sent = await call("POST", `/api/inbox/conversations/${encodeURIComponent(thread.id)}/reply`, { text: "Hello Marc" });
      assert.strictEqual(sent.data.delivery, "failed");
      assert.match(sent.data.note, /blocked/);
    });

    await check("web chat: the owner's answer waits, the chat page fetches it, then it is seen", async () => {
      const sessionId = "web-3f1c2b7e-aaaa-bbbb-cccc-123456789abc";
      const chat = await call("POST", "/api/assistant/chat", { salon: slug, sessionId, message: "Do you do lash lifts?" }, { Cookie: "" });
      assert.strictEqual(chat.status, 200, JSON.stringify(chat.data));
      const inbox = await call("GET", "/api/inbox");
      const thread = inbox.data.conversations.find((conversation) => conversation.kind === "web");
      assert.ok(thread, "web thread listed");
      assert.match(thread.name, /^Web client /);
      const sent = await call("POST", `/api/inbox/conversations/${encodeURIComponent(thread.id)}/reply`, { text: "Yes, lash lifts are $85." });
      assert.strictEqual(sent.data.delivery, "waiting");
      const updates = await call("GET", `/api/assistant/updates?salon=${slug}&sessionId=${sessionId}`, undefined, { Cookie: "" });
      assert.strictEqual(updates.status, 200);
      assert.deepStrictEqual(updates.data.messages.map((message) => message.text), ["Yes, lash lifts are $85."]);
      const later = await call("GET", `/api/assistant/updates?salon=${slug}&sessionId=${sessionId}&after=${encodeURIComponent(updates.data.messages[0].createdAt)}`, undefined, { Cookie: "" });
      assert.deepStrictEqual(later.data.messages, []);
      const after = await call("GET", "/api/inbox");
      const message = after.data.conversations.find((conversation) => conversation.id === thread.id).messages.find((entry) => entry.author === "staff");
      assert.strictEqual(message.delivery, "seen");
      const tgGuess = await call("GET", `/api/assistant/updates?salon=${slug}&sessionId=${encodeURIComponent("tg:7100000001:777")}`, undefined, { Cookie: "" });
      assert.deepStrictEqual(tgGuess.data.messages, [], "Telegram session ids are not readable from the web");
    });

    await check("handing a thread back to Maya", async () => {
      const result = await call("POST", `/api/inbox/conversations/${encodeURIComponent(threadId)}/maya`, { active: true });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      const inbox = await call("GET", "/api/inbox");
      assert.strictEqual(inbox.data.conversations.find((conversation) => conversation.id === threadId).state, "maya");
    });

    await check("alerts speak the owner's language (French)", async () => {
      const db = openDb();
      db.prepare(`UPDATE tenants SET language = 'fr' WHERE salon_slug = ?`).run(slug);
      db.close();
      telegramCalls.length = 0;
      await postHook({ chat: { id: 781, type: "private" }, from: { id: 781, first_name: "Julie", language_code: "fr" }, text: "Bonjour, je veux parler à une personne svp" });
      const frAlert = await waitFor(() => toChat(555)[0]);
      assert.ok(frAlert, "alert sent");
      assert.match(frAlert.body.text, /Julie veut parler à quelqu'un/);
      assert.match(frAlert.body.text, /Répondez à ce message/);
    });

    await check("medspa: a health question alert carries no health details", async () => {
      const db = openDb();
      db.prepare(`UPDATE tenants SET language = 'en', business_type = 'medspa' WHERE salon_slug = ?`).run(slug);
      db.close();
      telegramCalls.length = 0;
      await postHook({ chat: { id: 782, type: "private" }, from: { id: 782, first_name: "Priya", language_code: "en" }, text: "I am pregnant and have an allergy rash, can I still get lashes?" });
      const medAlert = await waitFor(() => toChat(555)[0]);
      assert.ok(medAlert, "alert sent");
      assert.match(medAlert.body.text, /Medical question\. Open the conversation/);
      assert.doesNotMatch(medAlert.body.text, /pregnan|allerg|rash/i);
    });

    await check("the alert link opens the salon's own inbox, not the demo console", async () => {
      const page = await call("GET", `/screens/unified-inbox-luminous-core.html?conversationId=${encodeURIComponent(threadId)}`, undefined, { Accept: "text/html" });
      assert.strictEqual(page.status, 200);
      assert.match(String(page.data), /id="tenant-inbox"/);
      assert.doesNotMatch(String(page.data), /Sarah J\.|Luminous Core<|Precision OS|Emma Thompson/);
    });

    console.log(`owner-loop: ${passed} checks passed`);
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
