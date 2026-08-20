#!/usr/bin/env node
// Live end-to-end smoke against the REAL LLM: boots the actual server on a
// test port with an isolated DB, runs a scripted Russian dialogue that books
// an appointment, then verifies the row in SQLite AND via the schedule API.
// Skip with ASSISTANT_SMOKE_SKIP=1 (e.g. no network / no LLM key).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

if (process.env.ASSISTANT_SMOKE_SKIP === "1") {
  console.log("assistant-live-smoke: SKIPPED (ASSISTANT_SMOKE_SKIP=1)");
  process.exit(0);
}

const PORT = Number(process.env.ASSISTANT_SMOKE_PORT || 4198);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-smoke-")), "platform.db");
const SERVER = path.join(__dirname, "..", "server.js");
const SESSION = `smoke-${Date.now().toString(36)}`;
const CLIENT_NAME = "Тест Смок";

// The guest half of this smoke (chat) is public; the verification half (schedule,
// digest) is owner-only, so the smoke signs in like a real owner instead of
// reading those endpoints anonymously.
const OWNER_CLI = path.join(__dirname, "../../..", "scripts/create-owner.mjs");
const OWNER = { email: "smoke-owner@example.test", password: "smoke-owner-pass-9137", name: "Smoke Owner" };
const SALON = "luminous-core";
let ownerCookie = "";

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}

// Authenticated GET as the salon owner.
async function getAsOwner(pathAndQuery) {
  const response = await fetch(`${BASE}${pathAndQuery}`, { headers: { Cookie: ownerCookie } });
  assert.strictEqual(response.status, 200, `GET ${pathAndQuery} → HTTP ${response.status}`);
  return response.json();
}

async function signInAsOwner(env) {
  const created = spawnSync(
    process.execPath,
    [OWNER_CLI, "--email", OWNER.email, "--salon", SALON, "--name", OWNER.name, "--password-stdin"],
    { env, input: `${OWNER.password}\n`, encoding: "utf8" }
  );
  assert.strictEqual(created.status, 0, `create-owner.mjs failed: ${created.stderr || created.stdout}`);

  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  assert.strictEqual(response.status, 200, `owner login HTTP ${response.status}`);
  const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const raw = setCookie.find((value) => value.startsWith("aibeaty_session=")) || "";
  ownerCookie = raw ? raw.split(";")[0] : "";
  assert.ok(ownerCookie, "owner login returned no session cookie");
  console.log(`  [OK] signed in as ${OWNER.email} (salon ${SALON})`);
}

async function say(message) {
  const { status, data } = await post(`${BASE}/api/assistant/chat`, { sessionId: SESSION, message, channel: "Webchat" });
  assert.strictEqual(status, 200, `chat HTTP ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  console.log(`  client> ${message}`);
  console.log(`  maya  > ${(data.reply || "(silent)").replace(/\n/g, " ").slice(0, 220)}`);
  return data;
}

(async () => {
  console.log(`assistant-live-smoke — db: ${TEST_DB}, port: ${PORT}`);
  const childEnv = Object.assign({}, process.env, { PORT: String(PORT), PLATFORM_DB_PATH: TEST_DB });
  const server = spawn(process.execPath, [SERVER], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += chunk; });
  server.stderr.on("data", (chunk) => { serverLog += chunk; });

  try {
    // Wait for boot.
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await wait(500);
      try {
        const health = await fetch(`${BASE}/api/assistant/health`);
        up = health.ok;
      } catch (error) { /* not up yet */ }
    }
    assert.ok(up, `server did not boot:\n${serverLog}`);

    await signInAsOwner(childEnv);

    // Scripted RU dialogue that should end in a real booking.
    const Database = require("better-sqlite3");
    const db = () => new Database(TEST_DB, { readonly: true });
    const findRow = () => db().prepare(
      `SELECT * FROM appointments WHERE client_name LIKE ? AND notes LIKE '%Maya%'`
    ).get(`%${CLIENT_NAME}%`);

    let last = await say(`Привет! Запишите меня на женскую стрижку во вторник в 14:00, к Елене. Меня зовут ${CLIENT_NAME}.`);
    assert.ok(!findRow(), "appointment must NOT exist before the client confirms (read-back gate)");

    // Drive the dialogue: confirm when Maya reads back / asks to confirm,
    // otherwise pick a concrete offered time. The commit gate lives in code,
    // so no message here can create a row without a staged read-back + yes.
    let row = null;
    for (let i = 0; i < 4 && !row; i++) {
      const askingConfirm = last.state.pendingAction || /верно|подтвер|correct/i.test(last.reply || "");
      last = await say(askingConfirm ? "Да, всё верно!" : "Давайте в 11:00 к Елене, пожалуйста.");
      row = findRow();
    }
    assert.ok(row, "appointment row must exist in SQLite after confirmation");
    assert.strictEqual(row.service_name, "Women's Precision Cut");
    assert.strictEqual(row.appointment_status, "scheduled");
    assert.ok([14 * 60, 11 * 60].includes(row.start_minutes), `booked start: ${row.start_minutes}`);
    console.log(`  [OK] SQLite row: ${row.id} · ${row.service_name} · day_offset=${row.day_offset} · start=${row.start_minutes}`);

    // The booking must be visible through the platform schedule API.
    const schedule = await getAsOwner(`/api/platform/stylist-schedule-luminous-core?dayOffset=${row.day_offset}`);
    const visible = (schedule.page.appointments || []).find((appointment) => appointment.id === row.id);
    assert.ok(visible, "appointment visible via GET /api/platform/stylist-schedule-luminous-core");
    assert.ok(visible.client.includes("Тест"), `client on schedule: ${visible.client}`);
    console.log(`  [OK] schedule API shows: ${visible.client} · ${visible.service} · ${visible.time}`);

    // And in the owner digest.
    const digest = await getAsOwner("/api/assistant/digest");
    assert.ok(digest.totals.bookings >= 1, "digest counts the booking");
    console.log(`  [OK] digest: ${digest.totals.bookings} booking(s), ${digest.totals.clientMessages} client message(s)`);

    console.log("\nassistant-live-smoke: PASS");
  } finally {
    server.kill();
  }
})().catch((error) => {
  console.error(`\nassistant-live-smoke: FAIL — ${error.message}`);
  process.exit(1);
});
