# Google Business Profile Publishing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Automatically publish MostlyPostly posts to Google Business Profile (What's New + Offer) alongside Facebook/Instagram, with insights sync, a redesigned Integrations page, and GMB badges on post cards.

**Architecture:** Google OAuth per salon (access + refresh tokens stored in `salons` table). Token auto-refreshed before each publish. Scheduler calls GMB publisher after FB/IG. Integrations page consolidates all platform connections. Growth/Pro gated.

**Tech Stack:** Node.js ESM, Google Business Profile API v4, Google OAuth 2.0, better-sqlite3, Express, existing pageShell/Tailwind UI patterns.

---

## Task 1: Migration 039 — GMB columns on salons + posts

**Files:**
- Create: `migrations/039_gmb.js`
- Modify: `migrations/index.js`

**Step 1: Create the migration file**

```js
// migrations/039_gmb.js
export function run(db) {
  const salonCols = db.prepare(`PRAGMA table_info(salons)`).all().map(c => c.name);
  const add = (col, def) => {
    if (!salonCols.includes(col))
      db.prepare(`ALTER TABLE salons ADD COLUMN ${col} ${def}`).run();
  };
  add("google_location_id",   "TEXT");
  add("google_access_token",  "TEXT");
  add("google_refresh_token", "TEXT");
  add("google_business_name", "TEXT");
  add("google_token_expiry",  "TEXT");
  add("gmb_enabled",          "INTEGER DEFAULT 0");

  const postCols = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
  if (!postCols.includes("google_post_id"))
    db.prepare(`ALTER TABLE posts ADD COLUMN google_post_id TEXT`).run();
}
```

**Step 2: Register in migrations/index.js**

Add at bottom of imports:
```js
import { run as run039 } from "./039_gmb.js";
```

Add at bottom of migrations array:
```js
{ name: "039_gmb", run: run039 },
```

**Step 3: Verify migration runs without error**
```bash
node -e "import('./db.js').then(m => console.log('DB OK'))"
```
Expected: `DB OK` (migration runner fires on DB open)

**Step 4: Commit**
```bash
git add migrations/039_gmb.js migrations/index.js
git commit -m "feat: migration 039 — GMB columns on salons + posts"
```

---

## Task 2: Google token refresh helper

**Files:**
- Create: `src/core/googleTokenRefresh.js`

**Step 1: Create the file**

```js
// src/core/googleTokenRefresh.js
import db from "../../db.js";

/**
 * Returns a valid Google access token for the salon.
 * Silently refreshes using the stored refresh token if expired or within 5 min.
 * Updates salons row in place.
 */
export async function refreshGmbToken(salon) {
  const expiry = salon.google_token_expiry ? new Date(salon.google_token_expiry) : null;
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);

  // Token is still valid — return it directly
  if (expiry && expiry > fiveMinFromNow && salon.google_access_token) {
    return salon.google_access_token;
  }

  if (!salon.google_refresh_token) {
    throw new Error(`[GMB] No refresh token for salon ${salon.slug}`);
  }

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: salon.google_refresh_token,
    grant_type:    "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`[GMB] Token refresh failed: ${JSON.stringify(data)}`);
  }

  const newExpiry = new Date(Date.now() + data.expires_in * 1000).toISOString();

  db.prepare(`
    UPDATE salons SET google_access_token = ?, google_token_expiry = ? WHERE slug = ?
  `).run(data.access_token, newExpiry, salon.slug);

  // Mutate in place so caller's salon object reflects new token
  salon.google_access_token = data.access_token;
  salon.google_token_expiry = newExpiry;

  console.log(`[GMB] Token refreshed for salon ${salon.slug}, expires ${newExpiry}`);
  return data.access_token;
}
```

**Step 2: Spot-check — verify syntax**
```bash
node --input-type=module <<'EOF'
import { refreshGmbToken } from "./src/core/googleTokenRefresh.js";
console.log("import OK");
EOF
```
Expected: `import OK`

**Step 3: Commit**
```bash
git add src/core/googleTokenRefresh.js
git commit -m "feat: Google token refresh helper (refreshGmbToken)"
```

---

## Task 3: Google OAuth route (googleAuth.js)

**Files:**
- Create: `src/routes/googleAuth.js`
- Modify: `server.js` (add import + mount)

**Step 1: Create src/routes/googleAuth.js**

