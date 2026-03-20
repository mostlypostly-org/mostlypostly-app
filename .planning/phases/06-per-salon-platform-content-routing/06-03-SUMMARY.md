---
phase: 06-per-salon-platform-content-routing
plan: 03
subsystem: scheduler
tags: [scheduler, platform-routing, vendor-admin, platform-console]

# Dependency graph
requires:
  - "06-01: platformRouting.js and platform_routing column"
provides:
  - "scheduler.js: isEnabledFor() guards on all four platform publish paths"
  - "vendorAdmin.js: Global Routing Defaults section with per-salon reset"
affects:
  - publishing-pipeline
  - platform-console

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "isEnabledFor(salon, postType, platform) called before every publish call in scheduler"
    - "gmbEligible and tiktokEligible extended with isEnabledFor() as final condition"
    - "getSalonPolicy() SELECT now includes platform_routing column"

key-files:
  created: []
  modified:
    - src/scheduler.js
    - src/routes/vendorAdmin.js

# Decisions made
decisions:
  - "isEnabledFor() guards wrap individual publish calls (not the entire publish block) so FB and IG can be disabled independently per post type"
  - "GMB and TikTok routing added as && condition on existing eligible check — no restructuring needed"
  - "Reset-routing POST route replicates requireSecret + requirePin pattern from set-plan route"
  - "buildRoutingTable logic inlined as template expression in vendorAdmin.js — consistent with existing inline HTML pattern in that file"

# Metrics
metrics:
  duration_minutes: 5
  completed_date: "2026-03-20"
  tasks_completed: 2
  files_modified: 2
---

# Phase 06 Plan 03: Scheduler Platform Routing Enforcement Summary

**One-liner:** Scheduler now calls `isEnabledFor()` before every FB/IG/GMB/TikTok publish; Platform Console shows salons with custom routing and reset capability.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add isEnabledFor guards to scheduler.js | bc4253b | src/scheduler.js |
| 2 | Platform Console Global Routing Defaults viewer | d017eb6 | src/routes/vendorAdmin.js |

## What Was Built

### Task 1 — Scheduler routing guards

`src/scheduler.js` now:
- Imports `isEnabledFor` from `./core/platformRouting.js`
- Includes `platform_routing` in the `getSalonPolicy()` SELECT query
- Guards FB publish in reel branch with `isEnabledFor(salon, postType, 'facebook')`
- Guards IG publish in reel branch with `isEnabledFor(salon, postType, 'instagram')`
- Guards IG story publish with `isEnabledFor(salon, postType, 'instagram')`
- Guards FB + IG in multi-image branch independently
- Guards FB + IG in single-image branch independently
- Extends `gmbEligible` with `&& isEnabledFor(salon, postType, 'gmb')`
- Extends `tiktokEligible` with `&& isEnabledFor(salon, postType, 'tiktok')`

Salons with `NULL` platform_routing (all existing salons) publish to all connected platforms unchanged — `isEnabledFor()` returns `true` for all calls when `platform_routing` is NULL.

### Task 2 — Platform Console Global Routing Defaults

`src/routes/vendorAdmin.js` now:
- Imports `DEFAULT_ROUTING` and `mergeRoutingDefaults` from `platformRouting.js`
- Exposes `POST /internal/vendors/reset-routing` — resets a salon's `platform_routing` to `NULL`
- Queries `salonsWithRouting` (salons with non-NULL platform_routing) in the GET "/" handler
- Shows routing_reset flash banner on success
- Renders a "Global Routing Defaults" card in the tab-salons section showing each salon's disabled rules and a Reset button
- Empty state when no salons have custom routing

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all routing checks are wired to live data from `salons.platform_routing`.

## Self-Check: PASSED

Files exist:
- src/scheduler.js — FOUND (modified)
- src/routes/vendorAdmin.js — FOUND (modified)

Commits exist:
- bc4253b — FOUND
- d017eb6 — FOUND

Acceptance criteria verified:
- `grep -c "isEnabledFor" src/scheduler.js` → 10 occurrences (requirement: >= 8)
- `platform_routing` present in getSalonPolicy SELECT — VERIFIED
- `isEnabledFor(salon, postType, 'gmb')` in gmbEligible — VERIFIED
- `isEnabledFor(salon, postType, 'tiktok')` in tiktokEligible — VERIFIED
- `isEnabledFor(salon, postType, 'facebook')` present — VERIFIED (4 occurrences)
- `isEnabledFor(salon, postType, 'instagram')` present — VERIFIED (4 occurrences)
- `node --check src/scheduler.js` — PASSED
- "Global Routing Defaults" in vendorAdmin.js — VERIFIED
- `router.post('/reset-routing',` in vendorAdmin.js — VERIFIED
- `UPDATE salons SET platform_routing = NULL` in vendorAdmin.js — VERIFIED
- `salonsWithRouting` in vendorAdmin.js — VERIFIED
- `import { DEFAULT_ROUTING, mergeRoutingDefaults }` in vendorAdmin.js — VERIFIED
- `routing_reset` flash param in vendorAdmin.js — VERIFIED
- `node --check src/routes/vendorAdmin.js` — PASSED
