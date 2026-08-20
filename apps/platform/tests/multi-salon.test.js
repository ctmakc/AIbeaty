#!/usr/bin/env node
// Multi-salon tests: intake importer validation + idempotency, store-level
// isolation between two salons, and Maya answering with the RIGHT salon's
// prices, staff, hours and timezone. No network.
//
// Run: node apps/platform/tests/multi-salon.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-multisalon-"));
process.env.PLATFORM_DB_PATH = path.join(TEST_DIR, "platform.db");
delete process.env.ALERT_EMAIL;

const { createPlatformStore } = require("../backend/store");
const { createAssistant } = require("../backend/assistant");

const store = createPlatformStore();
const DEFAULT_SLUG = store.DEFAULT_SALON_SLUG;

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

// A second salon: nails/lashes studio, open Sunday (the demo salon is closed
// Sunday), different services, prices, staff and policies.
const SALON_B = {
  slug: "iris-test-bar",
  salon: {
    name: "Iris Test Bar",
    city: "Барrhaven",
    address: "3570 Strandherd Drive",
    phone: "(613) 555-0147",
    timezone: "America/Toronto"
  },
  hours: {
    понедельник: "выходной",
    вторник: "10:00-20:00",
    среда: "10:00-20:00",
    четверг: "10:00-20:00",
    пятница: "10:00-20:00",
    суббота: "09:00-18:00",
    воскресенье: "11:00-16:00"
  },
  services: [
    { name: "Маникюр с покрытием", category: "Ногти", durationMinutes: 75, price: "$65", keywords: ["маникюр", "гель-лак"] },
    { name: "Педикюр", category: "Ногти", durationMinutes: 90, price: "$80", keywords: ["педикюр"] },
    { name: "Наращивание ресниц", category: "Взгляд", durationMinutes: 120, price: "$120", requiresDeposit: true, keywords: ["ресницы"] }
  ],
  staff: [
    { name: "Ирина Ковальчук", role: "Мастер ногтевого сервиса", services: ["Маникюр с покрытием", "Педикюр"], workDays: ["вторник", "среда", "четверг", "пятница", "суббота"], aliases: ["Ира"] },
    { name: "Даша Мельник", role: "Лешмейкер", services: ["Наращивание ресниц"], workDays: ["вторник", "четверг", "пятница", "суббота", "воскресенье"] }
  ],
  policies: { cancellation: "Отмена бесплатно за 12 часов до визита." },
  faq: { parking: "Своя бесплатная парковка перед входом." },
  escalation: { who: "Ирина", notify: "owner@iris.demo" }
};

