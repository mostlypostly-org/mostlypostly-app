---
phase: 07-content-calendar-view
verified: 2026-03-21T00:00:00Z
status: passed
score: 6/6 must-haves verified
re_verification: false
human_verification:
  - test: "Navigate to /manager/calendar and visually confirm month grid"
    expected: "5-row x 7-column Sunday-anchored grid, today highlighted with blue ring, color-coded post pills visible"
    why_human: "Visual layout, ring highlight, and pill rendering depend on browser DOM and Tailwind CDN classes"
  - test: "Click a day cell that has posts and confirm slide-out panel opens"
    expected: "Panel slides in from right, shows thumbnail, type badge, status badge, time, caption preview, and action buttons"
    why_human: "Fragment fetch via openDayPanel(), innerHTML injection, and panel visibility toggling require browser execution"
  - test: "Click Approve on a pending post in the day panel"
    expected: "Post is approved and browser redirects back to /manager/calendar (not /manager)"
    why_human: "End-to-end redirect behavior requires a live session and DB state"
  - test: "Drag an approved post pill to a different day cell"
    expected: "SortableJS moves the pill visually; POST /manager/calendar/reschedule fires; post appears on the new day on next calendar load"
    why_human: "Drag interaction requires browser, SortableJS CDN load, and a live DB record with manager_approved status"
---

# Phase 7: Content Calendar View — Verification Report

