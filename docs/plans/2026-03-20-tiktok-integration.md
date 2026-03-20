# TikTok Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Add TikTok as a publish destination — salons connect via OAuth (Login Kit), approved posts auto-publish as photo posts or Reels via the Content Posting API (Direct Post mode).

**Architecture:** Mirror the existing Google Business Profile OAuth pattern (`googleAuth.js` → `tiktokAuth.js`). Add 6 columns to `salons` + 1 to `posts` via migration 050. Wire publisher into scheduler after the GMB block (non-blocking). Replace the disabled "Coming Soon" card in the integrations page with a live card.

**Tech Stack:** TikTok v2 OAuth (PKCE), TikTok Content Posting API v2, Express, better-sqlite3, Node.js ESM

---

### Task 1: Migration 050 — TikTok DB columns

**Files:**
- Create: `migrations/050_tiktok.js`
- Modify: `migrations/index.js`

**Step 1: Create the migration file**

```js
// migrations/050_tiktok.js
export function run(db) {
  const salonCols = db.prepare(`PRAGMA table_info(salons)`).all().map(c => c.name);
  const postCols  = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);

  if (!salonCols.includes('tiktok_account_id'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_account_id TEXT`).run();
  if (!salonCols.includes('tiktok_username'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_username TEXT`).run();
  if (!salonCols.includes('tiktok_access_token'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_access_token TEXT`).run();
  if (!salonCols.includes('tiktok_refresh_token'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_refresh_token TEXT`).run();
  if (!salonCols.includes('tiktok_token_expiry'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_token_expiry TEXT`).run();
  if (!salonCols.includes('tiktok_enabled'))
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_enabled INTEGER DEFAULT 0`).run();

  if (!postCols.includes('tiktok_post_id'))
    db.prepare(`ALTER TABLE posts ADD COLUMN tiktok_post_id TEXT`).run();

  console.log('[Migration 050] tiktok: added tiktok_* columns to salons + tiktok_post_id to posts');
}
```

**Step 2: Register in migrations/index.js**

Add at the bottom of the imports:
```js
import { run as run050 } from "./050_tiktok.js";
```

Add at the bottom of the `migrations` array:
```js
{ name: "050_tiktok", run: run050 },
```

**Step 3: Verify migration runs on server start**

Start the server locally (`node server.js`) and confirm the log line:
```
[Migration 050] tiktok: added tiktok_* columns to salons + tiktok_post_id to posts
```

Then confirm with SQLite:
```bash
cd mostlypostly-app
node -e "import('./db.js').then(m => { const r = m.db.prepare('PRAGMA table_info(salons)').all(); console.log(r.map(c=>c.name).filter(n=>n.startsWith('tiktok'))); })"
```
Expected: `[ 'tiktok_account_id', 'tiktok_username', 'tiktok_access_token', 'tiktok_refresh_token', 'tiktok_token_expiry', 'tiktok_enabled' ]`

**Step 4: Commit**
```bash
cd mostlypostly-app
git add migrations/050_tiktok.js migrations/index.js
git commit -m "feat: migration 050 — tiktok columns on salons + posts"
```

---

### Task 2: Token refresh helper

**Files:**
- Create: `src/core/tiktokTokenRefresh.js`

**Step 1: Create the file** (mirrors `googleTokenRefresh.js` exactly)

```js
// src/core/tiktokTokenRefresh.js
import { db } from "../../db.js";

/**
 * Returns a valid TikTok access token for the salon.
 * Silently refreshes using the stored refresh token if expired or within 5 min.
 * Updates salons row in place.
 */
export async function refreshTiktokToken(salon) {
  const expiry = salon.tiktok_token_expiry ? new Date(salon.tiktok_token_expiry) : null;
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (expiry && expiry > fiveMinFromNow && salon.tiktok_access_token) {
    return salon.tiktok_access_token;
  }

  if (!salon.tiktok_refresh_token) {
    throw new Error(`[TikTok] No refresh token for salon ${salon.slug}`);
  }

  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
    throw new Error("[TikTok] Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET env vars");
  }

  const params = new URLSearchParams({
    client_key:    process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type:    "refresh_token",
    refresh_token: salon.tiktok_refresh_token,
  });

  const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`[TikTok] Token refresh failed: ${JSON.stringify(data)}`);
  }

  const newExpiry = new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString();

  db.prepare(`
    UPDATE salons SET tiktok_access_token = ?, tiktok_token_expiry = ? WHERE slug = ?
  `).run(data.access_token, newExpiry, salon.slug);

  salon.tiktok_access_token = data.access_token;
  salon.tiktok_token_expiry = newExpiry;

  console.log(`[TikTok] Token refreshed for salon ${salon.slug}, expires ${newExpiry}`);
  return data.access_token;
}
```

**Step 2: Commit**
```bash
git add src/core/tiktokTokenRefresh.js
git commit -m "feat: tiktokTokenRefresh helper"
```

---

### Task 3: Publisher — replace stub

**Files:**
- Modify: `src/publishers/tiktok.js` (full replacement of stub)

**Step 1: Replace the stub with the real publisher**

```js
// src/publishers/tiktok.js
import { refreshTiktokToken } from "../core/tiktokTokenRefresh.js";

const API_BASE = "https://open.tiktokapis.com/v2";

/**
 * Publish a photo post to TikTok.
 * @param {object} salon - Full salon row (needs tiktok_access_token, tiktok_account_id, slug)
 * @param {string[]} imageUrls - Array of 1–35 public image URLs
 * @param {string} caption - Caption text (max 2200 chars)
 * @returns {string} publish_id
 */
export async function publishPhotoToTikTok(salon, imageUrls, caption) {
  const accessToken = await refreshTiktokToken(salon);

  const body = {
    post_info: {
      title:        caption.slice(0, 2200),
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_duet:  false,
      disable_stitch: false,
      disable_comment: false,
      auto_add_music: true,
    },
    source_info: {
      source:      "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: imageUrls.slice(0, 35),
    },
    post_mode:  "DIRECT_POST",
    media_type: "PHOTO",
  };

  const resp = await fetch(`${API_BASE}/post/publish/content/init/`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok || data.error?.code !== "ok") {
    throw new Error(`[TikTok] Photo post failed: ${JSON.stringify(data.error || data)}`);
  }

  const publishId = data.data?.publish_id;
  console.log(`[TikTok] Photo post published for salon ${salon.slug}: ${publishId}`);
  return publishId;
}

/**
 * Publish a video Reel to TikTok.
 * @param {object} salon - Full salon row
 * @param {string} videoUrl - Public URL to the video (mp4/mov)
 * @param {string} caption - Caption text (max 2200 chars)
 * @returns {string} publish_id
 */
export async function publishVideoToTikTok(salon, videoUrl, caption) {
  const accessToken = await refreshTiktokToken(salon);

  const body = {
    post_info: {
      title:         caption.slice(0, 2200),
      privacy_level: "PUBLIC_TO_EVERYONE",
      disable_duet:  false,
      disable_stitch: false,
      disable_comment: false,
    },
    source_info: {
      source:    "PULL_FROM_URL",
      video_url: videoUrl,
    },
    post_mode:  "DIRECT_POST",
    media_type: "VIDEO",
  };

  const resp = await fetch(`${API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok || data.error?.code !== "ok") {
    throw new Error(`[TikTok] Video post failed: ${JSON.stringify(data.error || data)}`);
  }

  const publishId = data.data?.publish_id;
  console.log(`[TikTok] Video post published for salon ${salon.slug}: ${publishId}`);
  return publishId;
}
```

**Step 2: Commit**
```bash
git add src/publishers/tiktok.js
git commit -m "feat: tiktok publisher — photo + video direct post"
```

---

### Task 4: OAuth route

**Files:**
- Create: `src/routes/tiktokAuth.js`

**Step 1: Create the OAuth route**

TikTok v2 OAuth requires PKCE. The `code_verifier` is stored in session during the login redirect and consumed in the callback.

```js
// src/routes/tiktokAuth.js
import express from "express";
import crypto from "crypto";
import { db } from "../../db.js";

function requireAuth(req, res, next) {
  if (!req.session?.manager_id) return res.redirect("/manager/login");
  next();
}

const router = express.Router();

const TIKTOK_AUTH_URL  = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_URL  = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";

// ── GET /auth/tiktok/login ────────────────────────────────────────────────────
router.get("/login", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/login");

  // PKCE
  const codeVerifier  = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  req.session.tiktok_pkce = { codeVerifier, salon_id };

  const params = new URLSearchParams({
    client_key:            process.env.TIKTOK_CLIENT_KEY,
    redirect_uri:          process.env.TIKTOK_REDIRECT_URI,
    response_type:         "code",
    scope:                 "user.info.basic,video.publish,video.upload",
    state:                 JSON.stringify({ salon_id }),
    code_challenge:        codeChallenge,
    code_challenge_method: "S256",
  });

  res.redirect(`${TIKTOK_AUTH_URL}?${params}`);
});

