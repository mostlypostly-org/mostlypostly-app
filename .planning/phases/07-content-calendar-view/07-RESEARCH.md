# Phase 7: Content Calendar View - Research

**Researched:** 2026-03-21
**Domain:** Server-rendered calendar UI, drag-to-reschedule, HTML fragment endpoints
**Confidence:** HIGH

## Summary

Phase 7 adds a visual 4-week calendar page at `/manager/calendar`. All product decisions are locked -- month view only, post thumbnails per day, vendor posts as purple pill, drag-to-reschedule (preserving time-of-day), and a slide-out day panel with full post cards plus approve/deny/post-now actions. There are no new dependencies needed: SortableJS is already loaded from CDN in postQueue.js for drag behavior and Luxon is already in the project for date math.

The key integration finding is that vendor posts created by `vendorScheduler.js` do NOT have `scheduled_for` assigned at insert time -- that column is left NULL until either `enqueuePost()` is called (auto-approve path) or the manager approves via the dashboard (which then calls `handleManagerApproval` which calls `enqueuePost`). This means the calendar query correctly excludes pending vendor posts without a scheduled date. The locked spec's query filters on status NOT IN ('draft', 'cancelled') and date range, so pending vendor posts with NULL `scheduled_for` will be invisible until approved. This is the correct behavior -- the calendar shows the schedule, not the pending queue.

The existing approve/deny/post-now routes in manager.js all use GET with `?post=ID`. Approve and post-now are simple GET redirects. Deny requires a form with a reason field, so it needs special treatment in the day panel -- either redirect to the existing deny page or render an inline mini-form.

**Primary recommendation:** Build `src/routes/calendar.js` as a new Express router mounted at `/manager/calendar`. Use SortableJS from CDN (already used in postQueue.js) for drag interaction. Day panel loads as an HTML fragment via `GET /manager/calendar/day/:date`. Drag reschedule via `POST /manager/calendar/reschedule` with `{postId, newDate}` body.

<user_constraints>
## User Constraints (from CONTEXT.md)

No CONTEXT.md exists for this phase. All constraints come from the phase additional_context block provided at research time.

### Locked Decisions (from phase spec)

**Must-have for V1:**
- Month view with post thumbnails per day
- Vendor posts visually distinct -- purple pill badge so Aveda content is immediately identifiable
- Drag to reschedule (postQueue.js already has reorder logic -- reuse it)
- Click a day to see all posts for that day with full card (image, caption, type, stylist or vendor brand)
- Approve/deny from panel without leaving the calendar

