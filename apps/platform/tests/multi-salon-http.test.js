#!/usr/bin/env node
// Multi-salon over REAL HTTP against a REAL server process, with a REAL owner
// session — the seam where the owner-login gate and multi-salon storage meet.
//
// The bug this file exists to prevent: the gate (backend/salon-scope.js) resolves
// and authorises the salon into request.salonSlug, but the /api/platform handlers
// used to re-derive the salon from ?salon= on their own. An owner of salon B who
// simply omitted ?salon= was then served the DEFAULT salon's clients and schedule.
// Only a signed-in request with no ?salon= catches that, so that is what this asserts.
//
// Run: node apps/platform/tests/multi-salon-http.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const OWNER_CLI = path.join(REPO_ROOT, "scripts/create-owner.mjs");
const ONBOARD_CLI = path.join(REPO_ROOT, "scripts/onboard-salon.mjs");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-ms-http-"));
const TEST_DB = path.join(TEST_DIR, "platform.db");
const INTAKE_FILE = path.join(TEST_DIR, "salon-b.json");

const SALON_A = "luminous-core";
const SALON_B = "iris-http-bar";
const OWNER_A = { email: "owner-a@example.test", password: "correct-horse-battery-A1", name: "Сара" };
const OWNER_B = { email: "owner-b@example.test", password: "correct-horse-battery-B2", name: "Ирина" };

const INTAKE = {
  slug: SALON_B,
  salon: { name: "Iris HTTP Bar", city: "Оттава", timezone: "America/Toronto", phone: "(613) 555-0147" },
  hours: {
    понедельник: "выходной", вторник: "10:00-20:00", среда: "10:00-20:00",
    четверг: "10:00-20:00", пятница: "10:00-20:00", суббота: "09:00-18:00",
    воскресенье: "11:00-16:00"
  },
  services: [
    { name: "Маникюр с покрытием", category: "Ногти", durationMinutes: 75, price: "$65", keywords: ["маникюр"] },
    { name: "Наращивание ресниц", category: "Взгляд", durationMinutes: 120, price: "$120", keywords: ["ресницы"] }
  ],
  staff: [
    { name: "Ирина Ковальчук", role: "Мастер", services: ["Маникюр с покрытием"], workDays: ["вторник", "среда"], aliases: ["Ира"] }
  ],
  policies: { cancellation: "Отмена бесплатно за 12 часов." },
  escalation: { who: "Ирина", notify: "owner@iris.demo" }
};

