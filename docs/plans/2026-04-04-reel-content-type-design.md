# Design: Reel Content Type Selection

_Date: 2026-04-04_

## Problem
All video reels are hardcoded to `content_type: 'education'` regardless of what the video is about. Stylists have no way to classify their reel, so analytics and platform routing are incorrect.

## Solution
After the reel caption preview is sent, the stylist picks the content type by replying with a keyword (or tapping an RCS chip). Picking a type also submits the post — no separate APPROVE step for reels.

---

## Content Type Mapping

| Stylist keyword | `content_type` stored | Label |
|---|---|---|
| SERVICE | `standard_post` | Client service / transformation |
| EDUCATION | `education` | Tips, technique, how-to |
| PROMOTION | `promotion` | Deals, offers, limited-time |
| CULTURE | `team_culture` | Behind the scenes, team content |

Placement stays `reel` for all types (it's a video — format doesn't change).

---

## New Content Types (contentType.js)

Add to `DEFAULT_PLACEMENT`:
```js
promotion:    "reel",
team_culture: "reel",
```

`promotion` is distinct from `vendor_promotion` (brand campaigns). `team_culture` is new.

---

## Preview Message Change

**Before:**
```
Here's your Reel caption: [caption]

Review here: [url]

Or reply APPROVE to submit, EDIT to modify, or REDO for a new caption.
```

**After:**
```
Here's your Reel caption: [caption]

Review here: [url]

To post, reply with the reel type:
SERVICE · EDUCATION · PROMOTION · CULTURE

Or EDIT to change the caption, REDO for a new one.
```

RCS chips (when RCS_ENABLED): Service · Education · Promotion · Culture · Edit · Redo

---

## Reply Handling (messageRouter.js)

Add a handler **before** the APPROVE check in `handleIncomingMessage`:

1. If command is `SERVICE | EDUCATION | PROMOTION | CULTURE` AND `drafts.get(chatId)?.postType === 'reel'`:
   - Map command → content_type
   - `UPDATE posts SET content_type = ? WHERE id = ?` using `draft._db_id`
   - Call `enqueuePost` with the draft
   - Clear draft from Map
   - Reply: "Got it — your [Type] reel is queued for approval!"

2. If command is `APPROVE` AND draft exists AND `draft.postType === 'reel'`:
   - Reply: "To post your reel, reply SERVICE, EDUCATION, PROMOTION, or CULTURE."
   - Do not enqueue

EDIT and REDO continue to work unchanged (they're handled before this new block).

---

## Files to Change

| File | Change |
|---|---|
| `src/core/contentType.js` | Add `promotion` and `team_culture` to `DEFAULT_PLACEMENT` |
| `src/core/messageRouter.js` | 1) Update preview message in `generateReelCaption`; 2) Add type-selection reply handler; 3) Add reel-guard to APPROVE handler |

---

## Task Reference
- Task #9: Explore context ✅
- Task #10: Design doc ✅
