---
phase: quick
plan: 260321-o2q
subsystem: vendor-brands
tags: [seed, database, vendor, local-dev]
dependency_graph:
  requires: []
  provides: [vendor-brands-realistic-data]
  affects: [vendor_campaigns, salon_vendor_feeds, salon_vendor_approvals]
tech_stack:
  added: []
  patterns: [transactional-rename-via-delete-insert]
key_files:
  created:
    - scripts/seed-vendor-brands.mjs
  modified: []
decisions:
  - "DELETE old + INSERT new required because vendor_name is TEXT PRIMARY KEY — no in-place rename possible in SQLite"
  - "FK references updated before DELETE to avoid orphan rows during transaction"
metrics:
  duration: "2 min"
  completed: "2026-03-21"
  tasks_completed: 1
  files_changed: 1
---

# Quick Task 260321-o2q: Update Stock Vendor Brands Summary

**One-liner:** Renamed three placeholder vendor brands (Your Brand / 2 / 3) to Aveda, Redken, and Olaplex across all four related tables with brand-specific hashtags and categories.

## What Was Done

Replaced placeholder vendor brand data in the local `postly.db` SQLite database with realistic professional beauty brand names for demos and development.

### Task 1: Create and run vendor brand rename script

**Commit:** dd5f809

Created `scripts/seed-vendor-brands.mjs` — a transactional ESM script using `better-sqlite3` that:

1. Fetches existing row values to carry over `min_gap_days`, `platform_max_cap`, `allow_client_renewal`
2. Updates all FK references in `vendor_campaigns`, `salon_vendor_feeds`, and `salon_vendor_approvals` before touching `vendor_brands`
3. Inserts new `vendor_brands` row with brand-specific metadata
4. Deletes the old placeholder row

Brand metadata applied:

| Brand | brand_hashtags | categories | product_value |
|-------|----------------|------------|---------------|
| Aveda | `["#AvedaColor","#Aveda"]` | `["Color","Standard","Promotion"]` | $55 |
| Redken | `["#RedkenReady","#Redken"]` | `["Color","Standard","Styling"]` | $40 |
| Olaplex | `["#Olaplex","#OlaplexTreatment"]` | `["Treatment","Standard","Repair"]` | $50 |

## Verification Results

All four tables confirmed clean — no "Your Brand" references remain:

- `vendor_brands`: `['Aveda', 'Olaplex', 'Redken']`
- `salon_vendor_feeds`: `['Aveda', 'Olaplex', 'Redken']`
- `vendor_campaigns`: `['Aveda', 'Olaplex', 'Redken']` (distinct)
- `salon_vendor_approvals`: `['Aveda', 'Olaplex', 'Redken']`

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `scripts/seed-vendor-brands.mjs`: FOUND
- Commit dd5f809: FOUND
- All four tables verified clean of placeholder names
