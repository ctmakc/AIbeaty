// Plans, add-ons and payment for self-serve salons (owner decision 2026-09-18).
//
// Prices are CAD per month, month-to-month, cancel any time. Annual billing is
// ten months for twelve ("2 months free"). Sales tax (HST/GST/QST) is NOT in
// these numbers: it is added on the invoice.
//
// How a salon pays today: the owner picks a plan in wizard step 7 and presses
// "Continue with <plan>". The tenant goes to plan_status 'pending_payment', its
// trial is extended by 7 days (once) so Maya never stops, and we get a platform
// notification. We email an invoice from INNOVA CONSULT LTD (card link or
// Interac e-Transfer) and activate with:
//
//   node scripts/tenants.mjs activate <slug> <solo|salon|pro> [addon ...]
//
// Stripe Checkout is wired but OFF: it switches on only when STRIPE_SECRET_KEY
// and STRIPE_PRICE_<PLAN> are set (see docs/self-serve.md). There is no Stripe
// account today and none is to be created without the owner.
//
// This module is shared by the server (backend/tenancy.js) and the ops script
// (scripts/tenants.mjs), so it only needs a better-sqlite3 handle.

const crypto = require("node:crypto");

const CURRENCY = "CAD";
const ANNUAL_MONTHS_BILLED = 10;
const PENDING_TRIAL_EXTENSION_DAYS = 7;
const SELLER = "INNOVA CONSULT LTD";
// Shown next to the seller on sign-up and in step 7: who bills, and from where.
const SELLER_PLACE = "Ottawa, Canada";

const PLANS = [
  {
    key: "solo",
    price: 39,
    staffLimit: 1,
    title: { en: "Solo", fr: "Solo", ru: "Соло" },
    staff: { en: "1 staff member", fr: "1 membre de l’équipe", ru: "1 мастер" },
    blurb: {
      en: "For one person working on their own.",
      fr: "Pour une personne qui travaille seule.",
      ru: "Для мастера, который работает один."
    }
  },
  {
    key: "salon",
    price: 79,
    staffLimit: 6,
    title: { en: "Salon", fr: "Salon", ru: "Салон" },
    staff: { en: "Up to 6 staff", fr: "Jusqu’à 6 personnes", ru: "До 6 мастеров" },
    blurb: {
      en: "For a salon or barbershop with a small team.",
      fr: "Pour un salon ou un barbier avec une petite équipe.",
      ru: "Для салона или барбершопа с небольшой командой."
    }
  },
  {
    key: "pro",
    price: 149,
    staffLimit: null,
    title: { en: "Pro", fr: "Pro", ru: "Про" },
    staff: { en: "Unlimited staff", fr: "Équipe illimitée", ru: "Без ограничения мастеров" },
    blurb: {
      en: "Medspa and clinic features. We set everything up for you.",
      fr: "Fonctions pour cliniques et médi-spas. Nous configurons tout pour vous.",
      ru: "Функции для клиник и медспа. Всё настроим за вас."
    }
  }
];

// Paid monthly add-ons. The owner ticks them in step 7; we connect each one
// within 2 business days.
const PAID_ADDONS = [
  {
    key: "instagram_dm",
    price: 29,
    title: { en: "Instagram Direct", fr: "Instagram Direct", ru: "Instagram Direct" },
    detail: { en: "Maya answers your Instagram messages.", fr: "Maya répond à vos messages Instagram.", ru: "Майя отвечает в Instagram Direct." }
  },
  {
    key: "whatsapp",
    price: 29,
    title: { en: "WhatsApp", fr: "WhatsApp", ru: "WhatsApp" },
    detail: { en: "Maya answers on your WhatsApp Business number.", fr: "Maya répond sur votre numéro WhatsApp Business.", ru: "Майя отвечает в WhatsApp Business." }
  },
  {
    key: "calendar_sync",
    price: 29,
    title: { en: "Calendar sync", fr: "Synchronisation d’agenda", ru: "Синхронизация календаря" },
    detail: {
      en: "Google Calendar, Square, Booksy, Fresha or Vagaro, so nothing double-books.",
      fr: "Google Agenda, Square, Booksy, Fresha ou Vagaro, pour éviter les doubles réservations.",
      ru: "Google Calendar, Square, Booksy, Fresha или Vagaro, чтобы не было двойных записей."
    }
  },
  {
    key: "sms_reminders",
    price: 19,
    title: { en: "SMS reminders", fr: "Rappels par SMS", ru: "SMS-напоминания" },
    detail: { en: "Up to 300 SMS a month before visits.", fr: "Jusqu’à 300 SMS par mois avant les rendez-vous.", ru: "До 300 SMS в месяц перед визитами." }
  }
];

