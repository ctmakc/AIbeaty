// Language handling for Maya: which language the CLIENT writes in, and
// whether a reply is written in it.
//
// Rule of the house: Maya answers in the client's language. The salon's own
// language (or the language of the owner's UI) never decides it on its own.
// Resolution order for a turn:
//   1. an explicit request in this message ("please answer in English",
//      "en français svp", "по-русски") — it also LOCKS the conversation;
//   2. a lock set earlier in the conversation;
//   3. the language this message is confidently written in;
//   4. the language of the conversation so far (short replies like "ok",
//      "14:00" or a phone number keep it);
//   5. the channel's hint (Telegram language_code, the browser language);
//   6. the salon's language;
//   7. English.
// Supported for templates: en, fr, ru, uk. Anything else is answered by the
// model "in the client's language" on a best-effort basis, with English
// templates as the fallback.

const SUPPORTED = ["en", "fr", "ru", "uk"];

const LANGUAGE_NAMES = {
  en: "English",
  fr: "French (Canadian French is fine)",
  ru: "Russian",
  uk: "Ukrainian"
};

function normalizeLanguageCode(value) {
  const code = String(value || "").trim().toLowerCase().slice(0, 2);
  if (code === "be") return "ru";
  return SUPPORTED.includes(code) ? code : "";
}

const CYRILLIC_RE = /[а-яёіїєґ]/i;
const CYRILLIC_G = /[а-яёіїєґ]/gi;
const LATIN_G = /[a-zàâäçéèêëîïôöùûüÿœæ]/gi;
const UK_ONLY_RE = /[іїєґ]/i;
// Words that are Ukrainian but carry no uk-only letter.
const UK_WORDS_RE = /(^|[^а-яёіїєґ])(що|чи|як|коли|скільки|будь ласка|дякую|так, будь|мені|можна записатися|хочу записатися на|вітаю|добрий|привіт)(?=$|[^а-яёіїєґ])/i;

const FR_ACCENT_RE = /[àâçéèêëîïôûùœ]/i;
// Common French words; single hits of short words are weak, so the score counts them.
const FR_WORDS = [
  "bonjour", "bonsoir", "salut", "merci", "oui", "ouais", "non", "je", "j'", "vous", "tu", "est", "c'est", "c’est",
  "le", "la", "les", "des", "une", "un", "pour", "avec", "chez", "demain", "aujourd'hui", "aujourd’hui", "après-demain",
  "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche", "semaine", "prochain", "prochaine",
  "rendez-vous", "rdv", "coupe", "barbe", "cheveux", "ongles", "prix", "combien", "coûte", "coute", "quel", "quelle",
  "quand", "heure", "heures", "matin", "soir", "après-midi", "disponible", "dispo", "possible", "svp", "s'il", "plaît", "plait",
  "voudrais", "veux", "aimerais", "peux", "pouvez", "est-ce", "qu'", "d'accord", "parfait", "bien", "mon", "ma", "mes",
  "nom", "appelle", "m'appelle", "réserver", "reserver", "prendre", "français", "francais", "parlez", "bon", "et", "du", "au", "aux"
];
const EN_WORDS = [
  "hi", "hello", "hey", "thanks", "thank", "yes", "yeah", "yep", "no", "i", "i'm", "i’m", "you", "your", "is", "are", "the",
  "a", "an", "for", "with", "tomorrow", "today", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "week", "next", "appointment", "book", "booking", "cut", "hair", "nails", "price", "how", "much", "what", "when", "time",
  "morning", "evening", "afternoon", "available", "please", "can", "could", "would", "like", "want", "need", "my", "name",
  "do", "does", "have", "english", "speak", "and", "of", "to", "it", "that", "this", "cost", "sure", "okay", "ok", "perfect", "great"
];
const FR_SET = new Set(FR_WORDS);
const EN_SET = new Set(EN_WORDS);
// Words both lists share or that are too short to count on their own.
const AMBIGUOUS = new Set(["ok", "no", "non", "a", "parfait", "perfect", "et", "an"]);

