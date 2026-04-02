# Vendor Campaign starts_at + Per-Stylist Zenoti Sync — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add a `starts_at` date to vendor campaigns (DB, scheduler, CSV, UI) and add a per-stylist Sync button to the Zenoti integration page.

**Architecture:** Four isolated changes: a DB migration, scheduler filter updates, Platform Console form/CSV updates, and a new route + UI tweak in integrations. No new dependencies. No shared state between features.

**Tech Stack:** Node.js/Express ESM, better-sqlite3 (sync), Luxon (already imported in vendorScheduler), server-rendered HTML + Tailwind CDN.

---

### Task 1: Migration 059 — Add starts_at to vendor_campaigns

**Files:**
- Create: `migrations/059_vendor_starts_at.js`
- Modify: `migrations/index.js`

**Step 1: Create the migration file**

```js
// migrations/059_vendor_starts_at.js
export function run(db) {
  const cols = db.pragma("table_info(vendor_campaigns)").map((c) => c.name);
  if (!cols.includes("starts_at")) {
    db.exec(`ALTER TABLE vendor_campaigns ADD COLUMN starts_at TEXT`);
    console.log("[Migration 059] Added starts_at to vendor_campaigns");
  } else {
    console.log("[Migration 059] starts_at already exists, skipping");
  }
}
```

**Step 2: Register in migrations/index.js**

Add import:
```js
import { run as run059 } from "./059_vendor_starts_at.js";
```

Add to migrations array after 058 entry:
```js
{ name: "059_vendor_starts_at", run: run059 },
```

**Step 3: Start app and verify migration log appears**

**Step 4: Commit**
```
git add migrations/059_vendor_starts_at.js migrations/index.js
git commit -m "feat(db): migration 059 — add starts_at to vendor_campaigns"
```

---

### Task 2: Scheduler — Filter and Window-Clamp starts_at

**Files:**
- Modify: `src/core/vendorScheduler.js`

**Location A — Campaign selection query (~line 237)**

Add one line to the WHERE clause:
```
AND (starts_at IS NULL OR starts_at <= date('now'))
```

Full block after change:
```js
    let campaignSql = `
      SELECT * FROM vendor_campaigns
      WHERE vendor_name = ?
        AND active = 1
        AND (expires_at IS NULL OR expires_at >= date('now'))
        AND (starts_at IS NULL OR starts_at <= date('now'))
    `;
```

**Location B — processCampaign window-start clamp**

After the block that ends with:
```js
    if (effectiveWindowEnd <= windowStart) {
      log.info(`  Campaign ${campaign.id} expires before window start — skipping`);
      return 0;
    }
```

Insert:
```js
  // Clamp effective window start to campaign starts_at date
  let effectiveWindowStart = windowStart;
  if (campaign.starts_at) {
    const startsAtBeginOfDay = DateTime.fromISO(campaign.starts_at, { zone: tz }).startOf("day").toJSDate();
    if (startsAtBeginOfDay > effectiveWindowStart) {
      effectiveWindowStart = startsAtBeginOfDay;
      log.info(`  Campaign ${campaign.id} starts ${campaign.starts_at} — clamping window start to ${startsAtBeginOfDay.toISOString().slice(0, 10)}`);
    }
    if (effectiveWindowStart >= effectiveWindowEnd) {
      log.info(`  Campaign ${campaign.id} starts after window end — skipping`);
      return 0;
    }
  }
```

Then replace `windowStart` with `effectiveWindowStart` in these two lines further down in processCampaign:
- `const windowStartSql = windowStart.toISOString()...` → `effectiveWindowStart`
- Any `DateTime.fromJSDate(windowStart,` → `DateTime.fromJSDate(effectiveWindowStart,`

**Step: Commit**
```
git add src/core/vendorScheduler.js
git commit -m "feat(scheduler): filter and window-clamp vendor campaign starts_at"
```

---

### Task 3: Platform Console — starts_at in CSV, Forms, and Cards

**Files:**
- Modify: `src/routes/vendorAdmin.js`

**3a — CSV_HEADERS: add "starts_at" between "expires_at" and "frequency_cap"**

**3b — CSV_EXAMPLE: add "" (blank) at the same position**

**3c — CSV upload INSERT prepared statement: add starts_at column + ? placeholder**

