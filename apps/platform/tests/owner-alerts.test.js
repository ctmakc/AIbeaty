#!/usr/bin/env node
// What the owner's Telegram alerts say: client name and phone, old → new time
// for a moved booking, dates in the owner's language, one message per event
// and no second "needs you" about the same client within a minute.
// Run: node apps/platform/tests/owner-alerts.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-owner-alerts-"));
process.env.PLATFORM_DB_PATH = path.join(dir, "platform.db");
process.env.SESSION_SECRET = "test-secret";
const { createPlatformStore } = require("../backend/store");
const { createAuth } = require("../backend/auth");
const { createTenancy } = require("../backend/tenancy");

let now = new Date("2026-09-18T14:00:00Z");
const clock = () => now;
const sent = [];
let messageId = 50;
const fakeFetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = init && init.body ? JSON.parse(init.body) : {};
  let result = true;
  if (method === "sendMessage") {
    sent.push(body);
    messageId += 1;
    result = { message_id: messageId };
  }
  if (method === "getMe") result = { id: 7200000, username: "alerts_test_bot" };
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

async function main() {
  const store = createPlatformStore();
  const auth = createAuth({ store, clock, log: () => {} });
  const tenancy = createTenancy({ store, auth, llm: {}, clock, fetchImpl: fakeFetch, secret: "s", alertDelayMs: 60000 });
  tenancy.attachAssistant({ invalidate() {}, chat: async () => ({ reply: "ok" }), noteStaffMessage() {} });

  const request = { headers: {}, socket: { remoteAddress: "10.1.1.2" } };
  const signup = tenancy.signup({ email: "a@test.io", password: "long-password-1", salonName: "Alert Nails", timezone: "America/Toronto" }, request);
  assert.ok(signup.ok, JSON.stringify(signup));
  const slug = signup.slug;
  assert.ok((await tenancy.connectTelegram(slug, "7200000:AAalertsTokenForTests_0123456789abcdefg")).ok);
  store.db.prepare(`UPDATE tenant_telegram SET owner_chat_id = '900' WHERE salon_slug = ?`).run(slug);
  const conversationId = store.forSalon(slug).createConversation({ name: "Olena K", channel: "telegram", contact: { phone: "+1 613 555 0142" } });
  store.db.prepare(`UPDATE conversations SET assistant_session_id = 'tg:7200000:777' WHERE salon_id = ? AND id = ?`).run(slug, conversationId);
  const toOwner = () => sent.filter((message) => String(message.chat_id) === "900");

  // A moved booking: old and new time, phone, English dates.
  tenancy.hooks.onEvent(slug, "reschedule", {
    conversationId, client: "Olena K", service: "Gel manicure", stylist: "Anna",
    fromDate: "2026-09-19", fromStartMinutes: 14 * 60, date: "2026-09-22", startMinutes: 10 * 60 + 30,
    day: "Tue, Sep 22", time: "10:30 AM - 11:30 AM"
  });
  tenancy.flushOwnerAlerts();
  await tick();
  let text = toOwner()[0].text;
  assert.match(text, /🔁 Booking moved/);
  assert.match(text, /Olena K · \+1 613 555 0142/);
  assert.match(text, /Gel manicure with Anna/);
  assert.match(text, /Sat, Sep 19, 2:00 PM → Tue, Sep 22, 10:30 AM/);
  assert.match(text, /Reply to this message and your answer goes to Olena K/);

  // A booking and Maya's note about the same turn arrive as ONE message.
  sent.length = 0;
  tenancy.hooks.onEvent(slug, "booking", { conversationId, client: "Olena K", service: "Gel manicure", stylist: "Anna", date: "2026-09-23", startMinutes: 11 * 60, phone: "+1 613 555 0142" });
  tenancy.hooks.onEvent(slug, "owner_message", { conversationId, message: "Maya назвала цену 45, которой нет в данных инструментов.", topic: "price_guard" });
  tenancy.flushOwnerAlerts();
  await tick();
  assert.strictEqual(toOwner().length, 1, "one message for one turn");
  text = toOwner()[0].text;
  assert.match(text, /✅ New booking/);
  assert.match(text, /Wed, Sep 23, 11:00 AM/);
  assert.match(text, /price that is not on your list/);
  assert.doesNotMatch(text, /назвала|price_guard/, "Maya's internal note never reaches the owner");

  // A second "needs you" within a minute is not sent again; after a minute it is.
  sent.length = 0;
  tenancy.hooks.onEvent(slug, "escalation", { conversationId, reason: "complaint", summary: "My nails broke after two days" });
  tenancy.flushOwnerAlerts();
  await tick();
  assert.strictEqual(toOwner().length, 0, "quiet within a minute of the last attention alert");
  now = new Date(now.getTime() + 61 * 1000);
  tenancy.hooks.onEvent(slug, "escalation", { conversationId, reason: "complaint", summary: "My nails broke after two days | Резюме Майи: жалоба" });
  tenancy.flushOwnerAlerts();
  await tick();
  text = toOwner()[0].text;
  assert.match(text, /Olena K needs a person/);
  assert.match(text, /unhappy about a visit/);
  assert.match(text, /“My nails broke after two days”/);
  assert.doesNotMatch(text, /Резюме|complaint/);

  // The alert's Telegram message id maps back to the conversation.
  const mapped = store.db.prepare(`SELECT conversation_id FROM tenant_alert_messages WHERE salon_slug = ? AND message_id = ?`).get(slug, String(messageId));
  assert.strictEqual(mapped.conversation_id, conversationId);

  // Russian owner: Russian labels and 24-hour time; cancellation shows the slot.
  store.db.prepare(`UPDATE tenants SET language = 'ru' WHERE salon_slug = ?`).run(slug);
  sent.length = 0;
  tenancy.hooks.onEvent(slug, "cancellation", { conversationId, client: "Olena K", service: "Gel manicure", date: "2026-09-23", startMinutes: 11 * 60 });
  tenancy.flushOwnerAlerts();
  await tick();
  text = toOwner()[0].text;
  assert.match(text, /❌ Запись отменена/);
  assert.match(text, /11:00/);
  assert.match(text, /Ответьте на это сообщение/);

  // Medspa: no client words at all, the medical case says so plainly.
  store.db.prepare(`UPDATE tenants SET language = 'en', business_type = 'medspa' WHERE salon_slug = ?`).run(slug);
  now = new Date(now.getTime() + 120 * 1000);
  sent.length = 0;
  tenancy.hooks.onEvent(slug, "escalation", { conversationId, reason: "medical", summary: "I had a reaction to filler last week" });
  tenancy.flushOwnerAlerts();
  await tick();
  text = toOwner()[0].text;
  assert.match(text, /Medical question\. Open the conversation to read it\./);
  assert.doesNotMatch(text, /filler|reaction/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("owner-alerts: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
