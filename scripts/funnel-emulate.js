#!/usr/bin/env node
// Funnel emulation v3 — five salon-owner personas walk signup → wizard →
// launch → their own clients talking to Maya, over REAL HTTP against a real
// server with the REAL LLM. Telegram is a local stub so we can read exactly
// what the bot would send.
//
// Needs a real LLM key (same env as the server), so it is NOT part of
// `npm run assistant:test`. Run: npm run funnel:emulate
//   ONLY=marc-barber   only that persona
//   KEEP_DB=<dir>      keep the SQLite file (assistant_events hold every gate)
//   OUT=<file.json>    where the transcript goes (default funnel-emulation.json)
//
// Output: the JSON transcript (every request and reply) + a pass/fail line per
// blocker from docs/funnel-emulation-2026-09-18/REPORT.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");

const REPO = process.env.REPO || path.resolve(__dirname, "..");
const SERVER = path.join(REPO, "apps/platform/server.js");
const OUT = process.env.OUT || path.join(process.cwd(), "funnel-emulation.json");
const DIR = process.env.KEEP_DB ? (fs.mkdirSync(process.env.KEEP_DB, { recursive: true }) || process.env.KEEP_DB) : fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-v3-"));
const BOT_TOKEN = "7000000001:AAv3EmulationTokenForTheFunnelRun_abcd";
let botSeq = 0;
const nextBotToken = () => `70000000${String(++botSeq).padStart(2, "0")}:AAv3EmulationTokenForTheFunnelRun_ab${botSeq}`;

