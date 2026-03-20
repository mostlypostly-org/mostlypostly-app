---
phase: 03-reels-video
plan: "01"
subsystem: video-infrastructure
tags: [video, twilio, mms, uploads, reels]
dependency_graph:
  requires: []
  provides: [downloadTwilioVideo, VIDEO_DIR, isVideo-flag]
  affects: [src/core/messageRouter.js, future reel post pipeline]
tech_stack:
  added: []
  patterns: [node-fetch Basic auth download, fsSync.mkdirSync at module load]
key_files:
  created:
    - src/core/videoDownload.js
  modified:
    - src/routes/twilio.js
    - server.js
decisions:
  - No new express.static mount added — existing /uploads mount in server.js already serves UPLOADS_DIR/videos/ at /uploads/videos/
  - node-fetch v3 default import used (ESM-compatible)
  - isVideo flag suppresses Twilio auto-ACK so video flow can send its own prompt
metrics:
  duration_seconds: 120
  completed_date: "2026-03-20"
  tasks_completed: 2
  tasks_total: 2
  files_created: 1
  files_modified: 2
---

# Phase 03 Plan 01: Video Infrastructure Summary

**One-liner:** Twilio video MMS detection with Basic-auth download utility saving UUID.mp4 to persistent disk, served via existing /uploads static mount.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Create videoDownload.js utility and ensure video directory exists | f9893e9 | src/core/videoDownload.js |
| 2 | Add video content-type detection to Twilio webhook and update cache headers | 9693c44 | src/routes/twilio.js, server.js |

## What Was Built

### src/core/videoDownload.js (new)
- Exports `VIDEO_DIR = path.join(UPLOADS_DIR, 'videos')` — creates directory at module load via `fsSync.mkdirSync`
- Exports `downloadTwilioVideo(twilioUrl)` — fetches with `Authorization: Basic <sid:token>` header, saves as `UUID.mp4`, returns `{ filePath, publicUrl, filename }`
- `publicUrl` is `${PUBLIC_BASE_URL}/uploads/videos/{filename}` — served by the existing `/uploads` static mount
- Error handling: wraps in try/catch, logs `[videoDownload]` prefix, re-throws so callers can handle

### src/routes/twilio.js (modified)
- Added `const primaryContentType = req.body.MediaContentType0 || ''` and `const isVideo = primaryContentType.startsWith('video/')`
- Passes `isVideo` to `handleIncomingMessage` so the router can route to Reels pipeline in future plans
- Suppresses auto-ACK "Got it! Building your post..." when `isVideo` is true (video flow sends its own prompt)

### server.js (modified)
- Extended cache header regex from `jpg|jpeg|png|gif|webp` to include `mp4|mov` — video files now get `Cache-Control: public, max-age=86400`

## Deviations from Plan

None - plan executed exactly as written. The CONTEXT.md note about no new express.static mount was confirmed correct — VIDEO_DIR is under UPLOADS_DIR which is already served at /uploads.

## Self-Check: PASSED

- [x] src/core/videoDownload.js exists
- [x] Exports VIDEO_DIR (ends with /videos) and downloadTwilioVideo (async function)
- [x] isVideo appears 3 times in src/routes/twilio.js (declaration, ACK conditional, handleIncomingMessage)
- [x] server.js contains mp4|mov in cache header regex
- [x] Commits f9893e9 and 9693c44 confirmed in git log
