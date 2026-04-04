# Video Upload Link Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Replace low-quality MMS video path with a keyword-triggered direct upload flow so stylists upload original-quality video from their camera roll.

**Architecture:** Stylist texts "reel" → messageRouter detects intent via `isReelRequest()` → creates `video_upload_tokens` row → sends SMS with 30-min upload link → stylist uploads video + description on a mobile-optimized page → `generateReelCaption` runs → SMS caption preview sent → normal approve/edit flow.

**Tech Stack:** Express, better-sqlite3, multer (video), existing `generateReelCaption` in messageRouter.js, existing `UPLOADS_DIR` from uploadPath.js.

---

### Task 1: Migration — `video_upload_tokens` table

**Files:**
- Create: `migrations/061_video_upload_tokens.js`
- Modify: `migrations/index.js`

**Step 1: Create the migration file**

```js
// migrations/061_video_upload_tokens.js
export function run(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS video_upload_tokens (
      id         TEXT PRIMARY KEY,
      stylist_id TEXT NOT NULL,
      salon_id   TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  console.log("  + video_upload_tokens table");
}
```

**Step 2: Register in migrations/index.js**

Add at the bottom of the imports:
```js
import { run as run061 } from "./061_video_upload_tokens.js";
```

Add at the bottom of the `migrations` array:
```js
{ name: "061_video_upload_tokens", run: run061 },
```

**Step 3: Verify migration runs**

```bash
node -e "import('./db.js').then(({default: db}) => { const row = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='video_upload_tokens'\").get(); console.log(row ? 'OK' : 'MISSING'); })"
```
Expected: `OK`

**Step 4: Commit**

```bash
git add migrations/061_video_upload_tokens.js migrations/index.js
git commit -m "feat(video-upload): add video_upload_tokens migration"
```

---

### Task 2: `isReelRequest()` detection

**Files:**
- Create: `src/core/reelRequest.js`

**Step 1: Create the file**

```js
// src/core/reelRequest.js
// Detects when a stylist wants to post a reel/video via keyword or natural language.

const FAST_PATH = [
  "reel",
  "post reel",
  "post a reel",
  "upload reel",
  "upload video",
  "share a reel",
  "share reel",
  "post my reel",
  "post video",
];

const INTENT_PATTERNS = [
  /i'?d\s+like\s+to\s+(post|share|upload)/i,
  /i\s+want\s+to\s+(post|share|upload)/i,
  /can\s+i\s+(post|upload|share)/i,
  /post\s+my\s+video/i,
  /share\s+my\s+video/i,
];

/**
 * Returns true if the message is a reel upload request.
 * Fast path: exact/substring keyword match.
 * Intent path: regex patterns for natural language variants.
 *
 * @param {string} text - Incoming SMS text
 * @returns {boolean}
 */
export function isReelRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  if (FAST_PATH.some(kw => t === kw || t.includes(kw))) return true;
  return INTENT_PATTERNS.some(re => re.test(t));
}
```

**Step 2: Manually verify a few cases in node REPL**

```bash
node -e "
import('./src/core/reelRequest.js').then(({ isReelRequest }) => {
  console.log(isReelRequest('reel'));                        // true
  console.log(isReelRequest('post a reel'));                 // true
  console.log(isReelRequest(\"i'd like to post a reel\"));  // true
  console.log(isReelRequest('can i upload a video'));        // true
  console.log(isReelRequest('approve'));                     // false
  console.log(isReelRequest('post my availability'));        // false
});
"
```
Expected: `true true true true false false`

**Step 3: Commit**

```bash
git add src/core/reelRequest.js
git commit -m "feat(video-upload): add isReelRequest() keyword + intent detection"
```

---

### Task 3: `videoUpload.js` route (GET + POST)

**Files:**
- Create: `src/routes/videoUpload.js`

This is the upload page stylists open from the SMS link.

**Step 1: Create the route file**

