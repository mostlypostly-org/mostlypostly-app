---
phase: 05-guest-care-and-support-staff
plan: "03"
subsystem: coordinator-visibility
tags: [coordinator, leaderboard, gamification, sms, attribution, dashboard]
dependency_graph:
  requires: [05-01]
  provides: [coordinator-leaderboard, coordinator-welcome-sms, submitted-by-badge]
  affects: [teamPerformance, stylistManager, manager-dashboard, database-view]
tech_stack:
  added: []
  patterns: [submitted_by-attribution, view-tab-toggle, 50pct-point-multiplier]
key_files:
  created: []
  modified:
    - src/core/gamification.js
    - src/core/stylistWelcome.js
    - src/routes/teamPerformance.js
    - src/routes/stylistManager.js
    - src/routes/manager.js
    - src/routes/dashboard.js
decisions:
  - getCoordinatorLeaderboard uses 50% point values (Math.round(getPointValue * 0.5)) to reflect that coordinators are facilitating rather than originating content
  - periodFilter called directly (not duplicated) — module-scoped function accessible within same file
  - View tabs preserve period param in href; period tabs preserve view param — cross-tab navigation is lossless
  - Coordinator leaderboard section uses display:none on stylist leaderboard div rather than conditional template string — simpler diff for review
  - submitted_by lookup is a per-row synchronous DB call — acceptable since better-sqlite3 is sync and result set is capped at 1000 rows
metrics:
  duration: 8
  completed_date: "2026-03-20"
---

# Phase 05 Plan 03: Coordinator Scoring, Leaderboard, Welcome SMS, and Attribution Badge Summary

Coordinator visibility suite: 50%-points leaderboard tab on Performance page, welcome SMS on creation, and "submitted by" attribution badges in the manager approval queue and Database view.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add getCoordinatorLeaderboard and sendCoordinatorWelcomeSms | cc4f69a | src/core/gamification.js, src/core/stylistWelcome.js |
| 2 | Wire coordinator tab, welcome SMS call, submitted-by badges | f9bd590 | src/routes/teamPerformance.js, src/routes/stylistManager.js, src/routes/manager.js, src/routes/dashboard.js |

## What Was Built

**getCoordinatorLeaderboard (gamification.js):**
- Groups published posts by `submitted_by` JOIN `managers.id`
- Applies 50% point values: `Math.round(getPointValue(salonId, row.post_type) * 0.5) * row.cnt`
- Returns `{ coordinator_name, coordinator_id, points, post_count, rank }` array sorted by points desc
- Rank assignment mirrors getLeaderboard (ties share rank, rank advances on point change)

**sendCoordinatorWelcomeSms (stylistWelcome.js):**
- Sends plain Twilio SMS (not RCS — no consent flow for portal users)
- Text: "You've been added as a coordinator at [salon]. To post for a stylist, text a photo and include their name (e.g. 'Taylor did this color'). Reply HELP for guidance."
- Guarded by `if (!phone) return`

**Performance page Coordinators tab (teamPerformance.js):**
- Imports `getCoordinatorLeaderboard` alongside existing `getLeaderboard`
- `view` query param: `?view=coordinators` or `?view=stylists` (default)
- Period tabs now include `&view=${view}` so tab switching preserves the view
- View tabs include `&period=${period}` so view switching preserves the period
- Coordinator table: Rank, Coordinator, Posts, Points columns
- Empty state: "No coordinator posts yet this period."
- Existing stylists leaderboard is hidden via `display:none` when view=coordinators — data unchanged

**Coordinator welcome SMS on creation (stylistManager.js):**
- Import updated: `import { sendWelcomeSms, sendCoordinatorWelcomeSms } from "../core/stylistWelcome.js"`
- Called after `INSERT INTO managers` when `role === "coordinator" && normalizePhone(phone)`
- Uses `.catch(err => console.error(...))` — fire-and-forget, never blocks redirect
- Phone input hint text updated to clarify phone is required for coordinators

**Submitted-by badge in approval queue (manager.js):**
- For each pending post: if `p.submitted_by`, queries `managers.name` synchronously
- Renders `<p class="text-[11px] text-mpMuted mt-1">via [Coordinator] on behalf of [Stylist]</p>`
- Badge inserted after metadata line and before promoExpiry — visible at a glance

**Submitted-by badge in Database view (dashboard.js):**
- `submitted_by` added to SQL SELECT (after `recycled_from_id`)
- Per-row `coordName` lookup inside `.map()` callback
- Stylist `<td>` now renders: stylist name on top, `<p class="text-[10px] text-mpMuted mt-0.5">via [name]</p>` below when coordName is present

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

Files created/modified:
- [x] src/core/gamification.js — contains `export function getCoordinatorLeaderboard`
- [x] src/core/stylistWelcome.js — contains `export async function sendCoordinatorWelcomeSms`
- [x] src/routes/teamPerformance.js — contains `view=coordinators`, `getCoordinatorLeaderboard`
- [x] src/routes/stylistManager.js — contains `sendCoordinatorWelcomeSms` call with `.catch()`
- [x] src/routes/manager.js — contains `submittedByBadge` with `text-[11px] text-mpMuted`
- [x] src/routes/dashboard.js — SQL includes `submitted_by`, badge with `text-[10px] text-mpMuted`

Commits:
- cc4f69a — feat(05-03): add getCoordinatorLeaderboard and sendCoordinatorWelcomeSms
- f9bd590 — feat(05-03): wire coordinator leaderboard tab, welcome SMS, and submitted-by badges

## Self-Check: PASSED
