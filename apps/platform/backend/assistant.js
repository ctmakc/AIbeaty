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
const BUSINESS_START_MINUTES = 9 * 60; // matches the schedule grid (minutesToTop base 540)
const BUSINESS_END_MINUTES = 19 * 60;
const SLOT_STEP_MINUTES = 30;
const CLOSED_WEEKDAYS = [0, 1]; // Sunday, Monday — per salon-faq.json hours
const HISTORY_LIMIT = 16;

function createId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dayString(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function isAffirmation(text) {
  const value = String(text || "").trim().toLowerCase();
  if (/^(да|ага|угу|конечно|давай(те)?|подтверждаю|верно|точно|ок|окей|хорошо|ага давай|yes|yep|yeah|sure|ok|okay|confirm|correct|right|так|авжеж|добре|підтверджую)[\s!.,)"”👍🙏❤️]*$/i.test(value)) return true;
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

function localized(pack, language) {
  return pack[language] || pack.ru;
}

// --- service / stylist / day / time resolution -----------------------------
const SERVICE_ALIASES = [
  { re: /балаяж|balayage|airtouch|аиртач/i, names: ["Full Balayage"] },
  { re: /мужск|men'?s|чоловіч/i, names: ["Men's Scissor Cut"] },
  { re: /женск|жіноч|women|precision/i, names: ["Women's Precision Cut"] },
  { re: /укладк|blowout|blow[- ]dry|styling|style|зачіск/i, names: ["Blowout & Style"] },
  { re: /корн|root|тониров|тонуван|touch[- ]?up/i, names: ["Single Process Root Touch-up"] },
  { re: /окраш|окрас|покрас|фарбуван|colou?r|краск|краси(ть|т)/i, names: ["Full Balayage", "Single Process Root Touch-up"] },
  { re: /стрижк|подстри|hair\s?cut|cut\b|підстри/i, names: ["Women's Precision Cut", "Men's Scissor Cut"] }
];

const STYLIST_ALIASES = [
  { re: /сара|sarah|дженкинс|jenkins/i, name: "Sarah Jenkins" },
  { re: /майкл|михаил|michael|чанг|chang|мишель/i, name: "Michael Chang" },
  { re: /елен|элен|olena|elena|ростов|rostova|олен/i, name: "Elena Rostova" }
];

const WEEKDAYS = [
  { index: 0, re: /воскресень|неділ|sunday|\bвс\b|\bsun\b/i },
  { index: 1, re: /понедельник|понеділок|monday|\bпн\b|\bmon\b/i },
  { index: 2, re: /вторник|вівторок|tuesday|\bвт\b|\btue\b/i },
  { index: 3, re: /среда|среду|середа|середу|wednesday|\bср\b|\bwed\b/i },
  { index: 4, re: /четверг|четвер|thursday|\bчт\b|\bthu\b/i },
  { index: 5, re: /пятниц|п'ятниц|friday|\bпт\b|\bfri\b/i },
  { index: 6, re: /суббот|субот|saturday|\bсб\b|\bsat\b/i }
];

function createAssistant({ store, llm, faqPath }) {
  const db = store.db;
  const resolvedFaqPath = faqPath || path.join(__dirname, "..", "data", "salon-faq.json");
  const faq = JSON.parse(fs.readFileSync(resolvedFaqPath, "utf8"));
  const rateBuckets = new Map();

  // ---------- persistence helpers ----------
  function recordEvent(session, type, payload = {}) {
    db.prepare(`
      INSERT INTO assistant_events (id, session_id, conversation_id, day, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("aevt"),
      session.id,
      session.conversation_id || "",
      dayString(),
      type,
      JSON.stringify(payload),
      new Date().toISOString()
    );
  }

  function loadSession(sessionId) {
    const row = db.prepare(`SELECT * FROM assistant_sessions WHERE id = ?`).get(sessionId);
    if (!row) return null;
    row.state = JSON.parse(row.state_json || "{}");
    return row;
  }

  function saveSession(session) {
    session.updated_at = new Date().toISOString();
    db.prepare(`
      UPDATE assistant_sessions
      SET conversation_id = ?, client_id = ?, client_phone = ?, channel = ?, language = ?, state_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      session.conversation_id,
      session.client_id || "",
      session.client_phone || "",
      session.channel,
      session.language,
      JSON.stringify(session.state || {}),
      session.updated_at,
      session.id
    );
  }

  function findClientByPhone(phone) {
    const wanted = digitsOnly(phone);
    if (wanted.length < 7) return null;
    const rows = db.prepare(`SELECT * FROM clients`).all();
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
      UPDATE conversations SET assistant_session_id = ?, assistant_state = 'active' WHERE id = ?
    `).run(sessionId, conversationId);
    db.prepare(`
      INSERT INTO assistant_sessions (id, conversation_id, client_id, client_phone, channel, language, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(
      sessionId,
      conversationId,
      knownClient ? knownClient.id : "",
      clientPhone || "",
      channel || "Webchat",
      language || "ru",
      now,
      now
    );
    const session2 = loadSession(sessionId);
    recordEvent(session2, "session_started", { channel: channel || "Webchat", client: guestName });
    return session2;
  }

  function getConversationRow(conversationId) {
    return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
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
      WHERE conversation_id = ? AND type IN ('incoming', 'outgoing')
      ORDER BY sort_order ASC
    `).all(session.conversation_id);
    return rows.slice(-HISTORY_LIMIT).map((row) => ({
      role: row.type === "incoming" ? "user" : "assistant",
      content: row.text_value
    }));
  }

  function rateLimited(sessionId) {
    const now = Date.now();
    const bucket = (rateBuckets.get(sessionId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (bucket.length >= RATE_LIMIT_MAX) {
      rateBuckets.set(sessionId, bucket);
      return true;
    }
    bucket.push(now);
    rateBuckets.set(sessionId, bucket);
    return false;
  }

  // ---------- domain resolution ----------
  function allServices() {
    return db.prepare(`
      SELECT s.*, c.name AS category_name FROM services s
      JOIN service_categories c ON c.id = s.category_id
      ORDER BY s.sort_order ASC
    `).all();
  }

  function resolveServices(query) {
    const text = String(query || "").trim();
    if (!text) return [];
    const rows = allServices();
    const direct = rows.filter((row) => row.name.toLowerCase().includes(text.toLowerCase()));
    if (direct.length) return direct;
    // First matching alias wins — the list is ordered specific → generic, so
    // "женская стрижка" resolves to one service instead of the whole "стрижка" family.
    for (const alias of SERVICE_ALIASES) {
      if (alias.re.test(text)) {
        return rows.filter((row) => alias.names.includes(row.name));
      }
    }
    return [];
  }

  function resolveStylist(query) {
    const text = String(query || "").trim();
    if (!text) return null;
    for (const alias of STYLIST_ALIASES) {
      if (alias.re.test(text)) {
        return db.prepare(`SELECT * FROM stylists WHERE name = ?`).get(alias.name) || null;
      }
    }
    return db.prepare(`SELECT * FROM stylists WHERE lower(name) LIKE ?`).get(`%${text.toLowerCase()}%`) || null;
  }

  function referenceDate() {
    const ref = new Date(store.getLastUpdated());
    return Number.isNaN(ref.getTime()) ? new Date() : ref;
  }

  function resolveDay(input) {
    const text = String(input || "").trim().toLowerCase();
    const ref = referenceDate();
    if (!text || /сегодня|сьогодні|today|now/.test(text)) return { offset: 0 };
    if (/послезавтра|післязавтра/.test(text)) return { offset: 2 };
    if (/завтра|tomorrow/.test(text)) return { offset: 1 };
    const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const target = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      const offset = Math.round((target - base) / 86400000);
      if (offset >= 0 && offset <= 60) return { offset };
      return { error: "date_out_of_range" };
    }
    for (const day of WEEKDAYS) {
      if (day.re.test(text)) {
        let offset = (day.index - ref.getDay() + 7) % 7;
        if (offset === 0 && /следующ|наступн|next/.test(text)) offset = 7;
        return { offset };
      }
    }
    const plain = text.match(/^\+?(\d{1,2})$/);
    if (plain) return { offset: Math.min(30, Number(plain[1])) };
    return { error: "unparsed_day" };
  }

  function dayLabel(offset) {
    const ref = referenceDate();
    const date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset);
    return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }

  function dayWeekday(offset) {
    const ref = referenceDate();
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset).getDay();
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
      WHERE checked_out = 0 AND appointment_status = 'scheduled' AND day_offset = ? AND stylist_id = ?
    `).all(dayOffset, stylistId);
  }

  function slotFree(dayOffset, stylistId, startMinutes, endMinutes) {
    return !busyIntervals(dayOffset, stylistId).some((row) =>
      startMinutes < row.end_minutes && endMinutes > row.start_minutes
    );
  }

  function freeSlots(dayOffset, durationMinutes, stylistRow) {
    const stylists = stylistRow ? [stylistRow] : store.getStylistRows();
    const slots = [];
    for (const stylist of stylists) {
      const open = [];
      for (let start = BUSINESS_START_MINUTES; start + durationMinutes <= BUSINESS_END_MINUTES; start += SLOT_STEP_MINUTES) {
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
    db.prepare(`UPDATE conversations SET assistant_state = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(state, statusLabel, new Date().toISOString(), session.conversation_id);
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
  }

  function leaveOwnerMessage(session, message, topic) {
    recordEvent(session, "owner_message", { message: String(message).slice(0, 500), topic: topic || "" });
    store.logActivity({
      title: "Message for Owner (Maya)",
      meta: String(message).slice(0, 90),
      icon: "mail",
      tone: "tertiary"
    });
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
        JOIN stylists s ON s.id = a.stylist_id WHERE a.id = ?
      `).get(appointmentId) || null;
    }
    if (session.client_id) return store.getActiveAppointmentForClient(session.client_id) || null;
    const conversation = getConversationRow(session.conversation_id);
    if (conversation && conversation.client_id) return store.getActiveAppointmentForClient(conversation.client_id) || null;
    return null;
  }

  function linkConversationToClient(session, clientId) {
    if (!clientId) return;
    session.client_id = clientId;
    db.prepare(`UPDATE conversations SET client_id = ?, updated_at = ? WHERE id = ?`)
      .run(clientId, new Date().toISOString(), session.conversation_id);
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
        const weekday = dayWeekday(day.offset);
        if (CLOSED_WEEKDAYS.includes(weekday)) {
          const alt = { offset: day.offset + (weekday === 0 ? 2 : 1) };
          return {
            closed: true,
            note: `Salon is closed that day (Sun/Mon). Nearest open day: ${dayLabel(alt.offset)}.`,
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
        const slots = freeSlots(day.offset, service.duration_minutes, stylist);
        const payload = {
          service: serviceSummary(session, service),
          day: dayLabel(day.offset),
          slots: slots.map((slot) => ({ stylist: slot.stylist, time: slot.time })),
          note: slots.length ? "Offer 2-3 of these real slots. Times not listed may still be free — check them via the `time` argument." : "No free slots that day; suggest another day."
        };
        if (args.time) {
          const wanted = parseTimeFlexible(args.time);
          if (wanted !== null && wanted >= BUSINESS_START_MINUTES && wanted + service.duration_minutes <= BUSINESS_END_MINUTES) {
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
            payload.requested_time = { time: args.time, available: false, reason: "outside working hours 9:00-19:00" };
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
          note: "Use at most ONE remembered detail, casually. Never recite the whole file."
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
        if (CLOSED_WEEKDAYS.includes(dayWeekday(day.offset))) {
          return { closed: true, note: "Salon is closed Sun/Mon — offer another day." };
        }
        const startMinutes = parseTimeFlexible(args.time);
        if (startMinutes === null) return { error: "unparsed_time", note: "Ask for a concrete time like 14:00." };
        const endMinutes = startMinutes + service.duration_minutes;
        if (startMinutes < BUSINESS_START_MINUTES || endMinutes > BUSINESS_END_MINUTES) {
          return {
            error: "outside_hours",
            note: "Working hours are 9:00-19:00.",
            alternatives: freeSlots(day.offset, service.duration_minutes, null).map((s) => ({ stylist: s.stylist, time: s.time }))
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
        const row = appointmentId ? db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(appointmentId) : null;
        if (!row) {
          leaveOwnerMessage(session, `Не удалось создать запись: ${service.name}, ${dayLabel(day.offset)} ${proposal.timeLabel}, клиент ${clientName}.`, "booking_failed");
          return { status: "failed", note: "DB write failed. Tell the client honestly the booking is NOT confirmed and the owner will follow up within the hour." };
        }
        session.state.pendingAction = null;
        turn.actionCommitted = true;
        linkConversationToClient(session, row.client_id);
        db.prepare(`
          UPDATE conversations SET status = ?, today_service = ?, today_time = ?, today_amount = ?, today_stylist = ?, updated_at = ? WHERE id = ?
        `).run("Booked by Maya AI", service.name, proposal.timeLabel, service.price_label, stylist.name, new Date().toISOString(), session.conversation_id);
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
        if (CLOSED_WEEKDAYS.includes(dayWeekday(day.offset))) return { closed: true, note: "Closed Sun/Mon — offer another day." };
        const startMinutes = parseTimeFlexible(args.time);
        if (startMinutes === null) return { error: "unparsed_time" };
        const duration = target.end_minutes - target.start_minutes;
        const endMinutes = startMinutes + duration;
        if (startMinutes < BUSINESS_START_MINUTES || endMinutes > BUSINESS_END_MINUTES) {
          return { error: "outside_hours", note: "Working hours are 9:00-19:00." };
        }
        const stylist = args.stylist ? resolveStylist(args.stylist) : db.prepare(`SELECT * FROM stylists WHERE id = ?`).get(target.stylist_id);
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
        const check = db.prepare(`SELECT start_minutes, day_offset FROM appointments WHERE id = ?`).get(target.id);
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
        const check = db.prepare(`SELECT appointment_status FROM appointments WHERE id = ?`).get(target.id);
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
        escalate(session, args.reason || "assistant_requested", turn.userMessage);
        return { ok: true, note: "Conversation flagged for a human. Tell the client a person will reply here within the hour, then stay silent." };
      }

      default:
        return { error: `unknown_tool:${name}` };
    }
  }

  // ---------- reply gates ----------
  function gateReply(session, turn, rawReply) {
    let reply = String(rawReply || "").trim();
    const language = session.language || "ru";
    const gates = [];

    if (!reply) {
      gates.push("empty_reply");
      reply = localized(FALLBACKS.unknown, language);
    }

    // Gate 1: booking claims require a committed DB write this turn.
    if (BOOKING_CLAIM_RE.test(reply) && !turn.actionCommitted) {
      gates.push("booking_claim_blocked");
      leaveOwnerMessage(session, `Maya попыталась подтвердить запись без записи в системе. Ответ заменён. Диалог: ${session.conversation_id}`, "booking_gate");
      reply = localized(FALLBACKS.notBooked, language);
    }

    // Gate 2: price quote-guard — every price in the reply must have come from a tool result.
    const allowed = new Set((session.state.quotedPrices || []).map(Number));
    const prices = extractPriceNumbers(reply);
    const unknownPrice = prices.find((price) => !allowed.has(price));
    if (unknownPrice !== undefined) {
      gates.push(`price_guard:${unknownPrice}`);
      leaveOwnerMessage(session, `Maya назвала цену ${unknownPrice}, которой нет в данных инструментов. Ответ заменён. Вопрос клиента: ${String(turn.userMessage).slice(0, 200)}`, "price_guard");
      reply = localized(FALLBACKS.unknown, language);
    }

    // Gate 3: banned phrases (style scrub, non-blocking).
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

    const turn = { userMessage: text, actionCommitted: false, handoffRequested: false, escalateAfter: null };

    // Hard triggers answer without the LLM; soft ones steer this turn then escalate.
    const trigger = checkTriggers(text);
    if (trigger && trigger.hard) {
      const reply = localized(FALLBACKS.handoff, session.language);
      escalate(session, trigger.reason, text);
      persistMessage(session, "outgoing", reply);
      recordEvent(session, "message_out", { text: reply.slice(0, 300), canned: trigger.reason });
      saveSession(session);
      return { reply, state: sessionState(session, { escalated: trigger.reason }) };
    }
    if (trigger) turn.escalateAfter = trigger.reason;

    const isFirstTurn = db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_messages WHERE conversation_id = ? AND type = 'incoming'
    `).get(session.conversation_id).count <= 1;

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
        content: "Клиент жалуется. Режим жалобы: выслушай, назови чувство, извинись один раз, предложи бесплатную коррекцию в 48 часов как «передам владельцу, он подтвердит», вызови request_human_handoff с кратким резюме. Ничего не продавай."
      });
    } else if (turn.escalateAfter) {
      messages.push({
        role: "system",
        content: "Клиент напряжён или спорит о цене. Ответь спокойно и коротко, без продаж, затем вызови request_human_handoff с причиной."
      });
    }
    messages.push(...buildHistoryMessages(session));

    let reply = null;
    try {
      let rounds = 0;
      let current = messages;
      while (rounds < MAX_TOOL_ROUNDS) {
        rounds += 1;
        const assistantMessage = await llm.complete({ messages: current, tools: TOOL_DEFS });
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
      if (reply === null) {
        session.state.failedUnderstandings = (session.state.failedUnderstandings || 0) + 1;
        reply = localized(FALLBACKS.unknown, session.language);
      }
    } catch (error) {
      session.state.failedUnderstandings = (session.state.failedUnderstandings || 0) + 1;
      leaveOwnerMessage(session, `Сбой ИИ-ассистента: ${String(error.message || error).slice(0, 200)}. Клиент ждёт ответа: "${text.slice(0, 150)}"`, "llm_error");
      reply = localized(FALLBACKS.error, session.language);
    }

    const gated = gateReply(session, turn, reply);
    if (gated.gates.some((gate) => gate !== "style_scrub")) {
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
    db.prepare(`UPDATE conversations SET assistant_state = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(state, label, new Date().toISOString(), conversationId);
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

  // ---------- owner digest ----------
  function getDigest(day) {
    const targetDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || "")) ? day : dayString();
    const events = db.prepare(`
      SELECT * FROM assistant_events WHERE day = ? ORDER BY created_at ASC
    `).all(targetDay).map((row) => Object.assign(row, { payload: JSON.parse(row.payload_json || "{}") }));

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
      salon: faq.salon ? faq.salon.name : "Luminous Core",
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
      conversations
    };
  }

  return {
    chat,
    getDigest,
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
      ensureSession,
      loadSession,
      saveSession,
      rateLimited,
      recordEvent,
      TOOL_DEFS
    }
  };
}

module.exports = { createAssistant };
