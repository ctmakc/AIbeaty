#!/usr/bin/env node
// A booking keeps its real date across midnights. Before the day anchor, a
// Saturday booking made on Friday showed on Sunday by Saturday and stopped
// blocking Saturday's slot.
// Run: node apps/platform/tests/day-anchor.test.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aibeaty-anchor-"));
process.env.PLATFORM_DB_PATH = path.join(dir, "platform.db");
const { createPlatformStore } = require("../backend/store");

const store = createPlatformStore();
store.createSalon({ slug: "anchor-salon", name: "Anchor Salon", timezone: "America/Toronto", hours: {}, faq: { topics: [] }, faqSource: "db" });
store.forSalon("anchor-salon").replaceCatalog({
  categories: [{ name: "Nails", services: [{ name: "Gel manicure", durationMinutes: 60, priceValue: 50, priceLabel: "$50" }] }],
  staff: [{ name: "Olena", role: "Nail tech", services: ["Gel manicure"], workDays: [1, 2, 3, 4, 5, 6] }]
});

const db = store.db;
const read = () => db.prepare(`SELECT day_offset, appt_date FROM appointments WHERE salon_id = 'anchor-salon'`).get();

// Friday 2026-09-18: book for tomorrow.
store.syncDayAnchor("anchor-salon", { today: "2026-09-18" });
const scope = store.forSalon("anchor-salon");
scope.createAppointment({ client: "Test Client", service: "Gel manicure", stylist: "Olena", date: "12:00 PM - 1:00 PM", dayOffset: 1 });
store.syncDayAnchor("anchor-salon", { today: "2026-09-18" });
assert.deepStrictEqual(read(), { day_offset: 1, appt_date: "2026-09-19" });

// Saturday: the same booking is today.
assert.strictEqual(store.syncDayAnchor("anchor-salon", { today: "2026-09-19" }), true);
assert.deepStrictEqual(read(), { day_offset: 0, appt_date: "2026-09-19" });

// A quiet stretch: Tuesday, three days later.
store.syncDayAnchor("anchor-salon", { today: "2026-09-22" });
assert.deepStrictEqual(read(), { day_offset: -3, appt_date: "2026-09-19" });

// A reschedule written in offsets on Tuesday lands on the right date.
db.prepare(`UPDATE appointments SET day_offset = 2 WHERE salon_id = 'anchor-salon'`).run();
store.syncDayAnchor("anchor-salon", { today: "2026-09-22" });
assert.deepStrictEqual(read(), { day_offset: 2, appt_date: "2026-09-24" });

// The demo salon is never rebased.
assert.strictEqual(store.syncDayAnchor(store.DEFAULT_SALON_SLUG, { today: "2030-01-01" }), false);

fs.rmSync(dir, { recursive: true, force: true });
console.log("day-anchor: all assertions passed");
