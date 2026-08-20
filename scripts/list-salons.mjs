#!/usr/bin/env node
// Lists the salons this instance hosts.
//
// Prints the database file first ON PURPOSE: run without the server's
// environment, the store falls back to the repo-local apps/platform/data/platform.db
// and silently reports an empty or stale list. Seeing the path is what tells you
// whether you are looking at production.
//
//   on the box:  cd /opt/aibeaty && sudo -u aibeaty env $(grep -v '^#' .env | xargs) node scripts/list-salons.mjs
//   locally:     npm run salon:list
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPlatformStore } = require(path.join(REPO, "apps", "platform", "backend", "store.js"));

const store = createPlatformStore();
const salons = store.listSalons();

console.log(`База данных: ${store.dbFile}`);
if (!process.env.PLATFORM_DB_PATH) {
  console.log("ВНИМАНИЕ: PLATFORM_DB_PATH не задан — это НЕ база сервера, а локальный файл репозитория.");
}
console.log(`Салон по умолчанию: ${store.DEFAULT_SALON_SLUG}`);
console.log(`Всего салонов: ${salons.length}\n`);

for (const salon of salons) {
  const summary = store.forSalon(salon.slug).summary();
  console.log(`  ${salon.slug}`);
  console.log(`    название:  ${salon.name}${salon.city ? ` (${salon.city})` : ""}`);
  console.log(`    часовой пояс: ${salon.timezone}`);
  console.log(`    услуг: ${summary.services}   мастеров: ${summary.staff}   клиентов: ${summary.clients}   записей: ${summary.appointments}`);
  console.log(`    чат: /screens/chat.html?salon=${salon.slug}`);
  console.log("");
}
