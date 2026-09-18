// Self-serve tenancy: a salon owner signs up, gets a trial assistant, fills in
// their salon through the setup wizard, connects their own Telegram bot and uses
// it — with nobody on our side touching a keyboard.
//
// What lives here:
//   - tenants            one row per self-serve salon: plan, trial end, the
//                        owner's setup document (the wizard's source of truth)
//   - tenant_telegram    the salon's own bot (token encrypted at rest), its
//                        webhook secret and the owner's linked chat
//   - tenant_addon_requests  "I want Instagram / Square / SMS …" requests
//
// Salons that existed before self-serve (the demo salon, salons onboarded by
// scripts/onboard-salon.mjs) have no tenants row and keep working exactly as
// before: no trial clock, no setup gate.
//
// Wiring order (server.js): createTenancy → createAssistant(with tenancy.hooks)
// → tenancy.attachAssistant(assistant). The assistant needs the hooks at build
// time and tenancy needs the assistant to answer messages.

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const net = require("node:net");

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;
const TRIAL_TURNS_CAP = Number(process.env.TRIAL_DAILY_TURNS_CAP) || 150;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_IP = Number(process.env.SIGNUP_MAX_PER_IP) || 5;
const EXTRACT_MAX_CHARS = 24000;
const SITE_MAX_BYTES = 1_500_000;
const TG_MAX_MESSAGE = 4096;

const BUSINESS_TYPES = ["hair", "nails", "lashes_brows", "barber", "spa", "multi"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RESERVED_SLUGS = new Set(["luminous-core", "admin", "api", "app", "www", "demo", "signup", "login", "setup", "screens"]);

// Paid extras. `auto: true` means the owner switches it on in the wizard with no
// human involved; the rest are requested and we come back with a quote. Prices
// are deliberately absent: nobody has set them yet.
const ADDONS = [
  { key: "telegram", auto: true, title: { en: "Telegram bot", ru: "Telegram-бот" } },
  { key: "website_widget", auto: true, title: { en: "Chat on your website", ru: "Чат на вашем сайте" } },
  { key: "owner_alerts", auto: true, title: { en: "Bookings and alerts in your Telegram", ru: "Записи и тревоги в ваш Telegram" } },
  { key: "instagram_dm", auto: false, title: { en: "Instagram Direct", ru: "Instagram Direct" } },
  { key: "facebook_messenger", auto: false, title: { en: "Facebook Messenger", ru: "Facebook Messenger" } },
  { key: "whatsapp", auto: false, title: { en: "WhatsApp", ru: "WhatsApp" } },
  { key: "sms_reminders", auto: false, title: { en: "SMS reminders before visits", ru: "SMS-напоминания перед визитом" } },
  { key: "calendar_sync", auto: false, title: { en: "Sync with Square / Fresha / Vagaro / Google Calendar", ru: "Синхронизация с Square / Fresha / Vagaro / Google Calendar" } },
  { key: "google_reviews", auto: false, title: { en: "Replies to Google reviews", ru: "Ответы на отзывы в Google" } },
  { key: "phone_calls", auto: false, title: { en: "AI answers phone calls", ru: "ИИ отвечает на звонки" } },
  { key: "done_for_you", auto: false, title: { en: "We set everything up for you", ru: "Настроим всё за вас" } },
  { key: "continue_after_trial", auto: false, title: { en: "Keep the assistant after the trial", ru: "Оставить ассистента после пробного периода" } }
];

// ---------------------------------------------------------------------------
// Owner alerts: one readable Telegram message per event, in the owner's own
// UI language (tenant.language), with no internal codes.
// ---------------------------------------------------------------------------

const OWNER_LANGS = ["en", "fr", "ru"];
const LOCALE_OF = { en: "en-CA", fr: "fr-CA", ru: "ru-RU" };
// Two attention alerts (needs a human / Maya's note) about one conversation
// within this window are one alert: the owner already knows to look.
const ATTENTION_QUIET_MS = 60 * 1000;

function ownerLang(tenant) {
  const lang = String((tenant && tenant.language) || "en").slice(0, 2).toLowerCase();
  if (lang === "uk") return "ru";
  return OWNER_LANGS.includes(lang) ? lang : "en";
}

function isMedspa(tenant) {
  return /^(medspa|clinic|medical)/.test(String((tenant && tenant.businessType) || ""));
}

// "Web client 1a2b", "Telegram client 1a2b" and the legacy "Веб-гость 1a2b"
// are placeholders, not names.
const GENERIC_NAME_RE = /^(web client|telegram client|веб-гость|client web|client telegram|веб-клиент|telegram-клиент)(\s|$)/i;
// store.createConversation fills a new thread's implicit client with these
// placeholders; they are not contact details and never reach an owner.
function realPhone(value) {
  const text = String(value || "").trim();
  return text && text !== "(555) 000-0000" ? text : "";
}

const ALERT_TEXT = {
  en: {
    booking: "✅ New booking",
    reschedule: "🔁 Booking moved",
    cancellation: "❌ Booking cancelled",
    escalation: (name) => `🔔 ${name} needs a person`,
    ownerMessage: (name) => `✉️ ${name} is waiting for your answer`,
    with: (stylist) => `with ${stylist}`,
    reasons: {
      explicit_request: "They asked to talk to a person.",
      medical: "Health or skin question. Maya does not answer these.",
      complaint: "They are unhappy about a visit.",
      price_dispute: "They are unhappy about a price.",
      frustration: "They sound frustrated.",
      repeated_misunderstanding: "Maya did not understand them twice.",
      assistant_requested: "Maya passed the conversation to you.",
      owner_message: "Maya passed the conversation to you."
    },
    topics: {
      price_guard: "Maya was about to quote a price that is not on your list, so she held back and asked them to wait for you.",
      booking_gate: "Maya could not confirm the booking in the calendar. Please confirm it yourself.",
      empty_reply: "Maya could not answer this message.",
      llm_error: "Maya could not answer this message.",
      reschedule_failed: "Maya could not move this booking. Please move it yourself.",
      daily_cap: "Maya reached today's message limit and took a note for you."
    },
    medicalHidden: "Medical question. Open the conversation to read it.",
    textHidden: "Open the conversation to read the message.",
    said: "They wrote",
    replyHint: (name) => `↩️ Reply to this message and your answer goes to ${name}.`,
    webHint: (name) => `↩️ Reply to this message: ${name} sees your answer when they open the chat again.`,
    open: "Open the conversation",
    test: "Test chat",
    usage: (threshold, turns, cap) => threshold >= 100
      ? `⛔ Maya used all of today's ${cap} replies. Clients get a polite note and their messages wait for you in the inbox. The count resets at midnight.`
      : `⚠️ Maya used ${threshold}% of today's replies (${turns} of ${cap}).`
  },
  fr: {
    booking: "✅ Nouveau rendez-vous",
    reschedule: "🔁 Rendez-vous déplacé",
    cancellation: "❌ Rendez-vous annulé",
    escalation: (name) => `🔔 ${name} veut parler à quelqu'un`,
    ownerMessage: (name) => `✉️ ${name} attend votre réponse`,
    with: (stylist) => `avec ${stylist}`,
    reasons: {
      explicit_request: "La personne a demandé à parler à quelqu'un.",
      medical: "Question de santé ou de peau. Maya n'y répond pas.",
      complaint: "La personne n'est pas satisfaite d'une visite.",
      price_dispute: "La personne n'est pas d'accord avec un prix.",
      frustration: "La personne semble agacée.",
      repeated_misunderstanding: "Maya ne l'a pas comprise deux fois de suite.",
      assistant_requested: "Maya vous a transmis la conversation.",
      owner_message: "Maya vous a transmis la conversation."
    },
    topics: {
      price_guard: "Maya allait donner un prix absent de votre liste. Elle s'est retenue et a demandé à la personne d'attendre votre réponse.",
      booking_gate: "Maya n'a pas pu confirmer le rendez-vous dans l'agenda. Confirmez-le vous-même.",
      empty_reply: "Maya n'a pas pu répondre à ce message.",
      llm_error: "Maya n'a pas pu répondre à ce message.",
      reschedule_failed: "Maya n'a pas pu déplacer ce rendez-vous. Déplacez-le vous-même.",
      daily_cap: "Maya a atteint la limite de messages du jour et a pris une note pour vous."
    },
    medicalHidden: "Question médicale. Ouvrez la conversation pour la lire.",
    textHidden: "Ouvrez la conversation pour lire le message.",
    said: "Message",
    colon: "\u00a0: ",
    replyHint: (name) => `↩️ Répondez à ce message et votre réponse ira à ${name}.`,
    webHint: (name) => `↩️ Répondez à ce message : ${name} verra votre réponse en rouvrant le clavardage.`,
    open: "Ouvrir la conversation",
    test: "Clavardage test",
    usage: (threshold, turns, cap) => threshold >= 100
      ? `⛔ Maya a utilisé les ${cap} réponses du jour. Les clients reçoivent un mot poli et leurs messages vous attendent dans la boîte de réception. Le compteur repart à minuit.`
      : `⚠️ Maya a utilisé ${threshold} % des réponses du jour (${turns} sur ${cap}).`
  },
  ru: {
    booking: "✅ Новая запись",
    reschedule: "🔁 Запись перенесена",
    cancellation: "❌ Запись отменена",
    escalation: (name) => `🔔 ${name}: нужен человек`,
    ownerMessage: (name) => `✉️ ${name} ждёт вашего ответа`,
    with: (stylist) => `мастер ${stylist}`,
    reasons: {
      explicit_request: "Клиент попросил живого человека.",
      medical: "Вопрос о здоровье или коже. Майя на такие не отвечает.",
      complaint: "Клиент недоволен визитом.",
      price_dispute: "Клиент недоволен ценой.",
      frustration: "Клиент раздражён.",
      repeated_misunderstanding: "Майя дважды не поняла клиента.",
      assistant_requested: "Майя передала разговор вам.",
      owner_message: "Майя передала разговор вам."
    },
    topics: {
      price_guard: "Майя чуть не назвала цену, которой нет в вашем прайсе. Она остановилась и попросила клиента дождаться вашего ответа.",
      booking_gate: "Майя не смогла подтвердить запись в календаре. Подтвердите её сами.",
      empty_reply: "Майя не смогла ответить на это сообщение.",
      llm_error: "Майя не смогла ответить на это сообщение.",
      reschedule_failed: "Майя не смогла перенести запись. Перенесите её сами.",
      daily_cap: "У Майи закончился дневной лимит сообщений, она записала вопрос для вас."
    },
    medicalHidden: "Медицинский вопрос. Откройте переписку, чтобы прочитать.",
    textHidden: "Откройте переписку, чтобы прочитать сообщение.",
    said: "Клиент пишет",
    replyHint: (name) => `↩️ Ответьте на это сообщение, и ваш ответ уйдёт клиенту ${name}.`,
    webHint: (name) => `↩️ Ответьте на это сообщение: ${name} увидит ответ, когда снова откроет чат.`,
    open: "Открыть переписку",
    test: "Тестовый чат",
    usage: (threshold, turns, cap) => threshold >= 100
      ? `⛔ Майя израсходовала все ${cap} ответов на сегодня. Клиенты получают вежливую заглушку, их сообщения ждут вас во входящих. Счётчик обнулится в полночь.`
      : `⚠️ Майя израсходовала ${threshold}% дневных ответов (${turns} из ${cap}).`
  }
};

const OWNER_CHAT_TEXT = {
  en: {
    linked: (chatLink) => `Done. New bookings, changes, cancellations and clients who need a person will arrive here.\n\nTo answer a client, reply to their alert (swipe left on it, or long-press and choose Reply). I'll send your answer to the client.\n\nMaya does not answer in this chat, because it is yours. To try her as a client, open your test chat while signed in: ${chatLink}`,
    help: (inbox, chatLink) => `This chat is for your alerts, so Maya does not answer here.\n\n• To answer a client, reply to their alert (swipe left on it, or long-press and choose Reply) and type your message. I'll send it to the client.\n• All conversations: ${inbox}\n• To try Maya as a client, open your test chat while signed in: ${chatLink}`,
    unknownAlert: (inbox) => `I can't tell which client that message belongs to. Reply to an alert about a client, or answer from the inbox: ${inbox}`,
    textOnly: "Only text can be forwarded to a client for now.",
    sent: (name) => `✓ Sent to ${name}.`,
    waiting: (name) => `✓ Saved. ${name} sees it when they open the chat again.`,
    failed: (name, inbox) => `Your answer did not reach ${name}: Telegram refused it. It is saved in the inbox: ${inbox}`
  },
  fr: {
    linked: (chatLink) => `C'est fait. Les nouveaux rendez-vous, changements, annulations et les clients qui veulent parler à quelqu'un arriveront ici.\n\nPour répondre à un client, répondez à son alerte (glissez-la vers la gauche, ou appui long puis Répondre). J'envoie votre réponse au client.\n\nMaya ne répond pas dans ce clavardage, il est à vous. Pour l'essayer comme un client, ouvrez votre clavardage test en étant connecté : ${chatLink}`,
    help: (inbox, chatLink) => `Ce clavardage sert à vos alertes, Maya n'y répond donc pas.\n\n• Pour répondre à un client, répondez à son alerte (glissez-la vers la gauche, ou appui long puis Répondre) et écrivez votre message. Je l'envoie au client.\n• Toutes les conversations : ${inbox}\n• Pour essayer Maya comme un client, ouvrez votre clavardage test en étant connecté : ${chatLink}`,
    unknownAlert: (inbox) => `Je ne sais pas à quel client ce message s'adresse. Répondez à une alerte sur un client, ou répondez depuis la boîte de réception : ${inbox}`,
    textOnly: "Pour l'instant, seul le texte peut être transmis à un client.",
    sent: (name) => `✓ Envoyé à ${name}.`,
    waiting: (name) => `✓ Enregistré. ${name} le verra en rouvrant le clavardage.`,
    failed: (name, inbox) => `Votre réponse n'a pas pu être livrée à ${name} : Telegram l'a refusée. Elle est enregistrée dans la boîte de réception : ${inbox}`
  },
  ru: {
    linked: (chatLink) => `Готово. Сюда будут приходить новые записи, переносы, отмены и клиенты, которым нужен человек.\n\nЧтобы ответить клиенту, ответьте на его уведомление (смахните его влево или нажмите и удерживайте → «Ответить»). Я перешлю ваш ответ клиенту.\n\nМайя в этом чате не отвечает: он ваш. Чтобы проверить её как клиент, откройте тестовый чат, войдя в кабинет: ${chatLink}`,
    help: (inbox, chatLink) => `Этот чат для ваших уведомлений, поэтому Майя здесь не отвечает.\n\n• Чтобы ответить клиенту, ответьте на его уведомление (смахните влево или нажмите и удерживайте → «Ответить») и напишите текст. Я перешлю его клиенту.\n• Все переписки: ${inbox}\n• Проверить Майю как клиент: откройте тестовый чат, войдя в кабинет: ${chatLink}`,
    unknownAlert: (inbox) => `Не понимаю, какому клиенту это сообщение. Ответьте на уведомление о клиенте или напишите из входящих: ${inbox}`,
    textOnly: "Пока клиенту можно переслать только текст.",
    sent: (name) => `✓ Отправлено: ${name}.`,
    waiting: (name) => `✓ Сохранено. ${name} увидит ответ, когда снова откроет чат.`,
    failed: (name, inbox) => `Ответ не дошёл до клиента ${name}: Telegram его не принял. Он сохранён во входящих: ${inbox}`
  }
};

function formatAlertDate(isoDate, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE_OF[lang] || "en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(`${isoDate}T12:00:00Z`));
  } catch (error) {
    return isoDate;
  }
}

