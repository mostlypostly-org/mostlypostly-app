# UTM Tracking + ROI Estimation — Design Doc

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Append standard MostlyPostly UTM parameters to all trackable URLs in posts, route them through a server-side click tracker for ROI reporting, and surface estimated revenue in the Analytics dashboard.

**Architecture:** Short opaque tokens mask UTM-encoded URLs in post captions. A public `/t/` redirect endpoint logs each click and bounces to the destination. A persistent per-salon bio link enables IG booking click tracking. ROI is estimated from click counts × configurable ticket/product values.

**Tech Stack:** Node.js/Express, better-sqlite3, existing `composeFinalCaption.js` + `vendorScheduler.js`, Analytics page

---

## Data Model

### New table: `utm_clicks`

```sql
CREATE TABLE utm_clicks (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,       -- short opaque token (8 chars)
  salon_id     TEXT NOT NULL,              -- FK → salons.slug
  post_id      TEXT,                       -- FK → posts.id (nullable — bio link has no post)
  click_type   TEXT NOT NULL,              -- 'booking' | 'vendor' | 'bio'
  vendor_name  TEXT,                       -- e.g. 'Aveda' (vendor clicks only)
  utm_content  TEXT,                       -- post type at creation time
  utm_term     TEXT,                       -- stylist slug at creation time
  destination  TEXT NOT NULL,             -- full destination URL (with UTMs)
  clicked_at   TEXT,                      -- UTC ISO — NULL = not yet clicked
  ip_hash      TEXT,                      -- SHA-256 of IP for dedup (never raw)
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_utm_clicks_salon ON utm_clicks(salon_id);
CREATE INDEX idx_utm_clicks_token ON utm_clicks(token);
```

### New column: `salons.avg_ticket_value`

```sql
ALTER TABLE salons ADD COLUMN avg_ticket_value INTEGER DEFAULT 95;
```

### New column: `vendor_brands.product_value`

```sql
ALTER TABLE vendor_brands ADD COLUMN product_value INTEGER DEFAULT 45;
```

---

## Standard UTM Parameter Set

| Parameter | Value |
|---|---|
| `utm_source` | `mostlypostly` |
| `utm_medium` | `social` |
| `utm_campaign` | salon slug (e.g. `vanity-lounge`) |
| `utm_content` | post type slug (e.g. `standard_post`, `vendor_aveda`, `availability`) |
| `utm_term` | stylist name slugified (e.g. `jessica-m`) — omitted if no stylist |

`utm_content` for vendor posts: `vendor_{vendor_name_slug}` — auto-derived from `campaign.vendor_name.toLowerCase().replace(/\s+/g, '-')`.

---

## Components

### 1. `src/core/utm.js` — UTM utility

```js
// appendUtm(url, params) → URL string with UTM query params appended
// Handles existing query strings. Skips null/empty url.
export function appendUtm(url, { source, medium, campaign, content, term }) { ... }

// slugify(str) → lowercase, spaces to hyphens, non-alphanum stripped
export function slugify(str) { ... }
```

### 2. `src/core/trackingUrl.js` — Token builder

```js
// buildTrackingToken({ salonId, postId, clickType, vendorName, utmContent, utmTerm, destination })
// → inserts row into utm_clicks, returns 8-char token
// buildShortUrl(token) → https://app.mostlypostly.com/t/{token}
// buildBioUrl(salonSlug) → https://app.mostlypostly.com/t/{slug}/book  (permanent, no token)
export function buildTrackingToken(...) { ... }
export function buildShortUrl(token) { ... }
export function buildBioUrl(salonSlug) { ... }
```

### 3. `src/routes/tracking.js` — Public redirect endpoint

```
GET /t/:token
  1. Look up token in utm_clicks
  2. If not found → 404
  3. If found and clicked_at IS NULL → update clicked_at + ip_hash
     (if clicked_at already set and ip_hash matches → skip dedup)
  4. 302 → destination URL

GET /t/:slug/book  (permanent bio link)
  1. Look up salon by slug
  2. Build destination: salon.booking_url + UTMs
     utm_content = 'bio_link', utm_term omitted
  3. Log to utm_clicks with click_type = 'bio', post_id = NULL
  4. 302 → destination
```

No auth required. Mount at app root (not under `/manager`).

### 4. Injection points

**`src/core/composeFinalCaption.js`** — booking URL (Facebook only):

```js
// Before: parts.push(`Book: ${booking}`)
// After:
import { buildTrackingToken, buildShortUrl } from './trackingUrl.js';

if (booking && platform === 'facebook') {
  const token = buildTrackingToken({
    salonId, postId, clickType: 'booking',
    utmContent: postType, utmTerm: stylistSlug,
    destination: appendUtm(booking, { source: 'mostlypostly', medium: 'social',
      campaign: salonId, content: postType, term: stylistSlug })
  });
  parts.push(`Book: ${buildShortUrl(token)}`);
}
```

