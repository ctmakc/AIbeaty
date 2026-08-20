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

const MAX_TOOL_ROUNDS = 6;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
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

function detectLanguage(text) {
  const value = String(text || "");
  if (/[іїєґІЇЄҐ]/.test(value)) return "uk";
  if (/[а-яА-ЯёЁ]/.test(value)) return "ru";
  return "en";
}

// --- escalation triggers (checked in code, before/independent of the LLM) ---
const TRIGGERS = [
  { reason: "explicit_request", hard: true, re: /(позов[иі]те|позвать|зовите|позови)\s+(человека|менеджера|адміністратора|администратора)|живо[йг]о? человек|хочу (поговорить|говорить) с человеком|соедините с|talk to a human|real person|human,? please|speak (to|with) (a )?(human|person|manager|someone real)|передай(те)? человеку/i },
  { reason: "medical", hard: true, re: /жжени|жж[её]т|печ[её]т|аллерги|алерг|беремен|вагітн|зуд|сыпь|свербіж|висип|ожог|опік|раздражение кожи|подразнення|кожа болит|allerg|pregnan|burn(ing|ed|s)?\b|rash|itch|scalp (pain|hurts)|chemical reaction/i },
  { reason: "complaint", hard: false, re: /испортил|зіпсував|сожгли|спалили|ужасн|жахлив|отвратительн|кошмар|верн[иу]те (мне )?деньги|возврат денег|повернить гроші|жалоб|скарг|плохо (по)?(стригли|красили)|ruined|terrible|awful|worst|complain|refund|botched/i },
  { reason: "price_dispute", hard: false, re: /слишком дорого|почему так дорого|это грабёж|занадто дорого|чому так дорого|too expensive|overpriced|rip[- ]?off|why so expensive/i },
  { reason: "frustration", hard: false, re: /да что (ж|же|такое)|сколько можно|это ужас(?!н)|бесит|задолбал|ненавижу|wtf|ridiculous|are you kidding|!{3,}/i }
];

function checkTriggers(text) {
  for (const trigger of TRIGGERS) {
    if (trigger.re.test(String(text || ""))) return trigger;
  }
  return null;
}

// Affirmation vs rejection for the read-back commit step. Safety order:
// a question or ANY rejection token always wins (a false negative only
// re-asks once; a false positive would commit without consent).
const AFFIRM_BOUND = "[\\s,.!;:()«»\"'”—–-]";
const AFFIRM_REJECTION_RE = new RegExp(
  `(^|${AFFIRM_BOUND})(нет|ні|no|nope|not|не|don'?t|do not|never|stop|wait|стоп|подожди(те)?|погоди(те)?|постой(те)?|зачекай(те)?|отставить|передумал[аио]?|передумала?|передумав)(?=$|${AFFIRM_BOUND})`, "i");
const AFFIRM_WORD_RE = new RegExp(
  `(^|${AFFIRM_BOUND})(да|ага|угу|конечно|давай(те)?|подтверждаю|верно|точно|именно|разумеется|ок|окей|хорошо|добро|yes|yep|yeah|yup|sure|ok|okay|confirm(ed)?|correct|right|exactly|absolutely|так|авжеж|звісно|добре|вірно|підтверджую)(?=$|${AFFIRM_BOUND})`, "i");
// Imperative / first-person-plural action verbs count as consent too:
// «отменяем», «отменяй(те)», «переносите», «записывайте», «скасовуйте», "cancel it".
const AFFIRM_ACTION_RE = /(отменя(ем|й|йте|ю)|отмен(и|ите)(?=$|[\s,.!])|убира(ем|й|йте)|убер(и|ите)(?=$|[\s,.!])|скасов(уємо|уй|уйте)|скасуй(те)?|перенос(им|и|ите|ьте)|перенес(и|ите|іть|емо)(?=$|[\s,.!])|запис(ывай|ывайте|ываем|уй|уйте|уємо)|оформля(й|йте|ем)|оформи(те)?(?=$|[\s,.!])|бронируй(те)?|броню(й|йте)|cancel (it|that|the appointment|my appointment)|please cancel|go ahead|do it|proceed|book it)/i;

function isAffirmation(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  if (/\?\s*[)!.…]*$/.test(value)) return false; // a question is never consent
  if (AFFIRM_REJECTION_RE.test(value)) return false;
  if (AFFIRM_WORD_RE.test(value)) return true;
  if (AFFIRM_ACTION_RE.test(value)) return true;
  if (/(вс[её]|all)\s*(верно|правильно|вірно|correct|good|right)/i.test(value)) return true;
  if (/подтвержда|підтверджу|confirm/i.test(value)) return true;
  return false;
}

// --- reply gates ---
const BOOKING_CLAIM_RE = /(вы записан|вас записал|записала? (вас|тебя)|запись (создана|подтверждена|оформлена|перенесена|отменена)|перен[её]сла ваш|отменила ваш|вас записано|запис (створено|підтверджено|перенесено|скасовано)|you'?re (all )?(booked|set)|booked you|booking (is )?confirmed|appointment (is )?(booked|confirmed|cancell?ed|rescheduled)|i('| ha)ve booked)/i;

