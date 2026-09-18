# Funnel emulation 2026-09-18

5 salon-owner personas + conversion critic walked landing → signup → wizard → Telegram → pay on a local copy (real model gpt-oss:120b, fake Telegram).

## Verdict

No. None of the 5 simulated salon owners would buy today, and the conversion critic agrees. The self-serve core does work well. Pasting a messy price list gave clean services in 3-5 s for every persona, the team chips were liked, the bot connected with one paste, owner alerts (booking, reschedule, cancel, needs a human) arrived instantly, and medical and forbidden-topic questions were handled safely. That covers roughly the first 70% of the funnel, and it is easy to follow. Three things kill the sale. (1) The landing page sells a different product: a consulting 'AI transformation audit' for medspas with scoped pricing, while the app is a Telegram bot with a 14-day trial. All 6 walkers nearly left on the first screen. (2) Maya is not yet safe to put in front of clients. She answered English and French clients in Russian (5/5 personas), booked staff on their days off and for services they don't do (5/5), failed on real future dates, looped on confirmations, and the price guard blocked correct deposit and 'from $X' price answers. On top of that, owner replies from the inbox never reach the client. (3) There is no price and no way to pay anywhere; step 7 is only a 'Request' button. Telegram as the main channel is a fourth structural objection: all 5 owners say their clients use Instagram, SMS or Booksy/Square, not Telegram. If the price, payment, language, availability and reply-delivery problems were fixed, 4 of 5 personas stated a price they would pay: Olena $49-79, Priya $29-39, Marc $49-79, Anna $149-249 CAD/mo. Jessica would also need Square sync and quotes $99-149. Telegram-only was valued at $15-30/mo. Screenshots I opened confirm the top blockers: conversion-critic/01-home-fold.png (the audit hero fills the whole phone screen), marc-barber/24-preview-chat.png (Russian reply to a French client, 'Русский' toggle, Go live above the test chat), anna-medspa/33-inbox-medical.png ('Luminous Core / Precision OS', 'Sarah J. Manager', a fake VIP 'Client since Mar 2022', Russian confirmation to an English client, Russian labels 'Веб-гость' / 'Настройка' / 'Выйти'), and conversion-critic/41-mobile-keep-request.png (no price; 'Request sent. We will get back to you within one business day'). All screenshot paths are relative to /fast/claude-tmp/claude-1000/-home-llm/c1a173bc-8bf4-44e6-9820-c8d9402d3f0b/scratchpad/funnel/shots/.

## Ranked fixes

### 1. Maya replies in Russian to English/French clients (language leak)  (blocker, maya)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa

Evidence: marc-barber/24-preview-chat.png: French client gets 'Спасибо за номер! Как к вам лучше обращаться...'. anna-medspa/33-inbox-medical.png: English client gets 'Проверяю: HydraFacial Signature у Dr. Anna Lee... Всё верно?'. TG 6002 kept answering in Russian after 'Please answer in English'. Priya TG: 'Вы записаны на 2-недельный фолл у Priya'. Jessica: 'Шлё' for Chloé. Olena: 'Всё верно?' to an English client. Mixed text 'pozwać человека', and an English 'Hi! I'm Maya' glued in front of French replies.

Fix: In the Maya reply pipeline, detect the client language per message (text first, then Telegram language_code, then tenant.language) and pass it as a hard system directive. Remove Russian from the base/system prompt and from the templated confirmations ('Проверяю… Всё верно?' is clearly a hardcoded RU template). Add a post-generation guard: if the reply's script does not match the client's (Cyrillic for an en/fr client), regenerate once, then fall back to an English/French template. Never transliterate staff or client names. Remove the hard-coded English intro prefix. Add regression tests: English-only, French-only and 'please answer in English' conversations.

### 2. Availability ignores staff work days, staff services and salon hours  (blocker, maya)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa

Evidence: Olena: Maya booked Megan for acrylic with Sofia, who doesn't do acrylic, and said 'Суббота у нас закрыта' / 'Wednesday is a closed day' although both days are open. Marc: Karim (saved workDays [tue,wed,thu]) was offered on Sat and Sun. Anna: owner alert '✅ New booking: Olivia Tran — HydraFacial Signature with Dr. Anna Lee, Sat' (Dr. Lee works Wed/Fri, injectables only). Priya: 'For Sunday at 8 am we have...' (closed Sundays); 7am offered with a 9am opening. Jessica: 09:00 offered with a 10:00 opening; Jessica herself offered on a Saturday she doesn't work.