function formatAlertTime(minutes, lang) {
  if (!Number.isFinite(Number(minutes))) return "";
  const hour = Math.floor(Number(minutes) / 60);
  const minute = String(Number(minutes) % 60).padStart(2, "0");
  if (lang === "fr") return `${hour} h ${minute}`;
  if (lang === "ru") return `${hour}:${minute}`;
  return `${((hour + 11) % 12) + 1}:${minute} ${hour < 12 ? "AM" : "PM"}`;
}

function localGenericName(name, lang) {
  const tail = String(name || "").replace(GENERIC_NAME_RE, "").trim();
  const telegram = /telegram/i.test(String(name || ""));
  const label = {
    en: telegram ? "Telegram client" : "Web client",
    fr: telegram ? "Client Telegram" : "Client web",
    ru: telegram ? "Клиент из Telegram" : "Клиент с сайта"
  }[lang] || (telegram ? "Telegram client" : "Web client");
  return tail ? `${label} ${tail}` : label;
}

function nowIso(clock) {
  return clock().toISOString();
}

function slugify(value) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", є: "ye", ё: "e", ж: "zh",
    з: "z", и: "i", і: "i", ї: "yi", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
    щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya"
  };
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split("")
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    return false;
  }
}

// "10:00-19:00", "9-19", "9:30 – 18" → { open:"10:00", close:"19:00" }; closed → null.
function parseHours(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || /^(closed|off|выходной|вихідний|—|-|no)$/.test(text)) return null;
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*[-–—to]+\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return { error: true };
  const open = Number(match[1]) * 60 + Number(match[2] || 0);
  const close = Number(match[3]) * 60 + Number(match[4] || 0);
  if (open >= 1440 || close > 1440 || close <= open) return { error: true };
  const pad = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { open: pad(open), close: pad(close) };
}