const BANNED_REPLACEMENTS = [
  [/нет проблем/gi, "конечно"],
  [/к сожалению,?\s*/gi, ""],
  [/на жаль,?\s*/gi, ""],
  [/согласно нашей политике/gi, "у нас так заведено"],
  [/как ии,?\s*я/gi, "я"],
  [/as an ai(,|\s+language model)?,?\s*/gi, ""],
  [/i hope this message finds you well[.,!]?\s*/gi, ""],
  [/unfortunately,?\s*/gi, ""]
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

const FALLBACKS = {
  unknown: {
    ru: "Это лучше уточню у владельца — вам напишут в течение часа. Могу пока подобрать удобное время для визита?",
    uk: "Це краще уточню у власника — вам напишуть протягом години. Можу поки підібрати зручний час для візиту?",
    en: "Let me check that with the owner — you'll hear back within the hour. Meanwhile, want me to find you a good time to come in?"
  },
  notBooked: {
    ru: "Хочу быть честной: запись ещё не подтверждена в системе. Я передала вопрос владельцу — вам напишут в течение часа.",
    uk: "Хочу бути чесною: запис ще не підтверджено в системі. Я передала питання власнику — вам напишуть протягом години.",
    en: "I want to be honest: the booking isn't confirmed in our system yet. I've passed this to the owner — you'll hear back within the hour."
  },
  handoff: {
    ru: "Конечно, передаю разговор человеку. Владелец или администратор напишут вам здесь в течение часа — я всё им уже пересказала.",
    uk: "Звісно, передаю розмову людині. Власник або адміністратор напишуть вам тут протягом години — я все їм переказала.",
    en: "Of course — I'm handing this over to a person. The owner or front desk will reply here within the hour; I've already passed everything along."
  },
  error: {
    ru: "У меня на секунду пропала связь с системой записи. Я оставила владельцу заметку — вам ответят в течение часа.",
    uk: "У мене на мить зникнув зв'язок із системою запису. Я залишила власнику нотатку — вам дадуть відповідь протягом години.",
    en: "I lost my connection to the booking system for a moment. I've left a note for the owner — you'll get a reply within the hour."
  }
};

// Daily spend cap reached: graceful, language-matched, zero LLM involved.
const CAP_REPLY = {
  ru: "Майя сегодня наговорилась — напишите нам, и человек ответит. Ваше сообщение уже у владельца, вам ответят здесь.",
  uk: "Майя сьогодні наговорилася — напишіть нам, і людина відповість. Ваше повідомлення вже у власника, вам дадуть відповідь тут.",
  en: "Maya has talked her fill for today — leave us a message and a person will reply. Your note is already with the owner; you'll hear back right here."
};

function localized(pack, language) {
  return pack[language] || pack.ru;
}

// --- first-turn AI disclosure (code-enforced backstop for the prompt rule) ---
const FIRST_TURN_INTRO = {
  ru: "Привет! Я Майя, ИИ-ассистентка салона.",
  uk: "Вітаю! Я Майя, ШІ-асистентка салону.",
  en: "Hi! I'm Maya, the salon's AI assistant."
};
// \b does not work for Cyrillic, so boundaries are spelled out.
const DISCLOSURE_AI_RE = /(^|[^а-яёіїєґa-z0-9])(ии|ші|ai)([^а-яёіїєґa-z0-9]|$)|искусственн|штучн|artificial|virtual assistant|виртуальн|віртуальн/i;
const LEADING_GREETING_RE = /^(привет|здравствуйте|добрый день|добрый вечер|доброе утро|вітаю|добрий день|добрий вечір|hi there|hi|hello|hey|good (morning|afternoon|evening))[!,.\s]+/i;

function hasAiDisclosure(reply) {
  return /(майя|maya|майї|майю|майи|майей|майєю)/i.test(String(reply || "")) && DISCLOSURE_AI_RE.test(String(reply || ""));
}

function withFirstTurnIntro(reply, language) {
  const intro = localized(FIRST_TURN_INTRO, language);
  const rest = String(reply || "").replace(LEADING_GREETING_RE, "").trim() || String(reply || "").trim();
  return `${intro} ${rest}`.trim();
}

// --- complaint turn: the CLIENT-facing reply must carry all three beats -----
// (feeling named, one sincere apology, concrete next step with a timeframe).
const COMPLAINT_BEAT_RES = [
  /(обидно|неприятно|досадно|расстро|огорч|понимаю( вас|, как| тебя)?|слышу вас|прикро|чую вас|засмучен|сумно|frustrating|upsetting|awful|i hear you|i understand|so sorry)/i,
  /(прости|извин|перепрошу|вибач|мені шкода|мне жаль|sorry|apolog)/i,
  /(в течение часа|протягом години|within the hour|за час|через час)/i
];
const COMPLAINT_REPLY = {
  ru: "Слышу вас — это правда обидно, простите нас. Я уже всё передала владельцу: он увидит сообщение в течение часа и напишет вам прямо здесь. Спасибо, что рассказали.",
  uk: "Чую вас — це справді прикро, вибачте нас. Я вже все передала власнику: він побачить повідомлення протягом години й напише вам просто тут. Дякую, що розповіли.",
  en: "I hear you — that's genuinely upsetting, and I'm sorry. I've passed everything to the owner: they'll see this within the hour and reply to you right here. Thank you for telling us."
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
  owner_message: "сообщение владельцу"
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

function escapeRe(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WEEKDAYS = [
  { index: 0, re: /воскресень|неділ|sunday|\bвс\b|\bsun\b/i },
  { index: 1, re: /понедельник|понеділок|monday|\bпн\b|\bmon\b/i },
  { index: 2, re: /вторник|вівторок|tuesday|\bвт\b|\btue\b/i },
  { index: 3, re: /среда|среду|середа|середу|wednesday|\bср\b|\bwed\b/i },
  { index: 4, re: /четверг|четвер|thursday|\bчт\b|\bthu\b/i },
  { index: 5, re: /пятниц|п'ятниц|friday|\bпт\b|\bfri\b/i },
  { index: 6, re: /суббот|субот|saturday|\bсб\b|\bsat\b/i }
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
  // English: "with Natalie", "see Natalie", "book me with Natalie", "stylist Natalie"
  /(?:with|to see|see|stylist|by)\s+([A-Z][a-z'-]{2,})(?:\s|[,.!?]|$)/g
];

// Words that look like names in the patterns above but are never stylists.
const STYLIST_NAME_STOPWORDS = /^(майя|maya|она|оно|вона|він|кто-то|хтось|вам|вас|вами|вашей|вашему|тебе|тебя|тобой|меня|мне|мной|нам|нас|нами|ним|ней|нему|неё|нее|него|них|ними|привет|здравствуйте|спасибо|дякую|будь\s?ласка|пожалуйста|hello|thanks|today|tomorrow|сегодня|завтра|сьогодні|обед\w*|утр\w*|вечер\w*|январ\w*|феврал\w*|март\w*|апрел\w*|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*|січн\w*|лют\w*|берез\w*|квітн\w*|травн\w*|червн\w*|липн\w*|серпн\w*|вересн\w*|жовтн\w*|листопад\w*|грудн\w*|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

// Stem that survives Russian/Ukrainian declension: "Наталье"/"Наталью"/"Натальи" → "наталь".
function nameStem(name) {
  const lower = String(name || "").toLowerCase().replace(/['’-]+$/g, "");
  const stripped = lower.replace(/[аеёиіїоуыэюяь]+$/g, "");
  return stripped.length >= 3 ? stripped : lower;
}

// Praise/affirmation the model must never attach to a nonexistent stylist.
const STYLIST_PRAISE_RE = /отличн|прекрасн|замечательн|великолепн|потрясающ|лучш|чудов|найкращ|классн|супер|great|amazing|wonderful|fantastic|excellent|awesome|the best|конечно!|of course!/i;

// Markers of an honest correction ("no such stylist") in the reply.
const STYLIST_CORRECTION_RE = /такого (мастера|майстра|стилиста|стиліста)|(мастера|майстра) (с именем|по имени|на ім'?я)? ?[«"']?[\wа-яёіїєґ'’-]* ?[»"']? ?(у нас )?(нет|немає)|в нашей команде нет|в нашій команді немає|не работает у нас|у нас не працює|у нас (нет|немає) (мастера|майстра)|don'?t have (a |any )?stylist|no stylist (named|called)|isn'?t (on|part of) (our|the) (team|staff)|not on (our|the) (team|staff)/i;

function createAssistant({ store: rootStore, llm, faqPath, clock, alertEmail, alertFetch, alertLinkBase, dailyTurnsCap } = {}) {
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
  const rateBuckets = new Map();   // `${salonId}:${sessionId}` → recent turn timestamps
  // Spend guard: hard cap on LLM turns per salon-timezone day (shared Ollama
  // Cloud quota protection). One "turn" = one chat() invocation that reached
  // the LLM; hard triggers, canned and silenced turns never count.
  const capCandidate = Number(dailyTurnsCap !== undefined ? dailyTurnsCap : process.env.ASSISTANT_DAILY_TURNS_CAP);
  const DAILY_TURNS_CAP = Number.isFinite(capCandidate) && capCandidate > 0 ? Math.floor(capCandidate) : 400;

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
      const wanted = digitsOnly(phone);
      if (wanted.length < 7) return null;
      const rows = db.prepare(`SELECT * FROM clients
      WHERE salon_id = ?
    `).all(salonId);
      return rows.find((row) => {
        const have = digitsOnly(row.phone);
        return have.length >= 7 && (have === wanted || have.endsWith(wanted) || wanted.endsWith(have));
      }) || null;
    }

    function ensureSession({ sessionId, channel, clientPhone, language }) {
      let session = loadSession(sessionId);
      if (session) return session;
      const now = new Date().toISOString();
      const knownClient = clientPhone ? findClientByPhone(clientPhone) : null;
      const guestName = knownClient ? knownClient.name : `Веб-гость ${sessionId.slice(-4)}`;
      const conversationId = store.createConversation({
        name: guestName,
        clientId: knownClient ? knownClient.id : undefined,
        channel: channel || "Webchat",
        preview: "Диалог с ИИ-ассистенткой Майей",
        status: "Maya AI · active",
        contact: clientPhone ? { phone: clientPhone } : undefined,
        suggestions: ["Позвать человека", "Записаться", "Цены и услуги"]
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
        language || "ru",
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
      store.createConversationMessage(session.conversation_id, { text, type });
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

    function rateLimited(sessionId) {
      const now = Date.now();
      const key = `${salonId}:${sessionId}`;
      const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (bucket.length >= RATE_LIMIT_MAX) {
        rateBuckets.set(key, bucket);
        return true;
      }
      bucket.push(now);
      rateBuckets.set(key, bucket);
      return false;
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
    function detectUnknownStylists(text) {
      const value = String(text || "");
      const found = new Map();
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
          if (resolveStylist(candidate)) continue; // real staff member — fine
          const stem = nameStem(candidate);
          if (!found.has(stem)) found.set(stem, { raw: candidate, stem });
        }
      }
      return [...found.values()];
    }

    function stylistCorrectionReply(language) {
      const staff = store.getStylistRows().map((row) => row.name);
      const listRu = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} и ${staff[staff.length - 1]}` : staff.join("");
      const listUk = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} та ${staff[staff.length - 1]}` : staff.join("");
      const listEn = staff.length > 1 ? `${staff.slice(0, -1).join(", ")} and ${staff[staff.length - 1]}` : staff.join("");
      const pack = {
        ru: `Хочу быть честной: такого мастера у нас нет. В нашей команде ${listRu} — к кому из них вас записать?`,
        uk: `Хочу бути чесною: такого майстра у нас немає. У нашій команді ${listUk} — до кого з них вас записати?`,
        en: `I want to be honest: we don't have a stylist by that name. Our team is ${listEn} — who would you like to book with?`
      };
      return localized(pack, language);
    }

    function referenceDate() {
      const ref = new Date(store.getLastUpdated());
      return Number.isNaN(ref.getTime()) ? clockNow() : ref;
    }

    // Salon-timezone calendar date of the reference day, anchored at UTC midnight
    // so weekday/offset math is DST-safe regardless of the server's own timezone.
    function refDayUtcMs() {
      const [y, m, d] = tzDateString(referenceDate(), TIMEZONE).split("-").map(Number);
      return Date.UTC(y, m - 1, d);
    }

    function resolveDay(input) {
      const text = String(input || "").trim().toLowerCase();
      if (!text || /сегодня|сьогодні|today|now/.test(text)) return { offset: 0 };
      if (/послезавтра|післязавтра/.test(text)) return { offset: 2 };
      if (/завтра|tomorrow/.test(text)) return { offset: 1 };
      const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (iso) {
        const target = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
        const offset = Math.round((target - refDayUtcMs()) / 86400000);
        if (offset >= 0 && offset <= 60) return { offset };
        return { error: "date_out_of_range" };
      }
      for (const day of WEEKDAYS) {
        if (day.re.test(text)) {
          let offset = (day.index - dayWeekday(0) + 7) % 7;
          if (offset === 0 && /следующ|наступн|next/.test(text)) offset = 7;
          return { offset };
        }
      }
      const plain = text.match(/^\+?(\d{1,2})$/);
      if (plain) return { offset: Math.min(60, Number(plain[1])) };
      return { error: "unparsed_day" };
    }

    function dayLabel(offset) {
      return new Date(refDayUtcMs() + offset * 86400000)
        .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
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

    function busyIntervals(dayOffset, stylistId) {
      return db.prepare(`
        SELECT start_minutes, end_minutes FROM appointments
        WHERE salon_id = ? AND checked_out = 0 AND appointment_status = 'scheduled' AND day_offset = ? AND stylist_id = ?
      `).all(salonId, dayOffset, stylistId);
    }

    function slotFree(dayOffset, stylistId, startMinutes, endMinutes) {
      return !busyIntervals(dayOffset, stylistId).some((row) =>
        startMinutes < row.end_minutes && endMinutes > row.start_minutes
      );
    }

    function freeSlots(dayOffset, durationMinutes, stylistRow) {
      const window = hoursForOffset(dayOffset);
      if (!window) return [];
      const minStart = minStartForOffset(dayOffset);
      const stylists = stylistRow ? [stylistRow] : store.getStylistRows();
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
      notePrice(session, row.price_value);
      return {
        name: row.name,
        category: row.category_name,
        price: row.price_label,
        duration_min: row.duration_minutes
      };
    }

    // ---------- escalation / takeover ----------
    function setConversationState(session, state, statusLabel) {
      db.prepare(`UPDATE conversations SET assistant_state = ?, status = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `)
        .run(state, statusLabel, new Date().toISOString(), session.conversation_id, salonId);
    }

    function escalate(session, reason, summary) {
      setConversationState(session, "escalated", "Needs human · Maya paused");
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
      if (appointmentId) {
        return db.prepare(`
          SELECT a.*, s.name AS stylist_name FROM appointments a
          JOIN stylists s ON s.id = a.stylist_id WHERE a.salon_id = ? AND a.id = ?
        `).get(salonId, appointmentId) || null;
      }
      if (session.client_id) return store.getActiveAppointmentForClient(session.client_id) || null;
      const conversation = getConversationRow(session.conversation_id);
      if (conversation && conversation.client_id) return store.getActiveAppointmentForClient(conversation.client_id) || null;
      return null;
    }

    function linkConversationToClient(session, clientId) {
      if (!clientId) return;
      session.client_id = clientId;
      db.prepare(`UPDATE conversations SET client_id = ?, updated_at = ? WHERE id = ? AND salon_id = ?
    `)
        .run(clientId, new Date().toISOString(), session.conversation_id, salonId);
    }

    function executeTool(session, turn, name, args) {
      switch (name) {
        case "get_services_and_prices": {
          const rows = args.query ? resolveServices(args.query) : [];
          const list = (rows.length ? rows : allServices()).map((row) => serviceSummary(session, row));
          return { services: list, note: "These are the only services the salon offers. Quote prices exactly." };
        }

        case "check_availability": {
          const matches = resolveServices(args.service);
          if (!matches.length) {
            return {
              found: false,
              note: "No such service here. Offer the real list below or leave_message_for_owner.",
              known_services: allServices().map((row) => serviceSummary(session, row))
            };
          }
          if (matches.length > 1) {
            return {
              ambiguous: true,
              note: "Ask the client which of these they mean.",
              options: matches.map((row) => serviceSummary(session, row))
            };
          }
          const service = matches[0];
          const day = resolveDay(args.day);
          if (day.error) return { error: day.error, note: "Ask the client for a concrete day." };
          const window = hoursForOffset(day.offset);
          if (!window) {
            const alt = { offset: nextOpenOffset(day.offset) };
            return {
              closed: true,
              note: `Salon is closed that day. Nearest open day: ${dayLabel(alt.offset)} (${hoursLabelForOffset(alt.offset)}).`,
              service: serviceSummary(session, service),
              alternative_day: dayLabel(alt.offset),
              alternative_slots: freeSlots(alt.offset, service.duration_minutes, args.stylist ? resolveStylist(args.stylist) : null)
            };
          }
          const stylist = args.stylist ? resolveStylist(args.stylist) : null;
          if (args.stylist && !stylist) {
            return {
              stylist_not_found: true,
              note: "No such stylist. These are the real staff:",
              stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role }))
            };
          }
          const minStart = minStartForOffset(day.offset);
          if (day.offset === 0 && minStart + service.duration_minutes > window[1]) {
            const altOffset = nextOpenOffset(0);
            return {
              day_over: true,
              salon_time_now: minutesLabel(salonMinutesNow()),
              note: `Today's hours (${hoursLabelForOffset(0)}) are already over — offer NOTHING for today. Nearest open day: ${dayLabel(altOffset)} (${hoursLabelForOffset(altOffset)}).`,
              service: serviceSummary(session, service),
              alternative_day: dayLabel(altOffset),
              alternative_slots: freeSlots(altOffset, service.duration_minutes, stylist)
                .map((slot) => ({ stylist: slot.stylist, time: slot.time }))
            };
          }
          const slots = freeSlots(day.offset, service.duration_minutes, stylist);
          const payload = {
            service: serviceSummary(session, service),
            day: dayLabel(day.offset),
            opening_hours: hoursLabelForOffset(day.offset),
            slots: slots.map((slot) => ({ stylist: slot.stylist, time: slot.time })),
            note: slots.length ? "Offer 2-3 of these real slots. Times not listed may still be free — check them via the `time` argument." : "No free slots that day; suggest another day.",
            next_step: "When the client settles on a slot, call book_appointment right away — it returns the official read-back. Never compose a read-back or confirmation question yourself."
          };
          if (day.offset === 0) payload.salon_time_now = minutesLabel(salonMinutesNow());
          if (args.time) {
            const wanted = parseTimeFlexible(args.time);
            if (wanted !== null && day.offset === 0 && wanted < minStart && wanted >= window[0] && wanted + service.duration_minutes <= window[1]) {
              payload.requested_time = {
                time: store.formatTimeRange(wanted, wanted + service.duration_minutes),
                available: false,
                reason: `already in the past — it is ${minutesLabel(salonMinutesNow())} salon time today. Offer only the future slots listed.`
              };
            } else if (wanted !== null && wanted >= window[0] && wanted + service.duration_minutes <= window[1]) {
              const candidates = stylist ? [stylist] : store.getStylistRows();
              const freeWith = candidates.filter((row) => slotFree(day.offset, row.id, wanted, wanted + service.duration_minutes));
              payload.requested_time = {
                time: store.formatTimeRange(wanted, wanted + service.duration_minutes),
                available: freeWith.length > 0,
                available_with: freeWith.map((row) => row.name),
                next_step: freeWith.length
                  ? "Time is free — call book_appointment NOW with these details; it will return the official read-back to confirm with the client."
                  : "Time is taken — offer the slots list instead."
              };
            } else if (wanted !== null) {
              payload.requested_time = {
                time: args.time,
                available: false,
                reason: `outside working hours ${hoursLabelForOffset(day.offset)} on ${dayLabel(day.offset)}`
              };
            }
          }
          return payload;
        }

        case "get_client_context": {
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
          const matches = resolveServices(args.service);
          if (matches.length !== 1) {
            return matches.length
              ? { ambiguous: true, options: matches.map((row) => serviceSummary(session, row)), note: "Ask which service exactly." }
              : { found: false, known_services: allServices().map((row) => serviceSummary(session, row)) };
          }
          const service = matches[0];
          const day = resolveDay(args.day);
          if (day.error) return { error: day.error, note: "Ask for a concrete day." };
          const window = hoursForOffset(day.offset);
          if (!window) {
            return { closed: true, note: `Salon is closed that day. Nearest open day: ${dayLabel(nextOpenOffset(day.offset))}.` };
          }
          const startMinutes = parseTimeFlexible(args.time);
          if (startMinutes === null) return { error: "unparsed_time", note: "Ask for a concrete time like 14:00." };
          const endMinutes = startMinutes + service.duration_minutes;
          if (startMinutes < window[0] || endMinutes > window[1]) {
            return {
              error: "outside_hours",
              note: `Working hours on ${dayLabel(day.offset)} are ${hoursLabelForOffset(day.offset)}. Tell the client honestly and offer times inside those hours.`,
              alternatives: freeSlots(day.offset, service.duration_minutes, null).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          if (day.offset === 0 && startMinutes < minStartForOffset(0)) {
            const alternatives = freeSlots(0, service.duration_minutes, null).map((s) => ({ stylist: s.stylist, time: s.time }));
            return {
              error: "time_in_past",
              note: `That time today is already past — it is ${minutesLabel(salonMinutesNow())} salon time. Refuse honestly.${alternatives.length ? " Offer these future slots instead." : ` Nothing is left today; suggest ${dayLabel(nextOpenOffset(0))}.`}`,
              alternatives
            };
          }
          let stylist = args.stylist ? resolveStylist(args.stylist) : null;
          if (args.stylist && !stylist) {
            return { stylist_not_found: true, stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role })) };
          }
          if (!stylist) {
            stylist = store.getStylistRows().find((row) => slotFree(day.offset, row.id, startMinutes, endMinutes)) || null;
            if (!stylist) {
              return {
                ok: false, reason: "slot_taken",
                alternatives: freeSlots(day.offset, service.duration_minutes, null).map((s) => ({ stylist: s.stylist, time: s.time }))
              };
            }
          } else if (!slotFree(day.offset, stylist.id, startMinutes, endMinutes)) {
            return {
              ok: false, reason: "slot_taken", stylist: stylist.name,
              alternatives: freeSlots(day.offset, service.duration_minutes, stylist).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          const conversation = getConversationRow(session.conversation_id);
          const clientName = String(args.client_name || "").trim() ||
            (session.client_id ? (store.getClientRecordById(session.client_id) || {}).name : "") ||
            conversation.name;
          const clientPhone = String(args.client_phone || "").trim() || session.client_phone || "";
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
          if (!pendingMatches(pending, proposal) || !isAffirmation(turn.userMessage)) {
            session.state.pendingAction = proposal;
            return {
              status: "needs_confirmation",
              read_back: {
                service: service.name,
                stylist: stylist.name,
                day: dayLabel(day.offset),
                time: proposal.timeLabel,
                client_name: clientName,
                price: service.price_label
              },
              instruction: "Read these details back to the client and ask ONE question: is everything correct? Do NOT say the booking is created. After an explicit yes, call book_appointment again with the same arguments."
            };
          }
          // commit — the only path that writes the appointment
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
          const row = appointmentId ? db.prepare(`SELECT * FROM appointments WHERE salon_id = ? AND id = ?`).get(salonId, appointmentId) : null;
          if (!row) {
            leaveOwnerMessage(session, `Не удалось создать запись: ${service.name}, ${dayLabel(day.offset)} ${proposal.timeLabel}, клиент ${clientName}.`, "booking_failed");
            return { status: "failed", note: "DB write failed. Tell the client honestly the booking is NOT confirmed and the owner will follow up within the hour." };
          }
          session.state.pendingAction = null;
          turn.actionCommitted = true;
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
            price: service.price_label
          });
          return {
            status: "booked",
            appointment: {
              id: appointmentId,
              service: service.name,
              stylist: stylist.name,
              day: dayLabel(day.offset),
              time: proposal.timeLabel,
              price: service.price_label
            }
          };
        }

        case "reschedule_appointment": {
          const target = findClientAppointment(session, args.appointment_id);
          if (!target) return { ok: false, reason: "no_appointment_found", note: "Ask for the client's phone and call get_client_context first." };
          const day = resolveDay(args.day);
          if (day.error) return { error: day.error, note: "Ask for a concrete day." };
          const window = hoursForOffset(day.offset);
          if (!window) return { closed: true, note: `Salon is closed that day. Nearest open day: ${dayLabel(nextOpenOffset(day.offset))}.` };
          const startMinutes = parseTimeFlexible(args.time);
          if (startMinutes === null) return { error: "unparsed_time" };
          const duration = target.end_minutes - target.start_minutes;
          const endMinutes = startMinutes + duration;
          if (startMinutes < window[0] || endMinutes > window[1]) {
            return { error: "outside_hours", note: `Working hours on ${dayLabel(day.offset)} are ${hoursLabelForOffset(day.offset)}.` };
          }
          if (day.offset === 0 && startMinutes < minStartForOffset(0)) {
            return {
              error: "time_in_past",
              note: `That time today is already past — it is ${minutesLabel(salonMinutesNow())} salon time. Offer a future time instead.`,
              alternatives: freeSlots(0, duration, null).map((s) => ({ stylist: s.stylist, time: s.time }))
            };
          }
          const stylist = args.stylist ? resolveStylist(args.stylist) : db.prepare(`SELECT * FROM stylists WHERE salon_id = ? AND id = ?`).get(salonId, target.stylist_id);
          if (!stylist) return { stylist_not_found: true, stylists: store.getStylistRows().map((row) => ({ name: row.name, role: row.role })) };
          const busy = busyIntervals(day.offset, stylist.id).some((iv) =>
            startMinutes < iv.end_minutes && endMinutes > iv.start_minutes &&
            !(target.day_offset === day.offset && target.stylist_id === stylist.id && iv.start_minutes === target.start_minutes)
          );
          if (busy) {
            return { ok: false, reason: "slot_taken", alternatives: freeSlots(day.offset, duration, stylist).map((s) => ({ stylist: s.stylist, time: s.time })) };
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
            session.state.pendingAction = proposal;
            return {
              status: "needs_confirmation",
              read_back: {
                service: target.service_name,
                stylist: stylist.name,
                new_day: dayLabel(day.offset),
                new_time: proposal.timeLabel,
                client_name: target.client_name
              },
              instruction: "Read the new details back, ask ONE confirmation question, and call again with the same arguments after an explicit yes."
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
          session.state.pendingAction = null;
          turn.actionCommitted = true;
          addSystemThreadNote(session, `Maya rescheduled: ${target.service_name} → ${dayLabel(day.offset)} ${proposal.timeLabel} with ${stylist.name}.`);
          recordEvent(session, "reschedule", {
            appointmentId: target.id,
            client: target.client_name,
            service: target.service_name,
            stylist: stylist.name,
            day: dayLabel(day.offset),
            time: proposal.timeLabel
          });
          return { status: "rescheduled", appointment: { id: target.id, service: target.service_name, stylist: stylist.name, day: dayLabel(day.offset), time: proposal.timeLabel } };
        }

        case "cancel_appointment": {
          const target = findClientAppointment(session, args.appointment_id);
          if (!target) return { ok: false, reason: "no_appointment_found", note: "Ask for the client's phone and call get_client_context first." };
          const proposal = { kind: "cancel", appointmentId: target.id };
          const pending = session.state.pendingAction;
          if (!pendingMatches(pending, proposal) || !isAffirmation(turn.userMessage)) {
            session.state.pendingAction = proposal;
            return {
              status: "needs_confirmation",
              read_back: {
                service: target.service_name,
                stylist: target.stylist_name || "",
                day: dayLabel(Number(target.day_offset || 0)),
                time: store.formatTimeRange(target.start_minutes, target.end_minutes),
                client_name: target.client_name
              },
              instruction: "Confirm the client really wants to cancel THIS appointment, then call again after an explicit yes."
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
          session.state.pendingAction = null;
          turn.actionCommitted = true;
          addSystemThreadNote(session, `Maya canceled: ${target.service_name}, ${store.formatTimeRange(target.start_minutes, target.end_minutes)}.`);
          recordEvent(session, "cancellation", { appointmentId: target.id, client: target.client_name, service: target.service_name });
          return { status: "canceled", appointment: { id: target.id, service: target.service_name } };
        }

        case "leave_message_for_owner": {
          if (!String(args.message || "").trim()) return { error: "empty_message" };
          leaveOwnerMessage(session, args.message, args.topic);
          return { ok: true, note: "Saved. Tell the client the owner will reply within the hour." };
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
            rawReason && !KNOWN_REASONS.includes(rawReason) ? `Резюме Майи: ${rawReason}` : ""
          ].filter(Boolean).join(" | ");
          escalate(session, reason, summary);
          return { ok: true, note: "Conversation flagged for a human. Tell the client a person will reply here within the hour, then stay silent." };
        }

        default:
          return { error: `unknown_tool:${name}` };
      }
    }

    // ---------- deterministic commit backstop ----------
    // When the client explicitly affirmed a staged action but the model failed to
    // produce anything (empty reply / LLM error), commit the staged action in
    // code — all its arguments were already validated when it was staged.
    function commitPendingAction(session, turn) {
      const pending = session.state.pendingAction;
      if (!pending) return null;
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
          if (result && result.status === "booked") {
            const a = result.appointment;
            return localized({
              ru: `Готово, вы записаны: ${a.service} у ${a.stylist}, ${a.day} в ${a.time}. Если планы поменяются — просто напишите мне.`,
              uk: `Готово, вас записано: ${a.service} у ${a.stylist}, ${a.day} о ${a.time}. Якщо плани зміняться — просто напишіть мені.`,
              en: `All set — you're booked: ${a.service} with ${a.stylist}, ${a.day} at ${a.time}. If plans change, just message me.`
            }, session.language);
          }
        } else if (pending.kind === "reschedule") {
          const result = executeTool(session, turn, "reschedule_appointment", {
            day: String(pending.dayOffset),
            time: minutesLabel(pending.startMinutes),
            stylist: pending.stylistName,
            appointment_id: pending.appointmentId
          });
          if (result && result.status === "rescheduled") {
            const a = result.appointment;
            return localized({
              ru: `Готово, перенесла: ${a.service} теперь ${a.day} в ${a.time}, мастер ${a.stylist}.`,
              uk: `Готово, перенесла: ${a.service} тепер ${a.day} о ${a.time}, майстер ${a.stylist}.`,
              en: `Done — moved: ${a.service} is now ${a.day} at ${a.time} with ${a.stylist}.`
            }, session.language);
          }
        } else if (pending.kind === "cancel") {
          const result = executeTool(session, turn, "cancel_appointment", { appointment_id: pending.appointmentId });
          if (result && result.status === "canceled") {
            return localized({
              ru: "Готово, запись отменена. Если захотите вернуться — я всегда тут.",
              uk: "Готово, запис скасовано. Якщо захочете повернутися — я завжди тут.",
              en: "Done — the appointment is cancelled. If you'd like to come back, I'm always here."
            }, session.language);
          }
        }
      } catch (error) {
        // fall through to the honest fallback path
      }
      return null;
    }

    // ---------- reply gates ----------
    function gateReply(session, turn, rawReply) {
      let reply = String(rawReply || "").trim();
      const language = session.language || "ru";
      const gates = [];

      if (!reply) {
        gates.push("empty_reply");
        reply = localized(FALLBACKS.unknown, language);
        // This fallback promises "вам напишут в течение часа" — back the promise
        // with a real owner task on the SAME turn (mirror of the llm_error path).
        leaveOwnerMessage(
          session,
          `Майя не смогла ответить (пустой ответ модели). Клиент ждёт ответа: "${String(turn.userMessage || "").slice(0, 200)}"`,
          "empty_reply"
        );
      }

      // Gate 1: booking claims require a committed DB write this turn.
      if (BOOKING_CLAIM_RE.test(reply) && !turn.actionCommitted) {
        gates.push("booking_claim_blocked");
        leaveOwnerMessage(session, `Maya попыталась подтвердить запись без записи в системе. Ответ заменён. Диалог: ${session.conversation_id}`, "booking_gate");
        reply = localized(FALLBACKS.notBooked, language);
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

      // Gate 3: price quote-guard — every price in the reply must have come from a tool result.
      const allowed = new Set((session.state.quotedPrices || []).map(Number));
      const prices = extractPriceNumbers(reply);
      const unknownPrice = prices.find((price) => !allowed.has(price));
      if (unknownPrice !== undefined) {
        gates.push(`price_guard:${unknownPrice}`);
        leaveOwnerMessage(session, `Maya назвала цену ${unknownPrice}, которой нет в данных инструментов. Ответ заменён. Вопрос клиента: ${String(turn.userMessage).slice(0, 200)}`, "price_guard");
        reply = localized(FALLBACKS.unknown, language);
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

      // Gate 5: banned phrases (style scrub, non-blocking).
      for (const [re, replacement] of BANNED_REPLACEMENTS) {
        if (re.test(reply)) {
          gates.push("style_scrub");
          reply = reply.replace(re, replacement);
        }
      }
      reply = reply.replace(/\s{2,}/g, " ").trim();
      if (gates.length) recordEvent(session, "gate_triggered", { gates, original: String(rawReply || "").slice(0, 300) });
      return { reply, gates };
    }

    // ---------- main turn ----------
    async function chat({ sessionId, message, channel, clientPhone }) {
      const text = String(message || "").trim().slice(0, 2000);
      const sid = String(sessionId || "").trim();
      if (!sid || !text) return { error: "bad_request", message: "sessionId and message are required." };

      // Zero-LLM watchdog fast-path: uptime probes get an instant reply and must
      // never touch the LLM, sessions, conversations, or the digest.
      if (text === "ping" && sid.startsWith("watchdog-")) {
        return { reply: "pong", watchdog: true };
      }

      if (rateLimited(sid)) return { error: "rate_limited", message: "Too many messages; slow down a little." };

      const session = ensureSession({ sessionId: sid, channel, clientPhone, language: detectLanguage(text) });
      session.language = detectLanguage(text);
      const conversation = getConversationRow(session.conversation_id);

      // Takeover / escalation silencing: store the message so the owner sees it, say nothing.
      if (conversation && ["takeover", "escalated"].includes(conversation.assistant_state)) {
        persistMessage(session, "incoming", text);
        recordEvent(session, "message_in", { text: text.slice(0, 300), silenced: true });
        saveSession(session);
        return {
          reply: null,
          state: sessionState(session, { silenced: true, reason: conversation.assistant_state })
        };
      }

      persistMessage(session, "incoming", text);
      recordEvent(session, "message_in", { text: text.slice(0, 300) });

      const isFirstTurn = db.prepare(`
        SELECT COUNT(*) AS count FROM conversation_messages WHERE salon_id = ? AND conversation_id = ? AND type = 'incoming'
      `).get(salonId, session.conversation_id).count <= 1;

      const turn = {
        id: createId("aturn"),
        llmCalls: 0,
        userMessage: text,
        actionCommitted: false,
        handoffRequested: false,
        escalateAfter: null,
        unknownStylists: detectUnknownStylists(text)
      };

      // Hard triggers answer without the LLM; soft ones steer this turn then escalate.
      const trigger = checkTriggers(text);
      if (trigger && trigger.hard) {
        let reply = localized(FALLBACKS.handoff, session.language);
        if (isFirstTurn && !hasAiDisclosure(reply)) {
          reply = withFirstTurnIntro(reply, session.language);
          recordEvent(session, "gate_triggered", { gates: ["first_turn_disclosure"] });
        }
        escalate(session, trigger.reason, text);
        persistMessage(session, "outgoing", reply);
        recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: trigger.reason });
        saveSession(session);
        return { reply, state: sessionState(session, { escalated: trigger.reason }) };
      }
      if (trigger) turn.escalateAfter = trigger.reason;

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
          let reply = localized(turn.escalateAfter === "complaint" ? COMPLAINT_REPLY : FALLBACKS.handoff, session.language);
          if (isFirstTurn && !hasAiDisclosure(reply)) reply = withFirstTurnIntro(reply, session.language);
          escalate(session, turn.escalateAfter, text);
          persistMessage(session, "outgoing", reply);
          recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: `${turn.escalateAfter}_at_cap` });
          saveSession(session);
          return { reply, state: sessionState(session, { escalated: turn.escalateAfter, capped: true }) };
        }
        let reply = localized(CAP_REPLY, session.language);
        if (isFirstTurn && !hasAiDisclosure(reply)) reply = withFirstTurnIntro(reply, session.language);
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

      let clientHint = "";
      if (session.client_id) {
        const client = store.getClientRecordById(session.client_id);
        if (client) {
          const preferences = store.getClientPreferences(client.id).slice(0, 2).join("; ");
          clientHint = `Клиент: ${client.name} (${client.status}). Последний визит: ${client.last_visit}.${preferences ? ` Предпочтения: ${preferences}.` : ""}`;
        }
      }

      const systemPrompt = buildSystemPrompt({ faq, language: session.language, isFirstTurn, clientHint });
      const messages = [{ role: "system", content: systemPrompt }];
      if (turn.escalateAfter === "complaint") {
        messages.push({
          role: "system",
          content: "Клиент жалуется. В ЭТОМ ЖЕ ответе КЛИЕНТУ обязательно все три такта: (1) назови чувство («это правда обидно»), (2) один раз искренне извинись, (3) конкретный следующий шаг со сроком — владелец увидит сообщение в течение часа и напишет прямо здесь; можно упомянуть бесплатную коррекцию в 48 часов как «передам владельцу, он подтвердит». Ничего не продавай. Затем вызови request_human_handoff с кратким резюме."
        });
      } else if (turn.escalateAfter) {
        messages.push({
          role: "system",
          content: "Клиент напряжён или спорит о цене. Ответь спокойно и коротко, без продаж, затем вызови request_human_handoff с причиной."
        });
      }
      if (turn.unknownStylists.length) {
        const staffNames = store.getStylistRows().map((row) => row.name).join(", ");
        messages.push({
          role: "system",
          content: `Проверка по базе: мастера «${turn.unknownStylists.map((entry) => entry.raw).join("», «")}» в салоне НЕ СУЩЕСТВУЕТ. Реальные мастера: ${staffNames}. В ПЕРВОМ ЖЕ ответе честно скажи, что такого мастера у нас нет — без похвал и подтверждений несуществующему имени — и предложи записать к одному из реальных мастеров.`
        });
      }
      messages.push(...buildHistoryMessages(session));

      let reply = null;
      let llmError = null;
      try {
        let rounds = 0;
        let current = messages;
        while (rounds < MAX_TOOL_ROUNDS) {
          rounds += 1;
          const assistantMessage = await llm.complete({ messages: current, tools: TOOL_DEFS });
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
        // that backs its "within the hour" promise, and counts the failure once.
      } catch (error) {
        llmError = error;
      }

      // Deterministic commit backstop: the client explicitly affirmed a staged
      // action but the model produced nothing (empty reply or LLM error) —
      // commit the staged action in code and confirm honestly.
      if (!turn.actionCommitted && session.state.pendingAction && isAffirmation(text) &&
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
        reply = localized(FALLBACKS.error, session.language);
      }

      const gated = gateReply(session, turn, reply);

      // Complaint turns: the CLIENT-facing reply must carry all three beats
      // (feeling + one apology + concrete next step with timeframe). If the model
      // condensed them away, replace with the deterministic 3-beat reply.
      if (turn.escalateAfter === "complaint" && !complaintBeatsPresent(gated.reply)) {
        recordEvent(session, "gate_triggered", { gates: ["complaint_rewrite"], original: gated.reply.slice(0, 300) });
        gated.gates.push("complaint_rewrite");
        gated.reply = localized(COMPLAINT_REPLY, session.language);
      }

      // First reply of a new session must disclose the AI identity (prompt rule,
      // enforced here as a backstop).
      if (isFirstTurn && !hasAiDisclosure(gated.reply)) {
        recordEvent(session, "gate_triggered", { gates: ["first_turn_disclosure"] });
        gated.gates.push("first_turn_disclosure");
        gated.reply = withFirstTurnIntro(gated.reply, session.language);
      }

      const BENIGN_GATES = new Set(["style_scrub", "markdown_scrub", "complaint_rewrite", "first_turn_disclosure"]);
      if (gated.gates.some((gate) => !BENIGN_GATES.has(gate))) {
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
            saveSession(session);
          }
        }
      }
      return { conversationId, assistantState: state };
    }

    // Called when staff sends an outgoing message via the inbox UI: bot goes silent.
    function noteStaffMessage(conversationId) {
      const conversation = getConversationRow(conversationId);
      if (!conversation || !conversation.assistant_session_id) return;
      if (conversation.assistant_state !== "takeover") setTakeover(conversationId, true);
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
      const targetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? day : salonDayString();
      const events = db.prepare(`
        SELECT * FROM assistant_events WHERE salon_id = ? AND day = ? ORDER BY created_at ASC
      `).all(salonId, targetDay).map((row) => Object.assign(row, { payload: JSON.parse(row.payload_json || "{}") }));

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
      // exposed for tests
      _internals: {
        detectLanguage,
        checkTriggers,
        isAffirmation,
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
        recordEvent,
        llmTurnsForDay,
        dailyTurnsCap: DAILY_TURNS_CAP,
        TOOL_DEFS
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
    async chat(payload = {}) {
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
    // Default-salon internals, kept for the existing single-salon test suite.
    _internals: defaultAssistant._internals
  };
}

module.exports = { createAssistant };