```js
// src/routes/videoUpload.js
import express from "express";
import multer from "multer";
import path from "path";
import { randomBytes } from "node:crypto";
import { db } from "../../db.js";
import { UPLOADS_DIR } from "../core/uploadPath.js";
import { getSalonPolicy } from "../scheduler.js";
import { generateCaption } from "../openai.js";
import { composeFinalCaption } from "../core/composeFinalCaption.js";
import moderateAIOutput from "../utils/moderation.js";
import { sendViaTwilio } from "./twilio.js";

const router = express.Router();

// multer: accept video only, max 200MB, store in UPLOADS_DIR/videos/
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(UPLOADS_DIR, "videos"),
    filename: (_req, file, cb) => {
      cb(null, `${randomBytes(16).toString("hex")}.mp4`);
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Only video files are allowed"));
  },
});

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tokenRow(token) {
  return db.prepare(`
    SELECT * FROM video_upload_tokens
    WHERE token = ? AND used_at IS NULL AND expires_at > datetime('now')
  `).get(token);
}

// ── GET /stylist/upload-video/:token ──────────────────────────────────────────
router.get("/:token", (req, res) => {
  const row = tokenRow(req.params.token);
  if (!row) {
    return res.status(401).send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">
      <h2>Link expired</h2><p>This upload link has expired or already been used. Text REEL to get a new one.</p>
    </body></html>`);
  }

  const stylist = db.prepare("SELECT name FROM stylists WHERE id = ? LIMIT 1").get(row.stylist_id);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload Your Reel – MostlyPostly</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #F8FAFC; color: #2B2D35; min-height: 100vh; }
    .wrap { max-width: 480px; margin: 0 auto; padding: 2rem 1.25rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 0.25rem; }
    p.sub { color: #7A7C85; font-size: 0.9rem; margin-bottom: 1.75rem; }
    label { display: block; font-weight: 600; font-size: 0.875rem; margin-bottom: 0.375rem; }
    .field { margin-bottom: 1.25rem; }
    input[type=file], textarea {
      width: 100%; border: 1px solid #E2E8F0; border-radius: 0.5rem;
      padding: 0.625rem 0.75rem; font-family: inherit; font-size: 0.95rem;
      background: #fff; color: #2B2D35;
    }
    textarea { height: 100px; resize: vertical; }
    button {
      width: 100%; background: #3B72B9; color: #fff; border: none;
      border-radius: 0.5rem; padding: 0.875rem; font-size: 1rem;
      font-weight: 700; font-family: inherit; cursor: pointer;
    }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .note { font-size: 0.8rem; color: #7A7C85; margin-top: 0.5rem; }
    .progress { display: none; margin-top: 1rem; text-align: center; color: #3B72B9; font-weight: 600; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Upload Your Reel</h1>
    <p class="sub">Hi ${esc(stylist?.name || "there")}! Upload your video and describe the look — we'll generate your caption.</p>
    <form id="uploadForm" method="POST" enctype="multipart/form-data">
      <div class="field">
        <label for="video">Video</label>
        <input type="file" id="video" name="video" accept="video/*" required />
        <p class="note">Select from your camera roll for best quality.</p>
      </div>
      <div class="field">
        <label for="description">What's the look? (service, style, vibe)</label>
        <textarea id="description" name="description" placeholder="e.g. Balayage with toner, warm honey tones" required></textarea>
      </div>
      <button type="submit" id="submitBtn">Send for Caption ✨</button>
      <p class="progress" id="progress">Uploading… this may take a moment</p>
    </form>
  </div>
  <script>
    document.getElementById('uploadForm').addEventListener('submit', function() {
      document.getElementById('submitBtn').disabled = true;
      document.getElementById('progress').style.display = 'block';
    });
  </script>
</body>
</html>`);
});

// ── POST /stylist/upload-video/:token ─────────────────────────────────────────
router.post("/:token", videoUpload.single("video"), async (req, res) => {
  const row = tokenRow(req.params.token);
  if (!row) {
    return res.status(401).send("Link expired or already used.");
  }

  if (!req.file) {
    return res.status(400).send("No video file received.");
  }

  const description = (req.body.description || "").trim();
  if (!description) {
    return res.status(400).send("Please include a description of the look.");
  }

  // Mark token used immediately to prevent replay
  db.prepare("UPDATE video_upload_tokens SET used_at = datetime('now') WHERE token = ?")
    .run(req.params.token);

  // Build public URL for the uploaded file
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const videoUrl = `${base}/uploads/videos/${req.file.filename}`;

  // Look up stylist + salon for caption generation
  const stylist = db.prepare("SELECT * FROM stylists WHERE id = ? LIMIT 1").get(row.stylist_id);
  const salon   = db.prepare("SELECT * FROM salons   WHERE slug = ? LIMIT 1").get(row.salon_id);

  if (!stylist || !salon) {
    return res.status(500).send("Could not find your salon account. Please contact your manager.");
  }

  // Send success page immediately — caption generation happens async
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Uploaded! – MostlyPostly</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap" rel="stylesheet" />
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #F8FAFC; color: #2B2D35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { background: #fff; border-radius: 1rem; padding: 2rem; max-width: 400px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    h2 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    p { color: #7A7C85; font-size: 0.95rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:2.5rem;margin-bottom:1rem">✅</div>
    <h2>Video uploaded!</h2>
    <p>We're generating your caption now. You'll receive a text in the next minute — reply APPROVE, EDIT, or REDO.</p>
  </div>
</body>
</html>`);

  // Generate caption + send SMS asynchronously
  try {
    const fullSalon = getSalonPolicy(row.salon_id) || salon;
    const aiJson = await generateCaption({
      imageDataUrl: videoUrl,
      notes: description,
      salon: fullSalon,
      stylist,
      postType: "reel",
      city: stylist.city || "",
    });

    if (moderateAIOutput && typeof moderateAIOutput === "function") {
      const modResult = await moderateAIOutput({ caption: aiJson?.caption || "" }, description);
      if (modResult?.safe === false) {
        await sendViaTwilio(stylist.phone, "Sorry, your caption was flagged. Please try a new upload with a different description.");
        return;
      }
    }

    const caption = composeFinalCaption({
      caption: aiJson?.caption || "",
      hashtags: aiJson?.hashtags || [],
      stylistName: stylist.name || "",
      salon: fullSalon,
      platform: "sms",
    });

    // Save draft post
    const { randomUUID } = await import("node:crypto");
    const postId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO posts (id, salon_id, stylist_name, image_url, base_caption, final_caption, post_type, content_type, placement, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'reel', 'standard_post', 'reel', 'draft', ?)
    `).run(postId, row.salon_id, stylist.name, videoUrl, aiJson?.caption || "", caption, now);

    // Send SMS preview
    const preview = caption.length > 160 ? caption.slice(0, 157) + "…" : caption;
    await sendViaTwilio(stylist.phone,
      `Here's your Reel caption:\n${preview}\n\nReply APPROVE to submit, EDIT <new caption>, or REDO <direction>.`
    );

    // Store draft for approve/edit/redo flow (same in-memory drafts map)
    const { drafts } = await import("./messageRouter.js").catch(() => ({ drafts: null }));
    if (drafts) {
      drafts.set(stylist.phone, {
        postId, salonId: row.salon_id, stylistId: stylist.id,
        caption, imageUrl: videoUrl, postType: "reel",
      });
    }

    console.log(`[VideoUpload] Caption sent to ${stylist.phone} for post ${postId}`);
  } catch (err) {
    console.error("[VideoUpload] Caption generation failed:", err.message);
    await sendViaTwilio(stylist.phone,
      "Sorry, we couldn't generate a caption for your video. Please try uploading again."
    ).catch(() => {});
  }
});

