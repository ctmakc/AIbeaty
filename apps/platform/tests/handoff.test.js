#!/usr/bin/env node
// A conversation that a person handles, and the owner's own test chat:
//   1. while a thread is handed off or taken over, every client message gets a
//      short holding line (first time, then at most every 15 minutes) and the
//      owner hears about it (one alert per 5 minutes, with the count, never
//      silently dropped; medspa alerts carry no client text);
//   2. the owner hands the thread back ("Let Maya continue"), and it goes back
//      by itself after 12 hours without a staff answer;
//   3. the owner's own test chat never locks after a handoff;
//   4. test bookings hold no real slot, stay out of revenue, digest and
//      reminders, are marked in alerts, and are deleted at Go live and on reset;
//   5. Maya's money slips: times not from the availability tool, "Friday" on a
//      Friday evening, a wrong year, "yes, but <question>".
// No network: stub LLM and stub Telegram. Run: node apps/platform/tests/handoff.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-handoff-"));
process.env.PLATFORM_DB_PATH = path.join(dir, "platform.db");
process.env.SESSION_SECRET = "test-secret";
process.env.OWNER_WAITING_ALERT_MS = String(5 * 60 * 1000);
delete process.env.ALERT_EMAIL;
const { createPlatformStore } = require("../backend/store");
const { createAuth } = require("../backend/auth");
const { createTenancy } = require("../backend/tenancy");
const { createAssistant } = require("../backend/assistant");
const dates = require("../backend/maya-dates");

// The clock runs on real time plus a shift the test moves forward.
let shift = 0;
let fixedNow = null;
const clock = () => new Date((fixedNow || Date.now()) + shift);

const sent = [];
let messageId = 100;
const fakeFetch = async (url, init) => {
  const method = url.split("/").pop();
  const body = init && init.body ? JSON.parse(init.body) : {};
  let result = true;
  if (method === "sendMessage") {
    sent.push(body);
    messageId += 1;
    result = { message_id: messageId };
  }
  if (method === "getMe") result = { id: 7300000, username: "handoff_test_bot" };
  return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

// Scripted LLM: each call takes the next step; every call's messages are kept.
const script = [];
const llmSeen = [];
const llm = {
  model: "mock",
  baseUrl: "mock://",
  async complete({ messages }) {
    llmSeen.push(messages);
    if (!script.length) throw new Error("mock LLM script exhausted");
    const step = script.shift();
    return typeof step === "function" ? step(messages) : step;
  }
};
const text = (content) => ({ role: "assistant", content });
const toolCall = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});
const lastToolResult = (messages) => JSON.parse([...messages].reverse().find((message) => message.role === "tool").content);

// Toronto wall-clock time today (EDT or EST, whichever is in force).
function torontoAt(hours, minutes = 0) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  for (const offset of ["-04:00", "-05:00"]) {
    const candidate = new Date(`${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00${offset}`);
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(candidate));
    if (hour === hours) return candidate.getTime();
  }
  throw new Error("no Toronto offset fits");
}

const todayToronto = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log(`  [PASS] ${name}`);
}

