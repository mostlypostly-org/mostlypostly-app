# Vendor Campaign Pre-Scheduling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Pre-schedule vendor campaign posts 30 days in advance with a new `vendor_scheduled` status so managers can see them on the calendar, edit captions, and drag them to preferred dates — with automatic publishing on their scheduled date.

**Architecture:** Replace the nightly "create one post today" logic in `vendorScheduler.js` with a 30-day evenly-spaced lookahead fill algorithm. Add `vendor_scheduled` as a new post status that the scheduler publishes without requiring manager approval. Calendar renders these as draggable ghost-purple pills.

**Tech Stack:** Node.js/Express ESM, better-sqlite3 (synchronous), Luxon for timezone-aware datetime math, SortableJS (already on calendar page).

---

## Task 1: Migration — Add vendor_scheduled status support (Task #1)

**Files:**
- Create: `migrations/054_vendor_scheduled_status.js`
- Modify: `src/routes/calendar.js` — `statusBadge()`, `calendarCardBarClass()`, draggable check, filter bar, DEFAULT_FILTERS

**Step 1: Create migration file**

```js
// migrations/054_vendor_scheduled_status.js
// Adds vendor_scheduled as a recognised post status.
// No schema change needed — status is TEXT with no CHECK constraint.
// This migration documents the new status and ensures vendor_post_log
// correctly stores the month of scheduled_for, not creation month.
export default function migrate(db) {
  // No DDL needed. Document via a no-op that doesn't break re-runs.
  console.log("[054] vendor_scheduled status registered (no DDL required)");
}
```

**Step 2: Verify migration runs without error**

```bash
node -e "
import('./db.js').then(({ db }) => {
  import('./migrations/054_vendor_scheduled_status.js').then(m => {
    m.default(db);
    console.log('Migration OK');
  });
});
"
```
Expected: `[054] vendor_scheduled status registered (no DDL required)` + `Migration OK`

**Step 3: Commit**

```bash
git add migrations/054_vendor_scheduled_status.js
git commit -m "feat(vendor): add 054 migration registering vendor_scheduled status"
```

---

## Task 2: Rewrite vendorScheduler 30-day lookahead algorithm (Task #2)

**Files:**
- Modify: `src/core/vendorScheduler.js`

**Step 1: Update `runVendorScheduler` — remove thisMonth, add window constants**

Replace line 144 (`const thisMonth = ...`) and the `log.info` call with:

```js
export async function runVendorScheduler() {
  const LOOKAHEAD_DAYS = 30;
  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  log.info(`Running vendor scheduler. Window: ${windowStart.toISOString().slice(0,10)} → ${windowEnd.toISOString().slice(0,10)}`);
  // ...rest unchanged except pass windowStart/windowEnd to processSalon
```

Pass `windowStart` and `windowEnd` instead of `thisMonth` through `processSalon` → `processCampaign`.

**Step 2: Update `processSalon` signature**

```js
async function processSalon(salon, windowStart, windowEnd) {
  // ...
  // change: await processCampaign(campaign, salon, thisMonth, ...)
  // to:     await processCampaign(campaign, salon, windowStart, windowEnd, ...)
```

**Step 3: Rewrite `processCampaign` — replace steps 4-11 with lookahead logic**

Replace the entire `processCampaign` function body from step 4 onward with:

