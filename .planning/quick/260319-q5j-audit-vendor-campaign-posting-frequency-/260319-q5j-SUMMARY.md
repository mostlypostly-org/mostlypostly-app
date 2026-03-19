---
phase: quick
plan: 260319-q5j
subsystem: vendor-scheduler
tags: [vendor, frequency-controls, platform-floor, auto-expiry, tone-direction-removal]
dependency_graph:
  requires: []
  provides: [vendor-frequency-controls, vendor-min-gap-enforcement, vendor-auto-expiry]
  affects: [vendor_brands, vendor_campaigns, vendorScheduler.js, vendorAdmin.js, vendorFeeds.js]
tech_stack:
  added: []
  patterns: [min-gap-check-before-cap-check, auto-expiry-fallback, platform-floor-ceiling]
key_files:
  created:
    - migrations/046_vendor_frequency_controls.js
  modified:
    - migrations/index.js
    - src/core/vendorSync.js
    - src/core/vendorScheduler.js
    - src/routes/vendorAdmin.js
    - src/routes/vendorFeeds.js
decisions:
  - min_gap_days defaults to 3 days stored in vendor_brands; enforced per-brand not per-campaign
  - platform_max_cap defaults to 6 posts/month ceiling stored in vendor_brands
  - processCampaign() checks min-gap BEFORE monthly cap check (gap is harder floor)
  - Auto-expiry uses 30 days from today when expires_at is NULL in both CSV and manual insert paths
  - Renew button was already implemented at time of execution (confirmed at vendorAdmin.js line 339)
  - Removed tone_direction entirely from: CSV_HEADERS, CSV_EXAMPLE, all 4 forms, 2 POST handlers, OpenAI prompt
  - brand-config POST consolidated from 2 branching DB calls into 1 unified INSERT/UPSERT
  - cap defaults changed 4→3 across: vendorSync.js, vendorScheduler.js processCampaign(), vendorAdmin.js all forms, vendorFeeds.js both call sites
metrics:
  duration: ~9 min
  completed: 2026-03-19
  tasks_completed: 3
  files_modified: 6
---

# Quick Task 260319-q5j: Vendor Campaign Posting Frequency Controls Summary

**One-liner:** Three-layer vendor frequency controls — platform min-gap floor (3 days), platform monthly ceiling (6 posts), and auto-30-day-expiry — with tone_direction removed throughout.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Migration 046 + vendorSync auto-expiry + scheduler min-gap enforcement | 4c857fc | migrations/046, migrations/index.js, vendorSync.js, vendorScheduler.js |
| 2 | Platform Console UI — min_gap/platform_max fields, tone_direction removal, cap defaults to 3 | ebe9767 | vendorAdmin.js, vendorFeeds.js |
| 3 | Remove tone_direction from generateVendorCaption() OpenAI prompt | 65a68f7 | vendorScheduler.js |

## What Was Built

### Migration 046
Adds `min_gap_days INTEGER DEFAULT 3` and `platform_max_cap INTEGER DEFAULT 6` to `vendor_brands`. Uses PRAGMA + conditional ADD COLUMN pattern (idempotent, safe to re-run).

### vendorSync.js — auto-expiry
`insertCampaigns()` now auto-sets `expires_at` to today+30 when the computed expiry from `release_date` is null. `frequency_cap` default changed from 4 to 3 for all PDF sync imports.

### vendorScheduler.js — min-gap enforcement
- `processSalon()` JOINs `vendor_brands` to fetch `min_gap_days` and `platform_max_cap` per vendor
- `processCampaign()` signature extended with `vendorName` and `minGapDays` parameters
- Min-gap check added BEFORE monthly cap check: queries `MAX(scheduled_for)` for any post from any campaign of the same vendor for this salon with status `manager_pending`, `manager_approved`, or `published`. If `daysSince < effectiveMinGap`, logs and returns false
- Default cap fallback updated from `|| 4` to `|| 3`
- `tone_direction` removed from `generateVendorCaption()` userPrompt

### vendorAdmin.js — Platform Console UI
- `CSV_HEADERS`: removed `tone_direction`
- `CSV_EXAMPLE`: removed `tone_direction` value, changed frequency_cap example from "4" to "3"
- All 4 campaign forms (inline per-vendor, top-level, brand detail, campaign edit page): removed Tone Direction input field; frequency_cap default changed from 4 to 3, max lowered from 30 to 6
- CSV upload INSERT: removed `tone_direction` column; auto-expiry added (today+30 when not provided); default cap 4→3
- `campaign/add` POST: removed `tone_direction` from body parse and INSERT; auto-expiry added; default cap 4→3
- `campaign/edit` POST: removed `tone_direction` from body parse and UPDATE SET; default cap 4→3
- Brand edit page: added `min_gap_days` and `platform_max_cap` number inputs with helper text
- `brand-config` POST: consolidated two branching DB calls into one unified UPSERT; saves `min_gap_days` and `platform_max_cap`
- Renew button was already present at line 339 — confirmed functional, no changes needed

### vendorFeeds.js
Both `|| 4` cap defaults updated to `|| 3`.

## Deviations from Plan

None — plan executed exactly as written.

**Note on Renew button:** The plan described adding a Renew button, but it was already implemented at vendorAdmin.js line 339 from a prior session. The POST handler at line 2192 also already existed. No duplicate code was added.

## Self-Check

### Created files exist:
- migrations/046_vendor_frequency_controls.js: confirmed present
### Commits exist:
- 4c857fc: confirmed (Task 1)
- ebe9767: confirmed (Task 2)
- 65a68f7: confirmed (Task 3)

## Self-Check: PASSED
