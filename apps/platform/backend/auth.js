// Owner login for the AIbeaty platform.
//
// One salon owner = one account = one salon. The account gives the owner their own
// door into their own salon view; the shared nginx basic-auth pair it replaces could
// never be per-client.
//
// Passwords: node:crypto scrypt (no new dependencies). Stored as
//   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
// Sessions: opaque 32-byte id in an HttpOnly cookie, signed with HMAC-SHA256 so a
// forged/garbage cookie is rejected before any DB work. Only the SHA-256 of the id is
// stored, so a stolen database still yields no usable cookie. Sessions are server-side
// rows, which is what makes logout a real invalidation rather than a client-side wish.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const COOKIE_NAME = "aibeaty_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const ROLES = new Set(["owner", "staff"]);

// One generic answer for "no such account" and "wrong password" alike — anything more
// specific hands an attacker a user-enumeration oracle.
const GENERIC_LOGIN_ERROR = {
  ru: "Неверная почта или пароль.",
  en: "Invalid email or password."
};

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !expected.length) return false;
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch (error) {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

// Burns roughly the same CPU as a real verify so a missing account and a wrong
// password take the same wall-clock time.
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString("hex"));
function burnPasswordTime(password) {
  verifyPassword(String(password || ""), DUMMY_HASH);
}

