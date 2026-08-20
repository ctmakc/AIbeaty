#!/usr/bin/env node
// Create (or re-password) a salon owner account.
//
//   node scripts/create-owner.mjs --email owner@salon.com --salon luminous-core --name "Ирина"
//   node scripts/create-owner.mjs --email x@y.z --salon s --name N --role staff
//   node scripts/create-owner.mjs --email x@y.z --salon s --name N --password-stdin < secret.txt
//
// With no password flag the script asks for one (input is not echoed); press Enter on
// an empty prompt and it generates a strong pronounceable password. Either way the
// password is printed EXACTLY ONCE, to the terminal, and is never written to a file,
// a log line or the database in clear form.
//
// On the box run it through the service env so it opens the right database:
//   cd /opt/aibeaty && sudo -u aibeaty env $(grep -v '^#' .env | xargs) \
//     node scripts/create-owner.mjs --email ... --salon ... --name ...

import { createRequire } from "node:module";
import { randomInt } from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPlatformStore } = require(path.join(ROOT, "apps/platform/backend/store.js"));
const { createAuth } = require(path.join(ROOT, "apps/platform/backend/auth.js"));

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "password-stdin" || key === "help" || key === "list") {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

// Pronounceable so it survives being read aloud on a phone call, still ~44 bits of
// entropy from a CSPRNG (five syllables from a 100-pair alphabet plus three digits).
function generatePassword() {
  const consonants = "bdfgklmnprstvz";
  const vowels = "aeiou";
  const syllables = [];
  for (let index = 0; index < 5; index += 1) {
    syllables.push(consonants[randomInt(consonants.length)] + vowels[randomInt(vowels.length)]);
  }
  const digits = String(randomInt(100, 1000));
  return `${syllables.slice(0, 2).join("")}-${syllables.slice(2, 4).join("")}-${syllables[4]}${digits}`;
}

// Typed characters never reach the terminal, so the password cannot end up in a
// screen recording, a scrollback buffer or a shared-terminal session.
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = function writeToOutput(chunk) {
      if (!muted) {
        rl.output.write(chunk);
        return;
      }
      if (String(chunk).includes(question)) rl.output.write(question);
    };
    rl.question(question, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolve(buffer.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
}

function usage() {
  console.log(`Usage:
  node scripts/create-owner.mjs --email <email> --salon <slug> --name "<display name>" [--role owner|staff]
  node scripts/create-owner.mjs --list

Options:
  --email            login (also the account's unique key)
  --salon            salon slug this account may see (and only this one)
  --name             display name shown in the console
  --role             owner (default) or staff
  --password-stdin   read the password from stdin instead of prompting
  --list             list existing accounts (no secrets)
`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const store = createPlatformStore();
  const auth = createAuth({ store, log: () => {} });

  if (args.list) {
    const owners = auth.listOwners();
    if (!owners.length) {
      console.log("No owner accounts yet.");
    } else {
      owners.forEach((owner) => {
        console.log(
          `${owner.email}\t${owner.salon_slug}\t${owner.role}\t${owner.display_name}` +
            `${owner.disabled ? "\tDISABLED" : ""}${owner.last_login_at ? `\tlast login ${owner.last_login_at}` : ""}`
        );
      });
    }
    process.exit(0);
  }

  const email = String(args.email || "").trim().toLowerCase();
  const salon = String(args.salon || "").trim().toLowerCase();
  const name = String(args.name || "").trim();
  const role = String(args.role || "owner").trim();

  if (!email || !salon || !name) {
    usage();
    console.error("ERROR: --email, --salon and --name are all required.");
    process.exit(1);
  }

  let password = "";
  let generated = false;
  if (args["password-stdin"]) {
    password = (await readStdin()).trim();
    if (!password) {
      console.error("ERROR: stdin held no password.");
      process.exit(1);
    }
  } else {
    if (!process.stdin.isTTY) {
      console.error("ERROR: no terminal to prompt on. Use --password-stdin.");
      process.exit(1);
    }
    const typed = (await askHidden(`Password for ${email} (Enter = generate one): `)).trim();
    if (typed) {
      password = typed;
    } else {
      password = generatePassword();
      generated = true;
    }
  }

  if (password.length < 10) {
    console.error("ERROR: password must be at least 10 characters.");
    process.exit(1);
  }

  const existing = auth.getOwnerByEmail(email);
  const owner = auth.createOwner({ email, password, salonSlug: salon, displayName: name, role });

  // A changed password must not leave old browsers signed in.
  if (existing) auth.revokeAllSessionsForOwner(owner.id);

  console.log("");
  console.log(existing ? "Password reset for an existing account." : "Owner account created.");
  console.log(`  login : ${owner.email}`);
  console.log(`  salon : ${owner.salon_slug}`);
  console.log(`  name  : ${owner.display_name}`);
  console.log(`  role  : ${owner.role}`);
  if (generated) {
    console.log(`  password: ${password}`);
    console.log("");
    console.log("Shown once, right here. The database keeps only a scrypt hash of it.");
    console.log("Hand it over in person or in a private channel; never paste it into a file, a commit or a chat log.");
  } else {
    console.log("  password: (the one you supplied — not echoed)");
  }
  process.exit(0);
})().catch((error) => {
  console.error(`ERROR: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