export default router;
```

**Step 2: Commit**

```bash
git add src/routes/videoUpload.js
git commit -m "feat(video-upload): add upload page + POST handler with caption generation"
```

---

### Task 4: Register route in `server.js`

**Files:**
- Modify: `server.js`

**Step 1: Add import near the other stylist route imports**

Find the line:
```js
import stylistPortal from "./src/routes/stylistPortal.js";
```

Add after it:
```js
import videoUploadRoute from "./src/routes/videoUpload.js";
```

**Step 2: Mount the route**

Find:
```js
app.use("/stylist", stylistPortal);
```

Add after it:
```js
app.use("/stylist/upload-video", videoUploadRoute);
```

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat(video-upload): register /stylist/upload-video route"
```

---

### Task 5: Update `messageRouter.js` — MMS path + keyword path

**Files:**
- Modify: `src/core/messageRouter.js`

**Step 1: Add import for `isReelRequest`**

Find the line:
```js
import { isAvailabilityRequest, hasDateHint, parseDateRange } from "./availabilityRequest.js";
```

Add after it:
```js
import { isReelRequest } from "./reelRequest.js";
```

**Step 2: Replace the MMS video block**

Find (around line 1966):
```js
  // -- VIDEO MMS (REEL-01 → REEL-03) --
  if (isVideo && primaryImageUrl) {
    console.log(`[Router] Video MMS detected from ${chatId}`);

    // Guard: salon and stylist must be resolved (same guard as processNewImageFlow)
    if (!salon || !stylist?.salon_info) {
```

