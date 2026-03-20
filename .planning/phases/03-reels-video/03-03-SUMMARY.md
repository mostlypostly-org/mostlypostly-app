---
phase: 03-reels-video
plan: 03
subsystem: api
tags: [twilio, sms, video, reel, caption, utm-tracking, messageRouter]

requires:
  - phase: 03-01
    provides: downloadTwilioVideo, isVideo flag in twilio.js
  - phase: 03-02
    provides: reel publishing in scheduler/enqueuePost

provides:
  - pendingVideoDescriptions in-memory Map with 30-min TTL
  - generateReelCaption module-level async function
  - video MMS branch in handleIncomingMessage
  - video description reply handler
  - MENU command updated to include Reel capability

affects:
  - 03-04-reel-dashboard (reel posts now appear in DB as post_type='reel')
  - 03-05-kb-article (user-facing reel flow now complete end-to-end)

tech-stack:
  added: []
  patterns:
    - "pendingVideoDescriptions Map pattern mirrors consentSessions/noAvailabilityRecent"
    - "generateReelCaption must call composeFinalCaption to inject Book: line for UTM tracking"
    - "Video MMS branch placed before photo branch — isVideo && primaryImageUrl short-circuits"
    - "setTimeout VIDEO_DESC_TTL_MS auto-generates generic caption on stylist timeout"

key-files:
  created: []
  modified:
    - src/core/messageRouter.js

key-decisions:
  - "generateReelCaption derives stylistId from stylist parameter, not _stylistId (local variable in handleIncomingMessage)"
  - "composeFinalCaption called with correct {caption, hashtags, cta, ...} signature (not baseCaption)"
  - "getSalonPolicy used directly (static import) rather than dynamic import in generateReelCaption"
  - "Video null guard checks !stylist?.salon_info (mirrors existing salon/stylist resolution pattern)"
  - "MENU Reel entry placed between Standard post and Before & after"

requirements-completed:
  - REEL-03
  - REEL-04
  - REEL-05

duration: 8min
completed: 2026-03-20
---

# Phase 03 Plan 03: Reel SMS Flow Summary

**Video MMS → description prompt → GPT-4o caption with Book: line injection → reel post created with post_type='reel' and full APPROVE/EDIT/REDO flow**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-20T14:06:00Z
- **Completed:** 2026-03-20T14:09:57Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments

- Stylist texting a video now receives: "Got your video! What service is this? Give me a quick description and I'll write your caption."
- Stylist's reply generates a GPT-4o reel caption with composeFinalCaption injecting the Book: line for UTM tracking
- 30-minute timeout auto-generates generic reel caption if stylist never replies
- Post saved as post_type='reel' with video public URL in image_url — appears in approval queue
- Preview message starts with "Here's your Reel caption:" with APPROVE/EDIT/REDO instructions
- MENU command updated to list Reel capability between Standard post and Before & after

## Task Commits

Each task was committed atomically:

1. **Task 1 + Task 2: Video SMS flow, generateReelCaption, MENU update** - `464c436` (feat)

## Files Created/Modified

- `src/core/messageRouter.js` — Added downloadTwilioVideo import, pendingVideoDescriptions Map, VIDEO_DESC_TTL_MS constant, isVideo parameter to handleIncomingMessage, generateReelCaption function, video description reply check, video MMS branch, updated MENU command

## Decisions Made

- `generateReelCaption` uses `crypto.randomUUID()` via the existing `import crypto from "crypto"` at line 4 (the `crypto` default export has `randomUUID` as a method in Node.js) — no separate `randomUUID` import needed
- `getSalonPolicy` already statically imported at top of file — used directly in `generateReelCaption` instead of dynamic import
- `composeFinalCaption` called with `{caption, hashtags, cta, instagramHandle, stylistName, bookingUrl, salon, salonId, postId, postType}` — matches actual function signature (plan docs used `baseCaption` but actual param name is `caption`)
- Null guard in video branch checks `!stylist?.salon_info` (consistent with how existing code confirms stylist is fully resolved)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] composeFinalCaption called with correct parameter name**
- **Found during:** Task 1 (generateReelCaption implementation)
- **Issue:** Plan code snippets used `baseCaption` as the parameter key, but `composeFinalCaption`'s actual signature uses `caption`
- **Fix:** Called `composeFinalCaption({ caption: aiJson?.caption, ... })` with the correct key
- **Files modified:** src/core/messageRouter.js
- **Verification:** Matched against composeFinalCaption.js line 49 destructure definition
- **Committed in:** 464c436

**2. [Rule 1 - Bug] Removed dynamic import of getSalonPolicy**
- **Found during:** Task 1 (generateReelCaption implementation)
- **Issue:** Plan code used `await import("../scheduler.js")` inside generateReelCaption, but getSalonPolicy is already a static import at the top of messageRouter.js — dynamic import was redundant and could cause issues
- **Fix:** Used statically imported `getSalonPolicy` directly
- **Files modified:** src/core/messageRouter.js
- **Verification:** Confirmed `import { getSalonPolicy } from "../scheduler.js"` at line 7
- **Committed in:** 464c436

---

**Total deviations:** 2 auto-fixed (both Rule 1 - Bug, parameter naming and redundant import)
**Impact on plan:** Both fixes necessary for correctness. No scope creep.

## Issues Encountered

None — plan executed cleanly with two minor parameter-naming corrections caught during implementation.

## Next Phase Readiness

- Video SMS flow complete end-to-end: video MMS → description prompt → reel caption → DB post_type='reel'
- UTM tracking via composeFinalCaption Book: line injection works for reel posts
- 30-min timeout ensures reel always appears in approval queue regardless of stylist reply
- Ready for Phase 03-04: dashboard display of reel posts

---
*Phase: 03-reels-video*
*Completed: 2026-03-20*
