#!/usr/bin/env node
"use strict";

// Telegram long-polling bridge for Maya, the AIbeaty salon assistant.
//
// Zero dependencies: raw fetch against the Telegram Bot API (long polling, no
// webhook, works from behind NAT) forwarding messages to the platform's
// POST /api/assistant/chat and sending Maya's replies back.
//
//   sessionId   = tg:<chat_id>   (one assistant thread per Telegram chat)
//   channel     = "telegram"
//   clientPhone = from a Telegram contact share, if the client offers it
//
// Config (env only — the token is NEVER read from a file in the repo,
// never logged, never committed):
//   TELEGRAM_BOT_TOKEN         required, from @BotFather
//   ASSISTANT_BASE_URL         default http://127.0.0.1:4174
//   TELEGRAM_API_BASE          default https://api.telegram.org (tests point it at a stub)
//   TELEGRAM_POLL_TIMEOUT_SEC  default 50 (long-poll hold time)
//   TELEGRAM_SALON_SLUG        which salon this bot answers for (default: the
//                              server's default salon). One bot = one salon.
//
// Run: npm run assistant:telegram
// Only ONE bridge instance may poll a given bot token at a time.

const fs = require("fs");
const path = require("path");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TG_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const ASSISTANT_BASE = (
  process.env.ASSISTANT_BASE_URL ||
  `http://127.0.0.1:${process.env.PORT || process.env.PLATFORM_PORT || 4174}`
).replace(/\/+$/, "");
const POLL_TIMEOUT_SEC = Math.max(1, Number(process.env.TELEGRAM_POLL_TIMEOUT_SEC) || 50);
// A Telegram bot belongs to exactly one salon: every message it relays is
// tagged with this slug, so two salons can run two bots against one server.
const SALON_SLUG = (process.env.TELEGRAM_SALON_SLUG || "").trim();
const ASSISTANT_TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS) || 120000;
const TYPING_INTERVAL_MS = 4000; // Telegram "typing…" status fades after ~5s
const MAX_TG_MESSAGE = 4096;

if (!TOKEN) {
  console.error(
    "TELEGRAM_BOT_TOKEN is not set.\n" +
      "Create a bot via @BotFather (/newbot), put the token in the server's .env\n" +
      "(gitignored — never commit or print it), then restart. See README-DEMO.md."
  );
  process.exit(1);
}

// --- logging (token never reaches stdout/stderr) -----------------------------

function redact(value) {
  const text =
    value instanceof Error
      ? value.stack || value.message
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return String(text).split(TOKEN).join("<bot-token>");
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts.map(redact));
}

// --- persona texts -----------------------------------------------------------

// The salon's display name comes from the server (the salon record), with the
// local FAQ file as an offline fallback. Never a hardcoded salon.
function loadSalonFallback() {
  try {
    const faq = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "salon-faq.json"), "utf8"));
    if (faq && faq.salon && faq.salon.name) return faq.salon;
  } catch (error) {
    // fall through to the generic name
  }
  return { name: "нашего салона", city: "" };
}

let SALON = loadSalonFallback();

async function refreshSalonFromServer() {
  const url = `${ASSISTANT_BASE}/api/assistant/health${SALON_SLUG ? `?salon=${encodeURIComponent(SALON_SLUG)}` : ""}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const info = await response.json();
  if (info && info.salon) {
    SALON = { name: info.salon, city: info.city || "" };
    TEXTS.greeting = buildGreeting(SALON.name);
  }
  return info;
}

function buildGreeting(name) {
  return (
    `Привет! Я Майя — ассистентка салона «${name}» 🙂 Я ИИ, но расписание знаю наизусть: ` +
    "могу записать, перенести визит или ответить на вопросы о ценах и услугах. " +
    "Если захотите живого человека — просто напишите «позвать человека». " +
    "(English is fine too — just write to me.)\n\n" +
    "С чего начнём?"
  );
}

const TEXTS = {
  greeting:
    `Привет! Я Майя — ассистентка салона «${SALON.name}» 🙂 Я ИИ, но расписание знаю наизусть: ` +
    "могу записать, перенести визит или ответить на вопросы о ценах и услугах. " +
    "Если захотите живого человека — просто напишите «позвать человека». " +
    "(English is fine too — just write to me.)\n\n" +
    "С чего начнём?",
  shareHint: "📱 Поделиться номером",
  fallback:
    "Ой, я на секунду потеряла связь с салоном 😳 Напишите, пожалуйста, ещё раз чуть позже — " +
    "или скажите «позвать человека», и вам ответит живой администратор.",
  rateLimited: "Сообщений так много, что я не успеваю 🙂 Секундочку — и продолжим.",
  nonText:
    "Пока я понимаю только текст 🙂 Напишите словами, что нужно — запись, перенос, вопрос о ценах. " +
    "Или скажите «позвать человека»."
};

// --- Telegram API ------------------------------------------------------------

async function tgCall(method, payload, timeoutMs) {
  const response = await fetch(`${TG_BASE}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs || 30000)
  });
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`telegram ${method}: HTTP ${response.status}, non-JSON body`);
  }
  if (!body.ok) {
    throw new Error(`telegram ${method}: HTTP ${response.status} ${body.description || "error"} (code ${body.error_code})`);
  }
  return body;
}

