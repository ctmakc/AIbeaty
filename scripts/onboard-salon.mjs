#!/usr/bin/env node
// Intake importer — turns one filled intake file into a live salon.
//
//   node scripts/onboard-salon.mjs docs/onboarding/example-salon.json --dry-run
//   node scripts/onboard-salon.mjs /path/to/my-salon.json
//
// Input format: ONE format, JSON. It mirrors the paper intake form in
// local-previews/aibeaty-demo/salon-intake.md section by section, so the person
// filling the form and the person typing the JSON are reading the same list.
// docs/onboarding/example-salon.json is a complete filled example.
//
// The import is idempotent: re-running with the same "slug" updates the salon
// in place (services and staff are matched by name) instead of creating a
// second one. Validation errors are plain Russian sentences aimed at the person
// who filled in the form, not at a programmer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");

// ---------------------------------------------------------------------------
// weekday + time parsing
// ---------------------------------------------------------------------------

// JS convention: 0 = Sunday … 6 = Saturday.
const WEEKDAY_KEYS = [
  { index: 0, names: ["sun", "sunday", "вс", "воскресенье", "неділя", "нд"] },
  { index: 1, names: ["mon", "monday", "пн", "понедельник", "понеділок"] },
  { index: 2, names: ["tue", "tues", "tuesday", "вт", "вторник", "вівторок"] },
  { index: 3, names: ["wed", "wednesday", "ср", "среда", "середа"] },
  { index: 4, names: ["thu", "thur", "thurs", "thursday", "чт", "четверг", "четвер"] },
  { index: 5, names: ["fri", "friday", "пт", "пятница", "п'ятниця", "пятниця"] },
  { index: 6, names: ["sat", "saturday", "сб", "суббота", "субота"] }
];

const CLOSED_WORDS = /^(выходной|вихідний|closed|нет|—|-|null)$/i;

function weekdayIndex(key) {
  const normalized = String(key || "").trim().toLowerCase();
  const found = WEEKDAY_KEYS.find((day) => day.names.includes(normalized));
  return found ? found.index : null;
}

function weekdayLabel(index) {
  return ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][index];
}

// "09:00-19:00", "9:00–19:00", "9-19" → { open, close }; "выходной" → null.
function parseHoursValue(value) {
  if (value === null || value === undefined) return { closed: true };
  const text = String(value).trim();
  if (!text || CLOSED_WORDS.test(text)) return { closed: true };
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return { error: true };
  const open = Number(match[1]) * 60 + Number(match[2] || 0);
  const close = Number(match[3]) * 60 + Number(match[4] || 0);
  if (open >= 24 * 60 || close > 24 * 60 || close <= open) return { error: true };
  const pad = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { open: pad(open), close: pad(close) };
}

// "$85", "85", "от $220", "220 CAD" → 220
function parsePrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const digits = String(value || "").replace(/[^\d.,]/g, "").replace(",", ".");
  const parsed = Number.parseFloat(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

function validTimezone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    return false;
  }
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
    .split("")
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// ---------------------------------------------------------------------------
// validation — every message is a sentence the salon owner can act on
// ---------------------------------------------------------------------------

