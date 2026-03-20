# TikTok Integration Design
_Date: 2026-03-20_

## Overview

Add TikTok as a publish destination alongside Facebook and Instagram. Salons connect their TikTok Business Account via OAuth (Login Kit). Approved posts auto-publish to TikTok via the Content Posting API (Direct Post mode) — photos as Photo Posts, videos as Reels. Stylist attribution via `@handle` tag in caption. No collab API — TikTok does not support it.

---

## Scope

- **In scope**: OAuth connect/disconnect, photo posts, video/Reel posts, scheduler wiring, integrations UI, daily cap, token refresh
- **Out of scope**: Stylist TikTok account linking (v2), analytics/insights sync (post-approval), TikTok Stories

---

## Section 1: Database (Migration 050)

### `salons` — new columns

| Column | Type | Notes |
|---|---|---|
| `tiktok_account_id` | TEXT | TikTok user `open_id` |
| `tiktok_username` | TEXT | Display username shown in UI |
| `tiktok_access_token` | TEXT | Short-lived (24h), refreshed before each publish |
| `tiktok_refresh_token` | TEXT | Long-lived (365 days) |
| `tiktok_token_expiry` | TEXT | ISO datetime — used to decide if refresh needed |
| `tiktok_enabled` | INTEGER | 0/1 toggle — pause without disconnecting |

### `posts` — new column

| Column | Notes |
|---|---|
| `tiktok_post_id` | Set after successful TikTok publish |

---

## Section 2: OAuth Flow

**New file:** `src/routes/tiktokAuth.js` — mounted at `/auth/tiktok`

**Scopes:** `user.info.basic`, `video.publish`, `video.upload`

| Route | Action |
|---|---|
| `GET /auth/tiktok/login` | Redirect to TikTok OAuth with `client_key`, `redirect_uri`, `scope`, `state={salon_id}` |
| `GET /auth/tiktok/callback` | Exchange code → tokens, fetch user info, save to `salons`, redirect to integrations |
| `POST /auth/tiktok/disconnect` | NULL all `tiktok_*` columns, `tiktok_enabled=0` |
| `POST /auth/tiktok/toggle` | Flip `tiktok_enabled` 0↔1 |

**Token refresh:** `src/core/tiktokTokenRefresh.js` — called before every publish. Refreshes if within 5 minutes of expiry. Silent failure (logs, skips TikTok for that post).

**Env vars required:**
```
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=   # https://app.mostlypostly.com/auth/tiktok/callback
```

---

## Section 3: Publisher

**File:** `src/publishers/tiktok.js` (replaces stub)

### `publishPhotoToTikTok(salon, imageUrls, caption)`
- `POST https://open.tiktokapis.com/v2/post/publish/content/init/`
- `post_info.media_type: "PHOTO"`, `post_mode: "DIRECT_POST"`
- Accepts 1–35 images
- Returns `publish_id` → stored as `tiktok_post_id`

### `publishVideoToTikTok(salon, videoUrl, caption)`
- `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
- `post_mode: "DIRECT_POST"`, `source_type: "PULL_FROM_URL"`
- TikTok pulls video directly from URL
- Returns `publish_id` → stored as `tiktok_post_id`

### Caption handling
- Max 2,200 chars
- Hashtags inline in caption
- `@stylisthandle` appended when `stylist.instagram_handle` is set (reuses existing field)

---

## Section 4: Scheduler Wiring

In `src/scheduler.js`, after existing FB/IG publish block:

```
if (salon.tiktok_enabled && salon.tiktok_access_token) {
  → refreshTiktokToken(salon) if needed
  → if video → publishVideoToTikTok()
  → else     → publishPhotoToTikTok()
  → UPDATE posts SET tiktok_post_id = ? WHERE id = ?
}
```

**Key decisions:**
- Non-blocking — FB/IG success not affected by TikTok failure
- Daily cap via existing `tiktok_daily_max` already in `getSalonPolicy()`
- Video detection: check image_url extension (`.mp4`, `.mov`) or `post_type`
- `postErrorTranslator.js` gets TikTok error mapping entry

---

## Section 5: Integrations UI

Replace disabled "Coming Soon" TikTok card in `src/routes/integrations.js` with live collapsible card.

**Connected state:**
- Green dot, `@tiktokusername`, enable/disable toggle, disconnect button

**Disconnected state:**
- Grey dot, "Connect TikTok" button → `GET /auth/tiktok/login`
- Subtitle: "Auto-publish to TikTok alongside Facebook & Instagram"

**Flash messages:**
- `?tiktok=connected` → green banner
- `?tiktok=disconnected` → grey banner
- `?tiktok=error` → red banner

**Scheduler config page:** Unlock the TikTok daily max input (remove "Coming Soon" badge, enable the existing input).

---

## Files to Create

| File | Purpose |
|---|---|
| `migrations/050_tiktok.js` | DB schema |
| `src/routes/tiktokAuth.js` | OAuth flow |
| `src/core/tiktokTokenRefresh.js` | Token refresh helper |
| `src/publishers/tiktok.js` | Publisher (replaces stub) |

## Files to Modify

| File | Change |
|---|---|
| `src/scheduler.js` | Add TikTok publish block + daily cap check |
| `src/routes/integrations.js` | Replace Coming Soon card with live card |
| `src/routes/schedulerConfig.js` | Unlock TikTok daily max input |
| `src/core/postErrorTranslator.js` | Add TikTok error mappings |
| `app.js` | Mount `/auth/tiktok` router |
| `migrations/index.js` | Register migration 050 |

---

## Task IDs

| Task | ID |
|---|---|
| Explore context | #1 |
| Clarifying questions | #2 |
| Propose approaches | #3 |
| Design approval | #4 |
| Write design doc | #5 |
| Invoke writing-plans | #6 |