// ── GET /auth/tiktok/callback ─────────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("[TikTok OAuth] Error from TikTok:", error);
    return res.redirect("/manager/integrations?tiktok=error");
  }

  let salon_id;
  try {
    ({ salon_id } = JSON.parse(state));
  } catch {
    return res.redirect("/manager/integrations?tiktok=error");
  }

  const pkce = req.session.tiktok_pkce;
  if (!pkce || pkce.salon_id !== salon_id) {
    console.error("[TikTok OAuth] PKCE session mismatch");
    return res.redirect("/manager/integrations?tiktok=error");
  }
  delete req.session.tiktok_pkce;

  try {
    // 1. Exchange code for tokens
    const tokenResp = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  process.env.TIKTOK_REDIRECT_URI,
        code_verifier: pkce.codeVerifier,
      }).toString(),
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const { access_token, refresh_token, expires_in, open_id } = tokens;
    const expiry = new Date(Date.now() + (expires_in || 86400) * 1000).toISOString();

    // 2. Fetch user display name
    const userResp = await fetch(TIKTOK_USER_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const userData = await userResp.json();
    const username = userData.data?.user?.display_name || open_id;

    // 3. Save to DB
    db.prepare(`
      UPDATE salons SET
        tiktok_account_id    = ?,
        tiktok_username      = ?,
        tiktok_access_token  = ?,
        tiktok_refresh_token = ?,
        tiktok_token_expiry  = ?,
        tiktok_enabled       = 1
      WHERE slug = ?
    `).run(open_id, username, access_token, refresh_token, expiry, salon_id);

    console.log(`[TikTok] Connected salon ${salon_id} → @${username} (${open_id})`);
    res.redirect(`/manager/integrations?tiktok=connected`);

  } catch (err) {
    console.error("[TikTok OAuth] Callback error:", err.message);
    res.redirect("/manager/integrations?tiktok=error");
  }
});