```js
async function processCampaign(campaign, salon, windowStart, windowEnd, affiliateUrl, vendorName, minGapDays) {
  const salonId = salon.slug;
  const tz = salon.timezone || "America/Indiana/Indianapolis";
  const cap = campaign.frequency_cap ?? 3;
  const effectiveMinGap = minGapDays ?? 3;
  const lookaheadDays = 30;

  // 4. Count existing vendor posts from this campaign in the 30-day window
  const windowStartSql = windowStart.toISOString().replace("T", " ").slice(0, 19);
  const windowEndSql   = windowEnd.toISOString().replace("T", " ").slice(0, 19);

  const { existingCount } = db.prepare(`
    SELECT COUNT(*) AS existingCount
    FROM posts
    WHERE salon_id = ?
      AND vendor_campaign_id = ?
      AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
      AND scheduled_for BETWEEN ? AND ?
  `).get(salonId, campaign.id, windowStartSql, windowEndSql);

  if (existingCount >= cap) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: window full (${existingCount}/${cap}) — skipping`);
    return false;
  }

  // 5. Require a photo
  if (!campaign.photo_url) {
    log.warn(`  Skipping campaign ${campaign.id} — no photo_url`);
    return false;
  }

  // 6. Divide 30-day window into cap equal intervals, find first gap
  const intervalMs = (lookaheadDays * 24 * 60 * 60 * 1000) / cap;
  let scheduledFor = null;

  for (let i = 0; i < cap; i++) {
    const intStart = new Date(windowStart.getTime() + i * intervalMs);
    const intEnd   = new Date(windowStart.getTime() + (i + 1) * intervalMs);
    const intStartSql = intStart.toISOString().replace("T", " ").slice(0, 19);
    const intEndSql   = intEnd.toISOString().replace("T", " ").slice(0, 19);

    const { slotTaken } = db.prepare(`
      SELECT COUNT(*) AS slotTaken
      FROM posts
      WHERE salon_id = ?
        AND vendor_campaign_id = ?
        AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
        AND scheduled_for BETWEEN ? AND ?
    `).get(salonId, campaign.id, intStartSql, intEndSql);

    if (slotTaken > 0) continue; // manager already has a post here — respect it

    // Pick a random day within this interval, at a random time within posting hours
    const randDayOffset = Math.floor(Math.random() * Math.max(1, Math.floor(intervalMs / (24 * 60 * 60 * 1000))));
    const candidateDay = new Date(intStart.getTime() + randDayOffset * 24 * 60 * 60 * 1000);

    // Parse posting window from salon (e.g. "09:00" → 9)
    const [startH, startM] = (salon.posting_start_time || "09:00").split(":").map(Number);
    const [endH,   endM]   = (salon.posting_end_time   || "20:00").split(":").map(Number);
    const windowMinutes = (endH * 60 + endM) - (startH * 60 + startM);
    const randMinutes = Math.floor(Math.random() * Math.max(1, windowMinutes));
    const postHour   = startH + Math.floor((startM + randMinutes) / 60);
    const postMinute = (startM + randMinutes) % 60;

    // Build UTC ISO from local date + local time
    const { DateTime } = await import("luxon");
    const localDt = DateTime.fromObject(
      { year: candidateDay.getUTCFullYear(), month: candidateDay.getUTCMonth() + 1, day: candidateDay.getUTCDate(),
        hour: postHour, minute: postMinute, second: 0 },
      { zone: tz }
    );
    scheduledFor = localDt.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
    break;
  }

  if (!scheduledFor) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: all ${cap} slots filled in window — skipping`);
    return false;
  }

  // 7. Generate AI caption (unchanged logic)
  let caption;
  if (campaign.source === "pdf_sync" && campaign.caption_body) {
    caption = await generateVendorCaption({ campaign, salon, brandCaption: campaign.caption_body });
  } else {
    caption = await generateVendorCaption({ campaign, salon });
  }
  if (!caption) {
    log.warn(`  Skipping campaign ${campaign.id} — no caption available`);
    return false;
  }

  // 8. Build locked hashtag block (unchanged)
  const brandCfg = db.prepare(`SELECT brand_hashtags FROM vendor_brands WHERE vendor_name = ?`).get(campaign.vendor_name);
  const brandHashtags = (() => { try { return JSON.parse(brandCfg?.brand_hashtags || "[]"); } catch { return []; } })();
  const salonDefaultTags = (() => { try { return JSON.parse(salon.default_hashtags || "[]"); } catch { return []; } })();
  const lockedBlock = buildVendorHashtagBlock({ salonHashtags: salonDefaultTags, brandHashtags, productHashtag: campaign.product_hashtag || null });

  // 9. salon_post_number
  const { maxnum } = db.prepare(`SELECT MAX(salon_post_number) AS maxnum FROM posts WHERE salon_id = ?`).get(salonId) || {};
  const salon_post_number = (maxnum || 0) + 1;

  // 10. Build post row — always vendor_scheduled (no manager approval gate)
  const postId = crypto.randomUUID();
  const now    = new Date().toISOString();

  let trackedCaption;
  if (affiliateUrl) {
    const utmContent  = `vendor_${slugify(campaign.vendor_name)}`;
    const destination = appendUtm(affiliateUrl, { source: "mostlypostly", medium: "social", campaign: salonId, content: utmContent });
    try {
      const token    = buildTrackingToken({ salonId, postId, clickType: "vendor", vendorName: campaign.vendor_name, utmContent, destination });
      const shortUrl = buildShortUrl(token);
      trackedCaption = caption + "\n\nShop today: " + shortUrl + (lockedBlock ? "\n\n" + lockedBlock : "");
    } catch (err) {
      log.warn(`  UTM token creation failed: ${err.message}`);
      trackedCaption = caption + (lockedBlock ? "\n\n" + lockedBlock : "");
    }
  } else {
    trackedCaption = caption + (lockedBlock ? "\n\n" + lockedBlock : "");
  }

  db.prepare(`
    INSERT INTO posts (id, salon_id, stylist_name, image_url, base_caption, final_caption,
                       post_type, status, vendor_campaign_id, scheduled_for, salon_post_number, created_at, updated_at)
    VALUES (@id, @salon_id, @stylist_name, @image_url, @base_caption, @final_caption,
            @post_type, @status, @vendor_campaign_id, @scheduled_for, @salon_post_number, @created_at, @updated_at)
  `).run({
    id: postId, salon_id: salonId,
    stylist_name: `${campaign.vendor_name} (Campaign)`,
    image_url: resolveUrl(campaign.photo_url),
    base_caption: caption, final_caption: trackedCaption,
    post_type: "standard_post",
    status: "vendor_scheduled",           // ← new status, always
    vendor_campaign_id: campaign.id,
    scheduled_for: scheduledFor,          // ← set directly, no enqueuePost()
    salon_post_number,
    created_at: now, updated_at: now,
  });

  // 11. Log to vendor_post_log — use month of scheduled_for, not today
  const postedMonth = scheduledFor.slice(0, 7); // "YYYY-MM"
  db.prepare(`
    INSERT INTO vendor_post_log (id, salon_id, campaign_id, post_id, posted_month, created_at)
    VALUES (@id, @salon_id, @campaign_id, @post_id, @posted_month, @created_at)
  `).run({ id: crypto.randomUUID(), salon_id: salonId, campaign_id: campaign.id, post_id: postId, posted_month: postedMonth, created_at: now });

  // No enqueuePost() call — scheduled_for is already set
  log.info(`  ✅ Created vendor_scheduled post ${postId} for salon ${salonId} → ${scheduledFor}`);
  return true;
}
```

