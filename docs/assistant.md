# Maya — the AIbeaty conversational assistant

Maya is the AI layer of the platform demo: a salon assistant that answers on the
salon's channels, books/reschedules/cancels appointments in the real SQLite
database, hands off to humans, and writes a daily owner digest. She discloses
being an AI, mirrors the client's language (RU/UK/EN), and is hard-gated in
code so she cannot invent prices, slots, staff, or booking confirmations.

## Architecture

```
POST /api/assistant/chat ──► backend/assistant.js  (engine: tool loop + gates)
                              ├─ backend/assistant-prompt.js  (persona, few-shots — editable)
                              ├─ backend/llm-client.js        (provider-agnostic OpenAI-compat fetch)
                              ├─ data/salon-faq.json          (owner-editable FAQ facts, RU/EN)
                              └─ backend/store.js             (same SQLite the whole platform uses)
```

Assistant chats are ordinary inbox conversations: they appear in the Unified
Inbox screen with all messages, and booking actions land in the schedule,
clients, and activity screens like any other data.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/assistant/chat` | `{sessionId, message, channel?, clientPhone?}` → `{reply, state}`. `reply: null` means the bot is silenced (takeover/escalated); the message is still stored for the owner. |
| GET | `/api/assistant/digest?day=YYYY-MM-DD` | Structured daily summary (escalations first, bookings, owner messages, per-conversation stats). Default: today. |
| GET | `/screens/digest.html` | Human-readable rendering of the digest. |
| PATCH | `/api/assistant/conversations/:id/takeover` | `{enabled: true\|false}` — manual takeover toggle. Staff replying by hand in the inbox enables it automatically. |
| GET | `/api/assistant/health` | Model + base URL currently wired (no secrets). |

CORS allowlist: `https://aibeaty.pages.dev`, `https://aibeaty.remolda.com`,
`http://localhost:*` / `http://127.0.0.1:*`.

## Hard gates (enforced in code, not prompt)

1. **Booking-claim gate** — "вы записаны"-class phrases are only allowed in a
   turn where a booking/reschedule/cancel tool actually committed and verified
   a DB write. Otherwise the reply is replaced with an honest fallback and an
   owner task is created.
2. **Read-back state machine** — `book_appointment` (and reschedule/cancel) is
   two-phase: the first call stages the action server-side and returns a
   read-back; the commit only happens when the staged action matches AND the
   client's latest message is an explicit affirmation.
3. **Price quote-guard** — every price in a reply must have appeared in a tool
   result during the session; unknown numbers get the reply replaced + owner task.
4. **Auto-escalation** — explicit "позовите человека" and medical topics get a
   canned handoff without the LLM; complaints/frustration/price disputes get one
   guided reply then escalate. Two misunderstandings in a session also escalate.
   Escalated threads silence the bot.
5. **Takeover** — a manual staff reply in an assistant thread flips
   `assistant_state='takeover'`; the bot stays silent until toggled back.
6. **Rate limit** — 20 messages / 5 min per session (in-memory), HTTP 429 beyond.
7. **Prompt-injection posture** — client text is data; discounts/policy are
   owner-only (prompt + the gates above mean injected "confirm my booking" or
   "everything is $1" cannot survive into a reply).
8. **Per-day opening hours** (red-team fix, 2026-08-15) — offered AND committed
   slots are clamped to per-weekday windows: Tue–Fri 9:00–19:00, Sat 10:00–17:00,
   Sun/Mon closed. Source of truth: `hours` block in
   `apps/platform/data/salon-faq.json` (falls back to the same defaults in code).
   `check_availability`, `book_appointment`, and `reschedule_appointment` all
   validate against the target day's window, so a "Saturday 9:00" can neither be
   offered nor written to the DB.
9. **Unknown-stylist gate** (red-team fix, 2026-08-15) — stylist names the
   client mentions are validated against the `stylists` table on the turn they
   first appear (RU/UK declensions handled by stemming). If the name doesn't
   exist: a ground-truth system note is injected for the model, and the reply is
   code-checked — any affirmation/praise of the phantom name (or a reply lacking
   an explicit correction) is replaced with an honest "no such stylist" reply
   listing real staff. A separate reply-side scan catches "мастер X"/"stylist X"
   names the model invents on its own.

