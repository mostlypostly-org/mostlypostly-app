# Configurable Content Placement Routing — Design

**Date:** 2026-03-25
**Feature:** FEAT-059 — Configurable placement routing (console defaults + salon overrides)

---

## Goal

Make the content_type → placement defaults configurable via the Platform Console, with per-salon overrides on the Integrations page. FEAT-057 implemented AI classification and per-post manager overrides — this feature makes the system-recommended defaults themselves tunable without a code deploy.

## Background

FEAT-057 added:
- `content_type` and `placement` columns on `posts`
- `DEFAULT_PLACEMENT` hardcoded in `src/core/contentType.js`
- Manager approval card shows recommendation + override radios

A salon owner flagged that vendor content disrupts their Instagram grid aesthetic. The fix is making the "Recommended" placement per content type configurable at two levels: console (system-wide) and salon (individual override).

---

## Content Type → Placement Defaults

| Content Type | System Default | Notes |
|---|---|---|
| standard_post | post | General salon content |
| before_after | reel | High engagement, grid-worthy |
| education | reel | Tutorial content performs best as reel |
| vendor_product | story | Keeps grid clean, product discovery |
| vendor_promotion | story | Time-sensitive; story for urgency |
| reviews | post | Social proof belongs on the grid |
| celebration | post | Team visibility on the grid |
| stylist_availability | story | Urgency content, immediacy |

---

## Architecture

**Resolution order for any post's placement:**

1. `post.placement_overridden = 1` → use `post.placement` as-is (manager changed it at approval)
2. `salons.placement_routing[contentType]` → salon-level override
3. `system_settings` where `key = 'placement_routing'` → console-level default
4. `DEFAULT_PLACEMENT[contentType]` in `contentType.js` → hardcoded fallback

---

## Data Model

### Migration 058

**New table: `system_settings`**
```sql
CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
```
Seeded at migration time with:
```json
{
  "key": "placement_routing",
  "value": "{\"standard_post\":\"post\",\"before_after\":\"reel\",\"education\":\"reel\",\"vendor_product\":\"story\",\"vendor_promotion\":\"story\",\"reviews\":\"post\",\"celebration\":\"post\",\"stylist_availability\":\"story\"}"
}
```

**New column: `salons.placement_routing TEXT`**
- NULL = use system defaults
- Partial JSON object — only overridden content types stored
- Merged with system defaults at read time (same pattern as `platform_routing`)

---

## Components

### 1. `src/core/placementRouting.js` (new)

```js
getSystemPlacementRouting(db)
  // reads system_settings where key='placement_routing'
  // falls back to DEFAULT_PLACEMENT from contentType.js

mergePlacementRouting(systemJson, salonJson)
  // overlays salon partial override on system defaults
  // ignores unknown content_type keys

resolveContentPlacement(db, salon, contentType)
  // single call point for scheduler and approval UI
  // returns "reel" | "story" | "post"
```

### 2. Platform Console (`/internal/vendors`)

New **"Content Placement Defaults"** section:
- Table: 8 rows (one per content_type), placement `<select>` per row
- **Save Defaults** → `POST /internal/vendors/set-placement-routing` → writes to `system_settings`
- **Push to all salons** checkbox → when checked, also writes to every `salons.placement_routing` (clears custom overrides)

### 3. Salon Integrations (`/manager/integrations`)

New collapsible **"Content Placement"** card:
- Table: 8 rows with placement dropdowns
- Rows show "Using system default" (muted) or "Custom" (blue badge) per row
- **Save** → `POST /manager/integrations/placement-routing` → writes partial JSON to `salons.placement_routing`
- **Reset to defaults** → sets `salons.placement_routing = NULL`
- Changes apply to future posts only; already-scheduled posts keep their stored placement

### 4. Scheduler (`src/scheduler.js`)

- `getSalonPolicy()` adds `SELECT placement_routing` to its salon query
- Replace `getDefaultPlacement(contentType)` call with `resolveContentPlacement(db, salon, contentType)`
- Posts with `placement_overridden = 1` bypass this entirely — their stored placement is used as-is

### 5. Manager Approval Card (`src/routes/manager.js`)

Placement source label logic:
- `placement_overridden = 1` → no label
- Salon has override for this content_type → "Your salon default"
- Otherwise → "Recommended by MostlyPostly"

---

## Error Handling

- Malformed JSON in `system_settings` or `salons.placement_routing` → fall back to `DEFAULT_PLACEMENT`
- Unknown content_type in routing JSON → ignored, fallback used
- `system_settings` row missing → fall back to `DEFAULT_PLACEMENT`

---

## Testing

- Unit tests for `getSystemPlacementRouting` (missing row, malformed JSON, valid)
- Unit tests for `mergePlacementRouting` (null salon, partial override, unknown key)
- Unit tests for `resolveContentPlacement` (all 4 resolution levels)
- Scheduler integration: verify `getSalonPolicy` includes `placement_routing`

---

## Task IDs

- Task 26: DB migration
- Task 27: `placementRouting.js` core logic
- Task 28: Salon Integrations card
- Task 29: Scheduler integration
- Task 30: Approval card label update
