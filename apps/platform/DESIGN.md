# AIbeaty Platform — Design Law

## System: «Luminous Core» (M3 light, pre-existing)

Tokens live in `tailwind.config.js` and are mirrored as CSS custom properties in
standalone screens (`screens/digest.html`, `screens/chat.html`). This system is
LOCKED — new platform surfaces extend it; divergence inside the product is a defect
(ledger precedent: Longvai / entity-ops-os / digest row).

- **Faces**: Manrope 500/700/800 (headline) + Inter 400/500/600 (body) + Material Symbols Outlined.
- **Ground**: `#f5f6f7` background, flat tonal containers (`#ffffff` → `#dadddf` ramp), no decorative shadows.
- **Accent**: primary `#4d2afa` (electric violet), tertiary `#7a25db`, secondary `#006384`; tonal container pairs carry state.
- **Radii**: tight M3 — 2 / 4 / 8 / 12 px.
- **Motion**: instrument-calm — single rise/settle 260–340ms `cubic-bezier(.2,0,0,1)`, stagger ≤280ms, `prefers-reduced-motion` honored. No fade-up carpets, no ambient loops.

## Client-facing chat surfaces (2026-08-15): «Лаунж у зеркала»

**Audience flip**: every other screen serves the salon OWNER (operator console).
`screens/chat.html` + `/assistant-widget.js` serve the salon's CLIENT on a phone —
same token DNA, re-lit for hospitality. Direction chosen from three (diverge-3):

1. **«Лаунж у зеркала» — CHOSEN.** The M3 tokens warmed for a guest: lavender-white
   ground (`#f6f5fa` — primary diluted into the surface family, not a new hue), Maya's
   identity is ONE gradient disc (primary→tertiary) and the client's own bubbles are the
   only other strong color; Maya answers in calm paper-white bubbles with a hairline.
   Shared artifact signature: booking confirmations / handoff notes render as the SAME
   centered tonal system-pill the owner sees in the Unified Inbox — client phone and
   owner console show one artifact.
2. «Вечерний бархат» (dark plum + violet glow) — REJECTED: neon-glow-on-dark is a
   nuclear ban, and a dark client chat splits the product into two visual worlds.
3. «Чековая лента» (mono receipt/ledger chat) — REJECTED: instrument register is right
   for operators, wrong for a nervous first-time client at 11pm; kills Maya's warmth.

### Chat tokens (deltas only — everything else inherits)
- `--bg-guest: #f6f5fa` — guest ground, faint lavender tint of the platform surface.
- Maya bubble: `--surface-lowest` + 1px solid `--surface-variant`, radius 16px with a 4px "spoken-from" corner toward the avatar.
- Client bubble: solid `--primary` + `#ffffff` text (chat vernacular: your words carry the accent), same radius language mirrored.
- System pill: `--surface-container` + `--on-surface-variant`, centered — identical to the inbox system message.
- Quick-intent chips: tonal tertiary (`--tertiary-container` @ 30% bg, solid `--on-tertiary-container` text ≥70% rule respected — text always solid).
- Maya avatar: 40px disc, `linear-gradient(135deg, #4d2afa, #7a25db)`, Manrope-800 white "M".

### Motion law for chat
One gesture: a bubble **settles** (translateY 8px→0 + opacity, 260ms `cubic-bezier(.2,0,0,1)`), applied only to newly appended messages — never re-animated on load.
The ONLY continuous animation is the typing indicator (three breathing dots) and the
header presence dot, and both run **only while Maya is genuinely composing** (request
in flight). Natural reply cadence: typing indicator visible ≥0.8–2s (randomized) even
when the server answers faster. `prefers-reduced-motion`: dots static, settle removed.

### Honesty rules carried into UI
- Subtitle under Maya's name states «ИИ-ассистент» permanently — disclosure is not only in the first LLM turn.
- «Позвать человека» is a permanent quick chip (escape hatch law), not buried in a menu.
- Error state is honest and warm: «Майя отошла на минутку — попробуйте ещё раз» + explicit retry; silenced threads say the humans have it now.

### Widget (`/assistant-widget.js`)
Self-contained IIFE, Shadow DOM, zero deps. Honors the landing contract: silent no-op
without `window.AIBEATY_API_BASE`; mounts into `#aibeaty-chat` (falls back to body).
Launcher = 56px gradient disc (the same Maya disc, so the brand mark IS the persona),
panel = 384×min(640px, viewport) iframe of `chat.html?embed=1`, full-screen ≤560px.
Open/close 220ms scale+fade from bottom-right; teaser pill once per session.
