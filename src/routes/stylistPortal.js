import express from "express";
import crypto from "crypto";
import { db } from "../../db.js";
import { generateCaption } from "../openai.js";
import { getSalonById } from "../core/salonLookup.js";

const router = express.Router();

// Validate token middleware
function validateStylistToken(req, res, next) {
  const token = req.query.token;
  const postId = req.params.id;

  if (!token) return res.status(401).send("Missing token");

  const row = db
    .prepare(
      `SELECT * FROM stylist_portal_tokens 
       WHERE post_id = ? AND token = ? 
       AND (expires_at > datetime('now'))`
    )
    .get(postId, token);

  if (!row) return res.status(401).send("Invalid or expired token");

  req.portal = row;
  next();
}

// GET → load page
router.get("/:id", validateStylistToken, (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).send("Post not found");

  const salon = getSalonById(post.salon_id);

  return res.send(`
    <!DOCTYPE html>
    <html class="bg-slate-950 text-slate-50">
    <head>
      <meta charset="utf-8" />
      <title>Edit Post – MostlyPostly</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="max-w-xl mx-auto p-6">

      <h1 class="text-2xl font-bold mb-4">Edit Post</h1>

      ${(() => {
        let urls = [];
        try { urls = JSON.parse(post.image_urls || "[]"); } catch { }
        if (!urls.length && post.image_url) urls = [post.image_url];
        if (urls.length <= 1) {
          return `<img src="${urls[0] || ""}" class="rounded-xl w-full mb-4" />`;
        }
        return `
          <div class="flex gap-2 mb-4 overflow-x-auto">
            ${urls.map(u => `<img src="${u}" class="w-32 h-32 rounded-xl object-cover border border-slate-700 flex-shrink-0" />`).join("")}
          </div>
          <p class="text-xs text-slate-400 mb-4">${urls.length} photos — caption applies to all</p>
        `;
      })()}

      <form method="POST" action="/stylist/${post.id}/update?token=${req.query.token}">
        <textarea name="caption" class="w-full bg-slate-900 p-3 rounded-xl border border-slate-700 h-40 mb-4">${post.final_caption}</textarea>

        <button 
          formaction="/stylist/${post.id}/regenerate?token=${req.query.token}"
          class="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 mr-2">Regenerate</button>

        <button 
          class="px-3 py-2 rounded-lg bg-blue-600 text-white">Save & Approve</button>
      </form>
    </body>
    </html>
  `);
});

// POST → Save & Approve
router.post("/:id/update", validateStylistToken, (req, res) => {
  const newCap = req.body.caption || "";
  const postId = req.params.id;

  db.prepare(`
    UPDATE posts
    SET final_caption = ?, status = 'manager_pending'
    WHERE id = ?
  `).run(newCap, postId);

  return res.send(`<p>Saved! Your manager will review it shortly.</p>`);
});

// POST → Regenerate using AI
router.post("/:id/regenerate", validateStylistToken, async (req, res) => {
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(req.params.id);

  const ai = await generateCaption({
    imageUrl: post.image_url,
    prompt: "Rewrite caption with stylist’s notes.",
  });

  const regenerated = ai.caption;
  db.prepare(`UPDATE posts SET final_caption=? WHERE id=?`)
    .run(regenerated, post.id);

  return res.redirect(`/stylist/${post.id}?token=${req.query.token}`);
});

export default router;