Fix: Compute slots only on the server: intersect salon hours, staff.workDays and staff.services, and require the slot plus service duration to end before closing. The model must only see tool-returned slot IDs. The booking and reschedule tools must reject any slot, staff member or service not in that set, with a structured error Maya can explain ('Karim works Tue-Thu'). Never let the model state 'closed' for a day; take open/closed from the tool. Add fixture tests for each persona's config.

### 3. No price and no way to pay anywhere in the funnel  (blocker, pricing-payment, OWNER DECISION)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: conversion-critic/41-mobile-keep-request.png: 'Request sent. We will get back to you within one business day.' /pricing: 'AIBeaty is scoped to the business, not sold as a one-size subscription.' Olena's note 'Сколько стоит в месяц?' got no answer. Anna: 'I won't forward a we'll-send-you-a-link request to Dr. Lee.'

Fix: Step 7 Plan & extras: replace 'Keep the assistant — Request' with a plan picker showing CAD monthly prices, taxes (GST/HST) and a checkout button (a Stripe Checkout session plus webhook that flips tenant.plan). Show add-on prices inline, e.g. 'Instagram DM +$X/mo, live in 48 h'. Show the same price on /signup and /pricing, with 'month-to-month, cancel anytime'. Until checkout ships: show the price, and after 'Request' say 'we email the payment link within N hours' and send that email automatically.

### 4. Price guard blocks correct answers (deposits, ranges, 'from $X', FAQ amounts) and the address question  (blocker, maya)

Personas: olena-nails, jessica-hair, priya-lashes, conversion-critic

Evidence: Owner alerts 'Maya назвала цену 25/20/220, которой нет в данных инструментов. Ответ заменён.' The wizard's own suggested test question 'How much does Women's cut & style cost?' is answered with 'Let me check that with the owner'. conversion-critic/30-maya.png: balayage takes ~100 s and escalates. After two blocks the conversation is escalated as 'repeated_misunderstanding' and the booking is lost. Priya: 'whats the address first?' triggers 'Maya попыталась подтвердить запись без записи в системе'.

Fix: Build the guard's allow-list from every amount in services (parse ranges '$220–$320', 'from $75', '+$15', '$5/nail') and from all FAQ, deposit and cancellation text. Let Maya quote range and 'from' prices verbatim. Store the deposit amount on the service, not only as a boolean. Scope the fake-confirmation guard to booking-confirmation claims only, not location questions. A blocked answer must not send the conversation to human-only mode, and the same canned line should never be sent twice in a row. Also, in the preview, answer price questions from the services table with a hard ~20 s timeout.

### 5. Owner replies never reach the client (inbox reply not delivered; owner's Telegram treated as a client)  (blocker, telegram)

Personas: olena-nails, priya-lashes, anna-medspa

Evidence: POST /api/platform/inbox/conversations/conv-0003.../messages returns 201, but sent.jsonl has no outbound message to chat 610003; the same happened for chat 55000202 (the pregnant patient). Olena replied to the handoff in the bot chat, and Maya answered her as a client: 'Чи хочете записати вашу доньку...'. Meanwhile Maya promises 'within the hour'.

Fix: (a) When an inbox message is posted to a Telegram conversation, send it through the tenant bot (sendMessage to the stored chat_id) and show delivered/failed status. (b) In the bot, recognise the linked owner chat_id and never route it to Maya. Support reply-to-alert: the owner replies to a '🔔 needs a human' alert and the text is forwarded to that client. Add inline buttons 'Take over' / 'Hand back to Maya'. (c) Make the 'within the hour' promise configurable, or drop it.

### 6. Landing sells a consulting audit; the product is a self-serve bot  (blocker, landing, OWNER DECISION)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: conversion-critic/01-home-fold.png: the first phone screen is 'AI transformation for salons, medspas, and clinics where new leads wait...' in jargon. The only self-serve hint is one all-caps line. The CTAs mostly lead to the audit ('Request scope' ×3, 'Book AI transformation audit'). The FAQ never mentions Telegram, the trial or a price. All personas said they nearly left.

Fix: Rewrite the aibeaty.pages.dev hero using the signup page's message: 'Maya answers your clients and books them tonight. Paste your price list, 14 days free, no card.' One primary CTA, 'Try Maya free'. Add a phone-mockup demo with chips ('How much is a gel manicure?', 'Book me Saturday') and a clip of the price-list import, which is the proven wow moment. Move the audit, Pilot and Scale formats to a secondary 'For groups & medspas' page. Add FAQ entries for price, channels, 'Why Telegram?', Square/Booksy, languages and liability for a wrong price.