`composeFinalCaption` needs `salonId`, `postId`, `postType`, `stylistSlug` added to its params object. All callers pass these from the post row.

**`src/core/vendorScheduler.js`** — affiliate URL:

```js
// Replace safeAffiliateUrl in the AI prompt with a tracking short URL
// utm_content = `vendor_${slugify(campaign.vendor_name)}`
// utm_term = omitted (no stylist)
```

The tracking token is created at post-creation time and embedded in the final caption, not in the AI prompt. The AI prompt continues to receive the raw affiliate URL so it can write naturally around it. The final caption replaces it with the short URL post-generation.

---

## Admin UI Changes

### Admin → Business Info card

New fields added to existing form:

```
Avg Ticket Value   [ $95 ]   (integer input, min 1)
                   Used to estimate booking revenue from link clicks.

Instagram Bio Link [ https://app.mostlypostly.com/t/vanity-lounge/book ] [Copy]
                   Paste this into your Instagram bio to track booking clicks.
                   Updates automatically when your booking URL changes.
```

### Onboarding (after booking URL step)

Optional field:
```
What's your average service ticket value?  [ $95 ]  (skip →)
We use this to estimate revenue driven by your posts.
```

### Analytics page — "Link Performance" card

New card below existing analytics:

```
Link Performance                    [This month ▾]

  Booking links     24 clicks     Est. $2,280  ⓘ
  Vendor links       8 clicks     Est. $360    ⓘ
  Instagram bio     11 clicks     Est. $1,045  ⓘ
  ─────────────────────────────────────────────
  Total est. ROI via MostlyPostly  $3,685

  [Update avg ticket value →]   (links to Admin → Business Info if still at default)
```

- Time filter: This month / Last month / All time
- ⓘ tooltip on booking: "Based on your $95 avg ticket value"
- ⓘ tooltip on vendor: "Based on $45 avg product value per brand"
- IG bio row hidden if zero clicks ever recorded (avoids confusion for salons who haven't set it up)
- Yellow setup nudge if `avg_ticket_value = 95` (still default) AND no clicks yet recorded

---

## Vendor Card UI (Salon Level — `/manager/vendors`)

### Preview Content accordion header

```
▶ Preview content   [2/4 this month]
```

Count pulled from `vendor_post_log` for this salon + campaign + current month vs `frequency_cap`.

### Inside the card — new action buttons

```
[ Add to Queue ]   [ Reset ]   ← Reset only shown if allow_client_renewal = 1
```

**Add to Queue flow:**
1. `POST /manager/vendors/add-to-queue` with `campaign_id`
2. Server calls `generateVendorCaption()` fresh — new AI caption each time
3. Creates post as `manager_approved` (manager clicking = implicit approval)
4. `enqueuePost()` schedules within posting window + spacing rules
5. UTM tracking token created and embedded in caption
6. Increments `vendor_post_log` count
7. Returns JSON `{ success: true, count: 3, cap: 4 }`
8. Button briefly shows "Added ✓", count pill updates to `3/4`
9. If at cap: button disabled, label = "Monthly cap reached"

**Reset flow:**
1. `POST /manager/vendors/reset-campaign` with `campaign_id`
2. Inline confirm: "Reset this month's post count for this campaign?"
3. Deletes `vendor_post_log` rows for this salon + campaign + current month
4. Count returns to `0/4`, Add to Queue re-enables

---

## Platform Console Restructure (separate implementation)

Noted as a follow-on design. Key points agreed:
- Brand-first hierarchy: Brands list → drill into brand → see/manage campaigns
- Vendor name becomes a navigation choice, not a text field (eliminates fat-finger)
- Platform Console nav: Overview · Salons & Plans · Vendor Management (Brands → Campaigns) · Support (Tickets, Feature Requests, Issues) · Approvals
- `vendor_brands.product_value` (INTEGER DEFAULT 45) added per brand for ROI calc

---

## Migration

`migrations/042_utm_tracking.js`:
- Create `utm_clicks` table
- `ALTER TABLE salons ADD COLUMN avg_ticket_value INTEGER DEFAULT 95`
- `ALTER TABLE vendor_brands ADD COLUMN product_value INTEGER DEFAULT 45`

---

## Definition of Done

- [ ] `/t/:token` redirect logs clicks and bounces correctly
- [ ] `/t/:slug/book` bio link works for all salons
- [ ] FB booking captions contain short tracking URL (not raw booking URL)
- [ ] Vendor captions contain short tracking URL (not raw affiliate URL)
- [ ] IG captions unchanged (still "Book via link in bio." — no URL)
- [ ] Admin → Business Info shows avg ticket value + bio link copy field
- [ ] Analytics Link Performance card shows correct counts and ROI estimates
- [ ] Add to Queue generates fresh caption, enqueues, updates count pill
- [ ] Reset clears monthly log and re-enables Add to Queue
- [ ] All UTM params match the standard set exactly
- [ ] No raw IP addresses stored — SHA-256 hash only
