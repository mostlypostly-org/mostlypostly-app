---
phase: 07-content-calendar-view
plan: 02
subsystem: calendar
tags: [calendar, day-panel, actions, drag-reschedule, csrf, manager-approval]
dependency_graph:
  requires: ["07-01"]
  provides: [calendar-day-panel-actions, return-calendar-redirects, drag-draggable-only]
  affects: [src/routes/calendar.js, src/routes/manager.js]
tech_stack:
  added: []
  patterns: [return-param-redirect, inline-deny-form, csrf-from-res-locals]
key_files:
  modified:
    - src/routes/calendar.js
    - src/routes/manager.js
decisions:
  - "Inline deny form toggled by button in day panel — avoids navigating away from calendar; CSRF token from res.locals.csrfToken (not req.csrfToken() which doesn't exist on this pattern)"
  - "data-draggable=true only on manager_approved posts with scheduled_for — prevents dragging published/pending/failed posts"
  - "SortableJS draggable selector updated to .calendar-post-card[data-draggable=true] — enforces drag restriction at library level"
  - "return=calendar handled as query param for GET routes (approve, post-now) and body param for POST routes (deny, retry-post) — matches HTTP conventions"
metrics:
  duration: 144s
  completed: "2026-03-21"
  tasks: 2
  files: 2
---

# Phase 07 Plan 02: Day Panel Actions and Return-to-Calendar Summary

Day panel in calendar.js wired with return=calendar on all action links/forms, inline deny toggled by button, CSRF injected from res.locals, and draggable restricted to manager_approved scheduled posts only.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Day panel return=calendar actions and draggable-only pills | fcc5483 | src/routes/calendar.js |
| 2 | return=calendar redirect support in approve/deny/post-now/retry | a2dafa8 | src/routes/manager.js |

## What Was Built

### Task 1 — calendar.js day panel actions

Updated the day panel fragment generator in `GET /day/:date`:

- **Approve link**: now `href="/manager/approve?post=ID&return=calendar"` — manager returns to calendar after approving
- **Deny button**: changed from an anchor navigating to `/manager/deny` (separate page) to an inline toggle button that reveals a hidden `<form>` below. The inline deny form posts to `/manager/deny` with `return=calendar` and `_csrf` token
- **Post Now link**: now `href="/manager/post-now?post=ID&return=calendar"` — manager stays on calendar
- **Retry form (failed posts)**: added `<input name="return" value="calendar" />` and `<input name="_csrf">` — returns to calendar after retry
- **CSRF**: sourced from `res.locals.csrfToken` (set by the csrf middleware on every request, available at render time). The CSRF middleware auto-injects into `<form method="POST">` patterns in full HTML responses but not fragments — so manual injection into the retry and deny forms is needed.
- **data-draggable**: grid pill rendering now sets `data-draggable="true"` only when `p.status === "manager_approved" && !!p.scheduled_for`. Pending, published, and failed posts get `cursor-default` and no data-draggable attribute.
- **SortableJS draggable selector**: updated from `.calendar-post-card` to `.calendar-post-card[data-draggable="true"]` — only approved scheduled posts can be dragged between days.

### Task 2 — manager.js return=calendar support

Modified four route handlers with backward-compatible redirect logic:

| Route | Param checked | Redirect target |
|-------|--------------|-----------------|
| `GET /approve` | `req.query.return` | `/manager/calendar` or `/manager` |
| `GET /post-now` | `req.query.return` | `/manager/calendar` or `/manager` |
| `POST /deny` | `req.body.return` | `/manager/calendar` or `/manager` |
| `POST /retry-post` | `req.body.return` | `/manager/calendar` or `/manager` |

Both early-exit paths in `/approve` (post not found) and `/deny` (post not found) also respect the return param.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Day panel already existed from Plan 01 — only actions needed updating**

- **Found during:** Task 1 analysis
- **Issue:** calendar.js from Plan 01 already had `GET /day/:date` and `POST /reschedule` fully implemented, but the day panel action links/forms lacked `return=calendar` and CSRF tokens, and the deny action linked away to a separate deny page
- **Fix:** Updated the actions block in the existing handler (not a rewrite) and added inline deny form
- **Files modified:** src/routes/calendar.js
- **Commit:** fcc5483

**2. [Rule 2 - Missing] data-draggable attribute absent from grid pills**

- **Found during:** Task 1 verification (plan acceptance criteria check)
- **Issue:** All grid pills used the same `.calendar-post-card` class with no draggability distinction — pending/published/failed posts were draggable too
- **Fix:** Added conditional `data-draggable="true"` and cursor class; updated SortableJS draggable selector
- **Files modified:** src/routes/calendar.js
- **Commit:** fcc5483

## Test Results

22 pass / 2 pre-existing failures in `src/routes/calendar.test.js`

The 2 failures are in the "UTC date range for calendar grid" describe block — the test hardcodes UTC-5 for `America/Indiana/Indianapolis` in April, but that timezone observes EDT (UTC-4) from March 8 onwards. The tests will pass in winter. These failures predate this plan and are in the test file itself, not production code.

## Known Stubs

None — all action links are fully wired to production routes.

## Self-Check: PASSED

- src/routes/calendar.js modified: confirmed (2 commits reference it)
- src/routes/manager.js modified: confirmed (commit a2dafa8)
- `return=calendar` in calendar.js approve href: `grep -c "return=calendar" src/routes/calendar.js` = 3
- `return=calendar` checks in manager.js: 10 references across 4 handlers
- `data-draggable` in calendar.js: 2 occurrences (data attr and SortableJS selector)
- `_csrf` in day panel fragment: 2 occurrences (deny form + retry form)
- No `await db.prepare` anywhere in calendar.js
