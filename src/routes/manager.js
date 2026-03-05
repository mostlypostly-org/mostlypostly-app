// src/routes/manager.js — Restored MostlyPostly “Old Blue UI” Manager Dashboard
import express from "express";
import crypto from "crypto";
import { db } from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";
import { getSalonName } from "../core/salonLookup.js";
import { handleManagerApproval } from "../core/messageRouter.js";
import { buildPromotionImage } from "../core/buildPromotionImage.js";
import { getSalonPolicy } from "../scheduler.js";

const router = express.Router();

// Escape all HTML special characters, safe for use in attributes and text nodes
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Convert a Twilio URL to a server-side proxy URL for safe browser display
function toProxyUrl(u) {
  if (!u) return u;
  if (/^https:\/\/api\.twilio\.com/i.test(u)) {
    return `/api/media-proxy?url=${encodeURIComponent(u)}`;
  }
  return u;
}

// No-op pass-through — kept for call-site compatibility.
// The scheduler rehosted files are ephemeral on Render; we proxy Twilio URLs
// for display instead of saving to disk.
async function ensurePublicImageUrls(p) {
  return p;
}

// Render image thumbnail(s) — Twilio URLs are served via the media proxy
function imageStrip(p, thumbClass = "w-32 h-32") {
  let urls = [];
  try { urls = JSON.parse(p.image_urls || "[]"); } catch { }
  if (!urls.length && p.image_url) urls = [p.image_url];
  if (!urls.length) return `<div class="${thumbClass} rounded-lg bg-slate-800 border border-slate-700"></div>`;

  const displayUrls = urls.map(toProxyUrl);

  if (displayUrls.length === 1) {
    return `<img src="${esc(displayUrls[0])}" class="${thumbClass} rounded-lg object-cover border border-slate-700" />`;
  }

  // Multi-image: horizontal strip with count badge
  const stripThumb = thumbClass.includes("w-32") ? "w-20 h-20" : "w-16 h-16";
  return `
    <div class="flex flex-col gap-1">
      <div class="flex gap-1">
        ${displayUrls.map(u => `<img src="${esc(u)}" class="${stripThumb} rounded-lg object-cover border border-slate-700" />`).join("")}
      </div>
      <span class="text-xs text-slate-400 text-center">${urls.length} photos</span>
    </div>
  `;
}

/* -------------------------------------------------------------
   AUTH MIDDLEWARE (SESSION ONLY)
------------------------------------------------------------- */
function requireAuth(req, res, next) {
  if (!req.session?.manager_id) {
    return res.redirect("/manager/login");
  }

  const row = db
    .prepare(`SELECT * FROM managers WHERE id = ?`)
    .get(req.session.manager_id);

  if (!row) {
    req.session.manager_id = null;
    return res.redirect("/manager/login");
  }

  req.manager = {
    id: row.id,
    salon_id: row.salon_id,
    phone: row.phone,
    name: row.name || "Manager",
  };

  next();
}