function validate(intake) {
  const errors = [];
  const warnings = [];
  const add = (message) => errors.push(message);

  if (!intake || typeof intake !== "object") {
    return { errors: ["Файл анкеты пустой или это не JSON-объект."], warnings };
  }

  const salon = intake.salon || {};
  if (!String(salon.name || "").trim()) {
    add("Не заполнено название салона (раздел 1 анкеты, поле «Название салона»).");
  }
  const slug = String(intake.slug || "").trim() || slugify(salon.name);
  if (!slug) {
    add("Не удалось составить короткий адрес салона (slug). Впишите его вручную полем \"slug\", латиницей, например \"aurora-nail-lab\".");
  } else if (!/^[a-z0-9-]+$/.test(slug)) {
    add(`Короткий адрес салона «${slug}» содержит недопустимые символы. Разрешены только латинские буквы, цифры и дефис.`);
  }

  const timezone = String(salon.timezone || "").trim();
  if (!timezone) {
    add("Не указан часовой пояс (раздел 2 анкеты). Для Оттавы и Торонто это America/Toronto.");
  } else if (!validTimezone(timezone)) {
    add(`Часовой пояс «${timezone}» не распознан. Нужно название вида America/Toronto или Europe/Kyiv.`);
  }

  // --- hours ---------------------------------------------------------------
  const hours = intake.hours || {};
  const hourKeys = Object.keys(hours);
  if (!hourKeys.length) {
    add("Не заполнен график работы (раздел 2 анкеты). Нужны все семь дней недели.");
  }
  const seenDays = new Set();
  for (const key of hourKeys) {
    const index = weekdayIndex(key);
    if (index === null) {
      add(`В графике работы непонятный день недели: «${key}». Пишите «понедельник», «вторник» … или mon, tue, wed.`);
      continue;
    }
    seenDays.add(index);
    const parsed = parseHoursValue(hours[key]);
    if (parsed.error) {
      add(`Не понял часы работы для дня «${weekdayLabel(index)}»: «${hours[key]}». Пишите так: «09:00-19:00», а для выходного — «выходной».`);
    }
  }
  if (hourKeys.length) {
    for (let index = 0; index < 7; index += 1) {
      if (!seenDays.has(index)) {
        warnings.push(`День «${weekdayLabel(index)}» не указан в графике — Майя будет считать его выходным.`);
      }
    }
  }

  // --- services ------------------------------------------------------------
  const services = Array.isArray(intake.services) ? intake.services : [];
  if (!services.length) {
    add("В анкете нет ни одной услуги (раздел 3). Майе нечего предлагать и не на что записывать.");
  }
  const serviceNames = new Map();
  services.forEach((service, index) => {
    const position = `услуга №${index + 1}`;
    const name = String(service && service.name || "").trim();
    if (!name) {
      add(`У ${position} не заполнено название (раздел 3 анкеты).`);
      return;
    }
    const lower = name.toLowerCase();
    if (serviceNames.has(lower)) {
      add(`Услуга «${name}» встречается в анкете дважды. Оставьте одну строку — или назовите их по-разному.`);
    }
    serviceNames.set(lower, name);

    const duration = Number(service.durationMinutes);
    if (!Number.isFinite(duration) || duration <= 0) {
      add(`У услуги «${name}» не указана длительность в минутах. Без неё Майя не может посчитать свободное время.`);
    } else if (duration % 5 !== 0) {
      warnings.push(`Длительность услуги «${name}» — ${duration} минут; расписание считается шагом в 30 минут, проверьте, что это осознанно.`);
    }
    if (parsePrice(service.price) === null) {
      add(`У услуги «${name}» не разобрана цена: «${service.price}». Напишите числом, например 85 или «$85».`);
    }
  });

  // --- staff ---------------------------------------------------------------
  const staff = Array.isArray(intake.staff) ? intake.staff : [];
  if (!staff.length) {
    add("В анкете нет ни одного мастера (раздел 4). Записывать будет некого и не к кому.");
  }
  const staffNames = new Set();
  staff.forEach((member, index) => {
    const name = String(member && member.name || "").trim();
    if (!name) {
      add(`У мастера №${index + 1} не заполнено имя (раздел 4 анкеты).`);
      return;
    }
    if (staffNames.has(name.toLowerCase())) {
      add(`Мастер «${name}» встречается в анкете дважды. Оставьте одну строку.`);
    }
    staffNames.add(name.toLowerCase());

    const performed = Array.isArray(member.services) ? member.services : [];
    if (!performed.length) {
      warnings.push(`У мастера «${name}» не указано ни одной услуги — Майя будет считать, что он выполняет все.`);
    }
    performed.forEach((serviceName) => {
      if (!serviceNames.has(String(serviceName).trim().toLowerCase())) {
        add(`Мастер ${name} умеет услугу «${serviceName}», но такой услуги в списке нет. Добавьте её в раздел 3 или исправьте название — оно должно совпадать буква в букву.`);
      }
    });

    const workDays = Array.isArray(member.workDays) ? member.workDays : [];
    workDays.forEach((day) => {
      if (weekdayIndex(day) === null) {
        add(`У мастера ${name} непонятный рабочий день: «${day}». Пишите «вторник», «среда» … или tue, wed.`);
      }
    });
  });

  // --- escalation ----------------------------------------------------------
  const escalation = intake.escalation || {};
  if (!String(escalation.who || "").trim()) {
    warnings.push("Не указано, кто отвечает на эскалации (раздел 8). Майя будет передавать диалоги владельцу без имени.");
  }
  if (!String(escalation.notify || "").trim()) {
    warnings.push("Не указано, куда слать уведомления об эскалациях (раздел 8) — письма приходить не будут.");
  }

  return { errors, warnings, slug };
}

// ---------------------------------------------------------------------------
// intake → store shapes
// ---------------------------------------------------------------------------

function buildHours(intake) {
  const hours = {};
  for (let index = 0; index < 7; index += 1) hours[String(index)] = null;
  for (const [key, value] of Object.entries(intake.hours || {})) {
    const index = weekdayIndex(key);
    if (index === null) continue;
    const parsed = parseHoursValue(value);
    hours[String(index)] = parsed.closed || parsed.error ? null : { open: parsed.open, close: parsed.close };
  }
  return hours;
}

