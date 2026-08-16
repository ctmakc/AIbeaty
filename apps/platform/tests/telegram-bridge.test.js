#!/usr/bin/env node
"use strict";

// Offline test suite for apps/platform/telegram-bridge.js.
//
// Boots two local stubs — a mock Telegram Bot API (long-poll getUpdates,
// sendMessage, sendChatAction, getMe, deleteWebhook) and a mock assistant
// /api/assistant/chat — then spawns the real bridge as a child process and
// drives it with pushed updates. No network, no real token, no LLM.
//
// Run: npm run assistant:telegram:test

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const FAKE_TOKEN = "4242424242:TEST-fake-token-for-bridge-suite";
const BRIDGE_PATH = path.join(__dirname, "..", "telegram-bridge.js");

let passed = 0;
let failed = 0;
function check(condition, name, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`timeout waiting for: ${label || "condition"}`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

// --- mock Telegram Bot API ---------------------------------------------------

function createTelegramStub() {
  const state = {
    calls: [], // { method, body }
    queue: [], // pending updates
    nextUpdateId: 100,
    badTokenHits: 0
  };

  const server = http.createServer(async (request, response) => {
    const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const [, token, method] = match;
    if (token !== FAKE_TOKEN) {
      state.badTokenHits += 1;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }));
      return;
    }
    const body = await readJsonBody(request).catch(() => ({}));
    state.calls.push({ method, body });

    const reply = (payload) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (method === "getMe") {
      return reply({ ok: true, result: { id: 4242, is_bot: true, first_name: "Maya", username: "aibeaty_demo_bot" } });
    }
    if (method === "deleteWebhook") {
      return reply({ ok: true, result: true });
    }
    if (method === "sendChatAction") {
      return reply({ ok: true, result: true });
    }
    if (method === "sendMessage") {
      return reply({ ok: true, result: { message_id: state.calls.length } });
    }
    if (method === "getUpdates") {
      const offset = Number(body.offset) || 0;
      const holdMs = Math.min((Number(body.timeout) || 0) * 1000, 2000);
      const deadline = Date.now() + holdMs;
      const pending = () => state.queue.filter((update) => update.update_id >= offset);
      while (pending().length === 0 && Date.now() < deadline) {
        await sleep(30);
      }
      const updates = pending();
      state.queue = state.queue.filter((update) => update.update_id < offset);
      return reply({ ok: true, result: updates });
    }
    return reply({ ok: false, error_code: 400, description: `unknown method ${method}` });
  });

  state.push = (message) => {
    state.nextUpdateId += 1;
    state.queue.push({ update_id: state.nextUpdateId, message });
  };
  state.sent = () => state.calls.filter((call) => call.method === "sendMessage");
  state.typing = () => state.calls.filter((call) => call.method === "sendChatAction");
  state.server = server;
  return state;
}

// --- mock assistant ----------------------------------------------------------

function createAssistantStub() {
  const state = { chats: [] }; // recorded /api/assistant/chat bodies

  const server = http.createServer(async (request, response) => {
    const reply = (status, payload) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && request.url === "/api/assistant/health") {
      return reply(200, { ok: true, persona: "Maya", model: "mock" });
    }
    if (request.method === "POST" && request.url === "/api/assistant/chat") {
      const body = await readJsonBody(request).catch(() => ({}));
      state.chats.push(body);
      const message = String(body.message || "");
      if (message === "boom") return reply(500, { error: "llm_upstream" });
      if (message === "flood") return reply(429, { error: "rate_limited" });
      if (message === "silent") return reply(200, { reply: null, state: { assistantState: "takeover" } });
      if (message === "long") return reply(200, { reply: "Д".repeat(9000), state: {} });
      return reply(200, { reply: `echo:${message}`, state: { language: "ru" } });
    }
    return reply(404, { error: "not_found" });
  });

  state.server = server;
  return state;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

// --- suite -------------------------------------------------------------------

