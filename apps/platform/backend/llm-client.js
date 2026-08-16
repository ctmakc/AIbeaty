// Provider-agnostic LLM client: any OpenAI-compatible /chat/completions endpoint
// with function calling. Configured purely via env so a future Anthropic
// (OpenAI-compat) endpoint is a 2-var swap:
//   LLM_BASE_URL      e.g. https://ollama.com/v1  (default)
//   LLM_API_KEY       raw key, or
//   LLM_API_KEY_FILE  path to a file with the key (default ~/.ollama/api_key)
//   LLM_MODEL         e.g. deepseek-v4-pro:0813   (default; see docs/assistant.md)
// No SDK — plain Node 22 global fetch.
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_BASE_URL = "https://ollama.com/v1";
const DEFAULT_MODEL = "deepseek-v4-pro:0813";
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

function createLlmClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = options.model || process.env.LLM_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(options.timeoutMs || process.env.LLM_TIMEOUT_MS || 90000);
  let cachedKey = null;

  async function complete({ messages, tools, temperature = 0.4, maxTokens = 700 }) {
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
        const response = await fetch(`${baseUrl}/chat/completions`, {
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
          throw new Error(`LLM HTTP ${response.status}: ${text}`);
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

  return { complete, model, baseUrl };
}

module.exports = { createLlmClient };
