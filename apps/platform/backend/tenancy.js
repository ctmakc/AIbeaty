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
const billing = require("./billing");

const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;
const TRIAL_TURNS_CAP = Number(process.env.TRIAL_DAILY_TURNS_CAP) || 150;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX_PER_IP = Number(process.env.SIGNUP_MAX_PER_IP) || 5;
const EXTRACT_MAX_CHARS = 24000;
const SITE_MAX_BYTES = 1_500_000;
const TG_MAX_MESSAGE = 4096;

const BUSINESS_TYPES = ["hair", "nails", "lashes_brows", "barber", "spa", "medspa", "multi"];
// UI languages. English and French for everyone; Russian is offered only to a
// browser that asks for ru/uk. Maya herself answers in the CLIENT's language.
const LANGUAGES = ["en", "fr", "ru"];
function normalizeLanguage(value) {
  const code = String(value || "").toLowerCase().slice(0, 2);
  if (code === "uk") return "ru";
  return LANGUAGES.includes(code) ? code : "en";
}
function pick(language, texts) {
  return texts[language] !== undefined ? texts[language] : texts.en;
}
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const RESERVED_SLUGS = new Set(["luminous-core", "admin", "api", "app", "www", "demo", "signup", "login", "setup", "screens"]);

// Paid extras. `auto: true` means the owner switches it on in the wizard with no
// human involved; the rest are requested and we come back with a quote. Prices
// are deliberately absent: nobody has set them yet.
// Paid prices live in backend/billing.js (owner decision 2026-09-18); the
// `price` here is only copied from there for the add-ons that have one.
const ADDONS = [
  { key: "website_widget", auto: true, title: { en: "Your chat link and website chat", fr: "Votre lien de clavardage et le chat du site", ru: "Ссылка на чат и чат на сайте" } },
  { key: "telegram", auto: true, title: { en: "Telegram bot (optional)", fr: "Bot Telegram (facultatif)", ru: "Telegram-бот (по желанию)" } },
  { key: "owner_alerts", auto: true, title: { en: "Bookings and alerts in your Telegram", fr: "Réservations et alertes dans votre Telegram", ru: "Записи и тревоги в ваш Telegram" } },
  { key: "instagram_dm", auto: false, title: { en: "Instagram Direct", fr: "Instagram Direct", ru: "Instagram Direct" } },
  { key: "whatsapp", auto: false, title: { en: "WhatsApp", fr: "WhatsApp", ru: "WhatsApp" } },
  { key: "calendar_sync", auto: false, title: { en: "Calendar sync (Google Calendar / Square / Booksy / Fresha / Vagaro)", fr: "Synchronisation d’agenda (Google Agenda / Square / Booksy / Fresha / Vagaro)", ru: "Синхронизация календаря (Google Calendar / Square / Booksy / Fresha / Vagaro)" } },
  { key: "sms_reminders", auto: false, title: { en: "SMS reminders (up to 300 SMS)", fr: "Rappels par SMS (jusqu’à 300 SMS)", ru: "SMS-напоминания (до 300 SMS)" } },
  { key: "done_for_you", auto: false, title: { en: "We set it up for you (free during the trial)", fr: "Nous configurons tout pour vous (gratuit pendant l’essai)", ru: "Настроим всё за вас (бесплатно в пробный период)" } },
  { key: "facebook_messenger", auto: false, later: true, title: { en: "Facebook Messenger", fr: "Facebook Messenger", ru: "Facebook Messenger" } },
  { key: "google_reviews", auto: false, later: true, title: { en: "Replies to Google reviews", fr: "Réponses aux avis Google", ru: "Ответы на отзывы в Google" } },
  { key: "phone_calls", auto: false, later: true, title: { en: "AI answers phone calls", fr: "L’IA répond aux appels", ru: "ИИ отвечает на звонки" } },
  { key: "continue_after_trial", auto: false, later: true, title: { en: "Keep the assistant after the trial", fr: "Garder l’assistante après l’essai", ru: "Оставить ассистента после пробного периода" } }
].map((addon) => {
  const paid = billing.addonByKey(addon.key);
  return paid ? Object.assign({ price: paid.price }, addon) : addon;
});

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
  const parsed = parsePriceText(value);
  return parsed.ok ? parsed.value : null;
}

