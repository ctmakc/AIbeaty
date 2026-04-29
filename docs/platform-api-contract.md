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
- `POST /api/platform/inbox/conversations/:id/recovery-offer`
- `POST /api/platform/inbox/conversations/:id/bookings`
- Services
  - `PATCH /api/platform/services/:id`
- Schedule
- `POST /api/platform/schedule/appointments`
- `PATCH /api/platform/schedule/appointments/:id`
- `POST /api/platform/schedule/appointments/:id/deposit`
- `POST /api/platform/schedule/appointments/:id/reschedule`
- `POST /api/platform/schedule/appointments/:id/cancel`
- `POST /api/platform/schedule/appointments/:id/checkout`
- `POST /api/platform/schedule/appointments/:id/no-show`
- `POST /api/platform/schedule/appointments/:id/refund`

## Live view query params

- `GET /api/platform/salon-performance-luminous-core?q=<term>&limit=<n>`
- `GET /api/platform/inventory-management-luminous-core?q=<term>&category=professional|retail&stock=all|low|watch|ok`
- `GET /api/platform/automations-marketing-luminous-core?q=<term>&enabled=all|enabled|disabled`
- `GET /api/platform/client-directory-luminous-core?q=<term>&status=all|vip|regular|new|at-risk&clientId=<client id>`
- `GET /api/platform/unified-inbox-luminous-core?q=<term>&channel=all|whatsapp|instagram&clientId=<client id>&conversationId=<conversation id>`
- `GET /api/platform/stylist-schedule-luminous-core?q=<term>&stylist=<exact stylist name>&clientId=<client id>&appointmentId=<appointment id>&view=day|week&dayOffset=<n>&weekOffset=<n>`

Filtered live pages return the same page payload shape plus `page.liveQuery`, which the runtime uses to preserve active search/filter state across reloads. Client, inbox, and schedule payloads also expose resolved selected entities via `page.selectedClientId`, `page.selectedConversationId`, and `page.selectedAppointment`.

Schedule payloads also expose `page.weekView` when the runtime requests week mode so the UI can render a week planner and drill back into a selected day.
Selected appointments can now also expose:

- `page.selectedAppointment.receipt` after checkout so the runtime can keep the drawer open on a checked-out visit and show a receipt modal
- `page.selectedAppointment.paymentSummary` for invoice/deposit/balance/refund state before and after payment
- `page.selectedAppointment.appointmentStatus` / `appointmentStatusLabel` for live lifecycle state in the drawer
- inbox conversations can also expose `conversation.recoveryState` and `conversation.recoverySentCount` when lifecycle events trigger recovery mode

## Live reports

- `GET /api/platform/reports/performance`
- `GET /api/platform/reports/activity?q=<term>&tone=all|secondary|tertiary|error&limit=<n>`

Returns a generated live report snapshot with metrics, top stylists, recent activity, and a ready-to-copy `summaryText`.

`POST /api/platform/schedule/appointments/:id/checkout` now accepts optional JSON like:

```json
{
  "paymentMethod": "Card",
  "tipAmount": "20"
}
```

The checkout mutation persists payment metadata on the appointment row, updates the linked client + inbox state, and makes the latest receipt available through:

- `page.selectedAppointment.receipt` on schedule
- `client.latestReceipt` on clients
- `conversation.todayVisit.receipt` on inbox

`POST /api/platform/schedule/appointments/:id/deposit` accepts optional JSON like:

```json
{
  "paymentMethod": "Card",
  "amount": "45"
}
```

This updates `page.selectedAppointment.paymentSummary.depositPaid`, invoice status, and the linked inbox status for the client thread.

`POST /api/platform/schedule/appointments/:id/reschedule` accepts optional JSON like:

```json
{
  "stylist": "Sarah Jenkins",
  "date": "16:00-17:00",
  "dayOffset": "2"
}
```

This moves the appointment to a new slot/day, resets its lifecycle back to `scheduled`, and updates the linked inbox thread with the new visit time.

`POST /api/platform/schedule/appointments/:id/cancel` accepts optional JSON like:

```json
{
  "reason": "Client requested cancellation."
}
```

This marks the appointment as `canceled`, removes it from the active schedule grid, keeps it addressable by `appointmentId`, and updates linked inbox/client context.

`POST /api/platform/schedule/appointments/:id/no-show` accepts optional JSON like:

```json
{
  "note": "No-show confirmed by front desk."
}
```

This marks the appointment as `no_show`, keeps it visible in schedule with a no-show badge, disables checkout, and updates linked inbox follow-up state.

When `no-show` or `cancel` transitions happen, the linked inbox thread is automatically moved into recovery mode:

- `conversation.status` becomes a recovery-ready status
- `conversation.recoveryState` is set to `no_show` or `canceled`
- `conversation.suggestions` are replaced with rebooking-oriented recovery prompts

`POST /api/platform/inbox/conversations/:id/recovery-offer` accepts optional JSON like:

```json
{
  "offerPercent": "12",
  "text": "We missed you. Rebook within 48h and we'll apply 12% off."
}
```

This sends an outbound recovery message on the thread, increments `conversation.recoverySentCount`, and updates `No-Show Recovery` workflow sent metrics.

If a booking is later created from that recovery thread, the same workflow now increments converted count and recovered revenue as well.

`POST /api/platform/schedule/appointments/:id/refund` accepts optional JSON like:

```json
{
  "amount": "40"
}
```

This updates appointment refund state, client LTV/avg ticket, inbox status, and the receipt/payment summary exposed back to schedule, client, and inbox views.

The activity report returns `entries[]` with `title`, `meta`, `time`, `icon`, `tone`, and `route` metadata so the UI can open the most relevant live screen directly from an activity row.

## Dashboard navigation behavior

- Performance KPI cards now route into the most relevant live operational screens.
- Stylist performance rows route into schedule with `stylist=<name>`.
- Recent activity rows route into inventory, schedule, clients, or inbox with prefilled `q` where possible.
- Live screens can also open a specific selected client, conversation, or appointment through `clientId`, `conversationId`, and `appointmentId`.
- Client, inbox, and schedule detail panes now cross-link into each other using `clientId` so operators can jump between the same guest across screens without losing context.