### 7. Booking confirmation loops; 'yes' does not commit; French bookings never complete  (blocker, maya)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa

Evidence: Marc TG 6001: 'Oui c'est bon' is followed by 'coupe simple ou coupe + barbe?' repeated for 4 messages, and no booking was made. Olena needed 4 confirmations for 'русский маникюр'. Jessica: 'Yes, perfect' re-asked the service. Priya: 6 messages for one fill, and the name was asked twice. Anna: 'yes' was followed by 'that date has already passed'.

Fix: Keep a server-side booking draft per conversation (service_id, staff_id, slot_id, client name/phone). Treat any affirmative (yes/да/так/oui/ok, including one with an extra question attached) after a summary as commit, and call the booking tool with the stored slot_id. Resolve service names across languages (Russian manicure = 'русский маникюр', Coupe = haircut) to service_id once, and do not re-ask. Store the client's name and phone on the chat and reuse them for reschedule and cancel.

### 8. Date and year resolution breaks future bookings  (blocker, maya)

Personas: anna-medspa, priya-lashes, olena-nails

Evidence: anna-medspa/28-book-3.png: 'Sep 24 2024 is outside our scheduling window'. TG 55000101: 'that date has already passed'. Tomorrow was treated as past ('19 сентября уже прошёл'). Priya: 'next Tuesdays are Sept 20 or Sept 27' (both are Sundays). Friday 19:11 was called 'closed tonight' although the salon is open until 21:00.

Fix: Inject today's date, weekday, year and the tenant's timezone, plus a 14-day date/weekday table, into every turn. The booking tools take slot IDs or server-computed ISO datetimes, never a model-guessed year. Relative dates ('tomorrow', 'next Thursday') are resolved on the server in the tenant's timezone.

### 9. Telegram-first channel does not match North American clients (Instagram/SMS/booking apps)  (major, telegram, OWNER DECISION)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: All personas said their clients are not on Telegram. The landing /services promises 'Instagram and WhatsApp DMs', but the wizard shows Instagram/WhatsApp/SMS as 'Request, we send the price first' (conversion-critic/41-mobile-keep-request.png). The BotFather steps are 3 lines of text (16-wiz-Channels.png).

Fix: Engineering, now: make the shareable web-chat link plus a QR code the hero of step 6 ('Put this in your Instagram bio and Google Business profile', with a copy button). Keep Telegram as an optional advanced channel, add screenshots or a short video of the BotFather steps, and a free 'we set it up for you' button during the trial. Stop advertising channels the trial cannot turn on. Business: decide whether Instagram DM ships as an included default.

### 10. Owner inbox looks like a demo template: fake data, wrong brand, Russian labels, broken on mobile, wrong deep link  (major, trust)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa

Evidence: anna-medspa/33-inbox-medical.png shows 'Luminous Core / Precision OS', 'Sarah J. Manager', VIP 'Client since Mar 2022', 'with Sarah J.', 'Drink Preference', pending@client.local, 'Веб-гость 0202' for Telegram clients, and the labels 'Настройка · Setup' / 'Выйти' / 'Позвать человека'. The URL conversationId=conv-0202 opened Olivia Tran's thread. On a 390 px phone the thread pane is cut off (olena-nails/60-inbox.png, marc-barber/40-owner-inbox.png).

Fix: In unified-inbox-luminous-core.html: show the tenant's name and logo and the logged-in owner, and remove all fixture data (VIP, client-since, drink preference, trends, Apr 17 date, stock avatars). Show 'Telegram client' plus a name. Select the thread from the conversationId query parameter on load. Build a single-pane mobile layout (list, then full-screen thread with a sticky reply box). Localise the labels to the owner's UI language. Tag or hide the owner's own preview-test chats.

### 11. Services step rejects consult-only/Free prices silently, truncates prices, shows 'Saved' on a 422  (major, wizard)

Personas: jessica-hair, anna-medspa, olena-nails, priya-lashes, conversion-critic

Evidence: 422 'The price of "Colour correction consultation" is unclear: "Free"'. The UI only shows a red border while the header says 'Saved' (anna-medspa/15-step2-edited.png, jessica 19-step2-colourcorr.png). Prices are truncated to 30 characters ('$45 (add-on with any colour se', 'from $5/na'). The AI draft itself produces 'complimentary', which the validator then rejects. Background 422s appear while staff is still empty. conversion-critic: drafted rows were lost on reload.