// Owners write prices the way they say them. Every one of these is accepted and
// quoted to clients word for word:
//   "$65"  "65"  "from $75"  "$75+"  "$220–$320"  "+$15"  "$5/nail"  "Free"
//   "Complimentary"  "By consultation"  "Price on request"  "Gratuit"  "Sur consultation"
// Returns { ok, kind, value } where value is the lowest amount (0 for free and
// consultation) — what the quote guard checks the model's numbers against.
const PRICE_FREE_RE = /^(free|complimentary|no charge|gratuit|gratuite|offert|offerte|бесплатно|безкоштовно|безплатно)[.!]?$/i;
const PRICE_CONSULT_RE = /(consult|on request|upon request|price on request|quote|ask us|call us|sur demande|sur devis|devis|по консультации|по запросу|консультац|за запитом)/i;
const PRICE_MAX_CHARS = 60;

function parsePriceText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return { ok: value >= 0, kind: "fixed", value };
  const text = String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, kind: "empty", value: null };
  const numbers = (text.match(/\d+(?:[.,]\d{1,2})?/g) || []).map((raw) => Number.parseFloat(raw.replace(",", ".")));
  if (numbers.length) {
    const lower = text.toLowerCase();
    let kind = "fixed";
    if (numbers.length >= 2 && /\d\s*\$?\s*(?:-|–|—|to|à|до|-)\s*\$?\s*\d/i.test(text)) kind = "range";
    else if (/^(from|starting|starts|à partir|a partir|dès|des |от|від)/i.test(lower) || /\d\s*\$?\s*\+$/.test(text)) kind = "from";
    else if (/^\+/.test(text)) kind = "addon";
    else if (/\/|\bper\b|\beach\b|\bpar\b|за\s/i.test(lower)) kind = "per_unit";
    return { ok: true, kind, value: Math.min.apply(null, numbers) };
  }
  if (PRICE_FREE_RE.test(text)) return { ok: true, kind: "free", value: 0 };
  if (PRICE_CONSULT_RE.test(text)) return { ok: true, kind: "consult", value: 0 };
  return { ok: false, kind: "unclear", value: null };
}