In the insert.run() call, read `starts_at` from the row and validate YYYY-MM-DD format:
```js
const rawStartsAt = getCol(row, "starts_at") || null;
const starts_at = rawStartsAt && /^\d{4}-\d{2}-\d{2}$/.test(rawStartsAt) ? rawStartsAt : null;
```
Then pass `starts_at` after `expires_at` in the run() args.

**3d — Manual add form: add "Starts At (optional)" date input after "Expires At" input**

```html
<div>
  <label class="text-xs text-gray-500 block mb-1">Starts At <span class="text-gray-400">(optional — leave blank to go live immediately)</span></label>
  <input type="date" name="starts_at"
         class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
</div>
```

**3e — Manual add INSERT: add starts_at column + value**

Read from body: `const starts_at_add = (req.body.starts_at || "").trim() || null;`
Add to INSERT column list and VALUES.

**3f — Campaign edit UPDATE + form**

Read from body: `const starts_at_edit = (req.body.starts_at || "").trim() || null;`
Add `starts_at = ?` to the UPDATE SET clause.
Add a date input pre-populated with `c.starts_at` in the edit modal form.

**3g — Campaign card display: show starts_at when present**

Before the "Expires" span, add:
```js
${c.starts_at ? `<span>Starts: <strong class="text-gray-600">${safe(c.starts_at)}</strong></span>` : ""}
```

**Step: Commit**
```
git add src/routes/vendorAdmin.js
git commit -m "feat(vendor-console): add starts_at to CSV, add form, edit form, and campaign cards"
```

---

### Task 4: Zenoti — Per-Stylist Sync Button + Route

**Files:**
- Modify: `src/routes/integrations.js`

**4a — UI: add Sync button to each mapped stylist row**

In the stylist row template (around line 319), after the employee ID input, add:
```js
${matched ? `
  <form method="POST" action="/manager/integrations/zenoti/sync-stylist" style="margin:0">
    <input type="hidden" name="stylist_id" value="${s.id}" />
    <button type="submit"
      class="px-2.5 py-1.5 rounded-lg bg-mpAccentLight border border-mpBorder text-[11px] font-semibold text-mpAccent hover:bg-blue-100 transition-colors whitespace-nowrap">
      Sync
    </button>
  </form>` : ""}
```

**4b — New route: POST /zenoti/sync-stylist**

Add after the existing /zenoti/sync route, before /zenoti/disconnect:

```js
router.post("/zenoti/sync-stylist", async (req, res) => {
  const salon_id = req.manager?.salon_id;
  const { stylist_id } = req.body;

  if (!stylist_id) return res.redirect("/manager/integrations?error=missing_stylist");

  const stylist = db.prepare(
    `SELECT id, name, instagram_handle, integration_employee_id
     FROM stylists WHERE id = ? AND salon_id = ?`
  ).get(stylist_id, salon_id);

  if (!stylist || !stylist.integration_employee_id) {
    return res.redirect("/manager/integrations?error=not_mapped");
  }

  try {
    const zenotiInfo = await getZenotiClientForSalon(salon_id);
    if (!zenotiInfo) return res.redirect("/manager/integrations?synced=1&found=0");

    const { client, centerId } = zenotiInfo;
    const salon = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salon_id);

    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 7);
      return d.toISOString().slice(0, 10);
    })();

    const slots = await fetchStylistSlots({ client, centerId, stylist, salon, dateRange: { startDate, endDate } });
    let postsCreated = 0;
    if (slots.length) {
      const result = await generateAndSaveAvailabilityPost({ salon, stylist, slots });
      if (result) postsCreated = 1;
    }

    res.redirect(`/manager/integrations?synced=1&found=${postsCreated}`);
  } catch (e) {
    console.error("[Integrations] Zenoti sync-stylist error:", e.message);
    res.redirect("/manager/integrations?synced=1&found=0");
  }
});
```

**Manual test:**
1. Open /manager/integrations with a connected Zenoti account
2. Mapped stylists show "Sync" button; unmapped stylists do not
3. Click "Sync" on one — verify redirect back with success banner
4. Check Post Queue for the new availability post for that stylist only

**Step: Commit**
```
git add src/routes/integrations.js
git commit -m "feat(zenoti): per-stylist availability sync button and route"
```

---

### Task 5: Push to dev and prod

```
git push origin dev
git checkout main && git merge dev && git push origin main && git checkout dev
```
