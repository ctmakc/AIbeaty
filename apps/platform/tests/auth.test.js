#!/usr/bin/env node
// Owner-login tests. These drive a REAL server process over REAL HTTP against an
// isolated database — the gate is only proven by requests that actually get refused.
// No network beyond 127.0.0.1. Run: npm run auth:test
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER = path.join(REPO_ROOT, "apps/platform/server.js");
const CLI = path.join(REPO_ROOT, "scripts/create-owner.mjs");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-auth-"));
const TEST_DB = path.join(TEST_DIR, "platform.db");

const SALON_A = "luminous-core";
const SALON_B = "velvet-atelier";
const OWNER_A = { email: "owner-a@example.test", password: "correct-horse-battery-A1", name: "Owner A" };
const OWNER_B = { email: "owner-b@example.test", password: "correct-horse-battery-B2", name: "Owner B" };

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

function createOwnerViaCli({ email, password, salon, name }) {
  const result = spawnSync(process.execPath, [CLI, "--email", email, "--salon", salon, "--name", name, "--password-stdin"], {
    env: childEnv,
    input: `${password}\n`,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`create-owner.mjs failed: ${result.stderr || result.stdout}`);
  }
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
    } catch (error) {
      /* not up yet */
    }
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

function get(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    redirect: "manual",
    headers: Object.assign({ Accept: "application/json" }, options.headers || {}),
    method: options.method || "GET",
    body: options.body
  });
}

function withCookie(cookie, extra = {}) {
  return { headers: Object.assign({ Cookie: cookie }, extra) };
}

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json();
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const raw = setCookie.find((value) => value.startsWith("aibeaty_session=")) || "";
  const cookie = raw ? raw.split(";")[0] : "";
  return { status: response.status, payload, cookie, rawCookie: raw };
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
    console.log(`  [FAIL] ${name}`);
  }
}