**Step 4: Remove the `enqueuePost` import** (no longer needed in vendorScheduler)

```js
// Remove this line from the top of vendorScheduler.js:
import { enqueuePost } from "../scheduler.js";
```

**Step 5: Manually test via node script**

```bash
node --input-type=module <<'EOF'
import { runVendorScheduler } from './src/core/vendorScheduler.js';
runVendorScheduler().then(n => console.log('Created:', n)).catch(console.error);
EOF
```
Expected: logs showing interval analysis + any new `vendor_scheduled` posts created.

**Step 6: Commit**

```bash
git add src/core/vendorScheduler.js
git commit -m "feat(vendor): 30-day lookahead pre-scheduling with vendor_scheduled status"
```

---

## Task 3: Update scheduler publish loop to include vendor_scheduled (Task #3)

**Files:**
- Modify: `src/scheduler.js` — three query sites

**Step 1: Find and update the active-salons query (line ~358)**

```js
// Before:
WHERE status='manager_approved'
  AND scheduled_for IS NOT NULL

// After:
WHERE status IN ('manager_approved','vendor_scheduled')
  AND scheduled_for IS NOT NULL
```

**Step 2: Find and update the due-posts publish query (line ~385)**

```js
// Before:
WHERE status='manager_approved'
  AND scheduled_for IS NOT NULL
  AND datetime(scheduled_for) <= datetime('now')

// After:
WHERE status IN ('manager_approved','vendor_scheduled')
  AND scheduled_for IS NOT NULL
  AND datetime(scheduled_for) <= datetime('now')
```

**Step 3: Find and update the outside-window retry query (line ~269)**

