// src/routes/stylistPortal.js — Stylist caption editing portal
import express from "express";
import { db } from "../../db.js";
import { generateCaption } from "../openai.js";
import { getSalonPolicy } from "../scheduler.js";
import { composeFinalCaption } from "../core/composeFinalCaption.js";
import moderateAIOutput from "../utils/moderation.js";
import { rehostTwilioMedia } from "../utils/rehostTwilioMedia.js";

const router = express.Router();

// -------------------------------------------------------
// Token validation middleware
// -------------------------------------------------------
function validateToken(req, res, next) {
  const token = req.query.token;
  const postId = req.params.id;
  if (!token) return res.status(401).send(errorPage("Missing link token."));

  const row = db.prepare(`
    SELECT * FROM stylist_portal_tokens
    WHERE post_id = ? AND token = ? AND expires_at > datetime('now')
  `).get(postId, token);

  if (!row) return res.status(401).send(errorPage("This link has expired or is invalid. Please send a new photo to get a fresh link."));

  req.portalToken = row;
  next();
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} – MostlyPostly</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { background: #0f172a; color: #f1f5f9; font-family: system-ui, sans-serif; }
  </style>
</head>
<body class="max-w-xl mx-auto px-4 py-6 pb-20">
  <p class="text-xs font-bold tracking-widest text-blue-400 uppercase mb-6">MostlyPostly</p>
  ${body}
</body>
</html>`;
}

function errorPage(msg) {
  return shell("Error", `
    <div class="bg-red-950 border border-red-700 rounded-2xl p-6 text-red-300 text-sm">${esc(msg)}</div>
  `);
}

// Convert Twilio URLs to server-side proxy URLs for browser display
function resolveDisplayUrls(post) {
  let urls = [];
  try { urls = JSON.parse(post.image_urls || "[]"); } catch { }
  if (!urls.length && post.image_url) urls = [post.image_url];
  return urls.map(u =>
    /^https:\/\/api\.twilio\.com/i.test(u)
      ? `/api/media-proxy?url=${encodeURIComponent(u)}`
      : u
  );
}

const BROKEN_PORTAL = `onload="this.parentElement.querySelector('.img-expired').style.display='none'" onerror="this.style.display='none';this.parentElement.querySelector('.img-expired').style.display='flex'"`;

function renderImages(displayUrls) {
  if (!displayUrls.length) return "";
  if (displayUrls.length === 1) {
    return `
      <div class="relative w-full max-h-72 mb-5">
        <img src="${esc(displayUrls[0])}" class="rounded-2xl w-full max-h-72 object-cover border border-slate-800" ${BROKEN_PORTAL} />
        <div class="img-expired rounded-2xl w-full h-40 bg-slate-800 border border-slate-700 hidden flex-col items-center justify-center gap-2 text-slate-500">
          <span class="text-sm">Image expired</span>
          <span class="text-xs text-slate-600">Send a new photo to update</span>
        </div>
      </div>`;
  }
  return `
    <div class="flex gap-2 overflow-x-auto mb-2 pb-1">
      ${displayUrls.map(u => `
        <div class="relative w-36 h-36 flex-shrink-0">
          <img src="${esc(u)}" class="w-36 h-36 rounded-2xl object-cover border border-slate-800" ${BROKEN_PORTAL} />
          <div class="img-expired absolute inset-0 rounded-2xl bg-slate-800 border border-slate-700 hidden flex-col items-center justify-center text-slate-500 text-xs">Expired</div>
        </div>`).join("")}
    </div>
    <p class="text-xs text-slate-500 mb-5">${displayUrls.length} photos · caption applies to all</p>
  `;
}

// -------------------------------------------------------
// GET /:id  — show preview + regenerate form
// -------------------------------------------------------
router.get("/:id", validateToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send(errorPage("Post not found."));

  if (["manager_pending", "manager_approved", "published"].includes(post.status)) {
    return res.send(shell("Already Submitted", `
      <div class="bg-slate-900 border border-slate-700 rounded-2xl p-8 text-center">
        <p class="text-green-400 font-semibold text-lg mb-2">Already submitted!</p>
        <p class="text-slate-400 text-sm">Your post is ${esc(post.status.replace("_", " "))}. Nothing left to do.</p>
      </div>
    `));
  }

  const token = req.query.token;
  const justRegenerated = req.query.regen === "1";
  const displayUrls = resolveDisplayUrls(post);

  // Build the locked full-post preview
  let hashtags = [];
  try { hashtags = JSON.parse(post.hashtags || "[]"); } catch { }
  const hashtagLine = hashtags.length ? hashtags.map(h => `#${h.replace(/^#/, "")}`).join(" ") : "";

  res.send(shell("Review Your Caption", `
    <h1 class="text-xl font-bold mb-1">Your Post Preview</h1>
    <p class="text-sm text-slate-400 mb-5">Review your caption below. Add your own notes and regenerate before submitting.</p>

    ${renderImages(displayUrls)}

    ${justRegenerated ? `<div class="bg-green-900/40 border border-green-700 rounded-xl px-4 py-2 text-green-300 text-sm mb-4">Caption regenerated with your input!</div>` : ""}

    <!-- Current caption preview (locked) -->
    <div class="bg-slate-900 border border-slate-700 rounded-2xl p-4 mb-6">
      <p class="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Current Caption Preview</p>
      <p class="text-sm text-slate-100 leading-relaxed whitespace-pre-line">${esc(post.base_caption || "")}</p>
      ${hashtagLine ? `<p class="text-sm text-blue-400 mt-3">${esc(hashtagLine)}</p>` : ""}
      <p class="text-xs text-slate-500 mt-3">By ${esc(post.stylist_name || "")}</p>
    </div>

    <!-- Regenerate with notes -->
    <form method="POST" action="/stylist/${esc(post.id)}/regenerate?token=${esc(token)}">
      <label class="block text-sm font-medium text-slate-300 mb-1">
        Add your input <span class="text-slate-500 font-normal">(optional — helps AI write a better caption)</span>
      </label>
      <textarea
        name="notes"
        rows="3"
        placeholder="e.g. Warm balayage, client wanted natural beach waves…"
        class="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-slate-100 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
      ></textarea>
      <button type="submit"
        class="w-full bg-slate-700 hover:bg-slate-600 text-white font-medium py-2.5 rounded-xl text-sm mb-6 transition-colors">
        Regenerate with AI
      </button>
    </form>

    <!-- Submit -->
    <form method="POST" action="/stylist/${esc(post.id)}/submit?token=${esc(token)}">
      <button type="submit"
        class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors">
        Submit for Manager Review
      </button>
    </form>
  `));
});