Fix: Accept Free/Complimentary/By consultation. Add a per-service toggle 'Consultation only: don't quote a price, hand to a human'. Remove the 30-character limit, or move qualifiers into a note field, and widen or wrap the price column. Render server validation messages inline, and show 'Not saved' on errors. Save partial drafts without requiring services or staff; validate only at Go live. Persist the AI draft immediately (not debounced), and flush pending saves on add/remove and beforeunload (Anna lost her Answers text this way).

### 12. Double booking: Maya's calendar is separate, and she pretends to look up Square  (major, maya, OWNER DECISION)

Personas: olena-nails, jessica-hair, marc-barber, conversion-critic

Evidence: Jessica TG 5550404: 'share the phone number you used for the Square booking... let me pull up the details' followed by 'I'm not seeing a booking under that number... set up a new appointment?'. Olena and Marc use Google Calendar, paper or Booksy, and sync is only a 'Request' button. The chat footer claims 'Bookings are confirmed in the salon's system'.

Fix: Engineering, now: Maya must never claim access to an external calendar. If a client mentions Square/Booksy/Fresha, she says she can't see it and hands off. Add owner blocking of busy times in the dashboard and via Telegram ('/busy Sat 10-12'). Change the footer text. Business: decide whether Google Calendar sync is included in the trial and which of Square/Booksy/Fresha comes next.

### 13. No trust or legal layer: privacy, terms, company identity, gmail contact, agency footer, no social proof  (major, trust, OWNER DECISION)

Personas: anna-medspa, conversion-critic, jessica-hair

Evidence: /privacy/, /terms/ and /about/ fall back to the home page. The contact is 'Prefer email? ctmakc@gmail.com'. The footer says 'Development & promotion — mmix.ua'. /results says 'representative operating patterns ... not named-client metrics'. There is no terms checkbox on signup. Health details (pregnancy, sertraline) are forwarded into Telegram alerts.

Fix: Add privacy, terms and DPA pages covering PIPEDA/PIPA and data location. Use a business email on the domain, show the legal entity and a Canadian contact, and add a terms checkbox at signup. Remove the agency credit. Add a guarantee/cancellation block. Add a tenant option to redact health details from Telegram alerts (send 'medical question, open inbox' instead of the text). Add social proof once pilots exist.

### 14. Localization: no French, Russian toggle for Canadian users, owner alerts partly in Russian  (major, signup, OWNER DECISION)

Personas: jessica-hair, marc-barber, anna-medspa, priya-lashes, conversion-critic

Evidence: marc-barber/24-preview-chat.png shows the 'Русский' header button. Owner alerts contain Russian ('Резюме Майи', 'Maya назвала цену ...'). The bot's /start reply is English even when language_code is fr. The French handoff phrase 'poser un humain' is wrong. The preview chat UI stays English under a Russian wizard.

Fix: Add an fr-CA UI locale. Language options: EN/FR by default, with Russian/Ukrainian shown only when the browser locale asks for it. Localise the bot /start message by language_code. Send owner alerts in the owner's UI language, with no internal codes such as 'repeated_misunderstanding'. Localise the preview chat widget.

### 15. Client names mistaken for staff; Cyrillic staff names not matched  (major, maya)

Personas: olena-nails, priya-lashes, marc-barber, anna-medspa

Evidence: 'Nadia 289-555-0123' got 'we don't have a stylist by that name'. The same happened with 'Name: Jason Lee' and 'Tanya Morales'. Olena: 'к Ирине' got 'такого мастера у нас нет' although Iryna is on staff.

Fix: Parse the client's name and phone out of the message before matching staff. Only treat a name as staff after 'with/к/avec'. Match staff with transliteration and aliases (Ирина=Iryna), and add an optional alias field in step 3. With one staff member, never ask which staff member.

### 16. Deposit, cancellation and post-booking rules not applied (late cancel, e-Transfer, address after deposit)  (major, maya)

Personas: olena-nails, priya-lashes

Evidence: Megan's late cancel: she was never told the booking was cancelled, never told about the 24h rule, and her last message got no reply; the owner got 3 separate alerts. Priya's booking confirmation had no deposit instructions and no address.

Fix: Always confirm the cancel or reschedule to the client first, then quote the matching policy text from step 4. Add a 'message after booking' template in step 4 (deposit, e-Transfer email, address) that is sent automatically. Merge a conversation's alerts into one readable owner message.

### 17. Preview/test mode is slow and locks after one handoff  (major, wizard)

Personas: jessica-hair, priya-lashes, conversion-critic, marc-barber

