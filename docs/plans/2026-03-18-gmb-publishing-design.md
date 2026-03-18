# Google Business Profile Publishing — Design Doc

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:writing-plans to create the implementation plan.

**Date:** 2026-03-18
**Feature:** FEAT-020 — Google Business Profile Publishing
**Status:** Design approved, ready for implementation planning

---

## Goal

Automatically publish MostlyPostly posts to Google Business Profile alongside Facebook and Instagram. Supports "What's New" posts (all post types) and "Offer" posts (promotions + vendor posts). Includes GMB analytics sync (post views + clicks). Available on Growth and Pro plans.

## Architecture

Follows the exact same pattern as Facebook/Instagram: OAuth once per salon → store access + refresh tokens → auto-refresh before each publish → publish alongside FB/IG in the scheduler → sync insights on demand. The Integrations page becomes the single home for all platform connections.

## Tech Stack

- Google Business Profile API v4 (localPosts endpoint)
- Google OAuth 2.0 (access_type=offline for refresh token)
- Business Profile Performance API (insights)
- No new npm packages — uses built-in `https`/`fetch`

---

## Task Index

| # | Task | ID |
|---|---|---|
| 1 | Migration 039: GMB columns | #35 |
| 2 | Google OAuth flow + token refresh | #36 |
| 3 | GMB publisher | #37 |
| 4 | Scheduler integration | #38 |
| 5 | GMB insights sync | #39 |
| 6 | Integrations page redesign | #40 |
| 7 | GMB badges + analytics dashboard | #41 |

---

## Section 1: Database Schema (Migration 039)

### `salons` table additions
```sql
google_location_id    TEXT     -- GMB location resource name (accounts/xxx/locations/yyy)
google_access_token   TEXT     -- Short-lived, refreshed before each publish
google_refresh_token  TEXT     -- Long-lived, stored permanently
google_business_name  TEXT     -- Display name pulled at connect time
google_token_expiry   TEXT     -- ISO datetime, used to decide if refresh needed
gmb_enabled           INTEGER  DEFAULT 0  -- Salon-level toggle (0/1)
```

### `posts` table addition
```sql
google_post_id        TEXT     -- Stored after successful GMB publish
```

### `post_insights` — no schema change
GMB rows use `platform = 'google'`. `impressions` ← VIEWS, `link_clicks` ← CLICKS. All other columns NULL.

---

## Section 2: OAuth Flow

### New file: `src/routes/googleAuth.js`

**`GET /auth/google/login?salon=<slug>`**
- Redirects to Google OAuth with scope: `https://www.googleapis.com/auth/business.manage`
- `access_type=offline&prompt=consent` to guarantee refresh token
- State param carries `salon_id`

**`GET /auth/google/callback?code=...&state=...`**
- Exchange code for access + refresh tokens
- Fetch GMB account via `mybusinessaccountmanagement.googleapis.com/v1/accounts`
- Fetch locations via `mybusinessbusinessinformation.googleapis.com/v1/accounts/{id}/locations`
- If one location → auto-select. If multiple → render picker page
- Save all credentials to salon row
- Redirect to Integrations page with `?gmb=connected` flash

**`POST /auth/google/disconnect`**
- Clears all `google_*` columns from salon row

### New file: `src/core/googleTokenRefresh.js`

**`refreshGmbToken(salon)`**
- Checks `google_token_expiry` — if expired or within 5 min of expiry, calls Google token endpoint with refresh token
- Updates `google_access_token` + `google_token_expiry` in salon row
- Returns fresh access token
- Called at top of every GMB publish — silent, no user interaction

### New env vars
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=    # https://app.mostlypostly.com/auth/google/callback
```

---

## Section 3: Publisher

### New file: `src/publishers/googleBusiness.js`

**`publishWhatsNewToGmb(salon, caption, imageUrl)`**
- Refresh token via `refreshGmbToken(salon)`
- POST to `https://mybusiness.googleapis.com/v4/{locationName}/localPosts`:
  ```json
  {
    "topicType": "STANDARD",
    "summary": "<caption truncated to 1500 chars>",
    "media": [{ "mediaFormat": "PHOTO", "sourceUrl": "<imageUrl>" }]
  }
  ```
