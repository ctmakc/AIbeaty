#!/usr/bin/env node
// Mock-LLM tests for the Maya assistant: tool loop, hard gates, escalation,
// takeover, rate limit. No network. Run: npm run assistant:test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolated DB per run — must be set BEFORE requiring the store.
const TEST_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-test-")), "platform.db");
process.env.PLATFORM_DB_PATH = TEST_DB;

const { createPlatformStore } = require("../backend/store");
const { createAssistant } = require("../backend/assistant");

const store = createPlatformStore();

function scriptedLlm(script) {
  let step = 0;
  return {
    model: "mock",
    baseUrl: "mock://",
    async complete() {
      if (step >= script.length) throw new Error(`mock LLM script exhausted at step ${step}`);
      const item = script[step];
      step += 1;
      return typeof item === "function" ? item() : item;
    }
  };
}

function toolCall(name, args) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: `call-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
  };
}

function text(content) {
  return { role: "assistant", content };
}

function mayaAppointments() {
  return store.db.prepare(`SELECT * FROM appointments WHERE notes LIKE '%Maya%'`).all();
}

function eventsOfType(type) {
  return store.db.prepare(`SELECT * FROM assistant_events WHERE type = ?`).all(type);
}

const BOOK_ARGS = {
  service: "женская стрижка",
  day: "вторник",
  time: "14:00",
  stylist: "Елена",
  client_name: "Тест Клиент"
};

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  [FAIL] ${name}: ${error.message}`);
  }
}