Evidence: The first reply took 91-121 s (Jessica, critic). After one escalation the preview shows 'The salon team has this conversation' and Maya stops answering. Reloading the page wipes the preview or returns to step 1.

Fix: In preview, simulate the handoff but keep Maya answering, with a clear 'Reset test chat' button. Warm the model or tools and stream a typing indicator; target a first reply under 10 s. Keep the preview session and the last wizard step across reloads. Greet with the salon's top 3 services and prices so the owner sees her own data at once.

### 18. Go live placement and confirmation  (minor, wizard)

Personas: jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: marc-barber/24-preview-chat.png: Go live sits above the test chat. The launch has no confirmation or checklist. 'Chat on your website — Active' is shown while the header says 'Not live yet'.

Fix: Move Go live below the chat and enable it after at least one test exchange. Add a checklist and a confirmation dialog, then a success screen saying where clients now see Maya. Show 'Ready, activates at Go live' instead of 'Active'.

### 19. Wizard defaults and first impression (red icons, staff days, owner as staff, timezone, medspa type)  (minor, wizard)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: Red (!) icons on unvisited steps (conversion-critic/11-wizard-step1.png). Staff default Tue-Sat ignores the salon hours (Marc had to toggle Sunday for each barber; Priya's Monday was dropped). A solo owner must add herself. Timezone defaults to Eastern for Vancouver; 613 placeholders. No Medspa type. The website field is not reused in step 2. Labels are not linked to inputs.

Fix: Show neutral to-do dots plus progress ('2 of 5, about 6 min left'). Default staff days to the salon's open days. Pre-fill the owner as the first staff member. Detect the timezone from the browser. Add a Medspa/Clinic type with prefilled forbidden topics and consult-only injectables. Reuse the website URL. Use '<label for>' and 'e.g.' placeholders. Flag guessed durations as 'please check'.

### 20. Add-on and per-unit price math  (minor, maya)

Personas: olena-nails

Evidence: 'Гель-манікюр + дизайн на 10 нігтях у нас $50' when the real price is from $100 ($50 + $5/nail × 10).

Fix: Model add-ons and per-unit prices in services, and have the tool compute combos; otherwise answer 'from $X, the design is priced by the tech'.

### 21. Tone/brand-voice control and double self-introduction  (minor, maya)

Personas: jessica-hair, olena-nails, priya-lashes, marc-barber

Evidence: 'I'm the AI, but I know the schedule by heart 🙂'. Maya introduces herself twice (on /start and again in the first reply). She says 'Привет' to a client who wrote 'Здравствуйте'. Medspa staff are called 'stylist'.

Fix: Add a tone section to step 4 (formal/warm, emoji on/off, vous/tu, a sample greeting with preview). Introduce Maya once per conversation. Take the staff noun from the business type (provider, barber, tech).

### 22. Owner alert content and desktop owner link  (minor, telegram)

Personas: olena-nails, jessica-hair, anna-medspa

Evidence: The new-booking alert has no phone number. The reschedule alert does not show the old time. Owner-language and English dates are mixed. Step 6 says 'Tap from your phone' with no QR code on desktop (jessica 43-bot-connected.png, anna 31-bot-connected.png).

Fix: Include the client's phone, old→new time and localised dates in alerts. Show a QR code for the owner deep link on desktop.

### 23. Two brands between landing and app  (minor, landing, OWNER DECISION)

Personas: olena-nails, jessica-hair, priya-lashes, marc-barber, anna-medspa, conversion-critic

Evidence: Landing: serif 'AIBeaty/26' on cream (conversion-critic/01-home-fold.png). App: purple 'M AIbeaty'. Dashboard: 'Luminous Core'.

Fix: Use one wordmark spelling, logo and palette across landing, signup, wizard and dashboard, and introduce Maya on the landing.

### 24. Walk-in and closing-time logic  (minor, maya)

Personas: marc-barber

Evidence: TG 6003: 'sans rendez-vous dimanche 15h45' was answered with morning slots; a 45-min fade at 15:45 would run past the 16:00 close.

Fix: Match walk-in and 'sans rendez-vous' questions to the custom FAQ first, and check that the service duration fits before closing.

## Maya errors