function planByKey(key) {
  return PLANS.find((plan) => plan.key === String(key || "").toLowerCase()) || null;
}

function addonByKey(key) {
  return PAID_ADDONS.find((addon) => addon.key === String(key || "").toLowerCase()) || null;
}

function normalizeCycle(cycle) {
  return String(cycle || "").toLowerCase() === "annual" ? "annual" : "monthly";
}

function uniqueAddons(keys) {
  const seen = new Set();
  return (Array.isArray(keys) ? keys : [])
    .map((key) => String(key || "").toLowerCase())
    .filter((key) => addonByKey(key) && !seen.has(key) && seen.add(key));
}

// The one place a total is computed. Returns null for an unknown plan.
function quote(planKey, addonKeys = [], cycle = "monthly") {
  const plan = planByKey(planKey);
  if (!plan) return null;
  const addons = uniqueAddons(addonKeys).map((key) => {
    const addon = addonByKey(key);
    return { key: addon.key, price: addon.price, title: addon.title };
  });
  const monthly = plan.price + addons.reduce((sum, addon) => sum + addon.price, 0);
  const billing = normalizeCycle(cycle);
  return {
    plan: plan.key,
    planTitle: plan.title,
    planPrice: plan.price,
    staffLimit: plan.staffLimit,
    addons,
    monthly,
    cycle: billing,
    // What the invoice says before tax.
    total: billing === "annual" ? monthly * ANNUAL_MONTHS_BILLED : monthly,
    annualSaving: monthly * (12 - ANNUAL_MONTHS_BILLED),
    currency: CURRENCY,
    taxIncluded: false
  };
}

// The smallest plan whose staff guidance fits the team (guidance only: the
// trial never blocks a salon for having more people).
function suggestPlan(staffCount, businessType) {
  if (businessType === "medspa") return "pro";
  const count = Number(staffCount) || 0;
  return (PLANS.find((plan) => plan.staffLimit === null || count <= plan.staffLimit) || PLANS[PLANS.length - 1]).key;
}

function money(amount) {
  return `$${Number(amount).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function describeQuote(q) {
  if (!q) return "";
  const parts = [`${q.planTitle.en} ${money(q.planPrice)}/mo`].concat(q.addons.map((addon) => `${addon.title.en} +${money(addon.price)}/mo`));
  const total = q.cycle === "annual"
    ? `${money(q.total)} ${q.currency}/year (${money(q.monthly)}/mo × ${ANNUAL_MONTHS_BILLED}) + tax`
    : `${money(q.total)} ${q.currency}/month + tax`;
  return `${parts.join(" · ")} = ${total}`;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

const COLUMNS = [
  ["plan_status", "TEXT NOT NULL DEFAULT 'trial'"],
  ["plan_choice", "TEXT NOT NULL DEFAULT ''"],
  ["plan_addons", "TEXT NOT NULL DEFAULT '[]'"],
  ["plan_cycle", "TEXT NOT NULL DEFAULT 'monthly'"],
  ["plan_requested_at", "TEXT NOT NULL DEFAULT ''"],
  ["plan_activated_at", "TEXT NOT NULL DEFAULT ''"],
  ["trial_extended_at", "TEXT NOT NULL DEFAULT ''"],
  ["stripe_customer", "TEXT NOT NULL DEFAULT ''"],
  ["stripe_subscription", "TEXT NOT NULL DEFAULT ''"]
];

function ensureBillingSchema(db) {
  const hasTenants = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tenants'`).get();
  if (!hasTenants) return false;
  const existing = new Set(db.prepare(`PRAGMA table_info(tenants)`).all().map((column) => column.name));
  COLUMNS.forEach(([name, spec]) => {
    if (!existing.has(name)) db.exec(`ALTER TABLE tenants ADD COLUMN ${name} ${spec}`);
  });
  return true;
}

