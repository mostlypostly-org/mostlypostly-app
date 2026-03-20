# Phase 3: Reels & Video - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Detect video MMS from stylists, download and re-host locally, prompt for service description, generate a Reel caption, and publish as an Instagram Reel + Facebook Reel through the existing approval flow. TikTok is a publisher stub only — no full publish flow this phase. Analytics and leaderboard are updated to score reel post_type correctly.

Creating new post types beyond `reel`, new publishing channels beyond IG/FB/TikTok stub, and video editing/trimming are out of scope.

</domain>

<decisions>
## Implementation Decisions

### Stylist Video SMS Flow
- Prompt after video received: `"Got your video! What service is this? Give me a quick description and I'll write your caption."` — same casual tone as the rest of the app
- If stylist doesn't reply within 30 minutes: auto-timeout and generate a generic caption from salon tone alone (same as a photo without context still gets a caption)
- Caption preview wording: `"Here's your Reel caption:"` instead of the usual `"Here's your caption:"` — minor wording change only; all other preview format is identical
- APPROVE, EDIT, REDO all work identically to photo posts — no special cases in messageRouter.js draft handling

### Video File Storage & Public URL
- Download Twilio video with auth -> save to `data/uploads/videos/` — no S3
- Rename to UUID + `.mp4` extension on download — avoids collisions, no Twilio filenames in public URLs
- **NOTE (superseded):** The original decision to add `express.static('data/uploads/videos')` mounted at `/uploads/videos/` is superseded by code inspection. The existing `app.use("/uploads", express.static(UPLOADS_DIR, ...))` mount in server.js (line 285) already serves all files under UPLOADS_DIR, including the `videos/` subdirectory. No new static mount is needed — only the cache header regex needs updating to include `mp4|mov` extensions. Plans 03-01 through 03-04 implement this correctly.
- Public video URL constructed using `PUBLIC_BASE_URL` env var (same pattern as buildPromotionImage.js / buildAvailabilityImage.js)
- Store video URL in existing `image_url` column on posts table — no schema change, all existing queries work unchanged

### Instagram Reels API
- Three-step: create container (type=REELS) -> poll status -> publish
- Poll inside the scheduler tick: 3s intervals x 40 attempts = 2 min max timeout
- After 2 min without `FINISHED` status: mark post as failed, surface via existing error flow (postErrorTranslator.js + manager SMS)
- IG and FB publish independently — one failure does not block the other (same as photo posts today)

### Facebook Reels API
- Use dedicated FB Reels endpoint (`POST /me/video_reels`) — no fallback to standard video post
- If FB Reels fails: surface error via existing error flow, no silent fallback

### TikTok Stub
- Create `src/publishers/tiktok.js` with exported `publishReel()` that throws `'TikTok publishing not yet available'`
- Add a greyed-out TikTok card on `/manager/integrations` with "Coming soon — pending approval" text
- Add a plan task to confirm TikTok Developer app is submitted and note the approval timeline (external dependency, not blocking)

### Analytics & Leaderboard
- Add `reel: 20` to `DEFAULT_POINTS` in `src/core/gamification.js` (requirement: 20 pts vs 10 for standard)
- `pickNextPost()` already scores reel posts at -1 (bonus content, SCHED-06 already implemented in Phase 2)
- `postTypeLabel()` and analytics queries need `reel` handled like other post_types — verify coverage

### Claude's Discretion
- Exact `data/uploads/videos/` directory creation and file path construction
- Twilio video download implementation (fetch with Basic auth vs using twilio-node SDK)
- IG container creation request body shape and API version
- FB Reels API endpoint exact path (research needed — Graph API v22.0)
- Migration number (next after current highest — check migrations/ directory)
- Whether `gamification_settings` table needs a new `pts_reel` column or if the `DEFAULT_POINTS` fallback in `getPointValue()` is sufficient

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Message routing & SMS flow
- `src/routes/twilio.js` — existing MMS handling (`MediaContentType0`, `MediaUrl0`); video branch goes here
- `src/core/messageRouter.js` — draft flow (APPROVE/EDIT/REDO handling); video caption flow reuses this path

### Publishing
- `src/publishers/instagram.js` — existing photo publish patterns; Reels publisher added here or as a new function in same file
- `src/publishers/facebook.js` — existing photo publish; FB Reels publisher added here

