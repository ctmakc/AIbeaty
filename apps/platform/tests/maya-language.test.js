#!/usr/bin/env node
// Maya: client language, "yes" commits, server-side dates and client names.
// Scripted LLM, no network. Covers the funnel-emulation findings of
// 2026-09-18: Russian replies to English/French clients, confirmation loops,
// guessed years, client names read as staff names, transliterated names.
//
// Run: node apps/platform/tests/maya-language.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-maya-lang-"));
process.env.PLATFORM_DB_PATH = path.join(TEST_DIR, "platform.db");
delete process.env.ALERT_EMAIL;

const { createPlatformStore } = require("../backend/store");
const { createAssistant } = require("../backend/assistant");
const language = require("../backend/maya-language");
const dates = require("../backend/maya-dates");
const { buildSystemPrompt } = require("../backend/assistant-prompt");

const store = createPlatformStore();

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

// Scripted LLM that also records what it was sent.
function scriptedLlm(script) {
  const seen = [];
  let step = 0;
  return {
    model: "mock",
    baseUrl: "mock://",
    seen,
    get calls() { return step; },
    async complete(request) {
      seen.push(request);
      if (step >= script.length) throw new Error(`mock LLM script exhausted at step ${step}`);
      const item = script[step];
      step += 1;
      return typeof item === "function" ? item(request) : item;
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
const CYRILLIC = /[а-яёіїєґ]/i;

const ALL_OPEN = {
  понедельник: "09:00-19:00", вторник: "09:00-19:00", среда: "09:00-19:00", четверг: "09:00-19:00",
  пятница: "09:00-19:00", суббота: "09:00-19:00", воскресенье: "09:00-19:00"
};
const ALL_DAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

const BARBER = {
  slug: "barbier-test",
  salon: { name: "Barbier Test", city: "Gatineau", address: "12 rue Principale", phone: "(819) 555-0100", timezone: "America/Toronto" },
  hours: ALL_OPEN,
  services: [
    { name: "Coupe simple", category: "Coupes", durationMinutes: 30, price: "$35", keywords: ["coupe"] },
    { name: "Coupe + barbe", category: "Coupes", durationMinutes: 45, price: "$50", keywords: ["coupe", "barbe"] }
  ],
  staff: [
    { name: "Karim", role: "Barber", services: ["Coupe simple", "Coupe + barbe"], workDays: ALL_DAYS },
    { name: "Iryna", role: "Barber", services: ["Coupe simple", "Coupe + barbe"], workDays: ALL_DAYS }
  ],
  policies: {},
  faq: {}
};

const SOLO = {
  slug: "solo-lash-test",
  salon: { name: "Solo Lash Test", city: "Ottawa", address: "1 Test St", phone: "(613) 555-0199", timezone: "America/Toronto" },
  hours: ALL_OPEN,
  services: [{ name: "Classic full set", category: "Lashes", durationMinutes: 90, price: "$120", keywords: ["lash", "classic"] }],
  staff: [{ name: "Priya", role: "Lash artist", services: ["Classic full set"], workDays: ALL_DAYS }],
  policies: {},
  faq: {}
};

function mayaAppointments(salon) {
  return store.db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND notes LIKE '%Maya%'`).all(salon);
}

// A day at least 2 days out with a free 11:00 slot (never "today", so the
// time-of-day floor never interferes).
function farDay(assistant, salonSlug) {
  const salon = assistant.forSalon(salonSlug);
  return { offset: 3, iso: salon._internals.dayIso(3) };
}

(async () => {
  console.log(`maya-language.test.js — db: ${process.env.PLATFORM_DB_PATH}`);
  const importer = await import("../../../scripts/onboard-salon.mjs");
  for (const intake of [BARBER, SOLO]) {
    store.createSalon({
      slug: intake.slug,
      name: intake.salon.name,
      city: intake.salon.city,
      timezone: intake.salon.timezone,
      address: intake.salon.address,
      phone: intake.salon.phone,
      hours: importer.buildHours(intake),
      faq: { topics: importer.buildFaqTopics(intake) },
      faqSource: "db"
    });
    store.forSalon(intake.slug).replaceCatalog({ categories: importer.buildCategories(intake), staff: importer.buildStaff(intake) });
  }

  // ------------------------------------------------------------ detection
  await test("detection: en / fr / ru / uk, and no opinion on names, times and phones", async () => {
    const d = (value) => language.detectMessageLanguage(value);
    assert.strictEqual(d("Hi! How much is a fade tomorrow?").language, "en");
    assert.strictEqual(d("Bonjour, je voudrais une coupe samedi").language, "fr");
    assert.strictEqual(d("Oui c'est bon").language, "fr");
    assert.strictEqual(d("Сколько стоит маникюр?").language, "ru");
    assert.strictEqual(d("Скільки коштує манікюр?").language, "uk");
    assert.strictEqual(d("Nadia 289-555-0123").language, "");
    assert.strictEqual(d("14:00").language, "");
    assert.strictEqual(d("ok").language, "");
  });

  await test("language resolution: text beats the Telegram hint; a short reply keeps the conversation language; hint used when text says nothing", async () => {
    const state = {};
    assert.strictEqual(language.resolveTurnLanguage({ text: "Bonjour! Dispo demain?", state, hint: "en" }).language, "fr");
    assert.strictEqual(language.resolveTurnLanguage({ text: "14:00", state, hint: "en" }).language, "fr", "short reply keeps French");
    assert.strictEqual(language.resolveTurnLanguage({ text: "10:30", state: {}, hint: "fr-CA" }).language, "fr", "hint on a first, wordless message");
    assert.strictEqual(language.resolveTurnLanguage({ text: "ok", state: {}, hint: "", salonLanguage: "ru" }).language, "ru", "salon language last");
    assert.strictEqual(language.resolveTurnLanguage({ text: "ok", state: {}, hint: "", salonLanguage: "" }).language, "en", "English default");
  });

  // ------------------------------------------------------------ English-only
  await test("English-only conversation: a Russian model reply is regenerated in English; nothing Cyrillic reaches the client", async () => {
    const llm = scriptedLlm([
      text("Здравствуйте! Я Майя, ИИ-ассистентка салона. Стрижка стоит у нас недорого, какой день удобен?"),
      text("Hi! I'm Maya, the salon's AI assistant. Which day works best for you?"),
      text("Great, which time on that day?")
    ]);
    const assistant = createAssistant({ store, llm });
    const first = await assistant.chat({ salon: BARBER.slug, sessionId: "en-only", message: "Hi, I'd like a haircut this week", channel: "Webchat" });
    assert.strictEqual(first.state.language, "en");
    assert.ok(!CYRILLIC.test(first.reply), `no Cyrillic: ${first.reply}`);
    assert.ok(first.state.gates.includes("language_regen"), `regen gate: ${first.state.gates}`);
    assert.ok(/Maya/.test(first.reply) && /AI/.test(first.reply), `English intro: ${first.reply}`);
    const second = await assistant.chat({ salon: BARBER.slug, sessionId: "en-only", message: "Thursday please", channel: "Webchat" });
    assert.ok(!CYRILLIC.test(second.reply), second.reply);
    assert.ok(!/I'm Maya/.test(second.reply), `introduced only once: ${second.reply}`);
    const prompt = llm.seen[0].messages[0].content;
    assert.ok(/Write your whole reply in English only/.test(prompt), "hard language directive in the system prompt");
  });

  await test("English-only: a model that keeps answering in Russian falls back to an English template", async () => {
    const llm = scriptedLlm([
      text("Проверяю: Coupe simple у Karim. Всё верно?"),
      text("Всё верно?")
    ]);
    const assistant = createAssistant({ store, llm });
    const result = await assistant.chat({ salon: BARBER.slug, sessionId: "en-fallback", message: "Hello, what can you do?", channel: "Webchat", greeted: true });
    assert.ok(!CYRILLIC.test(result.reply), `fallback is English: ${result.reply}`);
    assert.ok(result.state.gates.includes("language_fallback"), `fallback gate: ${result.state.gates}`);
  });

  // ------------------------------------------------------------ French-only
  await test("French-only conversation: French intro, no English greeting glued on, templates in French", async () => {
    const llm = scriptedLlm([
      text("Avec plaisir! Quel jour vous conviendrait?")
    ]);
    const assistant = createAssistant({ store, llm });
    const result = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-only", message: "Bonjour, je voudrais une coupe cette semaine", channel: "Webchat" });
    assert.strictEqual(result.state.language, "fr");
    assert.ok(/^Bonjour! Je suis Maya, l'assistante IA du salon\./.test(result.reply), `French intro: ${result.reply}`);
    assert.ok(!/\bHi\b|I'm Maya/.test(result.reply), `no English prefix: ${result.reply}`);
    assert.ok(/Write your whole reply in French/.test(llm.seen[0].messages[0].content));
    assert.ok(/"humain"/.test(llm.seen[0].messages[0].content), "French handoff word in the prompt");
  });

  await test("French: 'parler à un humain' and bare 'humain' hand over in French without the model", async () => {
    const assistant = createAssistant({ store, llm: { model: "mock", async complete() { throw new Error("LLM must not run"); } } });
    const result = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-human", message: "Je voudrais parler à un humain", channel: "Webchat", greeted: true });
    assert.strictEqual(result.state.assistantState, "escalated");
    assert.ok(/équipe/.test(result.reply) && !CYRILLIC.test(result.reply), result.reply);
    assert.ok(/dès que possible/.test(result.reply), `no response-time promise: ${result.reply}`);
    const bare = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-human-2", message: "humain", channel: "telegram", greeted: true, languageHint: "fr" });
    assert.strictEqual(bare.state.assistantState, "escalated", "bare 'humain' is a handoff request");
  });

  // ------------------------------------------------------------ explicit switch
  await test("'Please answer in English' switches a Russian conversation to English and keeps it", async () => {
    const llm = scriptedLlm([
      text("Здравствуйте! Я Майя, ИИ-ассистентка салона. Чем помочь?"),
      text("Спасибо! Какой день удобен?"),
      text("Sure! Which day works for you?"),
      text("Got it, 2 PM. Which service?")
    ]);
    const assistant = createAssistant({ store, llm });
    const ru = await assistant.chat({ salon: BARBER.slug, sessionId: "switch", message: "Здравствуйте, хочу записаться", channel: "telegram", languageHint: "en" });
    assert.strictEqual(ru.state.language, "ru", "Russian text beats an en app language");
    const en = await assistant.chat({ salon: BARBER.slug, sessionId: "switch", message: "Please answer in English", channel: "telegram" });
    assert.strictEqual(en.state.language, "en");
    assert.ok(!CYRILLIC.test(en.reply), `English after the request: ${en.reply}`);
    const later = await assistant.chat({ salon: BARBER.slug, sessionId: "switch", message: "14:00 да", channel: "telegram" });
    assert.strictEqual(later.state.language, "en", "the request locks the conversation");
    assert.ok(!CYRILLIC.test(later.reply), later.reply);
  });

  // ------------------------------------------------------------ yes commits
  await test("'Oui c'est bon' after a read-back books in code, with no model call, in French", async () => {
    const day = farDay(createAssistant({ store, llm: scriptedLlm([]) }), BARBER.slug);
    const args = { service: "Coupe simple", day: day.iso, time: "11:00", stylist: "Karim", client_name: "Alexandre" };
    const llm = scriptedLlm([
      toolCall("book_appointment", args),
      text(`Je récapitule : Coupe simple avec Karim, le ${day.iso} à 11 h, au nom de Alexandre. Je confirme?`)
    ]);
    const assistant = createAssistant({ store, llm });
    const stage = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-yes", message: `Bonjour, une coupe simple avec Karim le ${day.iso} à 11h, je m'appelle Alexandre`, channel: "telegram", greeted: true });
    assert.strictEqual(stage.state.pendingAction && stage.state.pendingAction.kind, "book", "read-back staged");
    const before = llm.calls;
    const done = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-yes", message: "Oui c'est bon", channel: "telegram" });
    assert.strictEqual(llm.calls, before, "no LLM call on the yes");
    assert.strictEqual(done.state.pendingAction, null);
    assert.ok(/réservé/.test(done.reply) && /Karim/.test(done.reply), `French confirmation: ${done.reply}`);
    const row = mayaAppointments(BARBER.slug).find((entry) => entry.client_name === "Alexandre");
    assert.ok(row && row.start_minutes === 660, `booked at 11:00: ${JSON.stringify(row)}`);
  });

  await test("a yes with a question attached commits, then the model answers only the question", async () => {
    const day = { iso: createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug)._internals.dayIso(4) };
    const args = { service: "Coupe + barbe", day: day.iso, time: "15:00", stylist: "Iryna", client_name: "Jason Lee" };
    const llm = scriptedLlm([
      toolCall("book_appointment", args),
      text(`To confirm: Coupe + barbe with Iryna, ${day.iso} at 3:00 PM, under the name Jason Lee. Shall I book it?`),
      (request) => {
        assert.ok(!request.tools.some((def) => def.function.name === "book_appointment"), "no booking tools after the commit");
        return text("Parking is free right in front of the shop.");
      }
    ]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ salon: BARBER.slug, sessionId: "yes-plus", message: `Name: Jason Lee. Coupe + barbe with Iryna on ${day.iso} at 3pm`, channel: "Webchat", greeted: true });
    const done = await assistant.chat({ salon: BARBER.slug, sessionId: "yes-plus", message: "Yes, and is there parking?", channel: "Webchat" });
    assert.ok(/you're booked/i.test(done.reply) && /Parking is free/.test(done.reply), done.reply);
    assert.ok(mayaAppointments(BARBER.slug).some((entry) => entry.client_name === "Jason Lee"), "booked");
  });

  await test("affirmation: yes/oui/da/так commit; a yes with a change or a question-only yes never does", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const yes = ["yes", "Yeah sure", "ok", "Sure!", "oui", "Ouais", "c'est bon", "Parfait", "d'accord", "da", "да", "так", "Yes, and do I need a deposit?", "Oui, et c'est où exactement?", "Perfect, see you then"];
    const no = ["yes but Saturday instead", "oui mais plutôt samedi", "No", "non", "Correct?", "Верно ли, что во вторник?", "ok?", "attendez", "wait, not that day"];
    yes.forEach((phrase) => assert.strictEqual(assistant._internals.isAffirmation(phrase), true, `should AFFIRM: ${phrase}`));
    no.forEach((phrase) => assert.strictEqual(assistant._internals.isAffirmation(phrase), false, `should NOT affirm: ${phrase}`));
  });

  await test("ambiguous service answered once is never asked again (coupe simple ou coupe + barbe)", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    const session = salon._internals.ensureSession({ sessionId: "amb", channel: "Webchat" });
    const iso = salon._internals.dayIso(5);
    const turn1 = { userMessage: "une coupe svp", actionCommitted: false };
    const first = salon._internals.executeTool(session, turn1, "check_availability", { service: "coupe", day: iso });
    assert.strictEqual(first.ambiguous, true, "two coupes: ask once");
    // The client answers; the model keeps passing the vague word.
    store.forSalon(BARBER.slug).createConversationMessage(session.conversation_id, { text: "coupe simple", type: "incoming" });
    const turn2 = { userMessage: "coupe simple", actionCommitted: false };
    const second = salon._internals.executeTool(session, turn2, "check_availability", { service: "coupe", day: iso });
    assert.ok(!second.ambiguous, `settled by the client's answer: ${JSON.stringify(second).slice(0, 160)}`);
    assert.strictEqual(second.service.name, "Coupe simple");
    const turn3 = { userMessage: "Oui c'est bon", actionCommitted: false };
    const third = salon._internals.executeTool(session, turn3, "book_appointment", { service: "coupe", day: iso, time: "11:30", client_name: "Marc" });
    assert.strictEqual(third.status, "needs_confirmation", JSON.stringify(third).slice(0, 200));
    assert.strictEqual(third.read_back.service, "Coupe simple");
  });

  await test("the model asking 'Vous confirmez?' without the tool: the server stages the draft and sends the real read-back", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    const iso = salon._internals.dayIso(6);
    const llm = scriptedLlm([
      text("Avec plaisir! À quelle heure?"),
      text("Je vais réserver la coupe simple avec Karim à 16 h. Vous confirmez?")
    ]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ salon: BARBER.slug, sessionId: "fr-self-confirm", message: `Bonjour, je m'appelle Élodie, une coupe simple le ${iso}`, channel: "telegram", greeted: true });
    const stage = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-self-confirm", message: "16h avec Karim", channel: "telegram" });
    assert.ok(stage.state.gates.includes("auto_stage"), `auto_stage gate: ${stage.state.gates}`);
    assert.strictEqual(stage.state.pendingAction && stage.state.pendingAction.stylist, "Karim");
    assert.ok(/^Je récapitule : Coupe simple avec Karim, .* à 16 h, au nom d'Élodie\. Je confirme la réservation\?$/.test(stage.reply), stage.reply);
    const done = await assistant.chat({ salon: BARBER.slug, sessionId: "fr-self-confirm", message: "Oui", channel: "telegram" });
    assert.ok(/réservé/.test(done.reply), done.reply);
    assert.ok(mayaAppointments(BARBER.slug).some((row) => row.client_name === "Élodie" && row.start_minutes === 960), "booked 16:00");
  });

  await test("booking day guard: the model drifting from 'next Thursday' to another day is pulled back", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    const thursday = salon._internals.resolveDay("next Thursday").offset;
    const wrong = thursday >= 2 ? thursday - 2 : thursday + 2;
    const llm = scriptedLlm([
      toolCall("check_availability", { service: "Coupe simple", day: salon._internals.dayIso(thursday) }),
      text("Thursday has 11:00 AM, 2:00 PM or 4:00 PM. Which one?"),
      toolCall("book_appointment", { service: "Coupe simple", day: salon._internals.dayIso(wrong), time: "14:00", client_name: "Jason Lee" }),
      text("To confirm: Coupe simple, 2:00 PM, under the name Jason Lee. Shall I book it?")
    ]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ salon: BARBER.slug, sessionId: "day-drift", message: "Hi, a simple cut next Thursday afternoon?", channel: "Webchat", greeted: true });
    const stage = await assistant.chat({ salon: BARBER.slug, sessionId: "day-drift", message: "2pm works. Name: Jason Lee", channel: "Webchat" });
    const pending = assistant.forSalon(BARBER.slug)._internals.loadSession("day-drift").state.pendingAction;
    assert.strictEqual(pending.dayOffset, thursday, `staged on Thursday, not the drifted day: ${JSON.stringify(pending)}`);
    assert.ok(stage.reply.includes("2:00 PM"), stage.reply);
  });

  await test("a yes with a question the model leaves unanswered: booked, and the question goes to the team honestly", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(SOLO.slug);
    const iso = salon._internals.dayIso(5);
    const llm = scriptedLlm([
      toolCall("book_appointment", { service: "Classic full set", day: iso, time: "10:00", client_name: "Megan Clarke" }),
      text(`To confirm: Classic full set with Priya, ${iso} at 10:00 AM, under the name Megan Clarke. Shall I book it?`),
      text("")
    ]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ salon: SOLO.slug, sessionId: "yes-empty", message: `Classic set on ${iso} at 10am, I'm Megan Clarke`, channel: "Webchat", greeted: true });
    const done = await assistant.chat({ salon: SOLO.slug, sessionId: "yes-empty", message: "Yes please, do you take e-transfer?", channel: "Webchat" });
    assert.ok(/you're booked/.test(done.reply) && /passed it to the salon team/.test(done.reply), done.reply);
    assert.ok(!/within the hour/.test(done.reply));
  });

  // ------------------------------------------------------------ dates
  await test("dates: relative words, weekdays, month names and a model-guessed year resolve on the server", async () => {
    const today = "2026-09-18"; // a Friday
    const p = (value) => dates.parseDayArgument(value, today);
    assert.deepStrictEqual(p("tomorrow"), { offset: 1 });
    assert.deepStrictEqual(p("demain"), { offset: 1 });
    assert.deepStrictEqual(p("завтра"), { offset: 1 });
    assert.deepStrictEqual(p("après-demain"), { offset: 2 });
    assert.deepStrictEqual(p("next Thursday"), { offset: 6 });
    assert.deepStrictEqual(p("jeudi prochain"), { offset: 6 });
    assert.deepStrictEqual(p("Friday"), { offset: 0 }, "the weekday that is today");
    assert.deepStrictEqual(p("next Friday"), { offset: 7 });
    assert.deepStrictEqual(p("Sep 24"), { offset: 6 });
    assert.deepStrictEqual(p("24 septembre"), { offset: 6 });
    assert.deepStrictEqual(p("24 сентября"), { offset: 6 });
    assert.deepStrictEqual(p("19 сентября"), { offset: 1 }, "tomorrow is never past");
    assert.deepStrictEqual(p("2024-09-24"), { offset: 6 }, "a guessed past year is corrected");
    assert.deepStrictEqual(p("2026-09-24"), { offset: 6 });
    assert.deepStrictEqual(p("Sept 17"), { error: "date_in_past" }, "yesterday is honestly past");
    assert.deepStrictEqual(p("Monday Sep 21"), { offset: 3 });
    assert.deepStrictEqual(p("in 3 days"), { offset: 3 });
    assert.deepStrictEqual(p("3"), { offset: 3 }, "engine offsets still work");
    assert.deepStrictEqual(p("2026-12-31"), { error: "date_out_of_range" });
  });

  await test("dates: every turn carries today, the year and a 14-day date→weekday table; client date words are resolved", async () => {
    const llm = scriptedLlm([text("Sure, tomorrow works. What time?")]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ salon: BARBER.slug, sessionId: "dates-ctx", message: "Can I come tomorrow or next Thursday?", channel: "Webchat", greeted: true });
    const salon = assistant.forSalon(BARBER.slug);
    const today = salon._internals.todayIso();
    const system = llm.seen[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(system.includes(`The year is ${today.slice(0, 4)}`), "year stated");
    assert.ok(system.includes(`${today} ${dates.WEEKDAY_EN[dates.weekdayOf(today)]} (today)`), "today row");
    const tomorrow = dates.addDays(today, 1);
    assert.ok(system.includes(`${tomorrow} ${dates.WEEKDAY_EN[dates.weekdayOf(tomorrow)]} (tomorrow)`), "tomorrow row");
    assert.ok(system.includes(dates.addDays(today, 13)), "14 rows");
    assert.ok(system.includes(`"tomorrow" = ${tomorrow}`), `client's words resolved: ${system.slice(-400)}`);
    const session = salon._internals.ensureSession({ sessionId: "dates-ctx" });
    const avail = salon._internals.executeTool(session, { userMessage: "tomorrow", actionCommitted: false }, "check_availability", { service: "Coupe simple", day: "tomorrow" });
    assert.ok(!avail.error, `tomorrow is bookable, never past: ${JSON.stringify(avail).slice(0, 160)}`);
    assert.strictEqual(avail.date, tomorrow);
    const past = salon._internals.executeTool(session, { userMessage: "", actionCommitted: false }, "check_availability", { service: "Coupe simple", day: dates.addDays(today, -1) });
    assert.strictEqual(past.error, "date_in_past");
    assert.ok(past.today.includes(today), "the error tells the model what today is");
  });

  // ------------------------------------------------------------ names
  await test("names: client name and phone are parsed before staff matching", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    const parse = salon._internals.parseClientIdentity;
    assert.deepStrictEqual(parse("Name: Jason Lee"), { name: "Jason Lee", phone: "" });
    assert.deepStrictEqual(parse("Nadia 289-555-0123"), { name: "Nadia", phone: "289-555-0123" });
    assert.strictEqual(parse("my name is Chloé Martin").name, "Chloé Martin");
    assert.strictEqual(parse("Je m'appelle Alexandre").name, "Alexandre");
    assert.strictEqual(parse("Меня зовут Анна").name, "Анна");
    assert.strictEqual(parse("I'm looking for a fade").name, "", "not a name");
    assert.strictEqual(parse("c'est bon").name, "");
  });

  await test("names: 'Nadia 289-555-0123' is the client, never 'no stylist by that name'", async () => {
    const llm = scriptedLlm([
      toolCall("check_availability", { service: "Classic full set", day: "tomorrow", stylist: "Nadia" }),
      text("Thanks Nadia! Priya has openings tomorrow at 10:00 AM or 1:00 PM. Which works?")
    ]);
    const assistant = createAssistant({ store, llm });
    const result = await assistant.chat({ salon: SOLO.slug, sessionId: "nadia", message: "Nadia 289-555-0123", channel: "telegram", greeted: true, languageHint: "en" });
    assert.ok(!result.state.gates.some((gate) => gate.startsWith("stylist_gate")), `no stylist gate: ${result.state.gates}`);
    const toolMessage = llm.seen[1].messages.find((m) => m.role === "tool");
    const toolResult = JSON.parse(toolMessage.content);
    assert.ok(!toolResult.stylist_not_found, `client name dropped as a staff filter: ${toolMessage.content.slice(0, 160)}`);
    assert.ok(toolResult.slots.every((slot) => slot.stylist === "Priya"), "the one-person salon books Priya");
    const conversation = store.db.prepare(`SELECT name, contact_phone FROM conversations WHERE id = ?`).get(result.state.conversationId);
    assert.strictEqual(conversation.name, "Nadia", "conversation named after the client");
    const system = llm.seen[0].messages[0].content;
    assert.ok(/one team member: Priya/.test(system) && /Never ask the client which staff member/.test(system), "single-staff rule in the prompt");
  });

  await test("names: 'Name: Jason Lee' as a stylist argument is ignored; a requested unknown barber is still reported", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    const session = salon._internals.ensureSession({ sessionId: "jason", channel: "Webchat" });
    session.state.client = { name: "Jason Lee" };
    const iso = salon._internals.dayIso(2);
    const withClientName = salon._internals.executeTool(session, { userMessage: "Name: Jason Lee", actionCommitted: false }, "check_availability", { service: "Coupe simple", day: iso, stylist: "Jason Lee" });
    assert.ok(!withClientName.stylist_not_found, JSON.stringify(withClientName).slice(0, 160));
    const asked = salon._internals.executeTool(session, { userMessage: "can I book with Natalie?", actionCommitted: false }, "check_availability", { service: "Coupe simple", day: iso, stylist: "Natalie" });
    assert.strictEqual(asked.stylist_not_found, true, "a barber the client asked for and who does not exist is reported");
  });

  await test("names: Cyrillic↔Latin staff aliases (к Ирине = Iryna, Карим = Karim) and no transliteration in replies", async () => {
    const salon = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(BARBER.slug);
    assert.strictEqual((salon._internals.resolveStylist("к Ирине") || {}).name, "Iryna");
    assert.strictEqual((salon._internals.resolveStylist("Ірина") || {}).name, "Iryna");
    assert.strictEqual((salon._internals.resolveStylist("к Кариму") || {}).name, "Karim");
    assert.strictEqual(salon._internals.detectUnknownStylists("хочу к Ирине в субботу").length, 0, "Ирина is on staff");
    const restored = salon._internals.restoreNameSpelling("Проверяю: Fade у Карима, суббота, на имя Александр. Всё верно?", ["Karim", "Iryna", "Alexandre"]);
    assert.ok(/Karim/.test(restored) && /Alexandre/.test(restored) && !/Карим|Александр/.test(restored), restored);
  });

  await test("names: Telegram passes the client's first name and the greeting counts as the introduction", async () => {
    const llm = scriptedLlm([text("Of course! Which day works for you?")]);
    const assistant = createAssistant({ store, llm });
    const result = await assistant.chat({ salon: BARBER.slug, sessionId: "tg:1:4242", message: "Hi, can I book a fade?", channel: "telegram", clientName: "Tanya Morales", greeted: true, languageHint: "en" });
    assert.ok(!/Maya/.test(result.reply), `no second introduction after /start: ${result.reply}`);
    const conversation = store.db.prepare(`SELECT name FROM conversations WHERE id = ?`).get(result.state.conversationId);
    assert.strictEqual(conversation.name, "Tanya Morales");
    assert.ok(/You already introduced yourself/.test(llm.seen[0].messages[0].content));
  });

  // ------------------------------------------------------------ prompt
  await test("prompt: English base, no response-time promise, never transliterate, verbatim price labels", async () => {
    const prompt = buildSystemPrompt({ faq: { salon: { name: "X" }, topics: [] }, language: "fr", staff: ["Chloé", "Karim"] });
    const cyrillicWords = prompt.match(/[а-яёіїєґ]{2,}/gi) || [];
    assert.ok(cyrillicWords.length <= 2, `no Russian in the base prompt: ${cyrillicWords.join(" ")}`);
    assert.ok(!/within the hour/.test(prompt));
    assert.ok(/Never transliterate a name/.test(prompt));
    assert.ok(/\$220–\$320/.test(prompt) && /By consultation/.test(prompt));
    assert.ok(/Reminder: reply in French/.test(prompt));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((failure) => console.error(failure.error));
    process.exit(1);
  }
})();