async function main() {
  const store = createPlatformStore();
  const auth = createAuth({ store, clock, log: () => {} });
  const platform = [];
  const tenancy = createTenancy({ store, auth, llm, clock, fetchImpl: fakeFetch, secret: "s", alertDelayMs: 0, platformNotify: (note) => platform.push(note) });
  const assistant = createAssistant(Object.assign({ store, llm, clock }, tenancy.hooks));
  tenancy.attachAssistant(assistant);

  const request = { headers: {}, socket: { remoteAddress: "10.1.1.9" } };
  const signup = tenancy.signup({ email: "h@test.io", password: "long-password-1", salonName: "Handoff Nails", timezone: "America/Toronto" }, request);
  assert.ok(signup.ok, JSON.stringify(signup));
  const slug = signup.slug;
  const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const saved = tenancy.saveSetup(slug, {
    salon: { name: "Handoff Nails", timezone: "America/Toronto", address: "5 Elgin St" },
    hours: Object.fromEntries(allDays.map((day) => [day, "10:00-16:00"])),
    services: [{ name: "Gel manicure", durationMinutes: 60, price: "$50" }],
    staff: [{ name: "Olena", workDays: allDays }]
  });
  assert.ok(saved.ok, JSON.stringify(saved.errors));
  assert.ok((await tenancy.connectTelegram(slug, "7300000:AAhandoffTokenForTests_0123456789abcdefg")).ok);
  store.db.prepare(`UPDATE tenant_telegram SET owner_chat_id = '900' WHERE salon_slug = ?`).run(slug);
  const tgRow = store.db.prepare(`SELECT * FROM tenant_telegram WHERE salon_slug = ?`).get(slug);
  const toOwner = () => sent.filter((message) => String(message.chat_id) === "900");
  const toChat = (chatId) => sent.filter((message) => String(message.chat_id) === String(chatId));
  let updateId = 1;
  async function clientSays(chatId, words, from = { first_name: "Anna", language_code: "en" }) {
    const outcome = tenancy.handleTelegramUpdate(tgRow.bot_id, tgRow.webhook_secret, {
      update_id: updateId++,
      message: { message_id: updateId, chat: { id: Number(chatId), type: "private" }, from, text: words }
    });
    await outcome.work;
    await tick();
  }
  const convFor = (sessionId) => store.db.prepare(`SELECT * FROM conversations WHERE salon_id = ? AND assistant_session_id = ?`).get(slug, sessionId);
  const salon = () => assistant.forSalon(slug);

  await step("date helpers: stray years corrected, Friday-after-closing rolls a week", async () => {
    assert.strictEqual(dates.fixReplyYears("Sep 19, 2024 and 2024-09-22, le 25 septembre 2023, 3 января 2025, since 2019", "2026-09-19"),
      "Sep 19, 2026 and 2026-09-22, le 25 septembre 2026, 3 января 2027, since 2019");
    assert.strictEqual(dates.fixReplyYears("Jan 5, 2027", "2026-09-19"), "Jan 5, 2027");
    // 2026-09-18 is a Friday.
    assert.strictEqual(dates.findDateExpressions("Friday 2pm?", "2026-09-18", { todayOver: true })[0].offset, 7);
    assert.strictEqual(dates.findDateExpressions("this Friday", "2026-09-18", { todayOver: true })[0].offset, 0);
    assert.strictEqual(dates.findDateExpressions("vendredi", "2026-09-18", {})[0].offset, 0);
    assert.strictEqual(dates.findDateExpressions("в пятницу", "2026-09-18", { todayOver: true })[0].offset, 7);
    // A year is not a day of the month: "mardi 22 septembre 2026" used to yield
    // "septembre 20" first, so the reply was read as being about Sep 20.
    const frDate = dates.findDateExpressions("Voici les créneaux le mardi 22 septembre 2026 : 12 h ou 15 h.", "2026-09-20", {});
    assert.ok(frDate.length, "the French date is found");
    frDate.forEach((hit) => assert.strictEqual(hit.offset, 2, `"${hit.phrase}" → offset ${hit.offset}`));
    const enDate = dates.findDateExpressions("We are open in September 2026.", "2026-09-20", {});
    assert.deepStrictEqual(enDate, [], "a bare month + year names no day");
    assert.strictEqual(dates.findDateExpressions("See you Sep 24, 2026", "2026-09-20", {})[0].offset, 4);
    const { isAffirmation, affirmationRemainder } = assistant._internals;
    assert.ok(isAffirmation("yes cancel. but what about my deposit??"));
    assert.strictEqual(affirmationRemainder("yes cancel. but what about my deposit??"), "what about my deposit??");
    assert.ok(isAffirmation("да, но где парковка?"));
    assert.ok(isAffirmation("oui, mais est-ce qu'il y a un dépôt?"));
    assert.ok(!isAffirmation("yes but can we do 3 instead?"));
    assert.ok(!isAffirmation("да, но можно в пятницу?"));
  });

  // ---------- 4a. test bookings before Go live are deleted at Go live ----------
  fixedNow = torontoAt(10, 5);
  await step("test booking before Go live is flagged test and deleted by Go live", async () => {
    const tomorrow = dates.addDays(todayToronto(), 1);
    script.push(toolCall("book_appointment", { service: "Gel manicure", day: tomorrow, time: "11:00", client_name: "Owner Test" }), text("ok"));
    await tenancy.chat(slug, { sessionId: "web-owner-a", message: "Book me a gel manicure tomorrow at 11" }, { preview: true });
    const yes = await tenancy.chat(slug, { sessionId: "web-owner-a", message: "yes" }, { preview: true });
    assert.match(yes.reply, /booked/i, yes.reply);
    const row = store.db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND client_name = 'Owner Test'`).get(slug);
    assert.ok(row, "test booking saved");
    assert.strictEqual(row.is_test, 1);
    assert.match(row.tags_json, /Test/);
    assert.ok(tenancy.launch(slug).ok);
    assert.strictEqual(store.db.prepare(`SELECT COUNT(*) AS c FROM appointments WHERE salon_id = ? AND is_test = 1`).get(slug).c, 0, "Go live clears test bookings");
    script.length = 0;
  });

  // ---------- 1. holding reply + owner alerts ----------
  await step("handoff: client hears a holding line in their language; owner alerted with the count, nothing dropped", async () => {
    sent.length = 0;
    await clientSays(555, "Can I talk to a person please?");
    const conv = convFor("tg:7300000:555");
    assert.strictEqual(conv.assistant_state, "escalated");
    assert.match(toChat(555).pop().text, /handing this over to a person/);
    assert.strictEqual(toOwner().length, 1, "the handoff alert");
    assert.match(toOwner()[0].text, /Anna needs a person/);

    // Within the 5-minute window of the handoff alert: holding line now, alert held.
    shift += 60 * 1000;
    await clientSays(555, "Do you have anything Saturday?");
    assert.match(toChat(555).pop().text, /I've passed this to the salon team; they'll reply here as soon as they can/);
    assert.strictEqual(toOwner().length, 1, "throttled, not sent yet");

    // 6 minutes later: no second holding line (15-minute rule), and the owner
    // gets one alert that carries both waiting messages.
    shift += 5 * 60 * 1000;
    const before = toChat(555).length;
    await clientSays(555, "Hello?? Anyone there?");
    assert.strictEqual(toChat(555).length, before, "no second holding line within 15 minutes");
    assert.strictEqual(toOwner().length, 2);
    const alert = toOwner()[1].text;
    assert.match(alert, /Anna wrote again \(2 new messages\)/);
    assert.match(alert, /Do you have anything Saturday\?/);
    assert.match(alert, /Hello\?\? Anyone there\?/);
    assert.match(alert, /Let Maya continue/);
    assert.match(alert, /Reply to this message/);

    // A third message inside the window is held and then flushed, never lost.
    shift += 60 * 1000;
    await clientSays(555, "I'll wait");
    assert.strictEqual(toOwner().length, 2);
    tenancy.flushWaitingAlerts();
    await tick();
    assert.strictEqual(toOwner().length, 3);
    assert.match(toOwner()[2].text, /Anna wrote again/);
    assert.match(toOwner()[2].text, /I'll wait/);

    // 16 minutes after the last holding line: one more.
    shift += 16 * 60 * 1000;
    await clientSays(555, "Still there?");
    assert.match(toChat(555).pop().text, /passed this to the salon team/);
    const view = tenancy.inboxView(slug).conversations.find((entry) => entry.id === conv.id);
    assert.strictEqual(view.state, "needs_human");
    assert.strictEqual(view.waiting, 4, "the inbox shows how many messages wait");
  });

  await step("handoff: French client gets the French holding line; Russian owner gets a Russian alert", async () => {
    store.db.prepare(`UPDATE tenants SET language = 'ru' WHERE salon_slug = ?`).run(slug);
    sent.length = 0;
    await clientSays(556, "Je voudrais parler à une personne, s'il vous plaît.", { first_name: "Chloé", language_code: "fr" });
    shift += 6 * 60 * 1000;
    await clientSays(556, "Bonjour? Vous avez de la place samedi?", { first_name: "Chloé", language_code: "fr" });
    assert.match(toChat(556).pop().text, /Merci, j'ai transmis votre message à l'équipe du salon/);
    const alert = toOwner().pop().text;
    assert.match(alert, /Chloé снова пишет/);
    assert.match(alert, /Вы avez|Vous avez de la place samedi/);
    store.db.prepare(`UPDATE tenants SET language = 'en' WHERE salon_slug = ?`).run(slug);
  });

  await step("handoff: medspa alert for a waiting client has no client text", async () => {
    store.db.prepare(`UPDATE tenants SET business_type = 'medspa' WHERE salon_slug = ?`).run(slug);
    sent.length = 0;
    shift += 6 * 60 * 1000;
    await clientSays(555, "My lips are still swollen after the filler");
    const alert = toOwner().pop().text;
    assert.match(alert, /Anna wrote again/);
    assert.match(alert, /Open the conversation to read the message/);
    assert.doesNotMatch(alert, /swollen|filler/);
    store.db.prepare(`UPDATE tenants SET business_type = '' WHERE salon_slug = ?`).run(slug);
  });

  await step("handoff: a staff answer drops the held-back 'wrote again' alert (the owner has read them)", async () => {
    sent.length = 0;
    shift += 60 * 1000;
    await clientSays(555, "Are you open Sunday?");
    assert.strictEqual(toOwner().length, 0, "inside the 5-minute window: held");
    const conv = convFor("tg:7300000:555");
    const answer = await tenancy.sendStaffReply(slug, conv.id, "Hi Anna, yes, 10 to 4.");
    assert.ok(answer.ok);
    tenancy.flushWaitingAlerts();
    await tick();
    assert.strictEqual(toOwner().length, 0, "nothing stale goes out after the owner answered");
    // A message after the answer is counted again.
    shift += 6 * 60 * 1000;
    await clientSays(555, "Thanks, and Monday?");
    const again = toOwner().pop().text;
    assert.match(again, /Anna wrote again/);
    assert.match(again, /Thanks, and Monday\?/);
    assert.doesNotMatch(again, /Are you open Sunday/);
  });

  // ---------- 2. hand-back ----------
  await step("hand-back: Let Maya continue returns the thread; Maya answers again, no holding line", async () => {
    const conv = convFor("tg:7300000:555");
    const result = assistant.setTakeover(conv.id, false, slug);
    assert.strictEqual(result.assistantState, "active");
    sent.length = 0;
    script.push(text("Hi Anna! What can I do for you?"));
    await clientSays(555, "So what now?");
    assert.strictEqual(toChat(555).pop().text, "Hi Anna! What can I do for you?");
    assert.strictEqual(tenancy.inboxView(slug).conversations.find((entry) => entry.id === conv.id).waiting, 0);
  });

  await step("hand-back: after 12 hours without a staff answer the thread is Maya's again", async () => {
    assistant.setTakeover(convFor("tg:7300000:556").id, false, slug); // Chloé's thread: not part of this check
    sent.length = 0;
    await clientSays(557, "I need a real person", { first_name: "Priya", language_code: "en" });
    const conv = convFor("tg:7300000:557");
    assert.strictEqual(conv.assistant_state, "escalated");
    // The owner answers after 2 hours: the clock restarts from that answer.
    shift += 2 * 60 * 60 * 1000;
    await tenancy.sendStaffReply(slug, conv.id, "Hi Priya, Olena here. What do you need?");
    assert.strictEqual(convFor("tg:7300000:557").assistant_state, "takeover");
    shift += 11 * 60 * 60 * 1000;
    assert.strictEqual(tenancy.returnStaleHandoffs(), 0, "11 hours after the staff answer: still the team's");
    shift += 61 * 60 * 1000;
    assert.strictEqual(tenancy.returnStaleHandoffs(), 1, "12 hours: back to Maya");
    assert.strictEqual(convFor("tg:7300000:557").assistant_state, "active");
    script.push(text("Hi Priya! Maya here again. How can I help?"));
    await clientSays(557, "Hello?", { first_name: "Priya", language_code: "en" });
    assert.match(toChat(557).pop().text, /Maya here again/);

    // The same happens on the client's next message without the ticker.
    await clientSays(558, "real person please", { first_name: "Marc", language_code: "en" });
    shift += 12 * 60 * 60 * 1000 + 1000;
    script.push(text("Hi Marc, I'm back. What can I do?"));
    await clientSays(558, "hi?", { first_name: "Marc", language_code: "en" });
    assert.match(toChat(558).pop().text, /I'm back/);
    assert.strictEqual(convFor("tg:7300000:558").assistant_state, "active");
  });

  // ---------- 3. the owner's test chat never locks ----------
  fixedNow = torontoAt(10, 5);
  shift = 0;
  await step("preview: a handoff in the owner's test chat shows the notice in the chat's language and Maya keeps answering", async () => {
    sent.length = 0;
    const first = await tenancy.chat(slug, { sessionId: "web-owner-b", message: "Can I talk to a person?" }, { preview: true });
    assert.match(first.reply, /handing this over to a person/);
    assert.match(first.reply, /Test chat: a real client's conversation would now wait for your team/);
    assert.strictEqual(convFor("web-owner-b").assistant_state, "active", "no human-only lock");
    await tick();
    assert.match(toOwner().pop().text, /^\[Test chat\] /, "the owner's alert is marked test");
    script.push(text("Sure! What would you like to book?"));
    const next = await tenancy.chat(slug, { sessionId: "web-owner-b", message: "Ok, a manicure then" }, { preview: true });
    assert.strictEqual(next.reply, "Sure! What would you like to book?");

    const fr = await tenancy.chat(slug, { sessionId: "web-owner-c", message: "Je veux parler à une personne" }, { preview: true });
    assert.match(fr.reply, /Clavardage test : avec un vrai client/);
    assert.doesNotMatch(fr.reply, /Test chat|Тестовый/);

    // A preview thread that was locked before this fix unlocks on its next message.
    const locked = convFor("web-owner-c");
    store.db.prepare(`UPDATE conversations SET assistant_state = 'escalated' WHERE salon_id = ? AND id = ?`).run(slug, locked.id);
    script.push(text("Bien sûr, je vous écoute."));
    const unlocked = await tenancy.chat(slug, { sessionId: "web-owner-c", message: "Alors?" }, { preview: true });
    assert.strictEqual(unlocked.reply, "Bien sûr, je vous écoute.");
  });

  // ---------- 4b. test bookings never block, never count ----------
  await step("test bookings: flagged, marked in alerts, hold no real slot, no revenue/digest/reminder, deleted on reset", async () => {
    const today = todayToronto();
    const tomorrow = dates.addDays(today, 1);
    sent.length = 0;
    script.push(toolCall("book_appointment", { service: "Gel manicure", day: tomorrow, time: "11:00", client_name: "Owner Test" }), text("ok"));
    await tenancy.chat(slug, { sessionId: "web-owner-d", message: "Gel manicure tomorrow 11 please, I'm Owner Test" }, { preview: true });
    await tenancy.chat(slug, { sessionId: "web-owner-d", message: "yes" }, { preview: true });
    await tick();
    const testRow = store.db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND client_name = 'Owner Test'`).get(slug);
    assert.strictEqual(testRow.is_test, 1);
    assert.match(toOwner().pop().text, /^\[Test chat\] ✅ New booking/);

    // A real client books the very same slot: free for them.
    script.push(toolCall("book_appointment", { service: "Gel manicure", day: tomorrow, time: "11:00", client_name: "Real Client" }), text("ok"));
    await clientSays(560, "Gel manicure tomorrow at 11, name Real Client", { first_name: "Real", language_code: "en" });
    await clientSays(560, "yes", { first_name: "Real", language_code: "en" });
    const realRow = store.db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND client_name = 'Real Client'`).get(slug);
    assert.ok(realRow, "the real client got the slot the test booking had");
    assert.strictEqual(realRow.is_test, 0);
    assert.strictEqual(realRow.start_minutes, testRow.start_minutes);
    assert.doesNotMatch(toOwner().pop().text, /Test chat/);

    const report = store.forSalon(slug).getPerformanceReport();
    assert.strictEqual(report.metrics.appointments, 1, "revenue and counts ignore the test booking");
    assert.match(report.metrics.revenue, /^\$50(\.00)?$/);
    const digest = assistant.getDigest(null, slug);
    assert.ok(digest.bookings.every((entry) => entry.client !== "Owner Test"), "digest leaves test chats out");
    assert.strictEqual(digest.totals.bookings, 1, "only the real client's booking");
    assert.ok(!digest.conversations.some((entry) => entry.conversationId === convFor("web-owner-d").id), "test chat not in the digest");
    assert.strictEqual(store.db.prepare(`SELECT COUNT(*) AS c FROM tenant_reminders WHERE appointment_id = ?`).get(testRow.id).c, 0);

    const reset = tenancy.resetTestChat(slug);
    assert.deepStrictEqual(reset, { ok: true, removedBookings: 1 });
    assert.ok(store.db.prepare(`SELECT 1 FROM appointments WHERE salon_id = ? AND id = ?`).get(slug, realRow.id), "real booking kept");
    assert.ok(tenancy.isTestSession(slug, "tg:7300000:900"), "the owner's own Telegram chat counts as a test chat");
    assert.ok(!tenancy.isTestSession(slug, "tg:7300000:560"));
  });

  // ---------- 5. Maya's slips ----------
  await step("time guard: a time the availability tool never gave is replaced by real free times", async () => {
    const today = todayToronto();
    const dayAfter = dates.addDays(today, 2);
    script.push(
      toolCall("check_availability", { service: "Gel manicure", day: dayAfter }),
      text("That day I can do 5:00 PM or 6:30 PM. Which one?")
    );
    const bad = await tenancy.chat(slug, { sessionId: "web-client-t1", message: `Gel manicure on ${dayAfter}?` });
    assert.ok(bad.state.gates.some((gate) => /^time_guard:5:00 PM/.test(gate)), JSON.stringify(bad.state.gates));
    assert.doesNotMatch(bad.reply, /5:00 PM|6:30 PM/);
    assert.match(bad.reply, /For Gel manicure on .* I can offer 10:00 AM/);

    script.push(
      toolCall("check_availability", { service: "Gel manicure", day: dayAfter }),
      (messages) => {
        const result = lastToolResult(messages);
        const first = result.slots[0].time.split(" - ")[0];
        return text(`I have ${first} free that day. Does it suit you? We're open until 4:00 PM.`);
      }
    );
    const good = await tenancy.chat(slug, { sessionId: "web-client-t2", message: `Gel manicure on ${dayAfter}?` });
    assert.ok(!good.state.gates.some((gate) => /^time_guard/.test(gate)), JSON.stringify(good.state.gates));
    assert.match(good.reply, /free that day/);
  });

  await step("dates: 'Friday' said on a Friday after closing means next week; 'this Friday' and daytime mean today", async () => {
    const today = todayToronto();
    const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][dates.weekdayOf(today)];
    fixedNow = torontoAt(18, 30); // closed at 16:00
    const internals = salon()._internals;
    assert.strictEqual(internals.resolveDay(weekday).offset, 7, `${weekday} after closing`);
    assert.strictEqual(internals.resolveDay(`this ${weekday}`).offset, 0);
    script.push(text("Let me check."));
    await tenancy.chat(slug, { sessionId: "web-client-d1", message: `Do you have ${weekday} 2pm?` });
    const note = llmSeen[llmSeen.length - 1].map((message) => message.content || "").join("\n");
    assert.match(note, new RegExp(`"${weekday}" = ${dates.addDays(today, 7)}`));
    fixedNow = torontoAt(10, 5);
    assert.strictEqual(internals.resolveDay(weekday).offset, 0, `${weekday} in the morning is today`);
  });

  await step("years: a reply never names a year other than this one or the next", async () => {
    const year = Number(clock().toISOString().slice(0, 4));
    script.push(text(`Your visit is on Sep 30, ${year - 2}. See you then!`));
    const reply = await tenancy.chat(slug, { sessionId: "web-client-y1", message: "When is my visit?" });
    assert.doesNotMatch(reply.reply, new RegExp(String(year - 2)));
    assert.match(reply.reply, new RegExp(`Sep 30, (${year}|${year + 1})`));
    assert.ok(reply.state.gates.includes("year_fixed"));
  });

  await step("'yes, but <question>' commits the booking and answers the question", async () => {
    const today = todayToronto();
    const day = dates.addDays(today, 3);
    script.push(toolCall("book_appointment", { service: "Gel manicure", day, time: "13:00", client_name: "Jess Park" }), text("ok"));
    const readBack = await tenancy.chat(slug, { sessionId: "web-client-y2", message: `Gel manicure ${day} at 1pm, I'm Jess Park` });
    assert.match(readBack.reply, /Shall I book it\?/);
    script.push((messages) => {
      const last = messages[messages.length - 1].content;
      assert.match(last, /"is there parking\?"/, "the model is asked only the side question");
      return text("Yes, there is free parking behind the salon.");
    });
    const both = await tenancy.chat(slug, { sessionId: "web-client-y2", message: "yes, but is there parking?" });
    assert.match(both.reply, /you're booked/);
    assert.match(both.reply, /free parking behind the salon/);
    assert.ok(store.db.prepare(`SELECT 1 FROM appointments WHERE salon_id = ? AND client_name = 'Jess Park'`).get(slug));

    script.push(toolCall("book_appointment", { service: "Gel manicure", day, time: "14:00", client_name: "Kim Lee" }), text("ok"));
    await tenancy.chat(slug, { sessionId: "web-client-y3", message: `Gel manicure ${day} at 2pm, I'm Kim Lee` });
    script.push(text("Sure, which time would you prefer?"));
    const change = await tenancy.chat(slug, { sessionId: "web-client-y3", message: "yes but can we do 3 instead?" });
    assert.doesNotMatch(change.reply, /you're booked/, "a change request is not consent");
    assert.ok(!store.db.prepare(`SELECT 1 FROM appointments WHERE salon_id = ? AND client_name = 'Kim Lee'`).get(slug));
  });

  await step("a 'yes' after Maya offered other times re-reads the staged slot back instead of booking it", async () => {
    const today = todayToronto();
    const day = dates.addDays(today, 5);
    const session = "web-client-s1";

    // Maya stages 2:00 PM and reads it back.
    script.push(toolCall("book_appointment", { service: "Gel manicure", day, time: "14:00", client_name: "Nora Diaz" }), text("ok"));
    const staged = await tenancy.chat(slug, { sessionId: session, message: `Gel manicure ${day} at 2pm, I'm Nora Diaz` });
    assert.match(staged.reply, /2:00 PM/);
    assert.match(staged.reply, /Shall I book it\?/);

    // The client asks what else is free; the model invents times, the time
    // guard replaces them with the real free slots — 2:00 PM is not among them.
    // 12:00 PM in that list must not read as "the client saw 2:00 PM".
    script.push(text("That day I can do 9:00 AM, 12:00 PM, 1:00 PM or 3:00 PM. Which one?"));
    const offer = await tenancy.chat(slug, { sessionId: session, message: "what other times are free that day?" });
    assert.ok(offer.state.gates.some((gate) => /^time_guard/.test(gate)), JSON.stringify(offer.state.gates));
    assert.match(offer.reply, /I can offer 10:00 AM/);
    assert.doesNotMatch(offer.reply, /2:00 PM/, "the fresh offer does not contain the staged time");

    // "yes" now means one of THOSE times, so nothing may be booked silently.
    const consent = await tenancy.chat(slug, { sessionId: session, message: "yes" });
    assert.ok(consent.state.gates.includes("stale_consent"), JSON.stringify(consent.state.gates));
    assert.match(consent.reply, /2:00 PM/);
    assert.match(consent.reply, /Shall I book it\?/);
    assert.ok(
      !store.db.prepare(`SELECT 1 FROM appointments WHERE salon_id = ? AND client_name = 'Nora Diaz'`).get(slug),
      "no appointment before the client saw the time they are agreeing to"
    );

    // A second "yes", now against a read-back that does show 2:00 PM, books it.
    const done = await tenancy.chat(slug, { sessionId: session, message: "yes" });
    assert.match(done.reply, /you're booked/);
    const row = store.db.prepare(`SELECT start_minutes FROM appointments WHERE salon_id = ? AND client_name = 'Nora Diaz'`).get(slug);
    assert.ok(row, "the re-confirmed booking is written");
    assert.strictEqual(row.start_minutes, 14 * 60, "Maya books the time she read back");
  });

  await step("an offer listing 12:00 is not read as the client having seen 2:00 PM", async () => {
    const today = todayToronto();
    const day = dates.addDays(today, 6);
    const session = "web-client-s2";
    script.push(toolCall("book_appointment", { service: "Gel manicure", day, time: "14:00", client_name: "Sam Okafor" }), text("ok"));
    await tenancy.chat(slug, { sessionId: session, message: `Gel manicure ${day} at 2pm, I'm Sam Okafor` });
    script.push(text(`On ${day} I have 9:00 AM, 12:00 PM, 1:00 PM or 3:00 PM free. Which suits you?`));
    const offer = await tenancy.chat(slug, { sessionId: session, message: "what else is free?" });
    assert.doesNotMatch(offer.reply, /2:00 PM/);
    const consent = await tenancy.chat(slug, { sessionId: session, message: "yes, that's right" });
    assert.ok(consent.state.gates.includes("stale_consent"), JSON.stringify(consent.state.gates));
    assert.ok(!store.db.prepare(`SELECT 1 FROM appointments WHERE salon_id = ? AND client_name = 'Sam Okafor'`).get(slug),
      "a 'yes' to a list that never showed 2:00 PM does not book 2:00 PM");
  });

  await step("check_availability with no day answers about the day the client named, not today", async () => {
    const today = todayToronto();
    const named = dates.addDays(today, 5);
    let answeredFor = "";
    script.push(
      toolCall("check_availability", { service: "Gel manicure" }), // the model forgot the day
      (messages) => {
        answeredFor = (lastToolResult(messages) || {}).date || "";
        return text("Let me see.");
      }
    );
    await tenancy.chat(slug, { sessionId: "web-client-h1", message: `Anything for a Gel manicure on ${named}?` });
    assert.strictEqual(answeredFor, named, `availability answered for ${answeredFor}, the client named ${named}`);
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`handoff: ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
