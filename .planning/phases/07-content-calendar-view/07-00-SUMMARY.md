---
phase: 07-content-calendar-view
plan: "00"
subsystem: calendar-tests
tags: [tdd, vitest, calendar, business-logic]
dependency_graph:
  requires: []
  provides: [calendar-test-suite]
  affects: [07-01-PLAN, 07-02-PLAN]
tech_stack:
  added: []
  patterns: [tdd-red-green, vitest-esm]
key_files:
  created:
    - src/routes/calendar.test.js
  modified: []
decisions:
  - "rescheduleDateOnly tested as inline pure function since POST handler is not easily exported; mirrors the exact pattern from Pattern 5 in RESEARCH.md"
  - "Reel post type assigned indigo color per RESEARCH.md open question recommendation -- distinct from all 7 locked colors"
  - "UTC date range tests use America/Indiana/Indianapolis as the reference timezone (existing salon timezone in CLAUDE.md)"
metrics:
  duration: "89 seconds"
  completed: "2026-03-21T18:46:16Z"
  tasks_completed: 1
  files_created: 1
  files_modified: 0
---

# Phase 07 Plan 00: Calendar Test Scaffold Summary

**One-liner:** Vitest test suite (RED state) for calendar pill class map, reschedule date preservation, and UTC date range grouping — 24 test cases across 3 describe blocks.

## What Was Built

Created `src/routes/calendar.test.js` with Vitest unit tests covering the three pure-logic behaviors identified in the Phase 7 RESEARCH.md Validation Architecture:

1. **calendarPillClass** (14 cases) — vendor override, all post types (standard/before_after/availability/promotion/celebration/reel), failed status override, unknown type fallback
2. **Reschedule date math** (6 cases) — date replacement while preserving HH:mm:ss, year boundary, midnight, DST-adjacent dates
3. **UTC date range for calendar grid** (4 cases) — Indianapolis EST offset, 11pm local = next day UTC, 4-week window coverage, boundary completeness

## Task 1: Create calendar.test.js (TDD RED)

**Commit:** `5e55920`
**Files:** `src/routes/calendar.test.js`
**Status:** RED — import of `calendarPillClass` from `./calendar.js` fails with "Cannot find module" until Plan 01 creates the production file.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — this plan is test-only. No production code was written. No stubs to track.

## Self-Check: PASSED

- `src/routes/calendar.test.js` exists: FOUND
- Commit `5e55920` exists in git log: FOUND
- 3 describe blocks verified: calendarPillClass, reschedule date math, UTC date range for calendar grid
- RED state confirmed: vitest run returns `"Cannot find module './calendar.js'"` (expected behavior)
