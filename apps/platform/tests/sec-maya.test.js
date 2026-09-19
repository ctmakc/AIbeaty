#!/usr/bin/env node
// Security regressions for Maya's public web chat (sec/hardening-20260918):
//   1. a phone typed into the web chat never reveals a client's file (PII);
//   2. an unlinked web session cannot cancel someone else's appointment by id (IDOR);
//   3. partial phone numbers never match a client (enumeration);
//   4. the per-IP throttle holds while the sessionId rotates.
// No network. Run: node apps/platform/tests/sec-maya.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-sec-"));
process.env.PLATFORM_DB_PATH = path.join(dir, "platform.db");
process.env.ASSISTANT_IP_RATE_LIMIT = "3";
delete process.env.ASSISTANT_VERIFIED_CHANNELS;
delete process.env.ALERT_EMAIL;

const { createPlatformStore } = require("../backend/store");
const { createAssistant } = require("../backend/assistant");
const store = createPlatformStore();

const toolCall = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call-${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }]
});
const text = (content) => ({ role: "assistant", content });

// Scripted LLM that keeps what the tools returned to it.
function recordingLlm(script) {
  const toolResults = [];
  return {
    toolResults,
    model: "mock",
    baseUrl: "mock://",
    async complete({ messages }) {
      const lastTool = [...messages].reverse().find((message) => message.role === "tool");
      if (lastTool && !toolResults.includes(lastTool.content)) toolResults.push(lastTool.content);
      if (!script.length) return text("Хорошо.");
      return script.shift();
    }
  };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
  }
}

(async () => {
  const victim = store.db.prepare(`
    SELECT c.* FROM clients c JOIN appointments a ON a.client_id = c.id
    WHERE c.phone IS NOT NULL AND c.phone != '' AND a.appointment_status = 'scheduled'
    LIMIT 1
  `).get();
  assert.ok(victim, "demo data has a client with a phone and a scheduled visit");
  const victimAppt = store.db.prepare(`SELECT * FROM appointments WHERE client_id = ? AND appointment_status = 'scheduled' LIMIT 1`).get(victim.id);

  await test("web chat: a known client's phone does not open their file", async () => {
    const llm = recordingLlm([toolCall("get_client_context", { phone: victim.phone }), text("Как вас зовут?")]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ sessionId: "web-sec-pii", message: `Мой номер ${victim.phone}`, channel: "web", clientPhone: victim.phone });
    const result = JSON.parse(llm.toolResults[0]);
    assert.strictEqual(result.found, false, "no lookup on an unverified channel");
    const all = llm.toolResults.join(" ");
    assert.ok(!all.includes(victim.name), "client's name never reaches the model");
    assert.ok(!all.includes(String(victimAppt.id)), "appointment id never reaches the model");
    const conversation = store.db.prepare(`SELECT client_id FROM conversations WHERE id = (SELECT conversation_id FROM assistant_sessions WHERE id = ?)`).get("web-sec-pii");
    assert.ok(conversation, "conversation exists");
    assert.notStrictEqual(conversation.client_id, victim.id, "session not linked to the client by a typed phone");
  });

  await test("web chat: cancel by someone else's appointment id is refused", async () => {
    const llm = recordingLlm([toolCall("cancel_appointment", { appointment_id: victimAppt.id }), text("Не нашла запись.")]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ sessionId: "web-sec-idor", message: "Отмените запись", channel: "web" });
    const result = JSON.parse(llm.toolResults[0]);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "no_appointment_found");
    const row = store.db.prepare(`SELECT appointment_status FROM appointments WHERE id = ?`).get(victimAppt.id);
    assert.strictEqual(row.appointment_status, "scheduled", "victim's visit untouched");
  });

  await test("phone lookup: a partial number matches nobody", async () => {
    process.env.ASSISTANT_VERIFIED_CHANNELS = "";
    const digits = String(victim.phone).replace(/\D/g, "");
    const llm = recordingLlm([toolCall("get_client_context", { phone: digits.slice(-7) }), text("Ок.")]);
    const assistant = createAssistant({ store, llm });
    await assistant.chat({ sessionId: "web-sec-partial", message: `номер ${digits.slice(-7)}`, channel: "web" });
    assert.strictEqual(JSON.parse(llm.toolResults[0]).found, false);
  });

  await test("per-IP throttle holds while the sessionId rotates", async () => {
    const assistant = createAssistant({ store, llm: recordingLlm([]) });
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push(await assistant.chat({ sessionId: `web-sec-rot-${i}`, message: "Привет", channel: "web", clientKey: "203.0.113.9" }));
    }
    assert.ok(results.some((result) => result.error === "rate_limited"), "rotating sessions still hit the per-IP cap");
    const other = await assistant.chat({ sessionId: "web-sec-other", message: "Привет", channel: "web", clientKey: "198.51.100.4" });
    assert.notStrictEqual(other.error, "rate_limited", "another IP is not affected");
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach((failure) => console.error(`FAILED: ${failure.name}\n${failure.error.stack}`));
    process.exit(1);
  }
})();
