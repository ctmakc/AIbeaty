#!/usr/bin/env node
// Self-serve salons at a glance, and removal of test sign-ups.
//
//   node scripts/tenants.mjs list
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

const store = createPlatformStore();
const db = store.db;
const [command, slug] = process.argv.slice(2);

const hasTable = (name) => Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name));
if (!hasTable("tenants")) {
  console.log("No self-serve salons yet (the tenants table is created on the first server start).");
  process.exit(0);
}

if (command === "list" || !command) {
  const rows = db.prepare(`
    SELECT t.salon_slug, t.plan, t.trial_ends_at, t.setup_complete, t.launched_at, t.created_at, s.name, s.email,
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
    console.log(`${row.created_at.slice(0, 10)}  ${state.padEnd(5)}  ${row.plan} until ${row.trial_ends_at.slice(0, 10)}  ${row.salon_slug}`);
    console.log(`            ${row.name} · ${row.email} · bot ${row.bot ? "@" + row.bot : "—"}${row.owner_chat ? " (owner linked)" : ""} · chats ${row.conversations} · bookings ${row.bookings}${row.addons ? " · wants " + row.addons : ""}`);
  });
  process.exit(0);
}

if (command === "delete" && slug) {
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

console.error("Usage: node scripts/tenants.mjs list | delete <slug>");
process.exit(2);