/* -------------------------------------------------------------
   GET /manager — OLD UI restored
------------------------------------------------------------- */
router.get("/", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const managerPhone = req.manager.phone || "";
  const mgrName = req.manager.name || "Manager";

  const salonName = getSalonName(salon_id) || "Your Salon";

  // Fetch pending
  const pendingRaw = db
    .prepare(
      `SELECT *
       FROM posts
       WHERE salon_id = ? AND status = 'manager_pending'
       ORDER BY created_at DESC`
    )
    .all(salon_id);

  // Fetch recent (exclude drafts and pending-approval — those show elsewhere)
  const recentRaw = db
    .prepare(
      `SELECT *
        FROM posts
        WHERE salon_id = ?
          AND status NOT IN ('manager_pending', 'draft')
        ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(salon_id);

  // Rehost any raw Twilio URLs so browsers (Safari) can display them
  const [pending, recent] = await Promise.all([
    Promise.all(pendingRaw.map(p => ensurePublicImageUrls(p))),
    Promise.all(recentRaw.map(p => ensurePublicImageUrls(p))),
  ]);

  const fmt = (iso) => {
    try {
      if (!iso) return "—";
      return DateTime.fromISO(iso, { zone: "utc" }).toFormat(
        "MMM d, yyyy • h:mm a"
      );
    } catch {
      return iso;
    }
  };

  /* -------------------------------------------------------------
     PENDING CARDS — exact original blue MostlyPostly UI
  ------------------------------------------------------------- */
  const pendingCards =
    pending.length === 0
      ? `<p class="text-slate-300 text-sm">No pending posts.</p>`
      : pending
          .map((p) => {
            const caption = esc(p.final_caption || p.caption || "")
              .replace(/\n/g, "<br/>");

            return `
          <div class="rounded-xl bg-slate-900 border border-slate-800 p-5 mb-5">
            <div class="flex gap-4">
              ${imageStrip(p, "w-32 h-32")}

              <div class="flex-1">
                <p class="text-xs text-slate-400 mb-1">
                  Pending • Post #${esc(p.salon_post_number) || "—"} • <span class="capitalize">${esc((p.post_type || "standard_post").replace(/_/g, " "))}</span>
                </p>

                <p class="text-sm whitespace-pre-line text-slate-100 leading-relaxed">
                  ${caption}
                </p>

                <div class="flex flex-wrap gap-3 mt-4">

                  <a href="/manager/approve?post=${p.id}"
                     class="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs text-white">
                    Approve
                  </a>

                  <a href="/manager/post-now?post=${p.id}"
                     class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-xs text-white">
                    Post Now
                  </a>

                  <a href="/manager/edit/${p.id}"
                     class="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 rounded text-xs text-white">
                    Edit
                  </a>

                  <a href="/manager/deny?post=${p.id}"
                     class="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded text-xs text-white">
                    Deny
                  </a>

                </div>
              </div>
            </div>
          </div>
        `;
          })
          .join("");

  /* -------------------------------------------------------------
     RECENT CARDS — exact old simple list
  ------------------------------------------------------------- */
  const recentCards =
  recent.length === 0
    ? `<div class="text-slate-500 text-sm italic">No recent posts.</div>`
    : recent.map((p) => {
        const caption = esc(p.final_caption || p.caption || "")
          .replace(/\n/g, "<br/>");

          return `
          <div class="recent-card rounded-xl bg-slate-900 border border-slate-800 p-4 mb-4">

            <div class="flex gap-4">
              ${imageStrip(p, "w-24 h-24")}

              <div class="flex-1">

                <p class="text-xs text-slate-400">
                  Status: <span class="font-semibold">${esc(p.status)}</span> • Post #${esc(p.salon_post_number) || "—"}
                </p>
                <p class="text-xs text-slate-500 mb-2">${esc(fmt(p.created_at))}</p>

                <!-- Collapsed Caption -->
                <p class="text-sm text-slate-300 leading-relaxed line-clamp-2">
                  ${caption.replace(/<br\/>/g, " ")}
                </p>

                <a href="#" class="text-xs text-blue-400 hover:underline"
                  onclick="this.closest('.recent-card').querySelector('.full-caption').classList.toggle('hidden'); return false;">
                  Show more
                </a>

                <!-- Expanded Caption -->
                <div class="full-caption hidden mt-2 text-sm text-slate-200 whitespace-pre-line leading-relaxed">
                  ${caption}
                </div>

              </div>
            </div>
          </div>
                `;
              }).join("");

  /* -------------------------------------------------------------
     PAGE BODY (old layout)
  ------------------------------------------------------------- */
  const body = `
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-2xl font-bold text-white">
          Manager Dashboard — <span class="text-mpPrimary">${salonName}</span>
        </h1>
        <a href="/manager/promotion/new"
           class="px-4 py-2 bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-semibold rounded-lg text-sm">
          + Create Promotion
        </a>
      </div>
      <p class="text-sm text-slate-400 mb-8">
        Logged in as ${mgrName} (${managerPhone})
      </p>

      <h2 class="text-xl font-semibold mb-3 text-white">Pending Approval</h2>
      ${pendingCards}

      <h2 class="text-xl font-semibold mt-10 mb-3 text-white">Recent Activity</h2>
      ${recentCards}
  `;

  return res.send(
    pageShell({
      title: "Manager Dashboard",
      current: "manager",
      salon_id,
      body,
    })
  );
});

/* -------------------------------------------------------------
   APPROVE
------------------------------------------------------------- */
router.get("/approve", requireAuth, async (req, res) => {
  const id = req.query.post;
  if (!id) return res.redirect("/manager");

  const pendingPost = db.prepare(`
    SELECT *
    FROM posts
    WHERE id = ?
      AND status = 'manager_pending'
  `).get(id);

  if (!pendingPost) {
    console.warn("⚠️ Dashboard approve: post not found or not pending", id);
    return res.redirect("/manager");
  }

  // 🔑 This does EVERYTHING:s
  // - status = manager_approved
  // - scheduled_for = now
  // - stylist notification
  // - scheduler eligibility
  await handleManagerApproval(
    req.manager.phone || "dashboard",
    pendingPost,
    (to, msg) => {
      console.log("📤 Dashboard approval notify:", to);
    }
  );

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   POST NOW
------------------------------------------------------------- */
router.get("/post-now", requireAuth, (req, res) => {
  const id = req.query.post;

  if (id) {
    db.prepare(`
      UPDATE posts
      SET
        status = 'manager_approved',
        scheduled_for = datetime('now'),
        approved_at = datetime('now','utc')
      WHERE id = ?
    `).run(id);
  }

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   CANCEL
------------------------------------------------------------- */
router.get("/cancel", requireAuth, (req, res) => {
  const id = req.query.post;
  if (id) {
    db.prepare(
      `UPDATE posts
       SET status='cancelled',
           updated_at=datetime('now')
       WHERE id=?`
    ).run(id);
  }
  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   DENY — FORM
------------------------------------------------------------- */
router.get("/deny", requireAuth, (req, res) => {
  const id = req.query.post;

  const body = `
    <div class="max-w-md mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-white mb-4">Deny Post</h1>

      <form method="POST" action="/manager/deny" class="space-y-4">
        <input type="hidden" name="post_id" value="${esc(id)}" />

        <div>
          <label class="text-xs text-slate-400">Reason</label>
          <textarea
            name="reason"
            class="w-full p-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 h-32"
            required
          ></textarea>
        </div>

        <button class="w-full bg-red-600 hover:bg-red-700 p-3 rounded-lg text-sm font-semibold">
          Submit Denial
        </button>
      </form>
    </div>
  `;

  res.send(
    pageShell({
      title: "Deny Post",
      body,
      current: "manager",
      salon_id: req.manager.salon_id,
    })
  );
});

/* -------------------------------------------------------------
   DENY — SAVE
------------------------------------------------------------- */
router.post("/deny", requireAuth, (req, res) => {
  const { post_id, reason } = req.body;

  db.prepare(
    `UPDATE posts
     SET status='denied',
         denial_reason=?,
         updated_at=datetime('now')
     WHERE id=?`
  ).run(reason.trim(), post_id);

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   EDIT — FORM
------------------------------------------------------------- */
router.get("/edit/:id", requireAuth, (req, res) => {
  const id = req.params.id;

  const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(id);
  if (!post) return res.redirect("/manager");

  const body = `
    <div class="max-w-lg mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-white mb-4">Edit Caption</h1>

      <form method="POST" action="/manager/edit/${id}" class="space-y-4">
        <textarea
          name="caption"
          class="w-full p-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 h-48"
        >${esc(post.final_caption || post.caption || "")}</textarea>

        <button class="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded-lg text-sm font-semibold">
          Save Changes
        </button>
      </form>
        <a href="/manager?salon=${req.manager.salon_id}"
          class="w-full block text-center bg-slate-700 hover:bg-slate-600 p-3 rounded-lg text-sm font-semibold text-white">
          Cancel
        </a>
    </div>
  `;

  return res.send(
    pageShell({
      title: "Edit Post",
      current: "manager",
      salon_id: req.manager.salon_id,
      body,
    })
  );
});

/* -------------------------------------------------------------
   EDIT — SAVE
------------------------------------------------------------- */
router.post("/edit/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const { caption } = req.body;

  // Normalize caption to prevent spacing expansion issues
  const cleaned = (caption || "")
    .replace(/\r\n/g, "\n")     // Normalize Windows-style newlines
    .replace(/\n{3,}/g, "\n\n") // Collapse 3+ blank lines into 1 blank line
    .trim();

  // Save cleaned caption
  db.prepare(
    `UPDATE posts
     SET final_caption = ?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(cleaned, id);

  // Redirect back to manager for the appropriate salon
  const salonSlug = req.manager?.salon_id || "";
  return res.redirect(`/manager?salon=${salonSlug}`);
});

