# Video Upload Link Flow — Design
_Date: 2026-04-04_

## Problem

MMS videos are heavily compressed by carriers (often 176×144, AMR audio). TikTok rejects low-quality video. Stylists texting videos via MMS produces unusable TikTok content.

## Solution

Replace the MMS video path with a keyword-triggered direct upload flow. Stylists text "REEL" (or natural language equivalent) to receive a 30-minute upload link. They upload the original video from their camera roll — full quality, no carrier compression.

---

## Data

### New table: `video_upload_tokens`

```sql
id          TEXT PRIMARY KEY  -- UUID
stylist_id  TEXT NOT NULL     -- FK → stylists.id
salon_id    TEXT NOT NULL     -- FK → salons.slug
token       TEXT NOT NULL     -- 32-char random hex, UNIQUE
expires_at  TEXT NOT NULL     -- 30 minutes from creation (UTC ISO)
used_at     TEXT              -- set on successful upload; prevents replay
```

---

## Trigger Detection

New file: `src/core/reelRequest.js` — `isReelRequest(text)`

**Fast path** (substring match, case-insensitive):
- "reel", "post reel", "post a reel", "upload reel", "upload video", "share a reel"

**Intent path** (regex):
- "i'd like to post a", "i want to share a", "can i upload", "post my video"

Returns `true` if either path matches.

---

## Flow

### Keyword path (new)

1. Stylist texts "reel" or natural language variant
2. `isReelRequest(text)` returns `true`
3. messageRouter creates `video_upload_tokens` row (30-min expiry)
4. Replies via SMS:
   > "Here's your upload link (expires in 30 min): https://app.mostlypostly.com/stylist/upload-video/{token} — include a description of the look when you upload."

### MMS video path (updated)

1. Stylist texts a video file directly (`ContentType: video/*`)
2. messageRouter discards the MMS (no download)
3. Replies via SMS:
   > "For best quality, text REEL to get a direct upload link instead of sending video here."

### Upload page

- `GET /stylist/upload-video/:token` — validates token (not expired, not used), renders mobile-first upload form
- Form fields: video file picker (`accept="video/*"`) + description textarea + submit button
- `POST /stylist/upload-video/:token` — validates token again, saves video to `UPLOADS_DIR/videos/`, marks `used_at`, calls `generateReelCaption`, sends SMS caption preview to stylist

### After upload

Normal SMS flow:
- Stylist receives caption preview via SMS
- APPROVE / EDIT / REDO commands
- Goes to manager approval queue (if required)
- Scheduler publishes to FB + IG + TikTok (with transcoding)

---

## Token Security

- Token is 32-char random hex (crypto.randomBytes)
- Single-use: `used_at` set on first successful upload; subsequent attempts rejected
- 30-minute expiry enforced at both GET and POST
- No auth session required — token is the credential (same pattern as `stylist_portal_tokens`)

---

## Out of Scope

- Coordinator video upload (coordinators continue using the web portal)
- Video editing or trimming on the upload page
- Progress indicator for large video uploads (deferred)
