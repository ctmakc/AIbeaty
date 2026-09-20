// Provider-agnostic LLM client: any OpenAI-compatible /chat/completions endpoint
// with function calling. Configured purely via env so a future Anthropic
// (OpenAI-compat) endpoint is a 2-var swap:
//   LLM_BASE_URL      e.g. https://ollama.com/v1  (default)
//   LLM_API_KEY       raw key, or
//   LLM_API_KEY_FILE  path to a file with the key (default ~/.ollama/api_key)
//   LLM_MODEL         e.g. gpt-oss:120b           (default; see docs/assistant.md)
//                     or a comma-separated fallback chain, tried in order:
//                     "gpt-oss:120b,nemotron-3-super"
//
// Why a chain: on 2026-09-18 the Ollama Cloud plan lapsed and the one model Maya
// used started answering "not included in your free usage". Every salon's
// assistant went silent at once. A model that refuses is skipped for a while and
// the next one answers; transient errors still retry the same model first.
// No SDK — plain Node 22 global fetch.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_BASE_URL = "https://ollama.com/v1";
// The default IS a chain. On 2026-09-18 the Ollama Cloud plan lapsed: the old
// single default (deepseek-v4-pro:0813) answers 403 "not included in your free
// usage", so anything that boots without LLM_MODEL (tests, scripts, a fresh box)
// went silent. These two answer on the free tier; add paid models in front via
// LLM_MODEL when a plan is active.
const DEFAULT_MODEL = "gpt-oss:120b,nemotron-3-super";
const DEFAULT_KEY_FILE = path.join(os.homedir(), ".ollama", "api_key");

function resolveApiKey(options = {}) {
  if (options.apiKey) return options.apiKey;
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  const keyFile = options.apiKeyFile || process.env.LLM_API_KEY_FILE || DEFAULT_KEY_FILE;
  try {
    return fs.readFileSync(keyFile, "utf8").trim();
  } catch (error) {
    throw new Error(`LLM API key not found: set LLM_API_KEY or LLM_API_KEY_FILE (tried ${keyFile})`);
  }
}

// A model that is refused outright (plan lapsed, model removed, bad request
// shape for this model) is benched for this long before it is tried again.
const BENCH_MS = 10 * 60 * 1000;

function parseModelChain(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createLlmClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const models = parseModelChain(options.model || process.env.LLM_MODEL || DEFAULT_MODEL);
  if (!models.length) models.push(DEFAULT_MODEL);
  const timeoutMs = Number(options.timeoutMs || process.env.LLM_TIMEOUT_MS || 90000);
  const fetchImpl = options.fetch || fetch;
  const now = options.now || (() => Date.now());
  const benchedUntil = new Map();
  let cachedKey = null;
  let lastModel = models[0];

  // Walks the chain: benched models are skipped unless every model is benched,
  // in which case the whole chain is tried anyway (better a doomed try than silence).
  async function complete(request) {
    const ready = models.filter((name) => (benchedUntil.get(name) || 0) <= now());
    const order = ready.length ? ready : models;
    let lastError = null;
    for (const name of order) {
      try {
        const message = await completeWith(name, request);
        benchedUntil.delete(name);
        lastModel = name;
        message.model = name;
        return message;
      } catch (error) {
        lastError = error;
        benchedUntil.set(name, now() + BENCH_MS);
        console.warn(`[llm] ${name} failed, trying next model: ${String(error.message).slice(0, 160)}`);
      }
    }
    throw lastError || new Error("LLM request failed");
  }

  async function completeWith(model, { messages, tools, temperature = 0.4, maxTokens = 700 }) {
    if (!cachedKey) cachedKey = resolveApiKey(options);
    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens
    };
    if (tools && tools.length) body.tools = tools;

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cachedKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const text = (await response.text()).slice(0, 400);
          // Retry only transient statuses.
          if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
            lastError = new Error(`LLM HTTP ${response.status}: ${text}`);
            await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
            continue;
          }
          const fatal = new Error(`LLM HTTP ${response.status}: ${text}`);
          fatal.fatal = true;
          throw fatal;
        }
        const data = await response.json();
        const message = data.choices && data.choices[0] && data.choices[0].message;
        if (!message) throw new Error("LLM returned no message");
        // Ollama /v1 (OpenAI-compat) returns token usage at the top level:
        // { usage: { prompt_tokens, completion_tokens, total_tokens } }.
        // Carry it on the message so callers can meter spend per call.
        if (data.usage && typeof data.usage === "object") message.usage = data.usage;
        return message;
      } catch (error) {
        if (error.fatal) throw error;
        lastError = error;
        if (error.name === "AbortError") lastError = new Error(`LLM request timed out after ${timeoutMs}ms`);
        if (attempt === 2) throw lastError;
        await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("LLM request failed");
  }

  return {
    complete,
    models,
    get model() {
      return lastModel;
    },
    baseUrl
  };
}

module.exports = { createLlmClient };