/* -------------------------------------------------------------
   PROMOTION — FORM
------------------------------------------------------------- */
router.get("/promotion/new", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;

  const body = `
    <div class="max-w-lg mx-auto mt-8">
      <div class="flex items-center gap-3 mb-6">
        <a href="/manager" class="text-slate-400 hover:text-white text-sm">← Dashboard</a>
      </div>

      <div class="bg-slate-900 border border-slate-700 rounded-2xl p-6">
        <h1 class="text-xl font-bold text-white mb-1">Create Promotion</h1>
        <p class="text-sm text-slate-400 mb-6">
          Fills automatically as an Instagram Story. Requires manager approval before posting.
        </p>

        <form method="POST" action="/manager/promotion/create" class="space-y-5">

          <div>
            <label class="block text-sm font-medium text-slate-300 mb-1">
              Product or Service <span class="text-red-400">*</span>
            </label>
            <input name="product" required placeholder="e.g. Balayage, Keratin Treatment, Olaplex"
              class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-300 mb-1">
              Discount <span class="text-slate-500 font-normal">(optional)</span>
            </label>
            <input name="discount" placeholder="e.g. 20%, $15 off, BOGO"
              class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-yellow-500" />
            <p class="text-xs text-slate-500 mt-1">Leave blank if no discount applies.</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-300 mb-1">
              Special Text <span class="text-slate-500 font-normal">(optional)</span>
            </label>
            <input name="special_text" placeholder="e.g. Limited time only!, Book before it's gone!"
              class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div>
            <label class="block text-sm font-medium text-slate-300 mb-1">
              Offer Expiration Date <span class="text-red-400">*</span>
            </label>
            <input type="date" name="expires_at" required
              min="${new Date().toISOString().split("T")[0]}"
              class="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div class="pt-2 space-y-3">
            <button type="submit"
              class="w-full bg-yellow-500 hover:bg-yellow-400 text-slate-900 font-bold py-3 rounded-xl text-sm">
              Build &amp; Preview Promotion
            </button>
            <a href="/manager"
              class="block text-center text-slate-400 hover:text-slate-200 text-sm py-2">
              Cancel
            </a>
          </div>

        </form>
      </div>
    </div>
  `;

  return res.send(pageShell({ title: "Create Promotion", current: "manager", salon_id, body }));
});

