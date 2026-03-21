---
phase: 7
slug: content-calendar-view
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-03-21
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vitest.config.mjs` (includes `src/**/*.test.js`) |
| **Quick run command** | `npx vitest run src/routes/calendar.test.js` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/routes/calendar.test.js`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 07-00-01 | 00 | 0 | CAL-01, CAL-02, CAL-05 | unit | `npx vitest run src/routes/calendar.test.js` | ❌ W0 | ⬜ pending |
| 07-01-01 | 01 | 1 | CAL-01, CAL-02 | unit+smoke | `npx vitest run src/routes/calendar.test.js` | ✅ after W0 | ⬜ pending |
| 07-01-02 | 01 | 1 | CAL-01, CAL-02 | unit | `npx vitest run src/routes/calendar.test.js` | ✅ after W0 | ⬜ pending |
| 07-02-01 | 02 | 2 | CAL-03, CAL-04 | smoke/manual | manual navigation | N/A | ⬜ pending |
| 07-02-02 | 02 | 2 | CAL-05 | unit | `npx vitest run src/routes/calendar.test.js` | ✅ after W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/routes/calendar.test.js` — unit tests for:
  - `calendarPillClass()` — correct class for each post type + vendor override (CAL-02)
  - Date range grouping logic — UTC date range returns correct posts (CAL-01)
  - Reschedule date math — time-of-day preserved, only date portion changes (CAL-05)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Day panel slide-out renders full post cards | CAL-03 | Server route returns HTML fragment, not testable as unit | Click any populated day cell, verify panel slides open with image, caption, type badge, stylist/vendor name |
| Approve/deny/post-now links work from panel | CAL-04 | Depends on existing manager.js routes + session state | Click Approve on a manager_pending post in panel, verify post moves to approved state and calendar refreshes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