// ── POST /auth/tiktok/disconnect ──────────────────────────────────────────────
router.post("/disconnect", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET
      tiktok_account_id    = NULL,
      tiktok_username      = NULL,
      tiktok_access_token  = NULL,
      tiktok_refresh_token = NULL,
      tiktok_token_expiry  = NULL,
      tiktok_enabled       = 0
    WHERE slug = ?
  `).run(salon_id);

  res.redirect("/manager/integrations?tiktok=disconnected");
});

// ── POST /auth/tiktok/toggle ──────────────────────────────────────────────────
router.post("/toggle", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET tiktok_enabled = CASE WHEN tiktok_enabled = 1 THEN 0 ELSE 1 END
    WHERE slug = ?
  `).run(salon_id);

  res.redirect("/manager/integrations");
});

export default router;
```

**Step 2: Commit**
```bash
git add src/routes/tiktokAuth.js
git commit -m "feat: tiktok OAuth route — login, callback, disconnect, toggle"
```

---

### Task 5: Mount router in server.js

**Files:**
- Modify: `server.js`

**Step 1: Add import** (after the googleAuthRoutes import on line ~73)

```js
import tiktokAuthRoutes from "./src/routes/tiktokAuth.js";
```

**Step 2: Mount the router** (after the google mount on line ~559)

```js
app.use("/auth/tiktok", tiktokAuthRoutes);
```

**Step 3: Add env vars to Render** (not code — reminder)

In Render dashboard, add these 3 env vars to both staging and production:
```
TIKTOK_CLIENT_KEY=<from TikTok Developer Portal>
TIKTOK_CLIENT_SECRET=<from TikTok Developer Portal>
TIKTOK_REDIRECT_URI=https://app.mostlypostly.com/auth/tiktok/callback
```

For staging: use sandbox credentials, `TIKTOK_REDIRECT_URI=https://mostlypostly-staging.onrender.com/auth/tiktok/callback`

