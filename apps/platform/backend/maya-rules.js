// Salon rules Maya must follow in code, not only in the prompt:
// staff work days, price labels (ranges, "from", add-ons, per-unit, free,
// by consultation), the price allow-list, FAQ matching, external booking
// apps and the scoped "fake booking confirmation" and "closed day" checks.
//
// Pure functions only (no DB, no clock) so every rule is unit-testable.

// ---------------------------------------------------------------- weekdays
// 0 = Sunday … 6 = Saturday, the same numbering as opening hours.
const DAY_WORDS = [
  [0, /^(0|sun|sunday|dim|dimanche|вс|воскресенье|воскресение|нд|неділя)\.?$/i],
  [1, /^(1|mon|monday|lun|lundi|пн|понедельник|понеділок)\.?$/i],
  [2, /^(2|tue|tues|tuesday|mar|mardi|вт|вторник|вівторок)\.?$/i],
  [3, /^(3|wed|wednesday|mer|mercredi|ср|среда|середа)\.?$/i],
  [4, /^(4|thu|thur|thurs|thursday|jeu|jeudi|чт|четверг|четвер)\.?$/i],
  [5, /^(5|fri|friday|ven|vendredi|пт|пятница|п'ятниця|п’ятниця)\.?$/i],
  [6, /^(6|sat|saturday|sam|samedi|сб|суббота|субота)\.?$/i]
];
const WEEKDAY_SHORT = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] };

function weekdayIndex(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value;
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!text) return null;
  for (const [index, re] of DAY_WORDS) if (re.test(text)) return index;
  return null;
}

// A staff row's work_days (JSON text or array) → sorted weekday numbers, or
// null when the owner gave none (then the salon's own open days apply).
function parseWorkDays(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try { list = JSON.parse(raw || "[]"); } catch (error) { list = raw.split(/[\s,;]+/); }
  }
  if (!Array.isArray(list)) return null;
  const days = [...new Set(list.map(weekdayIndex).filter((day) => day !== null))].sort((a, b) => a - b);
  return days.length ? days : null;
}

// "Tue, Wed, Thu" — runs of three or more become "Tue–Fri".
function workDaysLabel(days) {
  if (!days || !days.length) return "every day the salon is open";
  const names = WEEKDAY_SHORT.en;
  // Present Monday-first, the way people read a week.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const sorted = order.filter((day) => days.includes(day));
  const runs = [];
  sorted.forEach((day) => {
    const last = runs[runs.length - 1];
    const pos = order.indexOf(day);
    if (last && order.indexOf(last[last.length - 1]) === pos - 1) last.push(day);
    else runs.push([day]);
  });
  return runs.map((run) => (run.length >= 3 ? `${names[run[0]]}–${names[run[run.length - 1]]}` : run.map((day) => names[day]).join(", "))).join(", ");
}

// ---------------------------------------------------------------- prices
const AMOUNT_RE = /\d{1,6}(?:[.,]\d{1,2})?/g;

function amountsIn(text) {
  const found = [];
  const value = String(text || "");
  let match;
  AMOUNT_RE.lastIndex = 0;
  while ((match = AMOUNT_RE.exec(value)) !== null) {
    // "1,500" is a thousands separator; "12,50" a decimal comma.
    const raw = match[0];
    const normalized = /,\d{3}$/.test(raw) ? raw.replace(",", "") : raw.replace(",", ".");
    const num = Number(normalized);
    if (Number.isFinite(num)) found.push(num);
  }
  return found;
}

