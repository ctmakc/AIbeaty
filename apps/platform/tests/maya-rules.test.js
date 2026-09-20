#!/usr/bin/env node
// Maya: staff days and services, closing time, price labels and the price
// guard, policies after cancel/move, consult-only services, external booking
// apps, FAQ-first answers (walk-ins, address) and no response-time promises.
// Salon configs are the funnel-emulation personas of 2026-09-18 (Marc's
// barbershop, Olena's nails, Anna's medspa, Priya's lash studio, Jessica's
// hair salon), saved through the same setup → store path as the wizard.
//
// Run: node apps/platform/tests/maya-rules.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-maya-rules-"));
process.env.PLATFORM_DB_PATH = path.join(TEST_DIR, "platform.db");
delete process.env.ALERT_EMAIL;

const { createPlatformStore } = require("../backend/store");
const { createAssistant } = require("../backend/assistant");
const { normalizeSetup, setupToStore } = require("../backend/tenancy");
const rules = require("../backend/maya-rules");

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

// ------------------------------------------------------------------ personas
const MARC = {
  salon: { name: "Barbier Dubois", city: "Montréal", address: "4321 rue Saint-Denis", phone: "(514) 555-0142", timezone: "America/Toronto" },
  hours: { sun: "10:00-16:00", mon: "closed", tue: "09:00-20:00", wed: "09:00-20:00", thu: "09:00-20:00", fri: "09:00-20:00", sat: "09:00-18:00" },
  services: [
    { name: "Coupe", category: "Haircut", durationMinutes: 30, price: "35$" },
    { name: "Fade", category: "Haircut", durationMinutes: 45, price: "40$" },
    { name: "Barbe", category: "Beard", durationMinutes: 20, price: "20$" },
    { name: "Coupe + barbe", category: "Haircut & Beard", durationMinutes: 50, price: "50$" }
  ],
  staff: [
    { name: "Marc", role: "Propriétaire / barbier", services: [], workDays: ["tue", "wed", "thu", "fri", "sat", "sun"] },
    { name: "Karim", role: "Barbier", services: [], workDays: ["tue", "wed", "thu"] },
    { name: "Julien", role: "Barbier", services: [], workDays: ["wed", "thu", "fri", "sat", "sun"] },
    { name: "Sam", role: "Barbier", services: [], workDays: ["thu", "fri", "sat", "sun"] }
  ],
  faq: {
    parking: "Parcomètres sur Saint-Denis, gratuit dans les rues à côté après 21h.",
    payment: "Carte, comptant, Interac.",
    cancellation: "Gratuit jusqu'à 3 heures avant.",
    deposit: "Pas de dépôt.",
    late: "On attend 10 minutes, après on prend le prochain walk-in.",
    custom: [{ q: "Walk-ins / sans rendez-vous?", a: "Oui, les walk-ins sont bienvenus, mais les rendez-vous passent en priorité. L'attente peut être de 15 à 60 min le samedi. Le plus sûr: réserver." }]
  },
  assistant: { forbidden: "Les autres barbiers du quartier." }
};