(async () => {
  console.log(`multi-salon.test.js — db: ${process.env.PLATFORM_DB_PATH}`);

  const importer = await import("../../../scripts/onboard-salon.mjs");

  // ---------------------------------------------------------------- validation
  await test("importer validation: staff referencing a service that is not in the list", async () => {
    const { errors } = importer.validate({
      slug: "x", salon: { name: "X", timezone: "America/Toronto" },
      hours: { вторник: "09:00-19:00" },
      services: [{ name: "Стрижка", durationMinutes: 60, price: "$50" }],
      staff: [{ name: "Анна", services: ["балаяж"] }]
    });
    const message = errors.find((entry) => entry.includes("балаяж"));
    assert.ok(message, `expected a Russian error naming the missing service, got: ${JSON.stringify(errors)}`);
    assert.ok(/Мастер Анна умеет услугу «балаяж», но такой услуги в списке нет/.test(message), `message: ${message}`);
  });

  await test("importer validation: bad timezone, unparseable hours, bad price, zero duration", async () => {
    const { errors } = importer.validate({
      slug: "x", salon: { name: "X", timezone: "Mars/Olympus" },
      hours: { вторник: "9 до 19" },
      services: [{ name: "Стрижка", durationMinutes: 0, price: "дорого" }],
      staff: [{ name: "Анна", services: ["Стрижка"] }]
    });
    assert.ok(errors.some((entry) => /Mars\/Olympus/.test(entry) && /America\/Toronto/.test(entry)), "timezone error suggests a real zone");
    assert.ok(errors.some((entry) => /Не понял часы работы/.test(entry)), "hours error");
    assert.ok(errors.some((entry) => /не указана длительность/.test(entry)), "duration error");
    assert.ok(errors.some((entry) => /не разобрана цена/.test(entry)), "price error");
    assert.ok(errors.every((entry) => !/undefined|NaN|Error:/.test(entry)), `errors must stay human: ${JSON.stringify(errors)}`);
  });

  await test("importer validation: duplicate service and duplicate master are caught", async () => {
    const { errors } = importer.validate({
      slug: "x", salon: { name: "X", timezone: "America/Toronto" },
      hours: { вторник: "09:00-19:00" },
      services: [
        { name: "Стрижка", durationMinutes: 60, price: 50 },
        { name: "стрижка", durationMinutes: 60, price: 50 }
      ],
      staff: [
        { name: "Анна", services: ["Стрижка"] },
        { name: "анна", services: ["Стрижка"] }
      ]
    });
    assert.ok(errors.some((entry) => /Услуга «стрижка» встречается в анкете дважды/.test(entry)));
    assert.ok(errors.some((entry) => /Мастер «анна» встречается в анкете дважды/.test(entry)));
  });

  await test("importer validation: a complete intake passes with no errors", async () => {
    const { errors } = importer.validate(SALON_B);
    assert.deepStrictEqual(errors, [], `unexpected errors: ${JSON.stringify(errors)}`);
  });

  await test("importer: hours parse to the engine's weekday map, closed days become null", async () => {
    const hours = importer.buildHours(SALON_B);
    assert.strictEqual(hours["1"], null, "Monday closed");
    assert.deepStrictEqual(hours["2"], { open: "10:00", close: "20:00" }, "Tuesday");
    assert.deepStrictEqual(hours["0"], { open: "11:00", close: "16:00" }, "Sunday open (unlike the demo salon)");
  });

  // ---------------------------------------------------------------- import
  function importSalonB(overrides = {}) {
    const intake = Object.assign({}, SALON_B, overrides);
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
    return store.forSalon(intake.slug).replaceCatalog({
      categories: importer.buildCategories(intake),
      staff: importer.buildStaff(intake)
    });
  }

  await test("import creates salon B without touching the demo salon", async () => {
    const before = store.forSalon(DEFAULT_SLUG).summary();
    const result = importSalonB();
    assert.strictEqual(result.services, 3);
    assert.strictEqual(result.staff, 2);
    const after = store.forSalon(DEFAULT_SLUG).summary();
    assert.strictEqual(after.services, before.services, "demo salon services untouched");
    assert.strictEqual(after.staff, before.staff, "demo salon staff untouched");
    assert.strictEqual(store.listSalons().length, 2);
  });

  await test("import is idempotent: re-running the same intake does not duplicate", async () => {
    const first = store.forSalon(SALON_B.slug).summary();
    importSalonB();
    importSalonB();
    const again = store.forSalon(SALON_B.slug).summary();
    assert.strictEqual(again.services, first.services, `services must not multiply: ${first.services} → ${again.services}`);
    assert.strictEqual(again.staff, first.staff, `staff must not multiply: ${first.staff} → ${again.staff}`);
  });

  await test("import updates in place: a changed price replaces the old one, same row count", async () => {
    const changed = JSON.parse(JSON.stringify(SALON_B));
    changed.services[0].price = "$70";
    importSalonB(changed);
    const scope = store.forSalon(SALON_B.slug);
    const services = scope.getServicesPage().categories.flatMap((category) => category.services);
    assert.strictEqual(services.length, 3, "still three services");
    const manicure = services.find((service) => service.name === "Маникюр с покрытием");
    // The label keeps the owner's own wording from the intake ("$70", "от $110").
    assert.strictEqual(manicure.price, "$70", `price updated in place, got ${manicure.price}`);
    // put it back for the assistant tests below
    importSalonB();
    const restored = store.forSalon(SALON_B.slug).getServicesPage()
      .categories.flatMap((category) => category.services)
      .find((service) => service.name === "Маникюр с покрытием");
    assert.strictEqual(restored.price, "$65");
  });

  await test("import removes a service dropped from the intake", async () => {
    const trimmed = JSON.parse(JSON.stringify(SALON_B));
    trimmed.services = trimmed.services.filter((service) => service.name !== "Педикюр");
    trimmed.staff = trimmed.staff.map((member) => Object.assign({}, member, {
      services: member.services.filter((name) => name !== "Педикюр")
    }));
    importSalonB(trimmed);
    const names = store.forSalon(SALON_B.slug).getServicesPage()
      .categories.flatMap((category) => category.services).map((service) => service.name);
    assert.ok(!names.includes("Педикюр"), `dropped service must be gone, got ${names.join(", ")}`);
    importSalonB(); // restore
    assert.strictEqual(store.forSalon(SALON_B.slug).summary().services, 3);
  });

  // ---------------------------------------------------------------- isolation
  await test("store isolation: salon B's catalog and staff are invisible to the demo salon", async () => {
    const a = store.forSalon(DEFAULT_SLUG);
    const b = store.forSalon(SALON_B.slug);
    const aServices = a.getServicesPage().categories.flatMap((category) => category.services).map((s) => s.name);
    const bServices = b.getServicesPage().categories.flatMap((category) => category.services).map((s) => s.name);
    assert.ok(!aServices.some((name) => bServices.includes(name)), "no service leaks across salons");
    const aStaff = a.getStylistRows().map((row) => row.name);
    const bStaff = b.getStylistRows().map((row) => row.name);
    assert.ok(bStaff.includes("Ирина Ковальчук"));
    assert.ok(!aStaff.includes("Ирина Ковальчук"), "salon B staff not visible in salon A");
    assert.ok(!bStaff.includes("Sarah Jenkins"), "salon A staff not visible in salon B");
  });

  await test("store isolation: an appointment booked in B never appears in A's schedule or inbox", async () => {
    const a = store.forSalon(DEFAULT_SLUG);
    const b = store.forSalon(SALON_B.slug);
    const appointmentId = b.createAppointment({
      client: "Изоляция Тестовна",
      service: "Маникюр с покрытием",
      stylist: "Ирина Ковальчук",
      date: "12:00-13:15",
      dayOffset: 2
    });
    assert.ok(appointmentId, "appointment created in B");

    const bDay = b.getSchedulePage({ dayOffset: 2 }).appointments.map((entry) => entry.client);
    assert.ok(bDay.includes("Изоляция Тестовна"), `B sees its own booking: ${bDay.join(", ")}`);

    for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
      const aDay = a.getSchedulePage({ dayOffset: offset }).appointments.map((entry) => entry.client);
      assert.ok(!aDay.includes("Изоляция Тестовна"), `A must not see B's booking on day ${offset}`);
    }
    assert.ok(!a.getClientsPage().clients.some((client) => client.name === "Изоляция Тестовна"), "A's directory clean");
    assert.ok(!a.getInboxPage().conversations.some((conversation) => /Изоляция/.test(conversation.name)), "A's inbox clean");
    assert.ok(!a.getPerformanceReport().summaryText.includes("Изоляция"), "A's report clean");
  });

  await test("store isolation: resetting the demo salon leaves salon B intact", async () => {
    const b = store.forSalon(SALON_B.slug);
    const before = b.summary();
    store.forSalon(DEFAULT_SLUG).reset();
    const after = b.summary();
    assert.deepStrictEqual(
      { services: after.services, staff: after.staff, appointments: after.appointments },
      { services: before.services, staff: before.staff, appointments: before.appointments },
      "salon B survives a demo-salon reset"
    );
  });

  await test("unknown salon resolves to null rather than silently falling back", async () => {
    assert.strictEqual(store.forSalon("no-such-salon"), null);
    assert.strictEqual(store.salonExists("no-such-salon"), false);
    assert.ok(store.forSalon(SALON_B.slug));
  });

  // ---------------------------------------------------------------- assistant
  await test("assistant: salon B's own prices are quoted, and salon A's price is not allowed", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("get_services_and_prices", { query: "маникюр" }),
        text("Маникюр с покрытием у нас $65, занимает 75 минут. Подобрать время?")
      ])
    });
    const result = await assistant.chat({ salon: SALON_B.slug, sessionId: "b-price", message: "Сколько стоит маникюр?" });
    assert.ok(/65/.test(result.reply), `B's real price survives the quote-guard: ${result.reply}`);
    assert.ok(!result.state.gates.some((gate) => gate.startsWith("price_guard")), `no price gate: ${result.state.gates}`);
  });

  await test("assistant: a price from salon A is blocked when talking to salon B", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("get_services_and_prices", { query: "маникюр" }),
        // $85 is the demo salon's Women's Precision Cut — not a price salon B has.
        text("Это будет стоить $85, приходите!")
      ])
    });
    const result = await assistant.chat({ salon: SALON_B.slug, sessionId: "b-price-leak", message: "Сколько стоит маникюр?" });
    assert.ok(!/85/.test(result.reply), `another salon's price must not survive: ${result.reply}`);
    assert.ok(result.state.gates.some((gate) => gate.startsWith("price_guard")), `price gate fires: ${result.state.gates}`);
  });

  await test("assistant: salon B's services resolve, the demo salon's do not exist there", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const b = assistant.forSalon(SALON_B.slug);
    const session = b._internals.ensureSession({ sessionId: "b-services", channel: "Webchat" });
    const turn = { userMessage: "маникюр", actionCommitted: false };

    const manicure = b._internals.executeTool(session, turn, "check_availability", { service: "маникюр", day: "вторник" });
    assert.ok(manicure.service, `manicure resolves in salon B: ${JSON.stringify(manicure).slice(0, 160)}`);
    assert.strictEqual(manicure.service.name, "Маникюр с покрытием");
    assert.strictEqual(manicure.service.price, "$65");

    const balayage = b._internals.executeTool(session, turn, "check_availability", { service: "балаяж", day: "вторник" });
    assert.strictEqual(balayage.found, false, "the demo salon's balayage does not exist in salon B");
    const known = (balayage.known_services || []).map((service) => service.name);
    assert.ok(known.includes("Маникюр с покрытием"), `fallback lists B's own services: ${known.join(", ")}`);
    assert.ok(!known.some((name) => /Balayage|Scissor|Precision/.test(name)), `no demo-salon services leak: ${known.join(", ")}`);
  });

  await test("assistant: each salon keeps its own opening hours (B is open Sunday, A is not)", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const a = assistant.forSalon(DEFAULT_SLUG);
    const b = assistant.forSalon(SALON_B.slug);

    const sundayOffsetFor = (salon) => {
      for (let offset = 0; offset < 7; offset += 1) {
        if (salon._internals.dayWeekday(offset) === 0) return offset;
      }
      throw new Error("no Sunday within a week");
    };
    assert.strictEqual(a._internals.hoursForOffset(sundayOffsetFor(a)), null, "demo salon closed on Sunday");
    assert.deepStrictEqual(b._internals.hoursForOffset(sundayOffsetFor(b)), [11 * 60, 16 * 60], "salon B open 11:00–16:00 on Sunday");

    const sessionB = b._internals.ensureSession({ sessionId: "b-sunday", channel: "Webchat" });
    const turn = { userMessage: "воскресенье", actionCommitted: false };
    const result = b._internals.executeTool(sessionB, turn, "check_availability", { service: "маникюр", day: "воскресенье" });
    assert.ok(!result.closed, `salon B must accept Sunday: ${JSON.stringify(result).slice(0, 160)}`);
  });

  await test("assistant: booking through salon B lands in B and stays invisible in A", async () => {
    const b = store.forSalon(SALON_B.slug);
    const a = store.forSalon(DEFAULT_SLUG);
    const probe = createAssistant({ store, llm: scriptedLlm([]) }).forSalon(SALON_B.slug);
    const dayOffset = probe._internals.resolveDay("среда").offset;
    const slot = probe._internals.freeSlots(dayOffset, 75, null)[0];
    const timeArg = `${Math.floor(slot.startMinutes / 60)}:${String(slot.startMinutes % 60).padStart(2, "0")}`;
    const bookArgs = { service: "маникюр", day: "среда", time: timeArg, stylist: "Ирина", client_name: "Салон Б Клиентка" };

    const assistant = createAssistant({
      store,
      llm: scriptedLlm([
        toolCall("book_appointment", bookArgs),
        text("Проверяю: маникюр в среду. Всё верно?"),
        toolCall("book_appointment", bookArgs),
        text("Готово, вы записаны!")
      ])
    });
    await assistant.chat({ salon: SALON_B.slug, sessionId: "b-book", message: `Запишите на маникюр в среду в ${timeArg}` });
    const confirmed = await assistant.chat({ salon: SALON_B.slug, sessionId: "b-book", message: "Да, всё верно" });

    const row = store.db.prepare(`SELECT * FROM appointments WHERE client_name = ?`).get("Салон Б Клиентка");
    assert.ok(row, "appointment row written");
    assert.strictEqual(row.salon_id, SALON_B.slug, `row belongs to salon B, got ${row.salon_id}`);
    assert.ok(/записаны/i.test(confirmed.reply), `confirmation allowed after a real write: ${confirmed.reply}`);

    const inB = b.getSchedulePage({ dayOffset }).appointments.some((entry) => entry.client === "Салон Б Клиентка");
    assert.ok(inB, "B's schedule shows it");
    for (let offset = 0; offset < 7; offset += 1) {
      const inA = a.getSchedulePage({ dayOffset: offset }).appointments.some((entry) => entry.client === "Салон Б Клиентка");
      assert.ok(!inA, `A must not show B's booking (day ${offset})`);
    }
    assert.ok(!a.getInboxPage().conversations.some((conversation) => /Салон Б/.test(conversation.name)), "A's inbox clean");
  });

  await test("assistant: the same sessionId in two salons is two separate conversations", async () => {
    const assistant = createAssistant({
      store,
      llm: scriptedLlm([text("Здравствуйте! Я Майя, ИИ-ассистентка салона. Чем помочь?"), text("Здравствуйте! Я Майя, ИИ-ассистентка салона. Чем помочь?")])
    });
    const shared = "web-collision-1";
    const inA = await assistant.chat({ salon: DEFAULT_SLUG, sessionId: shared, message: "Добрый день" });
    const inB = await assistant.chat({ salon: SALON_B.slug, sessionId: shared, message: "Добрый день" });
    assert.notStrictEqual(inA.state.conversationId, inB.state.conversationId, "separate threads per salon");

    const rows = store.db.prepare(`SELECT salon_id FROM assistant_sessions WHERE id = ? ORDER BY salon_id`).all(shared);
    assert.strictEqual(rows.length, 2, "one session row per salon");
    assert.deepStrictEqual(rows.map((row) => row.salon_id).sort(), [DEFAULT_SLUG, SALON_B.slug].sort());
  });

  await test("assistant: unknown salon is refused, never served the default salon's data", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const result = await assistant.chat({ salon: "ghost-salon", sessionId: "ghost", message: "Привет" });
    assert.strictEqual(result.error, "unknown_salon");
    assert.strictEqual(assistant.forSalon("ghost-salon"), null);
  });

  await test("assistant: salon B's staff resolve by nickname and declension; A's staff do not", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const b = assistant.forSalon(SALON_B.slug);
    assert.ok(b._internals.resolveStylist("Ирина"), "full first name");
    assert.ok(b._internals.resolveStylist("к Ирине"), "dative declension");
    assert.ok(b._internals.resolveStylist("Ира"), "nickname from the intake aliases");
    assert.strictEqual(b._internals.resolveStylist("Sarah"), null, "demo salon's stylist is unknown in B");
    assert.strictEqual(b._internals.detectUnknownStylists("хочу к Ирине на маникюр").length, 0, "real B stylist not flagged");
    assert.strictEqual(b._internals.detectUnknownStylists("хочу к Валентине на маникюр").length, 1, "unknown name flagged");
  });

  await test("assistant: digest and usage are reported per salon", async () => {
    const assistant = createAssistant({ store, llm: scriptedLlm([]) });
    const digestB = assistant.getDigest(undefined, SALON_B.slug);
    const digestA = assistant.getDigest(undefined, DEFAULT_SLUG);
    assert.strictEqual(digestB.salon, "Iris Test Bar", `B's digest names B: ${digestB.salon}`);
    assert.strictEqual(digestB.salonSlug, SALON_B.slug);
    assert.strictEqual(digestA.salon, "Luminous Core");
    assert.ok(digestB.conversations.every((conversation) => !/Amanda|Jessica/i.test(conversation.client)), "no A conversations in B's digest");
    assert.strictEqual(assistant.getDigest(undefined, "ghost-salon"), null);
    assert.strictEqual(assistant.getUsage(undefined, "ghost-salon"), null);
  });

  await test("assistant: salon B's FAQ answers come from its own intake, not the demo file", async () => {
    const record = store.getSalonRecord(SALON_B.slug);
    const topics = record.faq.topics.map((topic) => topic.ru).join(" ");
    assert.ok(/Своя бесплатная парковка/.test(topics), "B's own parking answer");
    assert.ok(!/Somerset|Bank St/.test(topics), `no demo-salon FAQ leaked: ${topics.slice(0, 200)}`);
    assert.ok(/за 12 часов/.test(topics), "B's own cancellation policy");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  failures.forEach((failure) => {
    console.log(`FAILED: ${failure.name}`);
    console.log(failure.error.stack || failure.error.message);
  });
  if (failures.length) process.exit(1);
})();
