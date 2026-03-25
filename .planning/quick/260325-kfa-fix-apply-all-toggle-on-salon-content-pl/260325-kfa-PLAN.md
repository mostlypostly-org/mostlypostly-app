---
phase: quick-260325-kfa
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/routes/integrations.js]
autonomous: true
requirements: []
must_haves:
  truths:
    - "Apply All toggles in Content Routing card on salon integrations page toggle all checkboxes in the corresponding platform column"
    - "Toggling Apply All on submits the form once (not per-checkbox)"
    - "Apply All row visual styling matches Platform Console (accent background, uppercase label)"
  artifacts:
    - path: "src/routes/integrations.js"
      provides: "Apply All row + event delegation JS in Content Routing card"
      contains: "data-apply-all"
  key_links:
    - from: "Apply All checkbox change event"
      to: "col-{platform} checkboxes"
      via: "document event delegation"
      pattern: "querySelectorAll.*col-"
---

<objective>
Fix the "Apply All" toggle on the salon Content Routing card in the integrations page (`/manager/integrations`). The Platform Console (`vendorAdmin.js`) has working Apply All toggles that use `data-apply-all` attributes + event delegation. The salon integrations page has the same per-platform checkbox grid but is missing the Apply All row and its JS handler entirely.

Purpose: Salon managers need to quickly enable/disable all content types for a given platform.
Output: Working Apply All toggles in the Content Routing card on the integrations page.
</objective>

<execution_context>
@~/.claude/get-shit-done/workflows/execute-plan.md
@~/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/routes/integrations.js (target file — Content Routing card at ~line 579, toggleCell helper at ~line 226, script block at ~line 718)
@src/routes/vendorAdmin.js (working reference — Apply All row at ~line 1095, event delegation at ~line 1650)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add col-{platform} class to toggleCell checkboxes and insert Apply All row</name>
  <files>src/routes/integrations.js</files>
  <action>
Three changes in `src/routes/integrations.js`:

**1. Add `col-{platform}` class to each checkbox in `toggleCell()` (around line 230):**

Change the checkbox input from:
```
class="sr-only peer"
```
to:
```
class="sr-only peer col-${platform}"
```

This lets the Apply All handler target all checkboxes in a column by class name.

**2. Insert an Apply All row in the Content Routing table between `</thead>` and `<tbody>` (around line 606).**

After the `</thead>` closing tag and before the `<tbody>` opening tag, insert:
```html
<tbody>
  <tr class="bg-mpAccentLight border border-mpBorder rounded-lg">
    <td class="py-2 pr-4 pl-2 text-xs font-bold text-mpAccent uppercase tracking-wide rounded-l-lg">Apply All</td>
    ${["facebook","instagram","gmb","tiktok"].map(plat => {
      // Determine if all enabled (non-disabled) checkboxes in this column are checked
      const allOn = Object.entries(routing).every(([pt, r]) => (r || {})[plat] !== false);
      return `
        <td class="text-center py-2 px-3">
          <label class="relative inline-flex items-center cursor-pointer" title="Toggle all ${plat}" data-apply-all="${plat}">
            <input type="checkbox"${allOn ? ' checked' : ''}
              class="sr-only peer"
              data-apply-all="${plat}">
            <div class="w-11 h-6 rounded-full transition-colors peer-checked:bg-mpAccent bg-gray-300 relative
              after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-all
              peer-checked:after:translate-x-5"></div>
          </label>
        </td>`;
    }).join("")}
  </tr>
</tbody>
```

Note: The Apply All row lives in its own `<tbody>` visually separated from the per-type rows `<tbody>`.

**3. Add event delegation handler in the `<script>` block (around line 718).**

Inside the existing `<script>` tag, after the DOMContentLoaded handler's closing `});`, add:

```javascript
// Apply All toggle — sets all col-{platform} checkboxes, then submits form once
document.addEventListener('change', function(e) {
  var input = e.target;
  if (!input.hasAttribute || !input.hasAttribute('data-apply-all')) return;
  var plat = input.getAttribute('data-apply-all');
  var checked = input.checked;
  // Suppress individual onchange auto-submits during cascade
  window.__applyAllActive = true;
  document.querySelectorAll('input.col-' + plat).forEach(function(cb) {
    if (cb.checked !== checked) {
      cb.checked = checked;
    }
  });
  window.__applyAllActive = false;
  // Submit the routing form once
  var form = document.querySelector('form[action="/manager/integrations/routing-update"]');
  if (form) form.submit();
});
```

Also update the individual checkbox `onchange` in `toggleCell()` from:
```
onchange="this.form.submit()"
```
to:
```
onchange="if(!window.__applyAllActive)this.form.submit()"
```

This prevents N form submissions when Apply All cascades through all checkboxes, and submits only once at the end.
  </action>
  <verify>
    <automated>cd /Users/troyhardister/chairlyos/mostlypostly/mostlypostly-app && grep -c "data-apply-all" src/routes/integrations.js && grep -c "col-\${platform}" src/routes/integrations.js && grep -c "__applyAllActive" src/routes/integrations.js</automated>
  </verify>
  <done>Content Routing card on /manager/integrations has an Apply All row per platform column. Clicking Apply All toggles all checkboxes in that column and submits the form once. Individual toggles still auto-submit on change. Visual styling matches Platform Console (accent background, uppercase label).</done>
</task>

</tasks>

<verification>
1. `grep "data-apply-all" src/routes/integrations.js` returns multiple matches (Apply All row + JS handler)
2. `grep "col-\${platform}" src/routes/integrations.js` confirms checkbox class added
3. `grep "__applyAllActive" src/routes/integrations.js` confirms cascade suppression
4. Server starts without errors: `node src/server.js` (smoke test)
</verification>

<success_criteria>
- Apply All toggle row visible in Content Routing card on salon integrations page
- Clicking Apply All ON checks all enabled platform checkboxes in that column and saves
- Clicking Apply All OFF unchecks all and saves
- Individual toggles still work independently with auto-submit
- No duplicate form submissions during Apply All cascade
</success_criteria>

<output>
After completion, create `.planning/quick/260325-kfa-fix-apply-all-toggle-on-salon-content-pl/260325-kfa-SUMMARY.md`
</output>
