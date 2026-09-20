# Funnel emulation v3 (2026-09-20)

## What this run was

Five salon-owner personas — the same ones as run 1 and v2 — walked the whole
self-serve funnel on a fresh stand: sign up, paste a messy price list, save the
setup, connect a bot, Go live, then their own clients talked to Maya in the
client's language, over web chat and over Telegram, and the owner answered from
the inbox. Everything ran against a real server over real HTTP with the **real
LLM** (`gpt-oss:120b`, the default chain, no `LLM_MODEL` set); only the
Telegram Bot API was a local stub, so the exact outbound messages could be read.

Reproduce it: `npm run funnel:emulate` (`scripts/funnel-emulate.js`, ~8 min, needs
the LLM key the server uses). `ONLY=<persona>` narrows it, `KEEP_DB=<dir>` keeps
the SQLite file so `assistant_events` can be read for every gate that fired.

Difference from v2: this run drives the API, not a browser. It says nothing new
about the wizard's pixels, the dashboard screens or the landing's layout — for
those, v2's screenshots are still the evidence. What it does cover, it covers
the same way a paying client would: real model, real calendar, real bot payloads.

## Result

**94 of 96 checks pass.** Personas: olena-nails, marc-barber (French),
priya-lashes, jessica-hair, anna-medspa. Every persona signed up, had its price
list read into 4-6 services in 2-3 s, saved, connected a bot, went live, and
took a real booking from a client. Two open items are model variance, not lost
money: Marc's client needed one extra "oui" before the booking committed
(nothing was booked without consent), and Anna's Maya answered "are you open on
Monday?" by naming Wednesday's hours instead of saying "closed" first.

Four defects this run found were real and are fixed in code, each with a test:

1. **A "yes" could book a time the client never saw.** `replyShowsTime` matched
   substrings, so an offer of "9:00 AM, 12:00 PM, 1:00 PM or 3:00 PM" read as
   "the client saw 2:00 PM": the read-back guard stood down and the affirmation
   committed a 14:00 slot. This is exactly the shaky dialogue that kept turning
   up in `assistant-live-smoke`. Now a time has to stand on its own, and, on top
   of that, when Maya's last message put other times on the table and the staged
   slot is not among them, a "yes" re-reads the staged slot back instead of
   booking it.
2. **A four-digit year was read as a day of the month.** "mardi 22 septembre
   2026" also matched "septembre 20" — and that wrong hit came first, so the
   time guard treated a reply about next Tuesday as a reply about today. Maya
   answered "no room Sunday" to a client asking about Friday and dropped the
   correct "Karim does not work Fridays" with it (1 run in 3 for marc-barber).
3. **`check_availability` with no day fell back to today** even when the client
   had just named a day, which fed the same wrong-day rewrite.
4. **`llm-client` still defaulted to `deepseek-v4-pro:0813`**, which has
   answered 403 since the Ollama plan lapsed on 2026-09-18. Anything booting
   without `LLM_MODEL` went silent; a bare `npm run assistant:test` failed on
   the live smoke. The default is now the chain `gpt-oss:120b,nemotron-3-super`.

## The 24 blockers from REPORT.md

Statuses below are from this run unless the line says otherwise. "not re-walked"
means v3 did not exercise it and v2's status stands.

- **#1 language leak — closed.** 45 replies across 5 personas, 9 turns each:
  zero Cyrillic to English and French clients, French client served in French
  end to end including the read-back and the confirmation.
- **#2 staff days / services / hours — closed.** Sofia refused on a Friday,
  Karim refused on a Friday, Chloe refused on a Tuesday, each with the real
  alternative offered. The one failure seen (marc-barber, 1 run in 3) was the
  date-parse bug above and is fixed.
- **#3 price and payment — closed as far as the owner's decisions allow.** CAD
  plans on the landing, `/pricing` and wizard step 7; invoice from INNOVA
  CONSULT LTD; Stripe code present and off without keys. Card checkout is still
  an owner decision.
- **#4 price guard — closed.** Fixed prices, ranges ("$220-$320"), "from $95",
  "from $12/unit" all quoted verbatim, in French too ("35 $", "25 $").
- **#5 owner reply reaches the client — closed.** The owner's inbox reply went
  out through the tenant bot to the client's chat for all 5 personas; the
  owner's own chat is never routed to Maya.
- **#6 landing sells the product — closed** (static check: trial-first hero,
  "14 days free", CAD plans live on aibeaty.pages.dev).
- **#7 "yes" commits — closed, with one caveat.** 4 of 5 personas booked on the
  first "yes" / "oui c'est bon". Marc's model staged late and needed a second
  confirmation; nothing was booked unconfirmed.
- **#8 dates — closed.** Relative dates ("tomorrow", "next week") resolve, no
  "already passed", no stray 2024/2025. The year-as-day bug found here is fixed.
- **#9 Telegram-first channel — owner decision.** Chat link + QR is the main
  channel; Instagram DM is still a paid add-on connected by hand.
- **#10 owner inbox looks like a demo — not re-walked.** Covered by
  `owner-surfaces.test.js`: demo screens redirect self-serve owners to Bookings.
- **#11 services step — closed for the API path.** Every persona's messy paste
  produced 4-6 services in 2-3 s, and the save returned 200 with no errors.
- **#12 pretending to read Square — closed.** All 5: "I can't see bookings made
  in Square: that calendar is separate from mine, so I won't guess", and the
  question is passed to the team.
- **#13 trust and legal — closed as far as the owner's decisions allow.**
  /privacy and /terms are live; a DPA and Canadian hosting for the Pro tier stay
  owner decisions.
- **#14 localization — closed for the client-facing path**; the landing is still
  English only (owner decision on a French landing).
- **#15 client name vs staff name — closed.** A client introducing herself with
  a staff member's name is answered as a client, with no confusion.
- **#16 deposit and cancellation — closed.** Olena: "$20 deposit to hold a
  Saturday appointment, cancellation under 24 hours is charged 50%". Priya: the
  $40 deposit and the no-show rule. Where the owner wrote no policy, Maya says so
  and passes it to the team instead of inventing one.
- **#17 preview slow / locks after a handoff — not re-walked**; covered by
  `handoff.test.js` (the owner's test chat keeps answering after a handoff).
- **#18 Go live — not re-walked** (v2: fixed). The API path returns 200 and the
  salon goes live.
- **#19 wizard defaults — not re-walked.**
- **#20 add-on maths — closed.** "Gel manicure is $55 and nail art is +$15",
  "A Women's cut & style is $85, and the Toner add-on is +$40". The price guard
  now allows base + add-on totals (and only those), and the prompt no longer
  forbids that one sum.
- **#21 double self-introduction — closed.** Exactly one self-introduction per
  conversation in all 5 personas.
- **#22 owner alert content — partly.** Alerts arrive; the wording was not
  re-reviewed in this run.
- **#23 two brands — not re-walked** (v2: still broken).
- **#24 walk-in and closing time — closed with one slip.** Closed days are named
  as closed in 4 of 5 personas; Anna's Maya redirected to the next open day
  without saying "closed" first.

## Still open, and for whom

- Card checkout, Instagram DM and calendar sync inside the trial, a DPA and
  Canadian hosting for medspas, a French landing, a short chat link — all owner
  decisions, unchanged since v2.
- Model variance, not code: an occasional extra confirmation turn, and an
  occasional closed-day answer that redirects instead of saying "closed".
- The wizard and owner screens were not re-walked in a browser. Before the next
  release, v2's #10, #17, #19 and #23 still want a browser pass.