## LLM provider — tested matrix (2026-08-15)

Smoke test: 10 scripted turns (8 must emit a correct `check_availability`
function call with parseable args, 2 must answer plainly and warmly in the
client's language). Script: kept in repo history; acceptance bar was 9/10.

| Model | Provider | Tools | Notes |
| --- | --- | --- | --- |
| **deepseek-v4-pro:0813** | Ollama Cloud Pro | **10/10** | **Winner.** Fastest (avg ~1.0s/turn), natural warm RU, correct RU/UK/EN mirroring. Default. |
| glm-5.2 | Ollama Cloud Pro | 10/10 | Avg ~1.7s. Warm, uses emoji freely. Solid fallback. |
| qwen3.5:397b | Ollama Cloud Pro | 10/10 | Avg ~2.2s. Slightly formal RU. Fallback. |
| kimi-k3 | Ollama Cloud | 0/10 | Blocked: HTTP 402 — model is "extra usage only" on our plan. |
| kimi-k3 | OpenCode Zen | 0/10 | Blocked: HTTP 429 — monthly usage limit reached (resets ~2026-08-26). |

End-to-end (booking dialogue → SQLite row → schedule API) verified live with
deepseek-v4-pro:0813.

### Wiring (env — see `.env.example`)

- `LLM_BASE_URL` — default `https://ollama.com/v1`
- `LLM_API_KEY` or `LLM_API_KEY_FILE` — default file `~/.ollama/api_key`
- `LLM_MODEL` — default `deepseek-v4-pro:0813`

Any OpenAI-compatible endpoint with function calling drops in (a future
Anthropic OpenAI-compat endpoint is a 2-var swap). No SDK — plain `fetch`.

Switch to OpenCode Zen (when its monthly window resets):
`LLM_BASE_URL=https://opencode.ai/zen/go/v1`, `LLM_API_KEY=$OPENCODE_API_KEY`,
`LLM_MODEL=kimi-k3` (or `glm-5.2` etc.).

## Running

```bash
npm run platform:serve                   # http://127.0.0.1:4174 (PORT env to change)
npm run assistant:test                   # mock gate tests + live LLM e2e smoke
ASSISTANT_SMOKE_SKIP=1 npm run assistant:test   # offline: mock tests only
npm run platform:state:reset             # reseed demo data (also clears assistant threads)
```

Parallel instances: set `PORT` and `PLATFORM_DB_PATH` per instance.

## Telegram bridge

`apps/platform/telegram-bridge.js` — zero-dependency long-polling bridge
(raw `fetch`, no webhook needed). It forwards Telegram messages to
`POST /api/assistant/chat` with `sessionId=tg:<chat_id>`, `channel="telegram"`
and, after a contact share, `clientPhone`; replies go back via `sendMessage`
with a typing indicator while the LLM thinks. `/start` sends Maya's canned
honest-AI greeting (no LLM call) with a share-phone keyboard. LLM/server
failures produce a polite fallback that offers the human handoff; `reply: null`
(takeover/escalation) keeps the bot silent while messages still land in the
inbox. The token comes from `TELEGRAM_BOT_TOKEN` only and is scrubbed from
bridge logs.

```bash
npm run assistant:telegram        # run (needs TELEGRAM_BOT_TOKEN + running platform)
npm run assistant:telegram:test   # offline suite vs mock Telegram API (29 checks)
```

Setup from zero (BotFather → .env → systemd): see `README-DEMO.md`.
Only one bridge instance may poll a given token.

## Editing the persona / facts

- Tone, few-shots, rules: `apps/platform/backend/assistant-prompt.js`
- Salon facts (hours, address, parking, policies): `apps/platform/data/salon-faq.json`
  — the only non-database facts Maya may state. Restart the server after edits.