**Phase Goal:** Managers can see all scheduled and published posts on a visual 4-week calendar, click any day to preview posts in a slide-out panel, approve/deny/post-now directly from the panel, and drag-drop posts to reschedule them (FEAT-018)
**Verified:** 2026-03-21
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Manager can navigate to /manager/calendar and see a 4-week month grid | VERIFIED | `GET /` handler in calendar.js builds 5-week Sunday-based grid using Luxon; mounted at `app.use("/manager/calendar", calendarRoute)` in server.js line 447 |
| 2 | Each day cell shows thumbnail pills for that day's posts, color-coded by type | VERIFIED | `calendarPillClass(post)` and `calendarPillLabel(post)` functions fully implemented; all 8 post types mapped; pills rendered per cell from `byDate` Map |
| 3 | Vendor posts display a purple pill with vendor name | VERIFIED | `if (post.vendor_campaign_id) return "bg-purple-100 text-purple-700 border-purple-200"` in calendarPillClass; vendor_name comes from LEFT JOIN vendor_campaigns |
| 4 | Calendar nav item appears between Post Queue and Analytics in sidebar | VERIFIED | pageShell.js line 155: `navItem("/manager/calendar", ICONS.calendar, "Calendar", "calendar")` between queue (line 154) and analytics (line 156); mobile: same order at lines 196-198 |
| 5 | Clicking a day opens a panel with post cards, image, type badge, status, and actions | VERIFIED | `GET /day/:date` handler returns HTML fragment with thumbnail (`toProxyUrl`), typeLabel, statusBadge, timeDisplay, caption preview, and action buttons per status |
| 6 | Drag-to-reschedule changes date while preserving time-of-day | VERIFIED | `POST /reschedule` uses `DateTime.fromSQL(scheduled_for, { zone: "utc" })` + `.set({ year, month, day })` to swap date only; SortableJS onEnd fires fetch to this endpoint |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/routes/calendar.js` | Calendar route handler with GET / month grid, GET /day/:date fragment, POST /reschedule | VERIFIED | 454 lines, substantive, all three handlers present, exported as default router + named calendarPillClass |
| `src/ui/pageShell.js` | Calendar nav item and ICONS.calendar SVG | VERIFIED | ICONS.calendar at line 293, navItem at line 155, mobileNavLink at line 197 |
| `server.js` | Calendar route mounted at /manager/calendar | VERIFIED | `import calendarRoute from "./src/routes/calendar.js"` at line 89; `app.use("/manager/calendar", calendarRoute)` at line 447 |
| `src/routes/manager.js` | Approve/post-now/deny/retry with return=calendar redirect support | VERIFIED | 6 occurrences of return=calendar logic across all 4 handlers including early-exit paths |
| `src/routes/calendar.test.js` | Unit test suite for calendar business logic | VERIFIED | File exists (8.5KB); tests calendarPillClass, UTC date range, reschedule date math |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| server.js | src/routes/calendar.js | `import calendarRoute` + `app.use("/manager/calendar")` | WIRED | Line 89 (import) + line 447 (mount) |
| src/routes/calendar.js | db.js | LEFT JOIN vendor_campaigns query | WIRED | `LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id` in both GET / and GET /day/:date handlers |
| src/ui/pageShell.js | /manager/calendar | navItem + mobileNavLink entries | WIRED | Desktop nav line 155, mobile nav line 197 |
| GET /day/:date approve link | src/routes/manager.js GET /approve | href with `return=calendar` | WIRED | `href="/manager/approve?post=${safe(p.id)}&return=calendar"` |
| GET /day/:date deny form | src/routes/manager.js POST /deny | form with `name="return" value="calendar"` | WIRED | Hidden input `name="return" value="calendar"` in inline form; manager.js checks `req.body.return` |
| GET /day/:date post-now link | src/routes/manager.js GET /post-now | href with `return=calendar` | WIRED | `href="/manager/post-now?post=${safe(p.id)}&return=calendar"` |
| GET /day/:date retry form | src/routes/manager.js POST /retry-post | form with `name="return" value="calendar"` | WIRED | Hidden input in retry form; manager.js checks `req.body.return` |
| SortableJS onEnd | POST /manager/calendar/reschedule | fetch with postId and newDate | WIRED | `fetch('/manager/calendar/reschedule', { method: 'POST', body: JSON.stringify({ postId, newDate }) })` |

---

### Requirements Coverage

The plans declare CAL-01 through CAL-05 as requirements. These IDs appear only in ROADMAP.md Phase 7 — they are NOT defined as individual items in REQUIREMENTS.md. REQUIREMENTS.md covers phases 1-5 requirement sets (VSYNC, RECYC, SCHED, REEL, REP, COORD). Phase 7 was added to the roadmap after REQUIREMENTS.md was last updated.

**ORPHANED REQUIREMENT IDs** — CAL-01, CAL-02, CAL-03, CAL-04, CAL-05 are declared in plan frontmatter but have no corresponding entries in REQUIREMENTS.md. The goal description in ROADMAP.md is the only authoritative specification.

| Requirement | Source | Status | Evidence |
|-------------|--------|--------|----------|
| CAL-01 | ROADMAP Phase 7 goal / 07-00 + 07-01 plan | NOT IN REQUIREMENTS.MD — goal satisfied | Month grid with color-coded pills is fully implemented |
| CAL-02 | ROADMAP Phase 7 goal / 07-01 plan | NOT IN REQUIREMENTS.MD — goal satisfied | Vendor posts show purple pill with vendor_name from LEFT JOIN |
| CAL-03 | ROADMAP Phase 7 goal / 07-02 plan | NOT IN REQUIREMENTS.MD — goal satisfied | GET /day/:date returns full post card fragment with actions |
| CAL-04 | ROADMAP Phase 7 goal / 07-02 plan | NOT IN REQUIREMENTS.MD — goal satisfied | Approve/deny/post-now/retry actions wired with return=calendar redirects |
| CAL-05 | ROADMAP Phase 7 goal / 07-00 + 07-02 plan | NOT IN REQUIREMENTS.MD — goal satisfied | POST /reschedule endpoint preserves time-of-day; SortableJS onEnd fires it |

**Note:** REQUIREMENTS.md should be updated to define CAL-01 through CAL-05 formally for traceability, but the absence does not block the phase goal — the implementation matches the ROADMAP description.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| calendar.js | 377 | `placeholder="Reason for denial..."` | INFO | HTML input placeholder attribute — not a code stub; user-facing helper text in deny form textarea |

No blockers. No FIXME/TODO comments. No `await db.prepare` (synchronous DB used correctly throughout). No `require()` calls (ESM throughout). No hardcoded empty data flowing to render.

---

### Human Verification Required

#### 1. Month grid visual rendering

**Test:** Log into the manager portal and navigate to `/manager/calendar`
**Expected:** 5-row x 7-column grid with Sun-Sat headers, today's cell has a blue ring, out-of-month days show in gray, color-coded pills visible for scheduled/published posts, color legend visible below the grid
**Why human:** Visual layout correctness, Tailwind CDN class resolution, ring highlight rendering

#### 2. Day panel slide-out behavior

**Test:** Click a day cell that has posts (do not click a pill, click the cell background)
**Expected:** Panel slides in from the right showing a list of post cards; each card has a thumbnail (or camera emoji fallback), type badge, status badge, scheduled time, stylist name, and caption preview
**Why human:** Fragment fetch via `openDayPanel()`, `innerHTML` injection, and panel CSS transition require browser execution

#### 3. Approve from day panel

**Test:** Find a `manager_pending` post in the day panel, click Approve
**Expected:** Post is approved and browser redirects to `/manager/calendar` (not `/manager`)
**Why human:** End-to-end redirect behavior and DB state change require a live session

#### 4. Inline deny from day panel

**Test:** Find a `manager_pending` post, click Deny, enter a reason, click Submit Denial
**Expected:** Inline form reveals below the Deny button; on submit, post is denied and browser redirects to `/manager/calendar`
**Why human:** Toggle behavior (button shows/hides form), CSRF token injection in fragment, and redirect path require live execution

#### 5. Drag reschedule

**Test:** Find an approved (blue "Scheduled" badge) post pill and drag it to a different day cell
**Expected:** Pill moves to the new cell visually; POST to /reschedule fires and succeeds; refreshing the calendar shows the post on the new date at the same time
**Why human:** SortableJS drag interaction, CDN load, `data-draggable="true"` selector enforcement, and DB persistence require browser + live data

---

### Gaps Summary

No gaps. All automated checks passed. The phase goal is achieved — the calendar route exists, renders a substantive 4-week grid, vendor posts show purple pills, the nav item is correctly positioned, the day panel fragment is fully implemented, all four action routes in manager.js support return=calendar, and drag-to-reschedule is wired end-to-end.

The only open item is a documentation gap: CAL-01 through CAL-05 requirement IDs referenced in plan frontmatter are not defined as rows in REQUIREMENTS.md. This is a traceability gap, not a functional gap.

---

_Verified: 2026-03-21_
_Verifier: Claude (gsd-verifier)_
