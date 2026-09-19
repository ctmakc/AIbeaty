# Self-serve salons (2026-09-18)

A salon signs up at `/screens/signup.html`, gets a 14-day trial, fills the setup
wizard (`/screens/setup.html`), tests Maya, presses **Go live**, and shares its
chat link + QR code (Instagram bio, Google Business profile, front desk, website
button). Telegram is optional: the salon's own bot from @BotFather, which also
sends the owner every booking and escalation.

Code: `apps/platform/backend/tenancy.js` (sign-up, setup doc, AI price-list import,
plan gate, Telegram webhooks, reminders, trial notices, add-on requests).
Plans and payment: `apps/platform/backend/billing.js`.
Tests: `npm run selfserve:test` (includes `tests/billing-wizard.test.js` and `tests/handoff.test.js`).

## Plans (owner decision 2026-09-18)
CAD per month, month-to-month, cancel anytime; annual = 10 months billed for 12.
Prices exclude sales tax (HST/GST/QST is added on the invoice). Seller: INNOVA
CONSULT LTD.

| Plan | Price | Staff (guidance, not enforced in the trial) |
|---|---|---|
| Solo | $39 | 1 |
| Salon | $79 | up to 6 |
| Pro | $149 | unlimited; medspa/clinic features; we set everything up |

Add-ons per month: Instagram Direct +$29, WhatsApp +$29, Calendar sync (Google
Calendar / Square / Booksy / Fresha / Vagaro) +$29, SMS reminders +$19 (up to 300
SMS). "We set it up for you" is free during the trial. We connect add-ons within
2 business days.

## How a salon pays (no Stripe today)
1. Step 7: the owner picks a plan + add-ons, sees the total "+ applicable tax" and
   presses **Continue with <plan>** (`POST /api/setup/plan`).
2. The tenant gets `plan_status = 'pending_payment'`, the trial is extended by
   7 days (once), each paid add-on becomes an add-on request, and we get a
   platform notification (`PLATFORM_EMAIL`, and always the service log line
   `[platform] AIbeaty plan request: …`) with plan, add-ons, monthly total and the
   exact activation command.
3. We email the invoice from INNOVA CONSULT LTD (card link or Interac e-Transfer).
4. Paid → `node scripts/tenants.mjs activate <slug> <solo|salon|pro> [addon ...] [--annual]`.
   The owner gets "plan active" in Telegram when their chat is linked.

`node scripts/tenants.mjs plans` prints prices; `... pending` lists salons waiting
on an invoice with their activation commands.

## Stripe Checkout (built, OFF)
Nothing Stripe runs unless these env vars are set on the server:
- `STRIPE_SECRET_KEY` and `STRIPE_PRICE_SOLO` / `STRIPE_PRICE_SALON` / `STRIPE_PRICE_PRO`
  (monthly price ids; `_ANNUAL` suffix for yearly),
- `STRIPE_PRICE_INSTAGRAM_DM`, `STRIPE_PRICE_WHATSAPP`, `STRIPE_PRICE_CALENDAR_SYNC`,
  `STRIPE_PRICE_SMS_REMINDERS` (a choice with an add-on that has no price id falls
  back to the invoice path),
- `STRIPE_WEBHOOK_SECRET` for `POST /api/billing/stripe-webhook` (answers 404 until
  set; verifies `Stripe-Signature`, 5-minute tolerance). Subscribe it to
  `checkout.session.completed`; it activates the plan from the session metadata.
- Optional: `STRIPE_AUTOMATIC_TAX=1` (needs Stripe Tax), `STRIPE_API_BASE` (tests).
With keys set, "Continue" still marks the tenant pending and extends the trial,
then redirects to Checkout. There is no Stripe account today; creating one is the
owner's call.

## Languages
Owner UI (sign-up, wizard) in English and French (fr-CA); Russian is offered only
when the browser language is ru/uk. The choice is saved on the tenant
(`PUT /api/setup/language`, `tenants.language` = en|fr|ru) and drives validation
messages and owner alerts. Maya answers in the client's language.

## Rules baked in
- Clients see Maya only after Go live; before that only the signed-in owner's
  web test chat can talk to her. The owner's linked Telegram chat never reaches
  Maya: a reply to an alert is forwarded to that alert's client
  (`tenant_alert_messages` maps alert message_id → conversation), any other
  message gets a help text.
- Owner answers (inbox or Telegram reply) are stored with `author = 'staff'` and
  `delivery`: Telegram clients get them through the salon bot (`delivered` /
  `failed` + reason); web chat clients fetch them from the public
  `/api/assistant/updates` (own `web-<uuid>` session only) → `waiting` → `seen`.
- Owner alerts: tenant language (en/fr/ru), client name + phone, old → new time,
  no internal codes; events for one conversation within `OWNER_ALERT_DELAY_MS`
  (1500) are one message, and a second "needs you" within 60 s is dropped.
  Medspa/clinic salons get no client text in alerts.
- Handoff / takeover: Maya stays out of the thread, but every client message
  gets a holding line in the client's language (first one, then at most every
  15 min, `HANDOFF_HOLDING_MS`) and the owner gets "💬 <client> wrote again (N
  new messages)" (one per conversation per 5 min, `OWNER_WAITING_ALERT_MS`;
  messages in between are sent with the next alert, never dropped; medspa: no
  client text). The inbox shows the count and a **Let Maya continue** button;
  a thread with no staff answer for 12 h (`HANDOFF_AUTO_RETURN_MS`) goes back
  to Maya by itself (ticker, inbox load or the client's next message).
- Test chats: the owner's preview, the web chat opened while signed in and the
  owner's linked Telegram chat never lock after a handoff (Maya adds a test
  note in the chat's language and keeps answering). Their bookings get
  `appointments.is_test = 1` + a "Test" tag: they hold no real slot, stay out
  of revenue, digest and reminders, alerts say `[Test chat]`, and they are
  deleted at Go live and by **Reset test chat** (`POST /api/setup/test-chat/reset`).
- Reply guards: a time Maya offers must come from the last availability
  result for that day or be free in the calendar right now (else she offers
  real free times); a bare weekday that names today after closing means next
  week; years other than this/next in a reply are corrected; "yes, but
  <question>" commits and answers only the question.
- Self-serve owners opening `/screens/unified-inbox-luminous-core.html` get
  `screens/inbox.html` (their real threads only); the demo salon keeps the console.
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

## Price texts in the services step
Owners write prices the way they say them, up to 60 characters: `$65`, `from $75`,
`$220–$320`, `+$15`, `$5/nail`, `Free`, `By consultation` (and fr/ru equivalents).
All are accepted and quoted verbatim. A per-service **Consultation only** switch
makes Maya never quote a price for it and hand the client to the team. Business
type **Medspa / clinic** pre-fills forbidden topics (medical advice, dosing,
pregnancy), marks injectables consultation-only in its starter menu and sets
`assistant.healthPrivacy` (medical questions always go to a person).

## Not built yet (tell-me-when-ready requests)
Facebook Messenger, Google review replies, phone calls.