function cleanText(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// setup document: shape, validation, conversion to what the store expects
// ---------------------------------------------------------------------------

// Starter "topics we do not discuss" for a medspa / clinic. The owner can edit
// them in step 4; medical questions always go to a person.
const MEDSPA_FORBIDDEN = {
  en: "Medical advice, dosing and units for a specific person, pregnancy or breastfeeding, medications and health conditions, diagnosing skin or health problems",
  fr: "Conseils médicaux, doses et unités pour une personne précise, grossesse ou allaitement, médicaments et problèmes de santé, diagnostic de la peau ou de la santé",
  ru: "Медицинские советы, дозировки и единицы для конкретного человека, беременность и кормление грудью, лекарства и болезни, диагнозы кожи и здоровья"
};
const OWNER_ROLE = { en: "Owner", fr: "Propriétaire", ru: "Владелец" };
const DEFAULT_HOURS = { sun: "closed", mon: "closed", tue: "10:00-19:00", wed: "10:00-19:00", thu: "10:00-19:00", fri: "10:00-19:00", sat: "10:00-17:00" };

function openDaysOf(hours) {
  return WEEKDAYS.filter((day) => {
    const parsed = parseHours(hours[day]);
    return parsed && !parsed.error;
  });
}

function emptySetup(signup = {}) {
  const language = normalizeLanguage(signup.language);
  const medspa = signup.businessType === "medspa";
  const hours = Object.assign({}, DEFAULT_HOURS);
  const ownerName = cleanText(signup.ownerName, 60);
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
    hours,
    services: [],
    // The owner is almost always the first person who does the work: a solo
    // owner should not have to add herself.
    staff: ownerName ? [{ name: ownerName, role: pick(language, OWNER_ROLE), services: [], workDays: openDaysOf(hours) }] : [],
    faq: { parking: "", payment: "", cancellation: "", deposit: "", late: "", custom: [] },
    assistant: { forbidden: medspa ? pick(language, MEDSPA_FORBIDDEN) : "", healthPrivacy: medspa }
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
    price: cleanText(service && service.price, PRICE_MAX_CHARS),
    deposit: Boolean(service && service.deposit),
    // "Consultation only": Maya never quotes a price for it and hands the
    // client to the team.
    consultOnly: Boolean(service && service.consultOnly),
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
    assistant: {
      forbidden: cleanText(doc.assistant && doc.assistant.forbidden, 400),
      // Medspa / clinic: health details stay out of Telegram alerts and
      // medical questions always go to a person.
      healthPrivacy: Boolean(doc.assistant && doc.assistant.healthPrivacy)
    }
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
    price: (name, value) => (value
      ? `We can't read the price of "${name}": "${value}". Write it like 65, from $75, $220–$320, +$15, $5/nail, Free or By consultation.`
      : `Add a price for "${name}", like 65, from $75, $220–$320, Free or By consultation. Or tick "Consultation only".`),
    noStaff: "Add at least one person who does the work, even if it is only you.",
    staffDup: (name) => `"${name}" is listed twice.`,
    staffService: (member, service) => `${member} does "${service}", but there is no service with that name. Pick it from your list.`,
    staffNoDays: (member) => `${member} has no working days. The assistant will not offer their time.`
  },
  fr: {
    name: "Indiquez le nom de votre salon.",
    timezone: (zone) => `Le fuseau horaire « ${zone} » n’est pas reconnu. Choisissez-en un dans la liste.`,
    hours: (day, value) => `Les heures du ${day} semblent incorrectes : « ${value} ». Écrivez-les ainsi : 10:00-19:00, ou choisissez « fermé ».`,
    noOpenDay: "Indiquez au moins un jour d’ouverture, sinon personne ne peut réserver.",
    noServices: "Ajoutez au moins un service pour que l’assistante ait quelque chose à réserver.",
    serviceName: (index) => `Le service no ${index} n’a pas de nom.`,
    serviceDup: (name) => `« ${name} » apparaît deux fois. Gardez-en un ou donnez-leur des noms différents.`,
    duration: (name) => `Indiquez combien de minutes dure « ${name} ». L’assistante en a besoin pour trouver un créneau.`,
    price: (name, value) => (value
      ? `Le prix de « ${name} » est illisible : « ${value} ». Écrivez par exemple 65, à partir de 75 $, 220–320 $, +15 $, 5 $/ongle, Gratuit ou Sur consultation.`
      : `Ajoutez un prix pour « ${name} », par exemple 65, à partir de 75 $, 220–320 $, Gratuit ou Sur consultation. Ou cochez « Sur consultation seulement ».`),
    noStaff: "Ajoutez au moins une personne qui fait le travail, même si c’est seulement vous.",
    staffDup: (name) => `« ${name} » apparaît deux fois.`,
    staffService: (member, service) => `${member} fait « ${service} », mais aucun service ne porte ce nom. Choisissez-le dans votre liste.`,
    staffNoDays: (member) => `${member} n’a aucun jour de travail. L’assistante ne proposera pas ses disponibilités.`
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
    price: (name, value) => (value
      ? `Не получается прочитать цену «${name}»: «${value}». Пишите так: 65, от $75, $220–$320, +$15, $5/ноготь, Бесплатно или По консультации.`
      : `Укажите цену «${name}», например 65, от $75, $220–$320, Бесплатно или По консультации. Или отметьте «Только консультация».`),
    noStaff: "Добавьте хотя бы одного мастера, пусть даже это вы.",
    staffDup: (name) => `«${name}» указан дважды.`,
    staffService: (member, service) => `У мастера ${member} стоит услуга «${service}», а такой услуги нет в списке. Выберите её из списка.`,
    staffNoDays: (member) => `У мастера ${member} не отмечено ни одного рабочего дня. Ассистент не будет предлагать его время.`
  }
};

