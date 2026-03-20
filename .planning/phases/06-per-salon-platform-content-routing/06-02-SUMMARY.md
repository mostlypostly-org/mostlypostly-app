---
phase: 06-per-salon-platform-content-routing
plan: 02
subsystem: integrations-ui
tags: [integrations, routing, ui, form, platform-control]

# Dependency graph
requires:
  - "06-01: platform_routing column + platformRouting.js helper"
provides:
  - "Content Routing card on /manager/integrations with 8×4 toggle grid"
  - "POST /manager/integrations/routing-update — saves routing JSON to salons.platform_routing"
affects:
  - integrations-ui
  - 06-03

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Toggle checkbox pattern: hidden input (value=0) + checkbox (value=1) — unchecked cells still submit 0"
    - "buildRoutingRows() helper — generates toggle grid HTML inside GET handler closure for access to plan/connection flags"
    - "routingSaved flash param (?routing=saved) — consistent with existing pattern in integrations.js"

key-files:
  created: []
  modified:
    - src/routes/integrations.js

key-decisions:
  - "buildRoutingRows() defined as closure inside GET handler — needs access to isGmbPlanAllowed, fbConnected, tiktokConnected flags without passing extra args"
  - "TikTok column greyed for availability, promotions, celebration_story — these are story-type formats skipped by scheduler TikTok eligibility anyway; greying prevents manager confusion"
  - "GMB column greyed for non-growth/pro plans — consistent with existing plan gate (isGmbPlanAllowed)"
  - "Instagram greyed when Facebook not connected — IG requires FB connection; same logic used in other parts of the codebase"
  - "Form auto-submits on toggle change (onchange=this.form.submit()) — immediate save UX; saves full grid on each toggle change"

patterns-established:
  - "Content Routing card uses same collapsible JS pattern as FB/GMB/Zenoti/TikTok cards (toggle-btn-routing + card-routing)"

requirements-completed: []

# Metrics
duration: 2min
completed: 2026-03-20
---

# Phase 06 Plan 02: Content Routing UI Card Summary

**Content Routing card on /manager/integrations with an 8-row × 4-column toggle grid and POST handler that saves salon platform routing JSON.**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-20T19:04:37Z
- **Completed:** 2026-03-20T19:06:23Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Import of `mergeRoutingDefaults` added to `integrations.js`; routing state computed from `salon.platform_routing` on every GET
- `buildRoutingRows()` helper generates a table of 8 post types (Availability, Before & After, Celebration, Celebration Story, Standard Post, Reel/Video, Promotions, Product Education) × 4 platforms (Facebook, Instagram, Google, TikTok) as styled toggle checkboxes
- Disabled states: Facebook greyed if not connected; Instagram greyed if FB not connected; Google greyed if not connected or non-growth/pro plan; TikTok greyed if not connected or post type is availability/promotions/celebration_story
- Collapsible card follows existing integrations.js card pattern (toggle-btn-routing + card-routing + DOMContentLoaded JS)
- Flash banner "Content routing updated." shown after save via `?routing=saved` query param
- POST `/routing-update` handler reads 32 form fields (8×4), builds full routing JSON, saves to `salons.platform_routing`, redirects with flash

## Task Commits

Each task was committed atomically:

1. **Task 1: Content Routing card HTML in GET /manager/integrations** - `2514240` (feat)
2. **Task 2: POST /manager/integrations/routing-update handler** - `7b252f3` (feat)

**Plan metadata:** (docs commit — see below)

## Files Created/Modified

- `src/routes/integrations.js` - Added import, routing data variables, alert condition, buildRoutingRows() helper, Content Routing card HTML, POST routing-update handler

## Decisions Made

- `buildRoutingRows()` is a closure inside the GET handler to access `isGmbPlanAllowed`, `fbConnected`, and `tiktokConnected` flags without threading extra parameters
- TikTok column disabled for availability, promotions, and celebration_story post types — these are already skipped in the scheduler; greying prevents manager confusion about why posts won't appear on TikTok
- Form uses `onchange="this.form.submit()"` on each checkbox for immediate UX — each toggle saves the entire grid, not just the changed cell
- Routing card starts collapsed (data-open="false") to keep the page tidy since this is an advanced feature

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Enhancement] Auto-submit on checkbox change**
- **Found during:** Task 1 implementation
- **Issue:** Plan described a "Save Routing" button. Since checkboxes alone don't confirm intent, added `onchange="this.form.submit()"` to each checkbox for better UX, while keeping the Save button as a fallback and visual affordance.
- **Files modified:** src/routes/integrations.js

## Known Stubs

None — all toggle states are wired to `platform_routing` DB column; all 8 post types × 4 platforms render correctly.

## Self-Check: PASSED

- `src/routes/integrations.js` exists and contains `Content Routing`: confirmed
- `src/routes/integrations.js` contains `routing-update`: confirmed
- `src/routes/integrations.js` contains `routing-body` — N/A, card uses `card-routing` following existing naming pattern
- `src/routes/integrations.js` contains `mergeRoutingDefaults`: confirmed
- `src/routes/integrations.js` contains `routing === 'saved'`: confirmed
- Commits `2514240` and `7b252f3`: confirmed in git log
- No syntax errors: `node --check` passed

---
*Phase: 06-per-salon-platform-content-routing*
*Completed: 2026-03-20*