async function sendText(chatId, text, extra) {
  const full = String(text == null ? "" : text).trim();
  if (!full) return;
  const chunks = [];
  let rest = full;
  while (rest.length > MAX_TG_MESSAGE) {
    chunks.push(rest.slice(0, MAX_TG_MESSAGE));
    rest = rest.slice(MAX_TG_MESSAGE);
  }
  chunks.push(rest);
  for (let i = 0; i < chunks.length; i += 1) {
    const payload = Object.assign(
      { chat_id: chatId, text: chunks[i] },
      i === chunks.length - 1 ? extra || {} : {}
    );
    await tgCall("sendMessage", payload);
  }
}

function startTyping(chatId) {
  const ping = () => tgCall("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  const timer = setInterval(ping, TYPING_INTERVAL_MS);
  return () => clearInterval(timer);
}

// --- assistant API -----------------------------------------------------------

const phonesByChat = new Map(); // chat_id -> phone from a contact share

async function askMaya(chatId, text) {
  const body = { sessionId: `tg:${chatId}`, message: text, channel: "telegram" };
  if (SALON_SLUG) body.salon = SALON_SLUG;
  const phone = phonesByChat.get(chatId);
  if (phone) body.clientPhone = phone;

  const response = await fetch(`${ASSISTANT_BASE}/api/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ASSISTANT_TIMEOUT_MS)
  });
  if (response.status === 429) return { kind: "rate_limited" };
  if (!response.ok) throw new Error(`assistant HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`assistant error: ${data.error}`);
  return { kind: "ok", reply: data.reply, state: data.state };
}

async function relayToMaya(chatId, text, extraOnReply) {
  const stopTyping = startTyping(chatId);
  try {
    const result = await askMaya(chatId, text);
    stopTyping();
    if (result.kind === "rate_limited") {
      await sendText(chatId, TEXTS.rateLimited);
      return;
    }
    if (result.reply === null || result.reply === undefined) {
      // Bot silenced (human takeover / escalated thread). The message is
      // already stored in the inbox for the owner — stay quiet.
      log(`chat ${chatId}: bot silenced, message stored for the owner`);
      return;
    }
    await sendText(chatId, result.reply, extraOnReply);
  } catch (error) {
    stopTyping();
    log(`chat ${chatId}: assistant/LLM error →`, error);
    await sendText(chatId, TEXTS.fallback).catch((sendError) => log("fallback send failed:", sendError));
  }
}

// --- message handling --------------------------------------------------------

function normalizePhone(raw) {
  const cleaned = String(raw || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
}

async function handleMessage(message) {
  if (!message || !message.chat || (message.from && message.from.is_bot)) return;
  const chatId = message.chat.id;

  // Contact share → remember the phone for this chat, let Maya greet by name.
  if (message.contact && message.contact.phone_number) {
    const phone = normalizePhone(message.contact.phone_number);
    if (phone) phonesByChat.set(chatId, phone);
    log(`chat ${chatId}: contact shared`);
    await relayToMaya(chatId, `Мой номер телефона: ${phone}`, {
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  const text = typeof message.text === "string" ? message.text.trim() : "";

  if (!text) {
    await sendText(chatId, TEXTS.nonText);
    return;
  }

  // /start (including deep links "/start something") → instant canned greeting
  // per the persona: honest AI disclosure + escape hatch, no LLM round-trip.
  if (/^\/start(\s|$)/.test(text)) {
    await sendText(chatId, TEXTS.greeting, {
      reply_markup: {
        keyboard: [[{ text: TEXTS.shareHint, request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true
      }
    });
    return;
  }

  if (/^\/help(\s|$)/.test(text)) {
    await sendText(chatId, TEXTS.greeting);
    return;
  }

  await relayToMaya(chatId, text);
}

// --- long-poll loop ----------------------------------------------------------

let running = true;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const me = await tgCall("getMe", {});
  // A leftover webhook blocks getUpdates — clear it (no-op when none is set).
  await tgCall("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  log(`bridge up: @${me.result.username} ↔ ${ASSISTANT_BASE} salon=${SALON_SLUG || "(default)"} (long poll ${POLL_TIMEOUT_SEC}s)`);

  try {
    const info = await refreshSalonFromServer();
    if (info && info.error === "unknown_salon") {
      log(`FATAL: TELEGRAM_SALON_SLUG="${SALON_SLUG}" is not a salon on this server.`);
      process.exit(1);
    }
    log(`assistant reachable: persona=${info.persona} model=${info.model} salon=${info.salon} (${info.salonSlug || "default"})`);
  } catch (error) {
    log(`WARNING: assistant not reachable at ${ASSISTANT_BASE} yet — start the platform server (npm run platform:serve)`);
  }

  let offset = 0;
  let failures = 0;
  while (running) {
    try {
      const res = await tgCall(
        "getUpdates",
        { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ["message"] },
        (POLL_TIMEOUT_SEC + 15) * 1000
      );
      failures = 0;
      for (const update of res.result || []) {
        if (update.update_id >= offset) offset = update.update_id + 1;
        if (update.message) {
          try {
            await handleMessage(update.message);
          } catch (error) {
            log("handleMessage error:", error);
          }
        }
      }
    } catch (error) {
      if (!running) break;
      failures += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      if (String(error && error.message).includes("409")) {
        log(
          "409 conflict from Telegram: another getUpdates poller or a webhook is active for this bot token. " +
            "Only ONE bridge instance may run per token. Retrying in " + delay + "ms…"
        );
      } else {
        log(`getUpdates failed (attempt ${failures}), retry in ${delay}ms →`, error);
      }
      await sleep(delay);
    }
  }
  log("bridge stopped");
}

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  running = false;
  // The long poll may be holding for up to POLL_TIMEOUT_SEC — exit promptly.
  setTimeout(() => process.exit(0), 250).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
