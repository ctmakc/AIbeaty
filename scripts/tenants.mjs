#!/usr/bin/env node
// Self-serve salons at a glance, and removal of test sign-ups.
//
//   node scripts/tenants.mjs list
//   node scripts/tenants.mjs plans                               (prices, from backend/billing.js)
//   node scripts/tenants.mjs pending                             (salons waiting on their invoice)
//   node scripts/tenants.mjs activate <slug> <solo|salon|pro> [addon ...] [--annual]
//        addons: instagram_dm whatsapp calendar_sync sms_reminders
//        Run it once the invoice from INNOVA CONSULT LTD is paid. The owner gets
//        a "plan active" message in their Telegram when it is linked.
//   node scripts/tenants.mjs delete <slug>      (asks nothing: meant for probes)
//
// Reads the same DB as the server (PLATFORM_DB_PATH). On the box:
//   cd /opt/aibeaty && sudo -u aibeaty env $(grep -v '^#' .env | xargs) node scripts/tenants.mjs list
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPlatformStore } = require(path.join(REPO, "apps/platform/backend/store.js"));
const billing = require(path.join(REPO, "apps/platform/backend/billing.js"));

const store = createPlatformStore();
const db = store.db;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
const [command, slug, ...rest] = argv.filter((arg) => !arg.startsWith("--"));

if (command === "plans") {
  console.log(`Plans (${billing.CURRENCY}/month, month-to-month, taxes added on the invoice; annual = ${billing.ANNUAL_MONTHS_BILLED} months billed for 12):`);
  billing.PLANS.forEach((plan) => {
    console.log(`  ${plan.key.padEnd(6)} ${billing.money(plan.price).padStart(5)}/mo  ${billing.money(plan.price * billing.ANNUAL_MONTHS_BILLED).padStart(7)}/yr  ${plan.staff.en}. ${plan.blurb.en}`);
  });
  console.log("Add-ons:");
  billing.PAID_ADDONS.forEach((addon) => {
    console.log(`  ${addon.key.padEnd(14)} +${billing.money(addon.price)}/mo  ${addon.title.en}: ${addon.detail.en}`);
  });
  console.log(`"We set it up for you" is free during the trial. Seller: ${billing.SELLER}.`);
  process.exit(0);
}

const hasTable = (name) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
if (!hasTable("tenants")) {
  console.log("No self-serve salons yet (the tenants table is created on the first server start).");
  process.exit(0);
}
billing.ensureBillingSchema(db);

if (command === "list" || !command) {
  const rows = db.prepare(`
    SELECT t.salon_slug, t.plan, t.plan_status, t.plan_choice, t.plan_addons, t.plan_cycle, t.trial_ends_at, t.setup_complete, t.launched_at, t.created_at, s.name, s.email,
      (SELECT bot_username FROM tenant_telegram g WHERE g.salon_slug = t.salon_slug) AS bot,
      (SELECT owner_chat_id FROM tenant_telegram g WHERE g.salon_slug = t.salon_slug) AS owner_chat,
      (SELECT COUNT(*) FROM conversations c WHERE c.salon_id = t.salon_slug) AS conversations,
      (SELECT COUNT(*) FROM appointments a WHERE a.salon_id = t.salon_slug) AS bookings,
      (SELECT group_concat(addon, ',') FROM tenant_addon_requests r WHERE r.salon_slug = t.salon_slug) AS addons
    FROM tenants t LEFT JOIN salons s ON s.id = t.salon_slug
    ORDER BY t.created_at DESC
  `).all();
  if (!rows.length) console.log("No self-serve salons yet.");
  rows.forEach((row) => {
    const state = row.launched_at ? "LIVE" : row.setup_complete ? "ready" : "setup";
    const money = row.plan_status === "trial" ? `${row.plan} until ${row.trial_ends_at.slice(0, 10)}` : `${row.plan_status} ${billing.describeQuote(billing.billingState(row).quote)}${row.plan_status === "pending_payment" ? ` · trial until ${row.trial_ends_at.slice(0, 10)}` : ""}`;
    console.log(`${row.created_at.slice(0, 10)}  ${state.padEnd(5)}  ${money}  ${row.salon_slug}`);
    console.log(`            ${row.name} · ${row.email} · bot ${row.bot ? "@" + row.bot : "—"}${row.owner_chat ? " (owner linked)" : ""} · chats ${row.conversations} · bookings ${row.bookings}${row.addons ? " · wants " + row.addons : ""}`);
  });
  process.exit(0);
}