```js
// Before:
WHERE (status='manager_approved' OR status='failed')
  AND scheduled_for IS NOT NULL
  AND datetime(scheduled_for) < datetime('now')

// After:
WHERE (status IN ('manager_approved','vendor_scheduled') OR status='failed')
  AND scheduled_for IS NOT NULL
  AND datetime(scheduled_for) < datetime('now')
```

**Step 4: Verify no other status='manager_approved' queries need updating**

```bash
grep -n "status='manager_approved'" src/scheduler.js
```
Review each hit — only update publish/retry loops, not status-transition writes (those set the new status intentionally).

**Step 5: Commit**

```bash
git add src/scheduler.js
git commit -m "feat(vendor): scheduler publish loop includes vendor_scheduled posts"
```

---

## Task 4: Calendar display — ghost purple pill, drag, filter chip (Task #4)

**Files:**
- Modify: `src/routes/calendar.js` — 6 targeted changes

**Change 1: `statusBadge()` — add vendor_scheduled entry (line ~108)**

```js
vendor_scheduled: { label: "Vendor Scheduled", color: "bg-purple-100 text-purple-700" },
```

**Change 2: `calendarCardBarClass()` — vendor_scheduled gets lighter purple bar (line ~54)**

```js
// Add before the vendor_campaign_id check:
if (post.status === "vendor_scheduled") return "bg-purple-300";
if (post.vendor_campaign_id) return "bg-purple-500";
```

**Change 3: `calendarPillClass()` — dashed border ghost style for vendor_scheduled (line ~72)**

```js
// Add before the vendor_campaign_id check:
if (post.status === "vendor_scheduled") return "bg-white text-purple-600 border border-purple-300 border-dashed";
if (post.vendor_campaign_id) return "bg-purple-100 text-purple-700 border-purple-200";
```

**Change 4: Make vendor_scheduled draggable (line ~213)**

```js
// Before:
const isDraggable = p.status === "manager_approved" && !!p.scheduled_for;

// After:
const isDraggable = (p.status === "manager_approved" || p.status === "vendor_scheduled") && !!p.scheduled_for;
```

**Change 5: Filter bar — add Vendor Scheduled chip after the existing Vendor chip (line ~344)**

```html
<button data-filter-status="vendor_scheduled" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white text-purple-600 border border-purple-300 border-dashed transition-opacity">Vendor Sched</button>
```

**Change 6: DEFAULT_FILTERS — add vendor_scheduled to statuses (line ~462)**

```js
statuses: { manager_pending: true, manager_approved: true, published: true, failed: true, vendor_scheduled: true }
```

**Change 7: Day panel — hide cancel button for vendor_scheduled**

Find the day-panel card HTML in `GET /day/:date` route. Locate where cancel/delete buttons are rendered and wrap in:

```js
// Only show cancel button if post is NOT vendor_scheduled
${post.status !== 'vendor_scheduled' ? `<button ...cancel button html...></button>` : ''}
```

**Step 1: Apply all 7 changes**

**Step 2: Smoke test in browser**
- Visit `/manager/calendar`
- Confirm vendor_scheduled posts show as dashed purple pills
- Confirm they are draggable to other days
- Confirm "Vendor Sched" filter chip toggles them
- Open day panel — confirm no cancel button for vendor_scheduled posts
- Confirm edit caption works normally

**Step 3: Commit**

```bash
git add src/routes/calendar.js
git commit -m "feat(vendor): calendar renders vendor_scheduled as ghost purple pills with drag + filter"
```

---

## Task 5: Push to staging and verify end-to-end

**Step 1: Push to dev branch**

```bash
git push origin HEAD:dev
```

**Step 2: Trigger vendor scheduler manually on staging**

Hit the internal scheduler trigger or wait for 2am UTC. Alternatively add a one-time dev route to call `runVendorScheduler()` directly for testing.

**Step 3: Verify on staging calendar**
- Pro salon with an active vendor campaign shows purple dashed pills 30 days out
- Dragging a pill updates its `scheduled_for` correctly
- Caption edit works
- Posts publish automatically when their `scheduled_for` arrives (no approval needed)

**Step 4: Push to production**

```bash
git push origin main
```
