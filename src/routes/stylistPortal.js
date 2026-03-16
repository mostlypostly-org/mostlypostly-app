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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            mpCharcoal: "#2B2D35", mpAccent: "#3B72B9",
            mpAccentLight: "#EBF3FF", mpBg: "#F8FAFC",
            mpBorder: "#E2E8F0", mpMuted: "#6B7280",
          }
        }
      }
    };
  </script>
  <style>
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; background: #F8FAFC; color: #2B2D35; }
  </style>
</head>
<body class="max-w-xl mx-auto px-4 pb-20">
  <header style="padding:14px 0 12px;margin-bottom:20px;border-bottom:1px solid #E2E8F0;">
    <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="height:36px;width:auto;" />
  </header>
  ${body}
</body>
</html>`;
}

function errorPage(msg) {
  return shell("Error", `
    <div class="bg-red-50 border border-red-200 rounded-2xl p-6 text-red-700 text-sm">${esc(msg)}</div>
  `);
}

// Convert Twilio URLs to server-side proxy URLs for browser display
function resolveDisplayUrls(post) {
  // For before/after posts image_urls holds the two originals; image_url is the collage — show the collage
  if (post.post_type === "before_after" && post.image_url) {
    return [post.image_url].map(u =>
      /^https:\/\/api\.twilio\.com/i.test(u)
        ? `/api/media-proxy?url=${encodeURIComponent(u)}`
        : u
    );
  }
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
        <img src="${esc(displayUrls[0])}" class="rounded-2xl w-full max-h-72 object-cover border border-mpBorder" ${BROKEN_PORTAL} />
        <div class="img-expired rounded-2xl w-full h-40 bg-mpBg border border-mpBorder hidden flex-col items-center justify-center gap-2 text-mpMuted">
          <span class="text-sm">Image expired</span>
          <span class="text-xs text-slate-600">Send a new photo to update</span>
        </div>
      </div>`;
  }
  return `
    <div class="flex gap-2 overflow-x-auto mb-2 pb-1">
      ${displayUrls.map(u => `
        <div class="relative w-36 h-36 flex-shrink-0">
          <img src="${esc(u)}" class="w-36 h-36 rounded-2xl object-cover border border-mpBorder" ${BROKEN_PORTAL} />
          <div class="img-expired absolute inset-0 rounded-2xl bg-mpBg border border-mpBorder hidden flex-col items-center justify-center text-mpMuted text-xs">Expired</div>
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
      <div class="bg-white border border-mpBorder rounded-2xl p-8 text-center shadow-sm">
        <div class="text-4xl mb-3">✅</div>
        <p class="text-mpCharcoal font-bold text-lg mb-2">Already submitted!</p>
        <p class="text-mpMuted text-sm">Your post is ${esc(post.status.replace("_", " "))}. Nothing left to do.</p>
      </div>
    `));
  }

  const token = req.query.token;
  const justRegenerated = req.query.regen === "1";
  const justSwapped = req.query.swapped === "1";
  const displayUrls = resolveDisplayUrls(post);

  // Build the locked full-post preview
  let hashtags = [];
  try { hashtags = JSON.parse(post.hashtags || "[]"); } catch { }
  const hashtagLine = hashtags.length ? hashtags.map(h => `#${h.replace(/^#/, "")}`).join(" ") : "";

  res.send(shell("Review Your Caption", `
    <h1 class="text-xl font-bold mb-1 text-mpCharcoal">Your Post Preview</h1>
    <p class="text-sm text-mpMuted mb-5">${post.post_type === "availability"
      ? "Review your availability post below. Update the details if needed, then submit."
      : "Review your caption below. Add notes and regenerate before submitting."}</p>

    ${renderImages(displayUrls)}

    ${justRegenerated ? `<div class="bg-green-50 border border-green-200 rounded-xl px-4 py-2 text-green-700 text-sm mb-4">Caption regenerated with your input!</div>` : ""}
    ${req.query.updated === "1" ? `<div class="bg-green-50 border border-green-200 rounded-xl px-4 py-2 text-green-700 text-sm mb-4">Availability updated!</div>` : ""}
    ${justSwapped ? `<div class="bg-green-50 border border-green-200 rounded-xl px-4 py-2 text-green-700 text-sm mb-4">Before/After positions swapped!</div>` : ""}

    ${post.post_type === "before_after" ? `
    <form method="POST" action="/stylist/${esc(post.id)}/swap?token=${esc(token)}" class="mb-4">
      <button type="submit"
        class="w-full bg-mpBg hover:bg-mpAccentLight border border-mpBorder text-mpCharcoal font-medium py-2.5 rounded-xl text-sm transition-colors">
        ⇄ Swap Before / After
      </button>
    </form>` : ""}

    ${post.post_type === "availability" ? `
    <!-- Availability: no caption, just update option -->
    <div class="bg-white border border-mpBorder rounded-2xl p-4 mb-6 shadow-sm">
      <p class="text-xs font-bold text-mpMuted uppercase tracking-widest mb-2">Availability Details</p>
      <p class="text-sm text-mpCharcoal leading-relaxed whitespace-pre-line">${esc(post.final_caption || post.base_caption || "")}</p>
    </div>

    <form method="POST" action="/stylist/${esc(post.id)}/update-availability?token=${esc(token)}">
      <label class="block text-sm font-semibold text-mpCharcoal mb-1">
        Update availability <span class="text-mpMuted font-normal">(change service type, times, etc.)</span>
      </label>
      <textarea
        name="availability_text"
        rows="3"
        placeholder="e.g. Friday 2pm for haircut, Saturday 10am for color…"
        class="w-full bg-mpBg border border-mpBorder rounded-xl p-3 text-mpCharcoal text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-mpAccent"
      ></textarea>
      <button type="submit"
        class="w-full bg-mpBg hover:bg-mpAccentLight border border-mpBorder text-mpCharcoal font-semibold py-2.5 rounded-xl text-sm mb-5 transition-colors">
        Rebuild Availability Post
      </button>
    </form>` : `
    <!-- Caption preview -->
    <div class="bg-white border border-mpBorder rounded-2xl p-4 mb-6 shadow-sm">
      <p class="text-xs font-bold text-mpMuted uppercase tracking-widest mb-3">Caption Preview</p>
      <p class="text-sm text-mpCharcoal leading-relaxed whitespace-pre-line">${esc(post.base_caption || "")}</p>
      ${hashtagLine ? `<p class="text-sm text-mpAccent mt-3 font-medium">${esc(hashtagLine)}</p>` : ""}
      <p class="text-xs text-mpMuted mt-3">By ${esc(post.stylist_name || "")}</p>
    </div>

    <!-- Regenerate -->
    <form method="POST" action="/stylist/${esc(post.id)}/regenerate?token=${esc(token)}">
      <label class="block text-sm font-semibold text-mpCharcoal mb-1">
        Add your input <span class="text-mpMuted font-normal">(optional)</span>
      </label>
      <textarea
        name="notes"
        rows="3"
        placeholder="e.g. Warm balayage, client wanted natural beach waves…"
        class="w-full bg-mpBg border border-mpBorder rounded-xl p-3 text-mpCharcoal text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-mpAccent"
      ></textarea>
      <button type="submit"
        class="w-full bg-mpBg hover:bg-mpAccentLight border border-mpBorder text-mpCharcoal font-semibold py-2.5 rounded-xl text-sm mb-5 transition-colors">
        Regenerate with AI
      </button>
    </form>`}

    <!-- Submit -->
    <form method="POST" action="/stylist/${esc(post.id)}/submit?token=${esc(token)}">
      <div class="mb-4">
        <label class="block text-sm font-semibold text-mpCharcoal mb-1">
          Add hashtags <span class="text-mpMuted font-normal">(optional, up to 2)</span>
        </label>
        <input type="text" name="extra_hashtags"
          placeholder="#balayage #colorist"
          class="w-full bg-mpBg border border-mpBorder rounded-xl px-3 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-mpAccent" />
        <p class="text-[11px] text-mpMuted mt-1">Space or comma separated. These are added to the post's default hashtags.</p>
      </div>
      <button type="submit"
        class="w-full bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-semibold py-3 rounded-full text-sm transition-colors shadow-sm">
        Submit for Manager Review →
      </button>
    </form>
  `));
});