const childEnv = {
  ...process.env,
  PLATFORM_DB_PATH: TEST_DB,
  SESSION_SECRET: "test-session-secret-not-a-real-one",
  LLM_API_KEY: "unused-in-these-tests",
  ALERT_EMAIL: ""
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

function runCli(script, args, input) {
  const result = spawnSync(process.execPath, [script, ...args], { env: childEnv, input, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

let serverProcess = null;
let baseUrl = "";

async function startServer() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [SERVER], { env: { ...childEnv, PORT: String(port), PLATFORM_HOST: "127.0.0.1" } });
  serverProcess.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${baseUrl}/api/assistant/health`);
      if (probe.ok) return;
    } catch (error) { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("server did not come up in time");
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

function get(pathname, cookie) {
  return fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    headers: cookie ? { Accept: "application/json", Cookie: cookie } : { Accept: "application/json" }
  });
}

function patch(pathname, body, cookie) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${baseUrl}${pathname}`, {
    method: "PATCH",
    redirect: "manual",
    headers,
    body: JSON.stringify(body)
  });
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password })
  });
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const raw = setCookie.find((value) => value.startsWith("aibeaty_session=")) || "";
  return raw ? raw.split(";")[0] : "";
}

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
  console.log("Multi-salon HTTP tests\n");
  fs.writeFileSync(INTAKE_FILE, JSON.stringify(INTAKE), "utf8");

  try {
    // Real importer, real CLI — the same commands docs/onboarding.md tells an
    // operator to run.
    runCli(ONBOARD_CLI, [INTAKE_FILE, "--dry-run"]);
    runCli(ONBOARD_CLI, [INTAKE_FILE]);
    runCli(OWNER_CLI, ["--email", OWNER_B.email, "--salon", SALON_B, "--name", OWNER_B.name, "--password-stdin"], `${OWNER_B.password}\n`);
    runCli(OWNER_CLI, ["--email", OWNER_A.email, "--salon", SALON_A, "--name", OWNER_A.name, "--password-stdin"], `${OWNER_A.password}\n`);
    await startServer();

    const cookieB = await login(OWNER_B.email, OWNER_B.password);
    assert.ok(cookieB, "owner B signed in");
    const cookieA = await login(OWNER_A.email, OWNER_A.password);
    assert.ok(cookieA, "owner A signed in");

    await test("signed-in owner with NO ?salon= gets their OWN salon, not the default", async () => {
      const response = await get("/api/platform/services-pricing-luminous-core", cookieB);
      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.strictEqual(payload.salon.slug, SALON_B, `served salon must be B, got ${payload.salon.slug}`);
      assert.strictEqual(payload.salon.name, "Iris HTTP Bar");
      const names = payload.page.categories.flatMap((category) => category.services).map((service) => service.name);
      assert.ok(names.includes("Маникюр с покрытием"), `B's own services: ${names.join(", ")}`);
      assert.ok(!names.some((name) => /Balayage|Precision|Scissor/.test(name)), `no default-salon services leaked: ${names.join(", ")}`);
    });

    await test("signed-in owner's schedule and clients are their own salon's", async () => {
      const clients = await (await get("/api/platform/client-directory-luminous-core", cookieB)).json();
      assert.strictEqual(clients.salon.slug, SALON_B);
      assert.deepStrictEqual(clients.page.clients, [], "a freshly onboarded salon starts with no clients");

      const schedule = await (await get("/api/platform/stylist-schedule-luminous-core", cookieB)).json();
      assert.strictEqual(schedule.salon.slug, SALON_B);
      const staff = schedule.page.stylists.map((stylist) => stylist.name);
      assert.deepStrictEqual(staff, ["Ирина Ковальчук"], `only B's staff: ${staff.join(", ")}`);
    });

    await test("asking for another salon explicitly is refused, not served", async () => {
      const response = await get(`/api/platform/services-pricing-luminous-core?salon=${SALON_A}`, cookieB);
      assert.strictEqual(response.status, 403, `cross-salon read must be 403, got ${response.status}`);
      const payload = await response.json();
      assert.strictEqual(payload.reason, "cross_salon");
      assert.ok(!JSON.stringify(payload).includes("Balayage"), "no data leaks in the refusal body");
    });

    await test("the salon directory shows the signed-in owner only their own salon", async () => {
      const payload = await (await get("/api/platform/salons", cookieB)).json();
      const slugs = payload.salons.map((salon) => salon.slug);
      assert.deepStrictEqual(slugs, [SALON_B], `owner B must not learn about other salons: ${slugs.join(", ")}`);
    });

    await test("no session at all: platform data is refused", async () => {
      const response = await get("/api/platform/services-pricing-luminous-core");
      assert.strictEqual(response.status, 401, `anonymous read must be 401, got ${response.status}`);
    });

    await test("public assistant health resolves a salon without any session", async () => {
      const forB = await (await get(`/api/assistant/health?salon=${SALON_B}`)).json();
      assert.strictEqual(forB.salon, "Iris HTTP Bar");
      assert.strictEqual(forB.salonSlug, SALON_B);

      const forDefault = await (await get("/api/assistant/health")).json();
      assert.strictEqual(forDefault.salonSlug, SALON_A, "no slug → default salon");

      const ghost = await get("/api/assistant/health?salon=ghost-salon");
      assert.strictEqual(ghost.status, 404, "unknown salon is refused on the public route too");
    });

    // ---------------------------------------------------------------------
    // Regressions for the four holes found under /api/assistant/*.
    //
    // The root cause was one line: isPublicPath() opened that whole PREFIX, so
    // every owner-only route that happened to live under it was world-readable
    // and the handlers underneath, trusting the gate had run, read ?salon=
    // straight off the query string. The tests below pin each consequence.
    // ---------------------------------------------------------------------

    await test("LEAK 1: the daily digest is refused without a session, for any salon", async () => {
      for (const target of ["/api/assistant/digest", `/api/assistant/digest?salon=${SALON_A}`, `/api/assistant/digest?salon=${SALON_B}`]) {
        const response = await get(target);
        assert.strictEqual(response.status, 401, `anonymous ${target} must be 401, got ${response.status}`);
        const body = await response.text();
        assert.ok(!/"totals"|"bookings"|Ирина|Маникюр/.test(body), `refusal body leaked digest data: ${body.slice(0, 200)}`);
      }
    });

    await test("LEAK 2: the usage/spend meter is refused without a session, for any salon", async () => {
      for (const target of ["/api/assistant/usage", `/api/assistant/usage?salon=${SALON_A}`, `/api/assistant/usage?salon=${SALON_B}`]) {
        const response = await get(target);
        assert.strictEqual(response.status, 401, `anonymous ${target} must be 401, got ${response.status}`);
        const body = await response.text();
        assert.ok(!/"turns"|"promptTokens"|"cap"/.test(body), `refusal body leaked usage data: ${body.slice(0, 200)}`);
      }
    });

    await test("LEAK 3: an owner's digest follows their session, never ?salon= or the default", async () => {
      // Salon B's owner opening their own digest screen sends no ?salon= at all.
      // This used to hand them the DEFAULT salon's digest — salon A's clients.
      const own = await get("/api/assistant/digest", cookieB);
      assert.strictEqual(own.status, 200);
      const payload = await own.json();
      assert.strictEqual(payload.salonSlug, SALON_B, `digest must follow the session, got ${payload.salonSlug}`);
      assert.strictEqual(payload.salon, "Iris HTTP Bar");
      assert.ok(!JSON.stringify(payload).includes("Luminous"), "no default-salon data in B's digest");

      const usage = await (await get("/api/assistant/usage", cookieB)).json();
      assert.ok(usage.cap > 0, "B gets a usage payload of their own");

      // And naming another salon out loud is refused rather than served.
      const crossed = await get(`/api/assistant/digest?salon=${SALON_A}`, cookieB);
      assert.strictEqual(crossed.status, 403, `cross-salon digest must be 403, got ${crossed.status}`);
      const refusal = await crossed.json();
      assert.strictEqual(refusal.reason, "cross_salon");
      assert.ok(!/Balayage|Sarah|"totals"/.test(JSON.stringify(refusal)), "no salon-A data in the refusal");

      const crossedUsage = await get(`/api/assistant/usage?salon=${SALON_A}`, cookieB);
      assert.strictEqual(crossedUsage.status, 403, `cross-salon usage must be 403, got ${crossedUsage.status}`);
    });

    await test("LEAK 4: the takeover switch needs a session and refuses another salon's thread", async () => {
      // A real conversation id from salon A, read the way its own owner would.
      const inbox = await (await get("/api/platform/unified-inbox-luminous-core", cookieA)).json();
      const conversationId = (inbox.page.conversations || [])[0] && inbox.page.conversations[0].id;
      assert.ok(conversationId, "salon A has a seeded conversation to aim at");

      // Anonymous: this used to answer 200 and silence Maya in that salon.
      const anonymous = await patch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/takeover`, { enabled: true });
      assert.strictEqual(anonymous.status, 401, `anonymous takeover must be 401, got ${anonymous.status}`);

      // Salon B's owner aiming at salon A's thread: indistinguishable from a
      // conversation that does not exist, so the id itself stays private.
      const crossed = await patch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/takeover`, { enabled: true }, cookieB);
      assert.strictEqual(crossed.status, 404, `cross-salon takeover must be 404, got ${crossed.status}`);

      // The thread is untouched by either attempt.
      const after = await (await get("/api/platform/unified-inbox-luminous-core", cookieA)).json();
      const row = after.page.conversations.find((conversation) => conversation.id === conversationId);
      assert.notStrictEqual(row.assistantState, "takeover", "neither attempt may flip the switch");

      // Its own owner still can.
      const allowed = await patch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/takeover`, { enabled: true }, cookieA);
      assert.strictEqual(allowed.status, 200, "the salon's own owner keeps the switch");
      assert.strictEqual((await allowed.json()).assistantState, "takeover");
      await patch(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/takeover`, { enabled: false }, cookieA);
    });

    await test("the public health probe tells an anonymous caller nothing about our LLM", async () => {
      const anonymous = await (await get(`/api/assistant/health?salon=${SALON_B}`)).json();
      assert.strictEqual(anonymous.salon, "Iris HTTP Bar", "the widget still gets the salon name");
      assert.strictEqual(anonymous.model, undefined, "model must not be published");
      assert.strictEqual(anonymous.baseUrl, undefined, "LLM endpoint must not be published");
    });

    await test("nothing new under /api/assistant/ is public by accident", async () => {
      // The old prefix rule made any unrecognised path here public, so a future
      // owner route would ship open. It must land on the gate instead.
      const response = await get("/api/assistant/some-future-owner-route");
      assert.strictEqual(response.status, 401, `unknown assistant route must hit the gate, got ${response.status}`);
    });

    await test("re-running the importer against a live server stays idempotent", async () => {
      runCli(ONBOARD_CLI, [INTAKE_FILE]);
      const payload = await (await get("/api/platform/services-pricing-luminous-core", cookieB)).json();
      const names = payload.page.categories.flatMap((category) => category.services).map((service) => service.name);
      assert.strictEqual(names.length, 2, `still two services after a second import, got ${names.length}`);
    });
  } finally {
    stopServer();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  failures.forEach((failure) => {
    console.log(`FAILED: ${failure.name}`);
    console.log(failure.error.stack || failure.error.message);
  });
  if (failures.length) process.exit(1);
})();