function buildCategories(intake) {
  const byCategory = new Map();
  (intake.services || []).forEach((service) => {
    const category = String(service.category || "Услуги").trim() || "Услуги";
    if (!byCategory.has(category)) byCategory.set(category, []);
    const priceValue = parsePrice(service.price) || 0;
    byCategory.get(category).push({
      name: String(service.name).trim(),
      durationMinutes: Number(service.durationMinutes) || 60,
      priceValue,
      // The label keeps the owner's own wording ("от $220") so Maya quotes the
      // salon exactly; priceValue is what the quote-guard checks against.
      priceLabel: typeof service.price === "string" && /[^\d.,\s]/.test(service.price)
        ? service.price.trim()
        : `$${priceValue.toFixed(2)}`,
      requiresDeposit: Boolean(service.requiresDeposit),
      description: String(service.note || "").trim() || `${service.name} — ${category}.`,
      keywords: Array.isArray(service.keywords) ? service.keywords.map((word) => String(word).trim()).filter(Boolean) : []
    });
  });
  return [...byCategory.entries()].map(([name, services]) => ({
    name,
    badge: `${services.length} услуг`,
    icon: "spa",
    tone: "primary",
    services
  }));
}

function buildStaff(intake) {
  return (intake.staff || []).map((member) => ({
    name: String(member.name).trim(),
    role: String(member.role || "Мастер").trim(),
    services: (member.services || []).map((name) => String(name).trim()),
    workDays: (member.workDays || []).map(weekdayIndex).filter((index) => index !== null),
    aliases: Array.isArray(member.aliases) ? member.aliases.map((entry) => String(entry).trim()).filter(Boolean) : []
  }));
}

