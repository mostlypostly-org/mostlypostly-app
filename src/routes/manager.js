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
import { sendViaTwilio } from "./twilio.js";
import { PLAN_LIMITS } from "./billing.js";
import { translatePostError } from "../core/postErrorTranslator.js";

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

// Placeholder shown when an image URL is broken/expired
const BROKEN_IMG_PLACEHOLDER = `
  onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
`;
function placeholderDiv(cls) {
  return `<div class="${cls} rounded-lg bg-mpBg border border-mpBorder flex-col items-center justify-center gap-1 text-mpMuted" style="display:none">
    <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4-4 4 4 4-6 4 6M4 4h16v16H4z"/></svg>
    <span class="text-[9px] uppercase tracking-wide">Expired</span>
  </div>`;
}

// Render image thumbnail(s) — Twilio URLs served via proxy; expired files show placeholder
function imageStrip(p, thumbClass = "w-32 h-32") {
  let urls = [];
  try { urls = JSON.parse(p.image_urls || "[]"); } catch { }
  if (!urls.length && p.image_url) urls = [p.image_url];
  if (!urls.length) return `<div class="${thumbClass} rounded-lg bg-mpBg border border-mpBorder"></div>`;

  const displayUrls = urls.map(toProxyUrl);

  if (displayUrls.length === 1) {
    return `<div class="relative ${thumbClass} flex-shrink-0">
      <img src="${esc(displayUrls[0])}" class="w-full h-full rounded-lg object-cover border border-mpBorder" ${BROKEN_IMG_PLACEHOLDER} />
      ${placeholderDiv("w-full h-full absolute inset-0")}
    </div>`;
  }

  // Multi-image: horizontal strip with count badge
  const stripThumb = thumbClass.includes("w-32") ? "w-20 h-20" : "w-16 h-16";
  return `
    <div class="flex flex-col gap-1">
      <div class="flex gap-1">
        ${displayUrls.map(u => `
          <div class="relative ${stripThumb} flex-shrink-0">
            <img src="${esc(u)}" class="w-full h-full rounded-lg object-cover border border-mpBorder" ${BROKEN_IMG_PLACEHOLDER} />
            ${placeholderDiv("w-full h-full absolute inset-0")}
          </div>`).join("")}
      </div>
      <span class="text-xs text-mpMuted text-center">${urls.length} photos</span>
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
    salon_id: req.session.salon_id || row.salon_id,
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

  // Plan usage stats + booking URL for approve preview
  const salonRow = db.prepare("SELECT plan, plan_status, booking_url, phone FROM salons WHERE slug = ?").get(salon_id);
  const salonBookingUrl = salonRow?.booking_url || "";
  const planLimits = PLAN_LIMITS[salonRow?.plan] || PLAN_LIMITS.trial;
  const monthStart = DateTime.utc().startOf("month").toFormat("yyyy-LL-dd");
  const postsThisMonth = db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE salon_id = ? AND status = 'published' AND date(published_at) >= ?`
  ).get(salon_id, monthStart)?.n || 0;
  const postLimit = planLimits.posts;
  const postPct = postLimit ? Math.min(100, Math.round((postsThisMonth / postLimit) * 100)) : 0;
  const postBarColor = postPct >= 100 ? "bg-red-400" : postPct >= 80 ? "bg-yellow-400" : "bg-mpAccent";

  // Fetch pending
  const pendingRaw = db
    .prepare(
      `SELECT *
       FROM posts
       WHERE salon_id = ? AND status = 'manager_pending'
       ORDER BY created_at DESC`
    )
    .all(salon_id);

  // Fetch upcoming promotions (approved/queued, scheduled for future)
  const upcomingPromos = db
    .prepare(
      `SELECT *
       FROM posts
       WHERE salon_id = ?
         AND post_type = 'promotions'
         AND status IN ('manager_approved', 'manager_pending')
       ORDER BY COALESCE(scheduled_for, created_at) ASC
       LIMIT 10`
    )
    .all(salon_id);

  // Fetch recent (exclude drafts and pending-approval — those show elsewhere)
  const recentRaw = db
    .prepare(
      `SELECT *
        FROM posts
        WHERE salon_id = ?
          AND status NOT IN ('manager_pending', 'draft', 'cancelled')
        ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(salon_id);

  // Fetch failed posts (need manager attention)
  const failedPosts = db
    .prepare(
      `SELECT * FROM posts WHERE salon_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 10`
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
      ? `<p class="text-mpMuted text-sm">No pending posts.</p>`
      : pending
          .map((p) => {
            const caption = esc(p.final_caption || p.caption || "")
              .replace(/\n/g, "<br/>");

            const isPromo = p.post_type === "promotions";
            const postTypeLabel = esc((p.post_type || "standard_post").replace(/_/g, " "));
            const promoBadge = isPromo
              ? `<span class="inline-flex items-center rounded-full bg-mpAccentLight text-mpAccent text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide">Promotion</span>`
              : "";
            const promoExpiry = isPromo && p.promotion_expires_at
              ? `<p class="text-xs text-mpAccent mt-1">Offer expires: ${esc(p.promotion_expires_at.slice(0,10))}</p>`
              : "";
            const bookingHint = salonBookingUrl
              ? `<p class="text-[11px] text-mpMuted mt-2 border-t border-mpBorder pt-2">Facebook post will include booking link: <span class="font-mono text-mpCharcoal">${esc(salonBookingUrl)}</span></p>`
              : "";

            return `
          <div class="rounded-xl bg-white border border-mpBorder p-5 mb-5">
            <div class="flex gap-4">
              ${imageStrip(p, "w-32 h-32")}

              <div class="flex-1">
                <div class="flex items-center gap-2 mb-1 flex-wrap">
                  <p class="text-xs text-mpMuted">
                    Pending • Post #${esc(p.salon_post_number) || "—"} • <span class="capitalize">${postTypeLabel}</span>
                  </p>
                  ${promoBadge}
                </div>

                ${promoExpiry}

                <p class="text-sm whitespace-pre-line text-mpCharcoal leading-relaxed mt-1">
                  ${caption}
                </p>

                ${bookingHint}

                <div class="flex flex-wrap gap-3 mt-4">

                  <a href="/manager/approve?post=${p.id}"
                     class="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs text-white">
                    Approve
                  </a>

                  <a href="/manager/post-now?post=${p.id}"
                     class="px-3 py-1.5 bg-mpCharcoal hover:bg-mpCharcoalDark rounded text-xs text-white">
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
    ? `<div class="text-mpMuted text-sm italic">No recent posts.</div>`
    : recent.map((p) => {
        const caption = esc(p.final_caption || p.caption || "")
          .replace(/\n/g, "<br/>");

          return `
          <div class="recent-card rounded-xl bg-white border border-mpBorder p-4 mb-4">

            <div class="flex gap-4">
              ${imageStrip(p, "w-24 h-24")}

              <div class="flex-1">

                <div class="flex items-center justify-between gap-2 mb-1">
                  <p class="text-xs text-mpMuted">
                    Status: <span class="font-semibold">${esc(p.status)}</span> • Post #${esc(p.salon_post_number) || "—"}
                  </p>
                  ${p.status === "manager_approved" || p.status === "failed" ? `
                    <a href="/manager/cancel-post?post=${p.id}"
                       onclick="return confirm('Cancel this post and remove it from the queue?')"
                       class="text-[11px] text-red-400 hover:text-red-300 shrink-0">
                      Cancel
                    </a>` : ""}
                </div>
                <p class="text-xs text-mpMuted mb-2">${esc(fmt(p.created_at))}</p>

                <!-- Collapsed Caption -->
                <p class="caption-preview text-sm text-mpMuted leading-relaxed line-clamp-2">
                  ${caption.replace(/<br\/>/g, " ")}
                </p>

                <button type="button" class="show-more-btn text-xs text-blue-400 hover:underline mt-1">Show more</button>

                <!-- Expanded Caption -->
                <div class="full-caption mt-2 text-sm text-mpCharcoal whitespace-pre-line leading-relaxed" style="display:none">
                  ${caption.replace(/<br\/>/g, "\n")}
                </div>

              </div>
            </div>
          </div>
                `;
              }).join("");

  /* -------------------------------------------------------------
     UPCOMING PROMOTIONS SECTION
  ------------------------------------------------------------- */
  const upcomingPromoCards = upcomingPromos.length === 0 ? "" : `
    <h2 class="text-xl font-bold text-mpCharcoal mb-3">Upcoming Promotions</h2>
    <div class="mb-8 space-y-3">
      ${upcomingPromos.map(p => {
        const scheduledLocal = p.scheduled_for
          ? (() => {
              try {
                return DateTime.fromSQL(p.scheduled_for, { zone: "utc" }).toFormat("MMM d, yyyy 'at' h:mm a");
              } catch { return p.scheduled_for; }
            })()
          : null;
        const displayImg = toProxyUrl(p.image_url);
        const isPending = p.status === "manager_pending";
        return `
        <div class="flex items-center gap-4 rounded-xl bg-white border border-mpBorder px-4 py-3">
          ${displayImg
            ? `<img src="${esc(displayImg)}" class="w-14 h-14 rounded-lg object-cover border border-mpBorder flex-shrink-0" />`
            : `<div class="w-14 h-14 rounded-lg bg-mpBg border border-mpBorder flex-shrink-0"></div>`}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5 flex-wrap">
              <span class="inline-flex items-center rounded-full bg-mpAccentLight text-mpAccent text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide">Promotion</span>
              ${isPending ? `<span class="inline-flex items-center rounded-full bg-yellow-100 text-yellow-700 text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide">Awaiting Approval</span>` : `<span class="inline-flex items-center rounded-full bg-blue-50 text-blue-600 text-[10px] font-bold px-2 py-0.5 uppercase tracking-wide">Coming Up</span>`}
            </div>
            <p class="text-sm font-semibold text-mpCharcoal truncate">${esc((p.final_caption || p.base_caption || "Promotion").split("\n")[0])}</p>
            <div class="flex gap-3 text-[11px] text-mpMuted mt-0.5">
              ${scheduledLocal ? `<span>Scheduled: ${scheduledLocal}</span>` : ""}
              ${p.promotion_expires_at ? `<span>· Expires: ${esc(p.promotion_expires_at.slice(0,10))}</span>` : ""}
            </div>
          </div>
          <div class="flex flex-col gap-1.5 shrink-0">
            ${isPending ? `<a href="/manager/approve?post=${p.id}" class="px-3 py-1 bg-green-600 hover:bg-green-700 rounded text-xs text-white text-center">Approve</a>` : ""}
            <a href="/manager/cancel-post?post=${esc(p.id)}"
               onclick="return confirm('Cancel this promotion?')"
               class="px-3 py-1 bg-mpBg hover:bg-red-50 border border-mpBorder rounded text-xs text-red-400 hover:text-red-600 text-center">
              Cancel
            </a>
          </div>
        </div>`;
      }).join("")}
    </div>
  `;

  /* -------------------------------------------------------------
     FAILED POSTS BANNER (Layer 1 + 3)
  ------------------------------------------------------------- */
  const failedBanner = failedPosts.length === 0 ? "" : `
    <div class="mb-6 rounded-xl border border-red-200 bg-red-50 px-5 py-4">
      <div class="flex items-center gap-2 mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        </svg>
        <h3 class="font-bold text-red-700 text-sm">${failedPosts.length} post${failedPosts.length > 1 ? "s" : ""} failed to publish</h3>
      </div>
      ${failedPosts.map(p => {
        const friendlyErr = translatePostError(p.error_message || "");
        const thumb = (() => {
          let urls = [];
          try { urls = JSON.parse(p.image_urls || "[]"); } catch {}
          const u = urls[0] || p.image_url;
          return u ? toProxyUrl(u) : null;
        })();
        return `
        <div class="flex items-start gap-3 py-3 border-t border-red-100">
          ${thumb ? `<img src="${esc(thumb)}" class="w-14 h-14 rounded-lg object-cover shrink-0 bg-red-100" onerror="this.style.display='none'">` : `<div class="w-14 h-14 rounded-lg bg-red-100 shrink-0"></div>`}
          <div class="flex-1 min-w-0">
            <p class="text-xs font-semibold text-red-700 mb-0.5">${esc(p.stylist_name || "Unknown")}</p>
            <p class="text-xs text-red-600 mb-2">${esc(friendlyErr)}</p>
            <div class="flex gap-2">
              <form method="POST" action="/manager/retry-post" class="inline">
                <input type="hidden" name="post_id" value="${esc(p.id)}">
                <button type="submit" class="px-3 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded">
                  Retry
                </button>
              </form>
              <a href="/manager/cancel-post?post=${esc(p.id)}"
                 onclick="return confirm('Remove this failed post?')"
                 class="px-3 py-1 border border-red-200 text-red-500 hover:bg-red-100 text-xs font-semibold rounded">
                Dismiss
              </a>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>
  `;

  /* -------------------------------------------------------------
     PAGE BODY (old layout)
  ------------------------------------------------------------- */
  const body = `
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-2xl font-extrabold text-mpCharcoal">
          Manager Dashboard
        </h1>
        <a href="/manager/promotion/new"
           class="px-4 py-2 bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-semibold rounded-lg text-sm">
          + Create Promotion
        </a>
      </div>
      <p class="text-sm text-mpMuted mb-8">
        Logged in as ${mgrName} (${managerPhone})
      </p>

      <!-- Posts usage bar -->
      <div class="mb-8 rounded-xl border border-mpBorder bg-white px-4 py-3">
        <div class="flex items-center justify-between mb-1.5">
          <p class="text-xs font-semibold text-mpMuted">Posts this month</p>
          <p class="text-xs font-bold text-mpCharcoal">${postsThisMonth} / ${postLimit ?? "∞"}</p>
        </div>
        <div class="w-full bg-gray-100 rounded-full h-2">
          <div class="${postBarColor} h-2 rounded-full transition-all" style="width:${postPct}%"></div>
        </div>
        ${postPct >= 80 ? `
        <p class="mt-1.5 text-xs ${postPct >= 100 ? "text-red-500 font-semibold" : "text-yellow-600"}">
          ${postPct >= 100 ? "Monthly post limit reached." : `${postLimit - postsThisMonth} posts remaining this month.`}
          <a href="/manager/billing" class="underline text-mpAccent ml-1">Upgrade for more →</a>
        </p>` : ""}
      </div>

      ${failedBanner}

      ${upcomingPromoCards}

      <h2 class="text-xl font-bold text-mpCharcoal mb-3">Pending Approval</h2>
      ${pendingCards}

      <h2 class="text-xl font-bold text-mpCharcoal mt-10 mb-3">Recent Activity</h2>
      ${recentCards}

  <script>
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.show-more-btn');
    if (!btn) return;
    var card = btn.closest('.recent-card');
    if (!card) return;
    var full    = card.querySelector('.full-caption');
    var preview = card.querySelector('.caption-preview');
    var showing = full.style.display === 'block';
    full.style.display    = showing ? 'none' : 'block';
    preview.style.display = showing ? ''     : 'none';
    btn.textContent       = showing ? 'Show more' : 'Show less';
  });
  </script>
  `;

  return res.send(
    pageShell({
      title: "Manager Dashboard",
      current: "manager",
      salon_id,
      manager_id: req.manager.id,
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

  // Look up salon settings for notification prefs
  const salonSettings = db.prepare(
    `SELECT notify_on_approval, timezone FROM salons WHERE slug = ?`
  ).get(pendingPost.salon_id);

  // Approve and enqueue (no-op sendText — we handle notifications below)
  await handleManagerApproval(
    req.manager.phone || "dashboard",
    pendingPost,
    async () => {} // suppress built-in SMS — we send below with correct content
  );

  // Notify stylist if setting is enabled and they have a phone
  if (salonSettings?.notify_on_approval && pendingPost.stylist_phone) {
    try {
      // Read scheduled_for set by enqueuePost
      const updated = db.prepare(`SELECT scheduled_for FROM posts WHERE id = ?`).get(pendingPost.id);
      let timeNote = "";
      if (updated?.scheduled_for) {
        const tz = salonSettings.timezone || "America/Indiana/Indianapolis";
        const localTime = DateTime.fromSQL(updated.scheduled_for, { zone: "utc" }).setZone(tz);
        timeNote = ` Scheduled for ${localTime.toFormat("cccc, MMM d 'at' h:mm a")} (${localTime.offsetNameShort}).`;
      }
      await sendViaTwilio(
        pendingPost.stylist_phone,
        `✅ Your post was approved by your manager!${timeNote} It will publish automatically during your salon's posting window.`
      );
    } catch (err) {
      console.error("[Manager] Approval notify failed:", err.message);
    }
  }

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   POST NOW
------------------------------------------------------------- */
router.get("/post-now", requireAuth, (req, res) => {
  const id = req.query.post;
  const salon_id = req.manager.salon_id;

  if (id) {
    db.prepare(`
      UPDATE posts
      SET
        status = 'manager_approved',
        scheduled_for = datetime('now'),
        approved_at = datetime('now','utc')
      WHERE id = ? AND salon_id = ?
    `).run(id, salon_id);
  }

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   CANCEL
------------------------------------------------------------- */
router.get("/cancel", requireAuth, (req, res) => {
  const id = req.query.post;
  const salon_id = req.manager.salon_id;
  if (id) {
    db.prepare(
      `UPDATE posts
       SET status='cancelled',
           updated_at=datetime('now')
       WHERE id=? AND salon_id=?`
    ).run(id, salon_id);
  }
  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   DENY — FORM
------------------------------------------------------------- */
router.get("/cancel-post", requireAuth, (req, res) => {
  const id = req.query.post;
  const salon_id = req.manager.salon_id;
  if (id) {
    db.prepare(
      `UPDATE posts SET status='cancelled', scheduled_for=NULL WHERE id=? AND salon_id=?`
    ).run(id, salon_id);
  }
  return res.redirect(`/manager?salon=${encodeURIComponent(salon_id)}`);
});

/* -------------------------------------------------------------
   RETRY FAILED POST (Layer 4)
------------------------------------------------------------- */
router.post("/retry-post", requireAuth, (req, res) => {
  const { post_id } = req.body;
  const salon_id = req.manager.salon_id;
  if (post_id) {
    const retryAt = DateTime.utc().plus({ minutes: 2 }).toFormat("yyyy-LL-dd HH:mm:ss");
    db.prepare(
      `UPDATE posts
       SET status='manager_approved', retry_count=0, scheduled_for=?, error_message=NULL
       WHERE id=? AND salon_id=? AND status='failed'`
    ).run(retryAt, post_id, salon_id);
  }
  return res.redirect("/manager");
});

router.get("/deny", requireAuth, (req, res) => {
  const id = req.query.post;

  const body = `
    <div class="max-w-md mx-auto bg-white border border-mpBorder rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-mpCharcoal mb-4">Deny Post</h1>

      <form method="POST" action="/manager/deny" class="space-y-4">
        <input type="hidden" name="post_id" value="${esc(id)}" />

        <div>
          <label class="text-xs text-mpMuted">Reason</label>
          <textarea
            name="reason"
            class="w-full p-3 rounded-lg bg-mpBg border border-mpBorder text-mpCharcoal h-32"
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
router.post("/deny", requireAuth, async (req, res) => {
  const { post_id, reason } = req.body;
  const salon_id = req.manager.salon_id;

  const post = db.prepare(`SELECT * FROM posts WHERE id = ? AND salon_id = ?`).get(post_id, salon_id);
  if (!post) return res.redirect("/manager");

  db.prepare(
    `UPDATE posts
     SET status='denied',
         denial_reason=?,
         updated_at=datetime('now')
     WHERE id=? AND salon_id=?`
  ).run((reason || "").trim(), post_id, salon_id);

  // Notify stylist if setting is enabled and they have a phone
  if (post?.stylist_phone) {
    const salonSettings = db.prepare(
      `SELECT notify_on_denial FROM salons WHERE slug = ?`
    ).get(post.salon_id);

    if (salonSettings?.notify_on_denial) {
      try {
        const reasonText = (reason || "").trim();
        const msg = reasonText
          ? `Your post was not approved by your manager. Reason: "${reasonText}". Feel free to send a new photo to try again!`
          : `Your post was not approved by your manager. Feel free to send a new photo to try again!`;
        await sendViaTwilio(post.stylist_phone, msg);
      } catch (err) {
        console.error("[Manager] Denial notify failed:", err.message);
      }
    }
  }

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   EDIT — FORM
------------------------------------------------------------- */
router.get("/edit/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const salon_id = req.manager.salon_id;

  const post = db.prepare(`SELECT * FROM posts WHERE id=? AND salon_id=?`).get(id, salon_id);
  if (!post) return res.redirect("/manager");

  const body = `
    <div class="max-w-lg mx-auto bg-white border border-mpBorder rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-mpCharcoal mb-4">Edit Caption</h1>

      <form method="POST" action="/manager/edit/${id}" class="space-y-4">
        <textarea
          name="caption"
          class="w-full p-3 rounded-lg bg-mpBg border border-mpBorder text-mpCharcoal h-48"
        >${esc(post.final_caption || post.caption || "")}</textarea>

        <button class="w-full bg-mpCharcoal hover:bg-mpCharcoalDark p-3 rounded-lg text-sm font-semibold">
          Save Changes
        </button>
      </form>
        <a href="/manager?salon=${req.manager.salon_id}"
          class="w-full block text-center bg-mpBg hover:bg-white border border-mpBorder p-3 rounded-lg text-sm font-semibold text-mpCharcoal">
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
     WHERE id = ? AND salon_id = ?`
  ).run(cleaned, id, req.manager.salon_id);

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
        <a href="/manager" class="text-mpMuted hover:text-mpCharcoal text-sm">← Dashboard</a>
      </div>

      <div class="bg-white border border-mpBorder rounded-2xl p-6">
        <h1 class="text-xl font-bold text-mpCharcoal mb-1">Create Promotion</h1>
        <p class="text-sm text-mpMuted mb-6">
          Fills automatically as an Instagram Story. Requires manager approval before posting.
        </p>

        <form method="POST" action="/manager/promotion/create" class="space-y-5">

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">
              Product or Service <span class="text-red-400">*</span>
            </label>
            <input name="product" required placeholder="e.g. Balayage, Keratin Treatment, Olaplex"
              class="w-full bg-mpBg border border-mpBorder rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">
              Discount <span class="text-mpMuted font-normal">(optional)</span>
            </label>
            <input name="discount" placeholder="e.g. 20%, $15 off, BOGO"
              class="w-full bg-mpBg border border-mpBorder rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-yellow-500" />
            <p class="text-xs text-mpMuted mt-1">Leave blank if no discount applies.</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">
              Special Text <span class="text-mpMuted font-normal">(optional)</span>
            </label>
            <input name="special_text" placeholder="e.g. Limited time only!, Book before it's gone!"
              class="w-full bg-mpBg border border-mpBorder rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">
              Offer Expiration Date <span class="text-red-400">*</span>
            </label>
            <input type="date" name="expires_at" required
              min="${new Date().toISOString().split("T")[0]}"
              class="w-full bg-mpBg border border-mpBorder rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-yellow-500" />
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">
              Design Style &amp; Mood
              <span class="text-mpMuted font-normal">(optional — guides AI background)</span>
            </label>
            <textarea name="design_context" rows="3"
              placeholder="e.g. Warm rose gold tones, soft bokeh, elegant and feminine. Or: Bold neon accent colors on a dark moody background. Or: Bright and airy, white marble, minimalist luxury."
              class="w-full bg-mpBg border border-mpBorder rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"></textarea>
            <p class="text-xs text-mpMuted mt-1">
              Describe colors, mood, and expression for the AI-generated background image.
              If your salon has a stock photo uploaded, that will be used instead.
            </p>
          </div>

          <div class="pt-2 space-y-3">
            <button type="submit"
              class="w-full bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-bold py-3 rounded-xl text-sm">
              Build &amp; Preview Promotion
            </button>
            <a href="/manager"
              class="block text-center text-mpMuted hover:text-mpCharcoal text-sm py-2">
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

  const { product, discount, special_text, expires_at, design_context } = req.body;

  if (!product?.trim() || !expires_at) {
    return res.redirect("/manager/promotion/new");
  }

  try {
    const fullSalon = getSalonPolicy(salon_id);
    const salonName = fullSalon?.name || fullSalon?.salon_info?.salon_name || "the salon";

    // Build the promotional story image
    const imageUrl = await buildPromotionImage({
      salonId:       salon_id,
      salonName,
      product:       product.trim(),
      discount:      discount?.trim() || null,
      specialText:   special_text?.trim() || null,
      expiresAt:     expires_at,
      designContext: design_context?.trim() || null,
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