function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const digits = String(value || "").replace(/[^\d.,]/g, "").replace(",", ".");
  const parsed = Number.parseFloat(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// setup document: shape, validation, conversion to what the store expects
// ---------------------------------------------------------------------------

function emptySetup(signup = {}) {
  return {
    salon: {
      name: cleanText(signup.salonName, 120),
      city: cleanText(signup.city, 80),
      address: "",
      phone: cleanText(signup.phone, 40),
      website: "",
      instagram: "",
      timezone: signup.timezone || "America/Toronto"
    },
    hours: { sun: "closed", mon: "closed", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" },
    services: [],
    staff: [],
    faq: { parking: "", payment: "", cancellation: "", deposit: "", late: "", custom: [] },
    assistant: { forbidden: "" }
  };
}

// Normalises whatever the browser (or the extractor) sent into the setup shape,
// dropping unknown keys. Nothing here throws; validateSetup reports problems.
function normalizeSetup(input) {
  const doc = input && typeof input === "object" ? input : {};
  const salon = doc.salon || {};
  const hours = {};
  WEEKDAYS.forEach((day) => {
    const raw = doc.hours && doc.hours[day];
    hours[day] = raw === undefined || raw === null || raw === "" ? "closed" : cleanText(raw, 20);
  });
  const services = (Array.isArray(doc.services) ? doc.services : []).slice(0, 150).map((service) => ({
    name: cleanText(service && service.name, 90),
    category: cleanText(service && service.category, 60),
    durationMinutes: Math.round(Number(service && service.durationMinutes) || 0),
    price: cleanText(service && service.price, 30),
    deposit: Boolean(service && service.deposit),
    keywords: (Array.isArray(service && service.keywords) ? service.keywords : String((service && service.keywords) || "").split(","))
      .map((word) => cleanText(word, 40))
      .filter(Boolean)
      .slice(0, 12),
    note: cleanText(service && service.note, 240)
  })).filter((service) => service.name || service.price || service.durationMinutes);
  const staff = (Array.isArray(doc.staff) ? doc.staff : []).slice(0, 40).map((member) => ({
    name: cleanText(member && member.name, 60),
    role: cleanText(member && member.role, 60),
    services: (Array.isArray(member && member.services) ? member.services : []).map((name) => cleanText(name, 90)).filter(Boolean),
    workDays: (Array.isArray(member && member.workDays) ? member.workDays : []).map((day) => String(day).slice(0, 3).toLowerCase()).filter((day) => WEEKDAYS.includes(day))
  })).filter((member) => member.name);
  const faqIn = doc.faq || {};
  const faq = {
    parking: cleanText(faqIn.parking, 400),
    payment: cleanText(faqIn.payment, 400),
    cancellation: cleanText(faqIn.cancellation, 400),
    deposit: cleanText(faqIn.deposit, 400),
    late: cleanText(faqIn.late, 400),
    custom: (Array.isArray(faqIn.custom) ? faqIn.custom : []).slice(0, 30).map((entry) => ({
      q: cleanText(entry && entry.q, 200),
      a: cleanText(entry && entry.a, 600)
    })).filter((entry) => entry.a)
  };
  return {
    salon: {
      name: cleanText(salon.name, 120),
      city: cleanText(salon.city, 80),
      address: cleanText(salon.address, 200),
      phone: cleanText(salon.phone, 40),
      website: cleanText(salon.website, 200),
      instagram: cleanText(salon.instagram, 80),
      timezone: cleanText(salon.timezone, 60) || "America/Toronto"
    },
    hours,
    services,
    staff,
    faq,
    assistant: { forbidden: cleanText(doc.assistant && doc.assistant.forbidden, 400) }
  };
}

// Messages are addressed to the salon owner, in plain words, in their language.
const MESSAGES = {
  en: {
    name: "Add your salon's name.",
    timezone: (zone) => `Time zone "${zone}" is not recognised. Pick one from the list.`,
    hours: (day, value) => `Opening hours for ${day} look wrong: "${value}". Write them like 10:00-19:00, or choose "closed".`,
    noOpenDay: "Mark at least one day as open, otherwise no one can book.",
    noServices: "Add at least one service so the assistant has something to book.",
    serviceName: (index) => `Service #${index} has no name.`,
    serviceDup: (name) => `"${name}" is listed twice. Keep one, or give them different names.`,
    duration: (name) => `Set how many minutes "${name}" takes. The assistant needs it to find free time.`,
    price: (name, value) => `The price of "${name}" is unclear: "${value}". Write a number, like 65 or "from $110".`,
    noStaff: "Add at least one person who does the work, even if it is only you.",
    staffDup: (name) => `"${name}" is listed twice.`,
    staffService: (member, service) => `${member} does "${service}", but there is no service with that name. Pick it from your list.`,
    staffNoDays: (member) => `${member} has no working days. The assistant will not offer their time.`
  },
  ru: {
    name: "Впишите название салона.",
    timezone: (zone) => `Часовой пояс «${zone}» не распознан. Выберите его из списка.`,
    hours: (day, value) => `Часы работы на ${day} выглядят странно: «${value}». Пишите так: 10:00-19:00, или выберите «выходной».`,
    noOpenDay: "Отметьте хотя бы один рабочий день, иначе записаться будет некуда.",
    noServices: "Добавьте хотя бы одну услугу, чтобы ассистенту было на что записывать.",
    serviceName: (index) => `У услуги №${index} нет названия.`,
    serviceDup: (name) => `«${name}» указана дважды. Оставьте одну или назовите по-разному.`,
    duration: (name) => `Укажите, сколько минут длится «${name}». Без этого ассистент не найдёт свободное время.`,
    price: (name, value) => `Не понятна цена «${name}»: «${value}». Напишите числом, например 65 или «от $110».`,
    noStaff: "Добавьте хотя бы одного мастера, пусть даже это вы.",
    staffDup: (name) => `«${name}» указан дважды.`,
    staffService: (member, service) => `У мастера ${member} стоит услуга «${service}», а такой услуги нет в списке. Выберите её из списка.`,
    staffNoDays: (member) => `У мастера ${member} не отмечено ни одного рабочего дня. Ассистент не будет предлагать его время.`
  }
};

const DAY_NAMES = {
  en: { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" },
  ru: { sun: "воскресенье", mon: "понедельник", tue: "вторник", wed: "среду", thu: "четверг", fri: "пятницу", sat: "субботу" }
};

function validateSetup(doc, language = "en") {
  const t = MESSAGES[language] || MESSAGES.en;
  const days = DAY_NAMES[language] || DAY_NAMES.en;
  const errors = [];
  const warnings = [];
  const add = (field, message) => errors.push({ field, message });

  if (!doc.salon.name) add("salon.name", t.name);
  if (!validTimezone(doc.salon.timezone)) add("salon.timezone", t.timezone(doc.salon.timezone));

  let openDays = 0;
  WEEKDAYS.forEach((day) => {
    const parsed = parseHours(doc.hours[day]);
    if (parsed && parsed.error) add(`hours.${day}`, t.hours(days[day], doc.hours[day]));
    else if (parsed) openDays += 1;
  });
  if (!openDays) add("hours", t.noOpenDay);

  if (!doc.services.length) add("services", t.noServices);
  const serviceNames = new Set();
  doc.services.forEach((service, index) => {
    if (!service.name) {
      add(`services.${index}.name`, t.serviceName(index + 1));
      return;
    }
    const key = service.name.toLowerCase();
    if (serviceNames.has(key)) add(`services.${index}.name`, t.serviceDup(service.name));
    serviceNames.add(key);
    if (!(service.durationMinutes > 0 && service.durationMinutes <= 720)) add(`services.${index}.durationMinutes`, t.duration(service.name));
    if (parsePrice(service.price) === null) add(`services.${index}.price`, t.price(service.name, service.price));
  });

  if (!doc.staff.length) add("staff", t.noStaff);
  const staffNames = new Set();
  doc.staff.forEach((member, index) => {
    const key = member.name.toLowerCase();
    if (staffNames.has(key)) add(`staff.${index}.name`, t.staffDup(member.name));
    staffNames.add(key);
    member.services.forEach((name) => {
      if (!serviceNames.has(name.toLowerCase())) add(`staff.${index}.services`, t.staffService(member.name, name));
    });
    if (!member.workDays.length) warnings.push({ field: `staff.${index}.workDays`, message: t.staffNoDays(member.name) });
  });

  return { errors, warnings };
}

function setupToStore(doc) {
  const hours = {};
  WEEKDAYS.forEach((day, index) => {
    const parsed = parseHours(doc.hours[day]);
    hours[String(index)] = parsed && !parsed.error ? parsed : null;
  });

  const byCategory = new Map();
  doc.services.forEach((service) => {
    const category = service.category || "Services";
    if (!byCategory.has(category)) byCategory.set(category, []);
    const priceValue = parsePrice(service.price) || 0;
    byCategory.get(category).push({
      name: service.name,
      durationMinutes: service.durationMinutes || 60,
      priceValue,
      // The owner's own wording ("from $110") is what the assistant quotes;
      // priceValue is what the quote guard checks against.
      priceLabel: /[^\d.,\s$]/.test(service.price) ? service.price : `$${priceValue.toFixed(2)}`,
      requiresDeposit: service.deposit,
      description: service.note || `${service.name} — ${category}.`,
      keywords: service.keywords
    });
  });
  const categories = [...byCategory.entries()].map(([name, services]) => ({
    name,
    badge: `${services.length} services`,
    icon: "spa",
    tone: "primary",
    services
  }));

  const allServiceNames = doc.services.map((service) => service.name);
  const byLower = new Map(allServiceNames.map((name) => [name.toLowerCase(), name]));
  const staff = doc.staff.map((member) => ({
    name: member.name,
    role: member.role || "Stylist",
    // An empty list in the wizard means "does everything".
    services: member.services.length
      ? member.services.map((name) => byLower.get(name.toLowerCase())).filter(Boolean)
      : allServiceNames,
    workDays: member.workDays.map((day) => WEEKDAYS.indexOf(day)),
    aliases: []
  }));

  const topics = [];
  const push = (id, text) => {
    const value = String(text || "").trim();
    if (value) topics.push({ id, ru: value, en: value });
  };
  const hoursText = WEEKDAYS.map((day) => {
    const parsed = parseHours(doc.hours[day]);
    return parsed && !parsed.error ? `${DAY_NAMES.en[day]} ${parsed.open}–${parsed.close}` : `${DAY_NAMES.en[day]} closed`;
  }).join(", ");
  push("hours", `Opening hours: ${hoursText}.`);
  if (doc.salon.address) push("address", `Address: ${doc.salon.address}.`);
  if (doc.salon.phone) push("phone", `Salon phone: ${doc.salon.phone}.`);
  if (doc.salon.website) push("website", `Website: ${doc.salon.website}.`);
  if (doc.salon.instagram) push("instagram", `Instagram: ${doc.salon.instagram}.`);
  push("parking", doc.faq.parking);
  push("payment", doc.faq.payment);
  push("cancellation_policy", doc.faq.cancellation);
  push("deposit_policy", doc.faq.deposit);
  // The deposit checkbox on a service is the owner's own statement: say it even
  // when the Answers step has no deposit text.
  const depositServices = doc.services.filter((service) => service.deposit).map((service) => service.name);
  if (depositServices.length && !doc.faq.deposit) {
    push("deposit_required", `A deposit is required to book: ${depositServices.join(", ")}. The salon confirms the amount.`);
  }
  push("late_policy", doc.faq.late);
  doc.faq.custom.forEach((entry, index) => push(`custom_${index + 1}`, entry.q ? `${entry.q} — ${entry.a}` : entry.a));
  if (doc.assistant.forbidden) push("forbidden_topics", `Topics we do not discuss: ${doc.assistant.forbidden}.`);

  return { hours, categories, staff, topics };
}

// ---------------------------------------------------------------------------
// SSRF-safe fetch of a salon's public website, for "import from my site"
// ---------------------------------------------------------------------------

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch (error) {
    throw Object.assign(new Error("That does not look like a web address."), { userFacing: true });
  }
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("Only http and https links work."), { userFacing: true });
  if (url.port && !["80", "443"].includes(url.port)) throw Object.assign(new Error("Only standard web ports are allowed."), { userFacing: true });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw Object.assign(new Error("We could not find that website."), { userFacing: true });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw Object.assign(new Error("That address is not a public website."), { userFacing: true });
  }
  return url;
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------

function createTenancy({ store, auth, llm, clock = () => new Date(), fetchImpl, publicBaseUrl, platformNotify, secret, alertDelayMs } = {}) {
  const db = store.db;
  const http = fetchImpl || ((...args) => fetch(...args));
  const PUBLIC_BASE = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || "https://aibeaty.remolda.com").replace(/\/+$/, "");
  const TG_API = String(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const notifyPlatform = typeof platformNotify === "function" ? platformNotify : () => {};
  let assistant = null;
  const signupAttempts = new Map();
  // Events about one conversation that land within this window become one
  // Telegram message (a booking plus Maya's note about it, a handoff plus its
  // reason). Env override for tests.
  const delayCandidate = Number(alertDelayMs !== undefined ? alertDelayMs : process.env.OWNER_ALERT_DELAY_MS);
  const ALERT_DELAY_MS = Number.isFinite(delayCandidate) && delayCandidate >= 0 ? delayCandidate : 1500;
  const alertQueue = new Map();      // `${slug}|${conversationId}` → { events, timer }
  const lastAttentionAt = new Map(); // `${slug}|${conversationId}` → ms

  // Bot tokens are encrypted with a key derived from the session secret, so a
  // copied database file alone does not hand out the salons' bots.
  const key = crypto.createHash("sha256").update(`aibeaty-tenant-tokens:${secret || ""}`).digest();
  function seal(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
  }
  function unseal(sealed) {
    const [version, iv, tag, body] = String(sealed || "").split(".");
    if (version !== "v1") throw new Error("unknown token format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      salon_slug TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'trial',
      business_type TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      trial_ends_at TEXT NOT NULL,
      setup_json TEXT NOT NULL DEFAULT '{}',
      setup_complete INTEGER NOT NULL DEFAULT 0,
      signup_ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_telegram (
      salon_slug TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL UNIQUE,
      bot_username TEXT NOT NULL,
      token_sealed TEXT NOT NULL,
      webhook_secret TEXT NOT NULL,
      owner_link_code TEXT NOT NULL,
      owner_chat_id TEXT NOT NULL DEFAULT '',
      connected_at TEXT NOT NULL,
      last_update_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS tenant_addon_requests (
      id TEXT PRIMARY KEY,
      salon_slug TEXT NOT NULL,
      addon TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      created_at TEXT NOT NULL
    );
  `);
  // Added after the first self-serve build: an explicit "Go live" press. Until
  // then only the owner (preview) talks to Maya — an AI-imported price list must
  // be looked at by a human before a client hears it.
  if (!db.prepare(`PRAGMA table_info(tenants)`).all().some((column) => column.name === "launched_at")) {
    db.exec(`ALTER TABLE tenants ADD COLUMN launched_at TEXT NOT NULL DEFAULT ''`);
  }
  if (!db.prepare(`PRAGMA table_info(tenants)`).all().some((column) => column.name === "notices_json")) {
    db.exec(`ALTER TABLE tenants ADD COLUMN notices_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // One row per Telegram booking: the evening before the visit, the client
  // gets a reminder in the same chat. Cuts no-shows, needs nothing from the owner.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_reminders (
      salon_slug TEXT NOT NULL,
      appointment_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      sent_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (salon_slug, appointment_id)
    );
  `);

  // Every owner alert that is about one conversation: the owner answers a
  // client by replying to the alert in Telegram, and this map finds the thread.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_alert_messages (
      salon_slug TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (salon_slug, chat_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS tenant_preview_sessions (
      salon_slug TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (salon_slug, session_id)
    );
  `);

  function attachAssistant(instance) {
    assistant = instance;
  }

  function getTenant(slug) {
    const row = db.prepare(`SELECT * FROM tenants WHERE salon_slug = ?`).get(String(slug || ""));
    if (!row) return null;
    let setup = {};
    try {
      setup = JSON.parse(row.setup_json || "{}");
    } catch (error) {
      setup = {};
    }
    const trialEnds = new Date(row.trial_ends_at);
    const msLeft = trialEnds.getTime() - clock().getTime();
    return {
      slug: row.salon_slug,
      plan: row.plan,
      businessType: row.business_type,
      language: row.language,
      trialEndsAt: row.trial_ends_at,
      trialDaysLeft: row.plan === "trial" ? Math.max(0, Math.ceil(msLeft / 86400000)) : null,
      active: row.plan !== "trial" || msLeft > 0,
      setupComplete: Boolean(row.setup_complete),
      launched: Boolean(row.launched_at),
      launchedAt: row.launched_at || "",
      live: Boolean(row.setup_complete) && Boolean(row.launched_at) && (row.plan !== "trial" || msLeft > 0),
      setup: normalizeSetup(setup),
      createdAt: row.created_at
    };
  }

  // ---------- signup ----------
  function signupRateLimited(ip) {
    const now = clock().getTime();
    const recent = (signupAttempts.get(ip) || []).filter((stamp) => now - stamp < SIGNUP_WINDOW_MS);
    signupAttempts.set(ip, recent);
    if (recent.length >= SIGNUP_MAX_PER_IP) return true;
    recent.push(now);
    return false;
  }

  function uniqueSlug(name) {
    const base = slugify(name) || "salon";
    let candidate = base;
    for (let index = 2; RESERVED_SLUGS.has(candidate) || store.salonExists(candidate); index += 1) {
      candidate = `${base}-${index}`;
    }
    return candidate;
  }

  function signup(input, request) {
    const language = input.language === "ru" ? "ru" : "en";
    const say = (en, ru) => (language === "ru" ? ru : en);
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    const salonName = cleanText(input.salonName, 120);
    const timezone = cleanText(input.timezone, 60) || "America/Toronto";
    const businessType = BUSINESS_TYPES.includes(input.businessType) ? input.businessType : "multi";
    const ip = auth.clientIp(request);

    if (signupRateLimited(ip)) {
      return { ok: false, status: 429, error: "rate_limited", message: say("Too many sign-ups from this network. Try again in an hour.", "Слишком много регистраций из этой сети. Попробуйте через час.") };
    }
    const fieldErrors = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.push({ field: "email", message: say("Enter a valid email.", "Введите корректный email.") });
    if (password.length < 10) fieldErrors.push({ field: "password", message: say("Use at least 10 characters.", "Нужно не меньше 10 символов.") });
    if (!salonName) fieldErrors.push({ field: "salonName", message: say("Enter your salon's name.", "Введите название салона.") });
    if (!validTimezone(timezone)) fieldErrors.push({ field: "timezone", message: say("Pick your time zone.", "Выберите часовой пояс.") });
    if (fieldErrors.length) return { ok: false, status: 400, error: "invalid", errors: fieldErrors };
    // createOwner upserts by email; without this check a sign-up would take over
    // an existing account.
    if (auth.getOwnerByEmail(email)) {
      return { ok: false, status: 409, error: "account_exists", errors: [{ field: "email", message: say("This email already has an account. Sign in instead.", "На этот email уже есть аккаунт. Войдите.") }] };
    }

    const slug = uniqueSlug(salonName);
    const setup = emptySetup({ salonName, city: input.city, phone: input.phone, timezone });
    const converted = setupToStore(setup);
    const created = nowIso(clock);
    const trialEnds = new Date(clock().getTime() + TRIAL_DAYS * 86400000).toISOString();

    db.transaction(() => {
      store.createSalon({
        slug,
        name: salonName,
        city: setup.salon.city,
        timezone,
        phone: setup.salon.phone,
        email,
        ownerName: cleanText(input.ownerName, 80),
        ownerContact: email,
        locationLabel: setup.salon.city,
        workspaceLabel: `${salonName} — Salon Workspace`,
        hours: converted.hours,
        closedDates: [],
        faq: { topics: converted.topics },
        faqSource: "db"
      });
      db.prepare(`
        INSERT INTO tenants (salon_slug, plan, business_type, language, trial_ends_at, setup_json, setup_complete, signup_ip, created_at, updated_at)
        VALUES (?, 'trial', ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(slug, businessType, language, trialEnds, JSON.stringify(setup), ip, created, created);
      auth.createOwner({ email, password, salonSlug: slug, displayName: cleanText(input.ownerName, 80) || email });
    })();

    notifyPlatform({
      subject: `New AIbeaty trial: ${salonName}`,
      lines: [`Salon: ${salonName} (${slug})`, `Email: ${email}`, `City: ${setup.salon.city || "—"}`, `Type: ${businessType}`, `Trial ends: ${trialEnds.slice(0, 10)}`]
    });

    const login = auth.login({ email, password, request });
    return { ok: true, status: 201, slug, setCookie: login.setCookie, trialEndsAt: trialEnds };
  }

  // ---------- setup ----------
  function saveSetup(slug, input, { language } = {}) {
    const tenant = getTenant(slug);
    const doc = normalizeSetup(input);
    const lang = language || (tenant && tenant.language) || "en";
    const { errors, warnings } = validateSetup(doc, lang);
    const complete = errors.length === 0;
    const stamp = nowIso(clock);

    if (tenant) {
      // The draft is always kept, so a half-filled wizard survives a reload.
      // An invalid draft also takes the salon out of "complete": the last good
      // catalogue stays in place, but a launched salon is told what broke.
      db.prepare(`UPDATE tenants SET setup_json = ?, setup_complete = ?, updated_at = ? WHERE salon_slug = ?`)
        .run(JSON.stringify(doc), complete ? 1 : (tenant.launched ? 1 : 0), stamp, slug);
    }
    if (!complete) return { ok: false, errors, warnings, setup: doc };

    const converted = setupToStore(doc);
    db.transaction(() => {
      store.createSalon({
        slug,
        name: doc.salon.name,
        city: doc.salon.city,
        timezone: doc.salon.timezone,
        address: doc.salon.address,
        phone: doc.salon.phone,
        website: doc.salon.website,
        locationLabel: doc.salon.city,
        workspaceLabel: `${doc.salon.name} — Salon Workspace`,
        hours: converted.hours,
        faq: { topics: converted.topics },
        faqSource: "db"
      });
      store.forSalon(slug).replaceCatalog({ categories: converted.categories, staff: converted.staff });
      if (tenant) db.prepare(`UPDATE tenants SET setup_complete = 1, updated_at = ? WHERE salon_slug = ?`).run(stamp, slug);
    })();
    if (assistant) assistant.invalidate(slug);
    return { ok: true, errors: [], warnings, setup: doc };
  }

  function launch(slug) {
    const tenant = getTenant(slug);
    if (!tenant) return { ok: false, error: "not_self_serve" };
    const { errors } = validateSetup(tenant.setup, tenant.language);
    if (errors.length || !tenant.setupComplete) return { ok: false, error: "incomplete", errors };
    if (!tenant.launched) {
      db.prepare(`UPDATE tenants SET launched_at = ?, updated_at = ? WHERE salon_slug = ?`).run(nowIso(clock), nowIso(clock), slug);
      const record = store.getSalonRecord(slug) || {};
      notifyPlatform({
        subject: `AIbeaty: ${record.name || slug} went live`,
        lines: [`Salon: ${record.name || slug} (${slug})`, `Services: ${tenant.setup.services.length}`, `Team: ${tenant.setup.staff.length}`, `Owner email: ${record.email || "—"}`]
      });
    }
    return { ok: true, tenant: getTenant(slug) };
  }

  // Reads a price list / website text and drafts services, staff, hours and FAQ.
  // The result is only a DRAFT for the wizard: the owner reviews it before save,
  // because a wrong price quoted to a real client is the worst failure we have.
  async function extractSetup({ text, url }) {
    let source = String(text || "");
    if (url) {
      const pageText = await fetchSiteText(String(url));
      source = `${source}\n\n${pageText}`;
    }
    source = source.trim().slice(0, EXTRACT_MAX_CHARS);
    if (source.length < 20) {
      throw Object.assign(new Error("There is not enough text to read. Paste your price list or a link to your website."), { userFacing: true });
    }
    const prompt = [
      "You read a beauty salon's price list or website text and return JSON only, no prose.",
      "Schema:",
      '{"salon":{"name":"","address":"","phone":"","website":"","instagram":""},',
      ' "hours":{"sun":"closed|HH:MM-HH:MM","mon":"","tue":"","wed":"","thu":"","fri":"","sat":""},',
      ' "services":[{"name":"","category":"","durationMinutes":60,"price":"$65","deposit":false,"keywords":["how clients call it"]}],',
      ' "staff":[{"name":"","role":""}],',
      ' "faq":{"parking":"","payment":"","cancellation":"","deposit":"","late":""}}',
      "Rules: copy prices exactly as written (keep 'from', ranges and currency). Never invent a price, a person or an address:",
      "leave a field empty when the text does not say it. If duration is missing, estimate a typical duration for that service",
      "and it will be reviewed. Keep service names in the language of the text. Hours you cannot find: leave empty string.",
      "deposit is true only for services the text says need a deposit. Copy any deposit rule and amount into faq.deposit,",
      "and cancellation / late rules into faq.cancellation / faq.late, in the text's own words."
    ].join("\n");
    const message = await llm.complete({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: source }
      ],
      temperature: 0.1,
      maxTokens: 4000
    });
    const raw = String(message.content || "");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    let parsed = {};
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch (error) {
      throw Object.assign(new Error("We could not read that text. Try pasting just the price list."), { userFacing: true });
    }
    // Empty hour strings mean "not found", not "closed": drop them so the
    // wizard keeps what the owner already had.
    if (parsed.hours) {
      Object.keys(parsed.hours).forEach((day) => {
        if (!String(parsed.hours[day] || "").trim()) delete parsed.hours[day];
      });
    }
    return {
      salon: parsed.salon || {},
      hours: parsed.hours || {},
      services: normalizeSetup({ services: parsed.services }).services,
      staff: normalizeSetup({ staff: parsed.staff }).staff,
      faq: parsed.faq || {}
    };
  }

  async function fetchSiteText(raw) {
    let url = await assertPublicUrl(raw);
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await http(url.toString(), {
        redirect: "manual",
        headers: { "User-Agent": "AIbeatySetupBot/1.0 (+https://aibeaty.pages.dev)", Accept: "text/html,text/plain" },
        signal: AbortSignal.timeout(12000)
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        url = await assertPublicUrl(new URL(response.headers.get("location"), url).toString());
        continue;
      }
      if (!response.ok) throw Object.assign(new Error(`The website answered with an error (${response.status}).`), { userFacing: true });
      const body = Buffer.from(await response.arrayBuffer()).subarray(0, SITE_MAX_BYTES).toString("utf8");
      return htmlToText(body).slice(0, EXTRACT_MAX_CHARS);
    }
    throw Object.assign(new Error("The website redirects too many times."), { userFacing: true });
  }

  // ---------- plan gate for every client-facing message ----------
  // Used by the web chat and the Telegram webhook alike.
  // preview: the salon's own owner is testing (signed-in web chat, or the
  // owner's linked Telegram chat). They reach Maya before launch.
  async function chat(slug, payload, { preview = false } = {}) {
    const tenant = getTenant(slug);
    if (tenant) {
      const ru = /[а-яёіїє]/i.test(String(payload.message || ""));
      if (!tenant.setupComplete || (!tenant.launched && !preview)) {
        return {
          reply: ru
            ? "Ассистент этого салона ещё настраивается. Пожалуйста, свяжитесь с салоном напрямую."
            : "This salon's assistant is still being set up. Please contact the salon directly for now.",
          state: { reason: "setup_incomplete" }
        };
      }
      if (!tenant.active) {
        return {
          reply: ru
            ? "Онлайн-ассистент салона сейчас на паузе. Пожалуйста, свяжитесь с салоном напрямую."
            : "The salon's online assistant is paused right now. Please contact the salon directly.",
          state: { reason: "trial_ended" }
        };
      }
    }
    if (tenant && preview && payload.sessionId && !/^tg:/.test(String(payload.sessionId))) {
      // The owner's own test chats are tagged in the inbox and in alerts.
      db.prepare(`INSERT OR IGNORE INTO tenant_preview_sessions (salon_slug, session_id, created_at) VALUES (?, ?, ?)`)
        .run(slug, String(payload.sessionId).slice(0, 120), nowIso(clock));
    }
    return assistant.chat(Object.assign({}, payload, { salon: slug }));
  }

  // ---------- hooks for createAssistant ----------
  const hooks = {
    dailyTurnsCapFor(salonId) {
      const tenant = getTenant(salonId);
      return tenant && tenant.plan === "trial" ? TRIAL_TURNS_CAP : undefined;
    },
    // Self-serve salons never mail our inbox about their clients: their owner
    // hears about it in their own Telegram. Legacy salons keep ALERT_EMAIL.
    alertEmailFor(salonId) {
      return getTenant(salonId) ? "" : String(process.env.ALERT_EMAIL || "");
    },
    onEvent(salonId, type, payload) {
      trackReminder(salonId, type, payload);
      queueOwnerAlert(salonId, type, payload);
    }
  };

  // ---------- client reminders ----------
  function trackReminder(salonId, type, payload) {
    if (!payload.appointmentId) return;
    if (type === "cancellation") {
      db.prepare(`DELETE FROM tenant_reminders WHERE salon_slug = ? AND appointment_id = ?`).run(salonId, payload.appointmentId);
      return;
    }
    if (type !== "booking" && type !== "reschedule") return;
    const match = /^tg:\d+:(-?\d+)$/.exec(String(payload.sessionId || ""));
    if (type === "booking" && !match) return;
    if (type === "booking") {
      db.prepare(`
        INSERT INTO tenant_reminders (salon_slug, appointment_id, chat_id, language, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(salon_slug, appointment_id) DO NOTHING
      `).run(salonId, payload.appointmentId, match[1], String(payload.language || ""), nowIso(clock));
    } else {
      // A moved visit deserves a fresh reminder for its new day.
      db.prepare(`UPDATE tenant_reminders SET status = 'pending', sent_at = '' WHERE salon_slug = ? AND appointment_id = ?`).run(salonId, payload.appointmentId);
    }
  }

  function localParts(timezone, date = clock()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function addDaysIso(isoDate, days) {
    const date = new Date(`${isoDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function clockLabel(minutes) {
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  }

  // Reminder window: the evening before, from 17:00 to 21:00 salon time.
  const REMINDER_FROM = 17 * 60;
  const REMINDER_UNTIL = 21 * 60;

  async function sendDueReminders() {
    const rows = db.prepare(`
      SELECT r.*, t.bot_id, t.token_sealed, t.bot_username
      FROM tenant_reminders r JOIN tenant_telegram t ON t.salon_slug = r.salon_slug
      WHERE r.status = 'pending'
    `).all();
    let sent = 0;
    for (const row of rows) {
      store.syncDayAnchor(row.salon_slug);
      const record = store.getSalonRecord(row.salon_slug) || {};
      const appointment = db.prepare(`
        SELECT
          -- appt_date is only refreshed when the day rolls over; a booking made
          -- today has it empty, so derive the date from the anchor + offset.
          date((SELECT value FROM metadata m WHERE m.salon_id = a.salon_id AND m.key = 'day_anchor'), printf('%+d days', a.day_offset)) AS appt_date,
          a.start_minutes, a.service_name, a.appointment_status, s.name AS stylist
        FROM appointments a LEFT JOIN stylists s ON s.salon_id = a.salon_id AND s.id = a.stylist_id
        WHERE a.salon_id = ? AND a.id = ?
      `).get(row.salon_slug, row.appointment_id);
      if (!appointment || appointment.appointment_status !== "scheduled") {
        db.prepare(`UPDATE tenant_reminders SET status = 'dropped' WHERE salon_slug = ? AND appointment_id = ?`).run(row.salon_slug, row.appointment_id);
        continue;
      }
      const now = localParts(record.timezone);
      const tomorrow = addDaysIso(now.date, 1);
      if (appointment.appt_date && appointment.appt_date <= now.date) {
        // Booked for today (or already past): a reminder now would be noise.
        db.prepare(`UPDATE tenant_reminders SET status = 'skipped' WHERE salon_slug = ? AND appointment_id = ?`).run(row.salon_slug, row.appointment_id);
        continue;
      }
      if (appointment.appt_date !== tomorrow || now.minutes < REMINDER_FROM || now.minutes >= REMINDER_UNTIL) continue;
      const ru = /^(ru|uk)/.test(row.language);
      const time = clockLabel(appointment.start_minutes);
      const text = ru
        ? `Напоминаем: завтра в ${time} — ${appointment.service_name}${appointment.stylist ? `, мастер ${appointment.stylist}` : ""}, салон «${record.name}».${record.address ? ` Адрес: ${record.address}.` : ""} Если планы изменились, напишите сюда: перенесём или отменим.`
        : `Reminder: tomorrow at ${time} — ${appointment.service_name}${appointment.stylist ? ` with ${appointment.stylist}` : ""} at ${record.name}.${record.address ? ` Address: ${record.address}.` : ""} If your plans changed, reply here and we'll reschedule or cancel.`;
      try {
        await sendTelegram(row, row.chat_id, text);
        db.prepare(`UPDATE tenant_reminders SET status = 'sent', sent_at = ? WHERE salon_slug = ? AND appointment_id = ?`).run(nowIso(clock), row.salon_slug, row.appointment_id);
        sent += 1;
      } catch (error) {
        console.error(`[tenancy] reminder failed for ${row.salon_slug}: ${String(error.message).slice(0, 140)}`);
      }
    }
    return sent;
  }

  // ---------- trial notices to the owner ----------
  function sendTrialNotices() {
    const rows = db.prepare(`SELECT salon_slug, notices_json FROM tenants WHERE plan = 'trial'`).all();
    let sent = 0;
    rows.forEach((row) => {
      const tenant = getTenant(row.salon_slug);
      if (!tenant) return;
      let notices = {};
      try { notices = JSON.parse(row.notices_json || "{}"); } catch (error) { notices = {}; }
      const ru = tenant.language === "ru";
      const planLink = `${PUBLIC_BASE}/screens/setup.html#7`;
      let key = "";
      let text = "";
      if (!tenant.active && !notices.ended) {
        key = "ended";
        text = ru
          ? `Пробный период закончился, и Майя поставлена на паузу для клиентов. Чтобы продолжить, нажмите «Оставить ассистента» здесь: ${planLink}`
          : `Your trial has ended and Maya is paused for clients. To keep her, press "Keep the assistant" here: ${planLink}`;
        const record = store.getSalonRecord(row.salon_slug) || {};
        notifyPlatform({ subject: `AIbeaty trial ended: ${record.name || row.salon_slug}`, lines: [`Salon: ${record.name || row.salon_slug}`, `Owner email: ${record.email || "—"}`, `Launched: ${tenant.launched ? "yes" : "no"}`] });
      } else if (tenant.active && tenant.trialDaysLeft <= 3 && !notices.d3) {
        key = "d3";
        text = ru
          ? `Пробный период закончится через ${tenant.trialDaysLeft} дн. Чтобы Майя продолжала отвечать клиентам без перерыва, нажмите «Оставить ассистента»: ${planLink}`
          : `Your trial ends in ${tenant.trialDaysLeft} day(s). To keep Maya answering clients without a gap, press "Keep the assistant": ${planLink}`;
      }
      if (!key) return;
      notices[key] = nowIso(clock);
      db.prepare(`UPDATE tenants SET notices_json = ? WHERE salon_slug = ?`).run(JSON.stringify(notices), row.salon_slug);
      notifyOwner(row.salon_slug, text);
      sent += 1;
    });
    return sent;
  }

  let ticker = null;
  function startTicker(intervalMs = 10 * 60 * 1000) {
    if (ticker) return;
    const tick = () => {
      Promise.resolve()
        .then(() => sendTrialNotices())
        .then(() => sendDueReminders())
        .catch((error) => console.error(`[tenancy] tick failed: ${String(error.message).slice(0, 160)}`));
    };
    ticker = setInterval(tick, intervalMs);
    ticker.unref();
    setTimeout(tick, 5000).unref();
  }

  // ---------- owner alerts ----------
  const ALERT_TYPES = new Set(["booking", "reschedule", "cancellation", "escalation", "owner_message", "usage_alert"]);

  function queueOwnerAlert(salonId, type, payload = {}) {
    if (!ALERT_TYPES.has(type)) return;
    if (!getTenant(salonId)) return;
    const key = `${salonId}|${payload.conversationId || "_"}`;
    let entry = alertQueue.get(key);
    if (!entry) {
      entry = { slug: salonId, conversationId: payload.conversationId || "", events: [], timer: null };
      alertQueue.set(key, entry);
    }
    entry.events.push({ type, payload });
    if (entry.timer) return;
    const flush = () => {
      alertQueue.delete(key);
      entry.timer = null;
      const text = composeOwnerAlert(entry.slug, entry.conversationId, entry.events);
      if (text) notifyOwner(entry.slug, text, { conversationId: entry.conversationId });
    };
    if (ALERT_DELAY_MS === 0) {
      entry.timer = true;
      Promise.resolve().then(flush);
      return;
    }
    entry.timer = setTimeout(flush, ALERT_DELAY_MS);
    if (entry.timer.unref) entry.timer.unref();
  }

  // Sends everything still waiting in the alert queue now (tests, shutdown).
  function flushOwnerAlerts() {
    [...alertQueue.entries()].forEach(([key, entry]) => {
      if (entry.timer && entry.timer !== true) clearTimeout(entry.timer);
      alertQueue.delete(key);
      const text = composeOwnerAlert(entry.slug, entry.conversationId, entry.events);
      if (text) notifyOwner(entry.slug, text, { conversationId: entry.conversationId });
    });
  }

  function conversationFacts(slug, conversationId) {
    if (!conversationId) return null;
    const row = db.prepare(`SELECT id, name, contact_phone, assistant_session_id FROM conversations WHERE salon_id = ? AND id = ?`).get(slug, conversationId);
    if (!row) return null;
    const session = row.assistant_session_id
      ? db.prepare(`SELECT client_phone FROM assistant_sessions WHERE salon_id = ? AND id = ?`).get(slug, row.assistant_session_id)
      : null;
    const lastIncoming = db.prepare(`
      SELECT text_value FROM conversation_messages WHERE salon_id = ? AND conversation_id = ? AND type = 'incoming'
      ORDER BY sort_order DESC LIMIT 1
    `).get(slug, conversationId);
    const preview = row.assistant_session_id
      ? Boolean(db.prepare(`SELECT 1 FROM tenant_preview_sessions WHERE salon_slug = ? AND session_id = ?`).get(slug, row.assistant_session_id))
      : false;
    return {
      name: row.name,
      phone: realPhone(row.contact_phone) || realPhone(session && session.client_phone),
      sessionId: row.assistant_session_id || "",
      telegram: /^tg:/.test(row.assistant_session_id || ""),
      lastIncoming: lastIncoming ? String(lastIncoming.text_value) : "",
      preview
    };
  }

  function quote(text, max = 280) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
  }

  function composeOwnerAlert(slug, conversationId, events) {
    const tenant = getTenant(slug);
    if (!tenant) return "";
    const lang = ownerLang(tenant);
    const t = ALERT_TEXT[lang];
    const medspa = isMedspa(tenant);
    const facts = conversationFacts(slug, conversationId);
    const key = `${slug}|${conversationId || "_"}`;

    const nameFor = (payload) => {
      const raw = [payload.client, facts && facts.name].find((value) => value && !GENERIC_NAME_RE.test(String(value))) ||
        (facts && facts.name) || payload.client || "";
      return raw && GENERIC_NAME_RE.test(raw) ? localGenericName(raw, lang) : (raw || localGenericName("", lang));
    };
    const who = (payload) => [nameFor(payload), realPhone(payload.phone) || (facts && facts.phone) || ""].filter(Boolean).join(" · ");
    const when = (date, minutes, fallbackDay, fallbackTime) => {
      const day = formatAlertDate(date, lang) || fallbackDay || "";
      const time = formatAlertTime(minutes, lang) || fallbackTime || "";
      return [day, time].filter(Boolean).join(", ");
    };

    const blocks = [];
    let attention = null;
    events.forEach(({ type, payload }) => {
      if (type === "booking") {
        blocks.push([
          t.booking,
          who(payload),
          [payload.service, payload.stylist ? t.with(payload.stylist) : ""].filter(Boolean).join(" "),
          when(payload.date, payload.startMinutes, payload.day, payload.time)
        ].filter(Boolean).join("\n"));
      } else if (type === "reschedule") {
        const from = when(payload.fromDate, payload.fromStartMinutes, "", "");
        const to = when(payload.date, payload.startMinutes, payload.day, payload.time);
        blocks.push([
          t.reschedule,
          who(payload),
          [payload.service, payload.stylist ? t.with(payload.stylist) : ""].filter(Boolean).join(" "),
          from ? `${from} → ${to}` : `→ ${to}`
        ].filter(Boolean).join("\n"));
      } else if (type === "cancellation") {
        blocks.push([
          t.cancellation,
          who(payload),
          [payload.service, when(payload.date, payload.startMinutes, "", "")].filter(Boolean).join(", ")
        ].filter(Boolean).join("\n"));
      } else if (type === "usage_alert") {
        blocks.push(t.usage(Number(payload.threshold) || 0, payload.turns, payload.cap));
      } else if (type === "escalation" || type === "owner_message") {
        // One attention block per alert; a handoff beats a note about the same turn.
        if (!attention || (attention.type === "owner_message" && type === "escalation")) attention = { type, payload };
      }
    });

    if (attention) {
      const now = clock().getTime();
      const last = lastAttentionAt.get(key) || 0;
      if (conversationId && now - last < ATTENTION_QUIET_MS) {
        attention = null;
      } else {
        lastAttentionAt.set(key, now);
      }
    }
    if (attention) {
      const { type, payload } = attention;
      const name = nameFor(payload);
      const reason = type === "escalation"
        ? (t.reasons[payload.reason] || t.reasons.assistant_requested)
        : (t.topics[payload.topic] || t.reasons.owner_message);
      // The client's own words, never Maya's internal note (that one is ours and
      // in whatever language the prompt was written in).
      const clientText = (type === "escalation" ? String(payload.summary || "").split(" | ")[0] : "") || (facts && facts.lastIncoming) || "";
      let body = "";
      const medical = type === "escalation" && payload.reason === "medical";
      // Medspa / clinic: health details stay inside the conversation, never in
      // a Telegram notification that may show up on a lock screen.
      if (medspa) body = medical ? t.medicalHidden : t.textHidden;
      else if (clientText) body = `${t.said}${t.colon || ": "}${quote(clientText)}`;
      blocks.unshift([
        type === "escalation" ? t.escalation(name) : t.ownerMessage(name),
        who(payload) !== name ? who(payload) : "",
        medspa && medical ? "" : reason,
        body
      ].filter(Boolean).join("\n"));
    }
    if (!blocks.length) return "";

    const footer = [];
    if (conversationId && facts) {
      const name = nameFor(events[0].payload);
      if (facts.sessionId) footer.push(facts.telegram ? t.replyHint(name) : t.webHint(name));
      footer.push(`${t.open}${t.colon || ": "}${PUBLIC_BASE}/screens/unified-inbox-luminous-core.html?conversationId=${encodeURIComponent(conversationId)}`);
    }
    const head = facts && facts.preview ? `[${t.test}] ` : "";
    return `${head}${blocks.join("\n\n")}${footer.length ? `\n\n${footer.join("\n")}` : ""}`;
  }

  // ---------- Telegram ----------
  async function tg(token, method, body) {
    const response = await http(`${TG_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!data.ok) {
      const error = new Error(`telegram ${method}: ${String(data.description || response.status).slice(0, 160)}`);
      error.telegram = data;
      throw error;
    }
    return data.result;
  }

  function getTelegram(slug) {
    return db.prepare(`SELECT * FROM tenant_telegram WHERE salon_slug = ?`).get(slug) || null;
  }

  function telegramStatus(slug) {
    const row = getTelegram(slug);
    if (!row) return { connected: false };
    return {
      connected: true,
      username: row.bot_username,
      botLink: `https://t.me/${row.bot_username}`,
      ownerLinked: Boolean(row.owner_chat_id),
      ownerLink: `https://t.me/${row.bot_username}?start=owner-${row.owner_link_code}`,
      connectedAt: row.connected_at,
      lastUpdateAt: row.last_update_at
    };
  }

  async function connectTelegram(slug, rawToken, { language = "en" } = {}) {
    const say = (en, ru) => (language === "ru" ? ru : en);
    const token = String(rawToken || "").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return { ok: false, message: say("That is not a bot token. It looks like 123456789:AA… and comes from @BotFather.", "Это не токен бота. Он выглядит как 123456789:AA… и приходит от @BotFather.") };
    }
    let me;
    try {
      me = await tg(token, "getMe");
    } catch (error) {
      return { ok: false, message: say("Telegram did not accept this token. Copy it again from @BotFather.", "Telegram не принял этот токен. Скопируйте его ещё раз из @BotFather.") };
    }
    const botId = String(me.id);
    const taken = db.prepare(`SELECT salon_slug FROM tenant_telegram WHERE bot_id = ?`).get(botId);
    if (taken && taken.salon_slug !== slug) {
      return { ok: false, message: say("This bot is already connected to another salon. Create a new bot in @BotFather.", "Этот бот уже подключён к другому салону. Создайте нового бота в @BotFather.") };
    }
    const previous = getTelegram(slug);
    const webhookSecret = crypto.randomBytes(24).toString("hex");
    const ownerCode = (previous && previous.owner_link_code) || crypto.randomBytes(8).toString("hex");
    try {
      await tg(token, "setWebhook", {
        url: `${PUBLIC_BASE}/api/telegram/hook/${botId}`,
        secret_token: webhookSecret,
        allowed_updates: ["message"],
        drop_pending_updates: true
      });
    } catch (error) {
      return { ok: false, message: say("Telegram refused to connect the bot. Try again in a minute.", "Telegram не дал подключить бота. Попробуйте через минуту.") };
    }
    if (previous && previous.bot_id !== botId) {
      // A different bot replaces the old one: stop the old one from calling us.
      tg(unseal(previous.token_sealed), "deleteWebhook", {}).catch(() => {});
    }
    const stamp = nowIso(clock);
    db.prepare(`
      INSERT INTO tenant_telegram (salon_slug, bot_id, bot_username, token_sealed, webhook_secret, owner_link_code, owner_chat_id, connected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(salon_slug) DO UPDATE SET
        bot_id = excluded.bot_id, bot_username = excluded.bot_username, token_sealed = excluded.token_sealed,
        webhook_secret = excluded.webhook_secret, owner_link_code = excluded.owner_link_code,
        owner_chat_id = CASE WHEN tenant_telegram.bot_id = excluded.bot_id THEN tenant_telegram.owner_chat_id ELSE '' END,
        connected_at = excluded.connected_at
    `).run(slug, botId, me.username, seal(token), webhookSecret, ownerCode, "", stamp);
    const record = store.getSalonRecord(slug) || {};
    tg(token, "setMyDescription", {
      description: `${record.name || "Salon"} — book, reschedule or ask about prices any time. AI assistant; a human is one message away.`
    }).catch(() => {});
    tg(token, "setMyShortDescription", { short_description: `${record.name || "Salon"}: bookings and questions 24/7` }).catch(() => {});
    notifyPlatform({ subject: `AIbeaty: ${record.name || slug} connected Telegram`, lines: [`Bot: @${me.username}`, `Salon: ${slug}`] });
    return Object.assign({ ok: true }, telegramStatus(slug));
  }

  async function disconnectTelegram(slug) {
    const row = getTelegram(slug);
    if (!row) return { ok: true };
    try {
      await tg(unseal(row.token_sealed), "deleteWebhook", {});
    } catch (error) {
      // The row goes anyway: an orphaned webhook just gets 404s from us.
    }
    db.prepare(`DELETE FROM tenant_telegram WHERE salon_slug = ?`).run(slug);
    return { ok: true };
  }

  function sendTelegram(row, chatId, text, extra = {}) {
    const chunks = [];
    for (let start = 0; start < text.length; start += TG_MAX_MESSAGE) chunks.push(text.slice(start, start + TG_MAX_MESSAGE));
    const token = unseal(row.token_sealed);
    return chunks.reduce(
      (chain, chunk, index) => chain.then(() => tg(token, "sendMessage", Object.assign({ chat_id: chatId, text: chunk, disable_web_page_preview: true }, index === chunks.length - 1 ? extra : {}))),
      Promise.resolve()
    );
  }

  // Returns the send promise (tests await it); failures are only logged.
  function notifyOwner(slug, text, { conversationId } = {}) {
    const row = getTelegram(slug);
    if (!row || !row.owner_chat_id) return Promise.resolve(null);
    return sendTelegram(row, row.owner_chat_id, text).then((sent) => {
      if (conversationId && sent && sent.message_id !== undefined) {
        db.prepare(`
          INSERT OR REPLACE INTO tenant_alert_messages (salon_slug, chat_id, message_id, conversation_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(slug, String(row.owner_chat_id), String(sent.message_id), conversationId, nowIso(clock));
      }
      return sent;
    }).catch((error) => {
      console.error(`[tenancy] owner notify failed for ${slug}: ${String(error.message).slice(0, 140)}`);
      return null;
    });
  }

  function greetingFor(slug, languageCode) {
    const record = store.getSalonRecord(slug) || {};
    const name = record.name || "the salon";
    if (/^(ru|uk|be)/.test(String(languageCode || ""))) {
      return `Здравствуйте! Я Майя, ИИ-ассистент салона «${name}». Могу записать вас, перенести или отменить визит и ответить на вопросы о ценах и услугах. Если нужен живой человек, просто напишите «позвать человека».`;
    }
    return `Hi! I'm Maya, the AI assistant at ${name}. I can book, reschedule or cancel a visit and answer questions about prices and services. If you'd rather talk to a person, just write "human".`;
  }

  // Webhook entry point. Returns an HTTP status right away; the conversation
  // runs after the response so Telegram never waits on the LLM.
  function handleTelegramUpdate(botId, secretHeader, update) {
    const row = db.prepare(`SELECT * FROM tenant_telegram WHERE bot_id = ?`).get(String(botId || ""));
    if (!row) return { status: 404 };
    const expected = Buffer.from(row.webhook_secret);
    const got = Buffer.from(String(secretHeader || ""));
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return { status: 403 };
    const message = update && update.message;
    if (!message || !message.chat || message.chat.type !== "private") return { status: 200 };
    db.prepare(`UPDATE tenant_telegram SET last_update_at = ? WHERE salon_slug = ?`).run(nowIso(clock), row.salon_slug);
    const work = processTelegramMessage(row, message).catch((error) => {
      console.error(`[tenancy] telegram message failed for ${row.salon_slug}: ${String(error.message).slice(0, 160)}`);
    });
    return { status: 200, work };
  }

  function ownerLinks(slug) {
    return {
      inbox: `${PUBLIC_BASE}/screens/unified-inbox-luminous-core.html`,
      chat: `${PUBLIC_BASE}/screens/chat.html?salon=${encodeURIComponent(slug)}`
    };
  }

  function ownerChatText(slug) {
    return OWNER_CHAT_TEXT[ownerLang(getTenant(slug))];
  }

  // The owner's linked chat is never a client: Maya does not answer it. A
  // reply to an alert goes to that alert's client; anything else gets help.
  async function handleOwnerMessage(row, message) {
    const chatId = String(message.chat.id);
    const t = ownerChatText(row.salon_slug);
    const links = ownerLinks(row.salon_slug);
    const replyTo = message.reply_to_message;
    const text = String(message.text || "").trim();
    if (!replyTo) {
      await sendTelegram(row, chatId, t.help(links.inbox, links.chat));
      return { action: "help" };
    }
    const mapped = db.prepare(`
      SELECT conversation_id FROM tenant_alert_messages WHERE salon_slug = ? AND chat_id = ? AND message_id = ?
    `).get(row.salon_slug, chatId, String(replyTo.message_id));
    if (!mapped) {
      await sendTelegram(row, chatId, t.unknownAlert(links.inbox));
      return { action: "unknown_alert" };
    }
    if (!text) {
      await sendTelegram(row, chatId, t.textOnly);
      return { action: "text_only" };
    }
    const result = await sendStaffReply(row.salon_slug, mapped.conversation_id, text.slice(0, 4000), { via: "telegram_owner" });
    const lang = ownerLang(getTenant(row.salon_slug));
    const name = result.name && GENERIC_NAME_RE.test(result.name) ? localGenericName(result.name, lang) : (result.name || "");
    const confirmation = result.delivery === "delivered" ? t.sent(name)
      : result.delivery === "waiting" ? t.waiting(name)
        : t.failed(name, `${links.inbox}?conversationId=${encodeURIComponent(mapped.conversation_id)}`);
    await sendTelegram(row, chatId, confirmation, { reply_to_message_id: message.message_id });
    return { action: "forwarded", delivery: result.delivery };
  }

  // A staff member's answer to a client: stored in the thread (author 'staff'),
  // Maya steps back (takeover), and the text goes to wherever the client is.
  //   Telegram client → sent through the salon's bot now: 'delivered' / 'failed'
  //   web chat client → 'waiting' until their chat page fetches it ('seen')
  //   no live channel (seeded / manual threads) → '' (nothing to deliver)
  // existingMessageId: the inbox route already stored the message.
  async function sendStaffReply(slug, conversationId, text, { existingMessageId, via = "inbox" } = {}) {
    const scope = store.forSalon(slug);
    if (!scope) return { ok: false, error: "unknown_salon" };
    const conversation = db.prepare(`SELECT id, name, assistant_session_id FROM conversations WHERE salon_id = ? AND id = ?`).get(slug, conversationId);
    if (!conversation) return { ok: false, error: "not_found" };
    const body = String(text || "").trim();
    if (!body) return { ok: false, error: "empty" };
    const sessionId = conversation.assistant_session_id || "";
    const tgMatch = /^tg:(\d+):(-?\d+)$/.exec(sessionId);
    let messageId = existingMessageId;
    if (!messageId) {
      messageId = `message-staff-${crypto.randomBytes(6).toString("hex")}`;
      scope.createConversationMessage(conversationId, { text: body, type: "outgoing", author: "staff", id: messageId, delivery: sessionId ? (tgMatch ? "sending" : "waiting") : "" });
    }
    if (assistant && typeof assistant.noteStaffMessage === "function") assistant.noteStaffMessage(conversationId, slug);

    let delivery = "";
    let note = "";
    if (tgMatch) {
      const row = getTelegram(slug);
      if (!row || row.bot_id !== tgMatch[1]) {
        delivery = "failed";
        note = "telegram_not_connected";
      } else {
        try {
          await sendTelegram(row, tgMatch[2], body);
          delivery = "delivered";
        } catch (error) {
          delivery = "failed";
          note = String((error.telegram && error.telegram.description) || error.message || "").slice(0, 160);
          console.error(`[tenancy] staff reply failed for ${slug}: ${note}`);
        }
      }
    } else if (sessionId) {
      delivery = "waiting";
    }
    scope.setMessageDelivery(messageId, delivery, note);
    return { ok: true, messageId, delivery, note, name: conversation.name, channel: tgMatch ? "telegram" : (sessionId ? "web" : "") };
  }

  // The web chat asks for staff answers it has not shown yet. The session id
  // is the chat's own random id (web-<uuid>); Telegram ids are refused, they
  // are guessable and those clients get their answers in Telegram anyway.
  function webUpdates(slug, sessionId, after) {
    const id = String(sessionId || "");
    if (!id || /^tg:/.test(id) || id.length > 120) return { messages: [] };
    const session = db.prepare(`SELECT conversation_id FROM assistant_sessions WHERE salon_id = ? AND id = ?`).get(String(slug || ""), id);
    if (!session) return { messages: [] };
    const since = /^\d{4}-\d{2}-\d{2}T/.test(String(after || "")) ? String(after) : "";
    const rows = db.prepare(`
      SELECT id, text_value, created_at, delivery FROM conversation_messages
      WHERE salon_id = ? AND conversation_id = ? AND author = 'staff' AND created_at > ?
      ORDER BY sort_order ASC LIMIT 50
    `).all(slug, session.conversation_id, since);
    const seen = rows.filter((row) => row.delivery === "waiting");
    if (seen.length) {
      const mark = db.prepare(`UPDATE conversation_messages SET delivery = 'seen' WHERE salon_id = ? AND id = ?`);
      db.transaction(() => seen.forEach((row) => mark.run(slug, row.id)))();
    }
    return { messages: rows.map((row) => ({ id: row.id, text: row.text_value, createdAt: row.created_at })) };
  }

  // The owner's inbox for a self-serve salon: only this salon's real threads,
  // no demo fixtures. Channel and test-chat flags come from the session id.
  function inboxView(slug) {
    const scope = store.forSalon(slug);
    if (!scope) return null;
    const tenant = getTenant(slug);
    const record = store.getSalonRecord(slug) || {};
    const previewIds = new Set(db.prepare(`SELECT session_id FROM tenant_preview_sessions WHERE salon_slug = ?`).all(slug).map((row) => row.session_id));
    const rows = db.prepare(`
      SELECT id, name, channel, contact_phone, assistant_session_id, assistant_state, updated_at, created_at
      FROM conversations WHERE salon_id = ? ORDER BY updated_at DESC
    `).all(slug);
    const phoneOf = db.prepare(`SELECT client_phone FROM assistant_sessions WHERE salon_id = ? AND id = ?`);
    const conversations = rows.map((row) => {
      const sessionId = row.assistant_session_id || "";
      const messages = scope.getConversationMessages(row.id).map((message) => ({
        id: message.id,
        type: message.type,
        author: message.author || (message.type === "incoming" ? "client" : message.type === "system" ? "" : "maya"),
        text: message.text,
        delivery: message.delivery,
        deliveryNote: message.deliveryNote,
        createdAt: message.createdAt
      }));
      const last = [...messages].reverse().find((message) => message.type !== "system") || messages[messages.length - 1];
      const session = sessionId ? phoneOf.get(slug, sessionId) : null;
      return {
        id: row.id,
        name: row.name,
        generic: GENERIC_NAME_RE.test(row.name),
        kind: /^tg:/.test(sessionId) ? "telegram" : sessionId ? "web" : "other",
        test: previewIds.has(sessionId),
        phone: realPhone(row.contact_phone) || realPhone(session && session.client_phone),
        state: row.assistant_state === "escalated" ? "needs_human" : row.assistant_state === "takeover" ? "takeover" : "maya",
        preview: last ? String(last.text).slice(0, 140) : "",
        lastAuthor: last ? last.author : "",
        updatedAt: row.updated_at,
        messages
      };
    });
    // Clients first; the owner's own test chats sink to the bottom.
    conversations.sort((a, b) => Number(a.test) - Number(b.test));
    return {
      salon: { slug, name: record.name || slug, city: record.city || "", timezone: record.timezone || "America/Toronto" },
      selfServe: Boolean(tenant),
      language: ownerLang(tenant),
      businessType: tenant ? tenant.businessType : "",
      telegram: telegramStatus(slug).connected ? { connected: true, ownerLinked: telegramStatus(slug).ownerLinked } : { connected: false },
      chatUrl: `/screens/chat.html?salon=${encodeURIComponent(slug)}`,
      conversations
    };
  }

  // A Telegram client's own name replaces the "Telegram client 1a2b" placeholder.
  function nameTelegramConversation(slug, sessionId, from) {
    const name = cleanText([from && from.first_name, from && from.last_name].filter(Boolean).join(" "), 60);
    if (!name) return;
    const row = db.prepare(`SELECT id, name, client_id FROM conversations WHERE salon_id = ? AND assistant_session_id = ?`).get(slug, sessionId);
    if (!row || !GENERIC_NAME_RE.test(row.name)) return;
    db.transaction(() => {
      db.prepare(`UPDATE conversations SET name = ?, avatar_text = ? WHERE salon_id = ? AND id = ?`)
        .run(name, name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(), slug, row.id);
      // The thread's implicit client record carries the same placeholder name.
      if (row.client_id) {
        const client = db.prepare(`SELECT name FROM clients WHERE salon_id = ? AND id = ?`).get(slug, row.client_id);
        if (client && GENERIC_NAME_RE.test(client.name)) {
          db.prepare(`UPDATE clients SET name = ? WHERE salon_id = ? AND id = ?`).run(name, slug, row.client_id);
        }
      }
    })();
  }

  async function processTelegramMessage(row, message) {
    const chatId = String(message.chat.id);
    const text = String(message.text || "").trim();
    const languageCode = message.from && message.from.language_code;
    const ru = /^(ru|uk|be)/.test(String(languageCode || ""));
    const isOwnerChat = Boolean(row.owner_chat_id) && row.owner_chat_id === chatId;

    const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
    if (startMatch && startMatch[1] === `owner-${row.owner_link_code}`) {
      db.prepare(`UPDATE tenant_telegram SET owner_chat_id = ? WHERE salon_slug = ?`).run(chatId, row.salon_slug);
      await sendTelegram(row, chatId, ownerChatText(row.salon_slug).linked(ownerLinks(row.salon_slug).chat));
      return;
    }
    if (isOwnerChat) {
      await handleOwnerMessage(row, message);
      return;
    }
    if (startMatch) {
      await sendTelegram(row, chatId, greetingFor(row.salon_slug, languageCode), {
        reply_markup: { keyboard: [[{ text: ru ? "📱 Поделиться номером" : "📱 Share my number", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
      });
      return;
    }

    let clientPhone = "";
    let body = text;
    if (message.contact && message.contact.phone_number) {
      clientPhone = String(message.contact.phone_number);
      body = ru ? `Мой номер телефона: ${clientPhone}` : `My phone number is ${clientPhone}`;
    }
    if (!body) {
      await sendTelegram(row, chatId, ru ? "Пока я читаю только текст. Напишите, пожалуйста, сообщением." : "I can only read text for now. Please type your message.");
      return;
    }

    const sessionId = `tg:${row.bot_id}:${chatId}`;
    nameTelegramConversation(row.salon_slug, sessionId, message.from);
    const tokenForTyping = unseal(row.token_sealed);
    tg(tokenForTyping, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const typing = setInterval(() => tg(tokenForTyping, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4500);
    let result;
    try {
      result = await chat(row.salon_slug, {
        sessionId,
        message: body.slice(0, 2000),
        channel: "telegram",
        clientPhone
      });
    } finally {
      clearInterval(typing);
    }
    nameTelegramConversation(row.salon_slug, sessionId, message.from);
    if (result && result.reply) {
      await sendTelegram(row, chatId, String(result.reply), { reply_markup: { remove_keyboard: true } });
    } else if (result && result.error === "rate_limited") {
      await sendTelegram(row, chatId, ru ? "Слишком быстро 🙂 Подождите минутку." : "That was fast 🙂 Give me a minute.");
    }
  }

  // ---------- add-ons ----------
  function listAddons(slug, language = "en") {
    const requested = new Map(
      db.prepare(`SELECT addon, status, created_at FROM tenant_addon_requests WHERE salon_slug = ? ORDER BY created_at`).all(slug)
        .map((row) => [row.addon, row])
    );
    const telegram = getTelegram(slug);
    return ADDONS.map((addon) => {
      let status = requested.has(addon.key) ? requested.get(addon.key).status : "available";
      if (addon.key === "telegram" && telegram) status = "active";
      if (addon.key === "owner_alerts" && telegram && telegram.owner_chat_id) status = "active";
      if (addon.key === "website_widget") status = "active";
      return { key: addon.key, auto: addon.auto, title: addon.title[language] || addon.title.en, status };
    });
  }

  function requestAddon(slug, addonKey, note) {
    const addon = ADDONS.find((entry) => entry.key === addonKey);
    if (!addon || addon.auto) return { ok: false, error: "unknown_addon" };
    const existing = db.prepare(`SELECT id FROM tenant_addon_requests WHERE salon_slug = ? AND addon = ?`).get(slug, addonKey);
    if (!existing) {
      db.prepare(`INSERT INTO tenant_addon_requests (id, salon_slug, addon, note, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(`addon-${crypto.randomBytes(6).toString("hex")}`, slug, addonKey, cleanText(note, 1000), nowIso(clock));
    }
    const record = store.getSalonRecord(slug) || {};
    notifyPlatform({
      subject: `AIbeaty add-on request: ${addon.title.en} — ${record.name || slug}`,
      lines: [`Salon: ${record.name || slug} (${slug})`, `Owner email: ${record.email || "—"}`, `Add-on: ${addon.title.en}`, `Note: ${cleanText(note, 1000) || "—"}`]
    });
    return { ok: true };
  }

  return {
    hooks,
    attachAssistant,
    getTenant,
    signup,
    saveSetup,
    launch,
    publicBase: PUBLIC_BASE,
    extractSetup,
    chat,
    telegramStatus,
    connectTelegram,
    disconnectTelegram,
    handleTelegramUpdate,
    sendStaffReply,
    webUpdates,
    inboxView,
    flushOwnerAlerts,
    listAddons,
    requestAddon,
    sendDueReminders,
    sendTrialNotices,
    startTicker,
    ADDONS,
    BUSINESS_TYPES
  };
}

module.exports = {
  createTenancy,
  normalizeSetup,
  validateSetup,
  setupToStore,
  parseHours,
  isPrivateAddress,
  htmlToText,
  TRIAL_DAYS,
  TRIAL_TURNS_CAP
};