// -------------------------------------------------------
// POST /:id/swap  — swap Before/After image positions, rebuild collage
// -------------------------------------------------------
router.post("/:id/swap", validateToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send(errorPage("Post not found."));

  const token = req.query.token;

  try {
    let urls = [];
    try { urls = JSON.parse(post.image_urls || "[]"); } catch { }
    if (!urls.length && post.image_url) urls = [post.image_url];

    if (urls.length < 2) {
      return res.redirect(`/stylist/${post.id}?token=${token}`);
    }

    const { buildBeforeAfterCollage } = await import("../core/buildBeforeAfterCollage.js");

    // Flip the order and rebuild
    const [first, second] = urls;
    const flipped = [second, first];
    const collageUrl = await buildBeforeAfterCollage(flipped, post.salon_id);

    // Keep flipped originals in image_urls so future swaps still work
    db.prepare(`
      UPDATE posts
      SET image_url  = ?,
          image_urls = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(collageUrl, JSON.stringify(flipped), post.id);

    return res.redirect(`/stylist/${post.id}?token=${token}&swapped=1`);
  } catch (err) {
    console.error("❌ [Portal] Swap error:", err.message);
    return res.send(shell("Error", `
      <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
        <p class="text-red-700 font-semibold mb-2">Swap failed</p>
        <p class="text-mpMuted text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-mpAccent text-sm underline">Go back</a>
    `));
  }
});

// -------------------------------------------------------
// POST /:id/update-availability  — rebuild availability image with new text
// -------------------------------------------------------
router.post("/:id/update-availability", validateToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send(errorPage("Post not found."));

  const token = req.query.token;
  const availabilityText = (req.body.availability_text || "").trim();

  if (!availabilityText) {
    return res.redirect(`/stylist/${post.id}?token=${token}`);
  }

  try {
    const { buildAvailabilityImage } = await import("../core/buildAvailabilityImage.js");
    const fullSalon = getSalonPolicy(post.salon_id);

    const newImageUrl = await buildAvailabilityImage({
      text: availabilityText,
      stylistName: post.stylist_name || "",
      salonName: fullSalon?.name || "",
      salonId: post.salon_id,
      stylistId: post.stylist_id || null,
      instagramHandle: post.instagram_handle || null,
      bookingCta: fullSalon?.booking_url || "",
    });

    db.prepare(`
      UPDATE posts
      SET image_url     = ?,
          image_urls    = ?,
          final_caption = ?,
          base_caption  = ?,
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(newImageUrl, JSON.stringify([newImageUrl]), availabilityText, availabilityText, post.id);

    return res.redirect(`/stylist/${post.id}?token=${token}&updated=1`);
  } catch (err) {
    console.error("❌ [Portal] update-availability error:", err.message);
    return res.send(shell("Error", `
      <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
        <p class="text-red-700 font-semibold mb-2">Could not rebuild availability post</p>
        <p class="text-mpMuted text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-mpAccent text-sm underline">Go back</a>
    `));
  }
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
        <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
          <p class="text-red-700 font-semibold mb-2">Your notes were flagged</p>
          <p class="text-mpMuted text-sm">Please revise your input and try again.</p>
        </div>
        <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
          class="block text-center text-mpAccent text-sm underline">Go back</a>
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
      <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
        <p class="text-red-700 font-semibold mb-2">Regeneration failed</p>
        <p class="text-mpMuted text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-mpAccent text-sm underline">Try again</a>
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
      <div class="bg-white border border-mpBorder rounded-2xl p-8 text-center shadow-sm">
        <div class="text-4xl mb-3">✅</div>
        <p class="text-mpCharcoal font-bold mb-2">Already submitted!</p>
        <p class="text-mpMuted text-sm">Your post is being reviewed.</p>
      </div>
    `));
  }

  try {
    const fullSalon = getSalonPolicy(post.salon_id);

    // Use the already-saved base_caption + hashtags from the regeneration step.
    // Running AI again here would discard the stylist's curated hashtags.
    let hashtags = [];
    try { hashtags = JSON.parse(post.hashtags || "[]"); } catch { }

    // Merge up to 2 extra hashtags from stylist input; enforce 5-tag total max
    const extraRaw = (req.body.extra_hashtags || "").split(/[,\s]+/)
      .map(t => t.trim().replace(/^#+/, "")).filter(Boolean).slice(0, 2);
    const existing = new Set(hashtags.map(h => h.toLowerCase().replace(/^#/, "")));
    for (const tag of extraRaw) {
      if (!existing.has(tag.toLowerCase()) && hashtags.length < 5) {
        hashtags.push(`#${tag}`);
        existing.add(tag.toLowerCase());
      }
    }

    // Moderation on the existing caption
    const modResult = await moderateAIOutput(
      { caption: post.base_caption || "", hashtags },
      post.base_caption || "",
      { post_id: post.id, salon_id: post.salon_id }
    );

    if (!modResult.safe) {
      return res.send(shell("Content Flagged", `
        <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
          <p class="text-red-700 font-semibold mb-2">Your caption was flagged</p>
          <p class="text-mpMuted text-sm">Please go back and revise your content.</p>
        </div>
        <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
          class="block text-center text-mpAccent text-sm underline">Go back and edit</a>
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
      <div class="bg-white border border-mpBorder rounded-2xl p-10 text-center shadow-sm mt-4">
        <div class="text-5xl mb-4">✅</div>
        <p class="text-mpCharcoal font-extrabold text-xl mb-2">Caption submitted!</p>
        <p class="text-mpMuted text-sm leading-relaxed">Your manager will review and approve it.<br/>You'll be notified when it's posted.</p>
      </div>
    `));

  } catch (err) {
    console.error("❌ [Portal] Submit error:", err.message);
    return res.send(shell("Error", `
      <div class="bg-red-50 border border-red-200 rounded-2xl p-6 mb-4">
        <p class="text-red-700 font-semibold mb-2">Something went wrong</p>
        <p class="text-mpMuted text-sm">${esc(err.message)}</p>
      </div>
      <a href="/stylist/${esc(post.id)}?token=${esc(token)}"
        class="block text-center text-mpAccent text-sm underline">Try again</a>
    `));
  }
});

export default router;