**Step 4: Commit**
```bash
git add server.js
git commit -m "feat: mount /auth/tiktok router in server.js"
```

---

### Task 6: Wire TikTok into scheduler

**Files:**
- Modify: `src/scheduler.js`

**Step 1: Add import at top of scheduler.js** (after googleBusiness import, line ~9)

```js
import { publishPhotoToTikTok, publishVideoToTikTok } from "./publishers/tiktok.js";
import { refreshTiktokToken } from "./core/tiktokTokenRefresh.js";
```

**Step 2: Add tiktok columns to getSalonPolicy() SELECT query** (line ~184, after `gmb_enabled`)

```js
tiktok_account_id, tiktok_access_token, tiktok_refresh_token,
tiktok_token_expiry, tiktok_enabled,
```

**Step 3: Add TikTok publish block** — insert after the closing `}` of the GMB block (after line ~611), before the outer catch:

```js
          // --- TikTok publish (independent — does not block FB/IG/GMB) ---
          const tiktokEligible = salon.tiktok_enabled
            && salon.tiktok_access_token
            && salon.tiktok_refresh_token
            && postType !== "availability";   // availability posts are stories — skip

          if (tiktokEligible) {
            try {
              let tiktokPublishId;
              const isVideo = postType === "reel"
                || /\.(mp4|mov|avi|webm)$/i.test(allImages[0] || "");

              if (isVideo) {
                const videoUrl = allImages[0] || post.image_url;
                tiktokPublishId = await publishVideoToTikTok(salon, videoUrl, fbCaption);
              } else {
                tiktokPublishId = await publishPhotoToTikTok(salon, allImages, fbCaption);
              }

              if (tiktokPublishId) {
                db.prepare("UPDATE posts SET tiktok_post_id = ? WHERE id = ?")
                  .run(tiktokPublishId, post.id);
                console.log(`✅ [${post.id}] TikTok published: ${tiktokPublishId}`);
              }
            } catch (tiktokErr) {
              console.error(`⚠️ [${post.id}] TikTok publish failed (FB/IG unaffected):`, tiktokErr.message);
            }
          }
```

**Step 4: Add daily cap check** — find the `getDailyPublishedCounts` function (~line 130) and add TikTok count:

```js
  const tiktok = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND tiktok_post_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, dateStr)?.n || 0;

  return { fb, ig, tiktok };
```

Then in the main publish loop where `fbPostedToday`/`igPostedToday` are initialized, add:
```js
let tiktokPostedToday = counts.tiktok ?? 0;
const tiktokDailyCap  = salon.tiktok_daily_max ?? 3;
```

And add the cap guard before the TikTok eligible block:
```js
          if (tiktokEligible && tiktokPostedToday < tiktokDailyCap) {
```

And increment after successful TikTok publish:
```js
                tiktokPostedToday++;
```

**Step 5: Commit**
```bash
git add src/scheduler.js
git commit -m "feat: wire TikTok publish into scheduler with daily cap"
```

---

### Task 7: Update integrations UI

**Files:**
- Modify: `src/routes/integrations.js`

**Step 1: Add TikTok data to the route handler**

Find where the route handler reads salon data (look for where `gmb_enabled`, `google_business_name` etc. are read). Add:

```js
const tiktokConnected = !!(salon.tiktok_account_id && salon.tiktok_refresh_token);
const tiktokEnabled   = !!salon.tiktok_enabled;
const tiktokUsername  = salon.tiktok_username || "";
```

Also handle flash messages — look for where `req.query.gmb` is checked and add:

```js
const tiktokFlash = req.query.tiktok;
```

Add the flash banner HTML in the flash section (near the gmb flash):
```js
${tiktokFlash === 'connected'    ? `<div class="mb-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">TikTok connected successfully.</div>` : ''}
${tiktokFlash === 'disconnected' ? `<div class="mb-4 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">TikTok disconnected.</div>` : ''}
${tiktokFlash === 'error'        ? `<div class="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">Could not connect TikTok — please try again.</div>` : ''}
```

**Step 2: Replace the Coming Soon card** — find the TikTok "Coming Soon" card (line ~406) and replace the entire `<div>` block with:

