#!/usr/bin/env node
// Automatic extras that run with nobody watching: the client's reminder the
// evening before a Telegram booking, and the owner's trial-ending notices.
// Run: node apps/platform/tests/tenancy-reminders.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-reminders-"));
process.env.PLATFORM_DB_PATH = path.join(dir, "platform.db");
process.env.SESSION_SECRET = "test-secret";
const { createPlatformStore } = require("../backend/store");
const { createAuth } = require("../backend/auth");
const { createTenancy } = require("../backend/tenancy");

// 2026-09-18 is a Friday. Toronto is UTC-4 in September.
let now = new Date("2026-09-18T14:00:00Z"); // 10:00 in Toronto
const clock = () => now;
const sent = [];
const fakeFetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = init && init.body ? JSON.parse(init.body) : {};
  if (method === "sendMessage") sent.push(body);
  const result = method === "getMe" ? { id: 7000000, username: "reminder_test_bot" } : true;
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};

async function main() {
  const store = createPlatformStore();
  const auth = createAuth({ store, clock, log: () => {} });
  const platform = [];
  const tenancy = createTenancy({ store, auth, llm: {}, clock, fetchImpl: fakeFetch, secret: "s", platformNotify: (note) => platform.push(note) });
  tenancy.attachAssistant({ invalidate() {}, chat: async () => ({ reply: "ok" }) });

  const request = { headers: {}, socket: { remoteAddress: "10.1.1.1" } };
  const signup = tenancy.signup({ email: "r@test.io", password: "long-password-1", salonName: "Reminder Nails", timezone: "America/Toronto" }, request);
  assert.ok(signup.ok, JSON.stringify(signup));
  const slug = signup.slug;
  const saved = tenancy.saveSetup(slug, {
    salon: { name: "Reminder Nails", timezone: "America/Toronto", address: "5 Elgin St" },
    hours: { mon: "10:00-19:00", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00", sun: "closed" },
    services: [{ name: "Gel manicure", durationMinutes: 60, price: "$50" }],
    staff: [{ name: "Olena", workDays: ["mon", "tue", "wed", "thu", "fri", "sat"] }]
  });
  assert.ok(saved.ok, JSON.stringify(saved.errors));
  assert.ok(tenancy.launch(slug).ok);
  assert.ok((await tenancy.connectTelegram(slug, "7000000:AAreminderTokenForTests_0123456789abcdef")).ok);
  store.db.prepare(`UPDATE tenant_telegram SET owner_chat_id = '900' WHERE salon_slug = ?`).run(slug);

  // A client books Saturday 2:00 PM from Telegram chat 555 on Friday morning.
  store.syncDayAnchor(slug, { today: "2026-09-18" });
  store.forSalon(slug).createAppointment({ client: "Anna", service: "Gel manicure", stylist: "Olena", date: "2:00 PM - 3:00 PM", dayOffset: 1 });
  const appointment = store.db.prepare(`SELECT id FROM appointments WHERE salon_id = ? AND client_name = 'Anna'`).get(slug);
  tenancy.hooks.onEvent(slug, "booking", { appointmentId: appointment.id, sessionId: "tg:7000000:555", language: "en", client: "Anna", service: "Gel manicure" });
  sent.length = 0;

  assert.strictEqual(await tenancy.sendDueReminders(), 0, "10:00 the day before: too early");
  now = new Date("2026-09-18T22:00:00Z"); // 18:00 Toronto
  assert.strictEqual(await tenancy.sendDueReminders(), 1, "18:00 the day before: send");
  const toClient = sent.filter((message) => String(message.chat_id) === "555");
  assert.strictEqual(toClient.length, 1);
  assert.match(toClient[0].text, /tomorrow at 2:00 PM — Gel manicure with Olena at Reminder Nails/);
  assert.strictEqual(await tenancy.sendDueReminders(), 0, "never twice");

  // A web booking gets no Telegram reminder; a cancelled one is dropped.
  tenancy.hooks.onEvent(slug, "booking", { appointmentId: "web-only", sessionId: "web-abc" });
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) AS c FROM tenant_reminders WHERE appointment_id = 'web-only'`).get().c, 0);
  tenancy.hooks.onEvent(slug, "cancellation", { appointmentId: appointment.id });
  assert.strictEqual(store.db.prepare(`SELECT COUNT(*) AS c FROM tenant_reminders WHERE salon_slug = ?`).get(slug).c, 0);

  // Trial notices: three days before the end, then at the end. Once each.
  sent.length = 0;
  now = new Date("2026-09-29T15:00:00Z");
  assert.strictEqual(tenancy.sendTrialNotices(), 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const toOwner = () => sent.filter((message) => String(message.chat_id) === "900" && /trial/.test(message.text));
  assert.match(toOwner()[0].text, /trial ends in 3 day/);
  assert.strictEqual(tenancy.sendTrialNotices(), 0, "never twice");
  now = new Date("2026-10-03T15:00:00Z");
  assert.strictEqual(tenancy.sendTrialNotices(), 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(toOwner()[1].text, /trial has ended/);
  assert.ok(platform.some((note) => /trial ended/.test(note.subject)), "we hear about it too");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("tenancy-reminders: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