// SESSION_SECRET wins; otherwise a 32-byte secret is generated once and persisted
// next to the database with mode 600, so restarts do not sign every user out.
function resolveSessionSecret({ dbFile, log = () => {} } = {}) {
  const fromEnv = String(process.env.SESSION_SECRET || "").trim();
  if (fromEnv) return fromEnv;

  const secretFile = process.env.SESSION_SECRET_FILE
    ? path.resolve(process.env.SESSION_SECRET_FILE)
    : path.join(path.dirname(dbFile || process.cwd()), "session-secret");

  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    /* falls through to generation */
  }

  const generated = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, `${generated}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(secretFile, 0o600);
  } catch (error) {
    /* best effort on exotic filesystems */
  }
  log(`[auth] generated a session secret at ${secretFile} (mode 600)`);
  return generated;
}

function parseCookies(header) {
  const jar = {};
  String(header || "")
    .split(";")
    .forEach((pair) => {
      const index = pair.indexOf("=");
      if (index < 1) return;
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (key) jar[key] = decodeURIComponent(value);
    });
  return jar;
}

function clientIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  const real = String(request.headers["x-real-ip"] || "").trim();
  if (real) return real;
  return (request.socket && request.socket.remoteAddress) || "unknown";
}

function isSecureRequest(request) {
  if (String(process.env.SESSION_COOKIE_SECURE || "") === "1") return true;
  const proto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (proto) return proto === "https";
  return Boolean(request.socket && request.socket.encrypted);
}

function createAuth({ store, clock = () => new Date(), log = console.log } = {}) {
  const db = store.db;
  const secret = resolveSessionSecret({ dbFile: store.dbFile, log });

  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salon_slug TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'owner',
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS owner_sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      salon_slug TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS owner_sessions_owner ON owner_sessions (owner_id);
  `);

  function signSessionId(sessionId) {
    return base64url(crypto.createHmac("sha256", secret).update(sessionId).digest());
  }

  function nowIso() {
    return clock().toISOString();
  }

  function createOwner({ email, password, salonSlug, displayName, role = "owner" }) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes("@")) throw new Error("A valid email is required.");
    if (!password || String(password).length < 10) throw new Error("Password must be at least 10 characters.");
    const slug = String(salonSlug || "").trim().toLowerCase();
    if (!slug) throw new Error("salon slug is required.");
    if (!ROLES.has(role)) throw new Error(`role must be one of: ${[...ROLES].join(", ")}`);

    const timestamp = nowIso();
    const id = `own-${base64url(crypto.randomBytes(9))}`;
    db.prepare(
      `INSERT INTO owner_accounts (id, email, password_hash, salon_slug, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         password_hash = excluded.password_hash,
         salon_slug = excluded.salon_slug,
         display_name = excluded.display_name,
         role = excluded.role,
         disabled = 0,
         updated_at = excluded.updated_at`
    ).run(id, normalizedEmail, hashPassword(password), slug, String(displayName || normalizedEmail), role, timestamp, timestamp);

    return getOwnerByEmail(normalizedEmail);
  }

  function getOwnerByEmail(email) {
    return db.prepare(`SELECT * FROM owner_accounts WHERE email = ?`).get(normalizeEmail(email)) || null;
  }

  function listOwners() {
    return db
      .prepare(`SELECT id, email, salon_slug, display_name, role, disabled, created_at, last_login_at FROM owner_accounts ORDER BY created_at`)
      .all();
  }

  // ---- login rate limit: per IP, sliding window, in-memory (one process serves one box)
  const attempts = new Map();
  function rateLimitState(ip) {
    const now = clock().getTime();
    const fresh = (attempts.get(ip) || []).filter((stamp) => now - stamp < LOGIN_WINDOW_MS);
    if (fresh.length) attempts.set(ip, fresh);
    else attempts.delete(ip);
    return fresh;
  }
  function rateLimited(ip) {
    return rateLimitState(ip).length >= LOGIN_MAX_ATTEMPTS;
  }
  function noteFailedAttempt(ip) {
    const fresh = rateLimitState(ip);
    fresh.push(clock().getTime());
    attempts.set(ip, fresh);
  }
  function clearAttempts(ip) {
    attempts.delete(ip);
  }
  function retryAfterSeconds(ip) {
    const fresh = rateLimitState(ip);
    if (!fresh.length) return 0;
    return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (clock().getTime() - fresh[0])) / 1000));
  }

  // ---- sessions
  function startSession(owner, request) {
    const rawId = base64url(crypto.randomBytes(32));
    const created = clock();
    const expires = new Date(created.getTime() + SESSION_TTL_MS);
    db.prepare(
      `INSERT INTO owner_sessions (id, owner_id, salon_slug, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sha256(rawId),
      owner.id,
      owner.salon_slug,
      created.toISOString(),
      expires.toISOString(),
      created.toISOString(),
      clientIp(request),
      String(request.headers["user-agent"] || "").slice(0, 200)
    );
    db.prepare(`UPDATE owner_accounts SET last_login_at = ? WHERE id = ?`).run(created.toISOString(), owner.id);
    return { cookieValue: `${rawId}.${signSessionId(rawId)}`, expires };
  }

  function readSession(request) {
    const cookie = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator < 1) return null;
    const rawId = cookie.slice(0, separator);
    const signature = cookie.slice(separator + 1);
    const expected = signSessionId(rawId);
    const given = Buffer.from(signature);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.expires_at, s.revoked_at, s.salon_slug,
                o.id AS owner_id, o.email, o.display_name, o.role, o.disabled
           FROM owner_sessions s
           JOIN owner_accounts o ON o.id = s.owner_id
          WHERE s.id = ?`
      )
      .get(sha256(rawId));
    if (!row) return null;
    if (row.revoked_at) return null;
    if (row.disabled) return null;
    if (new Date(row.expires_at).getTime() <= clock().getTime()) return null;

    return {
      sessionId: row.session_id,
      ownerId: row.owner_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      salonSlug: row.salon_slug
    };
  }

  function revokeSession(sessionId) {
    if (!sessionId) return false;
    const result = db
      .prepare(`UPDATE owner_sessions SET revoked_at = ? WHERE id = ? AND revoked_at = ''`)
      .run(nowIso(), sessionId);
    return result.changes > 0;
  }

  function revokeAllSessionsForOwner(ownerId) {
    return db.prepare(`UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at = ''`)
      .run(nowIso(), ownerId).changes;
  }

  function sessionCookieHeader(request, cookieValue, expires) {
    const bits = [
      `${COOKIE_NAME}=${cookieValue}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Expires=${expires.toUTCString()}`,
      `Max-Age=${Math.floor((expires.getTime() - clock().getTime()) / 1000)}`
    ];
    if (isSecureRequest(request)) bits.push("Secure");
    return bits.join("; ");
  }

  function clearCookieHeader(request) {
    const bits = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
    if (isSecureRequest(request)) bits.push("Secure");
    return bits.join("; ");
  }

  function login({ email, password, request }) {
    const ip = clientIp(request);
    if (rateLimited(ip)) {
      return { ok: false, status: 429, error: "rate_limited", retryAfter: retryAfterSeconds(ip), message: GENERIC_LOGIN_ERROR };
    }
    const owner = getOwnerByEmail(email);
    if (!owner || owner.disabled) {
      burnPasswordTime(password);
      noteFailedAttempt(ip);
      return { ok: false, status: 401, error: "invalid_credentials", message: GENERIC_LOGIN_ERROR };
    }
    if (!verifyPassword(String(password || ""), owner.password_hash)) {
      noteFailedAttempt(ip);
      return { ok: false, status: 401, error: "invalid_credentials", message: GENERIC_LOGIN_ERROR };
    }
    clearAttempts(ip);
    const session = startSession(owner, request);
    return {
      ok: true,
      status: 200,
      owner: { email: owner.email, displayName: owner.display_name, role: owner.role, salonSlug: owner.salon_slug },
      setCookie: sessionCookieHeader(request, session.cookieValue, session.expires)
    };
  }

  function purgeExpiredSessions() {
    return db.prepare(`DELETE FROM owner_sessions WHERE expires_at <= ?`).run(nowIso()).changes;
  }

  return {
    COOKIE_NAME,
    SESSION_TTL_MS,
    LOGIN_MAX_ATTEMPTS,
    LOGIN_WINDOW_MS,
    GENERIC_LOGIN_ERROR,
    createOwner,
    getOwnerByEmail,
    listOwners,
    login,
    readSession,
    revokeSession,
    revokeAllSessionsForOwner,
    clearCookieHeader,
    purgeExpiredSessions,
    clientIp,
    hashPassword,
    verifyPassword
  };
}

module.exports = {
  createAuth,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  parseCookies,
  COOKIE_NAME
};
