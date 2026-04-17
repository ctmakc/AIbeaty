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