**Color system (locked):**
| Post Type | Color | Rationale |
|-----------|-------|-----------|
| Vendor post | Purple pill | Distinct, premium-feeling |
| Standard post | Blue (mpAccent #3B72B9) | Default brand color |
| Before/After | Teal | High-value content |
| Promotion | Amber | Urgency/offer connotation |
| Availability | Green | "Open chair" = go sign |
| Celebration | Pink | Warm, personal |
| Failed | Red | Matches existing failed state |

**Key implementation constraints:**
- ESM only (import/export, never require)
- SQLite is synchronous -- no await on db calls
- Always verify salon_id ownership before any DB write
- Use pageShell.js for all page rendering
- CSRF token required on all POST routes (X-CSRF-Token header)
- Twilio image URLs must go through toProxyUrl() before rendering in img tags
- Vendor posts: vendor_campaign_id IS NOT NULL -- show purple pill with vendor_name (join vendor_campaigns)
- Drag reschedule: preserves time-of-day, changes only the date portion of scheduled_for
- Day panel fetches from GET /manager/calendar/day/:date -- returns HTML fragment, not full page
- Approve/Deny/Post Now in panel use existing routes: /manager/approve, /manager/deny, /manager/post-now
- Nav: add "Calendar" between Post Queue and Analytics in pageShell.js

### Deferred Ideas (OUT OF SCOPE for V1)
- Week view toggle
- Gap highlighting
- CSV export
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAL-01 | Month view calendar grid showing 4 weeks of posts with thumbnails per day cell | DB query verified: COALESCE(scheduled_for, published_at) with status filter. Luxon for date math. |
| CAL-02 | Color-coded post type pills per calendar cell (vendor=purple, standard=blue, etc.) | postTypeBadge() pattern from postQueue.js confirmed. Vendor detection via vendor_campaign_id IS NOT NULL. |
| CAL-03 | Click a day -- slide-out panel showing full post cards for that day | GET /manager/calendar/day/:date returns HTML fragment. Panel toggled via client-side JS. |
| CAL-04 | Approve/deny/post-now actions directly from day panel | Existing GET routes: /manager/approve, /manager/deny (GET form + POST handler), /manager/post-now. |
| CAL-05 | Drag-drop to reschedule posts by date (preserving time-of-day) | POST /manager/calendar/reschedule with {postId, newDate}. SortableJS available from CDN. Luxon for date replacement. |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| SortableJS | 1.15.2 (CDN) | Drag-and-drop interactions | Already used in postQueue.js -- same CDN URL, no new install |
| Luxon | Already installed | Date math, timezone-aware formatting | Already used throughout scheduler.js and postQueue.js |
| better-sqlite3 | Already installed | Synchronous DB queries | Project standard |
| express | Already installed | Route handler | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pageShell.js | internal | Page wrapper, nav, CSRF meta tag | All manager pages |
| crypto (Node built-in) | built-in | UUID generation if needed | Only if new records created |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SortableJS CDN | FullCalendar.js | FullCalendar is a 200KB dependency with its own opinion on UI; SortableJS + hand-built grid gives full control and matches existing project pattern |
| HTML fragment (day panel) | JSON API + client template | Fragment approach matches existing server-rendered pattern and requires zero client-side templating logic |

**Installation:**
No new packages required. All dependencies already installed.

## Architecture Patterns

### Recommended Project Structure
```
src/routes/calendar.js       # New route file
```

Routes in calendar.js:
- `GET /` -- main calendar page (rendered via pageShell)
- `GET /day/:date` -- HTML fragment for day panel
- `POST /reschedule` -- drag reschedule handler

Mount in server.js at `app.use("/manager/calendar", calendarRoute)` after `restoreManagerSession` (line 411) and after the post queue mount at line 441.

### Pattern 1: Route Registration in server.js
**What:** New router mounted alongside other manager routes
**When to use:** Every new manager page follows this pattern

```javascript
// server.js -- after line 441 (postQueueRoute)
import calendarRoute from "./src/routes/calendar.js";
// ...
app.use("/manager/calendar", calendarRoute);
```

### Pattern 2: requireAuth Guard
**What:** Identical inline function in every manager route file
**When to use:** Top of route file, applied to every handler

```javascript
// Source: src/routes/postQueue.js line 14-17
function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) return res.redirect("/manager/login");
  next();
}
```

### Pattern 3: toProxyUrl for Twilio Images
**What:** Convert Twilio MMS URLs to server-side proxy before rendering in img tags
**When to use:** Every image_url from posts table used in HTML

```javascript
// Source: src/routes/postQueue.js line 19-23 and src/routes/manager.js line 43-49
function toProxyUrl(url) {
  if (!url) return null;
  if (url.includes("api.twilio.com")) return `/api/media-proxy?url=${encodeURIComponent(url)}`;
  return url;
}
```

### Pattern 4: CSRF Token in Fetch Calls
**What:** Read meta tag inserted by CSRF middleware, pass as X-CSRF-Token header on POST requests
**When to use:** Any client-side fetch hitting a POST route

```javascript
// Source: src/routes/postQueue.js line 206-210
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
fetch('/manager/calendar/reschedule', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  body: JSON.stringify({ postId, newDate }),
});
```

The CSRF middleware (src/middleware/csrf.js) auto-injects the meta tag into every full HTML response. The calendar page (full-page response) will have the meta tag. Day panel fragments will NOT have it -- client JS reads the token from the page-level meta tag, which is already present.

### Pattern 5: Luxon Date Manipulation for Reschedule
**What:** Preserve time-of-day, swap only the date portion of scheduled_for
**When to use:** POST /reschedule handler

```javascript
// Source: Luxon usage pattern from src/routes/postQueue.js line 73-74 and src/scheduler.js
import { DateTime } from "luxon";

const post = db.prepare("SELECT scheduled_for, salon_id FROM posts WHERE id = ? AND salon_id = ?")
  .get(postId, salon_id);

// Parse as UTC (scheduled_for is always stored UTC)
const original = DateTime.fromSQL(post.scheduled_for, { zone: "utc" });
// newDate is YYYY-MM-DD from client
const [y, mo, d] = newDate.split("-").map(Number);
const updated = original.set({ year: y, month: mo, day: d });
// Write back as UTC SQLite timestamp
const newTimestamp = updated.toFormat("yyyy-LL-dd HH:mm:ss");
db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ? AND salon_id = ?")
  .run(newTimestamp, postId, salon_id);
```

### Pattern 6: Nav Item Addition in pageShell.js
**What:** Add Calendar nav item between Post Queue and Analytics
**When to use:** pageShell.js desktop nav and mobile nav sections

Insert after Post Queue line in desktop nav (currently line 154):
```javascript
${navLocked ? "" : navItem("/manager/calendar", ICONS.calendar, "Calendar", "calendar")}
```

Insert after Post Queue line in mobile nav (currently line 195):
```javascript
${navLocked ? "" : mobileNavLink("/manager/calendar", "Calendar", "calendar")}
```

Add to ICONS object:
```javascript
calendar: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
  <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5m-9-6h.008v.008H12v-.008ZM12 15h.008v.008H12V15Zm0 2.25h.008v.008H12v-.008ZM9.75 15h.008v.008H9.75V15Zm0 2.25h.008v.008H9.75v-.008ZM7.5 15h.008v.008H7.5V15Zm0 2.25h.008v.008H7.5v-.008Zm6.75-4.5h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V15Zm0 2.25h.008v.008h-.008v-.008Zm2.25-4.5h.008v.008H18v-.008Zm0 2.25h.008v.008H18V15Z" />
</svg>`
```

### Pattern 7: Day Panel as HTML Fragment
**What:** GET /day/:date returns bare HTML -- no pageShell wrapper -- for injection into panel div
**When to use:** Day panel fetch handler

```javascript
router.get("/day/:date", requireAuth, (req, res) => {
  const date = req.params.date; // YYYY-MM-DD
  const salon_id = req.session.salon_id;
  // validate date format with regex
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send("Invalid date");
  // query posts for this date
  // res.send(htmlFragment) -- NOT pageShell
});
```

On the client, fetch the fragment and set the panel div's content using the `element.innerHTML` pattern -- note the existing codebase uses this pattern throughout server-rendered pages (the body variable in pageShell is injected via template literal). The panel div starts hidden; clicking a day cell shows it and fetches the fragment.

### Pattern 8: Vendor Post Detection
**What:** Identify vendor posts for purple pill display
**When to use:** Calendar cell rendering and day panel card rendering

Vendor posts have `vendor_campaign_id IS NOT NULL`. The calendar query LEFT JOINs `vendor_campaigns` to get `vendor_name`. Purple pill overrides the normal post_type badge when `vendor_campaign_id` is set.

```sql
LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
-- In result: p.vendor_campaign_id IS NOT NULL means vendor post
-- vc.vendor_name gives "Aveda", "Redken", etc.
```

Note: `vendorScheduler.js` also stores `stylist_name = "${vendor_name} (Campaign)"`. The calendar should use the more reliable `vendor_campaign_id IS NOT NULL` JOIN check rather than string-parsing stylist_name.

### Anti-Patterns to Avoid
- **await on db calls:** better-sqlite3 is synchronous. Never write `await db.prepare(...).get()`.
- **Trust req.body.salon_id:** Always use `req.session.salon_id` for salon scoping to prevent IDOR.
- **require() instead of import:** Project is ESM. Use `import { db } from "../../db.js"` not require.
- **Modifying postQueue.js reorder endpoint:** Calendar reschedule has different semantics (date swap, not slot reassignment within a list). Must be a new endpoint at `/manager/calendar/reschedule`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Drag-and-drop | Custom mouse/touch event listeners | SortableJS 1.15.2 (CDN) | Already in postQueue.js; handles touch, ghost, animation |
| Timezone-aware date math | Manual UTC offset arithmetic | Luxon DateTime | Already installed; handles DST, ISO parsing, formatting |
| HTML escaping | Custom regex replace | Inline esc() function (copy from postQueue.js or manager.js) | Project-consistent pattern; covers all 5 HTML special chars |
| Calendar grid layout | Complex JS grid builder | CSS grid with Tailwind grid-cols-7 | Simple, responsive, no JS needed for the grid itself |

**Key insight:** The hard part of this feature is not the calendar grid layout -- it is correct date math across timezones and the cross-container drag reschedule logic. Luxon handles the timezone math; SortableJS groups handle cross-container drag.

## Common Pitfalls

### Pitfall 1: scheduled_for NULL for Pending Vendor Posts
**What goes wrong:** Calendar query filters on date range against `scheduled_for`. Vendor posts in `manager_pending` status have `scheduled_for = NULL` -- the vendorScheduler INSERT at src/core/vendorScheduler.js line 361 does not include the `scheduled_for` column. These posts will be invisible on the calendar.
**Why it happens:** `enqueuePost()` in scheduler.js is what sets `scheduled_for`. It only runs at approve time (or auto-approve path in vendorScheduler line 404-410).
**How to avoid:** This is correct behavior for the calendar (which shows the schedule, not the review queue). Document it in the UI. The Post Queue at `/manager/queue` shows pending posts; the calendar shows the schedule.
**Warning signs:** A vendor post is visible in Post Queue but not on the calendar -- this is expected and correct.

### Pitfall 2: Date Range Timezone Mismatch
**What goes wrong:** Calendar shows "April 1" but the DB query uses UTC midnight. A post scheduled for 11pm salon time on April 1 is stored as April 2 00:00 UTC, so it appears on April 2's cell instead of April 1's.
**Why it happens:** `scheduled_for` and `published_at` are stored as UTC in SQLite. Calendar cells represent local salon time.
**How to avoid:** When building the 4-week range query, compute the UTC bounds for each day using the salon's timezone: `DateTime.fromISO(date, { zone: salonTz }).startOf('day').toUTC()` for start and `.endOf('day').toUTC()` for end. Then group fetched posts by their local date for cell rendering.
**Warning signs:** Posts appearing on wrong day cells, especially around midnight or near DST transitions.

### Pitfall 3: Drag Reschedule Parsing Wrong Timezone
**What goes wrong:** `scheduled_for` is stored as `"2026-04-01 14:30:00"` (UTC). When replacing the date portion, parsing without a zone causes Luxon to treat it as local system time, corrupting the time component on the way back to UTC.
**Why it happens:** `DateTime.fromSQL(str)` without `{ zone: "utc" }` defaults to local system time.
**How to avoid:** Always parse `scheduled_for` with `{ zone: "utc" }` -- see Pattern 5 above. Replace only year/month/day with `.set()` on the UTC DateTime. Write back with `.toFormat("yyyy-LL-dd HH:mm:ss")`.
**Warning signs:** Posts shifting by several hours after reschedule; the hour:minute displayed is different from what was originally scheduled.

### Pitfall 4: Approve Route Only Handles manager_pending Status
**What goes wrong:** The existing `/manager/approve` GET route (manager.js line 651) queries `WHERE status = 'manager_pending'` and redirects to `/manager` if not found. Clicking approve for a `failed` post from the panel will silently redirect without approving.
**Why it happens:** The approve route was built for the normal pre-approval workflow, not for re-approving failed posts.
**How to avoid:** In the day panel, show Approve only for `manager_pending` posts. For `failed` posts, show the Retry button (existing route: `POST /manager/retry-post` with body `{post_id}`). Match button visibility to post status.
**Warning signs:** Clicking Approve in the panel results in redirect to /manager with no change to post status.

### Pitfall 5: CSRF in Day Panel Fragments
**What goes wrong:** The CSRF middleware injects `<meta name="csrf-token">` by replacing `</head>` in full HTML responses. A day panel fragment has no `<head>`, so the meta tag is not injected into the fragment. If panel action forms rely on a meta tag in the fragment, CSRF tokens will be missing.
**Why it happens:** CSRF injection is a string replacement on the full response body looking for `</head>`.
**How to avoid:** The calendar page (full-page response from GET /) already has the meta tag. Client JS always reads it from `document.querySelector('meta[name="csrf-token"]')` -- this works because the meta tag is on the page, not in the fragment. For the deny mini-form in the panel, the CSRF middleware will NOT auto-inject `_csrf` into the form either (fragment response). The route handler must explicitly pass `csrfToken` into the fragment template and include `input[type=hidden][name=_csrf]`.
**Warning signs:** 403 Forbidden on POST requests initiated from the day panel.

### Pitfall 6: Deny Flow Requires POST with Reason
**What goes wrong:** Approve and Post Now are GET routes. Deny is GET (renders form) + POST (submits reason). If the panel links to GET /manager/deny, the manager leaves the calendar page entirely.
**Why it happens:** Deny has a reason textarea which requires a form submission separate from a simple GET.
**How to avoid:** Two viable options for V1: (1) Link to the existing deny page -- manager leaves calendar, uses existing deny form, returns via back button or redirect. Simplest. (2) Inline mini-form in the panel -- `form[method=POST][action=/manager/deny]` with `input[name=post_id]`, `textarea[name=reason]`, and a manually-injected `input[type=hidden][name=_csrf][value=${csrfToken}]` where csrfToken comes from the route handler. The CSRF middleware will auto-inject into forms in full-page responses but NOT in fragment responses, so manual injection is required for option 2.
**Warning signs:** 403 on deny form submit if _csrf is missing from the fragment form.

### Pitfall 7: SortableJS Cross-Container Drag
**What goes wrong:** Default SortableJS (as used in postQueue.js) only reorders within one container. The calendar needs dragging from one day cell to another -- this requires the `group` option.
**Why it happens:** SortableJS isolates each container unless explicitly linked via a shared group name.
**How to avoid:** Initialize SortableJS on each day cell with `group: { name: "calendar-posts", pull: true, put: true }`. On `onEnd`, check `evt.from !== evt.to` to detect a date change. Each cell element must have a `data-date="YYYY-MM-DD"` attribute. Each draggable post card must have `data-id="[postId]"`. If the reschedule fetch fails, move `evt.item` back to `evt.from`.
**Warning signs:** Drag starts but the card snaps back to original position on drop -- the target cell is not configured to accept drops (missing group config).

## Code Examples

Verified patterns from official sources:

### Calendar DB Query
```javascript
// Verified: posts and vendor_campaigns tables confirmed in CLAUDE.md schema
const posts = db.prepare(`
  SELECT p.id, p.post_type, p.status, p.scheduled_for, p.published_at, p.stylist_name,
         p.image_url, p.final_caption, p.vendor_campaign_id, vc.vendor_name
  FROM posts p
  LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
  WHERE p.salon_id = ?
    AND p.status NOT IN ('draft', 'cancelled')
    AND (
      p.scheduled_for BETWEEN ? AND ?
      OR p.published_at BETWEEN ? AND ?
    )
  ORDER BY COALESCE(p.scheduled_for, p.published_at) ASC
`).all(salon_id, rangeStart, rangeEnd, rangeStart, rangeEnd);
```

### Post Type Color Map for Calendar
```javascript
// Extends postTypeBadge map from postQueue.js; adds vendor override and failed/reel
function calendarPillClass(post) {
  if (post.vendor_campaign_id) return "bg-purple-100 text-purple-700 border-purple-200";
  const map = {
    standard_post:    "bg-blue-100 text-blue-700",
    before_after:     "bg-teal-100 text-teal-700",
    before_after_post:"bg-teal-100 text-teal-700",
    availability:     "bg-green-100 text-green-700",
    promotion:        "bg-amber-100 text-amber-700",
    promotions:       "bg-amber-100 text-amber-700",
    celebration:      "bg-pink-100 text-pink-700",
    celebration_story:"bg-pink-100 text-pink-700",
    reel:             "bg-indigo-100 text-indigo-700",
    failed:           "bg-red-100 text-red-700",
  };
  return map[post.post_type] || "bg-gray-100 text-gray-600";
}
```

### Reschedule Endpoint
```javascript
// POST /reschedule
router.post("/reschedule", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const { postId, newDate } = req.body;
  if (!postId || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return res.json({ ok: false, error: "Invalid input" });
  }

  const post = db.prepare(
    "SELECT scheduled_for FROM posts WHERE id = ? AND salon_id = ? AND status = 'manager_approved'"
  ).get(postId, salon_id);
  if (!post?.scheduled_for) return res.json({ ok: false, error: "Post not found or not scheduled" });

  const original = DateTime.fromSQL(post.scheduled_for, { zone: "utc" });
  const [y, mo, d] = newDate.split("-").map(Number);
  const updated = original.set({ year: y, month: mo, day: d });
  const newTimestamp = updated.toFormat("yyyy-LL-dd HH:mm:ss");

  db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ? AND salon_id = ?")
    .run(newTimestamp, postId, salon_id);

  res.json({ ok: true });
});
```

### SortableJS Cross-Cell Drag Configuration
```javascript
// Applied to each day cell element via querySelectorAll
document.querySelectorAll('.calendar-day-cell').forEach(cell => {
  Sortable.create(cell, {
    group: { name: 'calendar-posts', pull: true, put: true },
    animation: 150,
    ghostClass: 'opacity-40',
    onEnd(evt) {
      if (evt.from === evt.to) return; // same day, no reschedule needed
      const postId = evt.item.dataset.id;
      const newDate = evt.to.dataset.date; // data-date="YYYY-MM-DD" on each cell
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
      fetch('/manager/calendar/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ postId, newDate }),
      })
      .then(r => r.json())
      .then(data => {
        if (!data.ok) evt.from.appendChild(evt.item); // revert on failure
      })
      .catch(() => evt.from.appendChild(evt.item));
    },
  });
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| vendorBadge via string match on stylist_name (postQueue.js) | Calendar uses vendor_campaign_id IS NOT NULL via JOIN | Phase 7 | More reliable vendor detection |

**Deprecated/outdated:**
- None relevant to this phase.

## Open Questions

1. **Approve from panel -- redirect or in-place refresh?**
   - What we know: `/manager/approve?post=ID` redirects to `/manager` on completion (manager.js line 699).
   - What's unclear: Should clicking Approve in the panel do a full page navigation (leaving calendar) or reload the panel in-place?
   - Recommendation: For V1, simplest approach is to redirect to `/manager/calendar` after approval. This requires either (a) modifying the approve/post-now routes to accept a `?return=` query param, or (b) wrapping the action in a client-side fetch that calls the route and then refreshes the panel. Option (a) is the least invasive change to existing routes.

2. **Reel post color not in locked spec**
   - What we know: The locked color spec lists 7 types but not `reel`. The codebase has `reel` as a valid post_type.
   - What's unclear: Whether reel should have its own calendar color or fall through to the gray default.
   - Recommendation: Use indigo (`bg-indigo-100 text-indigo-700`) -- it is visually distinct from all locked colors. Low priority -- few salons have reel posts during Phase 7.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | `vitest.config.mjs` -- includes `src/**/*.test.js` |
| Quick run command | `npx vitest run src/routes/calendar.test.js` |
| Full suite command | `npx vitest run` |

Note: four existing test files live in `tests/` (not `src/`). Vitest config only includes `src/**/*.test.js`. New calendar tests should go in `src/routes/calendar.test.js` to be picked up by vitest.

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAL-01 | DB query returns correct posts for 4-week UTC date range | unit | `npx vitest run src/routes/calendar.test.js` | No -- Wave 0 |
| CAL-02 | calendarPillClass() returns correct class for each post type including vendor override | unit | `npx vitest run src/routes/calendar.test.js` | No -- Wave 0 |
| CAL-03 | Day panel GET returns HTML fragment for correct date | smoke/manual | manual navigation | N/A -- server route |
| CAL-04 | Approve/deny/post-now links reach correct existing routes with correct status handling | smoke/manual | manual test in browser | N/A -- existing routes |
| CAL-05 | Reschedule preserves time-of-day component, updates only date | unit | `npx vitest run src/routes/calendar.test.js` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/routes/calendar.test.js`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/routes/calendar.test.js` -- unit tests for calendarPillClass(), reschedule date math, DB query date range logic (REQ CAL-01, CAL-02, CAL-05)

## Sources

### Primary (HIGH confidence)
- `src/routes/postQueue.js` -- SortableJS pattern, toProxyUrl, postTypeBadge, CSRF fetch pattern (direct code read)
- `src/ui/pageShell.js` -- navItem pattern, ICONS object, navLocked behavior, mobile nav (direct code read)
- `src/routes/manager.js` -- approve (GET, line 651), post-now (GET, line 705), cancel-post (GET, line 743), deny (GET form line 771 + POST handler line 810) -- all route signatures verified
- `src/core/vendorScheduler.js` -- processCampaign INSERT at line 361 does NOT include scheduled_for column (direct code read confirming Pitfall 1)
- `src/scheduler.js` -- enqueuePost() at line 769 sets scheduled_for (direct code read)
- `src/middleware/csrf.js` -- CSRF middleware: meta tag injection targets `</head>`, form inject targets `<form method="POST">`, X-CSRF-Token header accepted (direct code read)

### Secondary (MEDIUM confidence)
- SortableJS `group` option for cross-container drag -- documented in SortableJS GitHub README; behavior confirmed by project usage of single-container mode in postQueue.js

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all dependencies already in project, versions confirmed from package.json usage
- Architecture: HIGH -- route pattern verified against 3+ existing route files; reschedule logic derived from verified Luxon usage in scheduler.js and postQueue.js
- Pitfalls: HIGH for timezone/CSRF/vendor-null issues (verified against actual code); MEDIUM for SortableJS group cross-container drag (pattern from docs, not yet used in this codebase)

**Research date:** 2026-03-21
**Valid until:** 2026-04-21 (stable stack -- no fast-moving dependencies)