const CONSULT_RE = /consult|sur devis|on request|sur demande|по запросу|на консультац|за консультац|після консультац|после консультац|price on request|by quote|quote only/i;
const FREE_RE = /^\s*(free|gratuit|gratuite|offert|бесплатно|безкоштовно|безплатно|complimentary|\$?\s?0(?:[.,]00)?\s?\$?)\s*$/i;
const FROM_RE = /(^|[\s(])(from|starting( at)?|starts at|dès|des|à partir de|a partir de|от|від|min\.?)(?=[\s$\d])/i;
const RANGE_RE = /\d\s*\$?\s*(?:[-–—]|to|à|a|до)\s*\$?\s*\d/i;
const PER_UNIT_RE = /\d\s*\$?\s*(?:\/|per |par |each|chacun|chaque|за )\s*\p{L}*/iu;
const ADD_ON_RE = /^\s*\+|add[- ]?on|supplément|supplement|en plus|доплат|додатково/i;

// What kind of price the owner wrote, and how Maya must say it.
function priceKind(label) {
  const text = String(label || "").trim();
  if (!text) return "unknown";
  if (FREE_RE.test(text)) return "free";
  if (CONSULT_RE.test(text) && !amountsIn(text).some((num) => num > 0)) return "consultation";
  if (PER_UNIT_RE.test(text)) return "per_unit";
  if (RANGE_RE.test(text)) return "range";
  if (FROM_RE.test(text)) return "from";
  if (ADD_ON_RE.test(text)) return "add_on";
  return "fixed";
}

const PRICE_NOTES = {
  free: "Free. Say it is free; never invent an amount.",
  consultation: "Priced by consultation. Never say a number for it: offer a consultation, or pass the question to the team.",
  per_unit: "Priced per unit. Quote the label verbatim; multiply only by a quantity the client gave, and say the final price is confirmed at the visit.",
  range: "A range. Quote it verbatim, e.g. \"$220–$320\"; the stylist confirms the final price.",
  from: "A starting price. Quote it verbatim with the word \"from\"; the final price is confirmed at the visit.",
  add_on: "An add-on to another service. Quote it verbatim; do not add prices up into a total.",
  fixed: "Fixed price. Quote it exactly."
};

// Numbers Maya may say as prices: every amount in every service label and
// value, every amount in the owner's FAQ and policy text, in-label sums
// ("from $75 (senior stylist +$15)" → 90) and per-unit multiples by a
// quantity the client named in this message.
function buildPriceAllowList({ services = [], faqTexts = [], extra = [], clientMessage = "" } = {}) {
  const allowed = new Set();
  const add = (num) => { if (Number.isFinite(num)) allowed.add(Math.round(num * 100) / 100); };
  const quantities = amountsIn(clientMessage).filter((num) => Number.isInteger(num) && num > 0 && num <= 200);
  services.forEach((service) => {
    const label = String(service.price_label || service.price || "");
    const nums = amountsIn(label);
    nums.forEach(add);
    add(Number(service.price_value));
    if (/\+\s*\$?\s*\d/.test(label) && nums.length >= 2) {
      // base + each add-on inside the same label
      for (let i = 1; i < nums.length; i++) add(nums[0] + nums[i]);
    }
    if (priceKind(label) === "per_unit") {
      const unit = nums[0];
      quantities.forEach((qty) => add(unit * qty));
    }
  });
  // An add-on is its own row in the price list ("Nail art  +$15", "Toner +$40").
  // "Gel manicure with nail art is $70" is then the owner's own arithmetic, so
  // base + add-on totals are allowed; anything else still is not.
  const addOnAmounts = services
    .map((service) => String(service.price_label || service.price || ""))
    .filter((label) => priceKind(label) === "add_on")
    .map((label) => amountsIn(label)[0])
    .filter((num) => Number.isFinite(num));
  if (addOnAmounts.length) {
    services.forEach((service) => {
      const label = String(service.price_label || service.price || "");
      if (priceKind(label) === "add_on") return;
      const base = amountsIn(label);
      base.forEach((amount) => addOnAmounts.forEach((extraAmount) => add(amount + extraAmount)));
    });
  }

  faqTexts.forEach((text) => amountsIn(text).forEach(add));
  extra.forEach((num) => add(Number(num)));
  return allowed;
}

// ---------------------------------------------------------------- FAQ matching
// Topics the client's question can be about, and how the owner's FAQ names them.
const FAQ_CONCEPTS = [
  { key: "walk_in", client: /walk[- ]?ins?|sans rendez|sans rdv|pas de rendez|drop[- ]?in|without (an )?appointment|just (come|show up|pop|drop)|без записи|без запису|живая очередь|жива черга/i, topic: /walk[- ]?in|sans rendez|sans rdv|drop[- ]?in|без запис/i },
  { key: "address", client: /address|adresse|адрес|адреса|where are you|where is (the|your)|located|location|how (do i|to) (get|find)|où (êtes|se trouve|est|vous)|vous êtes où|находитесь|знаходитесь|где вы|де ви/i, topic: /address|adresse|адрес|located|location|studio in|situé/i, ids: ["address"] },
  { key: "parking", client: /park|stationn|парков|паркув/i, topic: /park|stationn|парков|паркув/i, ids: ["parking"] },
  { key: "deposit", client: /deposit|dépôt|depot|acompte|депозит|предоплат|передплат|завдат|e-?transfer|virement/i, topic: /deposit|dépôt|depot|acompte|депозит|предоплат|передплат|e-?transfer/i, ids: ["deposit_policy", "deposit_required"] },
  { key: "cancel", client: /cancel|annul|отмен|скасу|reschedul|déplacer|changer (mon|le) rendez|перенес|перенос|lose my|lost|perdre|потеря|втрач|no[- ]?show/i, topic: /cancel|annul|отмен|скасу|reschedul|no[- ]?show/i, ids: ["cancellation_policy"] },
  { key: "late", client: /\blate\b|en retard|retard|опозда|опозд|запізн|спізн|traffic|trafic|пробк|затор/i, topic: /\blate\b|retard|опозд|запізн|grace|wait \d+|attend \d+/i, ids: ["late_policy"] },
  { key: "payment", client: /\bpay\b|payment|pay by|card|cash|debit|credit|interac|payer|paiement|carte|comptant|оплат|карт|налич|готівк/i, topic: /card|cash|debit|credit|interac|carte|comptant|оплат|карт|налич|готівк/i, ids: ["payment"] },
  { key: "hours", client: /\bhours\b|open(ing)?\b|close(s|d)?\b|heures|ouvert|fermé|horaire|часы работы|до скольки|работаете|відчинен|графік|працюєте/i, topic: /opening hours|heures d'ouverture|часы работы/i, ids: ["hours"] }
];

const FAQ_STOPWORDS = new Set("what when where which there their about your yours have does with from this that please price prices much many will would could should vous votre avec pour dans quel quelle quels comment est-ce combien pouvez peux faire есть можно какой какая сколько стоит будет дуже можна який яка скільки".split(" "));

function significantWords(text) {
  return String(text || "").toLowerCase().split(/[^\p{L}]+/u).filter((word) => word.length >= 5 && !FAQ_STOPWORDS.has(word));
}

// topics: [{ id, text }]. Returns the topics that answer the client's message,
// most specific first (owner's custom Q&A before generic policy lines).
function matchFaqTopics(message, topics) {
  const text = String(message || "");
  if (!text.trim()) return [];
  const hits = new Map();
  FAQ_CONCEPTS.forEach((concept) => {
    if (!concept.client.test(text)) return;
    topics.forEach((topic) => {
      const byId = (concept.ids || []).includes(topic.id);
      const isCustom = /^custom_/.test(topic.id);
      if (byId || (isCustom && concept.topic.test(topic.text))) {
        hits.set(topic.id, { topic, score: isCustom ? 3 : 2 });
      }
    });
  });
  // Custom Q&A by shared words ("colour correction", "patch test", "French").
  const words = significantWords(text).map((word) => word.slice(0, 6));
  topics.filter((topic) => /^custom_/.test(topic.id) && !hits.has(topic.id)).forEach((topic) => {
    const question = String(topic.text).split(/ — /)[0];
    const qWords = significantWords(question).map((word) => word.slice(0, 6));
    if (qWords.some((word) => words.includes(word))) hits.set(topic.id, { topic, score: 1 });
  });
  return [...hits.values()].sort((a, b) => b.score - a.score).map((hit) => hit.topic);
}

// The owner said the address is given only after booking/deposit.
const ADDRESS_AFTER_BOOKING_RE = /(address|adresse|адрес)[^.]{0,80}(only|seulement|uniquement|только|лише|тільки)?[^.]{0,40}(after|once|après|une fois|после|після)[^.]{0,60}(book|confirm|deposit|réserv|dépôt|запис|депозит|предоплат)|never give the (street )?address|(street )?address before (the )?(deposit|booking|confirmation)|ne (donnez|donne) jamais l'adresse/i;

function addressIsPrivate(topicTexts) {
  return topicTexts.some((text) => ADDRESS_AFTER_BOOKING_RE.test(String(text || "")));
}

// ---------------------------------------------------------------- external calendars
const EXTERNAL_APP_RE = /\b(square( appointments)?|booksy|fresha|vagaro|mindbody|glossgenius|schedulicity|setmore|acuity|calendly|styleseat|google cal(endar)?|gcal|planity|salonized|timely)\b/i;
// The client talks about a booking that already exists somewhere else.
const EXISTING_BOOKING_RE = /\b(my|our)\b.{0,30}(booking|appointment|reservation|slot)|\bbooked\b|made (a|an|my) (booking|appointment|reservation)|\b(i|we) (have|had) an? (booking|appointment)|\bmon (rendez-vous|rdv)|\bma réservation|j'ai (réservé|pris (un )?(rendez-vous|rdv)|un (rendez-vous|rdv))|réservé (sur|via|dans|avec)|мо(ю|я|ей) запис|мой визит|записал(ась|ся|и)|я записан|моя бронь|забронировал|мій запис|записав(ся)?|записалас[ья]/i;

function externalBookingMention(text) {
  const value = String(text || "");
  const app = value.match(EXTERNAL_APP_RE);
  if (!app) return null;
  const name = app[1].replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Gcal$/i, "Google Calendar");
  return { app: name, booking: EXISTING_BOOKING_RE.test(value) };
}

// ---------------------------------------------------------------- claim scoping
// A sentence that talks ABOUT a booking without claiming it happened: a
// condition ("once you're booked"), a future step, a question or a negation.
const NON_CLAIM_RE = /\b(once|after|when|until|unless|if|as soon as|before|will|would|could|can|to get|not|isn'?t|aren'?t|haven'?t|hasn'?t|yet)\b|dès que|une fois|après|quand|lorsque|jusqu|avant|si |pas encore|n'est pas|pour être|после|когда|как только|если|до того|ещё не|еще не|пока не|після|коли|щойно|якщо|ще не|поки не/i;

function sentences(text) {
  return String(text || "").split(/(?<=[.!?…])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
}

// Only the words BEFORE the claim can make it conditional: "Once you're
// booked, I'll send the address" is not a claim; "You're booked, if plans
// change just write" is.
function affirmsBooking(reply, claimRe) {
  return sentences(reply).some((sentence) => {
    if (/\?\s*$/.test(sentence)) return false;
    const match = sentence.match(claimRe);
    if (!match) return false;
    const before = sentence.slice(0, match.index);
    return !NON_CLAIM_RE.test(before);
  });
}

// "closed" / "fermé" / "закрыто" / "выходной" / "day off" in a sentence.
const CLOSED_WORD_RE = /\bclosed\b|\bclose[sd]? (on|that)|we'?re not open|not open (on|that)|ferm[ée]e?s?\b|(on |nous )?n'ouvr|закрыт|не работаем|выходной|зачинен|не працюємо|вихідний/i;

module.exports = {
  weekdayIndex,
  parseWorkDays,
  workDaysLabel,
  amountsIn,
  priceKind,
  PRICE_NOTES,
  buildPriceAllowList,
  matchFaqTopics,
  addressIsPrivate,
  externalBookingMention,
  affirmsBooking,
  sentences,
  CLOSED_WORD_RE,
  WEEKDAY_SHORT
};
