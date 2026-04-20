# Platform API Contract

Static HTML screens in `apps/platform/screens/` now expect page-shaped JSON payloads.

## Runtime

- script: `apps/platform/screens/_platform-runtime.js`
- live base URL resolution:
  1. `?api=https://host/path`
  2. `localStorage.aibeaty_api_base`
  3. default `/api/platform`
- demo fallback:
  - `apps/platform/data/demo-platform.json`

## Storage

- live modules persist in SQLite at `apps/platform/data/platform.db`
- `npm run platform:state:reset` reseeds SQLite from `apps/platform/data/demo-platform.json`
- `/api/platform/health` reports the active storage backend

## Endpoint shape

Each screen requests:

```text
GET /api/platform/<screen-file-without-html>
```

Examples:

- `/api/platform/salon-performance-luminous-core`
- `/api/platform/unified-inbox-luminous-core`
- `/api/platform/inventory-management-luminous-core`

## Response format

```json
{
  "lastUpdated": "2026-04-17T20:40:00Z",
  "page": {}
}
```

`page` must match the structure used by that screen in `demo-platform.json`.

## Current adapters

- `salon-performance-luminous-core`
  - KPI cards
  - stylist performance list
  - recent activity feed
- `inventory-management-luminous-core`
  - KPI cards
  - inventory table
  - recent shipments feed
- `services-pricing-luminous-core`
  - service categories
  - service rows
  - side editor values
- `client-directory-luminous-core`
  - client list
  - client detail panel
  - history and preferences
- `unified-inbox-luminous-core`
  - conversation list
  - active thread
  - AI reply chips
  - client profile panel
- `stylist-schedule-luminous-core`
  - stylist headers
  - appointment blocks
  - active appointment drawer
- `automations-marketing-luminous-core`
  - workflow cards
  - builder defaults

## Notes

- The runtime keeps the Stitch HTML shell but swaps hardcoded product data for JSON-driven content.
- If a live endpoint is missing or returns non-200, the page falls back to demo data automatically.

## Live mutation endpoints

- Inventory
  - `PATCH /api/platform/inventory/items/:sku`
  - `POST /api/platform/inventory/restock-orders`
- Automations
  - `PATCH /api/platform/automations/workflows/:name`
  - `POST /api/platform/automations/builder/test-run`
  - `POST /api/platform/automations/builder/activate`
- Clients
  - `POST /api/platform/clients`
  - `PATCH /api/platform/clients/:id`
  - `DELETE /api/platform/clients/:id`
  - `POST /api/platform/clients/:id/bookings`
- Inbox
  - `POST /api/platform/inbox/conversations`
  - `PATCH /api/platform/inbox/conversations/:id`
  - `DELETE /api/platform/inbox/conversations/:id`
  - `POST /api/platform/inbox/conversations/:id/messages`
  - `POST /api/platform/inbox/conversations/:id/bookings`
- Services
  - `PATCH /api/platform/services/:id`
- Schedule
  - `POST /api/platform/schedule/appointments`
  - `PATCH /api/platform/schedule/appointments/:id`
  - `POST /api/platform/schedule/appointments/:id/checkout`

## Live view query params

- `GET /api/platform/salon-performance-luminous-core?q=<term>&limit=<n>`
- `GET /api/platform/inventory-management-luminous-core?q=<term>&category=professional|retail&stock=all|low|watch|ok`
- `GET /api/platform/automations-marketing-luminous-core?q=<term>&enabled=all|enabled|disabled`
- `GET /api/platform/client-directory-luminous-core?q=<term>&status=all|vip|regular|new|at-risk&clientId=<client id>`
- `GET /api/platform/unified-inbox-luminous-core?q=<term>&channel=all|whatsapp|instagram&clientId=<client id>&conversationId=<conversation id>`
- `GET /api/platform/stylist-schedule-luminous-core?q=<term>&stylist=<exact stylist name>&clientId=<client id>&appointmentId=<appointment id>`

Filtered live pages return the same page payload shape plus `page.liveQuery`, which the runtime uses to preserve active search/filter state across reloads. Client, inbox, and schedule payloads also expose resolved selected entities via `page.selectedClientId`, `page.selectedConversationId`, and `page.selectedAppointment`.

## Live reports

- `GET /api/platform/reports/performance`

Returns a generated live report snapshot with metrics, top stylists, recent activity, and a ready-to-copy `summaryText`.

## Dashboard navigation behavior

- Performance KPI cards now route into the most relevant live operational screens.
- Stylist performance rows route into schedule with `stylist=<name>`.
- Recent activity rows route into inventory, schedule, clients, or inbox with prefilled `q` where possible.
- Live screens can also open a specific selected client, conversation, or appointment through `clientId`, `conversationId`, and `appointmentId`.
- Client, inbox, and schedule detail panes now cross-link into each other using `clientId` so operators can jump between the same guest across screens without losing context.
