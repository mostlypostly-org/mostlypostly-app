---
phase: 02-content-engine
plan: 03
subsystem: ui
tags: [content-recycler, admin-settings, dashboard, sqlite]

# Dependency graph
requires:
  - phase: 02-content-engine plan 01
    provides: contentRecycler.js with cloneAndEnqueue shared helper
provides:
  - Auto-recycle toggle in Admin Manager Rules (all plans)
  - Caption-refresh-on-recycle toggle in Admin Manager Rules (Growth/Pro only)
  - Recycle button on published post rows in Database view
  - Block toggle on published post rows in Database view
  - POST /dashboard/recycle-post handler with IDOR protection
  - POST /dashboard/toggle-block handler with IDOR protection
affects: [02-content-engine, admin-settings, dashboard-views]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Plan-gated UI (showCaptionRefresh computed server-side, element omitted from DOM for Starter/trial)
    - Shared recycler helper called from manual route (same code path as auto-recycle)
    - IDOR protection on both new POST handlers via salon_id from session/token

key-files:
  created: []
  modified:
    - src/routes/admin.js
    - src/routes/dashboard.js

key-decisions:
  - "Caption refresh toggle omitted from DOM entirely for Starter/trial — not greyed, not in HTML"
  - "Manual recycle calls cloneAndEnqueue (shared with auto-recycle) — single code path for RECYC-05"
  - "salon_id sourced from req.body.salon (hidden input) then session fallback in POST handlers — never trusted from body alone"
  - "Block toggle reads Referer header for redirect — preserves active filter state"

patterns-established:
  - "Plan-gate: salonPlan check with ['growth','pro'].includes(), result used to conditionally render HTML"
  - "IDOR protection pattern: WHERE id=? AND salon_id=? on every row-level mutation"

requirements-completed: [RECYC-08, RECYC-09, RECYC-10]

# Metrics
duration: 8min
completed: 2026-03-20
---

# Phase 02 Plan 03: Admin Recycle Toggles and Database Recycle/Block Actions Summary

**Admin Manager Rules gains auto-recycle and plan-gated caption-refresh toggles; Database view gains Recycle and Block buttons on published posts backed by shared cloneAndEnqueue**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-20T02:15:00Z
- **Completed:** 2026-03-20T02:23:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Admin Manager Rules form shows Auto-Recycle select (all plans) and Caption Refresh on Recycle select (Growth/Pro only, absent from DOM for Starter/trial)
- update-manager-rules POST handler saves both auto_recycle and caption_refresh_on_recycle to the salons table
- Database view published-post rows now show Recycle button (blue, calls shared cloneAndEnqueue) and Block toggle (red when blocked, muted when not)
- POST /dashboard/recycle-post verifies ownership, calls cloneAndEnqueue, redirects with success notice
- POST /dashboard/toggle-block flips block_from_recycle, preserves filter state via Referer redirect

## Task Commits

Each task was committed atomically:

1. **Task 1: Add auto_recycle and caption_refresh_on_recycle toggles to Admin Manager Rules** - `43a84ae` (feat)
2. **Task 2: Add Recycle button and Block toggle to Database view with POST handlers** - `2eb9e78` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/routes/admin.js` - Added salonPlan check, auto_recycle select, conditional caption_refresh_on_recycle select, extended POST handler destructure + UPDATE SQL + .run() params
- `src/routes/dashboard.js` - Added cloneAndEnqueue import, block_from_recycle to SELECT, noticeBanner, Recycle/Block buttons in Actions td, POST /recycle-post and POST /toggle-block handlers

## Decisions Made
- Caption refresh toggle omitted entirely from DOM for Starter/trial rather than greyed — prevents any chance of form submission with unset plan
- Manual recycle calls the same cloneAndEnqueue as auto-recycle — ensures RECYC-05 (caption refresh) applies consistently via the toggle, not duplicated logic
- salon_id passed as hidden `<input name="salon">` in row forms so POST handlers always have the right context even without req.session being populated

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness
- Auto-recycle settings are now manager-configurable from Admin
- Manual recycle and block actions are live in the Database view
- Ready for Phase 02-04 (dashboard auto-recycle notices) and 02-05 (KB article)

---
*Phase: 02-content-engine*
*Completed: 2026-03-20*