(async () => {
  console.log("Owner login tests\n");

  createOwnerViaCli({ ...OWNER_A, salon: SALON_A });
  createOwnerViaCli({ ...OWNER_B, salon: SALON_B });
  await startServer();

  let cookieA = "";
  let cookieB = "";

  await test("public paths stay open without any session", async () => {
    for (const pathname of ["/api/assistant/health", "/screens/chat.html", "/assistant-widget.js", "/screens/login.html"]) {
      const response = await get(pathname, { headers: { Accept: "text/html,application/json" } });
      assert.strictEqual(response.status, 200, `${pathname} should be public, got ${response.status}`);
    }
  });

  await test("gate: platform API refuses an unauthenticated caller with 401", async () => {
    const response = await get("/api/platform/health");
    assert.strictEqual(response.status, 401);
    const payload = await response.json();
    assert.strictEqual(payload.error, "unauthorized");
  });

  await test("gate: a screen request without a session redirects to the login page", async () => {
    const response = await get("/screens/salon-performance-luminous-core.html", { headers: { Accept: "text/html" } });
    assert.strictEqual(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(location.startsWith("/screens/login.html?next="), `unexpected redirect target: ${location}`);
    assert.ok(location.includes(encodeURIComponent("/screens/salon-performance-luminous-core.html")));
  });

  await test("gate: bare / redirects to login when signed out", async () => {
    const response = await get("/", { headers: { Accept: "text/html" } });
    assert.strictEqual(response.status, 302);
    assert.ok(response.headers.get("location").startsWith("/screens/login.html"));
  });

  await test("gate: the demo JSON fallback is not a way around the gate", async () => {
    const response = await get("/data/demo-platform.json");
    assert.strictEqual(response.status, 401);
  });

  await test("wrong password is rejected", async () => {
    const result = await login(OWNER_A.email, "definitely-not-the-password");
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.cookie, "", "no cookie may be issued on a failed login");
  });

  await test("unknown account answers exactly like a wrong password (no user enumeration)", async () => {
    const unknown = await login("nobody@example.test", "whatever-long-enough");
    const wrong = await login(OWNER_A.email, "definitely-not-the-password");
    assert.strictEqual(unknown.status, wrong.status);
    assert.deepStrictEqual(unknown.payload, wrong.payload);
  });

  await test("successful login issues an HttpOnly, SameSite=Lax session cookie", async () => {
    const result = await login(OWNER_A.email, OWNER_A.password);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.payload.ok, true);
    assert.strictEqual(result.payload.owner.salonSlug, SALON_A);
    assert.ok(/HttpOnly/i.test(result.rawCookie), `cookie must be HttpOnly: ${result.rawCookie}`);
    assert.ok(/SameSite=Lax/i.test(result.rawCookie), `cookie must be SameSite=Lax: ${result.rawCookie}`);
    assert.ok(/Max-Age=\d+/i.test(result.rawCookie));
    const maxAge = Number(/Max-Age=(\d+)/i.exec(result.rawCookie)[1]);
    assert.ok(maxAge > 13 * 24 * 3600 && maxAge <= 14 * 24 * 3600, `~14 day session, got ${maxAge}s`);
    cookieA = result.cookie;
  });

  await test("a session opens the platform API and the screens", async () => {
    const api = await get("/api/platform/health", withCookie(cookieA));
    assert.strictEqual(api.status, 200);
    const payload = await api.json();
    assert.strictEqual(payload.ok, true);

    const screen = await get("/screens/salon-performance-luminous-core.html", withCookie(cookieA, { Accept: "text/html" }));
    assert.strictEqual(screen.status, 200);
  });

  await test("/api/auth/session reports who is signed in", async () => {
    const response = await get("/api/auth/session", withCookie(cookieA));
    const payload = await response.json();
    assert.strictEqual(payload.authenticated, true);
    assert.strictEqual(payload.owner.email, OWNER_A.email);
    assert.strictEqual(payload.owner.salonSlug, SALON_A);
  });

  await test("a tampered cookie signature is worthless", async () => {
    const tampered = `${cookieA.slice(0, -3)}zzz`;
    const response = await get("/api/platform/health", withCookie(tampered));
    assert.strictEqual(response.status, 401);
  });

  await test("cross-salon: owner B cannot read salon A's data (403)", async () => {
    const result = await login(OWNER_B.email, OWNER_B.password);
    assert.strictEqual(result.status, 200);
    cookieB = result.cookie;

    const explicit = await get(`/api/platform/health?salon=${SALON_A}`, withCookie(cookieB));
    assert.strictEqual(explicit.status, 403, "asking for salon A by name must be refused");
    const payload = await explicit.json();
    assert.strictEqual(payload.reason, "cross_salon");

    // …and without naming any salon B still cannot fall through onto A's data,
    // because this instance does not host B's salon.
    const implicit = await get("/api/platform/health", withCookie(cookieB));
    assert.strictEqual(implicit.status, 403);
    assert.strictEqual((await implicit.json()).reason, "salon_not_provisioned");
  });

  await test("cross-salon: owner A cannot reach into salon B either", async () => {
    const response = await get(`/api/platform/health?salon=${SALON_B}`, withCookie(cookieA));
    assert.strictEqual(response.status, 403);
    assert.strictEqual((await response.json()).reason, "cross_salon");
  });

  await test("cross-salon: the X-Salon-Slug header is policed the same way", async () => {
    const response = await get("/api/platform/health", withCookie(cookieA, { "X-Salon-Slug": SALON_B }));
    assert.strictEqual(response.status, 403);
  });

  await test("cross-salon: screens are gated by salon too, not just the API", async () => {
    const response = await get(`/screens/salon-performance-luminous-core.html?salon=${SALON_B}`, withCookie(cookieA, { Accept: "text/html" }));
    assert.strictEqual(response.status, 403);
  });

  await test("logout invalidates the session server-side", async () => {
    const before = await get("/api/platform/health", withCookie(cookieA));
    assert.strictEqual(before.status, 200);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookieA, Accept: "application/json" },
      redirect: "manual"
    });
    assert.strictEqual(logout.status, 200);

    // The same cookie value, replayed: a client-side cookie wipe would still pass here.
    const after = await get("/api/platform/health", withCookie(cookieA));
    assert.strictEqual(after.status, 401, "a logged-out cookie must be dead on the server");
  });

  await test("login is rate limited to 10 attempts per IP", async () => {
    const email = "ratelimit-probe@example.test";
    let sawLimit = false;
    let attemptsBeforeLimit = 0;
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const result = await login(email, "wrong-password-here");
      if (result.status === 429) {
        sawLimit = true;
        break;
      }
      attemptsBeforeLimit = attempt;
    }
    assert.ok(sawLimit, "the 11th attempt should have been rate limited");
    assert.ok(attemptsBeforeLimit <= 10, `expected the limit at 10 attempts, kept going to ${attemptsBeforeLimit}`);
  });

  await test("rate-limited answer says nothing a wrong password would not", async () => {
    const limited = await login(OWNER_A.email, "wrong-password-here");
    assert.strictEqual(limited.status, 429);
    assert.ok(limited.payload.message.ru.includes("Неверная почта или пароль"));
  });

  await test("--reset-state wipes the demo data and keeps the owner accounts", async () => {
    stopServer();
    const reset = spawnSync(process.execPath, [SERVER, "--reset-state"], { env: childEnv, encoding: "utf8" });
    assert.strictEqual(reset.status, 0, reset.stderr);
    const listing = spawnSync(process.execPath, [CLI, "--list"], { env: childEnv, encoding: "utf8" });
    assert.strictEqual(listing.status, 0, listing.stderr);
    assert.ok(listing.stdout.includes(OWNER_A.email), "owner A survived the demo reset");
    assert.ok(listing.stdout.includes(OWNER_B.email), "owner B survived the demo reset");
    await startServer();
    const result = await login(OWNER_A.email, OWNER_A.password);
    assert.strictEqual(result.status, 200, "the account still logs in after a demo reset");
  });

  await test("the CLI never prints a password it was handed", async () => {
    const output = createOwnerViaCli({
      email: "cli-echo-probe@example.test",
      password: "another-long-password-9",
      salon: SALON_A,
      name: "Echo Probe"
    });
    assert.ok(!output.includes("another-long-password-9"), "a supplied password must not be echoed");
  });

  stopServer();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAILED: ${failure.name}\n${failure.error.stack}`));
    process.exit(1);
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
})().catch((error) => {
  stopServer();
  console.error(error);
  process.exit(1);
});
