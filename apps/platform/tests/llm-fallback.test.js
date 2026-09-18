#!/usr/bin/env node
// The model chain: a refused model is skipped and benched, the next one answers,
// and a benched model gets another chance once the bench expires.
// Run: node apps/platform/tests/llm-fallback.test.js
const assert = require("assert");
const { createLlmClient } = require("../backend/llm-client");

function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

async function main() {
  const calls = [];
  let clock = 0;
  const refused = new Set(["paid-model"]);
  const client = createLlmClient({
    apiKey: "test",
    model: "paid-model, free-model",
    now: () => clock,
    fetch: async (url, init) => {
      const { model } = JSON.parse(init.body);
      calls.push(model);
      if (refused.has(model)) return reply(403, { error: { message: "this model is not included in your free usage" } });
      return reply(200, { choices: [{ message: { role: "assistant", content: `hi from ${model}` } }] });
    }
  });

  assert.deepStrictEqual(client.models, ["paid-model", "free-model"]);

  const first = await client.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.strictEqual(first.content, "hi from free-model");
  assert.strictEqual(first.model, "free-model");
  assert.strictEqual(client.model, "free-model");
  // A 403 is final for that model: exactly one call, no retry storm.
  assert.deepStrictEqual(calls, ["paid-model", "free-model"]);

  calls.length = 0;
  await client.complete({ messages: [{ role: "user", content: "again" }] });
  assert.deepStrictEqual(calls, ["free-model"], "a benched model is skipped");

  clock += 11 * 60 * 1000;
  refused.delete("paid-model");
  calls.length = 0;
  const back = await client.complete({ messages: [{ role: "user", content: "later" }] });
  assert.deepStrictEqual(calls, ["paid-model"], "the bench expires and the first model is tried again");
  assert.strictEqual(back.model, "paid-model");

  refused.add("paid-model");
  refused.add("free-model");
  clock += 11 * 60 * 1000;
  await assert.rejects(() => client.complete({ messages: [{ role: "user", content: "x" }] }), /LLM HTTP 403/);

  console.log("llm-fallback: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
