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

The root path now opens the dashboard screen directly instead of the old Stitch import catalog.

`platform:serve` now rebuilds the local Tailwind bundle first, serves the static platform shell, and exposes `/api/platform/*` from the same process on `4174`.

The local backend is now SQLite-backed. Live entities persist in `apps/platform/data/platform.db`, while `demo-platform.json` remains the seed/fallback source for non-live screens and resets.

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

State reset:

```bash
npm run platform:state:reset
```

This rebuilds the SQLite-backed live state from the demo seed.

Current live mutations:

- `PATCH /api/platform/inventory/items/:sku`
- `POST /api/platform/inventory/restock-orders`
- `PATCH /api/platform/automations/workflows/:name`
- `POST /api/platform/automations/builder/test-run`
- `POST /api/platform/automations/builder/activate`
- `POST /api/platform/clients`
- `PATCH /api/platform/clients/:id`
- `DELETE /api/platform/clients/:id`
- `POST /api/platform/clients/:id/bookings`
- `POST /api/platform/inbox/conversations`
- `PATCH /api/platform/inbox/conversations/:id`
- `DELETE /api/platform/inbox/conversations/:id`
- `POST /api/platform/inbox/conversations/:id/messages`
- `POST /api/platform/inbox/conversations/:id/bookings`
- `PATCH /api/platform/services/:id`
- `POST /api/platform/schedule/appointments`
- `PATCH /api/platform/schedule/appointments/:id`
- `POST /api/platform/schedule/appointments/:id/checkout`

Live query-driven views:

- Performance: `q`, `limit`
- Inventory: `q`, `category`, `stock`
- Automations: `q`, `enabled`
- Clients: `q`, `status`
- Inbox: `q`, `channel`
- Schedule: `q`, `stylist`

Live reports:

- `GET /api/platform/reports/performance`

Dashboard deep-links:

- KPI cards route into the live schedule, inbox, and client directory screens
- stylist performance rows deep-link into filtered schedule views
- recent activity rows deep-link into the most relevant live screen with prefilled query context
- live screens accept `clientId`, `conversationId`, and `appointmentId` so a deep-link can open with a specific entity already selected
- client, inbox, and schedule detail panes now cross-link using `clientId` to keep the same guest selected across screens