/* -------------------------------------------------------------
   PROMOTION — CREATE (POST)
------------------------------------------------------------- */
router.post("/promotion/create", requireAuth, async (req, res) => {
  const salon_id   = req.manager.salon_id;
  const manager_id = req.manager.id;

  const { product, discount, special_text, expires_at } = req.body;

  if (!product?.trim() || !expires_at) {
    return res.redirect("/manager/promotion/new");
  }

  try {
    const fullSalon = getSalonPolicy(salon_id);
    const salonName = fullSalon?.name || fullSalon?.salon_info?.salon_name || "the salon";

    // Build the promotional story image
    const imageUrl = await buildPromotionImage({
      salonId:     salon_id,
      salonName,
      product:     product.trim(),
      discount:    discount?.trim() || null,
      specialText: special_text?.trim() || null,
      expiresAt:   expires_at,
    });

    // Compose a text caption for the post record
    const captionParts = [`${product.trim()} Promotion`];
    if (discount?.trim()) captionParts.push(`${discount.trim()} off`);
    if (special_text?.trim()) captionParts.push(special_text.trim());
    captionParts.push(`Offer expires ${new Date(expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`);
    captionParts.push("Book via link in bio.");
    const caption = captionParts.join(" · ");

    // Assign salon post number
    const numRow = db.prepare(`SELECT MAX(salon_post_number) AS n FROM posts WHERE salon_id = ?`).get(salon_id);
    const salon_post_number = (numRow?.n || 0) + 1;

    // Save directly as manager_pending (manager created it, goes straight to approval queue)
    const postId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO posts (
        id, salon_id, manager_id,
        image_url, image_urls,
        base_caption, final_caption,
        post_type, promotion_expires_at,
        status, salon_post_number,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?,
        ?, ?,
        ?, ?,
        'promotions', ?,
        'manager_pending', ?,
        datetime('now'), datetime('now')
      )
    `).run(
      postId, salon_id, manager_id,
      imageUrl, JSON.stringify([imageUrl]),
      caption, caption,
      expires_at,
      salon_post_number
    );

    console.log(`[Manager] Promotion created: ${postId} for ${salon_id}`);
    return res.redirect("/manager");

  } catch (err) {
    console.error("❌ [Manager] Promotion create failed:", err.message);
    const body = `
      <div class="max-w-lg mx-auto mt-12 bg-red-950 border border-red-700 rounded-2xl p-6 text-red-300">
        <p class="font-semibold mb-2">Failed to build promotion</p>
        <p class="text-sm">${esc(err.message)}</p>
        <a href="/manager/promotion/new" class="block mt-4 text-center text-blue-400 underline text-sm">Try again</a>
      </div>`;
    return res.send(pageShell({ title: "Error", current: "manager", salon_id, body }));
  }
});

export default router;