function parseAddons(raw) {
  try {
    return uniqueAddons(JSON.parse(raw || "[]"));
  } catch (error) {
    return [];
  }
}

// Billing view of a tenants row (used by tenancy.getTenant and the ops script).
function billingState(row) {
  if (!row) return null;
  const status = row.plan_status || (row.plan && row.plan !== "trial" ? "active" : "trial");
  const choice = row.plan_choice || (row.plan !== "trial" ? row.plan : "");
  const addons = parseAddons(row.plan_addons);
  const cycle = normalizeCycle(row.plan_cycle);
  return {
    status,
    choice,
    addons,
    cycle,
    requestedAt: row.plan_requested_at || "",
    activatedAt: row.plan_activated_at || "",
    trialExtendedAt: row.trial_extended_at || "",
    quote: choice ? quote(choice, addons, cycle) : null
  };
}

// The owner pressed "Continue with <plan>". Idempotent: pressing again with a
// different choice updates it, but the trial is extended only once.
function requestPlan(db, slug, { plan, addons, cycle } = {}, clock = () => new Date()) {
  const q = quote(plan, addons, cycle);
  if (!q) return { ok: false, error: "unknown_plan" };
  const row = db.prepare(`SELECT * FROM tenants WHERE salon_slug = ?`).get(slug);
  if (!row) return { ok: false, error: "not_self_serve" };
  if ((row.plan_status || "trial") === "active") return { ok: false, error: "already_active", state: billingState(row) };
  const now = clock();
  const stamp = now.toISOString();
  let trialEndsAt = row.trial_ends_at;
  let extended = false;
  if (!row.trial_extended_at) {
    // From whichever is later: the current trial end, or now (an expired trial
    // comes back on for a week while the invoice is paid).
    const base = Math.max(new Date(row.trial_ends_at).getTime() || 0, now.getTime());
    trialEndsAt = new Date(base + PENDING_TRIAL_EXTENSION_DAYS * 86400000).toISOString();
    extended = true;
  }
  db.prepare(`
    UPDATE tenants SET plan_status = 'pending_payment', plan_choice = ?, plan_addons = ?, plan_cycle = ?,
      plan_requested_at = ?, trial_ends_at = ?, trial_extended_at = CASE WHEN trial_extended_at = '' THEN ? ELSE trial_extended_at END,
      updated_at = ?
    WHERE salon_slug = ?
  `).run(q.plan, JSON.stringify(q.addons.map((addon) => addon.key)), q.cycle, stamp, trialEndsAt, extended ? stamp : "", stamp, slug);
  return { ok: true, quote: q, trialEndsAt, extended, previous: billingState(row) };
}

// Payment received (by us, or by the Stripe webhook): the plan is on.
function activatePlan(db, slug, { plan, addons, cycle, stripeCustomer, stripeSubscription } = {}, clock = () => new Date()) {
  const row = db.prepare(`SELECT * FROM tenants WHERE salon_slug = ?`).get(slug);
  if (!row) return { ok: false, error: "not_self_serve" };
  const unknown = (Array.isArray(addons) ? addons : []).filter((key) => !addonByKey(key));
  if (unknown.length) return { ok: false, error: "unknown_addon", unknown };
  const q = quote(plan, addons, cycle || row.plan_cycle);
  if (!q) return { ok: false, error: "unknown_plan" };
  const stamp = clock().toISOString();
  db.prepare(`
    UPDATE tenants SET plan = ?, plan_status = 'active', plan_choice = ?, plan_addons = ?, plan_cycle = ?,
      plan_activated_at = ?, stripe_customer = COALESCE(NULLIF(?, ''), stripe_customer),
      stripe_subscription = COALESCE(NULLIF(?, ''), stripe_subscription), updated_at = ?
    WHERE salon_slug = ?
  `).run(q.plan, q.plan, JSON.stringify(q.addons.map((addon) => addon.key)), q.cycle, stamp, stripeCustomer || "", stripeSubscription || "", stamp, slug);
  return { ok: true, quote: q };
}

