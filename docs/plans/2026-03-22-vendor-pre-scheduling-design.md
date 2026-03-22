# Vendor Campaign Pre-Scheduling Design
_Date: 2026-03-22_

## Problem

Vendor posts are currently created the same day the nightly scheduler runs, meaning they only appear on the calendar hours before publishing. Managers have no forward visibility into upcoming vendor campaign content.

## Goal

Pre-schedule vendor campaign posts 30 days in advance so managers can see them on the calendar, edit captions, and drag them to preferred dates — while guaranteeing they publish automatically without requiring approval.

---

## New Status: `vendor_scheduled`

A new `posts.status` value sitting between placeholder and published.

| Property | Behavior |
|---|---|
| Publishable | Yes — scheduler treats it like `manager_approved` |
| Requires approval | No |
| Editable (caption) | Yes |
| Draggable on calendar | Yes |
| Cancellable | No — delete/cancel button hidden |
| Calendar appearance | Dashed/ghost purple pill |

---

## Data Model

No new tables. `vendor_scheduled` is a new valid value for `posts.status`.

Migration `054_vendor_scheduled_status.js` — ensures any status guards/whitelists include `vendor_scheduled`.

---

## Scheduler Algorithm (vendorScheduler.js)

Replaces the current "create one post today if cap not met" approach.

### Nightly run (2am UTC) per salon → per vendor feed → per campaign:

```
lookahead_days = 30
window_start   = today (salon local)
window_end     = today + 30 days

1. Count existing posts in window:
   SELECT COUNT(*) FROM posts
   WHERE salon_id = ?
     AND vendor_campaign_id = ?
     AND status IN ('vendor_scheduled','manager_approved','manager_pending','published')
     AND scheduled_for BETWEEN window_start AND window_end

2. slots_needed = frequency_cap - existing_count
   (skip if slots_needed <= 0)

3. Divide 30-day window into frequency_cap equal intervals
   interval_length = 30 / frequency_cap days

4. For each interval i (0..frequency_cap-1):
   interval_start = window_start + (i * interval_length)
   interval_end   = window_start + ((i+1) * interval_length)

   -- Does a post already exist in this interval? (manager may have dragged one here)
   SELECT COUNT(*) FROM posts WHERE ... AND scheduled_for BETWEEN interval_start AND interval_end
   → if exists: skip (respect manager's drag)

   -- Pick a random datetime within interval, within salon posting hours
   scheduled_for = random day in interval, random time between posting_start_time and posting_end_time

5. Create post:
   status        = 'vendor_scheduled'
   scheduled_for = computed above (NOT via enqueuePost)
   post_type     = 'standard_post'
   vendor_campaign_id = campaign.id
   final_caption = AI-generated + locked hashtag block

6. Insert into vendor_post_log (posted_month = YYYY-MM of scheduled_for)
```

**Idempotent**: Running nightly produces the same result — existing posts in each interval are detected and skipped.

---

## Publish Loop (scheduler.js)

Change publish query from:
```sql
WHERE status = 'manager_approved' AND scheduled_for <= now
```
To:
```sql
WHERE status IN ('manager_approved', 'vendor_scheduled') AND scheduled_for <= now
```

After successful publish: status → `published` (unchanged).

---

## Calendar Changes (calendar.js)

### Rendering
- `vendor_scheduled` pill: dashed purple outline, slightly transparent — visually distinct from solid purple (published vendor)
- Label: vendor name (same as today)

### Interactivity
- Draggable: yes — uses existing `/calendar/reschedule` POST endpoint
- Edit caption: yes — existing modal, no approval button shown
- Cancel button: hidden when `status = 'vendor_scheduled'`

### Filter bar
- Add `vendor_scheduled` chip: "Vendor Scheduled" with ghost purple styling
- Existing "Vendor" filter chip continues to match all vendor post types

---

## Task IDs

| Task | ID |
|---|---|
| Migration (vendor_scheduled status) | #1 |
| vendorScheduler 30-day algorithm | #2 (blocked by #1) |
| Publish loop update | #3 (blocked by #1) |
| Calendar display + drag + filter | #4 (blocked by #1) |
