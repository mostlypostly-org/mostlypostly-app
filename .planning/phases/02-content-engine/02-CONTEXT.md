# Phase 2: Content Engine - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Smart content recycling and intelligent cadence scheduling — keep the post queue balanced and never empty. Two interlocked systems: (1) the recycler auto-requeues top-performing published posts when the queue runs low, and (2) pickNextPost() enforces content-type distribution across the 7-day rolling window. Creating new post types and new publishing channels are out of scope.

</domain>

<decisions>
## Implementation Decisions

### Cadence Enforcement
- `pickNextPost()` applies to the **whole queue** — all approved posts, recycled and new alike
- If the ideal content type isn't in queue, **fall back to the next available type** — never stall publishing just because a specific type is missing (salons adapting the product won't always have every type)
- If the queue is **completely empty**, hold — do not recycle until trigger conditions are met (queue depth < 3 AND 48hr since last publish). Recycling should not fire just because a slot opened up.

### Recycle Trigger & Dashboard Notice
- Auto-recycle fires when: queue depth drops below 3 posts **AND** no publish in the last 48 hours
- Dashboard notice: **subtle inline info banner** at the top of the dashboard — "X posts were auto-recycled this week" with a link to Database view. Non-blocking and dismissible.
- **Undo** = delete the recycled copy. The original published post is untouched. Manager can trigger undo from the dashboard notice link or from Database view.

### Caption Refresh on Recycle (Plan-Gated)
- **Starter plan**: recycled posts always reuse the original caption verbatim — no AI refresh
- **Growth/Pro plans**: per-salon "refresh caption on recycle" toggle available in Admin settings, **off by default**
- Caption refresh toggle only renders in Admin UI for Growth/Pro salons
- When refresh is on: refreshed recycled post follows the existing `auto_publish` salon setting for approval — no new approval concept, consistent with all other posts

### Manual Recycle & Block Flag (Database View)
- Both actions live **inline on each published post row** in Database view — a Recycle button and a Block toggle/icon
- Consistent with existing row-level actions (deny, retry) already in the Database view
- Manual recycle follows the **same approval flow** as auto-recycle — no special case, same clone-and-enqueue path
- Block flag sets `block_from_recycle = 1` on the post — excluded from all recycle candidate queries (auto and manual)

### Claude's Discretion
- Exact SQL query for recycle candidate ranking (reach DESC from post_insights, excluding 45-day recycle cooldown)
- SMS notification copy for manager when auto-recycle fires
- Block flag visual treatment (toggle vs icon vs checkbox)
- Migration numbering (next in sequence after 045)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scheduler & Queue
- `src/scheduler.js` — existing `DEFAULT_PRIORITY`, `getSalonPolicy()`, `enqueuePost()`, `runSchedulerOnce()` — pickNextPost() integrates here; never launch a second Puppeteer instance
- `src/core/vendorScheduler.js` — existing cadence pattern for vendor posts; do not disrupt

### Database Schema
- `migrations/` — next migration after 045; add `block_from_recycle INTEGER DEFAULT 0`, `recycled_from_id TEXT`, `auto_recycle INTEGER DEFAULT 0` (salon toggle) to relevant tables
- `migrations/007_post_insights.js` — `post_insights` table with `reach`, `engagement_rate` columns — recycle candidate ranking source

### Plan Limits & Billing
- `src/routes/billing.js` — `PLAN_LIMITS` object — caption refresh gate must check plan here, same pattern used by manager seat limits and location limits

### Admin Settings Pattern
- `src/routes/admin.js` — toggle select pattern (`auto_publish`, `require_manager_approval`) — new `auto_recycle` and `caption_refresh_on_recycle` toggles must follow this exact pattern

### Dashboard View
- `src/routes/dashboard.js` — existing status-filtered post table with row-level actions — Recycle button and Block flag added to published post rows here

### Manager SMS
- `src/routes/twilio.js` — `sendViaTwilio()` — manager SMS notification when auto-recycle fires follows this pattern

### No external specs — requirements fully captured in REQUIREMENTS.md (RECYC-01 through RECYC-11, SCHED-01 through SCHED-06)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `enqueuePost()` in scheduler.js — recycled post clone calls this directly after DB insert; no new enqueue logic needed
- `getSalonPolicy()` in scheduler.js — recycle trigger check reads salon's queue depth and last publish from the same policy lookup
- `sendViaTwilio()` in twilio.js — manager SMS notification on auto-recycle fires through this
- `PLAN_LIMITS` in billing.js — caption refresh gate reads plan tier from here

### Established Patterns
- DB is synchronous (`better-sqlite3`) — no `await` on any DB calls in recycler or scheduler logic
- Admin toggles — `SELECT name="auto_publish"` pattern in admin.js — follow exactly for new salon-level toggles
- Row-level actions in dashboard.js — deny/retry buttons on post rows — Recycle and Block follow this structure
- `salon_id` filter on every DB query — recycler candidate queries must always scope to `req.session.salon_id`

### Integration Points
- `runSchedulerOnce()` in scheduler.js — auto-recycle check runs inside this loop, after `expireStalePosts()` and before the publish loop
- `src/routes/dashboard.js` — published post rows get two new inline actions: Recycle button + Block toggle
- `src/routes/admin.js` — new toggles: `auto_recycle` (all plans) and `caption_refresh_on_recycle` (Growth/Pro only)
- New migration (046 or next) — `block_from_recycle`, `recycled_from_id` on `posts`; `auto_recycle`, `caption_refresh_on_recycle` on `salons`

</code_context>

<specifics>
## Specific Ideas

- Caption refresh is a plan differentiator — Starter gets the recycling feature but not the AI caption variety. Good upsell surface.
- "Undo" for auto-recycled posts is scoped to deleting the recycled copy — keep it simple, no queue state restoration.
- Recycle candidate window: past 90 days, ranked by reach DESC, excluding posts recycled in last 45 days and `block_from_recycle = 1` posts (from REQUIREMENTS.md RECYC-02, RECYC-03).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 02-content-engine*
*Context gathered: 2026-03-19*
