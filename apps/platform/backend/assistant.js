// Maya — conversational AI layer for the AIbeaty platform demo.
//
// Design law: the LLM is untrusted. Every guarantee the demo makes is enforced
// here in code, not in the prompt:
//   - prices/slots/staff only from tool results (quote-guard on the final reply)
//   - "вы записаны" only after a successful DB write (booking-claim gate)
//   - read-back before commit (two-phase state machine inside book/reschedule/cancel)
//   - auto-escalation triggers + takeover flag silence the bot
//   - per-session rate limit
const fs = require("fs");
const path = require("path");
const { buildSystemPrompt } = require("./assistant-prompt");
const language = require("./maya-language");
const dates = require("./maya-dates");
const rules = require("./maya-rules");
const { detectLanguage, resolveTurnLanguage, replyLanguageMismatch, languageName } = language;

const MAX_TOOL_ROUNDS = 6;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
// Per-IP guards (untrusted sessionId can be rotated to defeat the per-session cap).
const IP_RATE_LIMIT_MAX = Number(process.env.ASSISTANT_IP_RATE_LIMIT || 40);
const BOOKING_QUOTA_MAX = Number(process.env.ASSISTANT_BOOKING_QUOTA || 5);
const BOOKING_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
// Channels where the caller's identity is server-verified (e.g. an authenticated
// staff console, or telephony that supplies a trusted caller-id). ONLY on these
// channels may Maya disclose or act on a returning client's data from a phone.
// The public webchat is never verified, so a client-supplied phone there is not
// treated as proof of ownership. Empty by default → fail closed everywhere.
const VERIFIED_CHANNELS = new Set(
  String(process.env.ASSISTANT_VERIFIED_CHANNELS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const SLOT_STEP_MINUTES = 30;
const HISTORY_LIMIT = 16;

// Per-weekday opening hours (0=Sunday … 6=Saturday), minutes since midnight.
// null = closed. These defaults mirror salon-faq.json and are the HARD FLOOR
// for every offered and committed slot; faq.hours (if present) overrides them.
const DEFAULT_OPENING_HOURS = {
  0: null,                // Sunday — closed
  1: null,                // Monday — closed
  2: [9 * 60, 19 * 60],
  3: [9 * 60, 19 * 60],
  4: [9 * 60, 19 * 60],
  5: [9 * 60, 19 * 60],
  6: [10 * 60, 17 * 60]   // Saturday opens later
};

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

function buildOpeningHours(faqHours) {
  const hours = {};
  for (let weekday = 0; weekday < 7; weekday++) {
    const src = faqHours ? faqHours[String(weekday)] : undefined;
    if (src === null) { hours[weekday] = null; continue; }
    const open = src ? parseHHMM(src.open) : null;
    const close = src ? parseHHMM(src.close) : null;
    hours[weekday] = (open !== null && close !== null && close > open)
      ? [open, close]
      : DEFAULT_OPENING_HOURS[weekday];
  }
  return hours;
}

function minutesLabel(minutes) {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- salon timezone ---------------------------------------------------------
// The server may run on a UTC box while the salon lives in another timezone.
// Every "what day/time is it" decision uses the salon's zone, carried in
// salon-faq.json (salon.timezone), defaulting to America/Toronto (Ottawa).
const DEFAULT_TIMEZONE = "America/Toronto";

function resolveTimezone(candidate) {
  const value = String(candidate || "").trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch (error) {
    return DEFAULT_TIMEZONE;
  }
}

function tzDateString(date, tz) {
  // en-CA renders as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function tzMinutesOfDay(date, tz) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number((parts.find((part) => part.type === "hour") || {}).value || 0) % 24;
  const minute = Number((parts.find((part) => part.type === "minute") || {}).value || 0);
  return hour * 60 + minute;
}

function digitsOnly(value) {
  return String(value || "").replace(/\D+/g, "");
}

// --- escalation triggers (checked in code, before/independent of the LLM) ---
const TRIGGERS = [
  { reason: "explicit_request", hard: true, re: /(позов[иі]те|позвать|зовите|позови|покличте|покликати|поклич)\s+(человека|людину|менеджера|адміністратора|администратора)|живо[йг]о? человек|жив(у|ою) людин|хочу (поговорить|говорить) с человеком|соедините с|talk to a human|(talk|speak|chat) (to|with) (a |an |some )?(person|human|real person|someone)|real person|human,? please|speak (to|with) (a )?(human|person|manager|someone real)|передай(те)? человеку|parler (à|a|avec) (un|une|quelqu'un|quelqu’un)( (humain|vrai|vraie|personne|conseill|employ))?|un(e)? (vrai(e)? )?(humain|personne r[ée]elle)|^\s*(human|humain|person|une personne|человек|человека|людина|людину|оператор|operator|agent)\s*[.!]*\s*$/i },
  { reason: "medical", hard: true, re: /жжени|жж[её]т|печ[её]т|аллерги|алерг|беремен|вагітн|зуд|сыпь|свербіж|висип|ожог|опік|раздражение кожи|подразнення|кожа болит|allerg|pregnan|burn(ing|ed|s)?\b|rash|itch|scalp (pain|hurts)|chemical reaction|enceinte|grossesse|allaite|br[uû]l(ure|e|ait)|d[ée]mang|rougeur|irritation|eczéma|eczema|m[ée]dicament|antid[ée]presseur|sertraline|botox.*(enceinte|pregnan)/i },
  // Post-treatment complications: a medspa client describing one must reach a
  // human at once, never "would you like me to connect you?" (funnel emulation
  // 2026-09-19: swollen, hard, bluish lip after filler was not handed off).
  { reason: "medical", hard: true, re: /swell|swollen|bluish|turn(ing|ed)? (blue|purple|white|gr[ae]y)|purpl(e|ish) (skin|lip|patch)|blanch|numb|tingl|blurr?(y|ed) vision|can'?t see|vision (loss|problem)|blister|pus\b|infect|fever|bleed|severe pain|really hurts|hurts a lot|lump|nodule|necros|droop|enfl[ée]|gonfl|bleu(â|a)tre|violac|engourd|picote|vision floue|saign|infect|fi[èe]vre|douleur (forte|intense)|опух|отёк|отек|набряк|сине(ет|ют|ть)|посине|онеме|оніміл|кров(ит|оточ)|гно|нагно|температур|зрени|зір|шишк|уплотнен|ущільн/i },
  { reason: "complaint", hard: false, re: /испортил|зіпсував|сожгли|спалили|ужасн|жахлив|отвратительн|кошмар|верн[иу]те (мне )?деньги|возврат денег|повернить гроші|жалоб|скарг|плохо (по)?(стригли|красили)|ruined|terrible|awful|worst|complain|refund|botched|plainte|rembours|catastroph|rat[ée] ma|g[aâ]ch[ée]/i },
  { reason: "price_dispute", hard: false, re: /слишком дорого|почему так дорого|это грабёж|занадто дорого|чому так дорого|too expensive|overpriced|rip[- ]?off|why so expensive|trop cher|c'est du vol/i },
  { reason: "frustration", hard: false, re: /да что (ж|же|такое)|сколько можно|это ужас(?!н)|бесит|задолбал|ненавижу|wtf|ridiculous|are you kidding|!{3,}/i }
];

function checkTriggers(text) {
  for (const trigger of TRIGGERS) {
    if (trigger.re.test(String(text || ""))) return trigger;
  }
  return null;
}

// Affirmation vs rejection for the read-back commit step. Safety order:
// a rejection or a correction always wins (a false negative only re-asks
// once; a false positive would commit without consent). A message that
// STARTS with a clear yes counts even with a question attached
// ("Yes, and do I need a deposit?"); the question is answered after the commit.
const AFFIRM_BOUND = "[\\s,.!;:()«»\"'”—–-]";
const AFFIRM_REJECTION_RE = new RegExp(
  `(^|${AFFIRM_BOUND})(нет|ні|no|nope|not|non|pas|не|don'?t|do not|never|stop|wait|attends|attendez|стоп|подожди(те)?|погоди(те)?|постой(те)?|зачекай(те)?|отставить|передумал[аио]?|передумала?|передумав|annule[rz]?)(?=$|${AFFIRM_BOUND})`, "i");
const AFFIRM_WORD_RE = new RegExp(
  `(^|${AFFIRM_BOUND})(да|ага|угу|конечно|давай(те)?|подтверждаю|верно|точно|именно|разумеется|ок|окей|хорошо|добро|yes|yep|yeah|yup|ya|yas|sure|ok|okay|k|confirm(ed)?|correct|right|exactly|absolutely|perfect|great|sounds good|that works|works for me|all good|da|так|авжеж|звісно|добре|вірно|підтверджую|oui|ouais|ouaip|ouep|yep|parfait|d'accord|dac|daccord|exact|exactement|volontiers|bien s[uû]r|[cç]a marche|[cç]a me va|c'est bon|c'est parfait|c'est correct|entendu|nickel|go)(?=$|${AFFIRM_BOUND})`, "i");
// The same words, but only at the very start of the message.
const LEADING_AFFIRM_RE = new RegExp(
  `^\\s*(да|ага|угу|конечно|давай(те)?|подтверждаю|верно|точно|ок|окей|хорошо|добре|так|звісно|авжеж|yes|yep|yeah|yup|sure|ok|okay|perfect|great|sounds good|that works|absolutely|correct|da|oui|ouais|ouep|parfait|d'accord|exact|exactement|bien s[uû]r|[cç]a marche|[cç]a me va|c'est bon|c'est parfait|c'est correct)(?=$|${AFFIRM_BOUND})`, "i");
// A yes followed by a change is not consent to the read-back.
const AFFIRM_CORRECTION_RE = /(^|[\s,.;:!-])(but|mais|но|але|instead|plutôt|plutot|actually|en fait|change|changer|другое|другой|другую|інший|іншу|rather|except|sauf|кроме|крім)(?=$|[\s,.;:!?-])/i;
// Imperative / first-person-plural action verbs count as consent too:
// «отменяем», «отменяй(те)», «переносите», «записывайте», «скасовуйте», "cancel it".
const AFFIRM_ACTION_RE = /(отменя(ем|й|йте|ю)|отмен(и|ите)(?=$|[\s,.!])|убира(ем|й|йте)|убер(и|ите)(?=$|[\s,.!])|скасов(уємо|уй|уйте)|скасуй(те)?|перенос(им|и|ите|ьте)|перенес(и|ите|іть|емо)(?=$|[\s,.!])|запис(ывай|ывайте|ываем|уй|уйте|уємо)|оформля(й|йте|ем)|оформи(те)?(?=$|[\s,.!])|бронируй(те)?|броню(й|йте)|cancel (it|that|the appointment|my appointment)|please cancel|go ahead|do it|proceed|book it|book me|r[ée]serve[zr]?(-le| le| moi|-moi)?(?=$|[\s,.!])|allez-y|vas-y|on y va|confirme[zr]?)/i;

// "yes, but what about my deposit?" / "да, но где парковка?" is consent plus a
// side question. A "but" clause is a CHANGE only when it is not a question or
// when it names another time, day or option ("yes but can we do 3 instead?").
const CHANGE_MARKER_RE = /(\d|instead|rather|plutôt|plutot|change|changer|другое|другой|другую|друго[мй]|інш|except|sauf|кроме|крім|earlier|later|plus tôt|plus tard|раньше|позже|раніше|пізніше|another|autre|перенес|move|déplac|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|понедельник|вторник|сред[уа]|четверг|пятниц|суббот|воскресень|завтра|понеділ|вівтор|серед[уа]|четвер|п.ятниц|субот|неділ)/i;
function sideQuestionOnly(rest) {
  const value = String(rest || "");
  const marker = AFFIRM_CORRECTION_RE.exec(value);
  if (!marker) return true;
  const tail = value.slice(marker.index);
  const sentences = tail.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
  if (!sentences.length) return false;
  return sentences.every((part) => {
    if (!AFFIRM_CORRECTION_RE.test(part)) return true;
    return /\?/.test(part) && !CHANGE_MARKER_RE.test(part);
  });
}

function isAffirmation(text) {
  const value = String(text || "").trim().toLowerCase().replace(/[’]/g, "'");
  if (!value) return false;
  const leading = LEADING_AFFIRM_RE.exec(value);
  if (leading) {
    // "Yes, and is there parking?" → consent; "yes but at 3" / "oui mais plutôt samedi" → not.
    const rest = value.slice(leading[0].length);
    // "Верно ли…?", "Correct?", "Oui?" are questions, not consent.
    if (/^\s*[?)!.…]*\s*$/.test(rest) && /\?/.test(rest)) return false;
    if (/^\s*(ли|чи)(?=$|[\s,?])/i.test(rest)) return false;
    if (AFFIRM_CORRECTION_RE.test(rest) && !sideQuestionOnly(rest)) return false;
    if (/^[\s,.!]*(no|non|нет|ні|not|pas)(?=$|[\s,.!?])/i.test(rest)) return false;
    // A rejection word inside the affirmative clause itself ("да нет", "yes no").
    const firstClause = rest.split(/[?.!]/)[0];
    if (/(^|[\s,])(не|нет|ні|no|not|don'?t|pas|non)(?=$|[\s,])/i.test(firstClause) && !/\?/.test(rest)) return false;
    return true;
  }
  if (/\?\s*[)!.…]*$/.test(value)) return false; // a question is never consent
  if (AFFIRM_REJECTION_RE.test(value)) return false;
  if (AFFIRM_WORD_RE.test(value)) return true;
  if (AFFIRM_ACTION_RE.test(value)) return true;
  if (/(вс[её]|all)\s*(верно|правильно|вірно|correct|good|right)/i.test(value)) return true;
  if (/(tout est|c'est tout) (bon|correct|parfait)/i.test(value)) return true;
  if (/подтвержда|підтверджу|confirm/i.test(value)) return true;
  return false;
}

// The part of an affirmative message after the yes, when it carries a
// question for Maya ("Yes! Do I need a deposit?" → "Do I need a deposit?").
function affirmationRemainder(text) {
  const value = String(text || "").trim();
  const leading = LEADING_AFFIRM_RE.exec(value.toLowerCase().replace(/[’]/g, "'"));
  let rest = (leading ? value.slice(leading[0].length) : value).replace(/^[\s,.!;:—–-]+/, "").trim();
  // "yes cancel. but what about my deposit?" → "what about my deposit?"
  const action = new RegExp(`^(?:${AFFIRM_ACTION_RE.source})`, "i").exec(rest);
  const bare = /^(please\s+)?(cancel|book|confirm|move|reschedule|annule[zr]?|d[ée]place[zr]?)(\s+(it|that|me|le|la))?(?=$|[\s,.!;])/i.exec(rest);
  if (action || bare) rest = rest.slice((action || bare)[0].length).replace(/^[\s,.!;:—–-]+/, "").trim();
  rest = rest.replace(/^(but|and|mais|et|но|и|а|але|і|та)(?=\s)\s*,?\s*/i, "").trim();
  if (!rest) return "";
  if (/\?/.test(rest) || rest.split(/\s+/).length >= 4) return rest;
  return "";
}

// --- reply gates ---
const BOOKING_CLAIM_RE = /(vous [êe]tes (bien )?(inscrit|r[ée]serv|book)|c'est r[ée]serv[ée]|rendez-vous (est )?(confirm[ée]|r[ée]serv[ée]|annul[ée]|d[ée]plac[ée])|j'ai (bien )?(r[ée]serv[ée]|annul[ée]|d[ée]plac[ée]) votre|вы записан|вас записал|записала? (вас|тебя)|запись (создана|подтверждена|оформлена|перенесена|отменена)|перен[её]сла ваш|отменила ваш|вас записано|запис (створено|підтверджено|перенесено|скасовано)|you'?re (all )?(booked|set)|booked you|booking (is )?confirmed|appointment (is )?(booked|confirmed|cancell?ed|rescheduled)|i('| ha)ve booked)/i;

const BANNED_REPLACEMENTS = [
  [/нет проблем/gi, "конечно"],
  [/к сожалению,?\s*/gi, ""],
  [/на жаль,?\s*/gi, ""],
  [/согласно нашей политике/gi, "у нас так заведено"],
  [/как ии,?\s*я/gi, "я"],
  [/as an ai(,|\s+language model)?,?\s*/gi, ""],
  [/i hope this message finds you well[.,!]?\s*/gi, ""],
  [/unfortunately,?\s*/gi, ""],
  [/malheureusement,?\s*/gi, ""]
];

const PRICE_IN_REPLY_RE = /\$\s?\d{1,5}(?:[.,]\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?\s?(?:\$|долл|доллар|CAD|кан\.?\s?долл|dollars?)/gi;

function extractPriceNumbers(text) {
  const found = [];
  const matches = String(text || "").match(PRICE_IN_REPLY_RE) || [];
  for (const match of matches) {
    const num = Number(String(match).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(num)) found.push(num);
  }
  return found;
}

// Said to a client who writes while a person handles the thread (first
// message, then at most every HOLDING_INTERVAL_MS).
const HOLDING_REPLY = {
  en: "Thanks — I've passed this to the salon team; they'll reply here as soon as they can.",
  fr: "Merci, j'ai transmis votre message à l'équipe du salon. Elle vous répondra ici dès que possible.",
  ru: "Спасибо, я передала это команде салона. Вам ответят здесь, как только смогут.",
  uk: "Дякую, я передала це команді салону. Вам дадуть відповідь тут, щойно зможуть."
};

// Added under a handoff in the salon owner's own test chat (it never locks).
const TEST_HANDOFF_NOTE = {
  en: "(Test chat: a real client's conversation would now wait for your team, and you would get an alert. Here Maya keeps answering so you can go on testing.)",
  fr: "(Clavardage test : avec un vrai client, la conversation attendrait maintenant votre équipe et vous recevriez une alerte. Ici, Maya continue de répondre pour que vous puissiez poursuivre le test.)",
  ru: "(Тестовый чат: с настоящим клиентом переписка теперь ждала бы вашу команду, а вам пришло бы оповещение. Здесь Майя продолжает отвечать, чтобы вы могли тестировать дальше.)",
  uk: "(Тестовий чат: зі справжнім клієнтом розмова тепер чекала б на вашу команду, а вам надійшло б сповіщення. Тут Майя відповідає далі, щоб ви могли продовжити тест.)"
};

// Canned replies, one per supported language. Maya never promises a response
// time on the salon's behalf: "the salon team will reply here as soon as they can".
const FALLBACKS = {
  unknown: {
    ru: "Это уточню у команды салона, вам ответят здесь, как только смогут. Пока могу подобрать удобное время для визита?",
    uk: "Це уточню в команди салону, вам дадуть відповідь тут, щойно зможуть. Поки можу підібрати зручний час для візиту?",
    en: "Let me check that with the salon team. They will reply here as soon as they can. Meanwhile, want me to find you a good time to come in?",
    fr: "Je vérifie ça avec l'équipe du salon, on vous répondra ici dès que possible. En attendant, voulez-vous que je vous trouve un moment pour venir?"
  },
  notBooked: {
    ru: "Хочу быть честной: запись ещё не подтверждена в системе. Я передала вопрос команде салона, вам ответят здесь, как только смогут.",
    uk: "Хочу бути чесною: запис ще не підтверджено в системі. Я передала питання команді салону, вам дадуть відповідь тут, щойно зможуть.",
    en: "To be honest with you, the booking isn't confirmed in our system yet. I've passed this to the salon team. They will reply here as soon as they can.",
    fr: "Pour être honnête, la réservation n'est pas encore confirmée dans notre système. J'ai transmis votre demande à l'équipe du salon, on vous répondra ici dès que possible."
  },
  handoff: {
    ru: "Конечно, передаю разговор человеку. Команда салона ответит вам здесь, как только сможет; я им всё пересказала.",
    uk: "Звісно, передаю розмову людині. Команда салону відповість вам тут, щойно зможе; я все їм переказала.",
    en: "Of course, I'm handing this over to a person. The salon team will reply here as soon as they can; I've already passed everything along.",
    fr: "Bien sûr, je transmets la conversation à une personne de l'équipe. Le salon vous répondra ici dès que possible; je leur ai déjà tout résumé."
  },
  error: {
    ru: "У меня на секунду пропала связь с системой записи. Я оставила команде салона заметку, вам ответят здесь, как только смогут.",
    uk: "У мене на мить зник зв'язок із системою запису. Я залишила команді салону нотатку, вам дадуть відповідь тут, щойно зможуть.",
    en: "I lost my connection to the booking system for a moment. I've left a note for the salon team. They will reply here as soon as they can.",
    fr: "J'ai perdu la connexion au système de réservation un instant. J'ai laissé une note à l'équipe du salon, on vous répondra ici dès que possible."
  },
  // The reply-language guard's last resort: the model could not answer in the
  // client's language twice in a row.
  rephrase: {
    ru: "Я могу записать вас, перенести или отменить визит и ответить на вопросы об услугах и ценах. Что вам удобнее?",
    uk: "Я можу записати вас, перенести чи скасувати візит і відповісти на питання про послуги та ціни. Що вам зручніше?",
    en: "I can book, move or cancel a visit and answer questions about services and prices. What would you like to do?",
    fr: "Je peux réserver, déplacer ou annuler un rendez-vous et répondre à vos questions sur les services et les prix. Qu'est-ce qui vous conviendrait?"
  }
};

// The same canned line is never sent twice in a row: the second time the
// client hears this instead.
const UNKNOWN_AGAIN = {
  en: "I've noted that for the salon team, and they will answer it here. Is there anything else I can help with meanwhile, like prices or a time to come in?",
  fr: "C'est noté pour l'équipe du salon, on vous répondra ici. Est-ce que je peux vous aider avec autre chose en attendant, comme les prix ou un moment pour venir?",
  ru: "Я записала это для команды салона, вам ответят здесь. Чем ещё могу помочь пока: цены, свободное время?",
  uk: "Я записала це для команди салону, вам дадуть відповідь тут. Чим ще можу допомогти поки: ціни, вільний час?"
};

// A booking made in another app (Square, Booksy, Fresha…): Maya cannot see
// it and says so, then hands the thread to a person.
const EXTERNAL_BOOKING_REPLY = {
  en: (app) => `I can't see bookings made in ${app}: that calendar is separate from mine, so I won't guess. I'm passing this to the salon team so they can check it, and they will reply here as soon as they can.`,
  fr: (app) => `Je ne vois pas les réservations faites dans ${app} : ce calendrier est séparé du mien, alors je préfère ne pas deviner. Je transmets votre message à l'équipe du salon pour qu'elle vérifie, on vous répondra ici dès que possible.`,
  ru: (app) => `Я не вижу записи, сделанные в ${app}: этот календарь отдельный от моего, поэтому гадать не буду. Передаю ваш вопрос команде салона, чтобы они проверили; вам ответят здесь, как только смогут.`,
  uk: (app) => `Я не бачу записів, зроблених у ${app}: цей календар окремий від мого, тож вгадувати не буду. Передаю ваше питання команді салону, щоб перевірили; вам дадуть відповідь тут, щойно зможуть.`
};

// Lead-ins for the owner's own policy text after a cancel / move / booking.
const POLICY_LEAD = {
  cancel: { en: "Our cancellation policy:", fr: "Notre politique d'annulation :", ru: "Правила отмены в салоне:", uk: "Правила скасування в салоні:" },
  deposit: { en: "About the deposit:", fr: "Pour le dépôt :", ru: "О депозите:", uk: "Про депозит:" }
};

// "On Wednesday we're open 10:00-19:00." — the replacement for a sentence
// that called an open day closed.
const OPEN_DAY_LINE = {
  en: (day, hours) => `On ${day} we're open ${hours}.`,
  fr: (day, hours) => `Le ${day}, nous sommes ouverts de ${hours.replace("-", " à ")}.`,
  ru: (day, hours) => `В ${day} мы работаем ${hours}.`,
  uk: (day, hours) => `У ${day} ми працюємо ${hours}.`
};

// A reply that promises when the team will answer. Maya never does that on
// the salon's behalf; only sentences about replying are touched, so a fact
// like "send the deposit within 12 hours" stays.
const REPLY_VERB_RE = /(reply|respond|get back|answer|contact you|in touch|hear back|call you|répond|reviendr|recontact|contacter|ответ|свяж|перезвон|напишут|відпов|зв'яж|зв’яж|передзвон)/i;
const TIME_PROMISE_RES = [
  [/\b(within|in)\s+(the\s+next\s+|the\s+|an?\s+|one\s+|a\s+few\s+|\d+\s*)?(hours?|minutes?|mins?|business days?|days?)\b/gi, { en: "as soon as they can" }],
  [/\b(shortly|very soon|right away|in no time)\b/gi, { en: "as soon as they can" }],
  [/dans (l'|l’)heure( qui suit)?|dans les \d+ (minutes|heures)|dans quelques (minutes|heures)|dans la journée|sous peu|très bientôt|rapidement|bientôt/gi, { en: "dès que possible" }],
  [/в течение (часа|получаса|дня|\d+ (минут|часов|часа)|пары часов|нескольких (минут|часов))|в ближайш(ее время|ий час)/gi, { en: "как только смогут" }],
  [/протягом (години|дня|\d+ (хвилин|годин))|найближчим часом|незабаром/gi, { en: "щойно зможуть" }]
];
function scrubTimePromises(reply) {
  let changed = false;
  const out = rules.sentences(reply).map((sentence) => {
    if (!REPLY_VERB_RE.test(sentence)) return sentence;
    let value = sentence;
    for (const [re, pack] of TIME_PROMISE_RES) {
      re.lastIndex = 0;
      if (re.test(value)) {
        re.lastIndex = 0;
        value = value.replace(re, pack.en);
        changed = true;
      }
    }
    return value;
  });
  return changed ? out.join(" ") : reply;
}

// A question attached to a "yes" that Maya could not answer.
const FOLLOWUP_PENDING = {
  en: "About your other question: I've passed it to the salon team, and they will reply here as soon as they can.",
  fr: "Pour votre autre question : je l'ai transmise à l'équipe du salon, on vous répondra ici dès que possible.",
  ru: "По вашему второму вопросу: я передала его команде салона, вам ответят здесь, как только смогут.",
  uk: "Щодо вашого другого питання: я передала його команді салону, вам дадуть відповідь тут, щойно зможуть."
};

// The slot is free and only the client's name is missing.
const NAME_ASK = {
  en: "That time is free. What name should I put the booking under?",
  fr: "Ce moment est libre. À quel nom dois-je faire la réservation?",
  ru: "Это время свободно. На какое имя вас записать?",
  uk: "Цей час вільний. На яке ім'я вас записати?"
};

// Daily spend cap reached: graceful, language-matched, zero LLM involved.
const CAP_REPLY = {
  ru: "Майя сегодня наговорилась — напишите нам, и человек ответит. Ваше сообщение уже у команды салона, вам ответят здесь.",
  uk: "Майя сьогодні наговорилася — напишіть нам, і людина відповість. Ваше повідомлення вже в команди салону, вам дадуть відповідь тут.",
  en: "Maya has talked her fill for today — leave us a message and a person will reply. Your note is already with the salon team; you'll hear back right here.",
  fr: "Maya a beaucoup parlé aujourd'hui : laissez-nous un message et une personne vous répondra. Votre message est déjà transmis à l'équipe du salon, la réponse arrivera ici."
};

function localized(pack, lang) {
  return pack[lang] || pack.en;
}

// --- first-turn AI disclosure (code-enforced backstop for the prompt rule) ---
const FIRST_TURN_INTRO = {
  ru: "Здравствуйте! Я Майя, ИИ-ассистентка салона.",
  uk: "Вітаю! Я Майя, ШІ-асистентка салону.",
  en: "Hi! I'm Maya, the salon's AI assistant.",
  fr: "Bonjour! Je suis Maya, l'assistante IA du salon."
};
// \b does not work for Cyrillic, so boundaries are spelled out.
const DISCLOSURE_AI_RE = /(^|[^а-яёіїєґa-z0-9])(ии|ші|ai|ia)([^а-яёіїєґa-z0-9]|$)|искусственн|штучн|artificial|artificielle|virtual assistant|assistante virtuelle|виртуальн|віртуальн/i;
const LEADING_GREETING_RE = /^(привет|здравствуйте|добрый день|добрый вечер|доброе утро|вітаю|добрий день|добрий вечір|привіт|bonjour|bonsoir|salut|allô|allo|hi there|hi|hello|hey|good (morning|afternoon|evening))[!,.\s]+/i;

function hasAiDisclosure(reply) {
  return /(майя|maya|майї|майю|майи|майей|майєю)/i.test(String(reply || "")) && DISCLOSURE_AI_RE.test(String(reply || ""));
}

function withFirstTurnIntro(reply, lang) {
  const intro = localized(FIRST_TURN_INTRO, lang);
  const rest = String(reply || "").replace(LEADING_GREETING_RE, "").trim() || String(reply || "").trim();
  return `${intro} ${rest}`.trim();
}

// --- complaint turn: the CLIENT-facing reply must carry all three beats -----
// (feeling named, one sincere apology, a concrete next step).
const COMPLAINT_BEAT_RES = [
  /(обидно|неприятно|досадно|расстро|огорч|понимаю( вас|, как| тебя)?|слышу вас|прикро|чую вас|засмучен|сумно|frustrating|upsetting|awful|i hear you|i understand|so sorry|je comprends|d[ée]cevant|frustrant|d[ée]sol[ée]e? de (lire|savoir))/i,
  /(прости|извин|перепрошу|вибач|мені шкода|мне жаль|sorry|apolog|d[ée]sol[ée]|excuse|pardon)/i,
  /(передала|передаю|передам|ответ|відповід|напиш|reply|get back|in touch|passed|passing|r[ée]pond|transmis|transmets)/i
];
const COMPLAINT_REPLY = {
  ru: "Слышу вас — это правда обидно, простите нас. Я уже всё передала владельцу, команда салона ответит вам здесь, как только сможет. Спасибо, что рассказали.",
  uk: "Чую вас — це справді прикро, вибачте нас. Я вже все передала власнику, команда салону відповість вам тут, щойно зможе. Дякую, що розповіли.",
  en: "I hear you, that's genuinely upsetting, and I'm sorry. I've passed everything to the owner, and the salon team will reply to you right here as soon as they can. Thank you for telling us.",
  fr: "Je vous entends, c'est vraiment décevant, et je suis désolée. J'ai tout transmis à la propriétaire, l'équipe du salon vous répondra ici dès que possible. Merci de nous l'avoir dit."
};

function complaintBeatsPresent(reply) {
  return COMPLAINT_BEAT_RES.every((re) => re.test(String(reply || "")));
}

// --- escalation alert emails (categories shown in the owner's inbox) --------
const ALERT_CATEGORIES = {
  medical: "медицина",
  complaint: "жалоба",
  explicit_request: "просьба человека",
  assistant_requested: "передача человеку",
  repeated_misunderstanding: "непонимание",
  price_dispute: "спор о цене",
  frustration: "недовольство",
  owner_message: "сообщение владельцу",
  external_booking: "запись в другой системе"
};
const ALERT_THROTTLE_MS = 10 * 60 * 1000;
const ALERT_TIMEOUT_MS = 5000;

// --- service / stylist / day / time resolution -----------------------------
// Salon-agnostic. A "concept" regex covers how CLIENTS phrase a service in
// ru/uk/en AND how a salon is likely to NAME it, so the same table resolves
// "хочу балаяж" against "Full Balayage", "Балаяж" or "Balayage & Toner"
// without any salon's service list being compiled into the engine.
// Order matters: specific concepts first, generic last (the first concept that
// matches any of the salon's own services wins).
const SERVICE_CONCEPTS = [
  { id: "balayage", re: /балаяж|balayage|air ?touch|аиртач|аір ?тач|шатуш|омбре|ombre|sombre/i },
  { id: "highlights", re: /мелирован|мелірув|highlight|блики|babylights/i },
  { id: "root_touchup", re: /корн[еия]|коріння|root|тониров|тонуван|toner|touch[- ]?up|отраст/i },
  { id: "keratin", re: /кератин|keratin|нанопласт|ботокс для волос|ботокс волосся/i },
  { id: "hair_treatment", re: /уход за волос|догляд за волосс|маска для волос|olaplex|восстановлен(ие)? волос|відновлен/i },
  { id: "extensions", re: /наращивание волос|нарощення волосс|hair extensions/i },
  // (?<![a-z]) — otherwise "Women's Precision Cut" matches the men's concept.
  { id: "mens_cut", re: /мужск|чоловіч|(?<![a-z])men'?s|барбер|barber|борода|бороду|beard/i },
  { id: "kids_cut", re: /детск|дитяч|kids?'? ?(hair)?cut|ребёнк|дитин/i },
  { id: "womens_cut", re: /женск|жіноч|women'?s|ladies'?|precision/i },
  { id: "blowout", re: /укладк|укладу|blowout|blow[- ]?dry|styling|зачіск|локон|кудр|curls?/i },
  { id: "haircut", re: /стрижк|подстри|підстри|hair\s?cut|\bcut\b|постриг/i },
  { id: "color", re: /окраш|окрас|покрас|фарбуван|colou?r|краск|краси(ть|т)|перекрас/i },
  { id: "manicure", re: /маникюр|манікюр|manicure|ногт|нігт|nails?|гель[- ]?лак|shellac|покрытие ногтей/i },
  { id: "pedicure", re: /педикюр|педікюр|pedicure/i },
  { id: "brows", re: /бров|брів|brow|ламинирование бровей/i },
  { id: "lashes", re: /ресниц|вій|вії|lash|наращивание ресниц/i },
  { id: "makeup", re: /макияж|макіяж|make[- ]?up|визаж/i },
  { id: "waxing", re: /депиляц|депіляц|шугаринг|sugaring|wax(ing)?|воск/i },
  { id: "facial", re: /чистка лица|уход за лицом|догляд за обличч|facial|космето|пилинг|пілінг|peel/i },
  { id: "massage", re: /масса?ж|масаж|massage/i },
  { id: "spa", re: /\bspa\b|\bспа\b|обёртыван|обгортанн/i }
];

// Cyrillic → Latin, so a client writing "Елена" finds a stylist stored as
// "Elena" (and vice versa) without any per-salon alias table.
const TRANSLIT = {
  а:"a",б:"b",в:"v",г:"g",ґ:"g",д:"d",е:"e",є:"ye",ё:"e",ж:"zh",з:"z",и:"i",і:"i",
  ї:"yi",й:"i",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",
  х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"
};

function translit(value) {
  return String(value || "").toLowerCase().split("").map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch)).join("");
}

// Spelling-insensitive key for a person's name across alphabets and accents:
// "Ирина"/"Ірина"/"Iryna"/"Irina" → "irin", "Карима"/"Karim" → "karim",
// "Александр"/"Alexandre" → "aleksandr", "Chloé" → "chlo".
function foldName(value) {
  let folded = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  folded = translit(folded);
  return folded
    .replace(/[^a-z]/g, "")
    .replace(/x/g, "ks")
    .replace(/ph/g, "f")
    .replace(/w/g, "v")
    .replace(/kh/g, "h")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1");
}

function nameKey(value) {
  const folded = foldName(value);
  const stripped = folded.replace(/[aeiou]+$/, "");
  return stripped.length >= 3 ? stripped : folded;
}

// --- client identity in free text ------------------------------------------
// "Name: Jason Lee", "Nadia 289-555-0123", "my name is Chloé", "je m'appelle
// Alexandre", "меня зовут Анна". Parsed BEFORE any staff matching, so a
// client's own name is never mistaken for a staff member.
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}|\+\d[\d\s().-]{8,16}\d/;
const NAME_WORD = "[\\p{Lu}][\\p{L}'’-]+";
const NAME_PATTERNS = [
  new RegExp(`(?:^|[\\s,.;!])(?:name|full name|nom|nom complet|имя|ім'я|ім’я|фио)\\s*[:=–—-]\\s*(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`, "iu"),
  // Lead phrase in any case; the name itself must be capitalised (checked below).
  new RegExp(`(?:^|[\\s,.;!])(?:my name is|my name's|name is|this is|i am|i'm|i’m|je m'appelle|je m’appelle|je suis|moi c'est|moi c’est|mon nom est|меня зовут|мене звати|моё имя|моє ім'я|на имя|на ім'я|under the name|au nom de)\\s+([\\p{L}'’-]+(?:\\s+[\\p{L}'’-]+){0,2})`, "iu"),
  new RegExp(`(?:^|[.!]\\s+)я\\s*[—–-]?\\s+(${NAME_WORD}(?:\\s+${NAME_WORD})?)(?=$|[\\s,.!])`, "u")
];
const NOT_A_NAME_RE = /^(maya|майя|hi|hello|hey|bonjour|salut|привет|здравствуйте|вітаю|yes|oui|да|так|no|non|нет|ok|okay|looking|interested|available|free|here|ready|new|back|late|coming|going|calling|writing|a|an|the|client|cliente|клиент|клієнт|хочу|буду|могу|можу|записал|записан|не|already|désolée?|intéressée?|disponible|pr[êe]te?|en|là|la|sur|at|in|on|from|with)$/i;

// A time of day in a client's message: "2pm", "2 PM", "14:00", "14h", "10h30",
// "à 10 h", "в 14:00". Returns minutes since midnight or null.
function parseClientTime(text) {
  const value = String(text || "").toLowerCase();
  let match = value.match(/(?:^|[^\d:])(\d{1,2})(?::|h|\s?h\s?)(\d{2})(?!\d)\s*([ap]\.?m\.?)?/);
  if (match) {
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = (match[3] || "").replace(/\./g, "");
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    if (hours < 24 && minutes < 60) return hours * 60 + minutes;
  }
  match = value.match(/(?:^|[^\d:])(\d{1,2})\s*([ap])\.?m\.?(?![a-z])/);
  if (match) {
    let hours = Number(match[1]);
    if (match[2] === "p" && hours !== 12) hours += 12;
    if (match[2] === "a" && hours === 12) hours = 0;
    return hours < 24 ? hours * 60 : null;
  }
  match = value.match(/(?:^|[^\d:])(\d{1,2})\s?h(?![a-z\d])/);
  if (match && Number(match[1]) < 24) return Number(match[1]) * 60;
  return null;
}

// Clock times a reply names ("2:30 PM", "14:00", "14 h 30", "5pm", "17h").
// Each hit carries every reading it can have: a bare "3:30" in a salon is
// 3:30 PM as often as it is 3:30 AM. The end of a range ("10:00 - 11:00")
// is not an offer and is skipped.
function replyTimes(text) {
  const value = String(text || "");
  const hits = [];
  const add = (index, length, hours, minutes, meridiem) => {
    if (hours > 23 || minutes > 59) return;
    let options;
    if (meridiem === "p") options = [(hours % 12 + 12) * 60 + minutes];
    else if (meridiem === "a") options = [(hours % 12) * 60 + minutes];
    else if (hours >= 1 && hours <= 7) options = [hours * 60 + minutes, (hours + 12) * 60 + minutes];
    else options = [hours * 60 + minutes];
    if (hits.some((hit) => index < hit.index + hit.length && hit.index < index + length)) return;
    hits.push({ index, length, raw: value.slice(index, index + length), options });
  };
  const patterns = [
    [/(?<![\d$€£:.,/])(\d{1,2})(?::|\s?h\s?)(\d{2})(?!\d)(?:\s*([ap])\.?\s?m\b\.?)?/gi, (m) => (/h/i.test(m[0]) && Number(m[1]) < 8 && !m[3] ? null : [Number(m[1]), Number(m[2]), (m[3] || "").toLowerCase()])],
    [/(?<![\d$€£:.,/])(\d{1,2})\s*([ap])\.?\s?m(?![a-z])\.?/gi, (m) => [Number(m[1]), 0, m[2].toLowerCase()]],
    [/(?<![\d$€£:.,/])(\d{1,2})\s?h(?![\p{L}\d])/giu, (m) => (Number(m[1]) >= 8 ? [Number(m[1]), 0, ""] : null)]
  ];
  patterns.forEach(([re, read]) => {
    let match;
    while ((match = re.exec(value)) !== null) {
      const parts = read(match);
      if (parts) add(match.index, match[0].length, parts[0], parts[1], parts[2]);
    }
  });
  hits.sort((a, b) => a.index - b.index);
  return hits.filter((hit, i) => {
    const prev = hits[i - 1];
    if (!prev) return true;
    const between = value.slice(prev.index + prev.length, hit.index);
    return !/^\s*(-|–|—|to|until|till|à|au|jusqu'à|до|по)\s*$/i.test(between);
  });
}

// The model asking the client to confirm a booking it never staged with the
// tool. The server then stages it from the draft and sends the real read-back.
const SELF_CONFIRM_RE = /(shall i (book|go ahead)|should i book|want me to (book|lock|confirm)|(can|may) i (book|confirm)|confirm\s*\?|is that (right|correct)\s*\?|does that work\s*\?|sound good\s*\?|vous confirmez|je confirme|on confirme|je (vous )?r[ée]serve|je peux r[ée]server|[cç]a vous va\s*\?|c'est bon pour vous|всё верно\s*\?|все верно\s*\?|записываю\s*\?|записать вас|подтверждаете|підтверджуєте|записую\s*\?|все вірно\s*\?)/i;

// Names the engine invents for a conversation before it knows the client.
function isPlaceholderName(name) {
  return /^(веб-гость|web guest|web client|client web|guest|invité|invitée|гость|гість|telegram client|client telegram|клиент telegram)(\s|$)/i.test(String(name || "").trim());
}

function parseClientIdentity(text) {
  const value = String(text || "").trim();
  const result = { name: "", phone: "" };
  const phoneMatch = value.match(PHONE_RE);
  if (phoneMatch && digitsOnly(phoneMatch[0]).length >= 10) result.phone = phoneMatch[0].trim();
  for (const pattern of NAME_PATTERNS) {
    const match = value.match(pattern);
    if (!match) continue;
    const words = [];
    for (const word of match[1].split(/\s+/)) {
      if (!/^\p{Lu}/u.test(word) || NOT_A_NAME_RE.test(word) || WEEKDAYS.some((day) => day.re.test(word))) break;
      words.push(word);
    }
    if (words.length) { result.name = words.join(" "); break; }
  }
  if (!result.name && result.phone) {
    // "Nadia 289-555-0123" / "289-555-0123 Nadia Brown": the words next to the phone.
    const rest = value.replace(phoneMatch[0], " ").replace(/[,;:()]/g, " ").trim();
    const words = rest.split(/\s+/).filter(Boolean);
    const nameLike = new RegExp(`^${NAME_WORD}$`, "u");
    if (words.length >= 1 && words.length <= 3 && words.every((word) => nameLike.test(word) && !NOT_A_NAME_RE.test(word))) {
      result.name = words.join(" ");
    }
  }
  if (!result.name) {
    // A bare "First Last" as the whole message (answering "what's your name?").
    const bare = value.replace(/[.!]+$/, "").trim();
    if (new RegExp(`^${NAME_WORD}\\s+${NAME_WORD}$`, "u").test(bare) && !bare.split(/\s+/).some((word) => NOT_A_NAME_RE.test(word) || WEEKDAYS.some((day) => day.re.test(word)))) {
      result.nameCandidate = bare;
    }
  }
  return result;
}

function escapeRe(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WEEKDAYS = [
  { index: 0, re: /воскресень|неділ|sunday|dimanche|\bsun\b/i },
  { index: 1, re: /понедельник|понеділок|monday|lundi/i },
  { index: 2, re: /вторник|вівторок|tuesday|mardi|\btue\b/i },
  { index: 3, re: /среда|среду|середа|середу|wednesday|mercredi|\bwed\b/i },
  { index: 4, re: /четверг|четвер|thursday|jeudi|\bthu\b/i },
  { index: 5, re: /пятниц|п'ятниц|п’ятниц|friday|vendredi|\bfri\b/i },
  { index: 6, re: /суббот|субот|saturday|samedi|\bsat\b/i }
];

// --- unknown-stylist gate: names the client uses for staff must exist in the
// stylists table BEFORE the model is allowed to affirm or praise them. --------
const STYLIST_MENTION_PATTERNS = [
  // "мастер Наталья", "к мастеру наталье", "стилист Оксана", "майстер Олена"
  /(?:мастер|майстер|майстр|стилист|стиліст|парикмахер|перукар)[а-яёіїєґ]{0,3}\s+(?:по имени\s+|на ім'?я\s+)?([А-ЯЁІЇЄҐа-яёіїєґ][а-яёіїєґ'’-]{2,})/gi,
  // "к Наталье", "у Натальи", "до Наталі" (capitalized only — bare prepositions are too noisy otherwise)
  /(?:^|[\s,.!?—-])(?:к|у|до)\s+([А-ЯЁІЇЄҐ][а-яёіїєґ'’-]{2,})/g,
  // "наталья меня всегда стрижёт / красит"
  /([А-ЯЁІЇЄҐа-яёіїєґ][а-яёіїєґ'’-]{2,})\s+(?:меня|мене)\s+(?:всегда\s+|завжди\s+|обычно\s+|зазвичай\s+)?(?:стриж|стриг|подстриг|підстриг|крас|фарбу)/gi,
  // English/French: "with Natalie", "see Natalie", "stylist Natalie", "avec Karim", "chez Chloé"
  /(?:with|to see|see|stylist|barber|avec|chez)\s+([A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'-]{2,})(?:\s|[,.!?]|$)/g
];

// Words that look like names in the patterns above but are never stylists.
const STYLIST_NAME_STOPWORDS = /^(майя|maya|она|оно|вона|він|кто-то|хтось|вам|вас|вами|вашей|вашему|тебе|тебя|тобой|меня|мне|мной|нам|нас|нами|ним|ней|нему|неё|нее|него|них|ними|привет|здравствуйте|спасибо|дякую|будь\s?ласка|пожалуйста|hello|thanks|today|tomorrow|name|nom|merci|bonjour|salut|demain|oui|sure|please|сегодня|завтра|сьогодні|обед\w*|утр\w*|вечер\w*|январ\w*|феврал\w*|март\w*|апрел\w*|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*|січн\w*|лют\w*|берез\w*|квітн\w*|травн\w*|червн\w*|липн\w*|серпн\w*|вересн\w*|жовтн\w*|листопад\w*|грудн\w*|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

// Stem that survives Russian/Ukrainian declension: "Наталье"/"Наталью"/"Натальи" → "наталь".
function nameStem(name) {
  const lower = String(name || "").toLowerCase().replace(/['’-]+$/g, "");
  const stripped = lower.replace(/[аеёиіїоуыэюяь]+$/g, "");
  return stripped.length >= 3 ? stripped : lower;
}

// Praise/affirmation the model must never attach to a nonexistent stylist.
const STYLIST_PRAISE_RE = /отличн|прекрасн|замечательн|великолепн|потрясающ|лучш|чудов|найкращ|классн|супер|great|amazing|wonderful|fantastic|excellent|awesome|the best|конечно!|of course!/i;

// Markers of an honest correction ("no such stylist") in the reply.
const STYLIST_CORRECTION_RE = /такого (мастера|майстра|стилиста|стиліста)|(мастера|майстра) (с именем|по имени|на ім'?я)? ?[«"']?[\wа-яёіїєґ'’-]* ?[»"']? ?(у нас )?(нет|немає)|в нашей команде нет|в нашій команді немає|не работает у нас|у нас не працює|у нас (нет|немає) (мастера|майстра)|don'?t have (a |any )?stylist|no stylist (named|called)|isn'?t (on|part of) (our|the) (team|staff)|not on (our|the) (team|staff)|n'?avons pas de (coiffeu|barbier|styliste|membre|personne)|pas dans (notre|l'?) ?[ée]quipe|ne travaille pas (chez nous|ici)/i;

// Self-serve hooks (all optional, see backend/tenancy.js):
//   onEvent(salonId, type, payload)   every assistant event after it is stored —
//                                     tenancy turns bookings/escalations into a
//                                     Telegram message to the salon owner.
//   alertEmailFor(salonId)            which inbox gets formsubmit alerts for this
//                                     salon ("" = none). Default: ALERT_EMAIL for
//                                     every salon, the pre-self-serve behaviour.
//   dailyTurnsCapFor(salonId)         per-salon daily LLM turn cap (trial plans
//                                     get a smaller one); falls back to the global cap.
//   isTestSession(salonId, sessionId) the salon owner's own test chat (wizard
//                                     preview, web chat opened while signed in):
//                                     a handoff there never locks Maya, and its
//                                     bookings are flagged test.
//   busyBlocksFor(salonId, date, staffId)  owner-blocked busy time on that salon
//                                     day ([{start_minutes, end_minutes}]); treated
//                                     like a booking by every availability check.
function createAssistant({ store: rootStore, llm, faqPath, clock, alertEmail, alertFetch, alertLinkBase, dailyTurnsCap, onEvent, alertEmailFor, dailyTurnsCapFor, languageFor, isTestSession: isTestSessionHook, busyBlocksFor } = {}) {
  const db = rootStore.db;
  const clockNow = typeof clock === "function" ? clock : () => new Date();
  // Alert emails: off unless ALERT_EMAIL is set (env or option). No secrets —
  // formsubmit.co relays to the configured inbox.
  const ALERT_EMAIL = alertEmail !== undefined ? String(alertEmail || "") : String(process.env.ALERT_EMAIL || "");
  const ALERT_LINK_BASE = String(alertLinkBase || process.env.ALERT_LINK_BASE || "https://aibeaty.remolda.com").replace(/\/+$/, "");
  // formsubmit.co silently refuses POSTs without a browser Origin/Referer (HTTP 200
  // + success:"false", no email) — send the activated site's origin explicitly.
  const ALERT_ORIGIN = String(process.env.ALERT_ORIGIN || "https://aibeaty.pages.dev").replace(/\/+$/, "");
  const alertHttp = alertFetch || ((...args) => fetch(...args));
  const alertLastSent = new Map(); // conversationId → last alert ms (in-memory throttle)
  const rateBuckets = new Map();   // `${salonId}:${sessionId}` / `${salonId}:ip:${ip}` → recent turn timestamps
  const bookingBuckets = new Map(); // `ip:${ip}` / `sid:${sessionId}` → recent booking timestamps

  function isVerifiedChannel(channel) {
    return VERIFIED_CHANNELS.has(String(channel || "").trim().toLowerCase());
  }

  // Canonical national number: exact-match only, no suffix/partial matching, so
  // callers cannot enumerate clients with fragments of a phone number.
  function normalizePhone(value) {
    let digits = digitsOnly(value);
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1); // drop NA country code
    return digits;
  }
  // Spend guard: hard cap on LLM turns per salon-timezone day (shared Ollama
  // Cloud quota protection). One "turn" = one chat() invocation that reached
  // the LLM; hard triggers, canned and silenced turns never count.
  const capCandidate = Number(dailyTurnsCap !== undefined ? dailyTurnsCap : process.env.ASSISTANT_DAILY_TURNS_CAP);
  const GLOBAL_TURNS_CAP = Number.isFinite(capCandidate) && capCandidate > 0 ? Math.floor(capCandidate) : 400;
  const ALERT_EMAIL_DEFAULT = ALERT_EMAIL;
  // While a person handles a conversation, a client who writes again hears a
  // short holding line at most this often, and the thread returns to Maya by
  // itself after this long without a staff answer.
  const envMs = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const HOLDING_INTERVAL_MS = envMs("HANDOFF_HOLDING_MS", 15 * 60 * 1000);
  const AUTO_RETURN_MS = envMs("HANDOFF_AUTO_RETURN_MS", 12 * 60 * 60 * 1000);

  // ---------------------------------------------------------------------------
  // Everything below is per-salon. `store` inside this scope is the SALON-SCOPED
  // store, so every store call this file already made stays correct while
  // reading and writing only this salon's rows. Hours, timezone, FAQ, services
  // and staff all come from the salon's own record — nothing about the original
  // demo salon is baked into the engine.
  // ---------------------------------------------------------------------------
  function createSalonAssistant(salonId) {
    const store = rootStore.forSalon(salonId);
    if (!store) throw new Error(`unknown salon: ${salonId}`);
    const salonCap = typeof dailyTurnsCapFor === "function" ? Number(dailyTurnsCapFor(salonId)) : NaN;
    const DAILY_TURNS_CAP = Number.isFinite(salonCap) && salonCap > 0 ? Math.floor(salonCap) : GLOBAL_TURNS_CAP;
    const ALERT_EMAIL = typeof alertEmailFor === "function" ? String(alertEmailFor(salonId) || "") : ALERT_EMAIL_DEFAULT;

    // Tests may pin a FAQ file; production reads the salon's stored record,
    // which the intake importer wrote.
    function loadFaq() {
      if (faqPath) return JSON.parse(fs.readFileSync(faqPath, "utf8"));
      const record = rootStore.getSalonRecord(salonId) || {};
      return {
        salon: {
          name: record.name || salonId,
          city: record.city || "",
          timezone: record.timezone || "",
          phone: record.phone || "",
          email: record.email || "",
          address: record.address || ""
        },
        hours: record.hours || {},
        topics: (record.faq && record.faq.topics) || []
      };
    }

    const faq = loadFaq();
    const OPENING_HOURS = buildOpeningHours(faq.hours);
    const TIMEZONE = resolveTimezone(faq.salon && faq.salon.timezone);
    const SALON_NAME = (faq.salon && faq.salon.name) || salonId;
    // Words that look like a stylist name but are this salon's own nouns
    // (its name, its city) — computed, never hardcoded to one salon.
    const SALON_WORD_STOPWORDS = String(`${SALON_NAME} ${(faq.salon && faq.salon.city) || ""}`)
      .split(/[^\p{L}]+/u)
      .filter((word) => word.length >= 3)
      .map((word) => word.toLowerCase());
    function salonMinutesNow() {
      return tzMinutesOfDay(clockNow(), TIMEZONE);
    }

    function salonDayString(date) {
      return tzDateString(date || clockNow(), TIMEZONE);
    }

    // ---------- opening hours (hard floor for offered AND committed slots) ----------
    function hoursForOffset(offset) {
      return OPENING_HOURS[dayWeekday(offset)] || null;
    }

    function hoursLabelForOffset(offset) {
      const window = hoursForOffset(offset);
      return window ? `${minutesLabel(window[0])}-${minutesLabel(window[1])}` : "closed";
    }

    function nextOpenOffset(fromOffset) {
      for (let offset = fromOffset + 1; offset <= fromOffset + 7; offset++) {
        if (hoursForOffset(offset)) return offset;
      }
      return fromOffset + 1;
    }

    // Same-day floor: today's slots may not start before "now" in the salon's
    // timezone (rounded up to the next step). Blocks booking a time already past.
    function minStartForOffset(offset) {
      const window = hoursForOffset(offset);
      if (!window) return null;
      if (offset !== 0) return window[0];
      return Math.max(window[0], Math.ceil(salonMinutesNow() / SLOT_STEP_MINUTES) * SLOT_STEP_MINUTES);
    }

    // ---------- staff: work days and services (hard floor, like hours) ----------
    function staffDays(row) {
      return rules.parseWorkDays(row && row.work_days);
    }

    function staffWorksOn(row, offset) {
      const days = staffDays(row);
      return !days || days.includes(dayWeekday(offset));
    }

    function staffDoesService(row, serviceId) {
      if (!row || !serviceId) return true;
      return store.stylistsForService(serviceId).some((entry) => entry.id === row.id);
    }

    function staffForService(serviceId) {
      return store.getStylistRows().filter((row) => staffDoesService(row, serviceId));
    }

    function staffScheduleLabel(row) {
      return rules.workDaysLabel(staffDays(row));
    }

    // The next days (after fromOffset) the salon is open and this service has
    // a free slot, optionally with one staff member.
    function nextBookableDays(fromOffset, service, stylistRow, count = 2) {
      const found = [];
      for (let offset = Math.max(0, fromOffset + 1); offset <= fromOffset + 21 && found.length < count; offset++) {
        if (offset > dates.MAX_OFFSET) break;
        const slots = freeSlots(offset, service.duration_minutes, stylistRow, service.id);
        if (slots.length) {
          found.push({ day: dayLabel(offset), date: dayIso(offset), slots: slots.slice(0, 4).map((slot) => ({ stylist: slot.stylist, time: slot.time })) });
        }
      }
      return found;
    }

    // Structured, explainable refusal when the staff member cannot take this
    // service on this day. null = fine.
    function staffProblem(stylistRow, service, offset) {
      if (stylistRow && !staffDoesService(stylistRow, service.id)) {
        const doers = staffForService(service.id).map((row) => row.name);
        return {
          error: "staff_does_not_do_service",
          stylist: stylistRow.name,
          service: service.name,
          who_does_it: doers,
          note: `${stylistRow.name} does not do ${service.name}.${doers.length ? ` ${doers.join(", ")} ${doers.length === 1 ? "does" : "do"}.` : ""} Tell the client plainly and offer ${doers.length ? "one of them" : "another service"}.`
        };
      }
      if (stylistRow && !staffWorksOn(stylistRow, offset)) {
        const window = hoursForOffset(offset);
        const others = window ? freeSlots(offset, service.duration_minutes, null, service.id) : [];
        return {
          error: "staff_not_working",
          stylist: stylistRow.name,
          works_on: staffScheduleLabel(stylistRow),
          day: dayLabel(offset),
          date: dayIso(offset),
          salon_open_that_day: Boolean(window),
          salon_hours_that_day: hoursLabelForOffset(offset),
          same_day_other_staff: others.slice(0, 4).map((slot) => ({ stylist: slot.stylist, time: slot.time })),
          next_days_with_stylist: nextBookableDays(offset, service, stylistRow),
          note: `${stylistRow.name} works ${staffScheduleLabel(stylistRow)}, so not on ${dayLabel(offset)}.${window ? ` The salon itself IS open that day (${hoursLabelForOffset(offset)}): never say the salon is closed.` : ""} Offer ${stylistRow.name}'s next days${others.length ? " or another team member that day" : ""}.`
        };
      }
      if (!stylistRow && hoursForOffset(offset) && !store.getStylistRows().some((row) => staffDoesService(row, service.id) && staffWorksOn(row, offset))) {
        return {
          error: "no_staff_that_day",
          service: service.name,
          day: dayLabel(offset),
          date: dayIso(offset),
          salon_open_that_day: true,
          next_days: nextBookableDays(offset, service, null),
          note: `The salon is open on ${dayLabel(offset)}, but nobody who does ${service.name} works that day. Never say the salon is closed; offer the next days listed.`
        };
      }
      return null;
    }

    // Consult-only: the owner priced it "By consultation". No number, no
    // direct booking; a consultation service is offered instead, if any.
    function consultOnly(service) {
      return rules.priceKind(service.price_label) === "consultation" && !/consult/i.test(service.name);
    }

    function consultOnlyResult(session, service) {
      const consults = allServices().filter((row) => /consult/i.test(row.name));
      return {
        consult_only: true,
        service: service.name,
        price: service.price_label,
        consultation_services: consults.map((row) => serviceSummary(session, row)),
        note: consults.length
          ? `${service.name} is priced by consultation: never say a number for it. Offer to book one of the consultation services listed.`
          : `${service.name} is priced by consultation: never say a number for it. Offer to pass the request to the salon team (leave_message_for_owner).`
      };
    }

    // ---------- persistence helpers ----------
    function recordEvent(session, type, payload = {}) {
      db.prepare(`
        INSERT INTO assistant_events (salon_id, id, session_id, conversation_id, day, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(salonId, createId("aevt"),
        session.id,
        session.conversation_id || "",
        salonDayString(),
        type,
        JSON.stringify(payload),
        new Date().toISOString());
      if (typeof onEvent === "function") {
        try {
          onEvent(salonId, type, Object.assign({
            conversationId: session.conversation_id || "",
            channel: session.channel || "",
            sessionId: session.id || "",
            language: session.language || ""
          }, payload));
        } catch (error) {
          console.error(`[assistant] onEvent hook failed: ${String((error && error.message) || error).slice(0, 140)}`);
        }
      }
    }

    // ---------- LLM spend metering ----------
    // One row per LLM API call (a turn may spend several: tool rounds).
    // Token counts come from the provider's usage block when present, else 0 —
    // the call itself is still counted.
    function recordLlmCall(session, turn, message) {
      const usage = (message && message.usage) || {};
      const prompt = Number(usage.prompt_tokens) || 0;
      const completion = Number(usage.completion_tokens) || 0;
      const total = Number(usage.total_tokens) || (prompt + completion);
      db.prepare(`
        INSERT INTO assistant_usage (salon_id, id, turn_id, session_id, conversation_id, channel, day, round, prompt_tokens, completion_tokens, total_tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(salonId, createId("ause"),
        turn.id,
        session.id,
        session.conversation_id || "",
        session.channel || "Webchat",
        salonDayString(),
        turn.llmCalls,
        prompt,
        completion,
        total,
        new Date().toISOString());
    }

    function llmTurnsForDay(day) {
      return db.prepare(`SELECT COUNT(DISTINCT turn_id) AS count FROM assistant_usage WHERE salon_id = ? AND day = ?`).get(salonId, day).count;
    }

    function loadSession(sessionId) {
      const row = db.prepare(`SELECT * FROM assistant_sessions WHERE salon_id = ? AND id = ?`).get(salonId, sessionId);
      if (!row) return null;
      row.state = JSON.parse(row.state_json || "{}");
      return row;
    }

    function saveSession(session) {
      session.updated_at = new Date().toISOString();
      db.prepare(`
        UPDATE assistant_sessions
        SET conversation_id = ?, client_id = ?, client_phone = ?, channel = ?, language = ?, state_json = ?, updated_at = ?
        WHERE id = ? AND salon_id = ?
    `).run(session.conversation_id,
        session.client_id || "",
        session.client_phone || "",
        session.channel,
        session.language,
        JSON.stringify(session.state || {}),
        session.updated_at,
        session.id, salonId);
    }

    function findClientByPhone(phone) {
      const wanted = normalizePhone(phone);
      if (wanted.length < 10) return null; // require a full national number, exact match only
      const rows = db.prepare(`SELECT * FROM clients
      WHERE salon_id = ?
    `).all(salonId);
      return rows.find((row) => normalizePhone(row.phone) === wanted) || null;
    }

    function ensureSession({ sessionId, channel, clientPhone, language, clientName }) {
      let session = loadSession(sessionId);
      if (session) return session;
      const now = new Date().toISOString();
      // Only auto-link a session to an existing client when the channel verifies the
      // caller: a client-supplied phone on the public webchat is not proof of ownership.
      const knownClient = (clientPhone && isVerifiedChannel(channel)) ? findClientByPhone(clientPhone) : null;
      const channelName = String(clientName || "").trim().slice(0, 80);
      // Stored names are neutral English; the owner's inbox localises the
      // "Web client" / "Telegram client" label and swaps in the client's own
      // name as soon as we learn it.
      const isTelegram = /^tg:/.test(String(sessionId)) || /telegram/i.test(String(channel || ""));
      const placeholder = `${isTelegram ? "Telegram client" : "Web client"} ${String(sessionId).replace(/[^a-z0-9]/gi, "").slice(-4)}`;
      const guestName = knownClient ? knownClient.name : (channelName || placeholder);
      const conversationId = store.createConversation({
        name: guestName,
        clientId: knownClient ? knownClient.id : undefined,
        channel: channel || "Webchat",
        preview: "Chat with Maya",
        status: "Maya AI · active",
        contact: clientPhone ? { phone: clientPhone } : undefined,
        suggestions: ["Book a visit", "Prices and services"]
      });
      db.prepare(`
        UPDATE conversations SET assistant_session_id = ?, assistant_state = 'active' WHERE id = ? AND salon_id = ?
    `).run(sessionId, conversationId, salonId);
      db.prepare(`
        INSERT INTO assistant_sessions (salon_id, id, conversation_id, client_id, client_phone, channel, language, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
      `).run(salonId, sessionId,
        conversationId,
        knownClient ? knownClient.id : "",
        clientPhone || "",
        channel || "Webchat",
        language || "en",
        now,
        now);
      const session2 = loadSession(sessionId);
      recordEvent(session2, "session_started", { channel: channel || "Webchat", client: guestName });
      return session2;
    }

    function getConversationRow(conversationId) {
      return db.prepare(`SELECT * FROM conversations WHERE salon_id = ? AND id = ?`).get(salonId, conversationId);
    }

    function persistMessage(session, type, text) {
      store.createConversationMessage(session.conversation_id, { text, type, author: type === "incoming" ? "client" : "maya" });
    }

    function addSystemThreadNote(session, text) {
      store.createConversationMessage(session.conversation_id, { text, type: "system" });
    }

    function buildHistoryMessages(session) {
      const rows = db.prepare(`
        SELECT type, text_value FROM conversation_messages
        WHERE salon_id = ? AND conversation_id = ? AND type IN ('incoming', 'outgoing')
        ORDER BY sort_order ASC
      `).all(salonId, session.conversation_id);
      return rows.slice(-HISTORY_LIMIT).map((row) => ({
        role: row.type === "incoming" ? "user" : "assistant",
        content: row.text_value
      }));
    }

    function takeToken(key, max) {
      const now = Date.now();
      const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (bucket.length >= max) {
        rateBuckets.set(key, bucket);
        return true;
      }
      bucket.push(now);
      rateBuckets.set(key, bucket);
      // Bound the map so rotating sessionIds/IPs cannot grow it without limit.
      if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets) {
          const live = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
          if (live.length) rateBuckets.set(k, live);
          else rateBuckets.delete(k);
        }
      }
      return false;
    }

    // Per-session cap (kept as a secondary check; sessionId is client-controlled).
    function rateLimited(sessionId) {
      return takeToken(`${salonId}:sid:${String(sessionId || "")}`, RATE_LIMIT_MAX);
    }

    // Per-IP cap the attacker cannot rotate. Keyed on the trusted-proxy client IP.
    function rateLimitedByIp(ip) {
      if (!ip) return false;
      return takeToken(`${salonId}:ip:${ip}`, IP_RATE_LIMIT_MAX);
    }

    // Rolling 24h booking quota per client key (IP), to bound calendar-fill abuse.
    function bookingQuotaExceeded(clientKey) {
      if (!clientKey) return false;
      const now = Date.now();
      const bucket = (bookingBuckets.get(clientKey) || []).filter((t) => now - t < BOOKING_QUOTA_WINDOW_MS);
      bookingBuckets.set(clientKey, bucket);
      return bucket.length >= BOOKING_QUOTA_MAX;
    }

    function noteBooking(clientKey) {
      if (!clientKey) return;
      const now = Date.now();
      const bucket = (bookingBuckets.get(clientKey) || []).filter((t) => now - t < BOOKING_QUOTA_WINDOW_MS);
      bucket.push(now);
      bookingBuckets.set(clientKey, bucket);
      if (bookingBuckets.size > 5000) {
        for (const [k, v] of bookingBuckets) {
          const live = v.filter((t) => now - t < BOOKING_QUOTA_WINDOW_MS);
          if (live.length) bookingBuckets.set(k, live);
          else bookingBuckets.delete(k);
        }
      }
    }

    // ---------- domain resolution ----------
    function allServices() {
      return db.prepare(`
        SELECT s.*, c.name AS category_name FROM services s
        JOIN service_categories c ON c.id = s.category_id
        WHERE s.salon_id = ?
      ORDER BY s.sort_order ASC
      `).all(salonId);
    }

    // Everything a service can be recognised by: its own name, its category and
    // the keywords the salon supplied in its intake file.
    function serviceHaystack(row) {
      return `${row.name} ${row.category_name || ""} ${row.keywords || ""}`;
    }

    function resolveServices(query) {
      const text = String(query || "").trim();
      if (!text) return [];
      const rows = allServices();
      const lower = text.toLowerCase();

      // 1. the client typed (part of) the salon's own service name
      const direct = rows.filter((row) => row.name.toLowerCase().includes(lower));
      if (direct.length) return direct;

      // 2. a keyword this salon listed for the service in its intake file
      const byKeyword = rows.filter((row) => String(row.keywords || "")
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter((word) => word.length >= 3)
        .some((word) => lower.includes(word)));
      if (byKeyword.length) return byKeyword;

      // 3. concept match — the first concept the client's phrasing hits that
      //    this salon actually offers wins (specific before generic).
      for (const concept of SERVICE_CONCEPTS) {
        if (!concept.re.test(text)) continue;
        const matched = rows.filter((row) => concept.re.test(serviceHaystack(row)));
        if (matched.length) return matched;
      }
      return [];
    }

    // Stylist lookup against THIS salon's roster: full name, then each name part
    // (transliterated, declension-stripped) so "к Саре"/"у Елены" find "Sarah
    // Jenkins"/"Elena Rostova", and "до Ірини" finds "Ирина Ковальчук".
    function resolveStylist(query) {
      const text = String(query || "").trim();
      if (!text) return null;
      const lower = text.toLowerCase();
      const rows = store.getStylistRows();

      const direct = rows.find((row) => {
        const name = row.name.toLowerCase();
        return lower.includes(name) || name.includes(lower);
      });
      if (direct) return direct;

      const queryLatin = translit(lower);
      // Stems of the client's words, computed BEFORE transliteration so Russian
      // and Ukrainian case endings are stripped in their own alphabet.
      const queryStems = lower
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word.length >= 3)
        .map((word) => translit(nameStem(word)))
        .filter((stem) => stem.length >= 3);

      // Spelling-insensitive pass across alphabets: "к Ирине" → "Iryna",
      // "avec Karim" → "Карим", "Chloé" → "Chloe".
      const queryKeys = text.split(/[^\p{L}'’-]+/u).filter((word) => word.length >= 3).map(nameKey).filter((key) => key.length >= 3);
      for (const row of rows) {
        const keys = String(row.name).split(/\s+/).concat(parseAliases(row.aliases)).map(nameKey).filter((key) => key.length >= 3);
        if (keys.some((key) => queryKeys.some((q) => q === key || (q.length >= 4 && key.length >= 4 && (q.startsWith(key) || key.startsWith(q)))))) return row;
      }

      for (const row of rows) {
        const candidates = String(row.name).split(/\s+/).concat(parseAliases(row.aliases));
        for (const part of candidates) {
          if (!part || part.length < 3) continue;
          const partLatin = translit(nameStem(part));
          if (partLatin.length < 3) continue;
          // Either direction may be the prefix: "сар"→"sar" ⊂ "sarah", and
          // "Ирина"→"irin" ⊃ the stem of "Ирине"→"irin".
          if (new RegExp(`(^|[^a-z0-9])${escapeRe(partLatin)}`, "i").test(queryLatin)) return row;
          if (queryStems.some((stem) => partLatin.startsWith(stem) || stem.startsWith(partLatin))) return row;
        }
      }
      return null;
    }

    function parseAliases(value) {
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(value || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (error) {
        return String(value || "").split(/[,;]+/).map((entry) => entry.trim()).filter(Boolean);
      }
    }

    // Names the client used for staff that do NOT exist in the stylists table.
    function detectUnknownStylists(text, clientNames = []) {
      const value = String(text || "");
      const found = new Map();
      const clientKeys = clientNames.join(" ").split(/\s+/).filter(Boolean).map(nameKey);
      for (const pattern of STYLIST_MENTION_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(value)) !== null) {
          const candidate = String(match[1] || "").trim();
          if (candidate.length < 3) continue;
          if (STYLIST_NAME_STOPWORDS.test(candidate)) continue;
          if (SALON_WORD_STOPWORDS.includes(candidate.toLowerCase())) continue;
          if (WEEKDAYS.some((day) => day.re.test(candidate))) continue;
          if (SERVICE_CONCEPTS.some((concept) => concept.re.test(candidate))) continue;
          if (clientKeys.includes(nameKey(candidate))) continue; // the client's own name
          if (resolveStylist(candidate)) continue; // real staff member — fine
          const stem = nameStem(candidate);
          if (!found.has(stem)) found.set(stem, { raw: candidate, stem });
        }
      }
      return [...found.values()];
    }

    function stylistCorrectionReply(lang) {
      const staff = store.getStylistRows().map((row) => row.name);
      const listRu = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} и ${staff[staff.length - 1]}` : staff.join("");
      const listUk = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} та ${staff[staff.length - 1]}` : staff.join("");
      const listEn = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} and ${staff[staff.length - 1]}` : staff.join("");
      const listFr = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} et ${staff[staff.length - 1]}` : staff.join("");
      const pack = {
        ru: `Хочу быть честной: такого мастера у нас нет. В нашей команде ${listRu} — к кому из них вас записать?`,
        uk: `Хочу бути чесною: такого майстра у нас немає. У нашій команді ${listUk} — до кого з них вас записати?`,
        en: `To be honest with you, nobody by that name works here. Our team is ${listEn}. Who would you like to book with?`,
        fr: `Pour être honnête, personne de ce nom ne travaille ici. Notre équipe : ${listFr}. Avec qui voulez-vous réserver?`
      };
      return localized(pack, lang);
    }

    function referenceDate() {
      const ref = new Date(store.getLastUpdated());
      return Number.isNaN(ref.getTime()) ? clockNow() : ref;
    }

    // Salon-timezone calendar date of the reference day, anchored at UTC midnight
    // so weekday/offset math is DST-safe regardless of the server's own timezone.
    function refDayUtcMs() {
      const [y, m, d] = todayIso().split("-").map(Number);
      return Date.UTC(y, m - 1, d);
    }

    // The salon-local date that day offset 0 means. For a self-serve salon it
    // is the store's day_anchor (every appointment offset is relative to it);
    // the demo salon keeps its last-updated reference.
    function todayIso() {
      const row = db.prepare(`SELECT value FROM metadata WHERE salon_id = ? AND key = 'day_anchor'`).get(salonId);
      if (row && /^\d{4}-\d{2}-\d{2}$/.test(row.value)) return row.value;
      return tzDateString(referenceDate(), TIMEZONE);
    }

    // Tool argument → { offset } | { error }. Relative words, weekdays, month
    // names and ISO dates in en/fr/ru/uk are resolved here, never by the model;
    // a year the model guessed wrong is corrected to the nearest future date.
    function resolveDay(input) {
      return dates.parseDayArgument(input, todayIso(), dateOpts());
    }

    // The salon is done for today (closed today, or past closing time): a
    // bare weekday that names today ("Friday" said on a Friday evening)
    // means the same weekday next week.
    function dateOpts() {
      const window = hoursForOffset(0);
      return { todayOver: !window || salonMinutesNow() >= window[1] };
    }

    function findDates(text) {
      return dates.findDateExpressions(text, todayIso(), dateOpts());
    }

    // Booking day guard: a book_appointment day that the client did not name
    // in this message and that was never offered in an earlier turn is pulled
    // back to the day the conversation settled on.
    function dayForTool(turn, input) {
      const day = resolveDay(input);
      const offered = (turn && turn.offeredAtStart) || [];
      if (turn && turn.draftDayAtStart !== undefined && !turn.clientNamedDay &&
          day.offset !== undefined && day.offset !== turn.draftDayAtStart && !offered.includes(day.offset)) {
        turn.dayCorrected = { from: day.offset, to: turn.draftDayAtStart };
        return { offset: turn.draftDayAtStart, corrected: true };
      }
      return day;
    }

    function dayIso(offset) {
      return dates.addDays(todayIso(), offset);
    }

    // The model sometimes calls check_availability with no day at all. Falling
    // back to today is wrong whenever the client just named a day, or the
    // conversation already settled on one: the tool then answers about a day
    // nobody asked about, and the time guard rewrites the reply around it
    // ("no room Sunday" to a client asking about Friday).
    function dayHintFor(session, turn) {
      const named = findDates(String((turn && turn.userMessage) || "")).find((hit) => hit.offset !== undefined);
      if (named) return dayIso(named.offset);
      const draftDay = (session.state.draft || {}).dayOffset;
      if (draftDay !== undefined && draftDay !== null) return dayIso(draftDay);
      return "";
    }

    function dayError(day) {
      const today = `${dates.WEEKDAY_EN[dates.weekdayOf(todayIso())]} ${todayIso()}`;
      if (day.error === "date_in_past") {
        return { error: "date_in_past", today, note: `That date is already past (today is ${today}). Tell the client kindly and ask for a day from the calendar in the TODAY block.` };
      }
      if (day.error === "date_out_of_range") {
        return { error: "date_out_of_range", today, note: `Bookings open up to ${dates.MAX_OFFSET} days ahead (today is ${today}). Ask for a nearer day.` };
      }
      return { error: day.error, today, note: "Ask the client for a concrete day, then pass it as YYYY-MM-DD from the TODAY calendar." };
    }

    function dayLabel(offset) {
      return new Date(refDayUtcMs() + offset * 86400000)
        .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    }

    // ISO date (salon calendar) for a day offset: alerts format it in the
    // owner's language instead of the English dayLabel.
    function isoDateForOffset(offset) {
      return new Date(refDayUtcMs() + offset * 86400000).toISOString().slice(0, 10);
    }

    function dayWeekday(offset) {
      return new Date(refDayUtcMs() + offset * 86400000).getUTCDay();
    }

    function parseTimeFlexible(input) {
      const text = String(input || "").trim().toLowerCase();
      let match = text.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
      if (match) {
        let hours = Number(match[1]);
        const minutes = Number(match[2]);
        const meridiem = match[3] ? match[3].toLowerCase() : "";
        if (meridiem === "pm" && hours !== 12) hours += 12;
        if (meridiem === "am" && hours === 12) hours = 0;
        if (!meridiem && hours >= 1 && hours <= 7) hours += 12; // salon context: bare 1-7 → afternoon
        return hours * 60 + minutes;
      }
      match = text.match(/(\d{1,2})\s*([ap]m)/i);
      if (match) {
        let hours = Number(match[1]);
        if (match[2].toLowerCase() === "pm" && hours !== 12) hours += 12;
        if (match[2].toLowerCase() === "am" && hours === 12) hours = 0;
        return hours * 60;
      }
      match = text.match(/^(\d{1,2})$/);
      if (match) {
        let hours = Number(match[1]);
        if (hours >= 1 && hours <= 7) hours += 12;
        return hours * 60;
      }
      return null;
    }

    // Test bookings (the owner's own test chat) never hold a slot against a
    // real client; inside a test chat they do, so the owner sees "taken".
    let slotViewTest = false;
    function busyIntervals(dayOffset, stylistId) {
      const rows = db.prepare(`
        SELECT start_minutes, end_minutes FROM appointments
        WHERE salon_id = ? AND checked_out = 0 AND appointment_status = 'scheduled' AND day_offset = ? AND stylist_id = ?
        AND (is_test = 0 OR ? = 1)
      `).all(salonId, dayOffset, stylistId, slotViewTest ? 1 : 0);
      // Time the owner blocked (a staff member's or the whole salon's).
      if (typeof busyBlocksFor === "function") {
        try {
          (busyBlocksFor(salonId, isoDateForOffset(dayOffset), stylistId) || []).forEach((block) => rows.push(block));
        } catch (error) {
          console.error(`[assistant] busy blocks lookup failed: ${String((error && error.message) || error).slice(0, 140)}`);
        }
      }
      return rows;
    }

    function slotFree(dayOffset, stylistId, startMinutes, endMinutes) {
      return !busyIntervals(dayOffset, stylistId).some((row) =>
        startMinutes < row.end_minutes && endMinutes > row.start_minutes
      );
    }

    // Slots come only from here: salon hours (the service must END by
    // closing), the staff member's work days and the services they do.
    function freeSlots(dayOffset, durationMinutes, stylistRow, serviceId) {
      const window = hoursForOffset(dayOffset);
      if (!window) return [];
      const minStart = minStartForOffset(dayOffset);
      const stylists = (stylistRow ? [stylistRow] : store.getStylistRows())
        .filter((row) => staffWorksOn(row, dayOffset) && staffDoesService(row, serviceId));
      const slots = [];
      for (const stylist of stylists) {
        const open = [];
        for (let start = minStart; start + durationMinutes <= window[1]; start += SLOT_STEP_MINUTES) {
          if (slotFree(dayOffset, stylist.id, start, start + durationMinutes)) open.push(start);
        }
        // Spread picks across the whole day (morning/midday/afternoon), not just
        // the earliest three — otherwise the model concludes 14:00 is "taken".
        const pickCount = Math.min(4, open.length);
        const picked = new Set();
        for (let i = 0; i < pickCount; i++) {
          picked.add(open[Math.round((open.length - 1) * (pickCount === 1 ? 0 : i / (pickCount - 1)))]);
        }
        [...picked].forEach((start) => {
          slots.push({
            stylist: stylist.name,
            time: store.formatTimeRange(start, start + durationMinutes),
            startMinutes: start
          });
        });
      }
      return slots.sort((a, b) => a.startMinutes - b.startMinutes).slice(0, 8);
    }

    function notePrice(session, value) {
      const num = Number(String(value).replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(num) || num <= 0) return;
      const state = session.state;
      state.quotedPrices = state.quotedPrices || [];
      if (!state.quotedPrices.includes(num)) state.quotedPrices.push(num);
    }

    function serviceSummary(session, row) {
      const kind = rules.priceKind(row.price_label);
      if (kind !== "consultation") notePrice(session, row.price_value);
      const summary = {
        name: row.name,
        category: row.category_name,
        price: row.price_label,
        duration_min: row.duration_minutes
      };
      if (kind !== "fixed") {
        summary.price_kind = kind;
        summary.price_note = rules.PRICE_NOTES[kind] || "";
      }
      if (Number(row.requires_deposit)) summary.deposit_required = true;
      return summary;
    }

    // ---------- escalation / takeover ----------
    function setConversationState(session, state, statusLabel) {
      db.prepare(`UPDATE conversations SET assistant_state = ?, status = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `)
        .run(state, statusLabel, new Date().toISOString(), session.conversation_id, salonId);
    }

    function isTestSession(session) {
      if (!session) return false;
      if (session.state && session.state.test) return true;
      return typeof isTestSessionHook === "function" && Boolean(isTestSessionHook(salonId, session.id));
    }

    function nowMs() {
      return clockNow().getTime();
    }

    // The moment a person became responsible for this thread: the later of
    // the handoff and the last staff answer. Older threads fall back to the
    // last escalation / takeover event.
    function handoffSinceMs(session) {
      const marks = [session.state.handoffAt, session.state.lastStaffAt]
        .map((value) => Date.parse(value || ""))
        .filter((value) => Number.isFinite(value));
      if (marks.length) return Math.max(...marks);
      const row = db.prepare(`
        SELECT created_at FROM assistant_events
        WHERE salon_id = ? AND conversation_id = ? AND type IN ('escalation', 'takeover_on')
        ORDER BY created_at DESC LIMIT 1
      `).get(salonId, session.conversation_id || "");
      const parsed = row ? Date.parse(row.created_at) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    }

    // Maya answers again: the thread leaves human-only mode.
    function returnToMaya(session, cause) {
      db.prepare(`UPDATE conversations SET assistant_state = 'active', status = ?, updated_at = ? WHERE id = ? AND salon_id = ?`)
        .run("Maya AI · active", new Date().toISOString(), session.conversation_id, salonId);
      session.state.escalated = null;
      session.state.failedUnderstandings = 0;
      session.state.handoffAt = null;
      session.state.holdingAt = null;
      session.state.waitingCount = 0;
      recordEvent(session, "handback", { cause });
    }

    // Threads whose staff went quiet for AUTO_RETURN_MS go back to Maya.
    function autoReturnStale() {
      const rows = db.prepare(`
        SELECT id, assistant_session_id FROM conversations
        WHERE salon_id = ? AND assistant_state IN ('escalated', 'takeover') AND assistant_session_id != ''
      `).all(salonId);
      let returned = 0;
      rows.forEach((row) => {
        const session = loadSession(row.assistant_session_id);
        if (!session) return;
        const since = handoffSinceMs(session);
        if (since === null || nowMs() - since < AUTO_RETURN_MS) return;
        returnToMaya(session, "auto_12h");
        saveSession(session);
        returned += 1;
      });
      return returned;
    }

    function escalate(session, reason, summary) {
      if (isTestSession(session)) {
        // The owner's own test chat: the handoff is shown and alerted (marked
        // test), but Maya keeps answering so the preview never locks.
        recordEvent(session, "escalation", { reason, summary: String(summary || "").slice(0, 400), test: true });
        session.state.escalated = null;
        session.state.failedUnderstandings = 0;
        session.state.testHandoffNote = true;
        return;
      }
      setConversationState(session, "escalated", "Needs human · Maya paused");
      session.state.handoffAt = clockNow().toISOString();
      session.state.holdingAt = null;
      session.state.waitingCount = 0;
      recordEvent(session, "escalation", { reason, summary: String(summary || "").slice(0, 400) });
      store.logActivity({
        title: "Maya Escalated a Conversation",
        meta: `${getConversationRow(session.conversation_id).name} • ${reason}`,
        icon: "support_agent",
        tone: "error"
      });
      session.state.escalated = reason;
      sendAlertEmail(session, ALERT_CATEGORIES[reason] || reason, { summary: String(summary || "").slice(0, 300) });
    }

    function leaveOwnerMessage(session, message, topic, { silent } = {}) {
      recordEvent(session, "owner_message", { message: String(message).slice(0, 500), topic: topic || "" });
      store.logActivity({
        title: "Message for Owner (Maya)",
        meta: String(message).slice(0, 90),
        icon: "mail",
        tone: "tertiary"
      });
      // silent: the thread is tracked but no per-conversation email goes out
      // (used at the daily cap, which sends its own single-fire alert instead).
      if (!silent) sendAlertEmail(session, ALERT_CATEGORIES.owner_message, { owner_note: String(message).slice(0, 300) });
    }

    // ---------- escalation alert emails ----------
    // Fire-and-forget POST to formsubmit.co (5s timeout, non-blocking, failures
    // only logged). Throttle: max one email per conversation per 10 minutes.
    function sendAlertEmail(session, category, extra = {}) {
      if (!ALERT_EMAIL) return;
      const conversationId = session.conversation_id || "";
      const lastSent = alertLastSent.get(conversationId) || 0;
      if (Date.now() - lastSent < ALERT_THROTTLE_MS) return;
      alertLastSent.set(conversationId, Date.now());
      const conversation = getConversationRow(conversationId) || {};
      const recentClientMessages = db.prepare(`
        SELECT text_value FROM conversation_messages
        WHERE salon_id = ? AND conversation_id = ? AND type = 'incoming'
        ORDER BY sort_order DESC LIMIT 3
      `).all(salonId, conversationId).reverse();
      const phone = session.client_phone || conversation.contact_phone || "";
      const payload = Object.assign({
        _subject: `🔔 AIbeaty / Майя: нужен человек — ${category}`,
        salon: SALON_NAME,
        category,
        client: [conversation.name || "клиент", phone].filter(Boolean).join(" · "),
        last_messages: recentClientMessages.map((row) => `— ${String(row.text_value).slice(0, 220)}`).join("\n") || "(сообщений нет)",
        thread: `${ALERT_LINK_BASE}/screens/unified-inbox-luminous-core.html?salon=${encodeURIComponent(salonId)}&conversationId=${encodeURIComponent(conversationId)}`
      }, extra);
      recordEvent(session, "alert_email", { category, to_domain: ALERT_EMAIL.split("@")[1] || "" });
      postAlertEmail(payload, category);
    }

    // Shared fire-and-forget formsubmit.co POST (5s timeout, non-blocking,
    // failures only logged). Callers decide throttling/single-fire.
    function postAlertEmail(payload, category) {
      let timer = null;
      try {
        const controller = new AbortController();
        timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
        Promise.resolve(alertHttp(`https://formsubmit.co/ajax/${ALERT_EMAIL}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Origin": ALERT_ORIGIN,
            "Referer": `${ALERT_ORIGIN}/`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        })).then(async (response) => {
          clearTimeout(timer);
          let delivered = Boolean(response && response.ok);
          let detail = `HTTP ${response ? response.status : "?"}`;
          if (delivered && response && typeof response.text === "function") {
            try {
              const body = JSON.parse(await response.text());
              if (body && String(body.success).toLowerCase() === "false") {
                delivered = false;
                detail = `relay refused: ${String(body.message || "").slice(0, 120)}`;
              }
            } catch (parseError) { /* non-JSON body — keep HTTP verdict */ }
          }
          if (!delivered) console.error(`[assistant] alert email failed: ${detail}`);
          else console.log(`[assistant] alert email sent (${category})`);
        }).catch((error) => {
          clearTimeout(timer);
          console.error(`[assistant] alert email failed: ${String((error && error.message) || error).slice(0, 140)}`);
        });
      } catch (error) {
        if (timer) clearTimeout(timer);
        console.error(`[assistant] alert email failed: ${String((error && error.message) || error).slice(0, 140)}`);
      }
    }

    // ---------- daily cap alerts (80% / 100%) ----------
    // Single-fire per salon day per threshold: the usage_alert event row is
    // written BEFORE the email attempt, so retries/races never double-send.
    function maybeSendUsageAlert(session, threshold, turns) {
      const day = salonDayString();
      const already = db.prepare(`
        SELECT COUNT(*) AS count FROM assistant_events
        WHERE salon_id = ? AND day = ? AND type = 'usage_alert' AND payload_json LIKE ?
      `).get(salonId, day, `%"threshold":${threshold},%`).count;
      if (already) return;
      recordEvent(session, "usage_alert", { threshold, turns, cap: DAILY_TURNS_CAP });
      if (!ALERT_EMAIL) return;
      const subject = threshold >= 100
        ? `⛔ AIbeaty / Майя: дневной лимит исчерпан (${turns}/${DAILY_TURNS_CAP})`
        : `⚠️ AIbeaty / Майя израсходовала 80% дневного лимита (${turns}/${DAILY_TURNS_CAP})`;
      postAlertEmail({
        _subject: subject,
        salon: SALON_NAME,
        day,
        turns: `${turns} из ${DAILY_TURNS_CAP}`,
        note: threshold >= 100
          ? "Майя отвечает клиентам вежливой заглушкой и собирает сообщения для владельца. Срочные темы (медицина, «позовите человека») по-прежнему уходят человеку. Счётчик обнулится в полночь по времени салона."
          : "Майя продолжает отвечать. На 100% она перейдёт на вежливую заглушку до полуночи по времени салона.",
        usage_dashboard: `${ALERT_LINK_BASE}/screens/digest.html?salon=${encodeURIComponent(salonId)}`
      }, `usage_${threshold}`);
    }

    // ---------- tools ----------
    const TOOL_DEFS = [
      {
        type: "function",
        function: {
          name: "get_services_and_prices",
          description: "List the salon's real services with prices and durations. The ONLY source of prices.",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "Optional filter, e.g. 'балаяж' or 'cut'" } }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "check_availability",
          description: "Find open slots for a service, optionally with a specific stylist and day. If the client asked for a specific time, pass it in `time` to check that exact slot. Call BEFORE offering any time.",
          parameters: {
            type: "object",
            properties: {
              service: { type: "string", description: "Service the client wants (any language)" },
              day: { type: "string", description: "'today', 'tomorrow', weekday, or YYYY-MM-DD" },
              stylist: { type: "string", description: "Stylist name if requested" },
              time: { type: "string", description: "Specific start time the client asked for, e.g. '14:00'" }
            },
            required: ["service"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "book_appointment",
          description: "Book an appointment. First call returns needs_confirmation with a read-back; read it to the client, and ONLY after their explicit yes call again with the same arguments to commit.",
          parameters: {
            type: "object",
            properties: {
              service: { type: "string" },
              day: { type: "string" },
              time: { type: "string", description: "Start time, e.g. '14:00' or '2:00 PM'" },
              stylist: { type: "string" },
              client_name: { type: "string" },
              client_phone: { type: "string" }
            },
            required: ["service", "day", "time"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "reschedule_appointment",
          description: "Move the client's upcoming appointment to a new day/time. Same confirm flow as book_appointment.",
          parameters: {
            type: "object",
            properties: {
              day: { type: "string" },
              time: { type: "string" },
              stylist: { type: "string" },
              appointment_id: { type: "string" }
            },
            required: ["day", "time"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "cancel_appointment",
          description: "Cancel the client's upcoming appointment. Same confirm flow: read back first, commit only after explicit yes.",
          parameters: {
            type: "object",
            properties: {
              appointment_id: { type: "string" },
              reason: { type: "string" }
            }
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_client_context",
          description: "Look up a returning client by phone: name, preferences, upcoming visit. Use when the client shares their phone number.",
          parameters: {
            type: "object",
            properties: { phone: { type: "string" } },
            required: ["phone"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "leave_message_for_owner",
          description: "Leave a task/message for the salon owner when you cannot answer from tools or FAQ, or the client asks for something outside your authority.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string" },
              topic: { type: "string" }
            },
            required: ["message"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "request_human_handoff",
          description: "Hand the conversation to a human (client asked, complaint, medical topic, or you are stuck). After this the bot goes silent in the thread.",
          parameters: {
            type: "object",
            properties: { reason: { type: "string" } }
          }
        }
      }
    ];

    // ---------- booking draft (server-side memory of what the client chose) ----------
    function noteDraft(session, fields) {
      const draft = session.state.draft || {};
      Object.keys(fields).forEach((key) => { if (fields[key] !== undefined && fields[key] !== null) draft[key] = fields[key]; });
      session.state.draft = draft;
    }

    function noteClient(session, { name, phone } = {}) {
      const client = session.state.client || {};
      if (name && !isPlaceholderName(name)) client.name = String(name).trim().slice(0, 80);
      if (phone && digitsOnly(phone).length >= 7) client.phone = String(phone).trim().slice(0, 40);
      session.state.client = client;
      if (client.phone && !session.client_phone) session.client_phone = client.phone;
      // The inbox shows a real name instead of "Web guest 1234" once we know it.
      const conversation = getConversationRow(session.conversation_id);
      if (client.name && conversation && isPlaceholderName(conversation.name)) {
        db.prepare(`UPDATE conversations SET name = ?, updated_at = ? WHERE id = ? AND salon_id = ?`)
          .run(client.name, new Date().toISOString(), session.conversation_id, salonId);
      }
    }

    function recentClientMessages(session, limit = 6) {
      return db.prepare(`
        SELECT text_value FROM conversation_messages
        WHERE salon_id = ? AND conversation_id = ? AND type = 'incoming'
        ORDER BY sort_order DESC LIMIT ?
      `).all(salonId, session.conversation_id, limit).map((row) => String(row.text_value || ""));
    }

    // Service lookup for a tool call that never asks the same question twice:
    // an ambiguous query is settled by the client's own words or by the draft.
    function resolveServiceForTool(session, turn, query) {
      const draft = session.state.draft || {};
      const text = String(query || "").trim();
      const byId = (id) => allServices().find((row) => row.id === id);
      if (!text && draft.serviceId && byId(draft.serviceId)) return [byId(draft.serviceId)];
      let matches = resolveServices(text);
      if (matches.length <= 1) return matches;
      const exact = matches.filter((row) => row.name.toLowerCase() === text.toLowerCase());
      if (exact.length === 1) return exact;
      // The client named one of the options in a recent message (newest first).
      const messages = [turn && turn.userMessage ? String(turn.userMessage) : ""].concat(recentClientMessages(session, 4));
      for (const message of messages) {
        const lower = message.toLowerCase();
        if (!lower) continue;
        const named = matches.filter((row) => lower.includes(row.name.toLowerCase()));
        if (named.length) return [named.sort((a, b) => b.name.length - a.name.length)[0]];
        const narrowed = resolveServices(message).filter((row) => matches.some((match) => match.id === row.id));
        if (narrowed.length === 1) return narrowed;
      }
      if (draft.serviceId && matches.some((row) => row.id === draft.serviceId)) return [byId(draft.serviceId)];
      return matches;
    }

    function resolveStylistExact(name) {
      const key = nameKey(name);
      const single = String(name || "").trim().split(/\s+/).length === 1;
      return store.getStylistRows().find((row) => nameKey(row.name) === key || (single && nameKey(String(row.name).split(/\s+/)[0]) === key)) || null;
    }

    // Staff for a tool call. A name the model passes is dropped (no staff
    // preference) when it is the client's own name or when the client never
    // asked for that person; only a name the client asked for and that is not
    // on the team is "not found". A one-person salon always gets that person.
    function stylistForTool(session, turn, raw) {
      const rows = store.getStylistRows();
      const value = String(raw || "").trim();
      if (!value || /^(any|anyone|any stylist|n'importe qui|peu importe|любой|любая|будь-хто|будь-який)$/i.test(value)) {
        return { row: rows.length === 1 ? rows[0] : null };
      }
      const row = resolveStylist(value);
      if (row) return { row };
      const client = session.state.client || {};
      const clientKeys = String(client.name || "").split(/\s+/).filter(Boolean).map(nameKey);
      if (value.split(/\s+/).some((word) => clientKeys.includes(nameKey(word)))) return { row: rows.length === 1 ? rows[0] : null, ignored: "client_name" };
      const asked = [turn && turn.userMessage ? String(turn.userMessage) : ""].concat(recentClientMessages(session, 6))
        .some((message) => detectUnknownStylists(message, [client.name || ""]).some((entry) => nameKey(entry.raw) === nameKey(value.split(/\s+/)[0])));
      if (!asked) return { row: rows.length === 1 ? rows[0] : null, ignored: "not_requested" };
      return { row: null, notFound: true };
    }

    function pendingMatches(pending, proposal) {
      if (!pending || pending.kind !== proposal.kind) return false;
      if (pending.kind === "cancel") return pending.appointmentId === proposal.appointmentId;
      return pending.serviceId === proposal.serviceId &&
        pending.dayOffset === proposal.dayOffset &&
        pending.startMinutes === proposal.startMinutes &&
        (!pending.stylistId || !proposal.stylistId || pending.stylistId === proposal.stylistId) &&
        (pending.appointmentId || "") === (proposal.appointmentId || "");
    }

    function findClientAppointment(session, appointmentId) {
      // Must be a session linked to a client (via a verified channel or its own
      // booking) before it can read/act on an appointment — no acting while unlinked.
      const conversation = getConversationRow(session.conversation_id);
      const clientId = session.client_id || (conversation && conversation.client_id) || null;
      if (!clientId) return null;
      if (appointmentId) {
        // Scope the by-id lookup to the linked client: closes the cross-client IDOR
        // where any appointment_id could be canceled/rescheduled.
        return db.prepare(`
          SELECT a.*, s.name AS stylist_name FROM appointments a
          JOIN stylists s ON s.id = a.stylist_id
          WHERE a.salon_id = ? AND a.id = ? AND a.client_id = ?
        `).get(salonId, appointmentId, clientId) || null;
      }
      return store.getActiveAppointmentForClient(clientId) || null;
    }

    function linkConversationToClient(session, clientId) {
      if (!clientId) return;
      session.client_id = clientId;
      db.prepare(`UPDATE conversations SET client_id = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `)
        .run(clientId, new Date().toISOString(), session.conversation_id, salonId);
    }

    function executeTool(session, turn, name, args) {
      slotViewTest = isTestSession(session);
      switch (name) {
        case "get_services_and_prices": {
          const rows = args.query ? resolveServices(args.query) : [];
          const list = (rows.length ? rows : allServices()).map((row) => serviceSummary(session, row));
          return { services: list, note: "These are the only services the salon offers. Quote each price label verbatim (ranges, \"from\", add-ons, per-unit, Free, By consultation). The only sum you may do is a fixed base price plus an add-on row; never invent any other total." };
        }

        case "check_availability": {
          const matches = resolveServiceForTool(session, turn, args.service);
          if (!matches.length) {
            return {
              found: false,
              note: "No such service here. Offer the real list below or leave_message_for_owner.",
              known_services: allServices().map((row) => serviceSummary(session, row))
            };
          }
          if (matches.length > 1) {
            session.state.lastAmbiguous = matches.map((row) => row.id);
            return {
              ambiguous: true,
              note: "Ask the client which of these they mean, once. If they already answered, pass that exact service name.",
              options: matches.map((row) => serviceSummary(session, row))
            };
          }
          const service = matches[0];
          noteDraft(session, { serviceId: service.id, serviceName: service.name });
          if (consultOnly(service)) return consultOnlyResult(session, service);
          const day = resolveDay(String(args.day || "").trim() || dayHintFor(session, turn));
          if (day.error) return dayError(day);
          const stylistPick = stylistForTool(session, turn, args.stylist);
          const stylist = stylistPick.row;
          if (stylistPick.notFound) {
            return {
              stylist_not_found: true,
              note: "No such staff member. These are the real team members:",
              stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role, works_on: staffScheduleLabel(row) }))
            };
          }
          const window = hoursForOffset(day.offset);
          if (!window) {
            const nextDays = nextBookableDays(day.offset, service, stylist && staffDoesService(stylist, service.id) ? stylist : null);
            return {
              closed: true,
              salon_closed_that_day: true,
              day: dayLabel(day.offset),
              date: dayIso(day.offset),
              note: `The salon is closed on ${dayLabel(day.offset)}. Offer the next days below.`,
              service: serviceSummary(session, service),
              next_days: nextDays,
              alternative_day: nextDays.length ? nextDays[0].day : null,
              alternative_slots: nextDays.length ? nextDays[0].slots : []
            };
          }
          const problem = staffProblem(stylist, service, day.offset);
          if (problem) return problem;
          noteDraft(session, { dayOffset: day.offset, stylistId: stylist ? stylist.id : undefined });
          session.state.draft.offeredDays = [...new Set((session.state.draft.offeredDays || []).concat([day.offset]))].slice(-10);
          if (args.time && parseTimeFlexible(args.time) !== null) noteDraft(session, { startMinutes: parseTimeFlexible(args.time) });
          const minStart = minStartForOffset(day.offset);
          if (day.offset === 0 && minStart + service.duration_minutes > window[1]) {
            const nextDays = nextBookableDays(0, service, stylist);
            return {
              day_over: true,
              salon_time_now: minutesLabel(salonMinutesNow()),
              note: `Today's hours (${hoursLabelForOffset(0)}) are over for this service: offer nothing for today. Offer the next days below.`,
              service: serviceSummary(session, service),
              next_days: nextDays,
              alternative_day: nextDays.length ? nextDays[0].day : null,
              alternative_slots: nextDays.length ? nextDays[0].slots : []
            };
          }
          const slots = freeSlots(day.offset, service.duration_minutes, stylist, service.id);
          const payload = {
            service: serviceSummary(session, service),
            day: dayLabel(day.offset),
            date: dayIso(day.offset),
            opening_hours: hoursLabelForOffset(day.offset),
            last_start_for_this_service: minutesLabel(window[1] - service.duration_minutes),
            slots: slots.map((slot) => ({ stylist: slot.stylist, time: slot.time })),
            note: slots.length
              ? "Offer 2-3 of these real slots. Times not listed may still be free: check them via the `time` argument."
              : "No free slots that day (the salon is open; the team is fully booked or off). Offer the next days below.",
            next_step: "When the client settles on a slot, call book_appointment right away: it returns the official read-back. Never compose a read-back or confirmation question yourself."
          };
          if (!slots.length) payload.next_days = nextBookableDays(day.offset, service, stylist);
          if (day.offset === 0) payload.salon_time_now = minutesLabel(salonMinutesNow());
          if (args.time) {
            const wanted = parseTimeFlexible(args.time);
            if (wanted !== null && day.offset === 0 && wanted < minStart && wanted >= window[0] && wanted + service.duration_minutes <= window[1]) {
              payload.requested_time = {
                time: store.formatTimeRange(wanted, wanted + service.duration_minutes),
                available: false,
                reason: `already in the past: it is ${minutesLabel(salonMinutesNow())} salon time today. Offer only the future slots listed.`
              };
            } else if (wanted !== null && wanted >= window[0] && wanted + service.duration_minutes <= window[1]) {
              const candidates = (stylist ? [stylist] : store.getStylistRows())
                .filter((row) => staffWorksOn(row, day.offset) && staffDoesService(row, service.id));
              const freeWith = candidates.filter((row) => slotFree(day.offset, row.id, wanted, wanted + service.duration_minutes));
              payload.requested_time = {
                time: store.formatTimeRange(wanted, wanted + service.duration_minutes),
                available: freeWith.length > 0,
                available_with: freeWith.map((row) => row.name),
                next_step: freeWith.length
                  ? "Time is free: call book_appointment NOW with these details; it will return the official read-back to confirm with the client."
                  : "Time is taken: offer the slots list instead."
              };
            } else if (wanted !== null) {
              payload.requested_time = {
                time: args.time,
                available: false,
                reason: wanted + service.duration_minutes > window[1] && wanted < window[1]
                  ? `${service.name} takes ${service.duration_minutes} min and would end after closing (${minutesLabel(window[1])}). The last start for it is ${minutesLabel(window[1] - service.duration_minutes)}.`
                  : `outside working hours ${hoursLabelForOffset(day.offset)} on ${dayLabel(day.offset)}`
              };
            }
          }
          return payload;
        }

        case "get_client_context": {
          // A phone typed into the public webchat is not proof of ownership. Only
          // disclose/act on a returning client's data on a channel where the caller
          // is server-verified; otherwise treat everyone as a new guest.
          if (!isVerifiedChannel(session.channel)) {
            return { found: false, note: "Cannot look up accounts by phone in this channel. Ask the client for their name and help them as a new guest." };
          }
          const client = findClientByPhone(args.phone);
          if (!client) return { found: false, note: "No client with this phone. Treat as a new client; ask for their name." };
          linkConversationToClient(session, client.id);
          session.client_phone = args.phone;
          const upcoming = store.getActiveAppointmentForClient(client.id);
          const history = store.getClientHistory(client.id).slice(0, 2);
          history.forEach((visit) => notePrice(session, visit.amount));
          if (upcoming) notePrice(session, upcoming.price_value);
          return {
            found: true,
            client: {
              name: client.name,
              status: client.status,
              preferences: store.getClientPreferences(client.id).slice(0, 3),
              last_visit: client.last_visit,
              recent_visits: history,
              upcoming: upcoming ? {
                appointment_id: upcoming.id,
                service: upcoming.service_name,
                stylist: upcoming.stylist_name,
                day: dayLabel(Number(upcoming.day_offset || 0)),
                time: store.formatTimeRange(upcoming.start_minutes, upcoming.end_minutes)
              } : null
            },
            note: upcoming
              ? "Use at most ONE remembered detail, casually. If the client wants to cancel or move the upcoming visit, IMMEDIATELY call cancel_appointment / reschedule_appointment — the tool returns the official read-back. Never compose your own confirmation question first."
              : "Use at most ONE remembered detail, casually. Never recite the whole file."
          };
        }

        case "book_appointment": {
          const matches = resolveServiceForTool(session, turn, args.service);
          if (matches.length !== 1) {
            if (matches.length) session.state.lastAmbiguous = matches.map((row) => row.id);
            return matches.length
              ? { ambiguous: true, options: matches.map((row) => serviceSummary(session, row)), note: "Ask which service exactly, once. If they already answered, pass that exact service name." }
              : { found: false, known_services: allServices().map((row) => serviceSummary(session, row)) };
          }
          const service = matches[0];
          noteDraft(session, { serviceId: service.id, serviceName: service.name });
          if (consultOnly(service)) return consultOnlyResult(session, service);
          const day = dayForTool(turn, args.day);
          if (day.error) return dayError(day);
          const window = hoursForOffset(day.offset);
          if (!window) {
            return {
              closed: true,
              salon_closed_that_day: true,
              note: `The salon is closed on ${dayLabel(day.offset)}. Offer the next days below.`,
              next_days: nextBookableDays(day.offset, service, null)
            };
          }
          const startMinutes = parseTimeFlexible(args.time);
          if (startMinutes === null) return { error: "unparsed_time", note: "Ask for a concrete time like 14:00." };
          const endMinutes = startMinutes + service.duration_minutes;
          const stylistPick = stylistForTool(session, turn, args.stylist);
          let stylist = stylistPick.row;
          if (stylistPick.notFound) {
            return { stylist_not_found: true, stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role, works_on: staffScheduleLabel(row) })) };
          }
          const problem = staffProblem(stylist, service, day.offset);
          if (problem) return problem;
          if (startMinutes < window[0] || endMinutes > window[1]) {
            return {
              error: "outside_hours",
              note: `Working hours on ${dayLabel(day.offset)} are ${hoursLabelForOffset(day.offset)}, and ${service.name} (${service.duration_minutes} min) must end by closing: the last start is ${minutesLabel(window[1] - service.duration_minutes)}. Tell the client honestly and offer times inside those hours.`,
              alternatives: freeSlots(day.offset, service.duration_minutes, stylist, service.id).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          if (day.offset === 0 && startMinutes < minStartForOffset(0)) {
            const alternatives = freeSlots(0, service.duration_minutes, stylist, service.id).map((s) => ({ stylist: s.stylist, time: s.time }));
            return {
              error: "time_in_past",
              note: `That time today is already past: it is ${minutesLabel(salonMinutesNow())} salon time. Refuse honestly.${alternatives.length ? " Offer these future slots instead." : " Nothing is left today; offer the next days below."}`,
              alternatives,
              next_days: alternatives.length ? undefined : nextBookableDays(0, service, stylist)
            };
          }
          if (!stylist) {
            stylist = store.getStylistRows().find((row) => staffWorksOn(row, day.offset) && staffDoesService(row, service.id) &&
              slotFree(day.offset, row.id, startMinutes, endMinutes)) || null;
            if (!stylist) {
              return {
                ok: false, reason: "slot_taken",
                alternatives: freeSlots(day.offset, service.duration_minutes, null, service.id).map((s) => ({ stylist: s.stylist, time: s.time }))
              };
            }
          } else if (!slotFree(day.offset, stylist.id, startMinutes, endMinutes)) {
            return {
              ok: false, reason: "slot_taken", stylist: stylist.name,
              alternatives: freeSlots(day.offset, service.duration_minutes, stylist, service.id).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          const conversation = getConversationRow(session.conversation_id);
          const known = session.state.client || {};
          const argName = String(args.client_name || "").trim();
          const clientName = (argName && !isPlaceholderName(argName) && !resolveStylistExact(argName) ? argName : "") ||
            known.name ||
            (session.client_id ? (store.getClientRecordById(session.client_id) || {}).name : "") ||
            (isPlaceholderName(conversation.name) ? "" : conversation.name);
          const clientPhone = String(args.client_phone || "").trim() || known.phone || session.client_phone || "";
          if (!clientName) {
            noteDraft(session, { serviceId: service.id, serviceName: service.name, dayOffset: day.offset, startMinutes, stylistId: stylist.id });
            return {
              needs_client_name: true,
              slot_is_free: true,
              note: "The slot is free. Ask the client for their name (and a phone number) in ONE question, then call book_appointment again with client_name."
            };
          }
          noteClient(session, { name: clientName, phone: clientPhone });
          const proposal = {
            kind: "book",
            serviceId: service.id,
            serviceName: service.name,
            stylistId: stylist.id,
            stylistName: stylist.name,
            dayOffset: day.offset,
            startMinutes,
            timeLabel: store.formatTimeRange(startMinutes, endMinutes),
            clientName,
            clientPhone,
            price: service.price_label
          };
          notePrice(session, service.price_value);
          const pending = session.state.pendingAction;
          if (!pendingMatches(pending, proposal) || !isAffirmation(turn.userMessage) ||
              consentLooksStale(session, pending)) {
            proposal.stagedAt = turn.incomingIndex || 0;
            session.state.pendingAction = proposal;
            turn.stagedAction = proposal;
            noteDraft(session, { dayOffset: day.offset, startMinutes, stylistId: stylist.id });
            return {
              status: "needs_confirmation",
              read_back: {
                service: service.name,
                stylist: stylist.name,
                day: dayLabel(day.offset),
                date: dayIso(day.offset),
                time: proposal.timeLabel,
                client_name: clientName,
                price: service.price_label
              },
              instruction: "Read these details back to the client, in the client's language, and ask ONE question: shall I book it? Do NOT say the booking is created. The system books it by itself when the client says yes."
            };
          }
          // commit — the only path that writes the appointment
          const bookingKey = turn.clientKey || ("sid:" + session.id);
          if (bookingQuotaExceeded(bookingKey)) {
            leaveOwnerMessage(session, `Достигнут лимит записей от одного посетителя — возможное злоупотребление. Последний запрос: ${service.name}, ${dayLabel(day.offset)} ${proposal.timeLabel}.`, "booking_quota");
            return { status: "failed", note: "Too many bookings from this visitor recently. Tell the client honestly the booking is NOT confirmed and the owner will follow up within the hour." };
          }
          const appointmentId = store.createAppointment({
            clientId: session.client_id || undefined,
            client: clientName,
            phone: clientPhone || undefined,
            serviceId: service.id,
            service: service.name,
            stylist: stylist.name,
            date: proposal.timeLabel,
            dayOffset: day.offset,
            notes: `Booked by Maya (AI assistant) via ${session.channel} chat.`
          });
          const testBooking = isTestSession(session);
          if (appointmentId && testBooking) {
            db.prepare(`UPDATE appointments SET is_test = 1, tags_json = '["Test"]' WHERE salon_id = ? AND id = ?`).run(salonId, appointmentId);
          }
          const row = appointmentId ? db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND id = ?`).get(salonId, appointmentId) : null;
          if (!row) {
            leaveOwnerMessage(session, `Не удалось создать запись: ${service.name}, ${dayLabel(day.offset)} ${proposal.timeLabel}, клиент ${clientName}.`, "booking_failed");
            return { status: "failed", note: "DB write failed. Tell the client honestly the booking is NOT confirmed and the salon team will reply here as soon as they can." };
          }
          turn.committedPending = proposal;
          session.state.pendingAction = null;
          turn.actionCommitted = true;
          noteBooking(bookingKey);
          linkConversationToClient(session, row.client_id);
          db.prepare(`
            UPDATE conversations SET status = ?, today_service = ?, today_time = ?, today_amount = ?, today_stylist = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `).run("Booked by Maya AI", service.name, proposal.timeLabel, service.price_label, stylist.name, new Date().toISOString(), session.conversation_id, salonId);
          addSystemThreadNote(session, `Maya booked: ${service.name} with ${stylist.name}, ${dayLabel(day.offset)} ${proposal.timeLabel}.`);
          recordEvent(session, "booking", {
            appointmentId,
            client: clientName,
            service: service.name,
            stylist: stylist.name,
            day: dayLabel(day.offset),
            time: proposal.timeLabel,
            price: service.price_label,
            date: isoDateForOffset(day.offset),
            startMinutes: proposal.startMinutes,
            phone: clientPhone,
            test: testBooking
          });
          return {
            status: "booked",
            appointment: {
              id: appointmentId,
              service: service.name,
              stylist: stylist.name,
              day: dayLabel(day.offset),
              date: dayIso(day.offset),
              time: proposal.timeLabel,
              price: service.price_label
            }
          };
        }

        case "reschedule_appointment": {
          const target = findClientAppointment(session, args.appointment_id);
          if (!target) return { ok: false, reason: "no_appointment_found", note: "Ask for the client's phone and call get_client_context first." };
          const day = resolveDay(args.day);
          if (day.error) return dayError(day);
          const duration = target.end_minutes - target.start_minutes;
          const targetService = allServices().find((row) => row.id === target.service_id) ||
            { id: target.service_id, name: target.service_name, duration_minutes: duration, price_label: target.price_label || "" };
          const serviceForSlots = Object.assign({}, targetService, { duration_minutes: duration });
          const window = hoursForOffset(day.offset);
          if (!window) {
            return {
              closed: true,
              salon_closed_that_day: true,
              note: `The salon is closed on ${dayLabel(day.offset)}. Offer the next days below.`,
              next_days: nextBookableDays(day.offset, serviceForSlots, null)
            };
          }
          const startMinutes = parseTimeFlexible(args.time);
          if (startMinutes === null) return { error: "unparsed_time" };
          const endMinutes = startMinutes + duration;
          const reschedulePick = stylistForTool(session, turn, args.stylist);
          if (reschedulePick.notFound) return { stylist_not_found: true, stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role, works_on: staffScheduleLabel(row) })) };
          const stylist = reschedulePick.row || db.prepare(`SELECT * FROM stylists WHERE salon_id = ? AND id = ?`).get(salonId, target.stylist_id);
          if (!stylist) return { stylist_not_found: true, stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role, works_on: staffScheduleLabel(row) })) };
          const problem = staffProblem(stylist, serviceForSlots, day.offset);
          if (problem) return problem;
          if (startMinutes < window[0] || endMinutes > window[1]) {
            return { error: "outside_hours", note: `Working hours on ${dayLabel(day.offset)} are ${hoursLabelForOffset(day.offset)}; the visit must end by closing (last start ${minutesLabel(window[1] - duration)}).` };
          }
          if (day.offset === 0 && startMinutes < minStartForOffset(0)) {
            return {
              error: "time_in_past",
              note: `That time today is already past: it is ${minutesLabel(salonMinutesNow())} salon time. Offer a future time instead.`,
              alternatives: freeSlots(0, duration, stylist, target.service_id).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          const busy = busyIntervals(day.offset, stylist.id).some((iv) =>
            startMinutes < iv.end_minutes && endMinutes > iv.start_minutes &&
            !(target.day_offset === day.offset && target.stylist_id === stylist.id && iv.start_minutes === target.start_minutes)
          );
          if (busy) {
            return { ok: false, reason: "slot_taken", alternatives: freeSlots(day.offset, duration, stylist, target.service_id).map((s) => ({ stylist: s.stylist, time: s.time })) };
          }
          const proposal = {
            kind: "reschedule",
            appointmentId: target.id,
            serviceId: target.service_id,
            serviceName: target.service_name,
            stylistId: stylist.id,
            stylistName: stylist.name,
            dayOffset: day.offset,
            startMinutes,
            timeLabel: store.formatTimeRange(startMinutes, endMinutes),
            clientName: target.client_name
          };
          const pending = session.state.pendingAction;
          if (!pendingMatches(pending, proposal) || !isAffirmation(turn.userMessage)) {
            proposal.stagedAt = turn.incomingIndex || 0;
            session.state.pendingAction = proposal;
            turn.stagedAction = proposal;
            return {
              status: "needs_confirmation",
              read_back: {
                service: target.service_name,
                stylist: stylist.name,
                new_day: dayLabel(day.offset),
                new_date: dayIso(day.offset),
                new_time: proposal.timeLabel,
                client_name: target.client_name
              },
              instruction: "Read the new details back in the client's language and ask ONE question: shall I move it? The system moves it by itself when the client says yes."
            };
          }
          const resultId = store.rescheduleAppointment(target.id, {
            stylist: stylist.name,
            date: proposal.timeLabel,
            dayOffset: day.offset
          });
          if (!resultId || resultId.error) {
            leaveOwnerMessage(session, `Не удалось перенести запись ${target.id} (${target.client_name}).`, "reschedule_failed");
            return { status: "failed", note: "Reschedule failed in the system. Tell the client honestly; the owner will follow up." };
          }
          const check = db.prepare(`SELECT start_minutes, day_offset FROM appointments WHERE salon_id = ? AND id = ?`).get(salonId, target.id);
          if (!check || check.start_minutes !== startMinutes || check.day_offset !== day.offset) {
            return { status: "failed", note: "Could not verify the reschedule. Be honest with the client." };
          }
          turn.committedPending = proposal;
          session.state.pendingAction = null;
          turn.actionCommitted = true;
          addSystemThreadNote(session, `Maya rescheduled: ${target.service_name} → ${dayLabel(day.offset)} ${proposal.timeLabel} with ${stylist.name}.`);
          recordEvent(session, "reschedule", {
            appointmentId: target.id,
            client: target.client_name,
            service: target.service_name,
            stylist: stylist.name,
            day: dayLabel(day.offset),
            time: proposal.timeLabel,
            date: isoDateForOffset(day.offset),
            startMinutes,
            fromDate: isoDateForOffset(target.day_offset),
            fromStartMinutes: target.start_minutes,
            phone: session.client_phone || ""
          });
          const movePolicy = policyNote(proposal, session.language);
          return Object.assign({ status: "rescheduled", appointment: { id: target.id, service: target.service_name, stylist: stylist.name, day: dayLabel(day.offset), time: proposal.timeLabel } },
            movePolicy ? { policy: movePolicy, instruction: "First confirm the new time to the client, then quote this policy text." } : {});
        }

        case "cancel_appointment": {
          const target = findClientAppointment(session, args.appointment_id);
          if (!target) return { ok: false, reason: "no_appointment_found", note: "Ask for the client's phone and call get_client_context first." };
          const proposal = {
            kind: "cancel",
            appointmentId: target.id,
            serviceName: target.service_name,
            stylistName: target.stylist_name || "",
            dayOffset: Number(target.day_offset || 0),
            startMinutes: target.start_minutes,
            timeLabel: store.formatTimeRange(target.start_minutes, target.end_minutes),
            clientName: target.client_name
          };
          const pending = session.state.pendingAction;
          if (!pendingMatches(pending, proposal) || !isAffirmation(turn.userMessage)) {
            proposal.stagedAt = turn.incomingIndex || 0;
            session.state.pendingAction = proposal;
            turn.stagedAction = proposal;
            return {
              status: "needs_confirmation",
              read_back: {
                service: target.service_name,
                stylist: target.stylist_name || "",
                day: dayLabel(Number(target.day_offset || 0)),
                time: store.formatTimeRange(target.start_minutes, target.end_minutes),
                client_name: target.client_name
              },
              instruction: "Read these details back in the client's language and ask ONE question: shall I cancel it? The system cancels it by itself when the client says yes."
            };
          }
          const resultId = store.cancelAppointment(target.id, { reason: args.reason || "Canceled by client via Maya (AI assistant)" });
          if (!resultId || resultId.error) {
            leaveOwnerMessage(session, `Не удалось отменить запись ${target.id} (${target.client_name}).`, "cancel_failed");
            return { status: "failed", note: "Cancellation failed; be honest, the owner will follow up." };
          }
          const check = db.prepare(`SELECT appointment_status FROM appointments WHERE salon_id = ? AND id = ?`).get(salonId, target.id);
          if (!check || check.appointment_status !== "canceled") {
            return { status: "failed", note: "Could not verify the cancellation. Be honest with the client." };
          }
          turn.committedPending = proposal;
          session.state.pendingAction = null;
          turn.actionCommitted = true;
          addSystemThreadNote(session, `Maya canceled: ${target.service_name}, ${store.formatTimeRange(target.start_minutes, target.end_minutes)}.`);
          recordEvent(session, "cancellation", {
            appointmentId: target.id,
            client: target.client_name,
            service: target.service_name,
            date: isoDateForOffset(target.day_offset),
            startMinutes: target.start_minutes,
            phone: session.client_phone || ""
          });
          const cancelPolicy = policyNote(proposal, session.language);
          return Object.assign({ status: "canceled", appointment: { id: target.id, service: target.service_name } },
            cancelPolicy ? { policy: cancelPolicy, instruction: "First tell the client the appointment is cancelled, then quote this policy text." } : {});
        }

        case "leave_message_for_owner": {
          if (!String(args.message || "").trim()) return { error: "empty_message" };
          leaveOwnerMessage(session, args.message, args.topic);
          return { ok: true, note: "Saved. Tell the client the salon team will reply here as soon as they can. Never promise a response time." };
        }

        case "request_human_handoff": {
          turn.handoffRequested = true;
          // Keep the escalation reason canonical (it drives digest grouping and
          // the alert-email category); the model's free-text goes into the summary.
          const KNOWN_REASONS = ["explicit_request", "medical", "complaint", "price_dispute", "frustration", "repeated_misunderstanding"];
          const rawReason = String(args.reason || "").trim();
          const reason = KNOWN_REASONS.includes(rawReason) ? rawReason : (turn.escalateAfter || "assistant_requested");
          const summary = [
            turn.userMessage,
            rawReason && !KNOWN_REASONS.includes(rawReason) ? `Maya's summary: ${rawReason}` : ""
          ].filter(Boolean).join(" | ");
          escalate(session, reason, summary);
          return { ok: true, note: "Conversation flagged for a human. Tell the client the salon team will reply here as soon as they can, then stay silent." };
        }

        default:
          return { error: `unknown_tool:${name}` };
      }
    }

    // ---------- deterministic commit backstop ----------
    // When the client explicitly affirmed a staged action but the model failed to
    // produce anything (empty reply / LLM error), commit the staged action in
    // code — all its arguments were already validated when it was staged.
    // ---------- client-language templates for booking steps ----------
    const LOCALE = { en: "en-CA", fr: "fr-CA", ru: "ru-RU", uk: "uk-UA" };
    function localDay(offset, lang) {
      const [y, m, d] = dayIso(offset).split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, d, 12));
      return new Intl.DateTimeFormat(LOCALE[lang] || "en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(date);
    }
    function localTime(minutes, lang) {
      if (lang === "en" || !LOCALE[lang]) {
        const h = Math.floor(minutes / 60);
        return `${h % 12 || 12}:${String(minutes % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
      }
      if (lang === "fr") return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, "0")}` : ""}`;
      return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
    }
    function readBackText(pending, lang) {
      const day = localDay(pending.dayOffset, lang);
      const time = localTime(pending.startMinutes, lang);
      const name = pending.clientName && !isPlaceholderName(pending.clientName) ? pending.clientName : "";
      const service = pending.serviceName || "";
      const staff = pending.stylistName || "";
      const pack = {
        book: {
          en: `To confirm: ${service}${staff ? ` with ${staff}` : ""}, ${day} at ${time}${name ? `, under the name ${name}` : ""}. Shall I book it?`,
          fr: `Je récapitule : ${service}${staff ? ` avec ${staff}` : ""}, ${day} à ${time}${name ? `, au nom ${/^[aeiouyhàâéèêîïôûœ]/i.test(name) ? "d'" : "de "}${name}` : ""}. Je confirme la réservation?`,
          ru: `Проверяю: ${service}${staff ? `, мастер ${staff}` : ""}, ${day}, ${time}${name ? `, на имя ${name}` : ""}. Записываю?`,
          uk: `Перевіряю: ${service}${staff ? `, майстер ${staff}` : ""}, ${day}, ${time}${name ? `, на ім'я ${name}` : ""}. Записую?`
        },
        reschedule: {
          en: `To confirm: I'll move ${service}${staff ? ` with ${staff}` : ""} to ${day} at ${time}. Shall I move it?`,
          fr: `Je récapitule : je déplace ${service}${staff ? ` avec ${staff}` : ""} au ${day} à ${time}. Je confirme le changement?`,
          ru: `Проверяю: переношу ${service}${staff ? `, мастер ${staff}` : ""}, на ${day}, ${time}. Переносим?`,
          uk: `Перевіряю: переношу ${service}${staff ? `, майстер ${staff}` : ""}, на ${day}, ${time}. Переносимо?`
        },
        cancel: {
          en: `To confirm: ${service}${staff ? ` with ${staff}` : ""}, ${day} at ${time}. Shall I cancel it?`,
          fr: `Je récapitule : ${service}${staff ? ` avec ${staff}` : ""}, ${day} à ${time}. Je l'annule?`,
          ru: `Проверяю: ${service}${staff ? `, мастер ${staff}` : ""}, ${day}, ${time}. Отменяем?`,
          uk: `Перевіряю: ${service}${staff ? `, майстер ${staff}` : ""}, ${day}, ${time}. Скасовуємо?`
        }
      };
      return localized(pack[pending.kind] || pack.book, lang);
    }
    function committedText(pending, lang) {
      const day = localDay(pending.dayOffset, lang);
      const time = localTime(pending.startMinutes, lang);
      const service = pending.serviceName || "";
      const staff = pending.stylistName || "";
      const pack = {
        book: {
          en: `All set, you're booked: ${service}${staff ? ` with ${staff}` : ""}, ${day} at ${time}. If plans change, just message me here.`,
          fr: `C'est fait, votre rendez-vous est réservé : ${service}${staff ? ` avec ${staff}` : ""}, ${day} à ${time}. Si vos plans changent, écrivez-moi ici.`,
          ru: `Готово, вы записаны: ${service}${staff ? `, мастер ${staff}` : ""}, ${day}, ${time}. Если планы поменяются, просто напишите мне.`,
          uk: `Готово, вас записано: ${service}${staff ? `, майстер ${staff}` : ""}, ${day}, ${time}. Якщо плани зміняться, просто напишіть мені.`
        },
        reschedule: {
          en: `Done, your visit is moved: ${service} is now ${day} at ${time}${staff ? ` with ${staff}` : ""}.`,
          fr: `C'est fait, votre rendez-vous est déplacé : ${service}, ${day} à ${time}${staff ? ` avec ${staff}` : ""}.`,
          ru: `Готово, перенесла: ${service} теперь ${day}, ${time}${staff ? `, мастер ${staff}` : ""}.`,
          uk: `Готово, перенесла: ${service} тепер ${day}, ${time}${staff ? `, майстер ${staff}` : ""}.`
        },
        cancel: {
          en: "Done, the appointment is cancelled. If you'd like to come back, I'm here.",
          fr: "C'est fait, le rendez-vous est annulé. Si vous voulez revenir, je suis là.",
          ru: "Готово, запись отменена. Если захотите вернуться — я всегда тут.",
          uk: "Готово, запис скасовано. Якщо захочете повернутися — я завжди тут."
        }
      };
      return localized(pack[pending.kind] || pack.book, lang);
    }
    // Does the reply actually show the client the staged time? A consent is
    // only valid for a read-back the client has seen.
    function replyShowsTime(reply, minutes) {
      const value = String(reply || "").toLowerCase();
      const h = Math.floor(minutes / 60);
      const mm = String(minutes % 60).padStart(2, "0");
      const h12 = h % 12 || 12;
      const forms = [`${h}:${mm}`, `${h}h${mm === "00" ? "" : mm}`, `${h} h${mm === "00" ? "" : ` ${mm}`}`, `${h12}:${mm}`];
      if (mm === "00") forms.push(`${h12} pm`, `${h12}pm`, `${h12} am`, `${h12}am`, `${h} ч`, `${h} год`);
      // A substring match is not enough: "12:00" contains "2:00", so an offer of
      // 9:00 / 12:00 / 1:00 / 3:00 used to read as "the client saw 2:00 PM" and
      // their "yes" committed a 14:00 slot nobody had shown them.
      return forms.some((form) => {
        const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![\\d:.])${escaped}(?![\\d])`).test(value);
      });
    }

    // ---------- deterministic commit ----------
    // Commits the staged action in code (all its arguments were validated when
    // it was staged). Used on the client's "yes" before the model runs, and as
    // the backstop when the model produced nothing.
    function commitPendingAction(session, turn) {
      const pending = session.state.pendingAction;
      if (!pending) return null;
      const lang = session.language;
      // The staged day is authoritative here; the drift guard must not touch it.
      const savedDraftDay = turn.draftDayAtStart;
      turn.draftDayAtStart = undefined;
      try {
        if (pending.kind === "book") {
          const result = executeTool(session, turn, "book_appointment", {
            service: pending.serviceName,
            day: String(pending.dayOffset),
            time: minutesLabel(pending.startMinutes),
            stylist: pending.stylistName,
            client_name: pending.clientName,
            client_phone: pending.clientPhone
          });
          if (result && result.status === "booked") return [committedText(pending, lang), policyNote(pending, lang)].filter(Boolean).join(" ");
        } else if (pending.kind === "reschedule") {
          const result = executeTool(session, turn, "reschedule_appointment", {
            day: String(pending.dayOffset),
            time: minutesLabel(pending.startMinutes),
            stylist: pending.stylistName,
            appointment_id: pending.appointmentId
          });
          if (result && result.status === "rescheduled") return [committedText(pending, lang), policyNote(pending, lang)].filter(Boolean).join(" ");
        } else if (pending.kind === "cancel") {
          const result = executeTool(session, turn, "cancel_appointment", { appointment_id: pending.appointmentId });
          if (result && result.status === "canceled") return [committedText(pending, lang), policyNote(pending, lang)].filter(Boolean).join(" ");
        }
      } catch (error) {
        // fall through to the honest fallback path
      } finally {
        turn.draftDayAtStart = savedDraftDay;
      }
      return null;
    }

    // ---------- time guard ----------
    // Every check_availability result is remembered per date: the times it
    // listed (slots, a free requested time, the next free days). A reply may
    // offer a time only when that result, or a check in code right now, says
    // it is free for the service being discussed.
    function isoOffset(iso) {
      const [y, m, d] = String(iso).split("-").map(Number);
      return Math.round((Date.UTC(y, m - 1, d) - refDayUtcMs()) / 86400000);
    }

    function recordAvailability(session, result) {
      if (!result || typeof result !== "object") return;
      const state = session.state;
      state.toolTimes = state.toolTimes || {};
      const startOf = (label) => parseTimeFlexible(String(label || "").split(/\s+-\s+/)[0]);
      const put = (iso, slots, extra) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return;
        const times = (slots || []).map((slot) => startOf(slot && slot.time)).filter((value) => value !== null);
        if (extra !== undefined && extra !== null) times.push(extra);
        state.toolTimes[iso] = [...new Set(times)];
      };
      if (result.date) {
        const requested = result.requested_time && result.requested_time.available ? startOf(result.requested_time.time) : null;
        put(result.date, result.slots || [], requested);
      }
      (result.next_days || []).forEach((day) => put(day.date, day.slots));
      const keys = Object.keys(state.toolTimes).sort();
      while (keys.length > 14) delete state.toolTimes[keys.shift()];
      if (result.date) state.lastCheckedDate = result.date;
    }

    function bookableNow(offset, start, service) {
      const window = hoursForOffset(offset);
      if (!window) return false;
      const minStart = minStartForOffset(offset);
      const duration = service ? service.duration_minutes : SLOT_STEP_MINUTES;
      if (start < minStart || start + duration > window[1]) return false;
      const staff = store.getStylistRows().filter((row) => staffWorksOn(row, offset) && (!service || staffDoesService(row, service.id)));
      return staff.some((row) => slotFree(offset, row.id, start, start + duration));
    }

    const TIME_HOURS_RE = /(open|clos|hours|we're here|ouvr|ouvert|ferm|horaire|работа|открыт|закрыва|працю|відчин|зачин|last (start|appointment|booking)|dernier rendez|walk-?in|sans rendez)/i;
    const TIME_NEGATIVE_RE = /(not (available|free|open)|isn't (available|free|open)|unavailable|taken|fully booked|booked up|no (free|open)|already (booked|past|gone)|has passed|pas (libre|disponible)|indisponible|complet|déjà (pris|passé)|занят|нет свобод|недоступ|уже прош|зайнят|немає вільн|вже мину)/i;

    // The first time in the reply that nothing says is free: { offset, raw } | null.
    function unverifiedTime(session, turn, reply) {
      const state = session.state;
      const draft = state.draft || {};
      const service = draft.serviceId ? allServices().find((row) => row.id === draft.serviceId) : null;
      const pending = state.pendingAction;
      const faqTimes = new Set();
      faqTopics().forEach((topic) => replyTimes(topic.text).forEach((hit) => hit.options.forEach((value) => faqTimes.add(value))));
      const sentences = String(reply || "").split(/(?<=[.!?…])\s+|\n+/);
      let fallbackIso = turn.lastCheckedDate || (draft.dayOffset !== undefined ? dayIso(draft.dayOffset) : "");
      for (const sentence of sentences) {
        const hits = replyTimes(sentence);
        const named = findDates(sentence).find((hit) => hit.offset !== undefined);
        if (named) fallbackIso = dayIso(named.offset);
        if (!hits.length || TIME_HOURS_RE.test(sentence) || TIME_NEGATIVE_RE.test(sentence)) continue;
        if (!fallbackIso) continue;
        const offset = isoOffset(fallbackIso);
        if (offset < 0 || offset > dates.MAX_OFFSET) continue;
        const listed = new Set((state.toolTimes || {})[fallbackIso] || []);
        const own = db.prepare(`
          SELECT start_minutes FROM appointments WHERE salon_id = ? AND day_offset = ? AND appointment_status = 'scheduled'
            AND client_id != '' AND client_id = ?
        `).all(salonId, offset, session.client_id || (getConversationRow(session.conversation_id) || {}).client_id || "").map((row) => row.start_minutes);
        for (const hit of hits) {
          const ok = hit.options.some((value) => listed.has(value) || faqTimes.has(value) || own.includes(value) ||
            (pending && pending.dayOffset === offset && pending.startMinutes === value) ||
            bookableNow(offset, value, service));
          if (!ok) return { offset, raw: hit.raw, service };
        }
      }
      return null;
    }

    // A "yes" consents to the last thing the client actually read. When Maya's
    // last message offered times and the staged action's time is not among
    // them — the time guard replaced a wrong offer with the real free slots, or
    // the model listed new ones — the client is agreeing to one of THOSE, not
    // to the old staged slot. Silently committing the old one is how Maya came
    // to offer 10:00/11:30/13:30/15:00 and then book 14:00.
    function consentLooksStale(session, staged) {
      if (!staged || staged.startMinutes === undefined || staged.startMinutes === null) return false;
      const lastOut = db.prepare(`
        SELECT text_value FROM conversation_messages
        WHERE salon_id = ? AND conversation_id = ? AND type = 'outgoing'
        ORDER BY sort_order DESC LIMIT 1
      `).get(salonId, session.conversation_id);
      const seen = String((lastOut && lastOut.text_value) || "");
      if (!seen) return false;
      if (replyShowsTime(seen, staged.startMinutes)) return false;
      for (const sentence of seen.split(/(?<=[.!?\u2026])\s+|\n+/)) {
        if (TIME_HOURS_RE.test(sentence) || TIME_NEGATIVE_RE.test(sentence)) continue;
        for (const hit of replyTimes(sentence)) {
          if (!hit.options.includes(staged.startMinutes)) return true;
        }
      }
      return false;
    }

    // The honest replacement: real free times for that day from the calendar.
    function slotOfferText(session, offset, service, lang) {
      if (!service) {
        return localized({
          en: "Let me check the real free times first. Which service would you like, and on which day?",
          fr: "Je vérifie d'abord les vraies disponibilités. Quel service voulez-vous, et quel jour?",
          ru: "Сначала проверю реальные свободные окна. Какая услуга вам нужна и на какой день?",
          uk: "Спершу перевірю реальні вільні вікна. Яка послуга вам потрібна і на який день?"
        }, lang);
      }
      const stylist = (session.state.draft || {}).stylistId ? store.getStylistRows().find((row) => row.id === session.state.draft.stylistId) : null;
      let slots = freeSlots(offset, service.duration_minutes, stylist && staffDoesService(stylist, service.id) ? stylist : null, service.id);
      let day = offset;
      let moved = false;
      if (!slots.length) {
        for (let next = offset + 1; next <= Math.min(offset + 21, dates.MAX_OFFSET); next++) {
          const found = freeSlots(next, service.duration_minutes, null, service.id);
          if (found.length) { slots = found; day = next; moved = true; break; }
        }
      }
      if (!slots.length) {
        return localized({
          en: `I can't find a free time for ${service.name} in the next few weeks. I've let the salon team know; they will reply here as soon as they can.`,
          fr: `Je ne trouve pas de disponibilité pour ${service.name} dans les prochaines semaines. J'ai prévenu l'équipe du salon, on vous répondra ici dès que possible.`,
          ru: `Не нахожу свободного времени на «${service.name}» в ближайшие недели. Я передала это команде салона, вам ответят здесь.`,
          uk: `Не знаходжу вільного часу на «${service.name}» найближчими тижнями. Я передала це команді салону, вам дадуть відповідь тут.`
        }, lang);
      }
      const starts = [...new Set(slots.map((slot) => slot.startMinutes))].slice(0, 4);
      session.state.toolTimes = session.state.toolTimes || {};
      session.state.toolTimes[dayIso(day)] = starts;
      const list = starts.map((value) => localTime(value, lang));
      const joined = {
        en: list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}` : list[0],
        fr: list.length > 1 ? `${list.slice(0, -1).join(", ")} ou ${list[list.length - 1]}` : list[0],
        ru: list.length > 1 ? `${list.slice(0, -1).join(", ")} или ${list[list.length - 1]}` : list[0],
        uk: list.length > 1 ? `${list.slice(0, -1).join(", ")} або ${list[list.length - 1]}` : list[0]
      };
      const when = localDay(day, lang);
      if (moved) {
        return localized({
          en: `${localDay(offset, "en")} has no free time for ${service.name}. The next free times are ${when}: ${joined.en}. Would one of these work?`,
          fr: `Il n'y a plus de place pour ${service.name} ${localDay(offset, "fr")}. Prochaines disponibilités, ${when} : ${joined.fr}. L'une d'elles vous convient?`,
          ru: `На ${localDay(offset, "ru")} нет свободного времени на «${service.name}». Ближайшее: ${when}, ${joined.ru}. Подойдёт?`,
          uk: `На ${localDay(offset, "uk")} немає вільного часу на «${service.name}». Найближче: ${when}, ${joined.uk}. Підійде?`
        }, lang);
      }
      return localized({
        en: `For ${service.name} on ${when} I can offer ${joined.en}. Which one suits you?`,
        fr: `Pour ${service.name}, ${when}, je peux vous proposer ${joined.fr}. Laquelle vous convient?`,
        ru: `На «${service.name}» ${when} могу предложить ${joined.ru}. Какое время удобно?`,
        uk: `На «${service.name}» ${when} можу запропонувати ${joined.uk}. Який час зручний?`
      }, lang);
    }

    // ---------- reply gates ----------
    function gateReply(session, turn, rawReply) {
      let reply = String(rawReply || "").trim();
      const language = session.language || "en";
      const gates = [];

      if (!reply) {
        gates.push("empty_reply");
        reply = localized(FALLBACKS.unknown, language);
        // This fallback promises the team will reply — back the promise
        // with a real owner task on the SAME turn (mirror of the llm_error path).
        leaveOwnerMessage(
          session,
          `Майя не смогла ответить (пустой ответ модели). Клиент ждёт ответа: "${String(turn.userMessage || "").slice(0, 200)}"`,
          "empty_reply"
        );
      }

      // Gate 1: a sentence that CLAIMS a booking happened requires a committed
      // DB write this turn. "Once you're booked I'll send the address" is not
      // a claim. With a staged action the client gets the read-back instead.
      if (!turn.actionCommitted && rules.affirmsBooking(reply, BOOKING_CLAIM_RE)) {
        gates.push("booking_claim_blocked");
        const pending = session.state.pendingAction;
        if (pending) {
          reply = readBackText(pending, language);
        } else {
          leaveOwnerMessage(session, ownerText(
            `Maya almost told a client a visit was booked, but nothing was saved. The client was told it is not confirmed yet. Client's message: "${String(turn.userMessage || "").slice(0, 200)}"`,
            `Майя чуть не подтвердила запись, которой нет в системе. Клиенту сказано, что запись ещё не подтверждена. Сообщение клиента: "${String(turn.userMessage || "").slice(0, 200)}"`
          ), "booking_gate");
          reply = localized(FALLBACKS.notBooked, language);
        }
      }

      // Gate 2: unknown-stylist guard — if the client named a stylist who does not
      // exist, the reply may not affirm/praise that name. It survives only as an
      // explicit correction; anything else is rewritten to the honest correction.
      const unknownStylists = turn.unknownStylists || [];
      if (unknownStylists.length) {
        const replyLower = reply.toLowerCase();
        const offender = unknownStylists.find((entry) => replyLower.includes(entry.stem));
        const corrected = STYLIST_CORRECTION_RE.test(reply);
        if (offender && (!corrected || STYLIST_PRAISE_RE.test(reply))) {
          gates.push(`stylist_gate:${offender.raw}`);
          recordEvent(session, "stylist_gate", { name: offender.raw, original: reply.slice(0, 300) });
          reply = stylistCorrectionReply(language);
        }
      }

      // Gate 2b: the model itself may not introduce a stylist name that is not in
      // the stylists table ("мастер X" / "stylist X" where X is invented).
      const invented = [];
      const replyMentionRe = /(?:мастер|майстер|майстр|стилист|стиліст|stylist)[аеуоыиі]{0,2}\s+(?:по имени\s+|на ім'?я\s+|named\s+)?([A-ZА-ЯЁІЇЄҐ][a-zа-яёіїєґ'’-]{2,})/g;
      let mention;
      while ((mention = replyMentionRe.exec(reply)) !== null) {
        const candidate = mention[1];
        if (STYLIST_NAME_STOPWORDS.test(candidate)) continue;
        if (!resolveStylist(candidate)) invented.push(candidate);
      }
      if (invented.length && !STYLIST_CORRECTION_RE.test(reply)) {
        gates.push(`stylist_gate:invented:${invented[0]}`);
        recordEvent(session, "stylist_gate", { name: invented[0], invented: true, original: reply.slice(0, 300) });
        reply = stylistCorrectionReply(language);
      }

      // Gate 3: price quote-guard. Every amount must be in the salon's own
      // data: service labels (ranges, "from", add-ons, per-unit), FAQ and
      // policy text. A wrong amount gets the price straight from the
      // services table; only when no service matches does the question go
      // to the team.
      const unknownPrices = unknownPricesIn(session, reply, turn.userMessage);
      if (unknownPrices.length) {
        gates.push(`price_guard:${unknownPrices[0]}`);
        const direct = priceAnswer(turn.userMessage, language);
        if (direct) {
          reply = direct;
        } else {
          leaveOwnerMessage(session, ownerText(
            `A client asked something Maya could not answer from your prices and FAQ: "${String(turn.userMessage || "").slice(0, 200)}"`,
            `Клиент спросил то, на что Майя не нашла ответа в ваших ценах и FAQ: "${String(turn.userMessage || "").slice(0, 200)}"`
          ), "price_guard");
          reply = localized(FALLBACKS.unknown, language);
        }
      }

      // Gate 3a: a time Maya offers must come from the availability tool (or
      // be free in the calendar right now) for that day and service.
      const badTime = unverifiedTime(session, turn, reply);
      if (badTime) {
        gates.push(`time_guard:${badTime.raw}`);
        recordEvent(session, "time_guard", { time: badTime.raw, date: dayIso(badTime.offset), original: reply.slice(0, 300) });
        reply = slotOfferText(session, badTime.offset, badTime.service, language);
      }

      // Gate 3c: a year other than this one or the next is a slip ("Sep 19, 2024").
      const yearFixed = dates.fixReplyYears(reply, todayIso());
      if (yearFixed !== reply) {
        gates.push("year_fixed");
        reply = yearFixed;
      }

      // Gate 3b: a day the salon is open may not be called closed.
      const fixedClosed = fixClosedClaims(reply, language);
      if (fixedClosed !== reply) {
        gates.push("closed_claim_fixed");
        reply = fixedClosed;
      }

      // Gate 4: plain-text scrub — every Maya surface (web chat bubble, Telegram)
      // renders plain text, so markdown would show as literal asterisks/dashes.
      const plain = reply
        .replace(/^[ \t]*[-*•]\s+/gm, "")
        .replace(/\*\*([^*\n]+)\*\*/g, "$1")
        .replace(/__([^_\n]+)__/g, "$1")
        .replace(/^#{1,4}\s+/gm, "");
      if (plain !== reply) {
        gates.push("markdown_scrub");
        reply = plain;
      }

      // Gate 4b: no response-time promises on the salon's behalf.
      const unpromised = scrubTimePromises(reply);
      if (unpromised !== reply) {
        gates.push("promise_scrub");
        reply = unpromised;
      }

      // Gate 5: banned phrases (style scrub, non-blocking).
      for (const [re, replacement] of BANNED_REPLACEMENTS) {
        re.lastIndex = 0;
        if (re.test(reply)) {
          gates.push("style_scrub");
          re.lastIndex = 0;
          reply = reply.replace(re, replacement);
          // "К сожалению, в понедельник…" → "В понедельник…"
          reply = reply.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (match, lead, letter) => lead + letter.toUpperCase());
        }
      }
      reply = reply.replace(/\s{2,}/g, " ").trim();
      if (gates.length) recordEvent(session, "gate_triggered", { gates, original: String(rawReply || "").slice(0, 300) });
      return { reply, gates };
    }

    // ---------- main turn ----------
    // ---------- per-turn context ----------
    function salonLanguage() {
      if (typeof languageFor === "function") {
        try { return String(languageFor(salonId) || ""); } catch (error) { return ""; }
      }
      const record = rootStore.getSalonRecord ? (rootStore.getSalonRecord(salonId) || {}) : {};
      return String(record.language || "");
    }

    function staffNames() {
      return store.getStylistRows().map((row) => row.name);
    }

    // Team for the prompt: who works which days and which services.
    function staffDetails() {
      const services = allServices();
      return store.getStylistRows().map((row) => {
        const does = services.filter((service) => staffDoesService(row, service.id)).map((service) => service.name);
        return {
          name: row.name,
          days: staffScheduleLabel(row),
          services: does.length === services.length ? "all services" : (does.length ? does.join(", ") : "no bookable services")
        };
      });
    }

    function faqTopics() {
      return (faq.topics || []).map((topic) => ({
        id: String(topic.id || ""),
        text: String(topic.en || topic.fr || topic.ru || topic.uk || "")
      })).filter((topic) => topic.text);
    }

    function topicText(id, lang) {
      const topic = (faq.topics || []).find((entry) => entry.id === id);
      if (!topic) return "";
      return String(topic[lang] || topic.en || topic.fr || topic.ru || topic.uk || "").trim();
    }

    // Owner-facing note in the owner's language (ru owners keep Russian).
    function ownerText(en, ru) {
      return salonLanguage() === "ru" ? ru : en;
    }

    const ADDRESS_PRIVATE = rules.addressIsPrivate(faqTopics().map((topic) => topic.text));

    // Prices Maya may say: all service labels and values, the owner's FAQ
    // and policy text, client-history amounts, per-unit × client quantity.
    function priceAllowList(session, clientMessage) {
      return rules.buildPriceAllowList({
        services: allServices(),
        faqTexts: faqTopics().map((topic) => topic.text),
        extra: session.state.quotedPrices || [],
        clientMessage
      });
    }

    function unknownPricesIn(session, reply, clientMessage) {
      const allowed = priceAllowList(session, clientMessage);
      return extractPriceNumbers(reply).filter((price) => !allowed.has(Math.round(price * 100) / 100));
    }

    // "Balayage is $220–$320 depending on length." — a deterministic price
    // answer from the services table, for when the model got a price wrong.
    function priceAnswer(message, lang) {
      const lower = String(message || "").toLowerCase();
      const named = allServices().filter((row) => row.name.length >= 3 && lower.includes(row.name.toLowerCase()));
      const rows = (named.length ? named : resolveServices(message)).slice(0, 3);
      if (!rows.length) return "";
      const parts = rows.map((row) => {
        const kind = rules.priceKind(row.price_label);
        if (kind === "consultation") {
          return localized({
            en: `${row.name} is priced by consultation`,
            fr: `${row.name} : prix sur consultation`,
            ru: `${row.name}: цена после консультации`,
            uk: `${row.name}: ціна після консультації`
          }, lang);
        }
        if (kind === "free") {
          return localized({ en: `${row.name} is free`, fr: `${row.name} est gratuit`, ru: `${row.name}: бесплатно`, uk: `${row.name}: безкоштовно` }, lang);
        }
        return localized({ en: `${row.name}: ${row.price_label}`, fr: `${row.name} : ${row.price_label}`, ru: `${row.name}: ${row.price_label}`, uk: `${row.name}: ${row.price_label}` }, lang);
      });
      const tail = localized({
        en: "Would you like me to find a time?",
        fr: "Voulez-vous que je vous trouve un moment?",
        ru: "Подобрать вам время?",
        uk: "Підібрати вам час?"
      }, lang);
      return `${parts.join("; ")}. ${tail}`;
    }

    // Days a reply calls "closed" while the salon is open that day.
    function falseClosedDays(reply) {
      const names = staffNames().map((name) => String(name).split(/\s+/)[0].toLowerCase()).filter((name) => name.length >= 3);
      const found = [];
      rules.sentences(reply).forEach((sentence) => {
        if (!rules.CLOSED_WORD_RE.test(sentence)) return;
        const lower = sentence.toLowerCase();
        // "Karim is off Saturday" is about a person, not the salon.
        if (names.some((name) => lower.includes(name))) return;
        const offsets = new Set();
        WEEKDAYS.forEach((day) => {
          if (!day.re.test(sentence)) return;
          for (let offset = 0; offset < 7; offset++) if (dayWeekday(offset) === day.index) offsets.add(offset);
        });
        findDates(sentence).forEach((hit) => { if (hit.offset !== undefined) offsets.add(hit.offset); });
        offsets.forEach((offset) => {
          const window = hoursForOffset(offset);
          if (!window) return;
          if (offset === 0 && salonMinutesNow() >= window[1]) return;
          found.push({ offset, sentence });
        });
      });
      return found;
    }

    function openDaySentence(offset, lang) {
      const day = new Intl.DateTimeFormat(LOCALE[lang] || "en-CA", { weekday: "long", timeZone: "UTC" })
        .format(new Date(`${dayIso(offset)}T12:00:00Z`));
      return (OPEN_DAY_LINE[lang] || OPEN_DAY_LINE.en)(day, hoursLabelForOffset(offset));
    }

    function fixClosedClaims(reply, lang) {
      const bad = falseClosedDays(reply);
      if (!bad.length) return reply;
      let out = String(reply);
      bad.forEach(({ offset, sentence }) => { out = out.replace(sentence, openDaySentence(offset, lang)); });
      return out;
    }

    // Policy lines to add after a committed cancel / move / booking.
    function policyNote(pending, lang) {
      const lines = [];
      if (pending.kind === "cancel" || pending.kind === "reschedule") {
        const cancel = topicText("cancellation_policy", lang);
        if (cancel) lines.push(`${localized(POLICY_LEAD.cancel, lang)} ${cancel}`);
      }
      if (pending.kind === "book") {
        const service = allServices().find((row) => row.id === pending.serviceId);
        if (service && Number(service.requires_deposit)) {
          const deposit = topicText("deposit_policy", lang) || topicText("deposit_required", lang);
          if (deposit) lines.push(`${localized(POLICY_LEAD.deposit, lang)} ${deposit}`);
          faqTopics().filter((topic) => /^custom_/.test(topic.id) && /deposit|dépôt|e-?transfer|депозит|предоплат/i.test(topic.text.split(" — ")[0]))
            .slice(0, 1)
            .forEach((topic) => {
              const parts = topic.text.split(" — ");
              lines.push(parts.length > 1 ? parts.slice(1).join(" — ") : topic.text);
            });
        }
      }
      return lines.join(" ");
    }

    function dateContext() {
      return dates.calendarBlock({
        todayIso: todayIso(),
        timezone: TIMEZONE,
        nowLabel: minutesLabel(salonMinutesNow()),
        days: 14,
        hoursLabel: (offset) => {
          const label = hoursLabelForOffset(offset);
          if (label === "closed") return label;
          const rows = store.getStylistRows();
          if (rows.length <= 1) return label;
          const working = rows.filter((row) => staffWorksOn(row, offset)).map((row) => row.name);
          return `${label} (working: ${working.length ? working.join(", ") : "nobody"})`;
        }
      });
    }

    function knownClientLine(session) {
      const client = session.state.client || {};
      const draft = session.state.draft || {};
      const parts = [];
      if (client.name) parts.push(`Client's name: ${client.name}`);
      if (client.phone || session.client_phone) parts.push(`phone: ${client.phone || session.client_phone}`);
      if (draft.serviceName) parts.push(`service chosen: ${draft.serviceName}`);
      if (draft.dayOffset !== undefined) parts.push(`day chosen: ${dayIso(draft.dayOffset)} (${dates.WEEKDAY_EN[dates.weekdayOf(dayIso(draft.dayOffset))]})`);
      if (draft.startMinutes !== undefined) parts.push(`time chosen: ${minutesLabel(draft.startMinutes)}`);
      // A visit already booked for this client: cancel / move it directly,
      // without asking for a phone number.
      let upcoming = null;
      try { upcoming = session.client_id || (getConversationRow(session.conversation_id) || {}).client_id ? findClientAppointment(session) : null; } catch (error) { upcoming = null; }
      if (upcoming && upcoming.appointment_status !== "canceled" && Number(upcoming.day_offset) >= 0) {
        parts.push(`upcoming visit: ${upcoming.service_name}${upcoming.stylist_name ? ` with ${upcoming.stylist_name}` : ""}, ${dayIso(Number(upcoming.day_offset))} ${minutesLabel(upcoming.start_minutes)} (appointment_id ${upcoming.id}). To cancel or move it, call cancel_appointment / reschedule_appointment right away; no phone number needed`);
      }
      return parts.join("; ");
    }

    // Latin-script names that must never come back transliterated into
    // Cyrillic ("Karim" → "Карима", "Alexandre" → "Александр").
    function restoreNameSpelling(reply, names) {
      let value = String(reply || "");
      const latin = [];
      names.forEach((full) => String(full || "").split(/\s+/).forEach((part) => {
        if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]{3,}$/.test(part)) latin.push(part);
      }));
      if (!latin.length || !/[А-ЯЁІЇЄҐ]/.test(value)) return value;
      return value.replace(/[А-ЯЁІЇЄҐ][а-яёіїєґ'’]{2,}/g, (word) => {
        const key = nameKey(word);
        const hit = latin.find((part) => nameKey(part) === key && key.length >= 3);
        return hit || word;
      });
    }

    function autoStageFromDraft(session, turn, reply) {
      const draft = session.state.draft || {};
      if (!draft.serviceId || draft.dayOffset === undefined || draft.startMinutes === undefined) return false;
      const service = allServices().find((row) => row.id === draft.serviceId);
      if (!service) return false;
      // The staff member the model just named, if exactly one, else the draft's.
      const named = store.getStylistRows().filter((row) => new RegExp(`(^|[^\\p{L}])${escapeRe(String(row.name).split(/\s+/)[0])}`, "iu").test(String(reply)));
      const stylistRow = named.length === 1 ? named[0] : (draft.stylistId ? store.getStylistRows().find((row) => row.id === draft.stylistId) : null);
      let result;
      try {
        result = executeTool(session, Object.assign({}, turn, { userMessage: "" }), "book_appointment", {
          service: service.name,
          day: String(draft.dayOffset),
          time: minutesLabel(draft.startMinutes),
          stylist: stylistRow ? stylistRow.name : ""
        });
      } catch (error) {
        return false;
      }
      recordEvent(session, "auto_stage", { ok: Boolean(result && result.status === "needs_confirmation"), result: result ? (result.status || result.error || result.reason || (result.needs_client_name ? "needs_client_name" : "")) : "" });
      if (result && result.status === "needs_confirmation") {
        turn.stagedAction = session.state.pendingAction;
        return true;
      }
      if (result && result.needs_client_name) {
        session.state.awaitingName = true;
        turn.askName = true;
        return true;
      }
      return false;
    }

    function languageFallback(session, turn) {
      const lang = session.language;
      if (turn.committedPending) return committedText(turn.committedPending, lang);
      if (turn.stagedAction && session.state.pendingAction === turn.stagedAction) return readBackText(turn.stagedAction, lang);
      return localized(FALLBACKS.rephrase, lang);
    }

    // ---------- main turn ----------
    // The owner's own test chat: after a handoff notice she hears, in the
    // chat's language, that a real client would now wait for the team, and
    // Maya goes on answering.
    async function chat(args = {}) {
      const result = await chatTurn(args);
      const sid = String(args.sessionId || "").trim();
      const session = sid && result && !result.error ? loadSession(sid) : null;
      if (session && session.state.testHandoffNote) {
        session.state.testHandoffNote = false;
        const note = localized(TEST_HANDOFF_NOTE, session.language || "en");
        result.reply = [result.reply, note].filter(Boolean).join("\n\n");
        const last = db.prepare(`
          SELECT id FROM conversation_messages WHERE salon_id = ? AND conversation_id = ? AND type = 'outgoing'
          ORDER BY sort_order DESC LIMIT 1
        `).get(salonId, session.conversation_id);
        if (last) {
          db.prepare(`UPDATE conversation_messages SET text_value = ? WHERE salon_id = ? AND id = ?`).run(result.reply, salonId, last.id);
        } else {
          persistMessage(session, "outgoing", result.reply);
        }
        saveSession(session);
        result.state = Object.assign({}, result.state, { testHandoff: true });
      }
      return result;
    }

    async function chatTurn({ sessionId, message, channel, clientPhone, languageHint, clientName, greeted, test, clientKey }) {
      const text = String(message || "").trim().slice(0, 2000);
      const sid = String(sessionId || "").trim();
      if (!sid || !text) return { error: "bad_request", message: "sessionId and message are required." };

      // Zero-LLM watchdog fast-path: uptime probes get an instant reply and must
      // never touch the LLM, sessions, conversations, or the digest.
      if (text === "ping" && sid.startsWith("watchdog-")) {
        return { reply: "pong", watchdog: true };
      }

      // Per-IP cap first — a rotating sessionId cannot bypass it.
      if (clientKey && rateLimitedByIp(clientKey)) return { error: "rate_limited", message: "Too many messages; slow down a little." };
      if (rateLimited(sid)) return { error: "rate_limited", message: "Too many messages; slow down a little." };

      const session = ensureSession({ sessionId: sid, channel, clientPhone, language: detectLanguage(text), clientName });
      if (languageHint) session.state.languageHint = String(languageHint).slice(0, 12);
      if (test) session.state.test = true;
      slotViewTest = isTestSession(session);
      // Telegram greets on /start with the AI disclosure, so Maya does not
      // introduce herself a second time in her first reply.
      if (greeted) session.state.introduced = true;
      const langPick = resolveTurnLanguage({
        text,
        state: session.state,
        hint: session.state.languageHint || "",
        salonLanguage: salonLanguage()
      });
      session.language = langPick.language;
      const lang = session.language;
      const conversation = getConversationRow(session.conversation_id);

      // A person handles this thread (handoff or takeover). The owner's own
      // test chat never locks; a real thread returns to Maya by itself after
      // AUTO_RETURN_MS without a staff answer.
      if (conversation && ["takeover", "escalated"].includes(conversation.assistant_state)) {
        const since = handoffSinceMs(session);
        if (isTestSession(session)) {
          returnToMaya(session, "test_chat");
        } else if (since !== null && nowMs() - since >= AUTO_RETURN_MS) {
          returnToMaya(session, "auto_12h");
        }
      }
      const liveConversation = getConversationRow(session.conversation_id);
      if (liveConversation && ["takeover", "escalated"].includes(liveConversation.assistant_state)) {
        // Maya stays out of it, but the client is never met with silence: a
        // short holding line (first time, then at most every 15 minutes), and
        // the owner hears about every message (tenancy throttles the alerts).
        persistMessage(session, "incoming", text);
        recordEvent(session, "message_in", { text: text.slice(0, 300), silenced: true });
        session.state.waitingCount = (Number(session.state.waitingCount) || 0) + 1;
        recordEvent(session, "client_waiting", {
          count: session.state.waitingCount,
          text: text.slice(0, 500),
          state: liveConversation.assistant_state,
          client: (session.state.client || {}).name || ""
        });
        const lastHolding = Date.parse(session.state.holdingAt || "");
        let reply = null;
        if (!Number.isFinite(lastHolding) || nowMs() - lastHolding >= HOLDING_INTERVAL_MS) {
          reply = localized(HOLDING_REPLY, lang);
          session.state.holdingAt = clockNow().toISOString();
          persistMessage(session, "outgoing", reply);
          recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: "holding" });
        }
        saveSession(session);
        return {
          reply,
          state: sessionState(session, { silenced: true, holding: Boolean(reply), reason: liveConversation.assistant_state })
        };
      }

      persistMessage(session, "incoming", text);
      recordEvent(session, "message_in", { text: text.slice(0, 300) });

      const incomingIndex = db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_messages WHERE salon_id = ? AND conversation_id = ? AND type = 'incoming'
      `).get(salonId, session.conversation_id).count;
      const needsIntro = !session.state.introduced;

      // Who the client is, parsed before any staff matching.
      const identity = parseClientIdentity(text);
      if (!identity.name && identity.nameCandidate && session.state.awaitingName) identity.name = identity.nameCandidate;
      if (identity.name || identity.phone) {
        noteClient(session, identity);
        session.state.awaitingName = false;
      }
      // The client's answer to "which of these services?" settles it for good.
      if (Array.isArray(session.state.lastAmbiguous) && session.state.lastAmbiguous.length) {
        const picked = resolveServices(text).filter((row) => session.state.lastAmbiguous.includes(row.id));
        if (picked.length === 1) {
          noteDraft(session, { serviceId: picked[0].id, serviceName: picked[0].name });
          session.state.lastAmbiguous = [];
        }
      }

      // The day and time the client just named go into the draft too.
      const messageTime = parseClientTime(text);
      if (messageTime !== null) noteDraft(session, { startMinutes: messageTime });
      const messageDay = findDates(text).find((hit) => hit.offset !== undefined);
      if (messageDay) noteDraft(session, { dayOffset: messageDay.offset });
      const lowerText = text.toLowerCase();
      const namedServices = allServices().filter((row) => row.name.length >= 3 && lowerText.includes(row.name.toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length);
      const messageService = namedServices.length ? [namedServices[0]] : resolveServices(text);
      if (messageService.length === 1) noteDraft(session, { serviceId: messageService[0].id, serviceName: messageService[0].name });

      const turn = {
        id: createId("aturn"),
        llmCalls: 0,
        userMessage: text,
        incomingIndex,
        // The day the conversation settled on before this message. A tool call
        // that silently drifts to another day while the client named none is
        // pulled back to it (the model lost "next Thursday" between turns).
        draftDayAtStart: (session.state.draft || {}).dayOffset,
        offeredAtStart: ((session.state.draft || {}).offeredDays || []).slice(),
        clientNamedDay: Boolean(messageDay) || findDates(text).length > 0,
        actionCommitted: false,
        handoffRequested: false,
        escalateAfter: null,
        clientKey: clientKey ? "ip:" + clientKey : null,
        unknownStylists: detectUnknownStylists(text, [(session.state.client || {}).name || ""])
      };

      const finishIntro = (reply) => {
        let out = reply;
        if (needsIntro && !hasAiDisclosure(out)) {
          out = withFirstTurnIntro(out, lang);
          recordEvent(session, "gate_triggered", { gates: ["first_turn_disclosure"] });
        }
        session.state.introduced = true;
        return out;
      };

      // Hard triggers answer without the LLM; soft ones steer this turn then escalate.
      const trigger = checkTriggers(text);
      if (trigger && trigger.hard) {
        const reply = finishIntro(localized(FALLBACKS.handoff, lang));
        escalate(session, trigger.reason, text);
        persistMessage(session, "outgoing", reply);
        recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: trigger.reason });
        saveSession(session);
        return { reply, state: sessionState(session, { escalated: trigger.reason }) };
      }
      if (trigger) turn.escalateAfter = trigger.reason;

      // A booking made in another app: Maya cannot see it. She says so and
      // hands the thread to a person (no LLM, so she cannot pretend to look).
      const external = rules.externalBookingMention(text);
      if (external && external.booking && !turn.escalateAfter) {
        const reply = finishIntro((EXTERNAL_BOOKING_REPLY[lang] || EXTERNAL_BOOKING_REPLY.en)(external.app));
        escalate(session, "external_booking", `${external.app}: ${text}`);
        persistMessage(session, "outgoing", reply);
        recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: "external_booking" });
        saveSession(session);
        return { reply, state: sessionState(session, { escalated: "external_booking" }) };
      }

      // ---------- daily spend cap (salon-timezone day) ----------
      // Checked AFTER hard triggers: medical and "позовите человека" answer
      // without the LLM and must keep working at cap.
      const turnsToday = llmTurnsForDay(salonDayString());
      if (turnsToday >= DAILY_TURNS_CAP) {
        recordEvent(session, "cap_hit", { turns: turnsToday, cap: DAILY_TURNS_CAP });
        maybeSendUsageAlert(session, 100, turnsToday);
        if (turn.escalateAfter) {
          // Soft triggers (complaint, price dispute…) still reach a human at cap
          // through the deterministic canned path — no LLM involved.
          const reply = finishIntro(localized(turn.escalateAfter === "complaint" ? COMPLAINT_REPLY : FALLBACKS.handoff, lang));
          escalate(session, turn.escalateAfter, text);
          persistMessage(session, "outgoing", reply);
          recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: `${turn.escalateAfter}_at_cap` });
          saveSession(session);
          return { reply, state: sessionState(session, { escalated: turn.escalateAfter, capped: true }) };
        }
        const reply = finishIntro(localized(CAP_REPLY, lang));
        // Track the waiting client as an owner task — once per session per day.
        if (session.state.capNotedDay !== salonDayString()) {
          session.state.capNotedDay = salonDayString();
          leaveOwnerMessage(session, `Дневной лимит Майи исчерпан (${turnsToday}/${DAILY_TURNS_CAP}). Клиент ждёт ответа: "${text.slice(0, 150)}"`, "daily_cap", { silent: true });
        }
        persistMessage(session, "outgoing", reply);
        recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: "daily_cap" });
        saveSession(session);
        return { reply, state: sessionState(session, { capped: true }) };
      }

      // ---------- "yes" after a read-back commits the stored draft ----------
      // Deterministic: the staged action was validated when it was read back,
      // so any affirmative ("yes", "oui c'est bon", "да", "так", even with a
      // question attached) commits it here, before the model can loop.
      let committedPrefix = "";
      let extraQuestion = "";
      const staged = session.state.pendingAction;
      if (staged && !turn.escalateAfter && isAffirmation(text) &&
          (!staged.stagedAt || incomingIndex - staged.stagedAt <= 2) &&
          consentLooksStale(session, staged)) {
        // Maya's last message put other times on the table: ask again, showing
        // the slot this "yes" would actually book.
        staged.stagedAt = incomingIndex;
        recordEvent(session, "stale_consent", { kind: staged.kind, time: staged.timeLabel });
        const reply = finishIntro(readBackText(staged, session.language));
        persistMessage(session, "outgoing", reply);
        recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: "stale_consent" });
        saveSession(session);
        return { reply, state: sessionState(session, { gates: ["stale_consent"] }) };
      }
      if (staged && !turn.escalateAfter && isAffirmation(text) &&
          (!staged.stagedAt || incomingIndex - staged.stagedAt <= 2)) {
        const committed = commitPendingAction(session, turn);
        if (committed) {
          recordEvent(session, "auto_commit", { kind: staged.kind, stage: "on_yes" });
          extraQuestion = affirmationRemainder(text);
          if (!extraQuestion) {
            const reply = finishIntro(committed);
            persistMessage(session, "outgoing", reply);
            recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: `commit_${staged.kind}` });
            saveSession(session);
            return { reply, state: sessionState(session, { gates: [], committed: staged.kind }) };
          }
          committedPrefix = committed;
        }
      }

      let clientHint = "";
      if (session.client_id) {
        const client = store.getClientRecordById(session.client_id);
        if (client) {
          const preferences = store.getClientPreferences(client.id).slice(0, 2).join("; ");
          clientHint = `Client: ${client.name} (${client.status}). Last visit: ${client.last_visit}.${preferences ? ` Preferences: ${preferences}.` : ""}`;
        }
      }

      const systemPrompt = buildSystemPrompt({
        faq,
        language: lang,
        needsIntro,
        clientHint,
        dateContext: dateContext(),
        staff: staffNames(),
        staffDetails: staffDetails(),
        hideAddress: ADDRESS_PRIVATE,
        knownClient: knownClientLine(session)
      });
      const messages = [{ role: "system", content: systemPrompt }];
      if (turn.escalateAfter === "complaint") {
        messages.push({
          role: "system",
          content: `The client is complaining. In THIS reply to the client include all three beats: (1) name the feeling, (2) apologise once, sincerely, (3) a concrete next step: you are passing it to the owner now and the salon team will reply here as soon as they can. Never promise a time. You may mention a free fix only as "I'll pass it to the owner, they will confirm". Sell nothing. Then call request_human_handoff with a short summary. Reply in ${languageName(lang)}.`
        });
      } else if (turn.escalateAfter) {
        messages.push({
          role: "system",
          content: `The client is tense or disputing a price. Answer calmly and briefly, sell nothing, then call request_human_handoff with the reason. Reply in ${languageName(lang)}.`
        });
      }
      if (turn.unknownStylists.length) {
        messages.push({
          role: "system",
          content: `Checked against the team list: the staff member(s) «${turn.unknownStylists.map((entry) => entry.raw).join("», «")}» do NOT exist at this salon. Real team: ${staffNames().join(", ")}. Say honestly in this reply that nobody by that name works here, with no praise for that name, and offer one of the real team members.`
        });
      }
      // The owner's own answer comes first: walk-ins, address, deposit,
      // cancellation, parking… matched in code, before any tool.
      const faqHits = rules.matchFaqTopics(text, faqTopics().filter((topic) => !(ADDRESS_PRIVATE && topic.id === "address"))).slice(0, 3);
      if (faqHits.length) {
        turn.faqHits = faqHits.map((topic) => topic.id);
        messages.push({
          role: "system",
          content: `The salon owner already answered this kind of question. Answer from these lines first, before calling any tool, in ${languageName(lang)}; keep their facts and numbers exactly and add no facts they do not contain (no street address, landmark or directions that are not written here):\n${faqHits.map((topic) => `- [${topic.id}] ${topic.text}`).join("\n")}`
        });
      }
      if (external && !external.booking) {
        messages.push({
          role: "system",
          content: `The client mentioned ${external.app}. You cannot see ${external.app} or any other calendar or booking app; never say you can look something up there. Only this chat's own booking tools are yours.`
        });
      }
      const mentions = findDates(text);
      if (mentions.length) {
        const lines = mentions.map((hit) => hit.offset !== undefined
          ? `"${hit.phrase}" = ${dayIso(hit.offset)} (${dates.WEEKDAY_EN[dates.weekdayOf(dayIso(hit.offset))]})`
          : `"${hit.phrase}" = ${hit.error === "date_in_past" ? "a date that is already past" : "a date outside the booking window"}`);
        messages.push({ role: "system", content: `Dates in the client's message, resolved by the system (use these, never recompute): ${lines.join("; ")}.` });
      }
      messages.push(...buildHistoryMessages(session));
      if (committedPrefix) {
        // After the history, so it is the last thing the model reads.
        messages.push({
          role: "system",
          content: `The system has just committed the client's request and already told them: "${committedPrefix}". Do NOT confirm it again and do not call booking tools. Now answer ONLY the client's additional question, in one or two sentences, in ${languageName(lang)}: "${extraQuestion}". Use the FAQ block or a tool; if you cannot answer, say the salon team will reply here as soon as they can.`
        });
      }

      // After a commit, the follow-up answer may not stage anything new.
      const toolsForTurn = committedPrefix
        ? TOOL_DEFS.filter((def) => !["book_appointment", "reschedule_appointment", "cancel_appointment"].includes(def.function.name))
        : TOOL_DEFS;

      let reply = null;
      let llmError = null;
      let current = messages;
      try {
        let rounds = 0;
        while (rounds < MAX_TOOL_ROUNDS) {
          rounds += 1;
          const assistantMessage = await llm.complete({ messages: current, tools: toolsForTurn });
          turn.llmCalls += 1;
          recordLlmCall(session, turn, assistantMessage);
          if (assistantMessage.tool_calls && assistantMessage.tool_calls.length) {
            current = current.concat([assistantMessage]);
            for (const call of assistantMessage.tool_calls) {
              let args = {};
              try { args = JSON.parse(call.function.arguments || "{}"); } catch (error) { args = {}; }
              let result;
              try {
                result = executeTool(session, turn, call.function.name, args);
              } catch (error) {
                result = { error: "tool_failed", detail: String(error.message || error).slice(0, 200) };
              }
              if (result && result.needs_client_name) session.state.awaitingName = true;
              if (turn.dayCorrected) {
                recordEvent(session, "day_corrected", turn.dayCorrected);
                turn.dayCorrected = null;
              }
              if (call.function.name === "check_availability") {
                recordAvailability(session, result);
                if (result && result.date) turn.lastCheckedDate = result.date;
              }
              recordEvent(session, "tool_call", { tool: call.function.name, args, ok: !result.error });
              current.push({
                role: "tool",
                tool_call_id: call.id,
                content: JSON.stringify(result)
              });
            }
            continue;
          }
          reply = assistantMessage.content;
          break;
        }
        // reply === null (tool rounds exhausted) falls through as empty: gateReply's
        // empty_reply path substitutes the honest fallback, records the owner task
        // that backs its promise, and counts the failure once.
      } catch (error) {
        llmError = error;
      }

      const preGates = [];
      // Reply-language guard: a reply in the wrong script/language is
      // regenerated once, then replaced by a template in the client's language.
      const keepNames = staffNames();
      if (!llmError && String(reply || "").trim() && replyLanguageMismatch(reply, lang, keepNames)) {
        preGates.push("language_regen");
        recordEvent(session, "language_guard", { language: lang, original: String(reply).slice(0, 300) });
        let fixed = "";
        try {
          const again = await llm.complete({
            messages: current.concat([
              { role: "assistant", content: String(reply) },
              { role: "system", content: `Your last reply was not written in ${languageName(lang)}. Rewrite it in ${languageName(lang)} only, with the same meaning and the same facts. Keep every name exactly as spelled in the tools. Output only the rewritten reply.` }
            ]),
            tools: toolsForTurn
          });
          turn.llmCalls += 1;
          recordLlmCall(session, turn, again);
          if (again && !(again.tool_calls && again.tool_calls.length)) fixed = String(again.content || "").trim();
        } catch (error) {
          fixed = "";
        }
        if (fixed && !replyLanguageMismatch(fixed, lang, keepNames)) {
          reply = fixed;
        } else {
          preGates.push("language_fallback");
          reply = languageFallback(session, turn);
        }
      }

      // Fact guard: a price that is not in the salon's data, or an open day
      // called "closed", gets one rewrite with the facts spelled out. The
      // gates below still enforce both if the rewrite fails.
      if (!llmError && String(reply || "").trim()) {
        const badPrices = unknownPricesIn(session, reply, text);
        const badClosed = falseClosedDays(reply);
        if (badPrices.length || badClosed.length) {
          preGates.push("fact_regen");
          const notes = [];
          if (badPrices.length) {
            notes.push(`The amount(s) ${badPrices.map((price) => `$${price}`).join(", ")} are not in the salon's data. Quote price labels exactly as the tools and the FAQ give them (ranges like "$220–$320", "from $75", "+$15", "$5/nail", "Free", "By consultation"). The only sum allowed is a fixed base price plus an add-on row; never invent an amount.`);
          }
          badClosed.forEach(({ offset }) => {
            notes.push(`The salon is OPEN on ${dayIso(offset)} (${dates.WEEKDAY_EN[dates.weekdayOf(dayIso(offset))]}, ${hoursLabelForOffset(offset)}). Never say it is closed. If a team member is off that day, say who is off and who works.`);
          });
          recordEvent(session, "fact_guard", { prices: badPrices, closed: badClosed.map((entry) => entry.offset), original: String(reply).slice(0, 300) });
          try {
            const again = await llm.complete({
              messages: current.concat([
                { role: "assistant", content: String(reply) },
                { role: "system", content: `Correction: ${notes.join(" ")} Rewrite your last reply with these facts, in ${languageName(lang)}. Output only the rewritten reply.` }
              ]),
              tools: toolsForTurn
            });
            turn.llmCalls += 1;
            recordLlmCall(session, turn, again);
            const fixed = again && !(again.tool_calls && again.tool_calls.length) ? String(again.content || "").trim() : "";
            if (fixed && !unknownPricesIn(session, fixed, text).length && !falseClosedDays(fixed).length &&
                !replyLanguageMismatch(fixed, lang, keepNames)) {
              reply = fixed;
            }
          } catch (error) {
            // keep the reply; the gates below replace what is wrong
          }
        }
      }

      // Deterministic commit backstop: the client explicitly affirmed a staged
      // action but the model produced nothing (empty reply or LLM error) —
      // commit the staged action in code and confirm honestly.
      if (!turn.actionCommitted && session.state.pendingAction && isAffirmation(text) &&
          !consentLooksStale(session, session.state.pendingAction) &&
          (llmError || !String(reply || "").trim())) {
        const pendingKind = session.state.pendingAction.kind;
        const committed = commitPendingAction(session, turn);
        if (committed) {
          recordEvent(session, "auto_commit", { kind: pendingKind });
          reply = committed;
          llmError = null; // the turn succeeded after all
        }
      }

      if (llmError) {
        session.state.failedUnderstandings = (session.state.failedUnderstandings || 0) + 1;
        leaveOwnerMessage(session, `Сбой ИИ-ассистента: ${String(llmError.message || llmError).slice(0, 200)}. Клиент ждёт ответа: "${text.slice(0, 150)}"`, "llm_error");
        reply = committedPrefix ? "" : localized(FALLBACKS.error, lang);
      }

      // The model asked "shall I book it?" without staging anything: stage it
      // from the draft now, so the client's "yes" has something to commit.
      if (!llmError && !committedPrefix && !turn.stagedAction && !turn.actionCommitted &&
          String(reply || "").trim() && SELF_CONFIRM_RE.test(String(reply))) {
        const staged = autoStageFromDraft(session, turn, reply);
        if (staged) { preGates.push("auto_stage"); turn.autoStaged = true; }
        if (turn.askName) reply = localized(NAME_ASK, lang);
      }

      // A read-back the client never saw cannot be consented to: if this turn
      // staged an action and the reply does not show its time, send the
      // official read-back in the client's language instead.
      if (turn.stagedAction && session.state.pendingAction === turn.stagedAction &&
          String(reply || "").trim() && (turn.autoStaged || !replyShowsTime(reply, turn.stagedAction.startMinutes))) {
        preGates.push("readback_template");
        reply = readBackText(turn.stagedAction, lang);
      }

      // Same question twice in a row is a loop: fall back to the read-back when
      // there is one, so the client can simply say yes.
      const lastOut = db.prepare(`
        SELECT text_value FROM conversation_messages
        WHERE salon_id = ? AND conversation_id = ? AND type = 'outgoing'
        ORDER BY sort_order DESC LIMIT 1
      `).get(salonId, session.conversation_id);
      const normalizeQ = (value) => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      if (lastOut && reply && normalizeQ(lastOut.text_value) === normalizeQ(reply) && session.state.pendingAction) {
        preGates.push("repeat_breaker");
        reply = readBackText(session.state.pendingAction, lang);
      }

      if (reply) {
        const restored = restoreNameSpelling(reply, staffNames().concat([(session.state.client || {}).name || ""]));
        if (restored !== reply) { preGates.push("name_spelling"); reply = restored; }
      }

      let gated;
      if (committedPrefix && !String(reply || "").trim()) {
        // The follow-up question got no answer: say so honestly and hand it on.
        leaveOwnerMessage(session, `Вопрос клиента после записи остался без ответа: "${extraQuestion.slice(0, 200)}"`, "followup_question");
        gated = { reply: localized(FOLLOWUP_PENDING, lang), gates: ["followup_to_owner"] };
      } else {
        gated = gateReply(session, turn, reply);
      }
      gated.gates = preGates.concat(gated.gates);
      if (committedPrefix) gated.reply = `${committedPrefix} ${gated.reply}`.trim();

      // Complaint turns: the CLIENT-facing reply must carry all three beats
      // (feeling + one apology + concrete next step). If the model condensed
      // them away, replace with the deterministic 3-beat reply.
      if (turn.escalateAfter === "complaint" && !complaintBeatsPresent(gated.reply)) {
        recordEvent(session, "gate_triggered", { gates: ["complaint_rewrite"], original: gated.reply.slice(0, 300) });
        gated.gates.push("complaint_rewrite");
        gated.reply = localized(COMPLAINT_REPLY, lang);
      }

      // The same line twice in a row reads like a broken bot: say something
      // that moves the conversation instead.
      if (lastOut && normalizeQ(lastOut.text_value) === normalizeQ(gated.reply) && !session.state.pendingAction) {
        gated.gates.push("repeat_canned");
        const alt = localized(UNKNOWN_AGAIN, lang);
        gated.reply = normalizeQ(alt) === normalizeQ(lastOut.text_value) ? localized(FALLBACKS.rephrase, lang) : alt;
      }

      // The first reply of a conversation discloses the AI identity (prompt
      // rule, enforced here as a backstop), once, in the client's language.
      if (needsIntro && !hasAiDisclosure(gated.reply)) {
        recordEvent(session, "gate_triggered", { gates: ["first_turn_disclosure"] });
        gated.gates.push("first_turn_disclosure");
        gated.reply = withFirstTurnIntro(gated.reply, lang);
      }
      session.state.introduced = true;

      // Only real failures to answer count toward "hand it to a person": a
      // guard that replaced a wrong price, a false "closed" or an early
      // "you're booked" never pushes the conversation into human-only mode.
      const CONFUSION_GATES = new Set(["empty_reply", "language_fallback"]);
      if (gated.gates.some((gate) => CONFUSION_GATES.has(gate))) {
        session.state.failedUnderstandings = (session.state.failedUnderstandings || 0) + 1;
      }

      persistMessage(session, "outgoing", gated.reply);
      recordEvent(session, "message_out", { text: gated.reply.slice(0, 300), gates: gated.gates });

      // Soft-trigger escalation after this turn's reply (unless the LLM already did it).
      if (turn.escalateAfter && !session.state.escalated) {
        escalate(session, turn.escalateAfter, text);
      }
      // Two strikes of confusion → hand off.
      if (!session.state.escalated && (session.state.failedUnderstandings || 0) >= 2) {
        escalate(session, "repeated_misunderstanding", text);
      }

      // Spend-guard thresholds, checked after the turn is metered:
      // 80% → warn the owner once a day; 100% → notify once, next turns are capped.
      const turnsAfter = llmTurnsForDay(salonDayString());
      if (turnsAfter >= DAILY_TURNS_CAP) {
        maybeSendUsageAlert(session, 100, turnsAfter);
      } else if (turnsAfter >= Math.ceil(DAILY_TURNS_CAP * 0.8)) {
        maybeSendUsageAlert(session, 80, turnsAfter);
      }

      saveSession(session);
      return { reply: gated.reply, state: sessionState(session, { gates: gated.gates }) };
    }

    function sessionState(session, extra = {}) {
      const conversation = getConversationRow(session.conversation_id) || {};
      return Object.assign({
        sessionId: session.id,
        conversationId: session.conversation_id,
        language: session.language,
        assistantState: conversation.assistant_state || "active",
        pendingAction: session.state.pendingAction ? {
          kind: session.state.pendingAction.kind,
          service: session.state.pendingAction.serviceName,
          stylist: session.state.pendingAction.stylistName,
          time: session.state.pendingAction.timeLabel
        } : null,
        escalated: session.state.escalated || null
      }, extra);
    }

    // ---------- takeover ----------
    function setTakeover(conversationId, enabled) {
      const conversation = getConversationRow(conversationId);
      if (!conversation) return null;
      const state = enabled ? "takeover" : "active";
      const label = enabled ? "Human takeover · Maya silent" : "Maya AI · active";
      db.prepare(`UPDATE conversations SET assistant_state = ?, status = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `)
        .run(state, label, new Date().toISOString(), conversationId, salonId);
      if (conversation.assistant_session_id) {
        const session = loadSession(conversation.assistant_session_id);
        if (session) {
          recordEvent(session, enabled ? "takeover_on" : "takeover_off", {});
          if (!enabled) {
            session.state.escalated = null;
            session.state.failedUnderstandings = 0;
            session.state.handoffAt = null;
            session.state.holdingAt = null;
            session.state.waitingCount = 0;
          } else if (!["takeover", "escalated"].includes(conversation.assistant_state)) {
            session.state.handoffAt = clockNow().toISOString();
            session.state.holdingAt = null;
          }
          saveSession(session);
        }
      }
      return { conversationId, assistantState: state };
    }

    // Called when staff sends an outgoing message via the inbox UI: bot goes
    // silent, and the 12-hour hand-back clock restarts from this answer.
    function noteStaffMessage(conversationId) {
      const conversation = getConversationRow(conversationId);
      if (!conversation || !conversation.assistant_session_id) return;
      if (conversation.assistant_state !== "takeover") setTakeover(conversationId, true);
      const session = loadSession(conversation.assistant_session_id);
      if (session) {
        session.state.lastStaffAt = clockNow().toISOString();
        session.state.waitingCount = 0;
        saveSession(session);
      }
    }

    // ---------- LLM spend usage (surface for owner + ops) ----------
    function getUsage(day) {
      const targetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? day : salonDayString();
      const agg = db.prepare(`
        SELECT COUNT(DISTINCT turn_id) AS turns, COUNT(*) AS calls,
               COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
               COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM assistant_usage WHERE salon_id = ? AND day = ?
      `).get(salonId, targetDay);
      const sessions = db.prepare(`
        SELECT COUNT(DISTINCT session_id) AS count FROM assistant_events WHERE salon_id = ? AND day = ?
      `).get(salonId, targetDay).count;
      const blockedTurns = db.prepare(`
        SELECT COUNT(*) AS count FROM assistant_events WHERE salon_id = ? AND day = ? AND type = 'cap_hit'
      `).get(salonId, targetDay).count;
      const byChannel = db.prepare(`
        SELECT channel, COUNT(DISTINCT turn_id) AS turns
        FROM assistant_usage WHERE salon_id = ? AND day = ? GROUP BY channel ORDER BY turns DESC
      `).all(salonId, targetDay);
      return {
        day: targetDay,
        generatedAt: new Date().toISOString(),
        timezone: TIMEZONE,
        cap: DAILY_TURNS_CAP,
        turns: agg.turns,
        remaining: Math.max(0, DAILY_TURNS_CAP - agg.turns),
        percentUsed: Math.round((agg.turns / DAILY_TURNS_CAP) * 100),
        capReached: agg.turns >= DAILY_TURNS_CAP,
        llmCalls: agg.calls,
        promptTokens: agg.prompt_tokens,
        completionTokens: agg.completion_tokens,
        totalTokens: agg.total_tokens,
        sessions,
        blockedTurns,
        byChannel
      };
    }

    // ---------- owner digest ----------
    function getDigest(day) {
      const testSessionCache = new Map();
      const targetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? day : salonDayString();
      const events = db.prepare(`
        SELECT * FROM assistant_events WHERE salon_id = ? AND day = ? ORDER BY created_at ASC
      `).all(salonId, targetDay).map((row) => Object.assign(row, { payload: JSON.parse(row.payload_json || "{}") }))
        // The owner's own test chats are not part of the salon's day.
        .filter((row) => {
          if (!testSessionCache.has(row.session_id)) {
            testSessionCache.set(row.session_id, isTestSession(loadSession(row.session_id) || { id: row.session_id, state: {} }));
          }
          return !testSessionCache.get(row.session_id);
        });

      const byType = (type) => events.filter((event) => event.type === type);
      const conversationIds = [...new Set(events.map((event) => event.conversation_id).filter(Boolean))];
      const conversations = conversationIds.map((id) => {
        const row = getConversationRow(id);
        const convEvents = events.filter((event) => event.conversation_id === id);
        const linkedClient = row && row.client_id ? store.getClientRecordById(row.client_id) : null;
        return {
          conversationId: id,
          client: linkedClient ? linkedClient.name : (row ? row.name : "(deleted)"),
          channel: row ? row.channel : "",
          assistantState: row ? row.assistant_state : "",
          preview: row ? row.preview : "",
          messagesIn: convEvents.filter((event) => event.type === "message_in").length,
          messagesOut: convEvents.filter((event) => event.type === "message_out").length,
          bookings: convEvents.filter((event) => ["booking", "reschedule", "cancellation"].includes(event.type)).length,
          escalated: convEvents.some((event) => event.type === "escalation")
        };
      });

      return {
        day: targetDay,
        generatedAt: new Date().toISOString(),
        salonSlug: salonId,
        salon: SALON_NAME,
        totals: {
          conversations: conversationIds.length,
          clientMessages: byType("message_in").length,
          assistantReplies: byType("message_out").length,
          bookings: byType("booking").length,
          reschedules: byType("reschedule").length,
          cancellations: byType("cancellation").length,
          escalations: byType("escalation").length,
          ownerMessages: byType("owner_message").length
        },
        escalations: byType("escalation").map((event) => ({
          time: event.created_at,
          conversationId: event.conversation_id,
          client: (getConversationRow(event.conversation_id) || {}).name || "",
          reason: event.payload.reason,
          summary: event.payload.summary
        })),
        bookings: byType("booking").concat(byType("reschedule"), byType("cancellation")).map((event) => ({
          time: event.created_at,
          type: event.type,
          client: event.payload.client,
          service: event.payload.service,
          stylist: event.payload.stylist || "",
          day: event.payload.day || "",
          slot: event.payload.time || "",
          price: event.payload.price || ""
        })),
        ownerMessages: byType("owner_message").map((event) => ({
          time: event.created_at,
          conversationId: event.conversation_id,
          client: (getConversationRow(event.conversation_id) || {}).name || "",
          topic: event.payload.topic,
          message: event.payload.message
        })),
        conversations,
        usage: getUsage(targetDay)
      };
    }
    return {
      chat,
      salonId,
      getDigest,
      getUsage,
      setTakeover,
      noteStaffMessage,
      autoReturnStale,
      // exposed for tests
      _internals: {
        detectLanguage,
        checkTriggers,
        isAffirmation,
        affirmationRemainder,
        parseClientIdentity,
        stylistForTool,
        restoreNameSpelling,
        todayIso,
        dayIso,
        readBackText,
        gateReply,
        executeTool,
        resolveServices,
        resolveDay,
        parseTimeFlexible,
        freeSlots,
        hoursForOffset,
        nextOpenOffset,
        dayWeekday,
        minStartForOffset,
        salonMinutesNow,
        timezone: TIMEZONE,
        salonName: SALON_NAME,
        openingHours: OPENING_HOURS,
        resolveStylist,
        hasAiDisclosure,
        withFirstTurnIntro,
        complaintBeatsPresent,
        sendAlertEmail,
        detectUnknownStylists,
        ensureSession,
        loadSession,
        saveSession,
        rateLimited,
        rateLimitedByIp,
        recordEvent,
        llmTurnsForDay,
        dailyTurnsCap: DAILY_TURNS_CAP,
        TOOL_DEFS,
        staffProblem,
        staffDetails,
        falseClosedDays,
        fixClosedClaims,
        policyNote,
        priceAnswer,
        unknownPricesIn,
        addressPrivate: ADDRESS_PRIVATE
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Multi-salon dispatch. One memoised assistant per salon; every entry point
  // resolves its salon explicitly before touching data.
  // ---------------------------------------------------------------------------
  const salonAssistants = new Map();

  function forSalon(slug) {
    const id = String(slug || rootStore.DEFAULT_SALON_SLUG || "").trim() || rootStore.DEFAULT_SALON_SLUG;
    if (!rootStore.salonExists(id)) return null;
    if (!salonAssistants.has(id)) salonAssistants.set(id, createSalonAssistant(id));
    return salonAssistants.get(id);
  }

  // Hours, FAQ, services and staff are read once when a salon's assistant is
  // built. The setup wizard calls this after saving so the next message sees the
  // new catalogue without a server restart. Sessions live in the DB, so nothing
  // a client said is lost.
  function invalidate(slug) {
    salonAssistants.delete(String(slug || "").trim());
  }

  // A conversation id is globally unique, so staff-side actions (takeover,
  // manual reply) can find their salon from the row itself.
  //
  // That lookup crosses salons by construction, so every caller MUST say which
  // salon it is allowed to act on. `expectedSalonSlug` is that fence: a row from
  // any other salon comes back null, so the caller answers "unknown conversation"
  // and learns nothing about whether the id exists elsewhere on the box. Callers
  // pass the salon on the signed-in session, never a salon read from the request.
  function salonForConversation(conversationId, expectedSalonSlug) {
    const row = db.prepare(`SELECT salon_id FROM conversations WHERE id = ?`).get(conversationId);
    if (!row) return null;
    const expected = String(expectedSalonSlug || "").trim().toLowerCase();
    if (expected && String(row.salon_id).trim().toLowerCase() !== expected) return null;
    return forSalon(row.salon_id);
  }

  const defaultAssistant = forSalon(rootStore.DEFAULT_SALON_SLUG);

  return {
    forSalon,
    invalidate,
    async chat(payload = {}) {
      // Rebase day offsets on the first message of a new salon day, before the
      // assistant reads busy slots (see syncDayAnchor in store.js).
      if (typeof rootStore.syncDayAnchor === "function") rootStore.syncDayAnchor(String(payload.salon || rootStore.DEFAULT_SALON_SLUG || ""));
      const salon = forSalon(payload.salon);
      if (!salon) {
        return { error: "unknown_salon", message: `Unknown salon: ${payload.salon}` };
      }
      return salon.chat(payload);
    },
    getDigest(day, salonSlug) {
      const salon = forSalon(salonSlug);
      return salon ? salon.getDigest(day) : null;
    },
    getUsage(day, salonSlug) {
      const salon = forSalon(salonSlug);
      return salon ? salon.getUsage(day) : null;
    },
    setTakeover(conversationId, enabled, expectedSalonSlug) {
      const salon = salonForConversation(conversationId, expectedSalonSlug);
      return salon ? salon.setTakeover(conversationId, enabled) : null;
    },
    noteStaffMessage(conversationId, expectedSalonSlug) {
      const salon = salonForConversation(conversationId, expectedSalonSlug);
      return salon ? salon.noteStaffMessage(conversationId) : undefined;
    },
    // Hands quiet threads back to Maya (12 h without a staff answer).
    autoReturnStale(salonSlug) {
      const salon = forSalon(salonSlug);
      return salon ? salon.autoReturnStale() : 0;
    },
    // Default-salon internals, kept for the existing single-salon test suite.
    _internals: defaultAssistant._internals
  };
}

module.exports = { createAssistant };
