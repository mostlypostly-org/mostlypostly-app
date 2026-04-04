// src/routes/videoUpload.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "node:crypto";
import { db } from "../../db.js";
import { UPLOADS_DIR } from "../core/uploadPath.js";
import { getSalonPolicy } from "../scheduler.js";
import { generateCaption } from "../openai.js";
import { composeFinalCaption } from "../core/composeFinalCaption.js";
import moderateAIOutput from "../utils/moderation.js";
import { sendViaTwilio } from "./twilio.js";

const router = express.Router();

// Ensure videos subdirectory exists
const videoDir = path.join(UPLOADS_DIR, "videos");
fs.mkdirSync(videoDir, { recursive: true });

// multer: accept video only, max 200MB, store in UPLOADS_DIR/videos/
const videoUpload = multer({
  storage: multer.diskStorage({
    destination: videoDir,
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
      <button type="submit" id="submitBtn">Send for Caption</button>
      <p class="progress" id="progress">Uploading... this may take a moment</p>
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
    <div style="font-size:2.5rem;margin-bottom:1rem">&#x2705;</div>
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
    const preview = caption.length > 160 ? caption.slice(0, 157) + "..." : caption;
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
