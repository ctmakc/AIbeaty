#!/usr/bin/env node
// Plans & payment (wizard step 7), price texts in the services step, and the
// wizard's defaults — unit checks plus two real servers:
//   1. no Stripe env: plan request → pending_payment, trial +7 days, platform
//      notification, `scripts/tenants.mjs activate` switches the plan on;
//   2. Stripe env pointing at a local stub: Checkout session + signed webhook.
//
// Run: node apps/platform/tests/billing-wizard.test.js
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const SCRIPT = path.join(REPO_ROOT, "scripts/tenants.mjs");
const billing = require("../backend/billing");
const { normalizeSetup, validateSetup, setupToStore, parsePriceText, emptySetup } = require("../backend/tenancy");

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

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

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(raw));
  });
}

function startLlmStub(port) {
  const server = http.createServer(async (request, response) => {
    await readBody(request);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hello! How can I help?" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const stripeCalls = [];
function startStripeStub(port) {
  const server = http.createServer(async (request, response) => {
    const raw = await readBody(request);
    stripeCalls.push({ url: request.url, auth: request.headers.authorization, form: new URLSearchParams(raw) });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/c/cs_test_1" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function startServer(env) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, {
      PORT: String(port),
      SESSION_SECRET: "billing-test-secret",
      LLM_API_KEY: "stub",
      LLM_MODEL: "stub-model",
      TELEGRAM_API_BASE: "http://127.0.0.1:9",
      PUBLIC_BASE_URL: "https://salons.example.test",
      ALERT_EMAIL: "",
      PLATFORM_EMAIL: "",
      TENANCY_TICKER: "0",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: ""
    }, env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const state = { log: "" };
  child.stdout.on("data", (chunk) => { state.log += chunk; });
  child.stderr.on("data", (chunk) => { state.log += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/assistant/health`)).ok) break;
    } catch (error) { /* not up */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  let cookie = "";
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: Object.assign({ "Content-Type": "application/json", Cookie: cookie }, headers),
      body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
      redirect: "manual"
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (error) { data = text; }
    if (response.headers.get("set-cookie")) cookie = String(response.headers.get("set-cookie")).split(";")[0];
    return { status: response.status, data };
  };
  return { base, child, state, call };
}

const COMPLETE_SERVICES = [
  { name: "Colour correction consultation", durationMinutes: 30, price: "Free" },
  { name: "Balayage", durationMinutes: 180, price: "$220–$320" },
  { name: "Women's cut & style", durationMinutes: 60, price: "from $75" },
  { name: "Toner add-on", durationMinutes: 15, price: "+$15" },
  { name: "Nail art", durationMinutes: 20, price: "$5/nail" },
  { name: "Dermal filler", durationMinutes: 45, price: "", consultOnly: true },
  { name: "Brow lamination", durationMinutes: 60, price: "By consultation" }
];

async function unitChecks() {
  await check("price texts owners actually write are accepted", () => {
    ["Free", "Complimentary", "By consultation", "Price on request", "Sur consultation", "Gratuit", "$220–$320", "220-320", "from $75", "à partir de 75 $", "$75+", "+$15", "$5/nail", "$5 per nail", "$65", "65", "65,00 $", "$45 (add-on with any colour service)"].forEach((text) => {
      assert.ok(parsePriceText(text).ok, text);
    });
    assert.strictEqual(parsePriceText("$220–$320").kind, "range");
    assert.strictEqual(parsePriceText("$220–$320").value, 220);
    assert.strictEqual(parsePriceText("from $75").kind, "from");
    assert.strictEqual(parsePriceText("+$15").kind, "addon");
    assert.strictEqual(parsePriceText("$5/nail").kind, "per_unit");
    assert.strictEqual(parsePriceText("Free").value, 0);
    ["", "?", "tbd", "-"].forEach((text) => assert.ok(!parsePriceText(text).ok, `rejects ${JSON.stringify(text)}`));
  });

  await check("the services step keeps 60 characters of price and quotes it verbatim", () => {
    const long = "$45 (add-on with any colour service, toner included)";
    const doc = normalizeSetup({
      salon: { name: "Maison", timezone: "America/Toronto" },
      hours: { tue: "10:00-19:00" },
      services: COMPLETE_SERVICES.concat([{ name: "Gloss", durationMinutes: 30, price: long }]),
      staff: [{ name: "Chloé", workDays: ["tue"] }]
    });
    assert.strictEqual(doc.services[7].price, long, "not cut at 30 characters");
    const { errors } = validateSetup(doc, "en");
    assert.deepStrictEqual(errors, []);
    const store = setupToStore(doc);
    const byName = Object.fromEntries(store.categories.flatMap((category) => category.services).map((service) => [service.name, service]));
    assert.strictEqual(byName.Balayage.priceLabel, "$220–$320");
    assert.strictEqual(byName.Balayage.priceValue, 220);
    assert.strictEqual(byName["Colour correction consultation"].priceLabel, "Free");
    assert.strictEqual(byName["Women's cut & style"].priceLabel, "from $75");
    assert.strictEqual(byName["Toner add-on"].priceLabel, "+$15");
    assert.strictEqual(byName["Nail art"].priceLabel, "$5/nail");
    assert.strictEqual(byName["Dermal filler"].priceLabel, "By consultation");
    assert.strictEqual(byName["Dermal filler"].priceValue, 0);
    assert.match(byName["Dermal filler"].description, /Consultation only/);
    assert.ok(store.topics.some((topic) => topic.id === "consultation_only" && /Dermal filler/.test(topic.en)));
  });

  await check("an empty or unreadable price explains itself in the owner's language", () => {
    const doc = normalizeSetup({ salon: { name: "X", timezone: "America/Toronto" }, hours: { tue: "10-19" }, services: [{ name: "Cut", durationMinutes: 30, price: "" }, { name: "Dye", durationMinutes: 30, price: "??" }], staff: [{ name: "A", workDays: ["tue"] }] });
    const en = validateSetup(doc, "en").errors;
    assert.deepStrictEqual(en.map((error) => error.field), ["services.0.price", "services.1.price"]);
    assert.match(en[0].message, /Consultation only/);
    const fr = validateSetup(doc, "fr").errors;
    assert.match(fr[1].message, /illisible/);
  });

  await check("a new salon starts with the owner as its first team member on the open days", () => {
    const setup = emptySetup({ salonName: "Lash by Priya", ownerName: "Priya", businessType: "lashes_brows", language: "en" });
    assert.strictEqual(setup.staff.length, 1);
    assert.strictEqual(setup.staff[0].name, "Priya");
    assert.deepStrictEqual(setup.staff[0].workDays, ["tue", "wed", "thu", "fri", "sat"]);
    assert.strictEqual(setup.assistant.forbidden, "");
    const clinic = emptySetup({ salonName: "Lumière", ownerName: "Grace", businessType: "medspa", language: "fr" });
    assert.match(clinic.assistant.forbidden, /grossesse/);
    assert.strictEqual(clinic.assistant.healthPrivacy, true);
    const store = setupToStore(normalizeSetup(Object.assign(clinic, { services: [{ name: "Botox", durationMinutes: 30, consultOnly: true }] })));
    assert.ok(store.topics.some((topic) => topic.id === "medical_questions"));
  });

  await check("plan math: CAD per month, add-ons on top, annual = 10 months", () => {
    assert.deepStrictEqual(billing.PLANS.map((plan) => [plan.key, plan.price, plan.staffLimit]), [["solo", 39, 1], ["salon", 79, 6], ["pro", 149, null]]);
    assert.deepStrictEqual(billing.PAID_ADDONS.map((addon) => [addon.key, addon.price]), [["instagram_dm", 29], ["whatsapp", 29], ["calendar_sync", 29], ["sms_reminders", 19]]);
    const q = billing.quote("salon", ["instagram_dm", "sms_reminders", "instagram_dm", "nope"], "monthly");
    assert.strictEqual(q.monthly, 127);
    assert.strictEqual(q.total, 127);
    assert.deepStrictEqual(q.addons.map((addon) => addon.key), ["instagram_dm", "sms_reminders"]);
    const annual = billing.quote("solo", [], "annual");
    assert.strictEqual(annual.total, 390);
    assert.strictEqual(annual.annualSaving, 78);
    assert.strictEqual(billing.quote("gold"), null);
    assert.strictEqual(billing.suggestPlan(1, "nails"), "solo");
    assert.strictEqual(billing.suggestPlan(4, "hair"), "salon");
    assert.strictEqual(billing.suggestPlan(9, "hair"), "pro");
    assert.strictEqual(billing.suggestPlan(2, "medspa"), "pro");
  });

  await check("Stripe stays off without keys and verifies webhook signatures", () => {
    assert.strictEqual(billing.stripeEnabled({}), false);
    assert.strictEqual(billing.stripeEnabled({ STRIPE_SECRET_KEY: "sk" }), false, "a key alone is not enough");
    assert.strictEqual(billing.stripeEnabled({ STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_SALON: "price_1" }), true);
    assert.strictEqual(billing.stripeLineItems(billing.quote("salon", ["whatsapp"]), { STRIPE_SECRET_KEY: "sk", STRIPE_PRICE_SALON: "price_1" }), null, "an add-on without a price id falls back to the invoice");
    const secret = "whsec_test";
    const body = JSON.stringify({ type: "ping" });
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    assert.ok(billing.verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, { now }));
    assert.ok(!billing.verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, { now }));
    assert.ok(!billing.verifyStripeSignature(body, `t=${t},v1=${sig}`, "other", { now }));
    assert.ok(!billing.verifyStripeSignature(body, `t=${t - 3600},v1=${crypto.createHmac("sha256", secret).update(`${t - 3600}.${body}`).digest("hex")}`, secret, { now }), "old events are refused");
  });
}

async function invoiceFlow(llmPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-billing-"));
  const dbPath = path.join(dir, "platform.db");
  const server = await startServer({ PLATFORM_DB_PATH: dbPath, LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1` });
  const { call } = server;
  try {
    let slug = "";
    await check("sign-up in French for a medspa: owner pre-filled, clinic topics, language kept", async () => {
      const result = await call("POST", "/api/auth/signup", { email: "grace@lumiere.test", password: "long-enough-pass-1", salonName: "Lumière Aesthetics", ownerName: "Grace Park", city: "Ottawa", timezone: "America/Toronto", businessType: "medspa", language: "fr" });
      assert.strictEqual(result.status, 201, JSON.stringify(result.data));
      slug = result.data.salonSlug;
      const setup = await call("GET", "/api/setup");
      assert.strictEqual(setup.data.tenant.language, "fr");
      assert.strictEqual(setup.data.tenant.businessType, "medspa");
      assert.strictEqual(setup.data.tenant.planStatus, "trial");
      assert.strictEqual(setup.data.setup.staff[0].name, "Grace Park");
      assert.strictEqual(setup.data.setup.staff[0].role, "Propriétaire");
      assert.match(setup.data.setup.assistant.forbidden, /grossesse/);
      assert.strictEqual(setup.data.publicChatUrl, `https://salons.example.test/screens/chat.html?salon=${slug}`);
      const ready = setup.data.addons.find((addon) => addon.key === "website_widget");
      assert.strictEqual(ready.status, "ready", "the chat link is not 'active' before Go live");
    });

    await check("French validation messages come back for a French owner", async () => {
      const result = await call("PUT", "/api/setup", { setup: { salon: { name: "Lumière Aesthetics", timezone: "America/Toronto" }, hours: { tue: "10-19" }, services: [{ name: "HydraFacial", durationMinutes: 60, price: "" }], staff: [{ name: "Grace Park", workDays: ["tue"] }] } });
      assert.strictEqual(result.status, 422);
      assert.match(result.data.errors[0].message, /Ajoutez un prix/);
    });

    await check("the services step saves ranges, 'from', add-on, per-unit, Free and consult-only prices", async () => {
      const result = await call("PUT", "/api/setup", { setup: {
        salon: { name: "Lumière Aesthetics", timezone: "America/Toronto" },
        hours: { tue: "10:00-19:00", wed: "10:00-19:00" },
        services: COMPLETE_SERVICES,
        staff: [{ name: "Grace Park", workDays: ["tue", "wed"] }],
        assistant: { forbidden: "Medical advice", healthPrivacy: true }
      } });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      const health = await call("GET", `/api/assistant/health?salon=${slug}`, undefined, { Cookie: "" });
      assert.deepStrictEqual(health.data.highlights.map((entry) => [entry.name, entry.price]), [["Colour correction consultation", "Free"], ["Balayage", "$220–$320"], ["Women's cut & style", "from $75"]]);
    });

    await check("the owner can switch the UI language, and it sticks on the tenant", async () => {
      const result = await call("PUT", "/api/setup/language", { language: "en" });
      assert.strictEqual(result.data.language, "en");
      const again = await call("PUT", "/api/setup/language", { language: "uk" });
      assert.strictEqual(again.data.language, "ru", "Ukrainian browsers get the Russian UI");
      await call("PUT", "/api/setup/language", { language: "en" });
    });

    await check("step 7 lists the three plans and four add-ons, invoice mode without Stripe", async () => {
      const plan = await call("GET", "/api/setup/plan");
      assert.strictEqual(plan.status, 200);
      assert.deepStrictEqual(plan.data.plans.map((entry) => entry.price), [39, 79, 149]);
      assert.deepStrictEqual(plan.data.addons.map((entry) => entry.price), [29, 29, 29, 19]);
      assert.strictEqual(plan.data.checkout, "invoice");
      assert.strictEqual(plan.data.status, "trial");
      assert.strictEqual(plan.data.suggested, "pro", "a medspa is pointed at Pro");
      assert.strictEqual(plan.data.seller, "INNOVA CONSULT LTD");
    });

    await check("an unknown plan is refused", async () => {
      const result = await call("POST", "/api/setup/plan", { plan: "gold" });
      assert.strictEqual(result.status, 422);
    });

    let trialEndsBefore = "";
    await check("Continue with Salon: pending payment, trial +7 days once, we are notified with the total", async () => {
      trialEndsBefore = (await call("GET", "/api/setup")).data.tenant.trialEndsAt;
      const result = await call("POST", "/api/setup/plan", { plan: "salon", addons: ["instagram_dm", "sms_reminders"], cycle: "monthly" });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.quote.monthly, 127);
      assert.strictEqual(result.data.checkoutUrl, "");
      assert.strictEqual(result.data.extended, true);
      const days = (new Date(result.data.trialEndsAt) - new Date(trialEndsBefore)) / 86400000;
      assert.strictEqual(Math.round(days), 7);
      const state = await call("GET", "/api/setup");
      assert.strictEqual(state.data.tenant.planStatus, "pending_payment");
      assert.strictEqual(state.data.plan.choice, "salon");
      assert.deepStrictEqual(state.data.plan.chosenAddons, ["instagram_dm", "sms_reminders"]);
      const requested = Object.fromEntries(state.data.addons.map((addon) => [addon.key, addon.status]));
      assert.strictEqual(requested.instagram_dm, "requested");
      assert.strictEqual(requested.sms_reminders, "requested");
      assert.match(server.state.log, /\[platform\] AIbeaty plan request: Lumière Aesthetics — Salon \$127\/mo \+ tax/);
      assert.match(server.state.log, /Monthly total: \$127 CAD \+ tax/);
      assert.match(server.state.log, new RegExp(`node scripts/tenants.mjs activate ${slug} salon instagram_dm sms_reminders`));
      const again = await call("POST", "/api/setup/plan", { plan: "pro", addons: [] });
      assert.strictEqual(again.data.extended, false, "the trial is extended only once");
      assert.strictEqual(again.data.trialEndsAt, result.data.trialEndsAt);
      await call("POST", "/api/setup/plan", { plan: "salon", addons: ["instagram_dm", "sms_reminders"] });
    });

    await check("scripts/tenants.mjs plans prints the decided prices", async () => {
      const out = spawnSync(process.execPath, [SCRIPT, "plans"], { env: Object.assign({}, process.env, { PLATFORM_DB_PATH: dbPath }), encoding: "utf8" });
      assert.strictEqual(out.status, 0, out.stderr);
      ["$39/mo", "$79/mo", "$149/mo", "+$29/mo", "+$19/mo", "INNOVA CONSULT LTD"].forEach((text) => assert.ok(out.stdout.includes(text), text));
      const pending = spawnSync(process.execPath, [SCRIPT, "pending"], { env: Object.assign({}, process.env, { PLATFORM_DB_PATH: dbPath }), encoding: "utf8" });
      assert.ok(pending.stdout.includes(`activate ${slug} salon instagram_dm sms_reminders`), pending.stdout);
    });

    await check("scripts/tenants.mjs activate switches the plan on", async () => {
      const bad = spawnSync(process.execPath, [SCRIPT, "activate", slug, "gold"], { env: Object.assign({}, process.env, { PLATFORM_DB_PATH: dbPath, SESSION_SECRET: "billing-test-secret" }), encoding: "utf8" });
      assert.strictEqual(bad.status, 2);
      const out = spawnSync(process.execPath, [SCRIPT, "activate", slug, "salon", "instagram_dm", "sms_reminders"], { env: Object.assign({}, process.env, { PLATFORM_DB_PATH: dbPath, SESSION_SECRET: "billing-test-secret", TELEGRAM_API_BASE: "http://127.0.0.1:9" }), encoding: "utf8" });
      assert.strictEqual(out.status, 0, out.stderr + out.stdout);
      assert.match(out.stdout, /Activated .*Salon \$79\/mo · Instagram Direct \+\$29\/mo · SMS reminders \+\$19\/mo = \$127 CAD\/month \+ tax/);
      const state = await call("GET", "/api/setup");
      assert.strictEqual(state.data.tenant.plan, "salon");
      assert.strictEqual(state.data.tenant.planStatus, "active");
      assert.strictEqual(state.data.tenant.active, true);
      assert.strictEqual(state.data.tenant.trialDaysLeft, null);
      const again = await call("POST", "/api/setup/plan", { plan: "solo" });
      assert.strictEqual(again.status, 409, "an active plan is not re-requested from the wizard");
    });

    await check("the Stripe webhook does not exist until Stripe is configured", async () => {
      const result = await call("POST", "/api/billing/stripe-webhook", "{}", { Cookie: "" });
      assert.strictEqual(result.status, 404);
    });
  } catch (error) {
    console.error("--- server log ---\n" + server.state.log.slice(-3000));
    throw error;
  } finally {
    server.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function stripeFlow(llmPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-stripe-"));
  const stripePort = await freePort();
  const stripe = await startStripeStub(stripePort);
  const secret = "whsec_local_test";
  const server = await startServer({
    PLATFORM_DB_PATH: path.join(dir, "platform.db"),
    LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    STRIPE_SECRET_KEY: "sk_test_local",
    STRIPE_PRICE_SOLO: "price_solo_m",
    STRIPE_PRICE_WHATSAPP: "price_wa_m",
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_API_BASE: `http://127.0.0.1:${stripePort}`
  });
  const { call } = server;
  try {
    let slug = "";
    await check("with Stripe keys set, Continue opens a Checkout session for the chosen items", async () => {
      const signup = await call("POST", "/api/auth/signup", { email: "priya@lash.test", password: "long-enough-pass-1", salonName: "Lash by Priya", ownerName: "Priya", businessType: "lashes_brows", timezone: "America/Toronto" });
      slug = signup.data.salonSlug;
      const plan = await call("GET", "/api/setup/plan");
      assert.strictEqual(plan.data.checkout, "stripe");
      const result = await call("POST", "/api/setup/plan", { plan: "solo", addons: ["whatsapp"] });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.checkoutUrl, "https://checkout.stripe.test/c/cs_test_1");
      const sent = stripeCalls[0];
      assert.strictEqual(sent.url, "/v1/checkout/sessions");
      assert.strictEqual(sent.auth, "Bearer sk_test_local");
      assert.strictEqual(sent.form.get("mode"), "subscription");
      assert.strictEqual(sent.form.get("line_items[0][price]"), "price_solo_m");
      assert.strictEqual(sent.form.get("line_items[1][price]"), "price_wa_m");
      assert.strictEqual(sent.form.get("metadata[slug]"), slug);
      assert.strictEqual(sent.form.get("client_reference_id"), slug);
    });

    await check("a signed checkout.session.completed flips the plan; a forged one is refused", async () => {
      const event = JSON.stringify({ type: "checkout.session.completed", data: { object: { client_reference_id: slug, customer: "cus_1", subscription: "sub_1", metadata: { slug, plan: "solo", addons: "whatsapp", cycle: "monthly" } } } });
      const forged = await call("POST", "/api/billing/stripe-webhook", event, { Cookie: "", "Stripe-Signature": "t=1,v1=00" });
      assert.strictEqual(forged.status, 400);
      const t = Math.floor(Date.now() / 1000);
      const signature = crypto.createHmac("sha256", secret).update(`${t}.${event}`).digest("hex");
      const result = await call("POST", "/api/billing/stripe-webhook", event, { Cookie: "", "Stripe-Signature": `t=${t},v1=${signature}` });
      assert.strictEqual(result.status, 200, JSON.stringify(result.data));
      assert.strictEqual(result.data.activated, true);
      const state = await call("GET", "/api/setup");
      assert.strictEqual(state.data.tenant.plan, "solo");
      assert.strictEqual(state.data.tenant.planStatus, "active");
    });
  } catch (error) {
    console.error("--- server log ---\n" + server.state.log.slice(-3000));
    throw error;
  } finally {
    server.child.kill();
    stripe.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const llmPort = await freePort();
  const llm = await startLlmStub(llmPort);
  try {
    await unitChecks();
    await invoiceFlow(llmPort);
    await stripeFlow(llmPort);
    console.log(`billing-wizard: ${passed} checks passed`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    llm.close();
  }
}

main();