if (command === "pending") {
  const rows = db.prepare(`
    SELECT t.*, s.name, s.email, s.city FROM tenants t LEFT JOIN salons s ON s.id = t.salon_slug
    WHERE t.plan_status = 'pending_payment' ORDER BY t.plan_requested_at
  `).all();
  if (!rows.length) console.log("Nobody is waiting on an invoice.");
  rows.forEach((row) => {
    const state = billing.billingState(row);
    console.log(`${row.plan_requested_at.slice(0, 16)}  ${row.salon_slug}  ${row.name} · ${row.email} · ${row.city || "—"}`);
    console.log(`            ${billing.describeQuote(state.quote)} · trial until ${row.trial_ends_at.slice(0, 10)}`);
    console.log(`            node scripts/tenants.mjs activate ${row.salon_slug} ${state.choice}${state.addons.length ? " " + state.addons.join(" ") : ""}${state.cycle === "annual" ? " --annual" : ""}`);
  });
  process.exit(0);
}

if (command === "activate") {
  const planKey = rest[0];
  const addons = rest.slice(1);
  if (!slug || !billing.planByKey(planKey)) {
    console.error(`Usage: node scripts/tenants.mjs activate <slug> <${billing.PLANS.map((plan) => plan.key).join("|")}> [${billing.PAID_ADDONS.map((addon) => addon.key).join(" ")}] [--annual]`);
    process.exit(2);
  }
  const unknown = addons.filter((key) => !billing.addonByKey(key));
  if (unknown.length) {
    console.error(`Unknown add-on(s): ${unknown.join(", ")}. Known: ${billing.PAID_ADDONS.map((addon) => addon.key).join(", ")}`);
    process.exit(2);
  }
  if (!db.prepare(`SELECT 1 FROM tenants WHERE salon_slug = ?`).get(slug)) {
    console.error(`${slug} is not a self-serve salon.`);
    process.exit(1);
  }
  // Through tenancy, so the owner hears it in Telegram when their chat is linked.
  const { createTenancy } = require(path.join(REPO, "apps/platform/backend/tenancy.js"));
  const { resolveSessionSecret } = require(path.join(REPO, "apps/platform/backend/auth.js"));
  const tenancy = createTenancy({ store, auth: null, llm: null, secret: resolveSessionSecret({ dbFile: store.dbFile }) });
  const result = tenancy.activatePlan(slug, { plan: planKey, addons, cycle: flags.has("--annual") ? "annual" : "monthly" });
  if (!result.ok) {
    console.error(`Not activated: ${result.error}`);
    process.exit(1);
  }
  console.log(`Activated ${slug}: ${billing.describeQuote(result.quote)}`);
  // Let the Telegram notice go out before the process ends.
  setTimeout(() => process.exit(0), 1500);
} else if (command === "delete" && slug) {
  if (slug === store.DEFAULT_SALON_SLUG) {
    console.error("Refusing to delete the demo salon.");
    process.exit(1);
  }
  const tenant = db.prepare(`SELECT salon_slug FROM tenants WHERE salon_slug = ?`).get(slug);
  if (!tenant) {
    console.error(`${slug} is not a self-serve salon; nothing deleted.`);
    process.exit(1);
  }
  db.transaction(() => {
    store.deleteSalon(slug);
    ["tenants", "tenant_telegram", "tenant_addon_requests", "tenant_reminders"].forEach((table) => {
      if (hasTable(table)) db.prepare(`DELETE FROM ${table} WHERE salon_slug = ?`).run(slug);
    });
    const owners = db.prepare(`SELECT id FROM owner_accounts WHERE salon_slug = ?`).all(slug);
    owners.forEach((owner) => db.prepare(`DELETE FROM owner_sessions WHERE owner_id = ?`).run(owner.id));
    db.prepare(`DELETE FROM owner_accounts WHERE salon_slug = ?`).run(slug);
  })();
  console.log(`Deleted ${slug}. If it had a Telegram bot, its webhook now gets 404s; the owner can reuse the bot elsewhere.`);
  process.exit(0);
}

else {
  console.error("Usage: node scripts/tenants.mjs list | plans | pending | activate <slug> <plan> [addon ...] [--annual] | delete <slug>");
  process.exit(2);
}