// ---------------------------------------------------------------------------
// Stripe Checkout (OFF unless configured)
// ---------------------------------------------------------------------------

function envKey(key) {
  return String(key).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

// Which Stripe price ids exist for this choice. Enabled only when the secret
// key and a price for the plan (and for every chosen add-on) are all set.
function stripeLineItems(q, env = process.env) {
  if (!q || !env.STRIPE_SECRET_KEY) return null;
  const suffix = q.cycle === "annual" ? "_ANNUAL" : "";
  const planPrice = env[`STRIPE_PRICE_${envKey(q.plan)}${suffix}`];
  if (!planPrice) return null;
  const items = [{ price: planPrice, quantity: 1 }];
  for (const addon of q.addons) {
    const price = env[`STRIPE_PRICE_${envKey(addon.key)}${suffix}`];
    if (!price) return null;
    items.push({ price, quantity: 1 });
  }
  return items;
}

function stripeEnabled(env = process.env) {
  return Boolean(env.STRIPE_SECRET_KEY) && PLANS.some((plan) => env[`STRIPE_PRICE_${envKey(plan.key)}`]);
}

function formEncode(object, prefix = "", out = []) {
  Object.entries(object).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") formEncode(value, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  });
  return out.join("&");
}

async function createCheckoutSession({ slug, email, q, successUrl, cancelUrl, env = process.env, fetchImpl = fetch }) {
  const items = stripeLineItems(q, env);
  if (!items) return null;
  const base = String(env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
  const metadata = { slug, plan: q.plan, addons: q.addons.map((addon) => addon.key).join(","), cycle: q.cycle };
  const lineItems = {};
  items.forEach((item, index) => { lineItems[index] = item; });
  const body = formEncode({
    mode: "subscription",
    client_reference_id: slug,
    customer_email: email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: lineItems,
    metadata,
    subscription_data: { metadata },
    // Sales tax is added on top of the listed prices; Stripe Tax computes it
    // when the account has it turned on.
    automatic_tax: env.STRIPE_AUTOMATIC_TAX === "1" ? { enabled: "true" } : undefined,
    billing_address_collection: "required"
  });
  const response = await fetchImpl(`${base}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) {
    throw new Error(`stripe checkout: ${String((data.error && data.error.message) || response.status).slice(0, 160)}`);
  }
  return { id: data.id, url: data.url };
}

// Stripe-Signature: "t=<unix>,v1=<hex hmac of `${t}.${rawBody}`>[,v1=…]".
function verifyStripeSignature(rawBody, header, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const parts = String(header).split(",").map((part) => part.split("="));
  const timestamp = (parts.find(([key]) => key === "t") || [])[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((signature) => {
    const given = Buffer.from(String(signature), "hex");
    return given.length === expectedBuffer.length && crypto.timingSafeEqual(given, expectedBuffer);
  });
}

// What the wizard needs to draw step 7.
function catalog(language = "en") {
  const pick = (map) => map[language] || map.en;
  return {
    currency: CURRENCY,
    annualMonthsBilled: ANNUAL_MONTHS_BILLED,
    seller: SELLER,
    sellerPlace: SELLER_PLACE,
    trialExtensionDays: PENDING_TRIAL_EXTENSION_DAYS,
    plans: PLANS.map((plan) => ({ key: plan.key, price: plan.price, staffLimit: plan.staffLimit, title: pick(plan.title), staff: pick(plan.staff), blurb: pick(plan.blurb) })),
    addons: PAID_ADDONS.map((addon) => ({ key: addon.key, price: addon.price, title: pick(addon.title), detail: pick(addon.detail) }))
  };
}

module.exports = {
  PLANS,
  PAID_ADDONS,
  CURRENCY,
  SELLER,
  SELLER_PLACE,
  ANNUAL_MONTHS_BILLED,
  PENDING_TRIAL_EXTENSION_DAYS,
  planByKey,
  addonByKey,
  quote,
  suggestPlan,
  describeQuote,
  money,
  ensureBillingSchema,
  billingState,
  requestPlan,
  activatePlan,
  stripeEnabled,
  stripeLineItems,
  createCheckoutSession,
  verifyStripeSignature,
  catalog
};
