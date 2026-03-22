# Design: Vendor Scheduler — Fill All Cap Slots Per Run

**Date:** 2026-03-22
**Status:** Approved

## Problem

`vendorScheduler.js` currently creates at most **one post per campaign per scheduler run** due to a `break` after finding the first empty interval. With a cap of 4, it takes 4 daily runs before the 30-day window is fully populated. Managers see only 1 vendor post per campaign in the near-term calendar instead of the full spread.

## Goal

On each daily scheduler run, fill **all empty slots up to the cap** for each campaign in a single pass. Once all slots are filled, stop until a slot opens (a post publishes and rolls out of the 30-day window).

## Approach: Option A — Fill all slots per run (remove the `break`)

### What changes

**File:** `src/core/vendorScheduler.js`

**`processCampaign`** — restructured to:
1. Check if `existingCount >= cap` → skip (unchanged)
2. Loop through **all** `cap` intervals — for each empty interval: generate a caption and insert a post
3. Return **count of posts created** (integer, 0–cap) instead of boolean

**`processSalon`** — accumulates the integer count returned from each campaign call (instead of `if (didCreate) created++`).

**`runVendorScheduler`** — no change needed; already totals `created` across salons.

No other files change.

### Data flow per run (cap=4, 0 existing posts)

```
Interval 0 (days 0–7):   empty → generate caption → insert post #1
Interval 1 (days 7–15):  empty → generate caption → insert post #2
Interval 2 (days 15–22): empty → generate caption → insert post #3
Interval 3 (days 22–30): empty → generate caption → insert post #4
→ returns 4
```

Next daily run: `existingCount = 4 = cap` → skip entire campaign.

As posts publish and roll behind `windowStart`, `existingCount` drops below `cap` and the next run fills the new opening automatically.

### Error handling

If OpenAI caption generation fails for one interval, that slot is skipped and the loop continues to fill remaining intervals. No partial-fill aborts the run.

### Non-goals

- No change to the 30-day rolling window logic
- No change to interval spacing math
- No change to cap enforcement
- No change to how manually repositioned posts are respected (`slotTaken > 0 → continue`)

## Success criteria

- [ ] On first scheduler run for a new campaign (0 existing posts), all `cap` posts are scheduled spread across the 30-day window
- [ ] Calendar shows full set of vendor posts immediately after first run
- [ ] On subsequent runs where window is full, no duplicate posts are created
- [ ] If 1 post publishes and falls out of window, next run fills exactly 1 new slot
- [ ] OpenAI failure on one interval does not prevent other intervals from being filled