function tokens(text) {
  return String(text || "").toLowerCase().replace(/[’]/g, "'").split(/[^a-zàâäçéèêëîïôöùûüÿœæ'-]+/i).filter(Boolean);
}

function latinScores(text) {
  let fr = 0;
  let en = 0;
  for (const raw of tokens(text)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (!word) continue;
    // French elisions: j'ai, c'est, qu'il, d'accord, m'appelle, l'adresse, s'il
    if (/^(j|c|qu|d|m|l|s|n|t)'[a-zàâçéèêëîïôûùœ]/i.test(word)) { fr += 2; continue; }
    if (AMBIGUOUS.has(word)) continue;
    if (FR_SET.has(word)) fr += word.length <= 2 ? 0.5 : 1;
    if (EN_SET.has(word)) en += word.length <= 2 ? 0.5 : 1;
  }
  if (FR_ACCENT_RE.test(text)) fr += 2;
  return { fr, en };
}

// Returns { language, confident }. `language` is "" when the text has no
// letters worth judging (a time, a phone number, an emoji).
function detectMessageLanguage(text) {
  const value = String(text || "");
  const cyr = (value.match(CYRILLIC_G) || []).length;
  const lat = (value.match(LATIN_G) || []).length;
  if (!cyr && !lat) return { language: "", confident: false };
  if (cyr >= lat) {
    const language = UK_ONLY_RE.test(value) || UK_WORDS_RE.test(value) ? "uk" : "ru";
    return { language, confident: cyr >= 3 };
  }
  const { fr, en } = latinScores(value);
  if (fr === 0 && en === 0) {
    // Letters, but no known word ("Nadia 289-555-0123", "Jason Lee"): no opinion.
    return { language: "", confident: false };
  }
  if (fr > en) return { language: "fr", confident: fr >= 1.5 || fr - en >= 1 };
  if (en > fr) return { language: "en", confident: en >= 1.5 || en - fr >= 1 };
  return { language: "", confident: false };
}

// Legacy single-value detector kept for callers and tests that only need a code.
function detectLanguage(text) {
  const { language } = detectMessageLanguage(text);
  return language || (CYRILLIC_RE.test(String(text || "")) ? "ru" : "en");
}

// "please answer in English", "can you speak French", "en français svp",
// "по-русски пожалуйста", "українською".
const EXPLICIT_REQUESTS = [
  { language: "en", re: /\b(in english|english please|speak english|write in english|answer in english|reply in english|en anglais)\b|по-английски|англійською|на английском/i },
  { language: "fr", re: /\b(in french|en fran[cç]ais|parlez[- ]vous fran[cç]ais|speak french|french please|fran[cç]ais svp|fran[cç]ais s'il vous pla[iî]t)\b|по-французски|французькою|на французском/i },
  { language: "ru", re: /по-русски|на русском|in russian|en russe|російською/i },
  { language: "uk", re: /українською|по-українськи|по-украински|на украинском|in ukrainian|en ukrainien/i }
];

function explicitLanguageRequest(text) {
  const value = String(text || "");
  for (const entry of EXPLICIT_REQUESTS) {
    if (entry.re.test(value)) return entry.language;
  }
  return "";
}

// Picks the language for this turn and updates the lock. `state` is the
// session's persisted state object (mutated: state.languageLock).
function resolveTurnLanguage({ text, state = {}, hint = "", salonLanguage = "" }) {
  const requested = explicitLanguageRequest(text);
  if (requested) {
    state.languageLock = requested;
    state.conversationLanguage = requested;
    return { language: requested, source: "explicit" };
  }
  if (state.languageLock) return { language: state.languageLock, source: "lock" };
  const detected = detectMessageLanguage(text);
  if (detected.language && detected.confident) {
    state.conversationLanguage = detected.language;
    return { language: detected.language, source: "message" };
  }
  if (state.conversationLanguage) return { language: state.conversationLanguage, source: "conversation" };
  const fromHint = normalizeLanguageCode(hint);
  if (detected.language) {
    // A weak signal from the text still beats a hint in a different script:
    // Cyrillic text is never answered in English because of an en phone.
    if (detected.language === "ru" || detected.language === "uk") return { language: detected.language, source: "message_weak" };
    if (fromHint && fromHint !== "ru" && fromHint !== "uk") return { language: fromHint, source: "hint" };
    return { language: detected.language, source: "message_weak" };
  }
  if (fromHint) return { language: fromHint, source: "hint" };
  const salon = normalizeLanguageCode(salonLanguage);
  if (salon) return { language: salon, source: "salon" };
  return { language: "en", source: "default" };
}

// Share of Cyrillic letters in a reply, ignoring the names we were told to
// keep as spelled (a Cyrillic staff name inside an English reply is fine).
function cyrillicShare(reply, keepNames = []) {
  let value = String(reply || "");
  for (const name of keepNames) {
    if (name) value = value.split(name).join(" ");
  }
  const cyr = (value.match(CYRILLIC_G) || []).length;
  const lat = (value.match(LATIN_G) || []).length;
  if (!cyr) return 0;
  return cyr / (cyr + lat);
}

// True when `reply` is not written in `language`. Only judges what can be
// judged reliably: script (Cyrillic vs Latin) and, between the two Latin
// languages we support, a clear French/English split.
function replyLanguageMismatch(reply, language, keepNames = []) {
  const value = String(reply || "").trim();
  if (!value) return false;
  const share = cyrillicShare(value, keepNames);
  if (language === "en" || language === "fr") {
    if (share > 0.08) return true;
    const { fr, en } = latinScores(value);
    if (language === "fr" && en >= 3 && en > fr * 2) return true;
    if (language === "en" && fr >= 3 && fr > en * 2) return true;
    return false;
  }
  if (language === "ru" || language === "uk") {
    const lat = (value.match(LATIN_G) || []).length;
    const cyr = (value.match(CYRILLIC_G) || []).length;
    // Mostly Latin text to a Cyrillic writer (names and service titles aside).
    return cyr === 0 && lat > 40;
  }
  return false;
}

function languageName(code) {
  return LANGUAGE_NAMES[code] || "the language the client writes in";
}

// The phrase a client can type to reach a person, per language. The code
// trigger in assistant.js recognises all of them.
const HUMAN_PHRASE = {
  en: "human",
  fr: "humain",
  ru: "позвать человека",
  uk: "покликати людину"
};

module.exports = {
  SUPPORTED,
  normalizeLanguageCode,
  detectMessageLanguage,
  detectLanguage,
  explicitLanguageRequest,
  resolveTurnLanguage,
  replyLanguageMismatch,
  cyrillicShare,
  languageName,
  HUMAN_PHRASE
};