```js
    <!-- TikTok -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4">
      <button id="toggle-btn-tiktok" type="button" class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div class="flex items-center gap-3">
          ${statusDot(tiktokConnected)}
          <span class="font-semibold text-mpCharcoal">TikTok</span>
        </div>
        <div class="flex items-center gap-3">
          ${statusLabel(tiktokConnected)}
          ${chevron('tiktok')}
        </div>
      </button>
      <div id="card-tiktok" data-open="${tiktokConnected}" class="border-t border-gray-100 px-6 py-5">
        ${tiktokConnected ? `
          <div class="flex items-center justify-between mb-4">
            <div>
              <p class="text-sm font-medium text-mpCharcoal">@${tiktokUsername}</p>
              <p class="text-xs text-mpMuted mt-0.5">Auto-publishing to TikTok alongside Facebook &amp; Instagram</p>
            </div>
            <form method="POST" action="/auth/tiktok/toggle">
              <button type="submit" class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border transition-colors ${tiktokEnabled
                ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'}">
                ${tiktokEnabled ? 'Enabled' : 'Paused'}
              </button>
            </form>
          </div>
          <form method="POST" action="/auth/tiktok/disconnect">
            <button type="submit" class="text-xs text-red-500 hover:text-red-700 underline">Disconnect TikTok</button>
          </form>
        ` : `
          <p class="text-sm text-mpMuted mb-4">Auto-publish to TikTok alongside Facebook &amp; Instagram.</p>
          <a href="/auth/tiktok/login"
             class="inline-flex items-center gap-2 rounded-xl bg-mpCharcoal hover:bg-mpCharcoalDark text-white text-sm font-semibold px-4 py-2 transition-colors">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.96a8.27 8.27 0 004.85 1.56V7.09a4.84 4.84 0 01-1.09-.4z"/>
            </svg>
            Connect TikTok
          </a>
        `}
      </div>
    </div>
```

**Step 3: Add TikTok to the accordion JS** — find the `DOMContentLoaded` script at the bottom of integrations.js. It initializes accordion toggles by iterating over IDs. TikTok should be included. Look for the list of card IDs (like `['facebook', 'gmb', 'zenoti']`) and add `'tiktok'`.

**Step 4: Commit**
```bash
git add src/routes/integrations.js
git commit -m "feat: live TikTok card in integrations page"
```

---

### Task 8: Unlock scheduler config TikTok input

**Files:**
- Modify: `src/routes/schedulerConfig.js`

**Step 1: Find the TikTok row** (line ~378) — it currently renders a "Coming Soon" badge and is disabled. Replace it with an active daily max input matching the FB/IG input pattern. The handler already accepts and saves `tiktok_daily_max` — only the UI needs to change.

Find the block that looks like:
```html
<!-- TikTok — Coming Soon -->
...Coming Soon badge...
```

Replace with an active input row matching this pattern (look at the `ig_feed_daily_max` row above it for the exact HTML structure):
```html
<!-- TikTok -->
<div class="flex items-center justify-between py-2.5 border-b border-mpBorder">
  <div class="flex items-center gap-3">
    <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
      <svg class="w-4 h-4 text-gray-600" fill="currentColor" viewBox="0 0 24 24">
        <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.96a8.27 8.27 0 004.85 1.56V7.09a4.84 4.84 0 01-1.09-.4z"/>
      </svg>
    </div>
    <div>
      <p class="text-sm font-medium text-mpCharcoal">TikTok</p>
      <p class="text-[11px] text-mpMuted">Max posts per day</p>
    </div>
  </div>
  <input type="number" name="tiktok_daily_max" min="1" max="10"
         value="${salon.tiktok_daily_max ?? 3}"
         class="w-16 rounded-lg border border-mpBorder bg-white px-2 py-1 text-sm text-center text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent">
</div>
```

**Step 2: Commit**
```bash
git add src/routes/schedulerConfig.js
git commit -m "feat: unlock TikTok daily max input in scheduler config"
```

---

### Task 9: Add TikTok error mappings

**Files:**
- Modify: `src/core/postErrorTranslator.js`

**Step 1: Add TikTok entries** — find the error mappings array and add (replacing the existing stub entry):

```js
{ match: /TikTok.*photo post failed.*access_token_invalid/i,
  text: "TikTok access token is invalid. Reconnect TikTok in Integrations." },
{ match: /TikTok.*photo post failed.*spam_risk/i,
  text: "TikTok flagged this post as spam. Try again later." },
{ match: /TikTok.*video post failed/i,
  text: "TikTok video post failed. Check that the video URL is publicly accessible." },
{ match: /TikTok.*photo post failed/i,
  text: "TikTok photo post failed. The image may be inaccessible or too large." },
{ match: /TikTok publishing not yet available/i,
  text: "TikTok publishing is coming soon — not yet available." },
```

**Step 2: Commit**
```bash
git add src/core/postErrorTranslator.js
git commit -m "feat: tiktok error translations in postErrorTranslator"
```

---

### Task 10: Manual end-to-end test

This is a manual verification checklist — no code to write.

**Pre-flight:**
- [ ] Set `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` in Render staging
- [ ] Confirm TikTok Developer Portal redirect URI matches `TIKTOK_REDIRECT_URI`
- [ ] Deploy staging (`git push origin dev`)

**Connect flow:**
- [ ] Log into staging as Studio 500
- [ ] Go to Integrations → TikTok card is visible and not disabled
- [ ] Click "Connect TikTok" → redirects to TikTok OAuth page
- [ ] Authorize in TikTok sandbox → redirects back to `/manager/integrations?tiktok=connected`
- [ ] Green banner "TikTok connected successfully" shown
- [ ] TikTok card shows `@username` and "Enabled" toggle

**Toggle / disconnect:**
- [ ] Click "Paused" toggle → card shows "Paused", DB `tiktok_enabled=0`
- [ ] Click again → re-enabled
- [ ] Click "Disconnect TikTok" → redirects, grey banner, card shows "Connect TikTok"

**Post publish:**
- [ ] Approve a photo post in Studio 500 queue
- [ ] Wait for scheduler tick (or trigger manually via schedulerTest)
- [ ] Confirm `tiktok_post_id` set on post row in DB
- [ ] Confirm post appears in TikTok sandbox account

**Scheduler config:**
- [ ] Go to Admin → Scheduler → TikTok daily max input visible and editable
- [ ] Set to 2, save, confirm `tiktok_daily_max=2` in DB

---

### Task 11: Update CLAUDE.md and FEATURES.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `FEATURES.md`

**Step 1: Add TikTok columns to the `salons` schema table in CLAUDE.md** (after the `gmb_enabled` row):

```markdown
| tiktok_account_id | TEXT | TikTok open_id (migration 050) |
| tiktok_username | TEXT | Display username (migration 050) |
| tiktok_access_token | TEXT | Short-lived (24h), refreshed before publish (migration 050) |
| tiktok_refresh_token | TEXT | Long-lived (365 days) (migration 050) |
| tiktok_token_expiry | TEXT | ISO datetime (migration 050) |
| tiktok_enabled | INTEGER | 0/1 salon-level toggle (migration 050) |
```

**Step 2: Add `tiktok_post_id` to the `posts` schema table** (after `google_post_id`):

```markdown
| tiktok_post_id | Set after successful TikTok publish (migration 050) |
```

**Step 3: Add new files to Key Source Files tables:**

Routes:
```markdown
| `src/routes/tiktokAuth.js` | TikTok OAuth flow — login, callback, disconnect, toggle |
```

Core Logic:
```markdown
| `src/core/tiktokTokenRefresh.js` | `refreshTiktokToken(salon)` — silently refreshes TikTok access token if expired |
```

Publishers:
```markdown
| `src/publishers/tiktok.js` | TikTok Content Posting API — `publishPhotoToTikTok()` and `publishVideoToTikTok()` |
```

**Step 4: Add env vars to the Environment Variables section:**
```markdown
# TikTok (Content Posting API + Login Kit)
TIKTOK_CLIENT_KEY=        # client_key from TikTok Developer Portal
TIKTOK_CLIENT_SECRET=     # client_secret from TikTok Developer Portal
TIKTOK_REDIRECT_URI=      # https://app.mostlypostly.com/auth/tiktok/callback
```

**Step 5: Update FEATURES.md** — set FEAT-023 status to `done`.

**Step 6: Commit**
```bash
git add CLAUDE.md FEATURES.md
git commit -m "docs: update CLAUDE.md and FEATURES.md for TikTok integration"
```
