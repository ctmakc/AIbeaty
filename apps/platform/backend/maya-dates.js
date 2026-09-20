// Server-side date resolution for Maya.
//
// The model never guesses a date or a year. Everything here works on the
// salon's local calendar date ("today" as YYYY-MM-DD in the salon timezone)
// and returns day OFFSETS from it, the unit the booking tables use.
//
// Understood (en / fr / ru / uk):
//   today, tonight, tomorrow, the day after tomorrow
//   weekdays, with "next" / "this" ("next Thursday", "jeudi prochain",
//   "в следующий четверг", "наступного четверга")
//   month + day in words ("Sep 24", "September 24th", "24 septembre",
//   "24 сентября", "24 вересня"), with or without a year
//   ISO dates (2026-09-24); a wrong year from the model is corrected to the
//   nearest matching future date
//   "the 24th", "le 24", "24-го", "24 числа"
//   "in 3 days", "dans 3 jours", "через 3 дня"
//   numeric day.month when unambiguous (24.09, 24/09)
// Returns { offset } or { error: "date_in_past" | "date_out_of_range" |
// "unparsed_day" }. A parse never returns a negative offset.

const MAX_OFFSET = 60;
const DAY_MS = 86400000;

const WEEKDAY_PATTERNS = [
  { index: 0, re: /(^|[^\p{L}])(sunday|sun\.?|dimanche|воскресень[еяю]|воскресенье|неділ[яюі])(?=$|[^\p{L}])/iu },
  { index: 1, re: /(^|[^\p{L}])(monday|lundi|понедельник[а]?|понеділ(ок|ка))(?=$|[^\p{L}])/iu },
  { index: 2, re: /(^|[^\p{L}])(tuesday|tue\.?|tues\.?|mardi|вторник[а]?|вівтор(ок|ка))(?=$|[^\p{L}])/iu },
  { index: 3, re: /(^|[^\p{L}])(wednesday|wed\.?|mercredi|сред[аыу]|серед[аиу])(?=$|[^\p{L}])/iu },
  { index: 4, re: /(^|[^\p{L}])(thursday|thu\.?|thurs\.?|jeudi|четверг[а]?|четвер[а]?)(?=$|[^\p{L}])/iu },
  { index: 5, re: /(^|[^\p{L}])(friday|fri\.?|vendredi|пятниц[аыу]|п'?ятниц[яіюи]|п’ятниц[яіюи])(?=$|[^\p{L}])/iu },
  { index: 6, re: /(^|[^\p{L}])(saturday|sat\.?|samedi|суббот[аыу]|субот[аиу])(?=$|[^\p{L}])/iu }
];

const MONTHS = [
  /^(jan|january|janv|janvier|январ[ьяе]|січ(ень|ня))\.?$/i,
  /^(feb|february|févr|fevr|février|fevrier|феврал[ьяе]|лют(ий|ого))\.?$/i,
  /^(mar|march|mars|март[аe]?|берез(ень|ня))\.?$/i,
  /^(apr|april|avr|avril|апрел[ьяе]|квіт(ень|ня))\.?$/i,
  /^(may|mai|ма[йяе]|трав(ень|ня))\.?$/i,
  /^(jun|june|juin|июн[ьяе]|черв(ень|ня))\.?$/i,
  /^(jul|july|juil|juillet|июл[ьяе]|лип(ень|ня))\.?$/i,
  /^(aug|august|août|aout|август[аe]?|серп(ень|ня))\.?$/i,
  /^(sep|sept|september|septembre|сентябр[ьяе]|верес(ень|ня))\.?$/i,
  /^(oct|october|octobre|октябр[ьяе]|жовт(ень|ня))\.?$/i,
  /^(nov|november|novembre|ноябр[ьяе]|листопад[а]?)\.?$/i,
  /^(dec|december|déc|dec|décembre|decembre|декабр[ьяе]|груд(ень|ня))\.?$/i
];

function monthIndex(word) {
  const value = String(word || "").toLowerCase();
  for (let i = 0; i < MONTHS.length; i++) if (MONTHS[i].test(value)) return i;
  return -1;
}

function isoToUtc(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso, days) {
  return utcToIso(isoToUtc(iso) + days * DAY_MS);
}

function weekdayOf(iso) {
  return new Date(isoToUtc(iso)).getUTCDay();
}

function offsetBetween(todayIso, iso) {
  return Math.round((isoToUtc(iso) - isoToUtc(todayIso)) / DAY_MS);
}

function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d;
}

function withOffset(offset) {
  if (offset < 0) return { error: "date_in_past" };
  if (offset > MAX_OFFSET) return { error: "date_out_of_range" };
  return { offset };
}

// Month/day without a trustworthy year: the nearest occurrence that is not in
// the past. A date from the last week is reported as past (the client most
// likely means it and needs to hear it is gone); older ones roll to next year.
function resolveMonthDay(todayIso, month, day, explicitYear) {
  const todayYear = Number(todayIso.slice(0, 4));
  if (explicitYear && explicitYear >= todayYear && validDate(explicitYear, month, day)) {
    return withOffset(offsetBetween(todayIso, utcToIso(Date.UTC(explicitYear, month, day))));
  }
  for (const year of [todayYear, todayYear + 1]) {
    if (!validDate(year, month, day)) continue;
    const offset = offsetBetween(todayIso, utcToIso(Date.UTC(year, month, day)));
    if (offset >= 0) return withOffset(offset);
    if (offset >= -7) return { error: "date_in_past" };
  }
  return { error: "unparsed_day" };
}

function resolveDayOfMonth(todayIso, day) {
  const year = Number(todayIso.slice(0, 4));
  const month = Number(todayIso.slice(5, 7)) - 1;
  const today = Number(todayIso.slice(8, 10));
  if (day >= today && validDate(year, month, day)) return withOffset(day - today);
  const nextMonth = (month + 1) % 12;
  const nextYear = month === 11 ? year + 1 : year;
  if (validDate(nextYear, nextMonth, day)) return withOffset(offsetBetween(todayIso, utcToIso(Date.UTC(nextYear, nextMonth, day))));
  return { error: "unparsed_day" };
}

const NEXT_RE = /(next|prochain|prochaine|следующ|наступн)/i;
// "this Friday" / "ce vendredi" / "в эту пятницу" said on a Friday: today, even after closing.
const THIS_RE = /(^|[^\p{L}])(this|ce|cette|эт[аоуи]|цю|цей|ця|сегодня|сьогодні|today|aujourd'hui)(?=$|[^\p{L}])/iu;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, "один": 1, "два": 2, "три": 3, "четыре": 4, "пять": 5, "один день": 1 };

// Finds every date expression in free text. Each hit: { phrase, offset } or
// { phrase, error }.
// opts.todayOver: the salon is closed for the rest of today (after closing,
// or not open today at all). A bare weekday that names today then means the
// same weekday next week ("Friday" said on a Friday evening).
function findDateExpressions(text, todayIso, opts = {}) {
  const value = String(text || "");
  const lower = value.toLowerCase().replace(/[’]/g, "'");
  const hits = [];
  const push = (phrase, result) => { if (result) hits.push(Object.assign({ phrase }, result)); };

  // ISO first (tools, and clients who type it).
  const isoRe = /(\d{4})-(\d{2})-(\d{2})/g;
  let match;
  while ((match = isoRe.exec(lower)) !== null) {
    const y = Number(match[1]); const m = Number(match[2]) - 1; const d = Number(match[3]);
    if (!validDate(y, m, d)) { push(match[0], { error: "unparsed_day" }); continue; }
    const offset = offsetBetween(todayIso, match[0]);
    if (offset >= 0) push(match[0], withOffset(offset));
    else if (y < Number(todayIso.slice(0, 4))) push(match[0], resolveMonthDay(todayIso, m, d)); // model guessed a past year
    else push(match[0], { error: "date_in_past" });
  }
  if (hits.length) return hits;

  if (/(the day after tomorrow|après-demain|apres-demain|après demain|послезавтра|післязавтра)/i.test(lower)) push("day_after_tomorrow", { offset: 2 });
  else if (/(^|[^\p{L}])(tomorrow|tmrw|tmr|demain|завтра|завтрашн)/iu.test(lower)) push("tomorrow", { offset: 1 });
  if (/(^|[^\p{L}])(today|tonight|this evening|aujourd'hui|ce soir|сегодня|сьогодні|сейчас|now)(?=$|[^\p{L}])/iu.test(lower)) push("today", { offset: 0 });

  const inDays = lower.match(/(?:in|dans|через)\s+(\d{1,2}|[a-zа-яё]+)\s+(days?|jours?|дн[яей]|день|дні|днів)/i);
  if (inDays) {
    const n = /^\d+$/.test(inDays[1]) ? Number(inDays[1]) : NUMBER_WORDS[inDays[1]];
    if (n) push(inDays[0], withOffset(n));
  }

  // Month in words + day ("Sep 24", "24 septembre", "24 сентября", optional year).
  // The day number may not be a slice of a longer number: without the
  // lookarounds, "mardi 22 septembre 2026" also matched "septembre 20" and
  // resolved to September 20 — the wrong day, and the first hit in the list.
  const wordDateRe = /(?<!\d)(\d{1,2})(?:st|nd|rd|th|er|e|-?го|-?е)?(?!\d)\s+(?:de\s+)?([a-zà-ÿа-яёіїєґ]{3,}\.?)(?:,?\s+(\d{4}))?|([a-zà-ÿа-яёіїєґ]{3,}\.?)\s+(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?!\d)(?:,?\s+(\d{4}))?/giu;
  while ((match = wordDateRe.exec(lower)) !== null) {
    const day = Number(match[1] || match[5]);
    const month = monthIndex(match[2] || match[4]);
    const year = Number(match[3] || match[6]) || 0;
    if (month < 0 || !day || day > 31) continue;
    push(match[0].trim(), resolveMonthDay(todayIso, month, day - 0, year));
  }

  // Numeric day.month / day/month when unambiguous (the day part > 12, or a dot).
  const numRe = /(^|[^\d:])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/g;
  while ((match = numRe.exec(lower)) !== null) {
    const a = Number(match[2]); const b = Number(match[3]);
    const dotted = match[0].includes(".");
    let day = 0; let month = -1;
    if (a > 12 && b <= 12) { day = a; month = b - 1; }
    else if (b > 12 && a <= 12 && !dotted) { day = b; month = a - 1; }
    else if (dotted && b <= 12) { day = a; month = b - 1; }
    if (month < 0 || !day) continue;
    const year = match[4] ? Number(match[4].length === 2 ? `20${match[4]}` : match[4]) : 0;
    push(match[0].replace(/^[^\d]/, ""), resolveMonthDay(todayIso, month, day, year));
  }

  // "the 24th", "le 24", "24-го", "24 числа" (day of month only).
  const domRe = /(?:the\s+(\d{1,2})(?:st|nd|rd|th)|(?:^|\s)le\s+(\d{1,2})(?=$|[^\d:h])|(\d{1,2})-?го(?=$|[^\p{L}])|(\d{1,2})\s+числа)/giu;
  while ((match = domRe.exec(lower)) !== null) {
    const day = Number(match[1] || match[2] || match[3] || match[4]);
    if (day >= 1 && day <= 31 && !hits.some((hit) => hit.phrase.includes(String(day)))) push(match[0].trim(), resolveDayOfMonth(todayIso, day));
  }

  // Weekdays.
  const todayWeekday = weekdayOf(todayIso);
  for (const day of WEEKDAY_PATTERNS) {
    const found = day.re.exec(lower);
    if (!found) continue;
    let offset = (day.index - todayWeekday + 7) % 7;
    const around = lower.slice(Math.max(0, found.index - 14), found.index + found[0].length + 12);
    if (offset === 0 && (NEXT_RE.test(around) || (opts.todayOver && !THIS_RE.test(around)))) offset = 7;
    push(found[2], withOffset(offset));
  }
  return hits;
}

// Tool argument → offset. A plain number is an offset (the engine's own
// commit path passes one). Empty means today.
function parseDayArgument(input, todayIso, opts = {}) {
  const text = String(input || "").trim();
  if (!text) return { offset: 0 };
  const plain = text.match(/^\+?(\d{1,2})$/);
  if (plain) return withOffset(Number(plain[1]));
  const hits = findDateExpressions(text, todayIso, opts);
  if (!hits.length) return { error: "unparsed_day" };
  // An explicit date beats a weekday word in the same argument ("Thu 2026-09-24").
  const best = hits.find((hit) => hit.offset !== undefined) || hits[0];
  return best.offset !== undefined ? { offset: best.offset } : { error: best.error };
}

// A year in a reply other than this one or the next is always a slip of the
// model ("Sep 19, 2024"). Dates with a wrong year get the year the calendar
// gives that month/day (the next one on or after today).
const MONTH_WORD_SRC = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|январ[яь]|феврал[яь]|марта?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|августа?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь]|січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\\.?";
function fixReplyYears(text, todayIso) {
  const value = String(text || "");
  const thisYear = Number(String(todayIso).slice(0, 4));
  const ok = (year) => year === thisYear || year === thisYear + 1;
  // This year unless that date is more than a week gone, then next year.
  const yearFor = (month, day) => {
    if (!validDate(thisYear, month, day)) return thisYear + 1;
    const offset = offsetBetween(todayIso, utcToIso(Date.UTC(thisYear, month, day)));
    return offset >= -7 ? thisYear : thisYear + 1;
  };
  let out = value.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y, m, d) => {
    const year = Number(y);
    if (ok(year) || !validDate(thisYear, Number(m) - 1, Number(d))) return whole;
    return `${yearFor(Number(m) - 1, Number(d))}-${m}-${d}`;
  });
  const monthFirst = new RegExp(`(?<![\\p{L}])(${MONTH_WORD_SRC})(\\s+)(\\d{1,2})(?:st|nd|rd|th)?(,?\\s+)((?:19|20)\\d{2})\\b`, "giu");
  out = out.replace(monthFirst, (whole, monthWord, gap, day, sep, year) => {
    if (ok(Number(year))) return whole;
    const month = monthIndex(monthWord);
    if (month < 0) return whole;
    return whole.slice(0, whole.length - year.length) + String(yearFor(month, Number(day)));
  });
  const dayFirst = new RegExp(`(\\d{1,2})(?:er|e|-?го)?(\\s+)(?:de\\s+)?(${MONTH_WORD_SRC})(,?\\s+)((?:19|20)\\d{2})\\b`, "giu");
  out = out.replace(dayFirst, (whole, day, gap, monthWord, sep, year) => {
    if (ok(Number(year))) return whole;
    const month = monthIndex(monthWord);
    if (month < 0) return whole;
    return whole.slice(0, whole.length - year.length) + String(yearFor(month, Number(day)));
  });
  return out;
}

function hasStrayYear(text, todayIso) {
  const thisYear = Number(String(todayIso).slice(0, 4));
  return (String(text || "").match(/\b20\d{2}\b/g) || []).some((y) => Number(y) !== thisYear && Number(y) !== thisYear + 1);
}

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The calendar block injected into every turn. hoursLabel(offset) returns
// "9:00-19:00" or "closed".
function calendarBlock({ todayIso, timezone, nowLabel, days = 14, hoursLabel }) {
  const year = todayIso.slice(0, 4);
  const lines = [];
  for (let offset = 0; offset < days; offset++) {
    const iso = addDays(todayIso, offset);
    const tag = offset === 0 ? " (today)" : offset === 1 ? " (tomorrow)" : "";
    const hours = typeof hoursLabel === "function" ? hoursLabel(offset) : "";
    lines.push(`${iso} ${WEEKDAY_EN[weekdayOf(iso)]}${tag}${hours ? `: salon hours ${hours}` : ""}`);
  }
  return `# TODAY (salon time zone ${timezone})
Today is ${WEEKDAY_EN[weekdayOf(todayIso)]} ${todayIso}. The year is ${year}. Salon time now: ${nowLabel}.
Calendar for the next ${days} days (use these exact dates in tool calls):
${lines.join("\n")}`;
}

module.exports = {
  findDateExpressions,
  parseDayArgument,
  fixReplyYears,
  hasStrayYear,
  calendarBlock,
  addDays,
  weekdayOf,
  offsetBetween,
  WEEKDAY_EN,
  MAX_OFFSET
};