Replace the entire MMS video block (from `if (isVideo && primaryImageUrl) {` through its closing `}`) with:

```js
  // -- VIDEO MMS: redirect to direct upload for better quality --
  if (isVideo && primaryImageUrl) {
    console.log(`[Router] Video MMS from ${chatId} — redirecting to upload link`);
    await sendMessage.sendText(chatId,
      "For best quality on TikTok and Instagram, upload your video directly instead of texting it here.\n\nText REEL to get your upload link (expires in 30 min)."
    );
    endTimer(start);
    return;
  }
```

**Step 3: Add reel keyword handler**

Find the availability request block:
```js
  if (!primaryImageUrl && isAvailabilityRequest(cleanText)) {
```

Add before it:
```js
  // -- REEL UPLOAD REQUEST: send direct upload link --
  if (!primaryImageUrl && isReelRequest(cleanText)) {
    if (!salon || !stylist?.salon_info) {
      await sendMessage.sendText(chatId,
        "Sorry, we couldn't identify your salon account. Please contact your manager."
      );
      endTimer(start);
      return;
    }

    const { randomUUID } = await import("node:crypto");
    const { randomBytes } = await import("node:crypto");
    const stylistId = stylist?.id || stylist?.stylist_id;
    const salonId   = salon?.salon_id || salon?.id || salon?.salon_info?.slug;
    const tokenId   = randomUUID();
    const token     = randomBytes(16).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      .replace("T", " ").replace(/\..+$/, "");

    db.prepare(`
      INSERT INTO video_upload_tokens (id, stylist_id, salon_id, token, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenId, stylistId, salonId, token, expiresAt);

    const base = (process.env.PUBLIC_BASE_URL || "https://app.mostlypostly.com").replace(/\/$/, "");
    await sendMessage.sendText(chatId,
      `Here's your upload link (expires in 30 min):\n${base}/stylist/upload-video/${token}\n\nOpen it on your phone, pick your video from your camera roll, and add a description of the look.`
    );

    console.log(`[Router] Reel upload token created for ${chatId}: ${tokenId}`);
    endTimer(start);
    return;
  }
```

**Step 4: Verify the app starts without errors**

```bash
node server.js &
sleep 3
curl -s http://localhost:3000/health | head -c 100
kill %1
```

**Step 5: Commit**

```bash
git add src/core/messageRouter.js
git commit -m "feat(video-upload): replace MMS video path with upload link; add REEL keyword trigger"
```

---

### Task 6: Manual end-to-end test

**Step 1: Test MMS redirect**

Send a video via SMS to the salon number. Expected response:
> "For best quality on TikTok and Instagram, upload your video directly instead of texting it here. Text REEL to get your upload link (expires in 30 min)."

**Step 2: Test keyword trigger**

Text "reel" to the salon number. Expected response:
> "Here's your upload link (expires in 30 min): https://app.mostlypostly.com/stylist/upload-video/{token} — Open it on your phone…"

**Step 3: Test upload page**

Open the link on mobile. Verify:
- Page renders with stylist name
- File picker accepts video
- Description field present
- Submit button works

**Step 4: Test full upload flow**

Upload a video + description. Verify:
- Success page renders immediately
- SMS caption preview arrives within ~30 seconds
- Post appears in DB as `draft` with `post_type = 'reel'`

**Step 5: Test expired token**

Wait 30 min (or manually set `expires_at` to the past in DB) and try the link. Expected: expired page.

**Step 6: Test used token**

Use a link, then try the same URL again. Expected: expired/used page.

**Step 7: Push to main**

```bash
git checkout main && git merge dev && git push origin main
git checkout dev && git merge main && git push origin dev
```
