---
name: 260319-fii Context
description: User decisions for fixing AI Generate button in Platform Console campaign forms
type: project
---

# Quick Task 260319-fii: Fix AI Generate Button — Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Task Boundary

Fix AI Generate button in Platform Console campaign forms (new + edit) — button does nothing
when clicked even with product name filled in.

Affects:
- Inline "+ Add Campaign" form under each vendor brand on main Platform Console page
- Top-level "+ Add Campaign" form (black button at top of campaigns section)
- Edit campaign page (/campaign/:id/edit)

</domain>

<decisions>
## Implementation Decisions

### Root Cause
Silent failure: onclick handlers evaluate `document.getElementById('...').value` inline in HTML
attributes. If the element lookup returns null for any reason, a `TypeError` is thrown inside
the onclick attribute evaluation BEFORE `aiGenerateDesc` is called. The browser swallows this
silently — no loading state, no alert, "absolutely nothing."

User confirmed: product name IS filled in before clicking, and button shows zero visual response.

### Fix Approach
Move all `document.getElementById` lookups INSIDE the JavaScript functions rather than evaluating
them inline in onclick attributes. Pass element IDs as strings, resolve values inside the function.

This eliminates the silent TypeError path and ensures the function is always called, allowing
proper error handling/feedback.

### Scope
Fix all three contexts: inline per-vendor form, top-level form, and edit campaign page.
Also fix `aiGenerateDescBrand` on the brand detail page (same pattern).

### Claude's Discretion
- Specific implementation detail of how to handle the ID-vs-value argument unification
- Whether to update error message text

</decisions>

<specifics>
## Specific Requirements

1. `aiGenerateDesc(btn, vendorArg, productNameInputId, targetId)` — change function to:
   - Resolve vendorArg: try `getElementById(vendorArg)`, use `.value` if found, else treat as literal string
   - Resolve productNameInputId: always `getElementById`, get `.value`, alert if element not found
   - Show explicit error if target textarea not found (not silent exit)

2. Inline form onclick: `aiGenerateDesc(this, '${safe(vendor)}', '${inlineProdId}', '${inlineFormId}')`
   — remove `.value` from inline HTML attribute

3. Top-level form onclick: `aiGenerateDesc(this, 'top-form-vendor-name', 'top-form-product-name', 'top-form-desc')`
   — pass element IDs, not inline `.value` calls

4. Brand detail page `aiGenerateDescBrand`: same pattern fix for onclick attribute
   — pass 'brand-form-product-name' as ID string, not `.value` inline

5. Edit campaign page `aiGen`: already fixed for CSRF in 077230b — no change needed there

</specifics>