async function main() {
  console.log("telegram-bridge test suite (mock Telegram API + mock assistant)");

  const tg = createTelegramStub();
  const assistant = createAssistantStub();
  const tgPort = await listen(tg.server);
  const assistantPort = await listen(assistant.server);

  let childOutput = "";
  const child = spawn(process.execPath, [BRIDGE_PATH], {
    env: Object.assign({}, process.env, {
      TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      ASSISTANT_BASE_URL: `http://127.0.0.1:${assistantPort}`,
      TELEGRAM_POLL_TIMEOUT_SEC: "1"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => (childOutput += chunk.toString()));
  child.stderr.on("data", (chunk) => (childOutput += chunk.toString()));

  const chat = { id: 1001, type: "private" };
  const from = { id: 555, is_bot: false, first_name: "Тест" };

  try {
    // 1. startup handshake
    await waitFor(() => tg.calls.some((call) => call.method === "getMe"), 5000, "getMe");
    check(true, "startup: getMe called with the token");
    await waitFor(() => tg.calls.some((call) => call.method === "deleteWebhook"), 3000, "deleteWebhook");
    check(true, "startup: deleteWebhook cleared (long poll cannot coexist with a webhook)");
    check(tg.badTokenHits === 0, "startup: no requests with a wrong token");

    // 2. /start → canned persona greeting, no LLM round-trip
    tg.push({ message_id: 1, chat, from, text: "/start" });
    const greeting = await waitFor(() => tg.sent()[0], 5000, "/start greeting");
    check(greeting.body.chat_id === 1001, "/start: greeting goes to the right chat");
    check(/Майя/.test(greeting.body.text) && /ИИ/.test(greeting.body.text), "/start: greeting is Maya + honest AI disclosure");
    check(/позвать человека/.test(greeting.body.text), "/start: greeting offers the human escape hatch");
    const keyboard = greeting.body.reply_markup && greeting.body.reply_markup.keyboard;
    check(
      Boolean(keyboard && keyboard[0] && keyboard[0][0] && keyboard[0][0].request_contact === true),
      "/start: contact-share keyboard attached"
    );
    check(assistant.chats.length === 0, "/start: no assistant/LLM call for the greeting");

    // 3. plain text → typing + forwarded to the assistant → reply relayed
    tg.push({ message_id: 2, chat, from, text: "Хочу записаться на балаяж" });
    const forwarded = await waitFor(() => assistant.chats[0], 5000, "assistant call");
    check(forwarded.sessionId === "tg:1001", "text: sessionId is tg:<chat_id>");
    check(forwarded.channel === "telegram", "text: channel is telegram");
    check(forwarded.message === "Хочу записаться на балаяж", "text: message forwarded verbatim");
    check(forwarded.clientPhone === undefined, "text: no clientPhone before a contact share");
    const relayed = await waitFor(
      () => tg.sent().find((call) => call.body.text === "echo:Хочу записаться на балаяж"),
      5000,
      "relayed reply"
    );
    check(Boolean(relayed), "text: assistant reply relayed to Telegram");
    check(
      tg.typing().some((call) => call.body.chat_id === 1001 && call.body.action === "typing"),
      "text: typing action sent while waiting"
    );

    // 4. contact share → phone remembered and forwarded, keyboard removed
    tg.push({
      message_id: 3,
      chat,
      from,
      contact: { phone_number: "1 (555) 000-0001", first_name: "Тест", user_id: 555 }
    });
    const contactCall = await waitFor(() => assistant.chats[1], 5000, "contact assistant call");
    check(contactCall.clientPhone === "+15550000001", "contact: phone normalized and passed as clientPhone");
    check(/\+15550000001/.test(contactCall.message), "contact: Maya is told the phone in the message");
    const contactReply = await waitFor(
      () => tg.sent().find((call) => /^echo:/.test(call.body.text || "") && /\+15550000001/.test(call.body.text)),
      5000,
      "contact reply"
    );
    check(
      Boolean(contactReply.body.reply_markup && contactReply.body.reply_markup.remove_keyboard === true),
      "contact: share-keyboard removed after the share"
    );

    tg.push({ message_id: 4, chat, from, text: "а когда ближайшее окно?" });
    const afterContact = await waitFor(() => assistant.chats[2], 5000, "post-contact call");
    check(afterContact.clientPhone === "+15550000001", "contact: later messages keep carrying clientPhone");

    // 5. assistant 500 → graceful fallback, bridge stays alive
    const sentBeforeBoom = tg.sent().length;
    tg.push({ message_id: 5, chat, from, text: "boom" });
    const fallback = await waitFor(() => tg.sent()[sentBeforeBoom], 5000, "fallback message");
    check(/позвать человека/.test(fallback.body.text), "error: graceful fallback offers the human handoff");
    check(!/boom|500|Error/.test(fallback.body.text), "error: fallback exposes no internals");

    // 6. assistant 429 → polite slow-down
    const sentBeforeFlood = tg.sent().length;
    tg.push({ message_id: 6, chat, from, text: "flood" });
    const slowDown = await waitFor(() => tg.sent()[sentBeforeFlood], 5000, "rate-limit message");
    check(/не успеваю|Секундочку/.test(slowDown.body.text), "rate limit: polite slow-down relayed");

    // 7. reply:null (takeover/escalated) → bot stays silent
    const sentBeforeSilent = tg.sent().length;
    const chatsBeforeSilent = assistant.chats.length;
    tg.push({ message_id: 7, chat, from, text: "silent" });
    await waitFor(() => assistant.chats.length > chatsBeforeSilent, 5000, "silent assistant call");
    await sleep(700);
    check(tg.sent().length === sentBeforeSilent, "takeover: reply:null sends nothing (message still stored server-side)");

    // 8. non-text message → polite text-only notice, no assistant call
    const chatsBeforeSticker = assistant.chats.length;
    const sentBeforeSticker = tg.sent().length;
    tg.push({ message_id: 8, chat, from, sticker: { file_id: "abc" } });
    const stickerReply = await waitFor(() => tg.sent()[sentBeforeSticker], 5000, "non-text notice");
    check(/только текст/.test(stickerReply.body.text), "non-text: polite text-only notice");
    check(assistant.chats.length === chatsBeforeSticker, "non-text: no assistant call");

    // 9. long reply → chunked under Telegram's 4096 limit, nothing lost
    const sentBeforeLong = tg.sent().length;
    tg.push({ message_id: 9, chat, from, text: "long" });
    await waitFor(() => tg.sent().length >= sentBeforeLong + 3, 6000, "long reply chunks");
    const longChunks = tg.sent().slice(sentBeforeLong);
    check(longChunks.length === 3, "long reply: split into 3 chunks", `got ${longChunks.length}`);
    check(
      longChunks.every((call) => call.body.text.length <= 4096),
      "long reply: every chunk within Telegram's 4096 limit"
    );
    check(
      longChunks.map((call) => call.body.text).join("") === "Д".repeat(9000),
      "long reply: concatenation is byte-identical"
    );

    // 10. secrets discipline: raw token never appears in bridge logs
    check(!childOutput.includes(FAKE_TOKEN), "secrets: bot token never printed to stdout/stderr");

    // 11. clean shutdown on SIGTERM
    const exitCode = await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.kill("SIGTERM");
      setTimeout(() => resolve("timeout"), 4000);
    });
    check(exitCode === 0, "shutdown: SIGTERM exits 0 promptly", `got ${exitCode}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  suite aborted — ${error.message}`);
    console.log("--- bridge output ---");
    console.log(childOutput);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    tg.server.close();
    assistant.server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