### Analytics & Gamification
- `src/core/gamification.js` — `DEFAULT_POINTS` object and `getPointValue()` — add `reel: 20`
- `src/routes/analytics.js` — `postTypeLabel()` helper — ensure `reel` is handled
- `src/core/pickNextPost.js` — already handles `reel` type (SCHED-06, scored -1) — do not change

### Storage & DB
- `src/core/storage.js` — `savePost()` — reel posts use `post_type='reel'`, `image_url` stores video URL
- `migrations/` — next migration for any schema additions (check highest existing number)

### Integrations page
- `src/routes/integrations.js` — TikTok "coming soon" card added here as a collapsed/greyed card

### Environment & URL patterns
- `src/core/buildPromotionImage.js` — example of `PUBLIC_BASE_URL` usage for constructing public asset URLs
- `src/core/uploadPath.js` — `UPLOADS_DIR` pattern; video storage follows same env var discipline

### Error flow
- `src/core/postErrorTranslator.js` — translate IG/FB Reel API errors to plain English
- `src/scheduler.js` — failed post handling (`MAX_RETRIES`, manager SMS) — Reel failures use same path

### No external specs — requirements fully captured in REQUIREMENTS.md (REEL-01 through REEL-10)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `twilio.js` already captures `MediaContentType0` and `MediaUrl0` — video detection is adding a branch on `content-type.startsWith('video/')`
- `instagram.js` publish patterns — container creation and publish are separate API calls; Reels follows same structure but different endpoint and status polling step
- `sendViaTwilio()` in twilio.js — used for the video description prompt SMS and the preview SMS
- `enqueuePost()` in scheduler.js — reel posts enter the queue the same way as all other post types
- `postErrorTranslator.js` — already handles raw API errors; add IG/FB Reel-specific error strings
- `getPointValue()` in gamification.js — already falls back to `DEFAULT_POINTS[key] ?? 10`; adding `reel: 20` to `DEFAULT_POINTS` is sufficient without a new DB column

### Established Patterns
- DB is synchronous (`better-sqlite3`) — no `await` on DB calls; video metadata stored synchronously
- `post_type` values are normalized via `canonicalType()` in gamification.js — `reel` will normalize correctly
- All post rows use `image_url` for the primary media URL — video URL stored there, no new column needed
- `PUBLIC_BASE_URL` env var already set in Render for both staging and production
- Existing `/uploads` static mount in server.js already serves all files under UPLOADS_DIR — no new mount needed for videos

### Integration Points
- `src/routes/twilio.js` — add video content-type detection branch before the photo flow
- `src/core/messageRouter.js` — add video draft path; description prompt stored in-memory pending stylist reply
- `src/publishers/instagram.js` — add `publishReel(salon, videoUrl, caption)` function
- `src/publishers/facebook.js` — add `publishFacebookReel(salon, videoUrl, caption)` function
- `src/core/gamification.js` — add `reel: 20` to `DEFAULT_POINTS`
- `src/routes/integrations.js` — add TikTok "coming soon" card
- `data/uploads/videos/` — new directory, served via existing Express static mount at `/uploads`

</code_context>

<specifics>
## Specific Ideas

- The 30-minute video description timeout generates a caption from salon tone alone — same fallback as a photo post with no text context. This means the reel still gets published, just with a more generic caption.
- `"Here's your Reel caption:"` is the only UX change vs a standard photo post preview — everything else (APPROVE/EDIT/REDO) is identical, keeping the flow zero-friction.
- TikTok "coming soon" card on Integrations matches the pattern of connected-but-not-enabled integrations — collapsed state with greyed styling and explanatory text.
- IG polling inside the scheduler tick is acceptable given Render's always-on instance — no concern about restart losing the container_id since the poll completes within the same tick.

</specifics>

<deferred>
## Deferred Ideas

- ffmpeg frame extraction for video captions (REQUIREMENTS.md Out of Scope: "Phase 2 of Reels — SMS prompt is sufficient for v1")
- TikTok full publish flow — pending TikTok Developer app approval (FEAT-022 Phase 2, next milestone)
- Video trimming or compression before upload
- Video thumbnail customization

</deferred>

---

*Phase: 03-reels-video*
*Context gathered: 2026-03-20*