```js
// src/routes/googleAuth.js
import express from "express";
import db from "../../db.js";

const router = express.Router();

const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
].join(" ");

// ── GET /auth/google/login?salon=<slug> ──────────────────────────────────────
router.get("/login", (req, res) => {
  const salon_id = req.query.salon || req.session?.salon_id;
  if (!salon_id) return res.redirect("/manager/login");

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",
    state:         JSON.stringify({ salon_id }),
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── GET /auth/google/callback ─────────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("[Google OAuth] Error from Google:", error);
    return res.redirect("/manager/integrations?gmb=error");
  }

  let salon_id;
  try {
    ({ salon_id } = JSON.parse(state));
  } catch {
    return res.redirect("/manager/integrations?gmb=error");
  }

  try {
    // 1. Exchange code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    "authorization_code",
      }).toString(),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const accessToken  = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiry       = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // 2. Fetch GMB accounts
    const accountsResp = await fetch(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const accountsData = await accountsResp.json();
    const account = accountsData.accounts?.[0];
    if (!account) throw new Error("No Google Business accounts found.");

    // 3. Fetch locations
    const locResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const locData = await locResp.json();
    const locations = locData.locations || [];

    if (locations.length === 0) {
      throw new Error("No Google Business locations found on this account.");
    }

    // 4. If multiple locations, show picker
    if (locations.length > 1) {
      // Store tokens in session temporarily, render picker
      req.session.gmb_pending = { accessToken, refreshToken, expiry, salon_id };
      const opts = locations.map(l =>
        `<option value="${l.name}">${l.title}</option>`
      ).join("");
      return res.send(`
        <!DOCTYPE html><html><head><title>Choose Location</title>
        <link rel="stylesheet" href="https://cdn.tailwindcss.com">
        </head><body class="bg-gray-50 flex items-center justify-center min-h-screen">
        <div class="bg-white rounded-2xl border border-gray-200 p-8 max-w-md w-full shadow">
          <h1 class="text-lg font-bold mb-2">Choose Your Business Location</h1>
          <p class="text-sm text-gray-500 mb-4">Select the location to connect to this salon.</p>
          <form method="POST" action="/auth/google/select-location">
            <select name="location_name" class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm mb-4">
              ${opts}
            </select>
            <button type="submit" class="w-full bg-blue-600 text-white rounded-xl py-2 text-sm font-semibold">Connect</button>
          </form>
        </div></body></html>
      `);
    }

    // 5. Single location — save directly
    const location = locations[0];
    await saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location });

    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=connected`);
  } catch (err) {
    console.error("[Google OAuth] Callback error:", err.message);
    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=error`);
  }
});

// ── POST /auth/google/select-location (multi-location picker) ────────────────
router.post("/select-location", async (req, res) => {
  const pending = req.session.gmb_pending;
  if (!pending) return res.redirect("/manager/integrations?gmb=error");

  const { accessToken, refreshToken, expiry, salon_id } = pending;
  const locationName = req.body.location_name;

  try {
    // Fetch title for selected location
    const locResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=name,title`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const location = await locResp.json();

    await saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location });
    delete req.session.gmb_pending;

    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=connected`);
  } catch (err) {
    console.error("[Google OAuth] Select location error:", err.message);
    res.redirect("/manager/integrations?gmb=error");
  }
});

// ── POST /auth/google/disconnect ─────────────────────────────────────────────
router.post("/disconnect", (req, res) => {
  const salon_id = req.session?.salon_id || req.body?.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET
      google_location_id   = NULL,
      google_access_token  = NULL,
      google_refresh_token = NULL,
      google_business_name = NULL,
      google_token_expiry  = NULL,
      gmb_enabled          = 0
    WHERE slug = ?
  `).run(salon_id);

  res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=disconnected`);
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location }) {
  db.prepare(`
    UPDATE salons SET
      google_location_id   = ?,
      google_access_token  = ?,
      google_refresh_token = ?,
      google_business_name = ?,
      google_token_expiry  = ?
    WHERE slug = ?
  `).run(location.name, accessToken, refreshToken, location.title, expiry, salon_id);

  console.log(`[GMB] Connected salon ${salon_id} → ${location.title} (${location.name})`);
}

export default router;
```

**Step 2: Register in server.js**

