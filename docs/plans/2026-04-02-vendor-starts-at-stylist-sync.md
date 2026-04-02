# Design: Vendor Campaign starts_at + Per-Stylist Zenoti Sync

_Date: 2026-04-02_

## Feature 1: Vendor Campaign `starts_at`

### Goal
Allow vendor campaigns to have a future start date so brands can upload campaigns ahead of time without them going live immediately.

### DB Change
- **Migration 059:** `ALTER TABLE vendor_campaigns ADD COLUMN starts_at TEXT` — NULL = active immediately.

### Scheduler (`vendorScheduler.js`)
- Add filter to campaign selection query:
  ```sql
  AND (starts_at IS NULL OR starts_at <= date('now'))
  ```
- Mirror the existing `expires_at` window-clamp for `starts_at`: if `windowStart` is before `starts_at`, push `windowStart` forward to the start of the `starts_at` day in the salon's timezone.

### CSV Import (`vendorAdmin.js`)
- Add `starts_at` as an optional column after `expires_at` in `CSV_HEADERS` and `CSV_EXAMPLE`.
- Blank or missing = NULL. Validated as `YYYY-MM-DD` format if present; invalid values are silently nulled.
- CSV template download updated to include the new column header.

### Platform Console Manual Form
- Add "Starts At (optional)" date input alongside the existing "Expires At" field.
- Show `starts_at` in the campaign card display (e.g. "Starts: 2026-05-01").

---

## Feature 2: Per-Stylist Zenoti Sync Button

### Goal
Allow managers to trigger an availability sync for a single stylist instead of all mapped stylists at once.

### New Route
`POST /manager/integrations/zenoti/sync-stylist`
- Accepts `stylist_id` in request body.
- Verifies stylist belongs to `req.manager.salon_id` and has an `integration_employee_id`.
- Runs the same fetch (`fetchStylistSlots`) + generate (`generateAndSaveAvailabilityPost`) logic as the full sync but for one stylist.
- Redirects to `/manager/integrations?synced=1&found=N`.

### UI
- In the Zenoti stylist mapping rows, add a small "Sync" button to the right of the employee ID input — **only for stylists that already have an `integration_employee_id`**.
- Each button is its own mini `<form method="POST" action="/manager/integrations/zenoti/sync-stylist">` with a hidden `stylist_id` input.
- Unmapped stylists show no button.
- The existing "Sync Availability" all-stylists button at the bottom of the card is unchanged.

---

## Task Reference
- Task #1: Explore context ✅
- Task #2: Design approved ✅
- Task #3: Write design doc ✅
