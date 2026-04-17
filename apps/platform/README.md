# Platform App

Internal product for AIbeaty.

## Current State

The first Stitch import is now deployed here as a static prototype.

Imported screens from `Aura AI Salon OS`:

- Stylist Schedule - Luminous Core
- Unified Inbox - Luminous Core
- Salon Performance - Luminous Core
- Inventory Management - Luminous Core
- Services & Pricing - Luminous Core
- Client Directory - Luminous Core
- Automations & Marketing - Luminous Core

## Run Locally

```bash
npm run platform:serve
```

Then open `http://localhost:4174`.

`platform:serve` now rebuilds the local Tailwind bundle first, serves the static platform shell, and exposes `/api/platform/*` from the same process on `4174`.

## Note

The imported screens are kept as raw Stitch HTML under `apps/platform/screens/` so the visual design stays intact.

## Data Runtime

The screens now also load a lightweight runtime layer:

- shared loader: `apps/platform/screens/_platform-runtime.js`
- demo data: `apps/platform/data/demo-platform.json`
- backend contract: `docs/platform-api-contract.md`

This keeps the screens static-first while making them ready for backend-fed data.

## Frontend Hardening

- shared CSS build: `apps/platform/styles/platform.css`
- Tailwind source: `apps/platform/styles/platform.tailwind.css`
- Tailwind config: `apps/platform/tailwind.config.js`
- local platform server: `apps/platform/server.js`

This keeps the visual output intact while making the platform deterministic enough for backend integration work.

## Local API

- `GET /api/platform/health`
- `GET /api/platform`
- `GET /api/platform/<screen-id>`

Examples:

- `/api/platform/salon-performance-luminous-core`
- `/api/platform/unified-inbox-luminous-core`
- `/api/platform/inventory-management-luminous-core`

Validation:

```bash
npm run platform:api:check
```