const OLENA = {
  salon: { name: "Olena Nail Studio", city: "Barrhaven, Ottawa", address: "3500 Fallowfield Rd, Unit 7", phone: "(613) 555-0142", timezone: "America/Toronto" },
  hours: { sun: "closed", mon: "closed", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" },
  services: [
    { name: "Classic manicure", category: "Nails", durationMinutes: 45, price: "$35" },
    { name: "Gel manicure", category: "Nails", durationMinutes: 60, price: "$50" },
    { name: "Acrylic full set", category: "Nails", durationMinutes: 120, price: "from $85", deposit: true },
    { name: "Nail art", category: "Nails", durationMinutes: 30, price: "from $5/nail" }
  ],
  staff: [
    { name: "Olena", role: "Owner", services: [], workDays: ["tue", "wed", "thu", "fri", "sat"] },
    { name: "Iryna", role: "Nail tech", services: [], workDays: ["tue", "wed", "thu", "fri"] },
    { name: "Sofia", role: "Nail tech", services: ["Classic manicure", "Gel manicure", "Nail art"], workDays: ["wed", "thu", "fri", "sat"] }
  ],
  faq: {
    parking: "Parking in the plaza",
    payment: "Debit, credit, cash, e-Transfer",
    cancellation: "Cancel or reschedule at least 24h before. Later than that, the deposit is lost.",
    deposit: "$20 deposit only for acrylic full set, by e-Transfer. Goes toward the price.",
    late: "We wait 10 minutes, after that we may need to reschedule",
    custom: []
  },
  assistant: {}
};

const ANNA = {
  salon: { name: "Lumiere Aesthetics", city: "Vancouver", address: "1128 W Broadway, Suite 210", phone: "(604) 555-0142", timezone: "America/Vancouver" },
  hours: { sun: "closed", mon: "10:00-19:00", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" },
  services: [
    { name: "HydraFacial Signature", category: "Facials", durationMinutes: 60, price: "$199" },
    { name: "Injectable Consultation", category: "Injectables", durationMinutes: 30, price: "$0" },
    { name: "Botox / neurotoxin", category: "Injectables", durationMinutes: 30, price: "$14/unit" },
    { name: "Dermal Filler", category: "Injectables", durationMinutes: 60, price: "from $650" },
    { name: "Skin assessment", category: "Consults", durationMinutes: 30, price: "Free" },
    { name: "Laser resurfacing", category: "Laser", durationMinutes: 60, price: "By consultation" }
  ],
  staff: [
    { name: "Dr. Anna Lee", role: "Medical director", services: ["Injectable Consultation", "Botox / neurotoxin", "Dermal Filler"], workDays: ["wed", "fri"] },
    { name: "Jenna Wu", role: "Aesthetician", services: ["HydraFacial Signature", "Skin assessment", "Laser resurfacing"], workDays: ["mon", "tue", "wed", "thu", "fri"] },
    { name: "Mina Choi", role: "RN", services: ["Injectable Consultation", "Botox / neurotoxin", "Dermal Filler"], workDays: ["tue", "wed", "thu", "fri", "sat"] }
  ],
  faq: {
    cancellation: "Please give 48 hours notice to cancel or reschedule. Late cancellations and no-shows are charged $75.",
    deposit: "A $50 deposit is required for injectable and laser appointments; it is applied to your treatment.",
    custom: []
  },
  assistant: {}
};

const PRIYA = {
  salon: { name: "Lash by Priya", city: "Mississauga", address: "41 Kingsbridge Garden Circle, Mississauga (home studio, side door)", phone: "(647) 555-0142", timezone: "America/Toronto" },
  hours: { sun: "closed", mon: "11:00-20:00", tue: "09:00-21:00", wed: "12:00-21:00", thu: "09:00-21:00", fri: "09:00-18:00", sat: "09:00-16:00" },
  services: [
    { name: "Classic full set", category: "Lashes", durationMinutes: 120, price: "$120", deposit: true },
    { name: "Volume full set", category: "Lashes", durationMinutes: 150, price: "$160", deposit: true },
    { name: "Lash lift + tint", category: "Lashes", durationMinutes: 60, price: "$85" }
  ],
  staff: [{ name: "Priya", role: "Lash artist", services: [], workDays: ["mon", "tue", "wed", "thu", "fri", "sat"] }],
  faq: {
    cancellation: "Reschedule or cancel at least 48 hours before. Less than 48h = deposit is lost.",
    deposit: "$25 NON-REFUNDABLE deposit for all full sets via e-Transfer",
    custom: [
      { q: "Where are you located? What is the address?", a: "Home studio in Mississauga (Erin Mills area). The exact address is sent ONLY after the booking is confirmed and the $25 deposit is received. Never give the street address before that." },
      { q: "How do I send the deposit?", a: "e-Transfer $25 to lashbypriya@example.com within 12 hours of booking, otherwise the spot is released. Put your name in the message." }
    ]
  },
  assistant: { forbidden: "Exact street address before deposit." }
};

const JESSICA = {
  salon: { name: "Maison Tremblay Hair", city: "Gatineau", address: "145 Promenade du Portage", phone: "(819) 555-0142", timezone: "America/Toronto" },
  hours: { sun: "closed", mon: "closed", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" },
  services: [
    { name: "Women's cut & style", category: "Cuts", durationMinutes: 60, price: "from $75 (senior stylist +$15)" },
    { name: "Blowout / Brushing", category: "Styling", durationMinutes: 45, price: "$55–$70 depending on length" },
    { name: "Balayage", category: "Colour", durationMinutes: 120, price: "$220–$320 depending on length", deposit: true },
    { name: "Toner / gloss", category: "Colour", durationMinutes: 30, price: "$45 add-on to colour" },
    { name: "Colour correction", category: "Colour", durationMinutes: 120, price: "By consultation" },
    { name: "Colour correction consultation", category: "Colour", durationMinutes: 15, price: "$0" }
  ],
  staff: [
    { name: "Jessica", role: "Owner", services: [], workDays: ["tue", "wed", "thu", "fri"] },
    { name: "Chloé", role: "Colour director", services: [], workDays: ["tue", "wed", "thu", "fri", "sat"] }
  ],
  faq: {
    cancellation: "Cancellations less than 24 h before your appointment forfeit the deposit.",
    deposit: "Deposit of $50 required for any colour service over $200.",
    custom: []
  },
  assistant: {}
};

function install(slug, setup) {
  const doc = normalizeSetup(setup);
  const converted = setupToStore(doc);
  store.createSalon({
    slug,
    name: doc.salon.name,
    city: doc.salon.city,
    timezone: doc.salon.timezone,
    address: doc.salon.address,
    phone: doc.salon.phone,
    hours: converted.hours,
    faq: { topics: converted.topics },
    faqSource: "db"
  });
  store.forSalon(slug).replaceCatalog({ categories: converted.categories, staff: converted.staff });
}

// First offset ≥ 2 whose weekday is `weekday` (0 = Sunday).
function offsetFor(salon, weekday) {
  for (let offset = 2; offset < 10; offset++) {
    if (new Date(`${salon._internals.dayIso(offset)}T12:00:00Z`).getUTCDay() === weekday) return offset;
  }
  throw new Error("no offset");
}
const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;

function weekdayOfIso(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

(async () => {
  console.log(`maya-rules.test.js — db: ${process.env.PLATFORM_DB_PATH}`);
  install("marc-test", MARC);
  install("olena-test", OLENA);
  install("anna-test", ANNA);
  install("priya-test", PRIYA);
  install("jessica-test", JESSICA);

  const salonOf = (slug, llm) => createAssistant({ store, llm: llm || scriptedLlm([]) }).forSalon(slug);
  const turnFor = (message) => ({ userMessage: message, actionCommitted: false, incomingIndex: 1 });

  // ------------------------------------------------------------ pure rules
  await test("rules: price kinds and the allow-list", async () => {
    assert.strictEqual(rules.priceKind("$220–$320 depending on length"), "range");
    assert.strictEqual(rules.priceKind("from $75 (senior stylist +$15)"), "from");
    assert.strictEqual(rules.priceKind("from $5/nail"), "per_unit");
    assert.strictEqual(rules.priceKind("$14/unit"), "per_unit");
    assert.strictEqual(rules.priceKind("+$15"), "add_on");
    assert.strictEqual(rules.priceKind("Free"), "free");
    assert.strictEqual(rules.priceKind("$0"), "free");
    assert.strictEqual(rules.priceKind("By consultation"), "consultation");
    assert.strictEqual(rules.priceKind("$35.00"), "fixed");
    const allowed = rules.buildPriceAllowList({
      services: [{ price_label: "from $75 (senior stylist +$15)", price_value: 75 }, { price_label: "$14/unit", price_value: 14 }],
      faqTexts: ["$25 NON-REFUNDABLE deposit"],
      clientMessage: "how much for 20 units?"
    });
    [75, 15, 90, 14, 280, 25].forEach((num) => assert.ok(allowed.has(num), `allowed ${num}`));
    assert.ok(!allowed.has(100), "an invented total is not allowed");

    // An add-on priced as its own row: base + add-on is the owner's own maths.
    const withAddOn = rules.buildPriceAllowList({
      services: [
        { price_label: "$55", price_value: 55 },
        { price_label: "$220-$320", price_value: 220 },
        { price_label: "+$15", price_value: 15 }
      ],
      faqTexts: [],
      clientMessage: "gel manicure with nail art?"
    });
    [55, 15, 70, 220, 320, 235, 335].forEach((num) => assert.ok(withAddOn.has(num), `add-on total ${num}`));
    assert.ok(!withAddOn.has(80), "a total nobody's price list supports is still blocked");
  });

  await test("rules: work days parse from numbers, English, French, Russian; label reads Tue–Thu", async () => {
    assert.deepStrictEqual(rules.parseWorkDays("[2,3,4]"), [2, 3, 4]);
    assert.deepStrictEqual(rules.parseWorkDays(["tue", "mercredi", "четверг"]), [2, 3, 4]);
    assert.strictEqual(rules.parseWorkDays("[]"), null);
    assert.strictEqual(rules.workDaysLabel([2, 3, 4]), "Tue–Thu");
    assert.strictEqual(rules.workDaysLabel([3, 5]), "Wed, Fri");
  });

  await test("rules: a booking claim is only a claim when nothing conditional comes before it", async () => {
    const claim = /(you'?re (all )?(booked|set)|booking (is )?confirmed|вы записаны)/i;
    assert.strictEqual(rules.affirmsBooking("Once your booking is confirmed and the $25 deposit is received, I'll send the address.", claim), false);
    assert.strictEqual(rules.affirmsBooking("Are you booked with us already?", claim), false);
    assert.strictEqual(rules.affirmsBooking("You're booked! See you Tuesday.", claim), true);
    assert.strictEqual(rules.affirmsBooking("You're all set, if plans change just write.", claim), true);
  });

  // ------------------------------------------------------------ Marc: Karim Tue–Thu, walk-ins, closing
  await test("Marc: Karim is never offered on Saturday or Sunday; asking for him there gets 'Karim works Tue–Thu'", async () => {
    const salon = salonOf("marc-test");
    const session = salon._internals.ensureSession({ sessionId: "marc-1", channel: "Webchat" });
    const sat = offsetFor(salon, SAT);
    const sun = offsetFor(salon, SUN);
    for (const offset of [sat, sun]) {
      const free = salon._internals.executeTool(session, turnFor("un fade samedi"), "check_availability", { service: "Fade", day: salon._internals.dayIso(offset) });
      assert.ok(free.slots.length > 0, `slots on ${salon._internals.dayIso(offset)}`);
      assert.ok(free.slots.every((slot) => slot.stylist !== "Karim"), `no Karim: ${JSON.stringify(free.slots)}`);
    }
    const withKarim = salon._internals.executeTool(session, turnFor("un fade avec Karim samedi"), "check_availability", { service: "Fade", day: salon._internals.dayIso(sat), stylist: "Karim" });
    assert.strictEqual(withKarim.error, "staff_not_working", JSON.stringify(withKarim));
    assert.strictEqual(withKarim.works_on, "Tue–Thu");
    assert.strictEqual(withKarim.salon_open_that_day, true);
    assert.ok(/never say the salon is closed/i.test(withKarim.note));
    assert.ok(withKarim.next_days_with_stylist.length > 0);
    withKarim.next_days_with_stylist.forEach((day) => assert.ok([TUE, WED, THU].includes(weekdayOfIso(day.date)), `Karim's next day ${day.date}`));
    assert.ok(withKarim.same_day_other_staff.every((slot) => slot.stylist !== "Karim"));

    const booked = salon._internals.executeTool(session, turnFor("avec Karim samedi 10h"), "book_appointment", { service: "Fade", day: salon._internals.dayIso(sat), time: "10:00", stylist: "Karim", client_name: "Alexandre" });
    assert.strictEqual(booked.error, "staff_not_working", JSON.stringify(booked));
  });

  await test("Marc: a 45-min fade at 15:45 on Sunday does not fit before the 16:00 close", async () => {
    const salon = salonOf("marc-test");
    const session = salon._internals.ensureSession({ sessionId: "marc-2", channel: "Webchat" });
    const sun = offsetFor(salon, SUN);
    const iso = salon._internals.dayIso(sun);
    const check = salon._internals.executeTool(session, turnFor("dimanche 15h45"), "check_availability", { service: "Fade", day: iso, time: "15:45" });
    assert.strictEqual(check.requested_time.available, false);
    assert.ok(/end after closing/.test(check.requested_time.reason) && /15:15/.test(check.requested_time.reason), check.requested_time.reason);
    assert.strictEqual(check.last_start_for_this_service, "15:15");
    assert.ok(salon._internals.freeSlots(sun, 45, null).every((slot) => slot.startMinutes + 45 <= 16 * 60));
    const book = salon._internals.executeTool(session, turnFor("dimanche 15h45"), "book_appointment", { service: "Fade", day: iso, time: "15:45", client_name: "Alexandre" });
    assert.strictEqual(book.error, "outside_hours", JSON.stringify(book));
    assert.ok(/last start is 15:15/.test(book.note), book.note);
  });

  await test("Marc: 'sans rendez-vous' gets the owner's walk-in answer before any tool", async () => {
    const llm = scriptedLlm([text("Oui, les walk-ins sont bienvenus, mais les rendez-vous passent en priorité. Voulez-vous réserver?")]);
    const salon = salonOf("marc-test", llm);
    const result = await salon.chat({ sessionId: "marc-3", message: "Est-ce que je peux venir sans rendez-vous dimanche à 15h45?" });
    const system = llm.seen[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(/owner already answered/.test(system) && /walk-ins sont bienvenus/.test(system), "walk-in FAQ injected first");
    assert.ok(/walk-ins sont bienvenus/.test(result.reply), result.reply);
  });

  await test("Marc: the TODAY calendar and the Team block show who works which day", async () => {
    const llm = scriptedLlm([text("Bonjour! Que puis-je faire pour vous?")]);
    const salon = salonOf("marc-test", llm);
    await salon.chat({ sessionId: "marc-4", message: "Bonjour" });
    const prompt = llm.seen[0].messages[0].content;
    assert.ok(/- Karim: works Tue–Thu; does all services/.test(prompt), "team line for Karim");
    const sat = salon._internals.dayIso(offsetFor(salon, SAT));
    const satLine = prompt.split("\n").find((line) => line.startsWith(sat));
    assert.ok(satLine && /working: Marc, Julien, Sam/.test(satLine) && !/Karim/.test(satLine), satLine);
  });

  // ------------------------------------------------------------ Olena: Sofia no acrylic, false "closed", deposit, late cancel
  await test("Olena: Sofia does not do acrylic; Saturday acrylic goes to Olena only", async () => {
    const salon = salonOf("olena-test");
    const session = salon._internals.ensureSession({ sessionId: "olena-1", channel: "Webchat" });
    const sat = offsetFor(salon, SAT);
    const iso = salon._internals.dayIso(sat);
    const withSofia = salon._internals.executeTool(session, turnFor("acrylic with Sofia on Saturday"), "book_appointment", { service: "Acrylic full set", day: iso, time: "11:00", stylist: "Sofia", client_name: "Megan Clarke" });
    assert.strictEqual(withSofia.error, "staff_does_not_do_service", JSON.stringify(withSofia));
    assert.deepStrictEqual(withSofia.who_does_it, ["Olena", "Iryna"]);
    const free = salon._internals.executeTool(session, turnFor("acrylic Saturday"), "check_availability", { service: "Acrylic full set", day: iso });
    assert.ok(free.slots.length && free.slots.every((slot) => slot.stylist === "Olena"), JSON.stringify(free.slots));
    const any = salon._internals.executeTool(session, turnFor("acrylic Saturday 11"), "book_appointment", { service: "Acrylic full set", day: iso, time: "11:00", client_name: "Megan Clarke" });
    assert.strictEqual(any.status, "needs_confirmation", JSON.stringify(any));
    assert.strictEqual(any.read_back.stylist, "Olena");
  });

  await test("Olena: 'Wednesday is closed' is rewritten once with the real hours, and never reaches the client", async () => {
    const llm = scriptedLlm([
      text("Wednesday is a closed day for us. How about Thursday?"),
      text("We're open Wednesday 10:00-19:00. What time works for you?")
    ]);
    const salon = salonOf("olena-test", llm);
    const result = await salon.chat({ sessionId: "olena-2", message: "Can I come Wednesday for a gel manicure?" });
    assert.ok(result.state.gates.includes("fact_regen"), JSON.stringify(result.state.gates));
    assert.ok(!/closed/i.test(result.reply), result.reply);
    assert.ok(/10:00-19:00/.test(result.reply), result.reply);

    // The last-resort gate replaces the sentence itself.
    const fixed = salon._internals.fixClosedClaims("Wednesday is a closed day for us. How about Thursday?", "en");
    assert.ok(/^On Wednesday we're open 10:00-19:00\. How about Thursday\?$/.test(fixed), fixed);
    // A day the salon is really closed stays closed; a staff member's day off is left alone.
    assert.strictEqual(salon._internals.falseClosedDays("We're closed on Sunday.").length, 0);
    assert.strictEqual(salon._internals.falseClosedDays("Sofia is off on Tuesday, the salon is closed for her.").length, 0);
  });

  await test("Olena: deposit and 'from' prices pass the guard; an invented combo total gets the real labels", async () => {
    const llm = scriptedLlm([
      text("Acrylic full set is from $85, and there's a $20 deposit by e-Transfer that goes toward the price. Want me to find a time?"),
      text("Gel manicure with design on 10 nails is $100."),
      text("That comes to $100 total.")
    ]);
    const salon = salonOf("olena-test", llm);
    const first = await salon.chat({ sessionId: "olena-3", message: "How much is an acrylic full set and do I need a deposit?" });
    assert.ok(!first.state.gates.some((gate) => /price_guard|fact_regen/.test(gate)), JSON.stringify(first.state.gates));
    assert.ok(/from \$85/.test(first.reply) && /\$20 deposit/.test(first.reply), first.reply);
    const combo = await salon.chat({ sessionId: "olena-3", message: "And a gel manicure plus nail art on 10 nails?" });
    assert.ok(combo.state.gates.some((gate) => /price_guard/.test(gate)), JSON.stringify(combo.state.gates));
    assert.ok(/Gel manicure: \$50(?!\.)/.test(combo.reply) && /from \$5\/nail/.test(combo.reply), combo.reply);
    assert.ok(!/\$100/.test(combo.reply), combo.reply);
    assert.notStrictEqual(combo.state.assistantState, "escalated");
  });

  await test("Olena: a late cancel is confirmed first, then the owner's cancellation policy is quoted", async () => {
    const llm = scriptedLlm([
      toolCall("cancel_appointment", {}),
      text("placeholder read-back")
    ]);
    const salon = salonOf("olena-test", llm);
    const session = salon._internals.ensureSession({ sessionId: "olena-4", channel: "Webchat" });
    const tue = offsetFor(salon, TUE);
    const staged = salon._internals.executeTool(session, turnFor("book me"), "book_appointment", { service: "Gel manicure", day: salon._internals.dayIso(tue), time: "11:00", client_name: "Megan Clarke" });
    assert.strictEqual(staged.status, "needs_confirmation");
    const booked = salon._internals.executeTool(session, { userMessage: "yes", actionCommitted: false, incomingIndex: 1 }, "book_appointment", { service: "Gel manicure", day: salon._internals.dayIso(tue), time: "11:00", client_name: "Megan Clarke" });
    assert.strictEqual(booked.status, "booked", JSON.stringify(booked));
    salon._internals.saveSession(session);
    const ask = await salon.chat({ sessionId: "olena-4", message: "I need to cancel my appointment" });
    assert.ok(/Shall I cancel it\?/.test(ask.reply), ask.reply);
    const done = await salon.chat({ sessionId: "olena-4", message: "yes" });
    assert.ok(/^Done, the appointment is cancelled\./.test(done.reply), done.reply);
    assert.ok(/Our cancellation policy: Cancel or reschedule at least 24h before/.test(done.reply), done.reply);
  });

  // ------------------------------------------------------------ Anna: Dr. Lee Wed/Fri injectables only, per unit, consult-only
  await test("Anna: Dr. Lee does no HydraFacial and does not work Saturday; a Saturday HydraFacial goes to Jenna-free days only", async () => {
    const salon = salonOf("anna-test");
    const session = salon._internals.ensureSession({ sessionId: "anna-1", channel: "Webchat" });
    const sat = offsetFor(salon, SAT);
    const iso = salon._internals.dayIso(sat);
    const hydra = salon._internals.executeTool(session, turnFor("HydraFacial with Dr. Lee Saturday"), "book_appointment", { service: "HydraFacial Signature", day: iso, time: "11:00", stylist: "Dr. Anna Lee", client_name: "Olivia Tran" });
    assert.strictEqual(hydra.error, "staff_does_not_do_service", JSON.stringify(hydra));
    assert.deepStrictEqual(hydra.who_does_it, ["Jenna Wu"]);
    const botoxSat = salon._internals.executeTool(session, turnFor("botox with Dr. Lee Saturday"), "check_availability", { service: "Botox", day: iso, stylist: "Dr. Anna Lee" });
    assert.strictEqual(botoxSat.error, "staff_not_working", JSON.stringify(botoxSat));
    assert.strictEqual(botoxSat.works_on, "Wed, Fri");
    assert.ok(botoxSat.same_day_other_staff.every((slot) => slot.stylist === "Mina Choi"), JSON.stringify(botoxSat.same_day_other_staff));
    // Jenna (the only one for HydraFacial) does not work Saturdays: open salon, nobody for this service.
    const hydraSat = salon._internals.executeTool(session, turnFor("HydraFacial Saturday"), "check_availability", { service: "HydraFacial Signature", day: iso });
    assert.strictEqual(hydraSat.error, "no_staff_that_day", JSON.stringify(hydraSat));
    assert.ok(/Never say the salon is closed/.test(hydraSat.note));
    hydraSat.next_days.forEach((day) => assert.ok([MON, TUE, WED, THU, FRI].includes(weekdayOfIso(day.date)), day.date));
  });

  await test("Anna: moving an injectable consult to Saturday with Dr. Lee is refused with her days", async () => {
    const salon = salonOf("anna-test");
    const session = salon._internals.ensureSession({ sessionId: "anna-2", channel: "Webchat" });
    const wed = offsetFor(salon, WED);
    const args = { service: "Injectable Consultation", day: salon._internals.dayIso(wed), time: "11:00", stylist: "Dr. Anna Lee", client_name: "Olivia Tran" };
    salon._internals.executeTool(session, turnFor("with Dr. Lee Wednesday"), "book_appointment", args);
    const booked = salon._internals.executeTool(session, { userMessage: "yes", actionCommitted: false, incomingIndex: 1 }, "book_appointment", args);
    assert.strictEqual(booked.status, "booked", JSON.stringify(booked));
    const sat = offsetFor(salon, SAT);
    const move = salon._internals.executeTool(session, turnFor("move it to Saturday"), "reschedule_appointment", { day: salon._internals.dayIso(sat), time: "11:00", appointment_id: booked.appointment.id });
    assert.strictEqual(move.error, "staff_not_working", JSON.stringify(move));
    assert.ok(/Dr\. Anna Lee works Wed, Fri/.test(move.note), move.note);
  });

  await test("Anna: per-unit math by the client's quantity passes; 'By consultation' gets no number and no direct booking; 'Free' is free", async () => {
    const salon = salonOf("anna-test");
    const session = salon._internals.ensureSession({ sessionId: "anna-3", channel: "Webchat" });
    assert.deepStrictEqual(salon._internals.unknownPricesIn(session, "Botox is $14/unit, so 20 units would be $280.", "how much for 20 units of botox?"), []);
    assert.deepStrictEqual(salon._internals.unknownPricesIn(session, "Botox is $14/unit, so 30 units would be $420.", "how much is botox?"), [420]);
    const laser = salon._internals.executeTool(session, turnFor("book laser resurfacing"), "book_appointment", { service: "Laser resurfacing", day: salon._internals.dayIso(offsetFor(salon, TUE)), time: "11:00", client_name: "Olivia Tran" });
    assert.strictEqual(laser.consult_only, true, JSON.stringify(laser));
    assert.ok(laser.consultation_services.some((row) => row.name === "Injectable Consultation"));
    const list = salon._internals.executeTool(session, turnFor("prices?"), "get_services_and_prices", {});
    const byName = Object.fromEntries(list.services.map((row) => [row.name, row]));
    assert.strictEqual(byName["Laser resurfacing"].price, "By consultation");
    assert.strictEqual(byName["Laser resurfacing"].price_kind, "consultation");
    assert.strictEqual(byName["Skin assessment"].price_kind, "free");
    assert.strictEqual(byName["Dermal Filler"].price, "from $650");
    const answer = salon._internals.priceAnswer("how much is laser resurfacing?", "en");
    assert.ok(/priced by consultation/.test(answer) && !/\$/.test(answer), answer);
  });

  // ------------------------------------------------------------ Priya: closed Sundays, opens 9, address after deposit
  await test("Priya: Sunday is closed, nothing before 9:00, and the address stays private until booking", async () => {
    const llm = scriptedLlm([
      text("The exact address is sent once your booking is confirmed and the $25 deposit is received. It's a home studio in Erin Mills, Mississauga. Would you like to book?")
    ]);
    const salon = salonOf("priya-test", llm);
    const session = salon._internals.ensureSession({ sessionId: "priya-1", channel: "Webchat" });
    const sun = offsetFor(salon, SUN);
    const closed = salon._internals.executeTool(session, turnFor("Sunday 8am"), "check_availability", { service: "Classic full set", day: salon._internals.dayIso(sun) });
    assert.strictEqual(closed.closed, true);
    assert.ok(closed.next_days.length && closed.next_days[0].slots.length);
    const tue = offsetFor(salon, TUE);
    assert.ok(salon._internals.freeSlots(tue, 120, null).every((slot) => slot.startMinutes >= 9 * 60));
    const early = salon._internals.executeTool(session, turnFor("Tuesday 7am"), "book_appointment", { service: "Classic full set", day: salon._internals.dayIso(tue), time: "7:00 AM", client_name: "Nadia" });
    assert.strictEqual(early.error, "outside_hours");

    assert.strictEqual(salon._internals.addressPrivate, true);
    const result = await salon.chat({ sessionId: "priya-2", message: "whats the address first?" });
    assert.ok(!result.state.gates.some((gate) => /booking_claim|price_guard/.test(gate)), JSON.stringify(result.state.gates));
    assert.ok(/address is sent once your booking is confirmed/.test(result.reply), result.reply);
    const prompt = llm.seen[0].messages[0].content;
    assert.ok(!/Kingsbridge/.test(prompt), "street address never in the prompt");
    const system = llm.seen[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(/exact address is sent ONLY after the booking/.test(system), "owner's address answer injected");
  });

  await test("Priya: a booking with a deposit gets the deposit rule and how to send it after the confirmation", async () => {
    const salon = salonOf("priya-test");
    const session = salon._internals.ensureSession({ sessionId: "priya-3", channel: "Webchat" });
    const tue = offsetFor(salon, TUE);
    const note = salon._internals.policyNote({ kind: "book", serviceId: salon._internals.resolveServices("Classic full set")[0].id }, "en");
    assert.ok(/About the deposit: \$25 NON-REFUNDABLE deposit/.test(note), note);
    assert.ok(/e-Transfer \$25 to lashbypriya@example.com/.test(note), note);
    assert.ok(tue > 0 && session);
  });

  // ------------------------------------------------------------ Jessica: ranges, from, add-ons, consult-only via label
  await test("Jessica: ranges, 'from' and in-label senior surcharge are quoted without the guard firing", async () => {
    const llm = scriptedLlm([
      text("Balayage is $220–$320 depending on length, and colour over $200 needs a $50 deposit. Women's cut & style is from $75, or $90 with a senior stylist. Would you like a time?")
    ]);
    const salon = salonOf("jessica-test", llm);
    const result = await salon.chat({ sessionId: "jess-1", message: "How much is balayage and a women's cut, and do I need a deposit?" });
    assert.ok(!result.state.gates.some((gate) => /price_guard|fact_regen/.test(gate)), JSON.stringify(result.state.gates));
    assert.ok(/\$220–\$320/.test(result.reply) && /\$50 deposit/.test(result.reply) && /\$90/.test(result.reply), result.reply);
  });

  await test("Jessica: a number for colour correction is replaced by 'priced by consultation'; the guard never escalates, never repeats", async () => {
    const llm = scriptedLlm([
      text("Colour correction is usually $250."),
      text("Colour correction is $250."),
      text("Colour correction is about $300."),
      text("Colour correction is about $300.")
    ]);
    const salon = salonOf("jessica-test", llm);
    const first = await salon.chat({ sessionId: "jess-2", message: "How much is colour correction?" });
    assert.ok(/priced by consultation/.test(first.reply) && !/\$250/.test(first.reply), first.reply);
    const second = await salon.chat({ sessionId: "jess-2", message: "How much is colour correction?" });
    assert.notStrictEqual(second.state.assistantState, "escalated", "a blocked answer never goes human-only");
    assert.ok(second.reply !== first.reply, `no repeated canned line: ${second.reply}`);
    assert.ok(!/\$300/.test(second.reply), second.reply);
  });

  // ------------------------------------------------------------ external calendars, promises, claim scoping
  await test("external booking apps: Maya says she can't see Square and hands off, with no LLM call", async () => {
    const llm = scriptedLlm([]);
    const salon = salonOf("jessica-test", llm);
    const result = await salon.chat({ sessionId: "jess-3", message: "Hi, I booked on Square for Saturday, can you move it to Friday?" });
    assert.strictEqual(llm.calls, 0);
    assert.ok(/can't see bookings made in Square/.test(result.reply), result.reply);
    assert.strictEqual(result.state.assistantState, "escalated");
    const fr = await salonOf("marc-test", scriptedLlm([])).chat({ sessionId: "marc-ext", message: "J'ai réservé sur Booksy pour samedi, c'est confirmé?" });
    assert.ok(/Je ne vois pas les réservations faites dans Booksy/.test(fr.reply), fr.reply);
  });

  await test("external apps mentioned without a booking: a hint, never a lookup", async () => {
    const llm = scriptedLlm([text("I can only book here in this chat. Want me to find you a time?")]);
    const salon = salonOf("jessica-test", llm);
    await salon.chat({ sessionId: "jess-4", message: "Do you take bookings on Booksy too?" });
    const system = llm.seen[0].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(/You cannot see Booksy/.test(system));
  });

  await test("no response-time promises survive, in any language; a fact like '12 hours' stays", async () => {
    const llm = scriptedLlm([
      text("I've passed this to Priya, she will get back to you within the hour."),
      text("Send the $25 by e-Transfer within 12 hours of booking.")
    ]);
    const salon = salonOf("priya-test", llm);
    const first = await salon.chat({ sessionId: "priya-4", message: "Can Priya call me?" });
    assert.ok(!/within the hour/.test(first.reply) && /as soon as they can/.test(first.reply), first.reply);
    const second = await salon.chat({ sessionId: "priya-4", message: "How do I send the deposit?" });
    assert.ok(/within 12 hours of booking/.test(second.reply), second.reply);
  });

  await test("post-treatment complications go straight to a human, with no LLM call, in en/fr/ru", async () => {
    const cases = [
      "My lip is swollen, hard and a bit bluish since the filler yesterday",
      "Ma lèvre est enflée et violacée depuis l'injection",
      "После филлера губа опухла и синеет",
      "I have blurry vision after my botox"
    ];
    for (const [index, message] of cases.entries()) {
      const llm = scriptedLlm([]);
      const result = await salonOf("anna-test", llm).chat({ sessionId: `anna-urgent-${index}`, message });
      assert.strictEqual(llm.calls, 0, `no LLM for: ${message}`);
      assert.strictEqual(result.state.assistantState, "escalated", `${message} → ${JSON.stringify(result.state)}`);
      assert.ok(!/would you like me to connect/i.test(result.reply || ""), result.reply);
    }
  });

  await test("price labels stay exactly as the owner wrote them; consult-only keeps the indication", async () => {
    const converted = setupToStore(normalizeSetup({
      salon: { name: "X", timezone: "America/Toronto" },
      hours: { mon: "10:00-18:00" },
      services: [
        { name: "HydraFacial", durationMinutes: 60, price: "$199" },
        { name: "Coupe", durationMinutes: 30, price: "35$" },
        { name: "Filler", durationMinutes: 60, price: "from $650", consultOnly: true }
      ],
      staff: [{ name: "A", workDays: ["mon"] }]
    }));
    const labels = converted.categories.flatMap((category) => category.services.map((service) => service.priceLabel));
    assert.deepStrictEqual(labels, ["$199", "35$", "By consultation (from $650)"]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAILED: ${failure.name}\n${failure.error.stack}`));
    process.exit(1);
  }
})();