Find the facebookAuth import line (around line 72):
```js
import facebookAuthRoutes from "./src/routes/facebookAuth.js";
```
Add directly after it:
```js
import googleAuthRoutes from "./src/routes/googleAuth.js";
```

Find where facebookAuth is mounted (search for `app.use.*facebookAuth`):
```js
app.use("/auth/facebook", facebookAuthRoutes);
```
Add directly after it:
```js
app.use("/auth/google", googleAuthRoutes);
```

**Step 3: Add env vars to .env.example or note them**

The following must be added to Render environment:
```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://app.mostlypostly.com/auth/google/callback
```

For staging:
```
GOOGLE_REDIRECT_URI=https://mostlypostly-staging.onrender.com/auth/google/callback
```

**Step 4: Verify the route is reachable**
```bash
node -e "
import('./server.js').then(() => {
  console.log('server OK');
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 | head -5
```
Expected: server starts without import errors

**Step 5: Commit**
```bash
git add src/routes/googleAuth.js server.js
git commit -m "feat: Google OAuth route — connect/disconnect GMB location"
```

---

## Task 4: GMB publisher

**Files:**
- Create: `src/publishers/googleBusiness.js`

**Step 1: Create the publisher**

```js
// src/publishers/googleBusiness.js
import { refreshGmbToken } from "../core/googleTokenRefresh.js";

const GMB_BASE = "https://mybusiness.googleapis.com/v4";
const MAX_CAPTION = 1500;

function truncate(text) {
  if (!text || text.length <= MAX_CAPTION) return text || "";
  return text.slice(0, MAX_CAPTION - 3) + "...";
}

function todayIso() {
  const d = new Date();
  return {
    year:  d.getFullYear(),
    month: d.getMonth() + 1,
    day:   d.getDate(),
  };
}

function dateToGmb(isoDateStr) {
  if (!isoDateStr) return null;
  const d = new Date(isoDateStr);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

async function gmbPost(locationName, body, accessToken) {
  const url = `${GMB_BASE}/${locationName}/localPosts`;
  const resp = await fetch(url, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`[GMB] Post failed (${resp.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Publish a "What's New" (STANDARD) post to Google Business Profile.
 */
export async function publishWhatsNewToGmb(salon, caption, imageUrl) {
  const accessToken = await refreshGmbToken(salon);
  const summary = truncate(caption);

  const body = {
    languageCode: "en-US",
    summary,
    topicType: "STANDARD",
    ...(imageUrl ? {
      media: [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }],
    } : {}),
  };

  const result = await gmbPost(salon.google_location_id, body, accessToken);
  console.log(`[GMB] What's New published for ${salon.slug}: ${result.name}`);
  return { id: result.name };
}

/**
 * Publish an "Offer" post to Google Business Profile.
 * @param {object} offerDetails - { title, startDate (ISO string), endDate (ISO string) }
 */
export async function publishOfferToGmb(salon, caption, imageUrl, offerDetails) {
  const accessToken = await refreshGmbToken(salon);
  const summary = truncate(caption);

  const startDate = todayIso();
  const endDate   = offerDetails.endDate ? dateToGmb(offerDetails.endDate) : startDate;

  const body = {
    languageCode: "en-US",
    summary,
    topicType: "OFFER",
    event: {
      title:    offerDetails.title || salon.name || "Special Offer",
      schedule: {
        startDate,
        endDate,
      },
    },
    offer: {},
    ...(imageUrl ? {
      media: [{ mediaFormat: "PHOTO", sourceUrl: imageUrl }],
    } : {}),
  };

  const result = await gmbPost(salon.google_location_id, body, accessToken);
  console.log(`[GMB] Offer published for ${salon.slug}: ${result.name}`);
  return { id: result.name };
}
```

**Step 2: Verify import**
```bash
node --input-type=module <<'EOF'
import { publishWhatsNewToGmb, publishOfferToGmb } from "./src/publishers/googleBusiness.js";
console.log("publisher import OK");
EOF
```
Expected: `publisher import OK`

**Step 3: Commit**
```bash
git add src/publishers/googleBusiness.js
git commit -m "feat: Google Business Profile publisher (What's New + Offer)"
```

---

## Task 5: Wire GMB into scheduler.js

**Files:**
- Modify: `src/scheduler.js`

**Step 1: Add imports at top of scheduler.js**

Find the existing publisher imports (search for `publishToFacebook`):
```js
import { publishToFacebook, publishToFacebookMulti } from "./publishers/facebook.js";
```
Add after it:
```js
import { publishWhatsNewToGmb, publishOfferToGmb } from "./publishers/googleBusiness.js";
```

**Step 2: Add GMB publish block after the existing FB/IG publish + DB update**

Find the section where `fb_post_id` and `ig_media_id` are saved (around line 460–467 in scheduler.js). After that DB update block, add:

```js
    // ── GMB publish (Growth + Pro, gmb_enabled, connected) ───────────────────
    let gmbResp = null;
    const gmbEligible = ["growth", "pro"].includes(salon.plan)
      && Number(salon.gmb_enabled) === 1
      && salon.google_location_id
      && salon.google_refresh_token;

    if (gmbEligible && !isStoryOnly(postType)) {
      try {
        const isOffer = ["promotions", "vendor_post"].includes(postType);
        if (isOffer) {
          gmbResp = await publishOfferToGmb(salon, igCaption, image, {
            title:   post.product_name || salon.name,
            endDate: post.promotion_expires_at || null,
          });
        } else {
          gmbResp = await publishWhatsNewToGmb(salon, igCaption, image);
        }
        if (gmbResp?.id) {
          db.prepare(`UPDATE posts SET google_post_id = ? WHERE id = ?`)
            .run(gmbResp.id, post.id);
          console.log(`[Scheduler] GMB published for post ${post.id}: ${gmbResp.id}`);
        }
      } catch (gmbErr) {
        // GMB failure does NOT block FB/IG — log and continue
        console.error(`[Scheduler] GMB publish error for post ${post.id}:`, gmbErr.message);
      }
    }
```

**Note on caption variable:** Use `igCaption` (the Instagram-variant caption without booking URL link since GMB doesn't render links in summary). If `igCaption` is not in scope at that point, use `finalCaption` instead — check what variable holds the published caption at the DB save point.

**Step 3: Verify scheduler imports cleanly**
```bash
node --input-type=module -e "
import('./src/scheduler.js').then(() => {
  console.log('scheduler OK');
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `scheduler OK`

**Step 4: Commit**
```bash
git add src/scheduler.js
git commit -m "feat: wire GMB publishing into scheduler (What's New + Offer)"
```

---

## Task 6: GMB insights sync

**Files:**
- Create: `src/core/fetchGmbInsights.js`
- Modify: `src/core/fetchInsights.js` (wire into syncSalonInsights)

**Step 1: Create fetchGmbInsights.js**

```js
// src/core/fetchGmbInsights.js
import db from "../../db.js";
import { refreshGmbToken } from "./googleTokenRefresh.js";

const GMB_BASE = "https://mybusiness.googleapis.com/v4";

/**
 * Sync post-level GMB insights (views + clicks) for all published posts
 * that have a google_post_id.
 */
export async function syncGmbInsights(salon) {
  if (!salon.google_location_id || !salon.google_refresh_token) return { synced: 0 };

  let accessToken;
  try {
    accessToken = await refreshGmbToken(salon);
  } catch (err) {
    console.error(`[GMB Insights] Token refresh failed for ${salon.slug}:`, err.message);
    return { synced: 0, error: err.message };
  }

  // Load posts with google_post_id
  const posts = db.prepare(`
    SELECT id, google_post_id
    FROM posts
    WHERE salon_id = ? AND google_post_id IS NOT NULL AND status = 'published'
    ORDER BY published_at DESC LIMIT 50
  `).all(salon.slug);

  if (posts.length === 0) return { synced: 0 };

  const localPostNames = posts.map(p => p.google_post_id);

  // Batch insights request
  let insightsData;
  try {
    const resp = await fetch(
      `${GMB_BASE}/${salon.google_location_id}/localPosts:reportInsights`,
      {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localPostNames,
          basicMetricsRequest: {
            metricRequests: [
              { metric: "LOCAL_POST_VIEWS_SEARCH" },
              { metric: "LOCAL_POST_ACTIONS_CALL_TO_ACTION" },
            ],
          },
        }),
      }
    );
    insightsData = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(insightsData));
  } catch (err) {
    console.error(`[GMB Insights] reportInsights failed for ${salon.slug}:`, err.message);
    return { synced: 0, error: err.message };
  }

  const postMap = new Map(posts.map(p => [p.google_post_id, p.id]));
  let synced = 0;

  for (const item of insightsData.localPostMetrics || []) {
    const postId = postMap.get(item.localPostName);
    if (!postId) continue;

    const views  = item.metricValues?.find(m => m.metric === "LOCAL_POST_VIEWS_SEARCH")
                    ?.totalValue?.value || 0;
    const clicks = item.metricValues?.find(m => m.metric === "LOCAL_POST_ACTIONS_CALL_TO_ACTION")
                    ?.totalValue?.value || 0;

    db.prepare(`
      INSERT INTO post_insights
        (id, post_id, salon_id, platform, impressions, link_clicks, fetched_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, 'google', ?, ?, datetime('now'))
      ON CONFLICT(post_id, platform) DO UPDATE SET
        impressions  = excluded.impressions,
        link_clicks  = excluded.link_clicks,
        fetched_at   = excluded.fetched_at
    `).run(postId, salon.slug, views, clicks);

    synced++;
  }

  console.log(`[GMB Insights] Synced ${synced} posts for ${salon.slug}`);
  return { synced };
}
```

**Step 2: Wire into syncSalonInsights in fetchInsights.js**

Find `syncSalonInsights` in `src/core/fetchInsights.js`. At the top of the file, add the import:
```js
import { syncGmbInsights } from "./fetchGmbInsights.js";
```

Inside `syncSalonInsights(salon)`, after the existing FB/IG sync completes, add:
```js
  // GMB insights sync
  try {
    await syncGmbInsights(salon);
  } catch (err) {
    console.error("[GMB Insights] sync error:", err.message);
  }
```

**Step 3: Verify import**
```bash
node --input-type=module -e "
import('./src/core/fetchGmbInsights.js').then(() => {
  console.log('fetchGmbInsights OK');
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `fetchGmbInsights OK`

**Step 4: Commit**
```bash
git add src/core/fetchGmbInsights.js src/core/fetchInsights.js
git commit -m "feat: GMB insights sync — post views + clicks via reportInsights API"
```

---

## Task 7: Integrations page redesign

**Files:**
- Modify: `src/routes/integrations.js` (full page redesign — add FB/IG + GMB cards, make all collapsible)
- Modify: `src/routes/admin.js` (remove Facebook/Instagram connection card)

**Step 1: Read the current integrations.js GET handler**

Read `src/routes/integrations.js` lines 29–271 to understand current Zenoti card HTML. You need to keep all Zenoti POST routes untouched — only the GET handler's HTML needs updating.

**Step 2: Replace the GET /manager/integrations HTML**

The page renders three collapsible cards. Each card has:
- Header row: colored status dot + platform name + connected/not-set label + chevron
- Expanded body: platform-specific config

Replace the HTML body inside the GET handler with the following structure (keep all existing Zenoti query/data fetching logic, just restructure the HTML):

```js
// At top of GET handler, add FB/IG salon data:
const fbConnected = !!(salon.facebook_page_id && salon.facebook_page_token);
const gmbConnected = !!(salon.google_location_id && salon.google_refresh_token);
const gmbEligible = ["growth", "pro"].includes(salon.plan);

// Status dot helper:
const dot = (on) => on
  ? `<span style="width:10px;height:10px;border-radius:50%;background:#22C55E;display:inline-block;flex-shrink:0;"></span>`
  : `<span style="width:10px;height:10px;border-radius:50%;background:#D1D5DB;display:inline-block;flex-shrink:0;"></span>`;
```

HTML for the page body:

```html
<h1 class="text-2xl font-bold mb-6">Integrations</h1>

<!-- Success/error banners -->
${req.query.gmb === "connected" ? `<div class="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-xs text-green-800">✅ Google Business Profile connected successfully.</div>` : ""}
${req.query.gmb === "disconnected" ? `<div class="mb-4 rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 text-xs text-yellow-800">Google Business Profile disconnected.</div>` : ""}
${req.query.gmb === "error" ? `<div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">⚠️ Could not connect Google Business Profile. Please try again.</div>` : ""}

<div class="space-y-3 max-w-2xl">

  <!-- ── Facebook & Instagram ── -->
  <details class="rounded-2xl border border-mpBorder bg-white overflow-hidden" ${fbConnected ? "" : ""}>
    <summary class="flex items-center gap-3 px-5 py-4 cursor-pointer select-none list-none">
      ${dot(fbConnected)}
      <span class="flex-1 text-sm font-semibold text-mpCharcoal">Facebook &amp; Instagram</span>
      <span class="text-xs ${fbConnected ? "text-green-600 font-medium" : "text-mpMuted"}">${fbConnected ? "Connected" : "Not set"}</span>
      <svg class="h-4 w-4 text-mpMuted ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </summary>
    <div class="px-5 pb-5 border-t border-mpBorder pt-4 space-y-3">
      ${fbConnected ? `
        <dl class="space-y-1.5 text-xs">
          <div class="flex justify-between"><dt class="text-mpMuted">Facebook Page ID</dt><dd class="text-mpCharcoal font-mono">${safe(salon.facebook_page_id)}</dd></div>
          <div class="flex justify-between"><dt class="text-mpMuted">Instagram Handle</dt><dd class="text-mpCharcoal">${salon.instagram_handle ? "@" + safe(salon.instagram_handle) : "—"}</dd></div>
          <div class="flex justify-between"><dt class="text-mpMuted">Page Token</dt><dd class="text-green-600 font-medium">Stored ✓</dd></div>
          <div class="flex justify-between"><dt class="text-mpMuted">Instagram Business ID</dt><dd class="text-mpCharcoal font-mono">${safe(salon.instagram_business_id) || "—"}</dd></div>
        </dl>
        <a href="/auth/facebook/login?salon=${qs_salon}"
           class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Reconnect Facebook &amp; Instagram
        </a>
      ` : `
        <p class="text-xs text-mpMuted mb-3">Connect Facebook to publish posts and sync Instagram automatically.</p>
        <a href="/auth/facebook/login?salon=${qs_salon}"
           class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Connect Facebook &amp; Instagram
        </a>
      `}
    </div>
  </details>

  <!-- ── Google Business Profile ── -->
  <details class="rounded-2xl border border-mpBorder bg-white overflow-hidden">
    <summary class="flex items-center gap-3 px-5 py-4 cursor-pointer select-none list-none">
      ${dot(gmbConnected)}
      <span class="flex-1 text-sm font-semibold text-mpCharcoal">Google Business Profile</span>
      <span class="text-xs ${gmbConnected ? "text-green-600 font-medium" : "text-mpMuted"}">${gmbConnected ? "Connected" : "Not set"}</span>
      <svg class="h-4 w-4 text-mpMuted ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </summary>
    <div class="px-5 pb-5 border-t border-mpBorder pt-4 space-y-3">
      ${!gmbEligible ? `
        <div class="rounded-xl bg-mpAccentLight border border-mpBorder px-4 py-3 text-xs text-mpAccent">
          Google Business Profile publishing is available on <strong>Growth and Pro plans</strong>.
          <a href="/manager/billing?salon=${qs_salon}" class="underline ml-1">Upgrade →</a>
        </div>
      ` : gmbConnected ? `
        <dl class="space-y-1.5 text-xs">
          <div class="flex justify-between"><dt class="text-mpMuted">Business Name</dt><dd class="text-mpCharcoal font-medium">${safe(salon.google_business_name)}</dd></div>
          <div class="flex justify-between"><dt class="text-mpMuted">Location ID</dt><dd class="text-mpCharcoal font-mono text-[10px]">${safe(salon.google_location_id)}</dd></div>
          <div class="flex justify-between"><dt class="text-mpMuted">Token</dt><dd class="text-green-600 font-medium">Active ✓</dd></div>
        </dl>
        <div class="flex items-center gap-3 pt-1">
          <form method="POST" action="/admin/gmb-toggle?salon=${qs_salon}" class="flex items-center gap-2">
            <label class="text-xs text-mpMuted font-medium">Auto-publish</label>
            <button type="submit" name="enabled" value="${salon.gmb_enabled ? '0' : '1'}"
                    class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${salon.gmb_enabled ? 'bg-mpAccent' : 'bg-gray-200'}">
              <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${salon.gmb_enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
            </button>
            <span class="text-xs ${salon.gmb_enabled ? 'text-mpAccent font-medium' : 'text-mpMuted'}">${salon.gmb_enabled ? 'On' : 'Off'}</span>
          </form>
        </div>
        <div class="flex gap-2 pt-1">
          <a href="/auth/google/login?salon=${qs_salon}"
             class="inline-flex items-center gap-1.5 rounded-full border border-mpBorder bg-white px-4 py-2 text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors">
            Reconnect
          </a>
          <form method="POST" action="/auth/google/disconnect" onsubmit="return confirm('Disconnect Google Business Profile?')">
            <input type="hidden" name="salon_id" value="${qs_salon}">
            <button type="submit" class="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-white px-4 py-2 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors">
              Disconnect
            </button>
          </form>
        </div>
      ` : `
        <p class="text-xs text-mpMuted mb-3">Publish your posts automatically to Google Business Profile alongside Facebook &amp; Instagram.</p>
        <a href="/auth/google/login?salon=${qs_salon}"
           class="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold text-white transition-colors"
           style="background:#4285F4;">
          Connect Google Business Profile
        </a>
      `}
    </div>
  </details>

  <!-- ── Zenoti ── -->
  <!-- Keep existing Zenoti card HTML here, just wrap in <details> with same pattern -->
  <details class="rounded-2xl border border-mpBorder bg-white overflow-hidden" ${zenotiConnected ? "open" : ""}>
    <summary class="flex items-center gap-3 px-5 py-4 cursor-pointer select-none list-none">
      ${dot(zenotiConnected)}
      <span class="flex-1 text-sm font-semibold text-mpCharcoal">Zenoti</span>
      <span class="text-xs ${zenotiConnected ? "text-green-600 font-medium" : "text-mpMuted"}">${zenotiConnected ? "Connected" : "Not set"}</span>
      <svg class="h-4 w-4 text-mpMuted ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
    </summary>
    <div class="px-5 pb-5 border-t border-mpBorder pt-4">
      <!-- PASTE existing Zenoti card content here (lines ~103–221 of current integrations.js GET handler) -->
    </div>
  </details>

</div>
```

**Note on `qs_salon` variable:** At the top of the GET handler, add:
```js
const qs_salon = encodeURIComponent(salon_id);
const zenotiConnected = !!(integration?.api_key);
```

Also add a `safe()` helper at the top of integrations.js if not already present:
```js
const safe = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
```

**Step 3: Add GMB toggle route to admin.js**

In `src/routes/admin.js`, add this POST handler (near other toggle routes):

```js
router.post("/gmb-toggle", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const enabled = req.body.enabled === "1" ? 1 : 0;
  db.prepare(`UPDATE salons SET gmb_enabled = ? WHERE slug = ?`).run(enabled, salon_id);
  res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}`);
});
```

**Step 4: Remove Facebook/Instagram card from admin.js**

In `src/routes/admin.js`, find the Facebook & Instagram connection card (search for `facebook_page_id` in the HTML rendering section). Remove that card entirely. Replace with a link:
```html
<p class="text-xs text-mpMuted">
  Manage platform connections in
  <a href="/manager/integrations?salon=${qs}" class="text-mpAccent underline">Integrations →</a>
</p>
```

**Step 5: Verify page loads**
```bash
node -e "
import('./src/routes/integrations.js').then(() => {
  console.log('integrations OK');
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
"
```
Expected: `integrations OK`

**Step 6: Commit**
```bash
git add src/routes/integrations.js src/routes/admin.js
git commit -m "feat: redesign Integrations page — collapsible FB/IG + GMB + Zenoti cards"
```

---

## Task 8: GMB badge on post cards + analytics dashboard

**Files:**
- Modify: `src/routes/analytics.js`
- Modify: `src/routes/manager.js` (if post cards shown there)
- Modify: `src/routes/dashboard.js` (if separate dashboard route exists)

**Step 1: Read the posts table rendering in analytics.js**

Read `src/routes/analytics.js` around lines 200–400 to find where the posts table rows are rendered. Look for `fb_post_id` or `ig_media_id` references.

**Step 2: Add `google_post_id` to the posts SELECT query**

Find the SQL query that fetches published posts for the analytics table. Add `p.google_post_id` to the SELECT. Example — change:
```js
SELECT p.id, p.fb_post_id, p.ig_media_id, ...
```
to:
```js
SELECT p.id, p.fb_post_id, p.ig_media_id, p.google_post_id, ...
```

Also add to the query joining `post_insights` — add a GMB insights join:
```sql
LEFT JOIN post_insights pig ON pig.post_id = p.id AND pig.platform = 'google'
```
And select: `COALESCE(pig.impressions, 0) AS gmb_views, COALESCE(pig.link_clicks, 0) AS gmb_clicks`

**Step 3: Add GMB badge helper**

Near the existing FB/IG badge helpers in analytics.js, add:

```js
function gmbBadge(post, salonHasGmb) {
  if (!salonHasGmb) return "";
  if (post.google_post_id) {
    // Derive live GMB URL from the location post name
    // Format: accounts/{accountId}/locations/{locationId}/localPosts/{postId}
    const parts = post.google_post_id.split("/");
    const shortId = parts[parts.length - 1];
    return `<a href="https://business.google.com/n/${shortId}" target="_blank" rel="noopener"
               title="View on Google Business Profile"
               style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;background:#4285F4;color:white;font-size:11px;font-weight:700;text-decoration:none;flex-shrink:0;">G</a>`;
  }
  // Enabled but post not on GMB (availability, story, etc.)
  return `<span title="Not published to Google"
                style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;background:#E5E7EB;color:#9CA3AF;font-size:11px;font-weight:700;flex-shrink:0;">G</span>`;
}
```

**Step 4: Render badge in the posts table row**

Find where FB/IG badges are rendered in the posts table. Add `${gmbBadge(post, salon.google_location_id)}` alongside them.

**Step 5: Add GMB summary card at top of analytics page**

Find the summary stat cards section (search for `statCard` calls). Add a GMB card after the existing ones:

```js
${salon.google_location_id ? statCard(
  "GMB Views",
  fmt(gmbViewsThisMonth),
  `${fmt(gmbClicksThisMonth)} clicks`
) : ""}
```

Add the query for `gmbViewsThisMonth` and `gmbClicksThisMonth`:
```js
const gmbStats = db.prepare(`
  SELECT COALESCE(SUM(pi.impressions), 0) AS views,
         COALESCE(SUM(pi.link_clicks), 0) AS clicks
  FROM post_insights pi
  JOIN posts p ON p.id = pi.post_id
  WHERE p.salon_id = ? AND pi.platform = 'google'
    AND p.published_at >= date('now', 'start of month')
`).get(salon_id);
const gmbViewsThisMonth  = gmbStats?.views  || 0;
const gmbClicksThisMonth = gmbStats?.clicks || 0;
```

**Step 6: Add GMB views/clicks columns to posts table**

In the posts table HTML, add columns for GMB views and GMB clicks alongside the existing FB/IG insight columns. Only show if `salon.google_location_id` is set.

**Step 7: Commit**
```bash
git add src/routes/analytics.js
git commit -m "feat: GMB badge on post cards + views/clicks in analytics dashboard"
```

---

## Task 9: Push to dev, smoke test, push to prod

**Step 1: Push to dev**
```bash
git checkout dev
git merge main --no-edit
git push origin dev
```

**Step 2: Add env vars to Render staging**

In Render dashboard → mostlypostly-staging → Environment, add:
```
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
GOOGLE_REDIRECT_URI=https://mostlypostly-staging.onrender.com/auth/google/callback
```

**Step 3: Smoke test on staging**
- [ ] Visit `/manager/integrations` — three collapsible cards render, no errors
- [ ] Click Facebook card — shows existing FB connection details
- [ ] Click GMB card — shows "Connect" button (Starter plan shows upgrade prompt)
- [ ] Switch to a Growth/Pro test account — GMB card shows full connect flow
- [ ] Click "Connect Google Business Profile" — redirects to Google OAuth
- [ ] Complete OAuth — redirected back with green "Connected" banner
- [ ] Toggle auto-publish on — green toggle shows
- [ ] Publish a test post — check logs for `[Scheduler] GMB published`
- [ ] Visit analytics — GMB "G" badge shows on published post
- [ ] Run `/analytics/sync` — check `[GMB Insights]` log lines

**Step 4: Push to prod**
```bash
git checkout main
git merge dev --no-edit
git push origin main
```

Add env vars to Render production:
```
GOOGLE_CLIENT_ID=<same>
GOOGLE_CLIENT_SECRET=<same>
GOOGLE_REDIRECT_URI=https://app.mostlypostly.com/auth/google/callback
```

**Step 5: Update FEATURES.md**
```
FEAT-020 | Google Business Profile Publishing | done
```