- olena-nails / preview RU: offered Iryna Sat 19 Sep 10:00-16:00 (Iryna works Tue-Fri), then said 'Суббота у нас закрыта' (the salon is open Sat 10-17)
- olena-nails / preview EN: 'Wednesday is a closed day for us. How about Tuesday, Sep 22 with Sofia' (Wednesday is open; Sofia doesn't do acrylic and doesn't work Tuesdays)
- olena-nails / Telegram: BOOKED 'Acrylic full set, мастер Sofia, Sat Sep 19' for Megan Clarke; Sofia doesn't do acrylic
- olena-nails / preview: 'Хочу быть честной: такого мастера у нас нет. В нашей команде Olena, Iryna и Sofia' in reply to 'к Ирине'
- olena-nails / deposit: 'Let me check that with the owner — within the hour' although the $20 deposit is in the FAQ (the guard blocked it)
- olena-nails / late cancel: the client was never told the booking was cancelled or about the 24h rule; 'so do I lose my deposit?' got no reply
- olena-nails / TG client 3: 'Гель-манікюр + дизайн на 10 нігтях у нас $50' (real price from $100), plus a double self-introduction
- olena-nails / owner chat: the owner's reply to a handoff was answered as if she were a client ('Чи хочете записати вашу доньку...')
- olena-nails / TG client 2 (EN): 'price from $85. Всё верно?' (Russian to an English client); a 4-step confirmation loop for 'русский маникюр'
- jessica-hair / preview + TG: 'How much is balayage?', 'How much does Women's cut & style cost?' and the French 'coupe femme senior' all got 'Let me check that with the owner' although the ranges and 'from' prices are in the data
- jessica-hair / preview: colour correction answered in RUSSIAN with 'colour-директором Шлё'
- jessica-hair / preview: 'Root touch-up стоит $95.00, около 60 минут' (Russian to an English client)
- jessica-hair / TG kids cut: answered in Russian; slots '09:00, 10:30, 12:00' before the 10:00 opening; then '10:00 с Джессикой' (Jessica doesn't work Saturdays)
- jessica-hair / TG Square client: 'share the phone number you used for the Square booking... let me pull up the details', then 'I'm not seeing a booking under that number... set up a new appointment?' (pretends to have Square access and invites a double booking)
- jessica-hair / TG FR: English 'Hi! I'm Maya' glued onto French text, and the broken phrase 'dites « poser un humain »'
- priya-lashes / preview: 'I can check tomorrow's 7 am slots' (opens at 9)
- priya-lashes / preview + TG: 'what is the address?' got 'the booking isn't confirmed in our system yet. I've passed this to the owner'; another answer invented 'just a short walk from the main road'
- priya-lashes / preview: 'Volume full set стоит $160.00' (Russian); 'Сегодня вечером уже закрыто' on Friday at 19:11 with Friday hours until 21:00; booked Monday by mistake
- priya-lashes / TG: 'For Sunday at 8 am we have a few lash set options' (closed Sundays)
- priya-lashes / TG: 'the next Tuesdays are Sept 20 or Sept 27' (both are Sundays); final booking confirmation in Russian; asked for the name and phone twice
- priya-lashes / TG: 'Hi! How much is a volume set and do you need a deposit?' got 'Let me check that with the owner' (the $25 deposit was blocked); in the preview Maya then went silent ('salon team has this conversation')
- priya-lashes / TG: 'Nadia 289-555-0123' got 'we don't have a stylist by that name. Our team is Priya'
- priya-lashes / owner reply from the inbox never delivered to Telegram client 610003 after 'Priya will reply here shortly'
- marc-barber / preview: 'Voici trois créneaux disponibles avec Karim ce samedi' and Sunday slots with Karim (he works Tue-Thu); TG 6003: 'Karim a un créneau dimanche à 15 h'
- marc-barber / preview: 'Спасибо за номер! Как к вам лучше обращаться...' to a French client; 'Проверяю: Fade у Карима... на имя Александр' (client name transliterated to Cyrillic)
- marc-barber / TG 6001: 'Vous pouvez dire « pozwać человека »' (Polish plus Russian inside French); endless 'coupe simple ou coupe + barbe?' loop after 'Oui c'est bon', no booking made
- marc-barber / TG 6002: full Russian greeting to an English client with language_code=en; still Russian after 'Please answer in English'; 'Name: Jason Lee' read as a staff name
- marc-barber / preview EN: 'Beard Trim only or Haircut + Beard combo?' asked twice, never booked
- marc-barber / TG 6003: ignored the walk-in FAQ and the 16:00 close for 'sans rendez-vous dimanche 15h45'
- anna-medspa / TG: booked 'HydraFacial Signature with Dr. Anna Lee, Sat Sep 19' (the doctor works Wed/Fri, injectables only); confirmation fully in Russian: 'Вы записаны! Ждём вас 19 сентября...'
- anna-medspa / TG: rescheduled an injectable consult to Sat with Dr. Lee (her day off) and ignored 'does Dr Lee even work Saturdays?'
- anna-medspa / preview: 'Sep 24 2024 is outside our scheduling window'; tomorrow treated as past ('Извините, 19 сентября уже прошёл'); TG: 'that date has already passed'
- anna-medspa / TG: '2 PM with Jenna is open', then 'no openings at 2 PM'; Monday Sep 21 turned into 'September 23'
- anna-medspa / preview + TG: units and per-unit price answers were compliant but in Russian
- anna-medspa / owner reply to the pregnant patient's medical handoff saved (201) but never delivered to Telegram
- conversion-critic / preview: 'How much is balayage and do I need a deposit?' took about 100 s and got 'Let me check that with the owner' (from $220 plus the deposit flag were in the table)
- all personas: Maya promises 'the owner will reply within the hour' on the owner's behalf, with no working channel to keep that promise

## Owner decisions

- Monthly price(s) in CAD. Persona anchors: solo $29-39, 3-4 chair salon or barbershop $49-79, 7-stylist salon $99-149, medspa $149-249; Telegram-only was valued at $15-30. One plan or a Solo/Salon/Pro tier set? Add-on prices for Instagram DM, SMS, WhatsApp and calendar sync?
- Payment method: Stripe Checkout (card, Apple Pay, Google Pay) inside step 7, or invoice/e-Transfer? Monthly only or also annual? Refund or money-back guarantee after the trial?
- Positioning: make the self-serve Maya trial the main landing message and move the 'AI transformation audit' to a secondary page for groups/medspas, or split into two sites?
- Channel priority for North America: ship Instagram DM (Meta app review) as the included default, or lead with the web-chat link/QR for the Instagram bio and keep Telegram as advanced? WhatsApp and SMS order?
- Calendar integration: include Google Calendar sync in the trial? Which booking app comes first (Square, Booksy, Fresha, Vagaro)?
- Languages: add French (fr-CA) now? Hide the Russian toggle for Canadian visitors?
- Brand: one name, spelling and visual identity across landing, app and dashboard (AIBeaty/26 serif vs purple 'M AIbeaty' vs 'Luminous Core')?
- Legal and trust: which legal entity and Canadian contact to show, a business email on the domain instead of ctmakc@gmail.com, whether to remove the 'Development & promotion — mmix.ua' footer credit, a privacy/DPA/data-location statement (PIPEDA/PIPA), and a liability line for wrong prices.
- Offer 'we set up your Telegram bot / Instagram for you' free during the trial?
- Should Maya promise a response window ('within the hour') on the owner's behalf, and should the owner configure it?
- Medspa segment: add a Medspa/Clinic business type with consult-only injectables, and redact health details from Telegram alerts by default?

## Per persona

- **olena-nails: Olena Kovalenko, 41, owner of Olena Nail Studio**: buy=no, ~45 min to live; price: $49–79 CAD/month, and only once it books correctly by master and service, answers the deposit/cancel rules itself, and works in Instagram DM, where my clients are. For Telegram only I would pay $20–30 at most, because few of my Canadian clients use it. Right now I can't even see a price, and 'we'll send a tariff' after a consulting-style landing makes me expect $300+.; would buy today if: A visible price like 'Maya — $59 CAD/month, cancel anytime' with a card button on step 7. Maya never offering a master on her day off or for a service she doesn't do. Deposit and 24h-cancel answers taken from what I typed. Me able to reply to a 'нужен человек' alert right in Telegram. And either Instagram DM included, or Google Calendar sync in the trial so she can't double-book me. If the landing page had just said what the signup page says, I'd have been in from the first screen.
- **Jessica Tremblay, 38, owner of Maison Tremblay Hair (7 styli**: buy=no, ~35 min to live; price: If it spoke my clients' language, quoted my ranges and synced with Square, I'd pay $99–149 CAD/month for 7 stylists. That's less than one lost balayage a month. Today I wouldn't pay anything. I couldn't even see a price: 'Keep the assistant' is only a request button.; would buy today if: A 10-minute demo where:
- Maya answers 'how much is balayage?' with '$220–$320 depending on length and density, final price confirmed by your stylist', in English and proper French.
- She sends colour correction straight to Chloé without a price.
- She reads and writes my Square calendar so nothing double-books.

Then a visible CAD monthly price with a card checkout on the Plan page, a tone setting, and one line in the terms on who is responsible when a price is wrong.
- **priya-lashes: Priya Sharma, 29, runs "Lash by Priya" alone f**: buy=no, ~25 min to live; price: About $29-39 CAD/month, at most $40, the same as my booking app. For that price she has to work inside Instagram DMs, where my clients actually are, and she has to never speak Russian to my clients. Telegram-only is worth maybe $15/month to me because almost none of my clients use it. I would not pay for an audit or setup fee.; would buy today if: A clear $29-39 CAD/month plan I can pay by card inside step 7. Instagram DMs included, or at least a firm price and date for it. Maya always answering in English and stating my deposit and cancellation policy from my FAQ. The deposit and e-Transfer instructions sent automatically after booking, and the address sent only after that. Owner replies (from the inbox or straight from the Telegram alert) that actually reach the client. If one test chat of mine went cleanly from 'how much + deposit?' to a booking, in English, with no handoff, I would pay today.
- **marc-barber: Marc Dubois, 34, owner of Barbier Dubois (Plate**: buy=no, ~20 min to live; price: $0 today. If Maya reliably answered in French, respected each barber's days and synced with Booksy (or at least Google Calendar), I'd pay $49–79 CAD/month for the shop. That's less than one lost fade a week. I'd go higher (~$99) only with Instagram DM and SMS included, because that's where my clients actually are. I won't pay for a price I can't see.; would buy today if: Maya answers only in the client's language (French first for me), offers a barber only on the days he works, and completes a French booking in 3 messages. Show a clear monthly CAD price with a pay button on the Plan step. Add a Booksy or Google Calendar sync so her bookings don't collide with my walk-ins, and ideally Instagram DM included. If a French landing page for barbers showed that in one screenshot, I'd subscribe the same evening.
- **anna-medspa — Grace Park, 45, clinic manager of Lumiere Aest**: buy=no, ~35 min to live; price: If it worked (English, correct providers and days, reliable bookings, owner replies reaching the client, a privacy policy/DPA), I'd pay 149-249 CAD/month, since one booked filler or HydraFacial a week covers it. In its current state: 0 CAD. I can't even see a price, and I won't forward a 'we'll send you a link' request to Dr. Lee.; would buy today if: Three conditions. First, one clean run in the preview: an English HydraFacial booking with Jenna next Thursday that lands on the right day and provider, plus inbox replies that actually reach the client. Second, a visible CAD monthly price with a card checkout in Plan & extras. Third, a one-page privacy/data statement (Canadian hosting, who AIBeaty is, a DPA, an option to keep health details out of Telegram alerts) and a 'Medspa' business type that marks injectables as consultation-only. With all of that, I'd put my card in today.
- **conversion-critic**: buy=no, ~35 min to live; price: A typical 1 to 8 chair Canadian salon owner would pay CAD $49-99/mo for 'answers my Instagram DMs and website and books clients 24/7'. At most CAD $29-49/mo for Telegram + web chat only, because her clients are not on Telegram. She would pay $150-250/mo only when Instagram DM + SMS reminders + Fresha/Square/Vagaro sync work. Today she cannot pay any amount without waiting a business day for a human.; would buy today if: 1) A landing page that matches the product, e.g. 'Maya, your AI front desk: paste your price list, see her answer your clients in 2 minutes', with a live demo in the hero. 2) Visible CAD monthly plans with 'cancel anytime' and a money-back guarantee. 3) Instagram DM (or at least a shareable chat link and QR for the Instagram bio / Google profile) as the default channel instead of a Telegram BotFather token. 4) Maya's first preview answer quoting the owner's own price instantly. 5) A Stripe checkout button inside the trial ('Keep Maya, $79/mo'). Top 10 changes ranked by expected lift: (1) rewrite hero/landing to the self-serve Maya offer with one CTA; (2) publish CAD pricing plus in-app Stripe checkout; (3) make the chat link / Instagram bio / website widget the default go-live channel and make Telegram optional; (4) fix instant, grounded price answers in the preview and fast first response (hard timeout, answer from the services table); (5) add a live demo or 'paste your price list' try-before-signup on the landing; (6) social proof: 2-3 named pilot salons, a Maya video, founder face, domain email, Canadian contact; (7) guarantee and cancellation terms plus a privacy/PIPEDA note; (8) one brand across landing and app, EN/FR instead of the Russian toggle, remove the agency footer; (9) price and ship Instagram DM + SMS reminders + Fresha/Square sync as self-serve add-ons with visible prices; (10) wizard polish: neutral progress instead of red errors, persist the AI draft immediately, keep deposit amounts, a correct 'Active' state and time-left estimates.
