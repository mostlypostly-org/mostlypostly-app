---
phase: quick
plan: 260325-kv4
subsystem: integrations-ui
tags: [content-routing, ux, form-behavior]
dependency_graph:
  requires: []
  provides: [manual-save-only-content-routing]
  affects: [integrations-page]
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - src/routes/integrations.js
decisions:
  - "__applyAllActive guard removed entirely since individual checkboxes no longer auto-submit"
metrics:
  duration: "1 min"
  completed_date: "2026-03-25"
  tasks_completed: 1
  files_modified: 1
---

# Quick Task 260325-kv4: Remove Auto-Submit from Content Routing Card Summary

**One-liner:** Removed `onchange` auto-submit from individual routing checkboxes and eliminated `form.submit()` from Apply All handler so only the Save Routing button persists changes.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Remove auto-submit from individual checkboxes and Apply All handler | 3e8e971 | src/routes/integrations.js |

## What Changed

- `toggleCell()` function: removed `onchange="if(!window.__applyAllActive)this.form.submit()"` attribute from the checkbox `<input>`. The `col-${platform}` class remains for Apply All column targeting.
- Apply All `change` event listener: removed the three lines that submitted the routing form after cascading checkboxes. The cascade logic (querySelectorAll + cb.checked assignment) is intact.
- `window.__applyAllActive` guard: removed (`true`/`false` assignments) since the guard was only needed to suppress individual onchange submits, which are now gone.

## Deviations from Plan

None - plan executed exactly as written.

## Verification

```
No onchange auto-submit: true
No form.submit in Apply All: true
Save Routing button exists: true
ALL CHECKS PASSED
```

## Self-Check: PASSED

- File `src/routes/integrations.js` exists and was modified.
- Commit `3e8e971` confirmed in git log.
