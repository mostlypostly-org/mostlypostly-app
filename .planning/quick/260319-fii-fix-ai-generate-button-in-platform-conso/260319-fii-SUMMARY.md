---
phase: quick-260319-fii
plan: 01
subsystem: vendor-admin
tags: [bug-fix, platform-console, ai-generate, vendor-campaigns]
dependency_graph:
  requires: []
  provides: [working-ai-generate-buttons]
  affects: [src/routes/vendorAdmin.js]
tech_stack:
  added: []
  patterns: [defer-getElementById-to-runtime]
key_files:
  modified:
    - src/routes/vendorAdmin.js
decisions:
  - "Pass element IDs as strings to JS functions; resolve via getElementById inside
    the function body to avoid TypeError when onclick attributes evaluate before
    DOM is ready"
metrics:
  duration: "5 minutes"
  completed: "2026-03-19"
  tasks_completed: 1
  tasks_total: 1
  files_modified: 1
---

# Quick Task 260319-fii: Fix AI Generate Button in Platform Console

**One-liner:** Moved `document.getElementById(...).value` out of onclick HTML attributes and into function bodies to eliminate silent TypeErrors blocking AI description generation across all three campaign form contexts.

## What Was Done

The AI Generate button on vendor campaign forms was silently doing nothing when clicked. The root cause: onclick HTML attributes were evaluating `document.getElementById('...').value` inline. When those element IDs weren't resolvable at click time (or the lookup returned null), a TypeError was thrown before the target function was ever called, and the browser swallowed it silently.

### Changes Made

**`src/routes/vendorAdmin.js`** — 5 targeted edits:

**Inline per-vendor campaign form onclick (line 424):**
- Before: `aiGenerateDesc(this, '${safe(vendor)}', document.getElementById('${inlineProdId}').value, '${inlineFormId}')`
- After: `aiGenerateDesc(this, '${safe(vendor)}', '${inlineProdId}', '${inlineFormId}')`

**Top-level campaign form onclick (line 992):**
- Before: `aiGenerateDesc(this, document.getElementById('top-form-vendor-name').value, document.getElementById('top-form-product-name').value, 'top-form-desc')`
- After: `aiGenerateDesc(this, 'top-form-vendor-name', 'top-form-product-name', 'top-form-desc')`

**Brand detail page onclick (line ~1799):**
- Before: `aiGenerateDescBrand(this, '${safe(brand.vendor_name)}', document.getElementById('brand-form-product-name').value, 'brand-form-desc')`
- After: `aiGenerateDescBrand(this, '${safe(brand.vendor_name)}', 'brand-form-product-name', 'brand-form-desc')`

**`aiGenerateDesc` function (line 1109):**
- New signature: `(btn, vendorArg, productNameInputId, targetId)`
- Resolves vendor: `getElementById(vendorArg)` with fallback to literal string (handles inline forms that pass vendor name directly)
- Resolves product: `getElementById(productNameInputId)` with explicit alert if missing
- Replaced silent `if (!target) return` with explicit alert

**`aiGenerateDescBrand` function (line 1856):**
- New signature: `(btn, vendorArg, productNameInputId, targetId)`
- Same resolution pattern as `aiGenerateDesc`

**Edit campaign page `aiGen` function was intentionally left untouched** (already fixed in commit 077230b).

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 4560978 | fix(quick-260319-fii): AI Generate button now resolves element IDs internally |

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- `grep -n "document.getElementById.*\.value" src/routes/vendorAdmin.js | grep "onclick"` returns 0 matches
- All three onclick call sites pass string IDs only
- Both function signatures updated to `(btn, vendorArg, productNameInputId, targetId)`
- Commit 4560978 verified in git log