// -------------------------------------------------------
// POST /:id/regenerate  — AI regen with stylist notes, redirect back
// -------------------------------------------------------
router.post("/:id/regenerate", validateToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send(errorPage("Post not found."));

  const notes = (req.body.notes || "").trim();
  const token = req.query.token;

  try {
    const fullSalon = getSalonPolicy(post.salon_id);

    // Rehost image so OpenAI can access it
    const publicImageUrl = await rehostTwilioMedia(post.image_url, post.salon_id).catch(() => post.image_url);

    const aiJson = await generateCaption({
      imageDataUrl: publicImageUrl,
      notes: notes || post.original_notes || "",
      salon: fullSalon,
      stylist: { stylist_name: post.stylist_name, name: post.stylist_name },
      city: fullSalon?.city || "",
    });

    // Moderation check
    const modResult = await moderateAIOutput(
      { caption: aiJson.caption || "", hashtags: aiJson.hashtags || [] },
      notes,
      { post_id: post.id, salon_id: post.salon_id }
    );

    if (!modResult.safe) {
      return res.send(shell("Content Flagged", `
        <div class="bg-red-950 border border-red-700 rounded-2xl p-6 mb-4">
          <p class="text-red-300 font-semibold mb-2">Your notes were flagged</p>
          <p class="text-slate-400 text-sm">Please revise your input and try again.</p>
        </div>
        <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
          class="block text-center text-blue-400 text-sm underline">Go back</a>
      `));
    }

    // Recompose with new caption
    let hashtags = [];
    try { hashtags = aiJson.hashtags || JSON.parse(post.hashtags || "[]"); } catch { }

    const finalCaption = composeFinalCaption({
      caption: aiJson.caption,
      hashtags,
      cta: aiJson.cta || post.cta || "Book via link in bio.",
      instagramHandle: post.instagram_handle || null,
      stylistName: post.stylist_name || "",
      bookingUrl: fullSalon?.booking_url || fullSalon?.booking_link || "",
      salon: fullSalon,
      asHtml: false,
    });

    db.prepare(`
      UPDATE posts
      SET base_caption  = ?,
          final_caption = ?,
          hashtags      = ?,
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(aiJson.caption || notes, finalCaption, JSON.stringify(hashtags), post.id);

    return res.redirect(`/stylist/${post.id}?token=${token}&regen=1`);

  } catch (err) {
    console.error("❌ [Portal] Regenerate error:", err.message);
    return res.send(shell("Error", `
      <div class="bg-red-950 border border-red-700 rounded-2xl p-6 mb-4">
        <p class="text-red-300 font-semibold mb-2">Regeneration failed</p>
        <p class="text-slate-400 text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-blue-400 text-sm underline">Try again</a>
    `));
  }
});

// -------------------------------------------------------
// POST /:id/submit  — submit current caption to manager
// -------------------------------------------------------
router.post("/:id/submit", validateToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send(errorPage("Post not found."));

  const token = req.query.token;

  if (post.status !== "draft") {
    return res.send(shell("Already Submitted", `
      <div class="bg-slate-900 border border-slate-700 rounded-2xl p-8 text-center">
        <p class="text-green-400 font-semibold mb-2">Already submitted!</p>
        <p class="text-slate-400 text-sm">Your post is being reviewed.</p>
      </div>
    `));
  }

  try {
    const fullSalon = getSalonPolicy(post.salon_id);

    // Use the already-saved base_caption + hashtags from the regeneration step.
    // Running AI again here would discard the stylist's curated hashtags.
    let hashtags = [];
    try { hashtags = JSON.parse(post.hashtags || "[]"); } catch { }

    // Moderation on the existing caption
    const modResult = await moderateAIOutput(
      { caption: post.base_caption || "", hashtags },
      post.base_caption || "",
      { post_id: post.id, salon_id: post.salon_id }
    );

    if (!modResult.safe) {
      return res.send(shell("Content Flagged", `
        <div class="bg-red-950 border border-red-700 rounded-2xl p-6 mb-4">
          <p class="text-red-300 font-semibold mb-2">Your caption was flagged</p>
          <p class="text-slate-400 text-sm">Please go back and revise your content.</p>
        </div>
        <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
          class="block text-center text-blue-400 text-sm underline">Go back and edit</a>
      `));
    }

    const finalCaption = composeFinalCaption({
      caption: post.base_caption,
      hashtags,
      cta: post.cta || "Book via link in bio.",
      instagramHandle: post.instagram_handle || null,
      stylistName: post.stylist_name || "",
      bookingUrl: fullSalon?.booking_url || fullSalon?.booking_link || "",
      salon: fullSalon,
      asHtml: false,
    });

    db.prepare(`
      UPDATE posts
      SET final_caption = ?,
          hashtags      = ?,
          status        = 'manager_pending',
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(finalCaption, JSON.stringify(hashtags), post.id);

    db.prepare(`UPDATE stylist_portal_tokens SET used_at = datetime('now') WHERE post_id = ? AND token = ?`)
      .run(post.id, token);

    console.log(`✅ [Portal] Post ${post.id} submitted by ${post.stylist_name} → manager_pending`);

    return res.send(shell("Submitted!", `
      <div class="bg-slate-900 border border-slate-700 rounded-2xl p-8 text-center mt-8">
        <div class="text-5xl mb-4">✅</div>
        <p class="text-white font-bold text-xl mb-2">Caption submitted!</p>
        <p class="text-slate-400 text-sm">Your manager will review and approve it. You'll be notified when it's posted.</p>
      </div>
    `));

  } catch (err) {
    console.error("❌ [Portal] Submit error:", err.message);
    return res.send(shell("Error", `
      <div class="bg-red-950 border border-red-700 rounded-2xl p-6 mb-4">
        <p class="text-red-300 font-semibold mb-2">Something went wrong</p>
        <p class="text-slate-400 text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-blue-400 text-sm underline">Try again</a>
    `));
  }
});

export default router;
