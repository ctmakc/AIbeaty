#!/usr/bin/env node
// Static audit: every SQL statement inside createSalonScope() that touches a
// tenant-owned table must carry a salon_id predicate.
//
// This is the guard that makes multi-salon isolation a property of the file
// rather than a claim: a query added later without `salon_id` fails the suite,
// even if no runtime test happens to exercise that code path.
//
// Run: node apps/platform/tests/scope-audit.test.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const STORE_FILE = path.join(__dirname, "..", "backend", "store.js");
const source = fs.readFileSync(STORE_FILE, "utf8");

// Tables the store declares as salon-owned (re-derived from the source so the
// audit and the schema can never drift apart).
const declared = /const SCOPED_TABLES = \[([\s\S]*?)\];/.exec(source);
assert.ok(declared, "SCOPED_TABLES declaration not found in store.js");
const SCOPED_TABLES = declared[1]
  .split(",")
  .map((entry) => entry.replace(/\/\/.*$/gm, "").trim().replace(/^["']|["']$/g, ""))
  .filter(Boolean);
assert.ok(SCOPED_TABLES.length >= 20, `expected the full scoped-table list, got ${SCOPED_TABLES.length}`);

// Body of createSalonScope(salonId) — brace-matched from its opening.
function scopeBody(text) {
  const marker = "function createSalonScope(salonId) {";
  const start = text.indexOf(marker);
  assert.ok(start >= 0, "createSalonScope(salonId) not found");
  let depth = 0;
  for (let i = start + marker.length - 1; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in createSalonScope");
}

// Every backtick template literal in the scope body that looks like SQL.
function sqlLiterals(text) {
  const found = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "`" || text[i - 1] === "\\") continue;
    let depth = 0;
    for (let j = i + 1; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "\\") { j += 1; continue; }
      if (ch === "$" && text[j + 1] === "{") { depth += 1; j += 1; continue; }
      if (ch === "}" && depth > 0) { depth -= 1; continue; }
      if (ch === "`" && depth === 0) {
        found.push({ sql: text.slice(i + 1, j), index: i });
        i = j;
        break;
      }
    }
  }
  // SQL also hides in plain "..." / '...' string literals passed to db.prepare
  // — a real miss during the multi-salon migration, so it is scanned too.
  const quoted = /db\.prepare\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = quoted.exec(text)) !== null) {
    found.push({ sql: match[2], index: match.index });
  }
  return found.filter((entry) => /\b(SELECT|INSERT\s+INTO|INSERT\s+OR\s+\w+\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(entry.sql));
}

// Which scoped tables does this statement read or write?
function touchedTables(sql) {
  const hits = new Set();
  for (const table of SCOPED_TABLES) {
    const re = new RegExp(`\\b(?:FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, "i");
    if (re.test(sql)) hits.add(table);
  }
  return [...hits];
}

const body = scopeBody(source);
const statements = sqlLiterals(body);
assert.ok(statements.length > 80, `expected the store's SQL to be found, got ${statements.length}`);

const unscoped = [];
let scopedCount = 0;
for (const statement of statements) {
  const tables = touchedTables(statement.sql);
  if (!tables.length) continue;
  scopedCount += 1;
  // A dynamic ${table} interpolation over SCOPED_TABLES counts as scoped only
  // when the statement still names salon_id.
  if (!/salon_id/.test(statement.sql)) {
    const line = body.slice(0, statement.index).split("\n").length;
    unscoped.push(`  [${tables.join(", ")}] scope-body line ${line}: ${statement.sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  }
}

// Dynamic-table statements (`DELETE FROM ${table}`) must name salon_id too.
const dynamic = statements.filter((entry) => /\$\{table\}/.test(entry.sql));
for (const statement of dynamic) {
  if (!/salon_id/.test(statement.sql)) {
    const line = body.slice(0, statement.index).split("\n").length;
    unscoped.push(`  [dynamic \${table}] scope-body line ${line}: ${statement.sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
  }
}

if (unscoped.length) {
  console.error(`\nscope-audit FAILED — ${unscoped.length} unscoped statement(s):\n${unscoped.join("\n")}\n`);
  process.exit(1);
}

// The salon registry itself must NOT be salon-scoped, and no scoped table may
// be queried from outside a scope (that would bypass isolation entirely).
const outside = source.replace(body, "");
const leaks = [];
for (const table of SCOPED_TABLES) {
  const re = new RegExp(`\\b(?:FROM|INTO|UPDATE)\\s+${table}\\b`, "gi");
  let match;
  while ((match = re.exec(outside)) !== null) {
    const context = outside.slice(Math.max(0, match.index - 200), match.index + 100);
    // Schema DDL and the migration helpers legitimately touch tables globally.
    if (/CREATE TABLE|CREATE INDEX|ALTER TABLE|PRAGMA|_pre_multisalon|sqlite_master/i.test(context)) continue;
    leaks.push(`  ${table} queried outside createSalonScope near: ${context.slice(-90).replace(/\s+/g, " ")}`);
  }
}
if (leaks.length) {
  console.error(`\nscope-audit FAILED — scoped table used outside a salon scope:\n${leaks.join("\n")}\n`);
  process.exit(1);
}

console.log(`scope-audit: ${scopedCount} salon-table statements checked, all carry salon_id (${SCOPED_TABLES.length} scoped tables).`);