(async () => {
  console.log(`assistant.test.js — db: ${TEST_DB}`);

  await test("tool loop happy path: availability tool result reaches the reply", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("check_availability", { service: "женская стрижка", day: "вторник" }),
        text("Во вторник есть свободные окна, например в 9:00. Какое время удобно?")
      ])
    });
    const result = await assistant.chat({ sessionId: "s-happy", message: "Привет! Есть время на женскую стрижку во вторник?" });
    assert.ok(result.reply.includes("вторник"), `reply: ${result.reply}`);
    assert.strictEqual(result.state.assistantState, "active");
    const calls = eventsOfType("tool_call").filter((event) => event.session_id === "s-happy");
    assert.strictEqual(calls.length, 1, "exactly one tool call recorded");
  });

  await test("booking gate: 'вы записаны' without a DB write is blocked and rewritten", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Отлично, вы записаны на завтра на 15:00!")])
    });
    const before = mayaAppointments().length;
    const result = await assistant.chat({ sessionId: "s-gate", message: "Запишите меня на стрижку на завтра на 15:00" });
    assert.strictEqual(mayaAppointments().length, before, "no appointment was written");
    assert.ok(!/вы записаны/i.test(result.reply), `claim must be rewritten, got: ${result.reply}`);
    assert.ok(/не подтверждена|isn't confirmed/i.test(result.reply), `honest fallback expected, got: ${result.reply}`);
    assert.ok(result.state.gates.includes("booking_claim_blocked"));
    assert.ok(eventsOfType("owner_message").some((event) => event.session_id === "s-gate"), "owner task created");
  });

  await test("price quote-guard: price not present in any tool result is blocked", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Стрижка стоит $999, приходите!")])
    });
    const result = await assistant.chat({ sessionId: "s-price", message: "Сколько стоит стрижка?" });
    assert.ok(!result.reply.includes("999"), `invented price must not survive: ${result.reply}`);
    assert.ok(result.state.gates.some((gate) => gate.startsWith("price_guard")));
  });

  await test("price quote-guard: price grounded in a tool result passes", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("get_services_and_prices", { query: "женская стрижка" }),
        text("Женская стрижка стоит $85. Подобрать время?")
      ])
    });
    const result = await assistant.chat({ sessionId: "s-price-ok", message: "Сколько стоит женская стрижка?" });
    assert.ok(result.reply.includes("$85"), `grounded price must survive: ${result.reply}`);
    assert.ok(!result.state.gates.some((gate) => gate.startsWith("price_guard")));
  });

  await test("read-back: first book_appointment returns needs_confirmation, nothing written", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("book_appointment", BOOK_ARGS),
        text("Проверяю: женская стрижка, Elena Rostova, вторник 14:00, на имя Тест Клиент. Всё верно?")
      ])
    });
    const before = mayaAppointments().length;
    const result = await assistant.chat({ sessionId: "s-book", message: "Запишите меня на женскую стрижку во вторник в 14:00 к Елене, я Тест Клиент" });
    assert.strictEqual(mayaAppointments().length, before, "commit must not happen before explicit yes");
    assert.ok(result.state.pendingAction, "pending action stored server-side");
    assert.strictEqual(result.state.pendingAction.kind, "book");
  });

  await test("read-back: explicit yes + same args commits a real appointment row", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("book_appointment", BOOK_ARGS),
        text("Вы записаны! Женская стрижка у Elena Rostova во вторник в 14:00.")
      ])
    });
    const result = await assistant.chat({ sessionId: "s-book", message: "Да, всё верно!" });
    const rows = mayaAppointments();
    assert.strictEqual(rows.length, 1, "exactly one Maya appointment exists");
    assert.strictEqual(rows[0].service_name, "Women's Precision Cut");
    assert.strictEqual(rows[0].start_minutes, 14 * 60);
    assert.strictEqual(rows[0].appointment_status, "scheduled");
    assert.ok(/вы записаны/i.test(result.reply), "booking claim allowed after commit");
    assert.ok(!result.state.gates.includes("booking_claim_blocked"));
    assert.ok(eventsOfType("booking").some((event) => event.session_id === "s-book"));
  });

  await test("escalation: explicit human request bypasses LLM, thread goes silent", async () => {
    const assistant = createAssistant({
      store,
      llm: { model: "mock", baseUrl: "mock://", async complete() { throw new Error("LLM must not be called on a hard trigger"); } }
    });
    const result = await assistant.chat({ sessionId: "s-esc", message: "Позовите человека, пожалуйста!" });
    assert.ok(result.reply, "canned handoff reply expected");
    assert.strictEqual(result.state.assistantState, "escalated");
    const followUp = await assistant.chat({ sessionId: "s-esc", message: "Ау, вы тут?" });
    assert.strictEqual(followUp.reply, null, "bot silent after escalation");
    assert.strictEqual(followUp.state.silenced, true);
    const stored = store.db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_messages cm
      JOIN conversations c ON c.id = cm.conversation_id
      WHERE c.assistant_session_id = 's-esc' AND cm.type = 'incoming'
    `).get().count;
    assert.strictEqual(stored, 2, "silenced incoming message still lands in the thread");
  });

  await test("escalation: medical topic triggers immediate handoff", async () => {
    const assistant = createAssistant({
      store,
      llm: { model: "mock", baseUrl: "mock://", async complete() { throw new Error("LLM must not be called"); } }
    });
    const result = await assistant.chat({ sessionId: "s-med", message: "После окрашивания жжение кожи головы, что делать?" });
    assert.strictEqual(result.state.assistantState, "escalated");
    assert.ok(eventsOfType("escalation").some((event) => event.session_id === "s-med" && JSON.parse(event.payload_json).reason === "medical"));
  });

  await test("takeover: staff reply silences the bot; toggle off re-enables", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Здравствуйте! Чем могу помочь?"), text("Снова я, Майя! Чем помочь?")])
    });
    const first = await assistant.chat({ sessionId: "s-take", message: "Привет" });
    assert.ok(first.reply);
    const conversationId = first.state.conversationId;
    assistant.noteStaffMessage(conversationId); // owner replied by hand in the inbox
    const silenced = await assistant.chat({ sessionId: "s-take", message: "А когда вы открыты?" });
    assert.strictEqual(silenced.reply, null);
    assert.strictEqual(silenced.state.reason, "takeover");
    assistant.setTakeover(conversationId, false);
    const back = await assistant.chat({ sessionId: "s-take", message: "Ну так когда?" });
    assert.ok(back.reply, "bot speaks again after takeover off");
  });

  await test("rate limit: 21st message in the window is rejected", async () => {
    const script = [];
    for (let i = 0; i < 20; i++) script.push(text(`Ответ ${i + 1}`));
    const assistant = createAssistant({ store, llm: scriptedLlm(script) });
    let lastOk = null;
    for (let i = 0; i < 20; i++) {
      lastOk = await assistant.chat({ sessionId: "s-rate", message: `Сообщение ${i + 1}` });
      assert.ok(!lastOk.error, `message ${i + 1} should pass`);
    }
    const blocked = await assistant.chat({ sessionId: "s-rate", message: "Сообщение 21" });
    assert.strictEqual(blocked.error, "rate_limited");
  });

  await test("digest: structured day summary counts what happened", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const digest = assistant.getDigest();
    assert.ok(digest.totals.conversations >= 5, `conversations counted: ${digest.totals.conversations}`);
    assert.strictEqual(digest.totals.bookings, 1);
    assert.ok(digest.totals.escalations >= 2);
    assert.ok(digest.totals.ownerMessages >= 1);
    assert.ok(Array.isArray(digest.escalations) && digest.escalations[0].reason, "escalations listed first-class");
    assert.strictEqual(digest.bookings[0].service, "Women's Precision Cut");
  });

  await test("language detection mirrors RU/UK/EN", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([text("Hi! How can I help?")]) });
    const result = await assistant.chat({ sessionId: "s-lang", message: "Hi! Do you have openings tomorrow?" });
    assert.strictEqual(result.state.language, "en");
    assert.strictEqual(assistant._internals.detectLanguage("Скільки коштує стрижка?"), "uk");
    assert.strictEqual(assistant._internals.detectLanguage("Сколько стоит стрижка?"), "ru");
  });

  await test("hours gate: Saturday before 10:00 is refused in code, no row written", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const satOffset = (6 - new Date().getDay() + 7) % 7;
    const session = assistant._internals.ensureSession({ sessionId: "s-sat", channel: "Webchat" });
    const turn = { userMessage: "можно в субботу в 9:00 утра?", actionCommitted: false };
    // window itself
    assert.deepStrictEqual(assistant._internals.hoursForOffset(satOffset), [600, 1020], "Saturday window is 10:00-17:00");
    // direct 9:00 booking attempt → hard refusal
    const before = mayaAppointments().length;
    const refused = assistant._internals.executeTool(session, turn, "book_appointment", {
      service: "женская стрижка", day: "суббота", time: "9:00", client_name: "Тест Суббота"
    });
    assert.strictEqual(refused.error, "outside_hours", `expected outside_hours, got: ${JSON.stringify(refused).slice(0, 200)}`);
    assert.strictEqual(mayaAppointments().length, before, "no appointment row from the refused attempt");
    // availability never offers a slot outside the Saturday window
    const avail = assistant._internals.executeTool(session, turn, "check_availability", {
      service: "женская стрижка", day: "суббота", time: "9:00"
    });
    assert.strictEqual(avail.opening_hours, "10:00-17:00");
    assert.ok(avail.requested_time && avail.requested_time.available === false, "9:00 Saturday must be unavailable");
    assert.ok(/outside working hours 10:00-17:00/.test(avail.requested_time.reason), avail.requested_time.reason);
    const duration = store.db.prepare(`SELECT duration_minutes FROM services WHERE name = 'Women''s Precision Cut'`).get().duration_minutes;
    const slots = assistant._internals.freeSlots(satOffset, duration, null);
    assert.ok(slots.length > 0, "Saturday still has real slots");
    assert.ok(slots.every((slot) => slot.startMinutes >= 600 && slot.startMinutes + duration <= 1020),
      `every offered Saturday slot inside 10:00-17:00, got: ${slots.map((s) => s.time).join("; ")}`);
  });

  await test("hours gate: Saturday inside hours still stages and commits", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const satOffset = (6 - new Date().getDay() + 7) % 7;
    const session = assistant._internals.ensureSession({ sessionId: "s-sat-ok", channel: "Webchat" });
    const duration = store.db.prepare(`SELECT duration_minutes FROM services WHERE name = 'Women''s Precision Cut'`).get().duration_minutes;
    const slot = assistant._internals.freeSlots(satOffset, duration, null)[0];
    const timeArg = `${Math.floor(slot.startMinutes / 60)}:${String(slot.startMinutes % 60).padStart(2, "0")}`;
    const args = { service: "женская стрижка", day: "суббота", time: timeArg, stylist: slot.stylist, client_name: "Тест Суббота ОК" };
    const stage = assistant._internals.executeTool(session, { userMessage: "давайте в субботу", actionCommitted: false }, "book_appointment", args);
    assert.strictEqual(stage.status, "needs_confirmation", JSON.stringify(stage).slice(0, 200));
    const commitTurn = { userMessage: "Да, всё верно!", actionCommitted: false };
    const commit = assistant._internals.executeTool(session, commitTurn, "book_appointment", args);
    assert.strictEqual(commit.status, "booked", JSON.stringify(commit).slice(0, 200));
    const row = store.db.prepare(`SELECT * FROM appointments WHERE client_name = 'Тест Суббота ОК'`).get();
    assert.ok(row, "committed row exists");
    assert.strictEqual(row.day_offset, satOffset);
    assert.ok(row.start_minutes >= 600 && row.end_minutes <= 1020, `committed slot inside Saturday hours: ${row.start_minutes}`);
    const badRows = store.db.prepare(`
      SELECT COUNT(*) AS count FROM appointments WHERE day_offset = ? AND start_minutes < 600 AND notes LIKE '%Maya%'
    `).get(satOffset).count;
    assert.strictEqual(badRows, 0, "Maya never wrote a row before Saturday opening");
  });

  await test("hours gate: Sunday closed, Tuesday 9:00 unchanged", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const session = assistant._internals.ensureSession({ sessionId: "s-hours", channel: "Webchat" });
    const turn = { userMessage: "а в воскресенье?", actionCommitted: false };
    const sunday = assistant._internals.executeTool(session, turn, "check_availability", { service: "женская стрижка", day: "воскресенье" });
    assert.strictEqual(sunday.closed, true, "Sunday reported closed");
    const tuesday = assistant._internals.executeTool(session, turn, "book_appointment", {
      service: "мужская стрижка", day: "вторник", time: "9:00", client_name: "Тест Вторник"
    });
    assert.ok(tuesday.status === "needs_confirmation" || tuesday.reason === "slot_taken",
      `Tuesday 9:00 must stay inside hours, got: ${JSON.stringify(tuesday).slice(0, 200)}`);
  });

  await test("stylist gate: praise for a nonexistent stylist is rewritten to an honest correction", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Конечно! Наталья — отличный мастер 🙂 На какой день вам удобно?")])
    });
    const result = await assistant.chat({ sessionId: "s-styl", message: "хочу к Наталье, она меня всегда стрижёт" });
    assert.ok(!/наталь/i.test(result.reply), `fabricated name must not survive: ${result.reply}`);
    assert.ok(!/отличный мастер/i.test(result.reply), `praise must not survive: ${result.reply}`);
    assert.ok(/Sarah Jenkins|Michael Chang|Elena Rostova/.test(result.reply), `real staff offered: ${result.reply}`);
    assert.ok(result.state.gates.some((gate) => gate.startsWith("stylist_gate")), `gate recorded: ${result.state.gates}`);
  });

  await test("stylist gate: system injection tells the model the name does not exist", async () => {
    let seenMessages = null;
    const assistant = createAssistant({
      store,
      llm: { model: "mock", baseUrl: "mock://", async complete({ messages }) { seenMessages = messages; return text("Секунду, посмотрю расписание!"); } }
    });
    await assistant.chat({ sessionId: "s-styl-inj", message: "запишите меня к мастеру Наталье на четверг" });
    assert.ok(seenMessages.some((m) => m.role === "system" && /НЕ СУЩЕСТВУЕТ/.test(m.content) && /Наталье/.test(m.content)),
      "ground-truth system note injected on first mention");
  });

  await test("stylist gate: real stylist mention passes untouched", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Сара свободна во вторник, предложу пару окон. Какое время удобно?")])
    });
    const result = await assistant.chat({ sessionId: "s-styl-ok", message: "хочу к Саре на стрижку" });
    assert.ok(/Сара/i.test(result.reply), `real stylist reply survives: ${result.reply}`);
    assert.ok(!result.state.gates.some((gate) => gate.startsWith("stylist_gate")), `no gate: ${result.state.gates}`);
  });

  await test("stylist gate: model-invented 'мастер X' is caught even without a client mention", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Вас примет мастер Виктория, она лучшая по окрашиванию!")])
    });
    const result = await assistant.chat({ sessionId: "s-styl-inv", message: "запишите на окрашивание на пятницу" });
    assert.ok(!/виктори/i.test(result.reply), `invented staff must not survive: ${result.reply}`);
    assert.ok(result.state.gates.some((gate) => gate.startsWith("stylist_gate:invented")), `invented gate recorded: ${result.state.gates}`);
  });

  await test("stylist detection: unknown flagged, known/pronouns/stopwords ignored", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const detect = assistant._internals.detectUnknownStylists;
    assert.strictEqual(detect("хочу к Наталье, она меня всегда стрижёт").length, 1);
    assert.strictEqual(detect("хочу к Наталье, она меня всегда стрижёт")[0].stem, "натал");
    assert.strictEqual(detect("book me with Natalie please").length, 1);
    assert.strictEqual(detect("хочу к Саре на стрижку").length, 0, "real stylist not flagged");
    assert.strictEqual(detect("можно записаться к Вам завтра?").length, 0, "pronoun not flagged");
    assert.strictEqual(detect("запишите меня на стрижку в субботу").length, 0, "no names — nothing flagged");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAILED: ${failure.name}\n${failure.error.stack}`));
    process.exit(1);
  }
})();