- Returns `{ id: localPost.name }`

**`publishOfferToGmb(salon, caption, imageUrl, offerDetails)`**
- `offerDetails` = `{ title, startDate, endDate }`
- `startDate` = today (ISO date), `endDate` = `promotion_expires_at` from post
- POST with `"topicType": "OFFER"` + `"offer"` object
- Returns `{ id: localPost.name }`

**Caption rules:**
- 1,500 character hard limit — truncate with `...` if exceeded
- Booking URL appended to caption body

---

## Section 4: Scheduler Integration

In `src/scheduler.js`, after the existing FB/IG publish block:

```js
const gmbEligible = ["growth", "pro"].includes(salon.plan)
  && salon.gmb_enabled
  && salon.google_location_id
  && salon.google_refresh_token;

if (gmbEligible) {
  const isOffer = ["promotions", "vendor_post"].includes(post.post_type);
  if (isOffer) {
    gmbResp = await publishOfferToGmb(salon, caption, image, {
      title: post.product_name || salon.name,
      startDate: todayIso,
      endDate: post.promotion_expires_at,
    });
  } else {
    gmbResp = await publishWhatsNewToGmb(salon, caption, image);
  }
}
```

**Rules:**
- GMB failure does NOT block FB/IG — independent try/catch
- Availability (story-only) posts skip GMB
- `google_post_id` saved to posts row after successful publish

---

## Section 5: Analytics Sync

### New file: `src/core/fetchGmbInsights.js`

**`syncGmbInsights(salon)`**
- Refresh token
- Fetch all published localPosts for the location
- Match to `posts` table via `google_post_id`
- Call `localPosts:reportInsights` with `basicMetric: ['VIEWS', 'CLICKS']`
- Upsert into `post_insights` (platform='google', impressions=views, link_clicks=clicks)

**Wired into:** `syncSalonInsights()` in `fetchInsights.js` — called by `/analytics/sync`

### Analytics dashboard additions
- GMB summary card: total GMB views + clicks this month (shown if `google_location_id` set)
- GMB views/clicks columns in posts table
- Only shown for salons with GMB connected

---

## Section 6: Integrations Page Redesign

`src/routes/integrations.js` becomes the single home for all platform connections.

**Layout — collapsible cards:**
```
● Facebook & Instagram     ✓ Connected  ▾
  [page ID, IG handle, token status, reconnect button]

● Google Business Profile  Not set      ▾
  [connect button + gmb_enabled toggle; plan gate if Starter]

● Zenoti                   ✓ Connected  ▾
  [existing Zenoti config + sync button]
```

- Green dot = connected, gray = not configured
- Cards collapsed by default
- Facebook/Instagram config **moved** from `admin.js` to integrations page
- `admin.js` social connection card removed

---

## Section 7: GMB Badge on Post Cards

**Visual:** Google blue `#4285F4` rounded badge with white **G** — matches FB/IG badge style.

**States:**
- 🔵 **G** (blue, linked) — `google_post_id` set → links to live GMB post URL
- ⚪ **G** (gray) — GMB enabled for salon but post wasn't published to GMB
- Hidden — GMB not connected for salon

**Locations:** Dashboard post cards, Post Queue cards, Analytics posts table.

---

## Plan Gates

- **Growth + Pro:** Full GMB access (connect, publish, analytics)
- **Starter:** Integrations page shows GMB card with upgrade prompt — connect button disabled

---

## Future: Review Management (FEAT-026 enhanced)

The GMB OAuth connection built here is the foundation for review management:
- Pull recent reviews via GMB Reviews API
- AI auto-reply in salon brand voice
- Identify mentioned team member → match to stylist record
- Generate celebration-style "thank you" post → publish to FB/IG/GMB

Scope separately after publishing ships.