const DAY_NAMES = {
  en: { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" },
  fr: { sun: "dimanche", mon: "lundi", tue: "mardi", wed: "mercredi", thu: "jeudi", fri: "vendredi", sat: "samedi" },
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
    if (!service.consultOnly && !parsePriceText(service.price).ok) add(`services.${index}.price`, t.price(service.name, service.price));
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
    const parsed = parsePriceText(service.price);
    const priceValue = service.consultOnly ? 0 : (parsed.ok ? parsed.value : 0);
    byCategory.get(category).push({
      name: service.name,
      durationMinutes: service.durationMinutes || 60,
      priceValue,
      // The owner's own wording ("from $110", "$220–$320", "Free") is what the
      // assistant quotes; priceValue is what the quote guard checks against.
      // A consultation-only service never carries a number to quote.
      priceLabel: service.consultOnly
        ? "By consultation"
        : /[^\d.,\s$]/.test(service.price) ? service.price : `$${priceValue.toFixed(2)}`,
      requiresDeposit: service.deposit,
      description: service.consultOnly
        ? `${service.note ? `${service.note} ` : ""}Consultation only: do not quote a price; offer a consultation or hand the client to the team.`
        : service.note || `${service.name} — ${category}.`,
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
  const consultOnly = doc.services.filter((service) => service.consultOnly).map((service) => service.name);
  if (consultOnly.length) {
    push("consultation_only", `Consultation only, never quote a price for: ${consultOnly.join(", ")}. Offer a consultation or pass the client to the salon team.`);
  }
  if (doc.assistant.forbidden) push("forbidden_topics", `Topics we do not discuss: ${doc.assistant.forbidden}.`);
  if (doc.assistant.healthPrivacy) {
    push("medical_questions", "Medical questions (health conditions, medications, pregnancy or breastfeeding, dosing, side effects, whether a treatment is safe for someone) always go to a person on the salon team. Do not answer them yourself.");
  }

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

function createTenancy({ store, auth, llm, clock = () => new Date(), fetchImpl, publicBaseUrl, platformNotify, secret } = {}) {
  const db = store.db;
  const http = fetchImpl || ((...args) => fetch(...args));
  const PUBLIC_BASE = String(publicBaseUrl || process.env.PUBLIC_BASE_URL || "https://aibeaty.remolda.com").replace(/\/+$/, "");
  const TG_API = String(process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
  const notifyPlatform = typeof platformNotify === "function" ? platformNotify : () => {};
  let assistant = null;
  const signupAttempts = new Map();

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
  // Plan choice and payment state (backend/billing.js).
  billing.ensureBillingSchema(db);
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
    const billingInfo = billing.billingState(row);
    return {
      slug: row.salon_slug,
      plan: row.plan,
      planStatus: billingInfo.status,
      billing: billingInfo,
      businessType: row.business_type,
      language: normalizeLanguage(row.language),
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
    const language = normalizeLanguage(input.language);
    const say = (en, ru, fr) => pick(language, { en, ru, fr: fr || en });
    const email = String(input.email || "").trim().toLowerCase();
    const password = String(input.password || "");
    const salonName = cleanText(input.salonName, 120);
    const timezone = cleanText(input.timezone, 60) || "America/Toronto";
    const businessType = BUSINESS_TYPES.includes(input.businessType) ? input.businessType : "multi";
    const ip = auth.clientIp(request);

    if (signupRateLimited(ip)) {
      return { ok: false, status: 429, error: "rate_limited", message: say("Too many sign-ups from this network. Try again in an hour.", "Слишком много регистраций из этой сети. Попробуйте через час.", "Trop d’inscriptions depuis ce réseau. Réessayez dans une heure.") };
    }
    const fieldErrors = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.push({ field: "email", message: say("Enter a valid email.", "Введите корректный email.", "Entrez une adresse courriel valide.") });
    if (password.length < 10) fieldErrors.push({ field: "password", message: say("Use at least 10 characters.", "Нужно не меньше 10 символов.", "Utilisez au moins 10 caractères.") });
    if (!salonName) fieldErrors.push({ field: "salonName", message: say("Enter your salon's name.", "Введите название салона.", "Entrez le nom de votre salon.") });
    if (!validTimezone(timezone)) fieldErrors.push({ field: "timezone", message: say("Pick your time zone.", "Выберите часовой пояс.", "Choisissez votre fuseau horaire.") });
    if (fieldErrors.length) return { ok: false, status: 400, error: "invalid", errors: fieldErrors };
    // createOwner upserts by email; without this check a sign-up would take over
    // an existing account.
    if (auth.getOwnerByEmail(email)) {
      return { ok: false, status: 409, error: "account_exists", errors: [{ field: "email", message: say("This email already has an account. Sign in instead.", "На этот email уже есть аккаунт. Войдите.", "Ce courriel a déjà un compte. Connectez-vous plutôt.") }] };
    }

    const slug = uniqueSlug(salonName);
    const setup = emptySetup({ salonName, city: input.city, phone: input.phone, timezone, ownerName: input.ownerName, businessType, language });
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
      lines: [`Salon: ${salonName} (${slug})`, `Email: ${email}`, `City: ${setup.salon.city || "—"}`, `Type: ${businessType}`, `Language: ${language}`, `Trial ends: ${trialEnds.slice(0, 10)}`]
    });

    const login = auth.login({ email, password, request });
    return { ok: true, status: 201, slug, setCookie: login.setCookie, trialEndsAt: trialEnds };
  }

  // ---------- setup ----------
  function saveSetup(slug, input, { language } = {}) {
    const tenant = getTenant(slug);
    const doc = normalizeSetup(input);
    const lang = normalizeLanguage(language || (tenant && tenant.language) || "en");
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
      const text = String(payload.message || "");
      const ru = /[а-яёіїє]/i.test(text);
      const fr = !ru && /[àâçéèêëîïôûùüÿœ]|\b(bonjour|merci|rendez-vous|prix|combien|svp|oui)\b/i.test(text);
      if (!tenant.setupComplete || (!tenant.launched && !preview)) {
        return {
          reply: ru
            ? "Ассистент этого салона ещё настраивается. Пожалуйста, свяжитесь с салоном напрямую."
            : fr
              ? "L’assistante de ce salon est encore en configuration. Pour l’instant, contactez le salon directement."
              : "This salon's assistant is still being set up. Please contact the salon directly for now.",
          state: { reason: "setup_incomplete" }
        };
      }
      if (!tenant.active) {
        return {
          reply: ru
            ? "Онлайн-ассистент салона сейчас на паузе. Пожалуйста, свяжитесь с салоном напрямую."
            : fr
              ? "L’assistante en ligne du salon est en pause pour le moment. Contactez le salon directement."
              : "The salon's online assistant is paused right now. Please contact the salon directly.",
          state: { reason: "trial_ended" }
        };
      }
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
      const text = ownerEventText(salonId, type, payload);
      if (text) notifyOwner(salonId, text);
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
      // A salon waiting on its invoice keeps Maya on; no nagging about the trial.
      if (tenant.planStatus === "pending_payment" && tenant.active) return;
      const lang = tenant.language;
      const planLink = `${PUBLIC_BASE}/screens/setup.html#7`;
      let key = "";
      let text = "";
      if (!tenant.active && !notices.ended) {
        key = "ended";
        text = pick(lang, {
          en: `Your trial has ended and Maya is paused for clients. To keep her, choose a plan here (from $39/month): ${planLink}`,
          fr: `Votre essai est terminé et Maya est en pause pour vos clients. Pour la garder, choisissez un forfait ici (à partir de 39 $/mois) : ${planLink}`,
          ru: `Пробный период закончился, и Майя поставлена на паузу для клиентов. Чтобы продолжить, выберите тариф здесь (от $39 в месяц): ${planLink}`
        });
        const record = store.getSalonRecord(row.salon_slug) || {};
        notifyPlatform({ subject: `AIbeaty trial ended: ${record.name || row.salon_slug}`, lines: [`Salon: ${record.name || row.salon_slug}`, `Owner email: ${record.email || "—"}`, `Launched: ${tenant.launched ? "yes" : "no"}`] });
      } else if (tenant.active && tenant.trialDaysLeft <= 3 && !notices.d3) {
        key = "d3";
        text = pick(lang, {
          en: `Your trial ends in ${tenant.trialDaysLeft} day(s). To keep Maya answering clients without a gap, choose a plan (from $39/month): ${planLink}`,
          fr: `Votre essai se termine dans ${tenant.trialDaysLeft} jour(s). Pour que Maya continue de répondre sans interruption, choisissez un forfait (à partir de 39 $/mois) : ${planLink}`,
          ru: `Пробный период закончится через ${tenant.trialDaysLeft} дн. Чтобы Майя продолжала отвечать клиентам без перерыва, выберите тариф (от $39 в месяц): ${planLink}`
        });
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

  function ownerEventText(salonId, type, payload) {
    const tenant = getTenant(salonId);
    const ru = tenant && tenant.language === "ru";
    const thread = `${PUBLIC_BASE}/screens/unified-inbox-luminous-core.html?conversationId=${encodeURIComponent(payload.conversationId || "")}`;
    const who = payload.client || (ru ? "клиент" : "a client");
    const when = [payload.day || payload.date || "", payload.time || payload.timeLabel || ""].filter(Boolean).join(" ");
    switch (type) {
      case "booking":
        return ru
          ? `✅ Новая запись: ${who} — ${payload.service || ""}${payload.stylist ? `, мастер ${payload.stylist}` : ""}${when ? `, ${when}` : ""}.`
          : `✅ New booking: ${who} — ${payload.service || ""}${payload.stylist ? ` with ${payload.stylist}` : ""}${when ? `, ${when}` : ""}.`;
      case "reschedule":
        return ru
          ? `🔁 Перенос: ${who} — ${payload.service || ""}${when ? ` → ${when}` : ""}.`
          : `🔁 Rescheduled: ${who} — ${payload.service || ""}${when ? ` → ${when}` : ""}.`;
      case "cancellation":
        return ru ? `❌ Отмена: ${who} — ${payload.service || ""}.` : `❌ Cancelled: ${who} — ${payload.service || ""}.`;
      case "escalation":
        return ru
          ? `🔔 Клиенту нужен человек (${payload.reason || ""}). ${payload.summary || ""}\nПереписка: ${thread}`
          : `🔔 A client needs a human (${payload.reason || ""}). ${payload.summary || ""}\nConversation: ${thread}`;
      case "owner_message":
        return ru ? `✉️ Для вас: ${payload.message || ""}\nПереписка: ${thread}` : `✉️ For you: ${payload.message || ""}\nConversation: ${thread}`;
      case "usage_alert":
        return ru
          ? `⚠️ Ассистент израсходовал ${payload.threshold}% дневного лимита (${payload.turns}/${payload.cap}).`
          : `⚠️ The assistant used ${payload.threshold}% of today's limit (${payload.turns}/${payload.cap}).`;
      default:
        return "";
    }
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
    const lang = normalizeLanguage(language);
    const say = (en, ru, fr) => pick(lang, { en, ru, fr: fr || en });
    const token = String(rawToken || "").trim();
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return { ok: false, message: say("That is not a bot token. It looks like 123456789:AA… and comes from @BotFather.", "Это не токен бота. Он выглядит как 123456789:AA… и приходит от @BotFather.", "Ce n’est pas un jeton de bot. Il ressemble à 123456789:AA… et vient de @BotFather.") };
    }
    let me;
    try {
      me = await tg(token, "getMe");
    } catch (error) {
      return { ok: false, message: say("Telegram did not accept this token. Copy it again from @BotFather.", "Telegram не принял этот токен. Скопируйте его ещё раз из @BotFather.", "Telegram n’a pas accepté ce jeton. Copiez-le de nouveau depuis @BotFather.") };
    }
    const botId = String(me.id);
    const taken = db.prepare(`SELECT salon_slug FROM tenant_telegram WHERE bot_id = ?`).get(botId);
    if (taken && taken.salon_slug !== slug) {
      return { ok: false, message: say("This bot is already connected to another salon. Create a new bot in @BotFather.", "Этот бот уже подключён к другому салону. Создайте нового бота в @BotFather.", "Ce bot est déjà relié à un autre salon. Créez un nouveau bot dans @BotFather.") };
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
      return { ok: false, message: say("Telegram refused to connect the bot. Try again in a minute.", "Telegram не дал подключить бота. Попробуйте через минуту.", "Telegram a refusé de connecter le bot. Réessayez dans une minute.") };
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

  function notifyOwner(slug, text) {
    const row = getTelegram(slug);
    if (!row || !row.owner_chat_id) return;
    sendTelegram(row, row.owner_chat_id, text).catch((error) => {
      console.error(`[tenancy] owner notify failed for ${slug}: ${String(error.message).slice(0, 140)}`);
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

  async function processTelegramMessage(row, message) {
    const chatId = String(message.chat.id);
    const text = String(message.text || "").trim();
    const languageCode = message.from && message.from.language_code;
    const ru = /^(ru|uk|be)/.test(String(languageCode || ""));

    const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
    if (startMatch) {
      const payload = startMatch[1] || "";
      if (payload === `owner-${row.owner_link_code}`) {
        db.prepare(`UPDATE tenant_telegram SET owner_chat_id = ? WHERE salon_slug = ?`).run(chatId, row.salon_slug);
        await sendTelegram(row, chatId, ru
          ? "Готово: сюда будут приходить новые записи, переносы, отмены и просьбы клиентов позвать человека. Можете и сами написать боту как клиент, чтобы проверить его."
          : "Done. New bookings, reschedules, cancellations and clients asking for a human will arrive here. You can also message this bot as a client to test it.");
        return;
      }
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

    const tokenForTyping = unseal(row.token_sealed);
    tg(tokenForTyping, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const typing = setInterval(() => tg(tokenForTyping, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4500);
    let result;
    try {
      result = await chat(row.salon_slug, {
        sessionId: `tg:${row.bot_id}:${chatId}`,
        message: body.slice(0, 2000),
        channel: "telegram",
        clientPhone
      }, { preview: Boolean(row.owner_chat_id) && row.owner_chat_id === chatId });
    } finally {
      clearInterval(typing);
    }
    if (result && result.reply) {
      await sendTelegram(row, chatId, String(result.reply), { reply_markup: { remove_keyboard: true } });
    } else if (result && result.error === "rate_limited") {
      await sendTelegram(row, chatId, ru ? "Слишком быстро 🙂 Подождите минутку." : "That was fast 🙂 Give me a minute.");
    }
  }

  // ---------- add-ons ----------
  function listAddons(slug, language = "en") {
    const lang = normalizeLanguage(language);
    const requested = new Map(
      db.prepare(`SELECT addon, status, created_at FROM tenant_addon_requests WHERE salon_slug = ? ORDER BY created_at`).all(slug)
        .map((row) => [row.addon, row])
    );
    const telegram = getTelegram(slug);
    const tenant = getTenant(slug);
    const paidAddons = tenant && tenant.planStatus === "active" ? tenant.billing.addons : [];
    return ADDONS.map((addon) => {
      let status = requested.has(addon.key) ? requested.get(addon.key).status : "available";
      if (addon.key === "telegram" && telegram) status = "active";
      if (addon.key === "owner_alerts" && telegram && telegram.owner_chat_id) status = "active";
      // Clients reach the chat link only after Go live: until then it is ready,
      // not active.
      if (addon.key === "website_widget") status = tenant && !tenant.launched ? "ready" : "active";
      if (paidAddons.includes(addon.key) && status === "requested") status = "paid";
      return Object.assign(
        { key: addon.key, auto: addon.auto, later: Boolean(addon.later), title: pick(lang, addon.title), status },
        addon.price ? { price: addon.price } : {}
      );
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
      lines: [`Salon: ${record.name || slug} (${slug})`, `Owner email: ${record.email || "—"}`, `Add-on: ${addon.title.en}${addon.price ? ` (+$${addon.price}/mo)` : ""}`, `Note: ${cleanText(note, 1000) || "—"}`]
    });
    return { ok: true };
  }

  // ---------- plan & payment (backend/billing.js) ----------
  function planView(slug, language = "en") {
    const tenant = getTenant(slug);
    if (!tenant) return null;
    const lang = normalizeLanguage(language || tenant.language);
    return Object.assign(billing.catalog(lang), {
      status: tenant.planStatus,
      choice: tenant.billing.choice,
      chosenAddons: tenant.billing.addons,
      cycle: tenant.billing.cycle,
      requestedAt: tenant.billing.requestedAt,
      activatedAt: tenant.billing.activatedAt,
      quote: tenant.billing.quote,
      suggested: billing.suggestPlan(tenant.setup.staff.length, tenant.businessType),
      staffCount: tenant.setup.staff.length,
      checkout: billing.stripeEnabled() ? "stripe" : "invoice"
    });
  }

  // The owner pressed "Continue with <plan>" in step 7.
  async function requestPlan(slug, input = {}, { language } = {}) {
    const tenant = getTenant(slug);
    if (!tenant) return { ok: false, status: 409, error: "not_self_serve" };
    const lang = normalizeLanguage(language || tenant.language);
    const result = billing.requestPlan(db, slug, { plan: input.plan, addons: input.addons, cycle: input.cycle }, clock);
    if (!result.ok) {
      const message = result.error === "already_active"
        ? pick(lang, { en: "Your plan is already active.", fr: "Votre forfait est déjà actif.", ru: "Тариф уже активен." })
        : pick(lang, { en: "Pick one of the plans.", fr: "Choisissez un des forfaits.", ru: "Выберите один из тарифов." });
      return { ok: false, status: result.error === "already_active" ? 409 : 422, error: result.error, message };
    }
    const q = result.quote;
    // Each paid add-on is also an ordinary add-on request, so the connect-it
    // work shows up in the same list as before.
    q.addons.forEach((addon) => {
      const existing = db.prepare(`SELECT id FROM tenant_addon_requests WHERE salon_slug = ? AND addon = ?`).get(slug, addon.key);
      if (!existing) {
        db.prepare(`INSERT INTO tenant_addon_requests (id, salon_slug, addon, note, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(`addon-${crypto.randomBytes(6).toString("hex")}`, slug, addon.key, `with plan ${q.plan}`, nowIso(clock));
      }
    });
    const record = store.getSalonRecord(slug) || {};
    const summary = billing.describeQuote(q);
    notifyPlatform({
      subject: `AIbeaty plan request: ${record.name || slug} — ${q.planTitle.en} ${billing.money(q.total)}/${q.cycle === "annual" ? "yr" : "mo"} + tax`,
      lines: [
        `Salon: ${record.name || slug} (${slug})`,
        `Owner email: ${record.email || "—"}`,
        `Plan: ${q.planTitle.en} ${billing.money(q.planPrice)}/mo (${q.staffLimit ? `up to ${q.staffLimit} staff` : "unlimited staff"})`,
        `Add-ons: ${q.addons.length ? q.addons.map((addon) => `${addon.title.en} +${billing.money(addon.price)}/mo`).join(", ") : "none"}`,
        `Billing: ${q.cycle}`,
        `Monthly total: ${billing.money(q.monthly)} ${q.currency} + tax`,
        q.cycle === "annual" ? `Invoice total: ${billing.money(q.total)} ${q.currency}/year + tax (2 months free)` : `Invoice total: ${billing.money(q.total)} ${q.currency}/month + tax`,
        `Summary: ${summary}`,
        `Team size now: ${tenant.setup.staff.length}`,
        `Province/city: ${record.city || "—"} (for HST/GST/QST)`,
        `Trial now ends: ${result.trialEndsAt.slice(0, 10)}${result.extended ? " (extended +7 days)" : ""}`,
        `Send the invoice from ${billing.SELLER} (card link or Interac e-Transfer), then run:`,
        `node scripts/tenants.mjs activate ${slug} ${q.plan}${q.addons.length ? ` ${q.addons.map((addon) => addon.key).join(" ")}` : ""}${q.cycle === "annual" ? " --annual" : ""}`
      ]
    });
    let checkoutUrl = "";
    if (billing.stripeEnabled()) {
      try {
        const session = await billing.createCheckoutSession({
          slug,
          email: record.email,
          q,
          successUrl: `${PUBLIC_BASE}/screens/setup.html?paid=1#7`,
          cancelUrl: `${PUBLIC_BASE}/screens/setup.html#7`,
          fetchImpl: http
        });
        if (session) checkoutUrl = session.url;
      } catch (error) {
        // The invoice path still works: the owner sees the invoice message.
        console.error(`[billing] checkout failed for ${slug}: ${String(error.message).slice(0, 160)}`);
      }
    }
    if (assistant) assistant.invalidate(slug);
    return { ok: true, status: 200, quote: q, trialEndsAt: result.trialEndsAt, extended: result.extended, checkoutUrl, plan: planView(slug, lang) };
  }

  function activatePlan(slug, input = {}) {
    const result = billing.activatePlan(db, slug, input, clock);
    if (result.ok) {
      const record = store.getSalonRecord(slug) || {};
      notifyPlatform({ subject: `AIbeaty plan active: ${record.name || slug} — ${result.quote.planTitle.en}`, lines: [`Salon: ${slug}`, billing.describeQuote(result.quote)] });
      const tenant = getTenant(slug);
      notifyOwner(slug, pick(tenant ? tenant.language : "en", {
        en: `Thank you! Your ${result.quote.planTitle.en} plan is active. Maya keeps answering your clients.`,
        fr: `Merci! Votre forfait ${result.quote.planTitle.fr} est actif. Maya continue de répondre à vos clients.`,
        ru: `Спасибо! Тариф «${result.quote.planTitle.ru}» активен. Майя продолжает отвечать вашим клиентам.`
      }));
    }
    return result;
  }

  // Stripe webhook (only reachable when STRIPE_WEBHOOK_SECRET is set).
  function handleStripeWebhook(rawBody, signatureHeader) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
    if (!secret) return { status: 404, body: { error: "not_configured" } };
    if (!billing.verifyStripeSignature(rawBody, signatureHeader, secret, { now: clock().getTime() })) {
      return { status: 400, body: { error: "bad_signature" } };
    }
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch (error) {
      return { status: 400, body: { error: "bad_json" } };
    }
    if (event.type !== "checkout.session.completed") return { status: 200, body: { received: true } };
    const session = (event.data && event.data.object) || {};
    const metadata = session.metadata || {};
    const slug = metadata.slug || session.client_reference_id;
    const result = activatePlan(slug, {
      plan: metadata.plan,
      addons: String(metadata.addons || "").split(",").filter(Boolean),
      cycle: metadata.cycle,
      stripeCustomer: session.customer || "",
      stripeSubscription: session.subscription || ""
    });
    return { status: 200, body: { received: true, activated: Boolean(result.ok) } };
  }

  // ---------- owner UI language ----------
  function setLanguage(slug, language) {
    const lang = normalizeLanguage(language);
    db.prepare(`UPDATE tenants SET language = ?, updated_at = ? WHERE salon_slug = ?`).run(lang, nowIso(clock), slug);
    return lang;
  }

  // ---------- the salon's own highlights for the chat greeting ----------
  // The first three services the owner listed, with the price text as written.
  function highlights(slug) {
    const tenant = getTenant(slug);
    if (!tenant || !tenant.setupComplete) return [];
    return tenant.setup.services
      .filter((service) => service.name && (service.consultOnly || parsePriceText(service.price).ok))
      .slice(0, 3)
      .map((service) => ({ name: service.name, price: service.consultOnly ? "" : service.price, consultOnly: service.consultOnly }));
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
    listAddons,
    requestAddon,
    planView,
    requestPlan,
    activatePlan,
    handleStripeWebhook,
    setLanguage,
    highlights,
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
  emptySetup,
  parseHours,
  parsePriceText,
  normalizeLanguage,
  isPrivateAddress,
  htmlToText,
  TRIAL_DAYS,
  TRIAL_TURNS_CAP
};