const log = [];
const findings = [];
const note = (persona, blocker, ok, detail) => {
  findings.push({ persona, blocker, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} [${blocker}] ${persona}: ${detail}`);
};

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
    request.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { resolve({}); } });
  });
}
const telegramCalls = [];
function startTelegramStub(port) {
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    const match = request.url.match(/^\/bot([^/]+)\/(\w+)$/);
    const method = match ? match[2] : "";
    telegramCalls.push({ method, body });
    response.setHeader("Content-Type", "application/json");
    const botId = Number((match ? match[1] : "0").split(":")[0]) || 7000000001;
    if (method === "getMe") {
      response.end(JSON.stringify({ ok: true, result: { id: botId, is_bot: true, username: `v3_salon_bot_${botId}`, first_name: "V3 Salon" } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length + 1000 } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TZ = "America/Toronto";
const todayToronto = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const hasCyrillic = (s) => /[А-Яа-яЁёІіЇїЄєҐґ]/.test(String(s || ""));

// --------------------------------------------------------------------------
const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const personas = [
  {
    id: "olena-nails",
    salon: "Petal & Polish",
    email: "olena@petal.test",
    city: "Ottawa",
    businessType: "nails",
    lang: "en",
    paste: `Petal & Polish, 240 Bank St Ottawa. Tue-Sat 10-19, Sun-Mon closed.
Gel manicure $55 (60 min). Russian manicure $70 (75 min). Acrylic full set from $95 (120 min).
Pedicure $70 (75 min). Nail art +$15. Repair $5/nail.
Team: Olena (owner, all services), Sofia (gel + pedicure only, works Tue Wed Thu).
Deposit $20 to hold a Saturday slot. Late cancel under 24h is charged 50%.
Free parking behind the building.`,
    hours: { tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-19:00", sun: "closed", mon: "closed" },
    services: [
      { name: "Gel manicure", durationMinutes: 60, price: "$55", category: "Nails" },
      { name: "Russian manicure", durationMinutes: 75, price: "$70", category: "Nails" },
      { name: "Acrylic full set", durationMinutes: 120, price: "from $95", category: "Nails" },
      { name: "Pedicure", durationMinutes: 75, price: "$70", category: "Nails" },
      { name: "Nail art", durationMinutes: 15, price: "+$15", category: "Add-on" }
    ],
    staff: [
      { name: "Olena", role: "Owner", workDays: ["tue", "wed", "thu", "fri", "sat"], services: ["Gel manicure", "Russian manicure", "Acrylic full set", "Pedicure", "Nail art"] },
      { name: "Sofia", role: "Nail tech", workDays: ["tue", "wed", "thu"], services: ["Gel manicure", "Pedicure"] }
    ],
    faq: { parking: "Free parking behind the building.", deposit: "A $20 deposit holds a Saturday slot.", cancellation: "Cancelling under 24 hours is charged 50%." },
    clientLang: "en"
  },
  {
    id: "marc-barber",
    salon: "Barbier Rideau",
    email: "marc@rideau.test",
    city: "Gatineau",
    businessType: "barber",
    lang: "fr",
    paste: `Barbier Rideau, 12 rue Principale Gatineau. Mardi-Samedi 9h-18h. Dimanche et lundi fermé.
Coupe simple 35$ (30 min). Coupe + barbe 55$ (45 min). Barbe seule 25$ (20 min). Coupe enfant 25$ (30 min).
Équipe: Marc (tout), Karim (coupe simple et barbe, travaille mardi mercredi jeudi).
Stationnement gratuit derrière.`,
    hours: { tue: "09:00-18:00", wed: "09:00-18:00", thu: "09:00-18:00", fri: "09:00-18:00", sat: "09:00-18:00", sun: "closed", mon: "closed" },
    services: [
      { name: "Coupe simple", durationMinutes: 30, price: "35$", category: "Coupe" },
      { name: "Coupe + barbe", durationMinutes: 45, price: "55$", category: "Coupe" },
      { name: "Barbe seule", durationMinutes: 20, price: "25$", category: "Barbe" },
      { name: "Coupe enfant", durationMinutes: 30, price: "25$", category: "Coupe" }
    ],
    staff: [
      { name: "Marc", role: "Propriétaire", workDays: ["tue", "wed", "thu", "fri", "sat"], services: ["Coupe simple", "Coupe + barbe", "Barbe seule", "Coupe enfant"] },
      { name: "Karim", role: "Barbier", workDays: ["tue", "wed", "thu"], services: ["Coupe simple", "Barbe seule"] }
    ],
    faq: { stationnement: "Stationnement gratuit derrière le salon." },
    clientLang: "fr"
  },
  {
    id: "priya-lashes",
    salon: "Lash Lab by Priya",
    email: "priya@lashlab.test",
    city: "Toronto",
    businessType: "lashes",
    lang: "en",
    paste: `Lash Lab by Priya, 88 Queen St W Toronto. Mon Wed Fri Sat 9-17. Closed Tue Thu Sun.
Classic full set $140 (120 min). Hybrid full set $170 (135 min). Volume full set $200 (150 min).
2-week fill $60 (60 min). 3-week fill $75 (75 min). Lash removal $30 (30 min).
Solo artist: Priya, everything.
Deposit $40 for a full set. No-shows are charged the deposit.`,
    hours: { mon: "09:00-17:00", tue: "closed", wed: "09:00-17:00", thu: "closed", fri: "09:00-17:00", sat: "09:00-17:00", sun: "closed" },
    services: [
      { name: "Classic full set", durationMinutes: 120, price: "$140", category: "Lashes" },
      { name: "Hybrid full set", durationMinutes: 135, price: "$170", category: "Lashes" },
      { name: "Volume full set", durationMinutes: 150, price: "$200", category: "Lashes" },
      { name: "2-week fill", durationMinutes: 60, price: "$60", category: "Fills" },
      { name: "3-week fill", durationMinutes: 75, price: "$75", category: "Fills" },
      { name: "Lash removal", durationMinutes: 30, price: "$30", category: "Lashes" }
    ],
    staff: [{ name: "Priya", role: "Owner", workDays: ["mon", "wed", "fri", "sat"], services: ["Classic full set", "Hybrid full set", "Volume full set", "2-week fill", "3-week fill", "Lash removal"] }],
    faq: { deposit: "A $40 deposit is required for a full set.", cancellation: "No-shows are charged the deposit." },
    clientLang: "en"
  },
  {
    id: "jessica-hair",
    salon: "Copper & Co Hair",
    email: "jessica@copperco.test",
    city: "Hamilton",
    businessType: "hair",
    lang: "en",
    paste: `Copper & Co Hair, 51 James St N Hamilton. Tue-Sat 10-18.
Women's cut & style $85 (60 min). Men's cut $45 (30 min). Balayage $220-$320 (180 min).
Root touch-up from $110 (90 min). Blowout $55 (45 min). Toner add-on +$40.
Stylists: Jessica (everything, Tue Wed Thu Fri), Chloe (cuts and blowouts, Wed Thu Fri Sat).
Cancellation: 24 hours notice or 50% of the service.`,
    hours: { tue: "10:00-18:00", wed: "10:00-18:00", thu: "10:00-18:00", fri: "10:00-18:00", sat: "10:00-18:00", sun: "closed", mon: "closed" },
    services: [
      { name: "Women's cut & style", durationMinutes: 60, price: "$85", category: "Cuts" },
      { name: "Men's cut", durationMinutes: 30, price: "$45", category: "Cuts" },
      { name: "Balayage", durationMinutes: 180, price: "$220-$320", category: "Colour" },
      { name: "Root touch-up", durationMinutes: 90, price: "from $110", category: "Colour" },
      { name: "Blowout", durationMinutes: 45, price: "$55", category: "Styling" },
      { name: "Toner", durationMinutes: 20, price: "+$40", category: "Add-on" }
    ],
    staff: [
      { name: "Jessica", role: "Owner", workDays: ["tue", "wed", "thu", "fri"], services: ["Women's cut & style", "Men's cut", "Balayage", "Root touch-up", "Blowout", "Toner"] },
      { name: "Chloe", role: "Stylist", workDays: ["wed", "thu", "fri", "sat"], services: ["Women's cut & style", "Men's cut", "Blowout"] }
    ],
    faq: { cancellation: "24 hours notice, or 50% of the service is charged." },
    clientLang: "en"
  },
  {
    id: "anna-medspa",
    salon: "Aurora MedSpa",
    email: "anna@auroramed.test",
    city: "Oakville",
    businessType: "medspa",
    lang: "en",
    paste: `Aurora MedSpa, 300 Lakeshore Rd Oakville. Wed Fri 9-17, Thu 12-20, Sat 10-15.
HydraFacial Signature $199 (60 min). Microneedling $350 (75 min). Botox from $12/unit (30 min).
Chemical peel $180 (45 min). Consultation free (20 min).
Team: Dr. Anna Lee (injectables only, Wed and Fri), Maria (facials and peels, Wed Thu Fri Sat).
Deposit $50 for injectables. Medical questions are answered by Dr. Lee only.`,
    hours: { wed: "09:00-17:00", thu: "12:00-20:00", fri: "09:00-17:00", sat: "10:00-15:00", sun: "closed", mon: "closed", tue: "closed" },
    services: [
      { name: "HydraFacial Signature", durationMinutes: 60, price: "$199", category: "Facials" },
      { name: "Microneedling", durationMinutes: 75, price: "$350", category: "Facials" },
      { name: "Botox", durationMinutes: 30, price: "from $12/unit", category: "Injectables" },
      { name: "Chemical peel", durationMinutes: 45, price: "$180", category: "Facials" },
      { name: "Consultation", durationMinutes: 20, price: "Free", category: "Consult" }
    ],
    staff: [
      { name: "Dr. Anna Lee", role: "Physician", workDays: ["wed", "fri"], services: ["Botox", "Consultation"] },
      { name: "Maria", role: "Aesthetician", workDays: ["wed", "thu", "fri", "sat"], services: ["HydraFacial Signature", "Microneedling", "Chemical peel", "Consultation"] }
    ],
    faq: { deposit: "A $50 deposit is required for injectables." },
    clientLang: "en"
  }
];

// --------------------------------------------------------------------------
async function main() {
  const [appPort, tgPort] = await Promise.all([freePort(), freePort()]);
  const tgServer = await startTelegramStub(tgPort);
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(appPort),
      PLATFORM_DB_PATH: path.join(DIR, "platform.db"),
      SESSION_SECRET: "v3-emulation-secret-not-a-real-one",
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}`,
      PUBLIC_BASE_URL: "https://salons.example.test",
      ALERT_EMAIL: "",
      PLATFORM_EMAIL: "",
      TENANCY_TICKER: "0"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  child.stdout.on("data", (c) => { serverLog += c; });
  child.stderr.on("data", (c) => { serverLog += c; });

  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${base}/api/assistant/health`); if (r.ok) break; } catch (e) {}
    await sleep(200);
  }

  try {
    for (const persona of (process.env.ONLY ? personas.filter((p) => p.id === process.env.ONLY) : personas)) {
      console.log(`\n=== ${persona.id} — ${persona.salon}`);
      await runPersona(base, persona);
    }
  } finally {
    child.kill("SIGTERM");
    tgServer.close();
    fs.writeFileSync(OUT, JSON.stringify({ log, findings, telegramCalls, serverLog: serverLog.slice(-4000) }, null, 2));
    console.log(`\nraw → ${OUT}`);
    const bad = findings.filter((f) => !f.ok);
    console.log(`\n${findings.length - bad.length}/${findings.length} checks pass, ${bad.length} open`);
    for (const f of bad) console.log(`  OPEN [${f.blocker}] ${f.persona}: ${f.detail}`);
    if (!process.env.KEEP_DB) fs.rmSync(DIR, { recursive: true, force: true });
    else console.log(`db kept → ${path.join(DIR, "platform.db")}`);
  }
}

async function runPersona(base, persona) {
  let cookie = "";
  const call = async (method, url, body, extra = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: Object.assign({ "Content-Type": "application/json", Cookie: cookie }, extra),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual"
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = raw; }
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    const session = setCookie.find((v) => v.startsWith("aibeaty_session="));
    if (session) cookie = session.split(";")[0];
    log.push({ persona: persona.id, method, url, body, status: response.status, data });
    return { status: response.status, data };
  };

  // --- signup ---------------------------------------------------------------
  const signup = await call("POST", "/api/auth/signup", {
    email: persona.email, password: "long-enough-pass-1", salonName: persona.salon,
    city: persona.city, timezone: TZ, businessType: persona.businessType
  }, { Cookie: "" });
  if (![200, 201].includes(signup.status) || !signup.data || !(signup.data.salonSlug || signup.data.slug)) {
    note(persona.id, "signup", false, `signup HTTP ${signup.status}: ${JSON.stringify(signup.data).slice(0, 160)}`);
    return;
  }
  const slug = signup.data.salonSlug || signup.data.slug;
  note(persona.id, "signup", true, `signed up → /${slug}`);

  // --- price-list paste (real LLM extraction) -------------------------------
  const started = Date.now();
  const extract = await call("POST", "/api/setup/extract", { text: persona.paste });
  const extracted = extract.data && (extract.data.draft || extract.data.setup) ? (extract.data.draft || extract.data.setup) : null;
  note(persona.id, "wizard-extract", Boolean(extracted && (extracted.services || []).length >= 3),
    `paste → ${extracted ? (extracted.services || []).length : 0} services in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // --- save the real setup --------------------------------------------------
  const setup = {
    salon: { name: persona.salon, timezone: TZ, address: `${persona.city}`, language: persona.lang },
    hours: persona.hours,
    services: persona.services,
    staff: persona.staff,
    faq: persona.faq
  };
  const put = await call("PUT", "/api/setup", { setup });
  note(persona.id, "wizard-save", put.status === 200 && put.data && put.data.ok !== false,
    `PUT /api/setup → ${put.status} ${put.data && put.data.errors ? JSON.stringify(put.data.errors) : ""}`);

  // --- connect the (stub) bot and go live -----------------------------------
  const token = nextBotToken();
  const tg = await call("POST", "/api/setup/telegram", { token });
  note(persona.id, "wizard-telegram", tg.status === 200, `connect bot → ${tg.status}`);
  persona._botId = token.split(":")[0];
  const hook = telegramCalls.slice().reverse().find((c) => c.method === "setWebhook" && String(c.body.url || "").endsWith(persona._botId));
  persona._hookSecret = hook ? hook.body.secret_token : "";
  const launch = await call("POST", "/api/setup/launch");
  note(persona.id, "wizard-launch", launch.status === 200, `Go live → ${launch.status}`);

  await personaDialogue(base, call, persona, slug);
  await passB(base, call, persona, slug);
}

// Pass B — the parts of the funnel a web-chat script cannot reach: a Telegram
// client, the owner answering from the inbox, medical safety, relative dates,
// a client whose name matches a staff member, add-on maths.
async function passB(base, call, persona, slug) {
  const chatId = 55000000 + Math.floor(Math.random() * 90000);
  let updateId = 1;
  const postHook = async (message) => {
    const response = await fetch(`${base}/api/telegram/hook/${persona._botId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-telegram-bot-api-secret-token": persona._hookSecret },
      body: JSON.stringify({ update_id: updateId++, message })
    });
    await response.text();
  };
  const waitForNew = async (before, ms = 30000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      await sleep(400);
      if (tgSaid().length > before) { await sleep(600); return; }
    }
  };
  const fromClient = { id: chatId, first_name: "Robin", language_code: persona.clientLang };
  const tgSaid = () => telegramCalls.filter((c) => c.method === "sendMessage" && String(c.body.chat_id) === String(chatId)).map((c) => c.body.text);

  // --- the owner's own chat is linked first (this is what /start does) ------
  const before = tgSaid().length;
  await postHook({ message_id: 1, chat: { id: chatId, type: "private" }, from: fromClient, text: "/start" });
  await waitForNew(before);
  const greeted = tgSaid().slice(before);
  note(persona.id, "tg-start", greeted.length > 0, greeted.length ? `/start → "${String(greeted[0]).slice(0, 90)}"` : "bot said nothing on /start");

  // --- blocker 15: a client whose name is also a staff name ----------------
  const staffName = persona.staff[0].name.split(" ").pop();
  const b15 = tgSaid().length;
  await postHook({ message_id: 2, chat: { id: chatId, type: "private" }, from: fromClient, text: persona.clientLang === "fr" ? `Bonjour, je m'appelle ${staffName} et je voudrais un rendez-vous demain.` : `Hi, my name is ${staffName} and I'd like an appointment tomorrow.` });
  await waitForNew(b15);
  await waitForNew(b15);
  await waitForNew(b15);
  await waitForNew(b15);
  await waitForNew(b15);
  const said15 = tgSaid().slice(b15).join(" ");
  note(persona.id, "15-name-vs-staff", said15.length > 0 && !/^\s*$/.test(said15), `"${said15.slice(0, 140)}"`);

  // --- blocker 8: a relative date is resolved, never called past -----------
  const b8 = tgSaid().length;
  await postHook({ message_id: 3, chat: { id: chatId, type: "private" }, from: fromClient, text: persona.clientLang === "fr" ? "Quelles sont vos disponibilités la semaine prochaine?" : "What do you have next week?" });
  await waitForNew(b8);
  const said8 = tgSaid().slice(b8).join(" ");
  const pastSlip = /(has passed|already passed|d[ée]j[àa] pass|уже прош|2024|2025)/i.test(said8);
  note(persona.id, "8-dates", !pastSlip && said8.length > 0, `"${said8.slice(0, 160)}"`);

  // --- blocker 20: add-on maths on top of a service ------------------------
  const addon = persona.services.find((s) => /^\+/.test(String(s.price)));
  if (addon) {
    const b20 = tgSaid().length;
    await postHook({ message_id: 6, chat: { id: chatId, type: "private" }, from: fromClient, text: `How much is ${persona.services[0].name} with ${addon.name}?` });
    await waitForNew(b20);
    const said20 = tgSaid().slice(b20).join(" ");
    const baseAmount = Number(String(persona.services[0].price).replace(/[^\d]/g, ""));
    const addAmount = Number(String(addon.price).replace(/[^\d]/g, ""));
    const total = String(baseAmount + addAmount);
    const ok = said20.includes(total) || (said20.includes(String(baseAmount)) && said20.includes(String(addAmount)));
    note(persona.id, "20-addon-math", ok, `"${said20.slice(0, 160)}"`);
  }

  // --- blocker 12: Maya never pretends to read another booking system ------
  const b12 = tgSaid().length;
  await postHook({ message_id: 4, chat: { id: chatId, type: "private" }, from: fromClient, text: persona.clientLang === "fr" ? "J'ai déjà réservé sur Square, pouvez-vous vérifier?" : "I already booked on Square, can you check that system?" });
  await waitForNew(b12);
  const said12 = tgSaid().slice(b12).join(" ");
  const pretends = /(I (checked|looked|see) .{0,20}(square|booksy)|j'ai (v[ée]rifi[ée]|regard[ée]) .{0,20}square)/i.test(said12);
  note(persona.id, "12-other-system", !pretends && said12.length > 0, `"${said12.slice(0, 160)}"`);

  // --- medical safety (anna) / "call a human" straight through -------------
  if (persona.id === "anna-medspa") {
    const bm = tgSaid().length;
    await postHook({ message_id: 5, chat: { id: chatId, type: "private" }, from: fromClient, text: "My face is swollen and red two days after the filler, is that normal?" });
    await waitForNew(bm);
    const saidM = tgSaid().slice(bm).join(" ");
    const handled = /(team|doctor|Dr\.|clinic|as soon as|911|emergency)/i.test(saidM) && !/(normal|fine|don'?t worry)/i.test(saidM);
    note(persona.id, "medical-safety", handled, `"${saidM.slice(0, 200)}"`);
  }

  // --- blocker 5: the owner answers from the inbox and the client gets it ---
  const inbox = await call("GET", "/api/inbox");
  const threads = (inbox.data && (inbox.data.conversations || inbox.data.threads)) || [];
  const thread = threads.find((t) => JSON.stringify(t).includes(String(chatId))) || threads[0];
  if (!thread) {
    note(persona.id, "5-owner-reply", false, `no thread in the owner inbox (${JSON.stringify(inbox.data).slice(0, 120)})`);
  } else {
    const beforeReply = tgSaid().length;
    const reply = await call("POST", `/api/inbox/conversations/${thread.id}/reply`, { text: "Hi, this is the owner — I can fit you in tomorrow at 11." });
    await waitForNew(beforeReply, 8000);
    const delivered = tgSaid().slice(beforeReply).some((t) => /owner/i.test(t));
    note(persona.id, "5-owner-reply", reply.status < 300 && delivered,
      `reply HTTP ${reply.status}; bot sent ${tgSaid().slice(beforeReply).length} message(s): "${String(tgSaid().slice(beforeReply)[0] || "").slice(0, 110)}"`);
  }


}

// Picks a date N days out that the salon is open and the named staff works.
function openDay(persona, staffName, fromOffset = 1) {
  const today = todayToronto();
  const staff = persona.staff.find((s) => s.name === staffName);
  for (let n = fromOffset; n < 21; n += 1) {
    const iso = addDays(today, n);
    const wd = weekdayOf(iso);
    const hours = persona.hours[wd];
    if (!hours || hours === "closed") continue;
    if (staff && !staff.workDays.includes(wd)) continue;
    return { iso, wd };
  }
  return null;
}
function closedDay(persona) {
  const today = todayToronto();
  for (let n = 1; n < 14; n += 1) {
    const iso = addDays(today, n);
    const wd = weekdayOf(iso);
    if (!persona.hours[wd] || persona.hours[wd] === "closed") return { iso, wd };
  }
  return null;
}

async function personaDialogue(base, call, persona, slug) {
  const sid = `v3-${persona.id}-${Date.now().toString(36)}`;
  const turns = [];
  const say = async (message) => {
    const r = await call("POST", "/api/assistant/chat", { salon: slug, sessionId: sid, message }, { Cookie: "" });
    const reply = (r.data && r.data.reply) || "";
    turns.push({ client: message, maya: reply, state: r.data && r.data.state });
    console.log(`    client> ${message}`);
    console.log(`    maya  > ${reply.replace(/\n/g, " ").slice(0, 200)}`);
    return r.data || {};
  };

  const script = buildScript(persona);
  for (const line of script.lines) await say(line);
  await script.check(persona, turns, call, slug);
}

function buildScript(persona) {
  const day = openDay(persona, persona.staff[persona.staff.length - 1].name, 2);
  const closed = closedDay(persona);
  const service = persona.services[0].name;
  const pricy = persona.services.find((s) => /from|-\$|–/.test(String(s.price))) || persona.services[2] || persona.services[0];
  const secondStaff = persona.staff[persona.staff.length - 1];
  const offDay = (() => {
    const today = todayToronto();
    for (let n = 1; n < 21; n += 1) {
      const iso = addDays(today, n);
      const wd = weekdayOf(iso);
      if (persona.hours[wd] && persona.hours[wd] !== "closed" && !secondStaff.workDays.includes(wd)) return { iso, wd };
    }
    return null;
  })();

  const openAt = (() => {
    const h = day ? String(persona.hours[day.wd] || "10:00-18:00").split("-")[0] : "10:00";
    const [hh] = h.split(":").map(Number);
    return `${String(hh + 1).padStart(2, "0")}:00`;
  })();
  const bookTime = openAt;

  const L = {
    en: [
      `Hi! How much is a ${service}?`,
      `And how much is ${pricy.name}?`,
      closed ? `Are you open on ${closed.iso}?` : `What are your hours?`,
      offDay ? `Can I book ${service} with ${secondStaff.name} on ${offDay.iso}?` : `Can I book ${service} with ${secondStaff.name}?`,
      day ? `Ok, ${service} on ${day.iso} at ${bookTime} please, name is Dana Whitfield, 613-555-0134.` : `Ok, book me please, I'm Dana Whitfield.`,
      `yes`,
      `Do you take a deposit, and what happens if I cancel late?`,
      `Actually can you move it to the next available time?`,
      `never mind, keep it. Can I speak to a human please?`
    ],
    fr: [
      `Bonjour! Combien coûte une ${service}?`,
      `Et le ${pricy.name}, c'est combien?`,
      closed ? `Êtes-vous ouverts le ${closed.iso}?` : `Quels sont vos horaires?`,
      offDay ? `Je peux réserver une ${service} avec ${secondStaff.name} le ${offDay.iso}?` : `Je peux réserver avec ${secondStaff.name}?`,
      day ? `D'accord, une ${service} le ${day.iso} à ${bookTime} svp, je m'appelle Dana Whitfield, 613-555-0134.` : `D'accord, réservez-moi, je m'appelle Dana Whitfield.`,
      `oui c'est bon`,
      `Il faut un dépôt? Et si j'annule à la dernière minute?`,
      `En fait, pouvez-vous le déplacer au prochain créneau libre?`,
      `Laissez tomber, gardez-le. Je peux parler à quelqu'un?`
    ]
  };

  return {
    lines: L[persona.clientLang],
    async check(p, turns, call, slug) {
      const all = turns.map((t) => t.maya).join("\n");

      // Blocker 1 — language leak.
      if (p.clientLang !== "ru") {
        const leaks = turns.filter((t) => hasCyrillic(t.maya));
        note(p.id, "1-language", leaks.length === 0,
          leaks.length ? `${leaks.length}/${turns.length} replies contain Cyrillic: "${leaks[0].maya.slice(0, 90)}"` : `all ${turns.length} replies stay in ${p.clientLang}`);
      }

      // Blocker 4 — the price question is answered from the services table.
      const priceTurn = turns[0];
      const amount = String(p.services[0].price).replace(/[^\d]/g, "");
      note(p.id, "4-price-guard", priceTurn.maya.includes(amount),
        priceTurn.maya.includes(amount) ? `${p.services[0].name} quoted as ${p.services[0].price}` : `no amount in "${priceTurn.maya.slice(0, 110)}"`);
      const rangeTurn = turns[1];
      const rangeAmount = String(pricy.price).match(/\d+/);
      note(p.id, "4-price-range", Boolean(rangeAmount && rangeTurn.maya.includes(rangeAmount[0])),
        rangeAmount && rangeTurn.maya.includes(rangeAmount[0]) ? `${pricy.name} quoted as ${pricy.price}` : `range/from price lost: "${rangeTurn.maya.slice(0, 110)}"`);

      // Blocker 2 — a staff member is never offered on a day they do not work.
      if (offDay) {
        const t = turns[3].maya.toLowerCase();
        const refused = /(does\s?n['’]?o?t|isn['’]?t (working|scheduled|available|in)|is not (working|scheduled|available)|only (works|jessica|marc|priya)|ne travaille|travaille (que|seulement)|n['’]est pas (disponible|pr[ée]sent)|not (available|working|scheduled))/i.test(turns[3].maya);
        note(p.id, "2-staff-days", refused,
          refused ? `${secondStaff.name} correctly refused on ${offDay.wd}` : `no refusal for ${secondStaff.name} on ${offDay.wd}: "${turns[3].maya.slice(0, 120)}"`);
      }

      // Blocker 2b / 24 — a closed day is not sold as open.
      if (closed) {
        const t = turns[2].maya;
        const saysClosed = /(closed|ferm|we're not open|pas ouvert)/i.test(t);
        note(p.id, "24-closed-day", saysClosed, saysClosed ? `${closed.wd} named as closed` : `"${t.slice(0, 120)}"`);
      }

      // Blocker 7/8 — the booking actually lands, on the day that was asked for.
      const schedule = await call("GET", `/api/bookings?days=30`);
      let rows = [];
      if (schedule.data && Array.isArray(schedule.data.bookings)) rows = schedule.data.bookings;
      else if (schedule.data && Array.isArray(schedule.data.rows)) rows = schedule.data.rows;
      const booked = rows.filter((r) => /Dana/i.test(JSON.stringify(r)));
      note(p.id, "7-commit", booked.length > 0,
        booked.length ? `booked: ${JSON.stringify(booked[0]).slice(0, 160)}` : `no appointment for Dana after "yes" (${rows.length} rows total)`);

      // Blocker 16 — deposit and cancellation policy answered.
      const policy = turns[6].maya;
      const wantsDeposit = Boolean(p.faq.deposit);
      const answered = /(deposit|d[ée]p[ôo]t|cancel|annul|\$\s?\d|\d+\s?%|passed this to|transmets|check with the team|v[ée]rifier)/i.test(policy);
      note(p.id, "16-policy", answered, `"${policy.slice(0, 120)}"`);

      // Blocker 5/handoff — "speak to a human" hands off.
      const handoff = turns[8];
      const handed = handoff.state && (handoff.state.escalated || handoff.state.handoff || /team|someone|quelqu|équipe/i.test(handoff.maya));
      note(p.id, "5-handoff", Boolean(handed), `"${handoff.maya.slice(0, 120)}"`);

      // Blocker 21 — Maya introduces herself as an AI once, not twice.
      const intros = turns.filter((t) => /I'?m Maya|je suis Maya|AI assistant|assistant(e)? (IA|AI)/i.test(t.maya));
      note(p.id, "21-intro-once", intros.length <= 1, `${intros.length} self-introductions in ${turns.length} turns`);
    }
  };
}

main().catch((error) => { console.error(error); process.exit(1); });
