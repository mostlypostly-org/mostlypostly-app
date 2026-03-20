---
phase: 02-content-engine
plan: 04
subsystem: ui
tags: [dashboard, recycle, sqlite, html, express]

# Dependency graph
requires:
  - phase: 02-content-engine
    plan: 01
    provides: contentRecycler.js with recycled_from_id column — required for banner query and undo handler
provides:
  - Blue info banner on manager dashboard when posts auto-recycled this week
  - Undo-recycle POST handler on /dashboard/undo-recycle with IDOR protection
  - Recycled badge on Database view rows
affects:
  - 02-content-engine (dashboard and manager UI)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Banner pattern: conditional HTML string rendered server-side, inserted after failedBanner in body template
    - IDOR protection: all post mutations verify salon_id = session salon before acting

key-files:
  created: []
  modified:
    - src/routes/manager.js
    - src/routes/dashboard.js

key-decisions:
  - "Recycle banner query uses datetime('now', '-7 days') — matches 7-day rolling window, not calendar week"
  - "Undo form passes salon as query param on action URL — consistent with dashboard resolveSalonId(req) pattern"
  - "Actions column added to Database table header — avoids orphaned Undo button with no column label"

patterns-established:
  - "Recycle notice banner: id='recycle-notice' + JS DOM removal — no server-side persistence needed"
  - "Undo IDOR guard: check recycled_from_id before delete — prevents deleting non-recycled posts via tampered POST"

requirements-completed: [RECYC-11]

# Metrics
duration: 4min
completed: 2026-03-20
---

# Phase 02 Plan 04: Auto-Recycle Notice Banner and Undo Summary

**Blue info banner on manager dashboard queries recycled_from_id within 7 days; Database view adds Undo button and Recycled badge with IDOR-protected DELETE handler**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-20T02:10:00Z
- **Completed:** 2026-03-20T02:14:10Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Manager dashboard shows a blue info banner with correct singular/plural grammar when auto-recycled posts exist this week
- Banner links to Database view filtered to published posts and is dismissible via JS DOM removal
- Database view rows for recycled posts now show a "Recycled" badge and an "Undo" button with a confirmation dialog
- POST /dashboard/undo-recycle handler verifies salon ownership and recycled_from_id before deletion

## Task Commits

Each task was committed atomically:

1. **Task 1: Add auto-recycle notice banner to manager dashboard** - `43d355a` (feat)
2. **Task 2: Add undo-recycle POST handler to dashboard** - `f3d6086` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `src/routes/manager.js` - Added recycledThisWeek query and recycleBanner HTML, inserted after failedBanner in body
- `src/routes/dashboard.js` - Added recycled_from_id to SELECT, Recycled badge, Undo form, undo-recycle POST handler, Actions column header

## Decisions Made
- Recycle banner query uses `datetime('now', '-7 days')` — rolling 7-day window not calendar week boundary
- Undo form passes salon as query param on action URL to match existing `resolveSalonId(req)` pattern in dashboard.js
- Actions column header added to Database table to avoid UI orphan

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Auto-recycle notice pipeline complete: recycler fires → banner shows on dashboard → manager can undo via Database view
- Ready for Phase 02 Plan 05 (KB article for auto-recycling feature)

---
*Phase: 02-content-engine*
*Completed: 2026-03-20*