// FAQ topics are what Maya is allowed to state as fact outside the database.
// Every line here is the owner's own wording from the intake form.
function buildFaqTopics(intake) {
  const topics = [];
  const push = (id, text) => {
    const value = String(text || "").trim();
    if (value) topics.push({ id, ru: value, en: value });
  };

  const hours = intake.hours || {};
  const hoursText = WEEKDAY_KEYS
    .map((day) => {
      const key = Object.keys(hours).find((entry) => weekdayIndex(entry) === day.index);
      if (key === undefined) return null;
      const parsed = parseHoursValue(hours[key]);
      return parsed.closed || parsed.error
        ? `${weekdayLabel(day.index)} — выходной`
        : `${weekdayLabel(day.index)} ${parsed.open}–${parsed.close}`;
    })
    .filter(Boolean)
    .join(", ");
  push("hours", hoursText ? `Мы работаем: ${hoursText}.` : "");

  const salon = intake.salon || {};
  push("address", salon.address ? `Адрес: ${salon.address}.` : "");
  push("phone", salon.phone ? `Телефон салона: ${salon.phone}.` : "");

  const policies = intake.policies || {};
  push("cancellation_policy", policies.cancellation);
  push("deposit_policy", policies.deposit);
  push("late_policy", policies.late);
  push("no_show_policy", policies.noShow);

  const faq = intake.faq || {};
  push("parking", faq.parking);
  push("payment", faq.payment);
  push("kids_pets", faq.kidsPets);
  push("products", faq.products);
  push("consultation", faq.consultation);
  push("gift_cards", faq.giftCards);
  (faq.custom || []).forEach((entry, index) => {
    const question = String(entry.q || entry.question || "").trim();
    const answer = String(entry.a || entry.answer || "").trim();
    if (answer) push(`custom_${index + 1}`, question ? `${question} — ${answer}` : answer);
  });

  const tone = intake.tone || {};
  if (String(tone.forbidden || "").trim()) {
    push("forbidden_topics", `Чего не обсуждаем: ${tone.forbidden}.`);
  }
  return topics;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printPlan(slug, intake, categories, staff, topics, hours) {
  const salon = intake.salon || {};
  console.log(`\nСалон:        ${salon.name}  (адрес в системе: ${slug})`);
  console.log(`Город:        ${salon.city || "—"}`);
  console.log(`Часовой пояс: ${salon.timezone}`);
  console.log(`Телефон:      ${salon.phone || "—"}`);
  console.log(`\nГрафик работы:`);
  for (let index = 0; index < 7; index += 1) {
    const window = hours[String(index)];
    console.log(`  ${weekdayLabel(index).padEnd(13)} ${window ? `${window.open}–${window.close}` : "выходной"}`);
  }
  const allServices = categories.flatMap((category) => category.services);
  console.log(`\nУслуги (${allServices.length}):`);
  categories.forEach((category) => {
    console.log(`  ${category.name}`);
    category.services.forEach((service) => {
      console.log(`    - ${service.name.padEnd(34)} ${String(service.durationMinutes + " мин").padEnd(9)} ${service.priceLabel}${service.requiresDeposit ? "  (депозит)" : ""}`);
    });
  });
  console.log(`\nМастера (${staff.length}):`);
  staff.forEach((member) => {
    const days = member.workDays.length ? member.workDays.map(weekdayLabel).join(", ") : "дни не указаны";
    console.log(`  - ${member.name} — ${member.role}`);
    console.log(`      услуги: ${member.services.length ? member.services.join(", ") : "все"}`);
    console.log(`      дни:    ${days}`);
  });
  console.log(`\nОтветы Майи из анкеты (${topics.length}):`);
  topics.forEach((topic) => console.log(`  [${topic.id}] ${topic.ru.slice(0, 96)}`));
  const escalation = intake.escalation || {};
  console.log(`\nЭскалации: ${escalation.who || "—"} → ${escalation.notify || "—"} (${escalation.hours || "часы не указаны"})`);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const file = args.find((arg) => !arg.startsWith("--"));

  if (!file) {
    console.error("Использование: node scripts/onboard-salon.mjs <файл-анкеты.json> [--dry-run]");
    process.exit(2);
  }
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`Файл анкеты не найден: ${resolved}`);
    process.exit(2);
  }

  let intake;
  try {
    intake = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    console.error(`Файл анкеты — не корректный JSON: ${error.message}`);
    console.error("Чаще всего это лишняя или пропущенная запятая. Проверьте файл на jsonlint.com.");
    process.exit(2);
  }

  const { errors, warnings, slug } = validate(intake);
  if (warnings.length) {
    console.log("\nПредупреждения (можно оставить как есть):");
    warnings.forEach((warning) => console.log(`  • ${warning}`));
  }
  if (errors.length) {
    console.error(`\nАнкета заполнена не полностью — ${errors.length} ${errors.length === 1 ? "замечание" : "замечаний"}:\n`);
    errors.forEach((error) => console.error(`  • ${error}`));
    console.error("\nИсправьте перечисленное и запустите импорт ещё раз. Ничего не изменено.\n");
    process.exit(1);
  }

  const hours = buildHours(intake);
  const categories = buildCategories(intake);
  const staff = buildStaff(intake);
  const topics = buildFaqTopics(intake);

  if (dryRun) {
    console.log("\n=== ПРОБНЫЙ ЗАПУСК (--dry-run): в базу ничего не записано ===");
    printPlan(slug, intake, categories, staff, topics, hours);
    console.log("\nЕсли всё верно — запустите ту же команду без --dry-run.\n");
    return;
  }

  const { createPlatformStore } = require(path.join(REPO, "apps", "platform", "backend", "store.js"));
  const store = createPlatformStore();
  const salon = intake.salon || {};
  const existed = store.salonExists(slug);

  store.createSalon({
    slug,
    name: salon.name,
    city: salon.city || "",
    timezone: salon.timezone,
    address: salon.address || "",
    phone: salon.phone || "",
    email: salon.email || "",
    website: salon.website || "",
    ownerName: (intake.escalation || {}).who || "",
    ownerContact: (intake.escalation || {}).notify || "",
    locationLabel: salon.city || "",
    workspaceLabel: `${salon.name} — Salon Workspace`,
    hours,
    closedDates: intake.closedDates || [],
    faq: { topics },
    faqSource: "db"
  });

  const scope = store.forSalon(slug);
  const result = scope.replaceCatalog({ categories, staff });
  const summary = scope.summary();

  console.log(`\n${existed ? "Салон обновлён" : "Салон создан"}: ${salon.name}  (адрес в системе: ${slug})`);
  console.log(`  услуг:    ${result.services}`);
  console.log(`  мастеров: ${result.staff}`);
  console.log(`  ответов Майи из анкеты: ${topics.length}`);
  console.log(`  записей в расписании:   ${summary.appointments}`);
  console.log(`\nЧат этого салона:`);
  console.log(`  /screens/chat.html?salon=${slug}`);
  console.log(`  виджет на сайт: window.AIBEATY_SALON = "${slug}";`);
  console.log(`\nПерезапустите сервер, чтобы Майя увидела изменения:  systemctl restart aibeaty\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Импорт не завершён: ${error.message}`);
    process.exit(1);
  });
}

export { validate, buildHours, buildCategories, buildStaff, buildFaqTopics, parseHoursValue, parsePrice, slugify, weekdayIndex };
