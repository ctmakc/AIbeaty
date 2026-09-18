# Self-serve salons (2026-09-18)

A salon signs up at `/screens/signup.html`, gets a 14-day trial, fills the setup
wizard (`/screens/setup.html`), presses **Go live**, connects its own Telegram bot
from @BotFather and gets bookings/escalations in the owner's Telegram.

Code: `apps/platform/backend/tenancy.js` (sign-up, setup doc, AI price-list import,
plan gate, Telegram webhooks, reminders, trial notices, add-on requests).
Tests: `npm run selfserve:test`.

## Rules baked in
- Clients see Maya only after Go live; before that only the owner (signed-in web
  chat, or the owner's linked Telegram chat) can talk to her.
- Imported prices are a draft; the owner reviews before Go live.
- Trial: `TRIAL_DAYS` (14), `TRIAL_DAILY_TURNS_CAP` (150 LLM turns/day).
- Self-serve salons never email our inbox about their clients; the owner hears
  in Telegram. Sign-ups, go-lives, add-on requests and trial ends email
  `PLATFORM_EMAIL` (falls back to `ALERT_EMAIL`).
- Bot tokens are AES-GCM sealed with a key derived from the session secret;
  webhooks are `/api/telegram/hook/<botId>` with a per-bot secret header.
- Appointments carry `appt_date`; offsets are rebased on the first touch of a new
  salon day (`syncDayAnchor`). The demo salon is exempt.

## Env
`PUBLIC_BASE_URL` (webhook + widget base), `LLM_MODEL` as a comma chain
(prod: `gpt-oss:120b,nemotron-3-super,deepseek-v4-pro:0813`), `TENANCY_TICKER=0`
turns off reminders/notices (tests).

## Ops
    cd /opt/aibeaty && sudo -u aibeaty env $(grep -v '^#' .env | xargs) node scripts/tenants.mjs list
    ... node scripts/tenants.mjs delete <slug>

`/opt/aibeaty/.llm_api_key` must stay owned by `aibeaty` (mode 600): the service
runs as that user. `chown -R root` of the app dir silences Maya.

## Not built yet (requested through "Plan & extras", we quote by hand)
Instagram/Messenger/WhatsApp, SMS, calendar sync (Square/Fresha/Vagaro/Google),
Google review replies, phone calls, payment. Prices are not set anywhere on purpose.
