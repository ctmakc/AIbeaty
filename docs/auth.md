# Owner login

Every salon gets its own credentials into its own view. This replaces the single
shared nginx basic-auth pair, which could not be per-client and greeted a prospect
with a browser popup.

## Shape

```
POST /api/auth/login    {email, password} ──► Set-Cookie: aibeaty_session (HttpOnly, 14d)
POST /api/auth/logout                     ──► revokes the session row, clears the cookie
GET  /api/auth/session                    ──► {authenticated, owner:{email,displayName,role,salonSlug}}

backend/auth.js         accounts, scrypt hashing, sessions, login rate limit
backend/salon-scope.js  THE one place that answers "which salon is this request for?"
screens/login.html      the door (Luminous Core M3, RU/EN labels)
scripts/create-owner.mjs  account creation / password reset
```

## What is gated

Everything under `/api/platform/*` and `/screens/*` needs a session, plus the bare
`/` and every other static file the server hands out (`/data/demo-platform.json`
included — it is a fallback data source, so leaving it open would be a hole in the
gate rather than a convenience).

Public, because a salon's CLIENT must reach them with no account at all:

- `/api/assistant/*` — the assistant API behind the chat and the widget
- `/screens/chat.html` — the page the widget frames
- `/assistant-widget.js` — the launcher script the landing page loads
- `/screens/login.html` and `/api/auth/*` — the door itself
- `/styles/*`, `/favicon.ico`, `/mmix-logo.png` — assets with no salon data in them

An HTML request without a session gets `302 → /screens/login.html?next=…`; an API
request gets `401` so the screen's JS can bounce the browser to the door itself.

## Salon scoping

`resolveSalonScope(store, request, requestUrl)` in `backend/salon-scope.js` is the
only function allowed to decide which salon a request acts on. It resolves in this
order: explicit selector (`?salon=` / `X-Salon-Slug`) → the session's salon → the
salon this instance hosts. It answers **403** in two cases:

- `cross_salon` — the request named a salon the session is not bound to.
- `salon_not_provisioned` — the resolved salon is not hosted here. This is what
  stops an owner of salon B from falling through onto salon A's rows while storage
  is still single-salon.

When multi-salon storage lands, the two functions to widen are `store.getSalonSlug()`
and `store.hasSalon(slug)`. The request-side contract above does not move.

## Passwords and sessions

- scrypt (`N=16384, r=8, p=1`, 64-byte key, random 16-byte salt per account) from
  `node:crypto` — no new dependencies. Stored as `scrypt$N$r$p$salt$hash`.
- A missing account burns the same scrypt work as a real verify, so response time
  does not reveal whether an email exists. Wrong password, unknown account and
  rate-limited all return the identical body; only the status code differs.
- Session cookie: 32 random bytes plus an HMAC-SHA256 signature, `HttpOnly`,
  `SameSite=Lax`, `Secure` whenever the request arrived over TLS, 14 days. The
  database stores only the SHA-256 of the id, so a database leak yields no usable
  cookie. Sessions are rows, which is why logout is a real invalidation: the same
  cookie replayed after logout gets 401.
- Login is limited to 10 attempts per IP per 15 minutes.

`SESSION_SECRET` signs the cookies. Unset, the server generates one on first start
and writes it beside the database with mode 600, so a restart does not sign
everyone out. See `.env.example`.

## Creating an account

```bash
# locally
npm run owner:create -- --email owner@salon.com --salon luminous-core --name "Ирина"

# on the box, through the service env so it opens the right database
cd /opt/aibeaty && sudo -u aibeaty env $(grep -v '^#' .env | xargs) \
  node scripts/create-owner.mjs --email owner@salon.com --salon luminous-core --name "Ирина"
```

Press Enter at the password prompt to get a generated pronounceable one (~44 bits,
readable over the phone). It is printed exactly once and never written anywhere
else. Re-running for an existing email resets the password and kills that account's
live sessions. `--list` shows accounts without secrets; `--role staff` makes a
non-owner account.

Owner accounts and sessions live in their own tables and are **not** touched by
`server.js --reset-state`, so resetting the demo before a call does not delete the
client's login.

## Tests

`npm run auth:test` boots a real server on a random port against a throwaway
database and drives it over real HTTP: the gate refusing anonymous callers, the
login page redirect, cookie flags, wrong password, user enumeration, a tampered
cookie, cross-salon 403s on both the API and the screens, logout invalidation, the
rate limit, and the demo reset preserving accounts.
