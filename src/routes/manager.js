// src/routes/manager.js — Restored MostlyPostly "Old Blue UI" Manager Dashboard
import express from "express";
import crypto from "crypto";
import path from "path";
import { renameSync, readFileSync } from "fs";
import multer from "multer";
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
import { savePost } from "../core/storage.js";
import { UPLOADS_DIR, toUploadUrl } from "../core/uploadPath.js";
import { requireRole } from "../middleware/auth.js";
import { getDefaultPlacement, getPlatformReach, deriveFromPostType } from "../core/contentType.js";
import { getSystemPlacementRouting, mergePlacementRouting } from "../core/placementRouting.js";

// Multer config for coordinator photo uploads
const coordinatorUpload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only images are allowed"));
  },
});

const router = express.Router();

const CONTENT_TYPE_OPTIONS = [
  { value: "standard_post", label: "Standard Post" },
  { value: "before_after", label: "Before & After" },
  { value: "education", label: "Education / Tutorial" },
  { value: "vendor_product", label: "Vendor Product" },
  { value: "vendor_promotion", label: "Vendor Promotion" },
  { value: "reviews", label: "Review" },
  { value: "celebration", label: "Celebration" },
  { value: "stylist_availability", label: "Stylist Availability" },
];

const VALID_CONTENT_TYPES = new Set([
  "standard_post", "before_after", "education", "vendor_product",
  "vendor_promotion", "reviews", "celebration", "stylist_availability",
]);
const VALID_PLACEMENTS = new Set(["story", "post", "reel"]);

const PLATFORM_LABELS = {
  instagram: "Instagram",
  facebook: "Facebook",
  gmb: "Google Business",
  tiktok: "TikTok",
};

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
// Uses CSS class + event delegation (no inline onerror — blocked by CSP script-src-attr 'none')
const BROKEN_IMG_PLACEHOLDER = `class-broken-img`; // sentinel — appended to img class string
function placeholderDiv(cls) {
  return `<div class="${cls} broken-placeholder rounded-lg bg-mpBg border border-mpBorder flex-col items-center justify-center gap-1 text-mpMuted" style="display:none">
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

  // Reel posts: render video thumbnail
  if (p.post_type === "reel") {
    const videoUrl = urls[0];
    return `<div class="relative ${thumbClass} flex-shrink-0">
      <video src="${esc(videoUrl)}" class="w-full h-full rounded-lg object-cover border border-mpBorder" muted playsinline preload="metadata"></video>
      <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div class="w-8 h-8 rounded-full bg-black/50 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>
    </div>`;
  }

  const displayUrls = urls.map(toProxyUrl);

  if (displayUrls.length === 1) {
    return `<div class="img-zoomable relative ${thumbClass} flex-shrink-0 cursor-zoom-in group" data-img="${esc(displayUrls[0])}">
      <img src="${esc(displayUrls[0])}" class="w-full h-full rounded-lg object-cover border border-mpBorder pointer-events-none" />
      ${placeholderDiv("w-full h-full absolute inset-0")}
      <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 rounded-lg pointer-events-none">
        <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6 text-white drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0zM11 8v6M8 11h6"/>
        </svg>
      </div>
    </div>`;
  }

  // Multi-image: horizontal strip with count badge
  const stripThumb = thumbClass.includes("w-32") ? "w-20 h-20" : "w-16 h-16";
  return `
    <div class="flex flex-col gap-1">
      <div class="flex gap-1">
        ${displayUrls.map(u => `
          <div class="img-zoomable relative ${stripThumb} flex-shrink-0 cursor-zoom-in group" data-img="${esc(u)}">
            <img src="${esc(u)}" class="w-full h-full rounded-lg object-cover border border-mpBorder pointer-events-none" ${BROKEN_IMG_PLACEHOLDER} />
            ${placeholderDiv("w-full h-full absolute inset-0")}
            <div class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20 rounded-lg pointer-events-none">
              <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 text-white drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0zM11 8v6M8 11h6"/>
              </svg>
            </div>
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
    role: row.role,
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
  const salonRow = db.prepare("SELECT plan, plan_status, booking_url, phone, google_location_id, timezone FROM salons WHERE slug = ?").get(salon_id);
  const salonBookingUrl = salonRow?.booking_url || "";
  const tz = salonRow?.timezone || "America/Indiana/Indianapolis";
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

  // Fetch recent (exclude drafts and pending-approval — those show elsewhere; capped to 14 days)
  const recentRaw = db
    .prepare(
      `SELECT *
        FROM posts
        WHERE salon_id = ?
          AND status NOT IN ('manager_pending', 'draft', 'cancelled')
          AND datetime(created_at) >= datetime('now', '-14 days')
        ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(salon_id);
  const reelsInRecent = recentRaw.filter(p => p.post_type === 'reel');
  const reelsTotal = db.prepare("SELECT id, status, created_at, salon_id FROM posts WHERE salon_id = ? AND post_type = 'reel' ORDER BY created_at DESC LIMIT 5").all(salon_id);
  console.log(`[Dashboard] salon=${salon_id} recent=${recentRaw.length} reels_in_recent=${reelsInRecent.length} all_reels:`, JSON.stringify(reelsTotal));

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
      // SQLite stores datetimes as "YYYY-MM-DD HH:MM:SS" (space, no T, no Z).
      // Normalize to ISO before parsing so Luxon doesn't return Invalid DateTime.
      const normalized = String(iso).replace(" ", "T").replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z");
      return DateTime.fromISO(normalized, { zone: "utc" }).setZone(tz).toFormat(
        "MMM d, yyyy • h:mm a"
      );
    } catch {
      return String(iso);
    }
  };

  /* -------------------------------------------------------------
     PENDING CARDS — exact original blue MostlyPostly UI
  ------------------------------------------------------------- */

  // Load placement routing for label logic (salon override → system default)
  const systemPlacementDefaults = getSystemPlacementRouting();
  const salonPlacementRow = db.prepare("SELECT placement_routing FROM salons WHERE slug = ?").get(salon_id);
  const salonPlacementOverrides = (() => {
    try { return JSON.parse(salonPlacementRow?.placement_routing || "{}"); } catch { return {}; }
  })();

  const pendingCards =
    pending.length === 0
      ? `<p class="text-mpMuted text-sm">No pending posts.</p>`
      : pending
          .map((p) => {
            const caption = esc(p.base_caption || p.final_caption || p.caption || "")
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

            let submittedByBadge = "";
            if (p.submitted_by) {
              const coordinator = db.prepare("SELECT name FROM managers WHERE id = ?").get(p.submitted_by);
              if (coordinator) {
                submittedByBadge = `<p class="text-[11px] text-mpMuted mt-1">via ${esc(coordinator.name)} on behalf of ${esc(p.stylist_name)}</p>`;
              }
            }

            const resolvedPlacement = p.placement || deriveFromPostType(p.post_type);
            const resolvedContentType = p.content_type || "standard_post";
            const platformReach = getPlatformReach(resolvedPlacement, resolvedContentType);
            const reachDisplay = platformReach.map(pl => PLATFORM_LABELS[pl] || pl).join(" · ");

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

                ${submittedByBadge}
                ${promoExpiry}

                <p class="text-sm whitespace-pre-line text-mpCharcoal leading-relaxed mt-1">
                  ${caption}
                </p>

                ${bookingHint}

                <div class="border border-gray-200 rounded-lg p-4 mb-4 mt-4 bg-gray-50">
                  <div class="flex flex-wrap gap-6 items-start mb-3">
                    <div>
                      <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Content Type</label>
                      <select
                        name="content_type"
                        data-post-id="${esc(p.id)}"
                        onchange="mpUpdatePlacement(this)"
                        class="border border-gray-300 rounded px-3 py-1.5 text-sm bg-white"
                      >
                        ${CONTENT_TYPE_OPTIONS.map(opt => `
                          <option value="${opt.value}"${resolvedContentType === opt.value ? " selected" : ""}>${opt.label}</option>
                        `).join("")}
                      </select>
                    </div>
                    <div>
                      <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Placement</label>
                      <div class="flex gap-3 items-center pt-1">
                        ${["reel", "post", "story"].map(pl => `
                          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input
                              type="radio"
                              name="placement_${esc(p.id)}"
                              value="${pl}"
                              ${resolvedPlacement === pl ? "checked" : ""}
                              onchange="mpOnPlacementOverride('${esc(p.id)}')"
                              class="accent-blue-600"
                            />
                            ${pl.charAt(0).toUpperCase() + pl.slice(1)}
                          </label>
                        `).join("")}
                      </div>
                      ${(() => {
                        if (p.placement_overridden) return `<p id="mp-placement-label-${esc(p.id)}" class="text-xs text-gray-400 mt-1"></p>`;
                        const ct = p.content_type || "standard_post";
                        const isCustom = ct in salonPlacementOverrides;
                        const labelText = isCustom ? "Your salon default" : "Recommended by MostlyPostly";
                        return `<p id="mp-placement-label-${esc(p.id)}" class="text-xs text-gray-400 mt-1">${labelText}</p>`;
                      })()}
                    </div>
                  </div>
                  <p class="text-xs text-gray-500">
                    Will post to: <span id="mp-reach-${esc(p.id)}" class="font-medium text-gray-700">${reachDisplay}</span>
                  </p>
                </div>

                <div class="flex flex-wrap gap-3 mt-4">

                  <a href="/manager/approve?post=${p.id}"
                     data-action-post-id="${esc(p.id)}"
                     data-action-type="approve"
                     class="mp-action-link px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs text-white">
                    Approve
                  </a>

                  <a href="/manager/post-now?post=${p.id}"
                     data-action-post-id="${esc(p.id)}"
                     data-action-type="post-now"
                     class="mp-action-link px-3 py-1.5 bg-mpCharcoal hover:bg-mpCharcoalDark rounded text-xs text-white">
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
     RECENT CARDS — first 5 visible, remainder collapsible
  ------------------------------------------------------------- */
  const gmbConnected = !!salonRow?.google_location_id;

  function renderRecentCard(p) {
        const caption = esc(p.base_caption || p.final_caption || p.caption || "")
          .replace(/\n/g, "<br/>");

        const platformBadges = (() => {
          const badges = [];
          if (p.ig_media_id) badges.push(`<span class="text-[10px] rounded-full bg-gradient-to-br from-purple-500 to-pink-400 text-white px-2 py-0.5 font-bold">IG</span>`);
          if (p.fb_post_id) badges.push(`<span class="text-[10px] rounded-full bg-blue-600 text-white px-2 py-0.5 font-bold">FB</span>`);
          if (gmbConnected) {
            if (p.google_post_id) {
              badges.push(`<span title="Published to Google Business Profile" class="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-xs font-bold" style="background:#4285F4;">G</span>`);
            } else {
              badges.push(`<span title="Not published to Google Business Profile" class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-300 text-white text-xs font-bold">G</span>`);
            }
          }
          return badges.join(" ");
        })();

          return `
          <div class="recent-card rounded-xl bg-white border border-mpBorder p-4 mb-4">

            <div class="flex gap-4">
              ${imageStrip(p, "w-24 h-24")}

              <div class="flex-1">

                <div class="flex items-center justify-between gap-2 mb-1">
                  <div class="flex items-center gap-2 flex-wrap">
                    <p class="text-xs text-mpMuted">
                      Status: <span class="font-semibold">${esc(p.status)}</span> • Post #${esc(p.salon_post_number) || "—"}
                    </p>
                    ${platformBadges ? `<div class="flex items-center gap-1">${platformBadges}</div>` : ""}
                  </div>
                  ${p.status === "manager_approved" || p.status === "failed" ? `
                    <a href="/manager/cancel-post?post=${p.id}"
                       data-confirm="Cancel this post and remove it from the queue?"
                       class="text-[11px] text-red-400 hover:text-red-300 shrink-0">
                      Cancel
                    </a>` : ""}
                </div>
                <p class="text-xs text-mpMuted mb-2">
                  ${p.status === 'published' && p.published_at
                    ? `Published: ${esc(fmt(p.published_at))}`
                    : `Approved: ${esc(fmt(p.updated_at || p.created_at))}`}
                  ${p.scheduled_for ? ` &nbsp;·&nbsp; Scheduled: ${esc(fmt(p.scheduled_for))}` : ""}
                </p>

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
  }

  const recentVisibleCards = recent.length === 0
    ? `<div class="text-mpMuted text-sm italic">No recent posts.</div>`
    : recent.slice(0, 5).map(renderRecentCard).join("");

  const recentCollapsedCards = recent.length > 5
    ? `<div id="recent-collapsed" style="display:none">${recent.slice(5).map(renderRecentCard).join("")}</div>`
    : "";

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
                return DateTime.fromSQL(p.scheduled_for, { zone: "utc" }).setZone(tz).toFormat("MMM d, yyyy 'at' h:mm a");
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
               data-confirm="Cancel this promotion?"
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
          ${thumb ? `<img src="${esc(thumb)}" class="w-14 h-14 rounded-lg object-cover shrink-0 bg-red-100 img-hide-on-error">` : `<div class="w-14 h-14 rounded-lg bg-red-100 shrink-0"></div>`}
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
                 data-confirm="Remove this failed post?"
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
     AUTO-RECYCLE NOTICE BANNER
  ------------------------------------------------------------- */
  const recycledThisWeek = db.prepare(`
    SELECT COUNT(*) AS n FROM posts
    WHERE salon_id = ?
      AND recycled_from_id IS NOT NULL
      AND datetime(created_at) >= datetime('now', '-7 days')
  `).get(salon_id)?.n || 0;

  const recycleBanner = recycledThisWeek === 0 ? '' : `
    <div id="recycle-notice"
         class="mb-6 rounded-xl border border-blue-200 bg-blue-50 px-5 py-3 flex items-center justify-between gap-4">
      <p class="text-sm text-blue-700">
        ${recycledThisWeek} post${recycledThisWeek > 1 ? 's were' : ' was'} auto-recycled this week.
        <a href="/dashboard?salon=${encodeURIComponent(salon_id)}&status=published" class="underline font-medium">View in Database</a>
      </p>
      <button data-dismiss-id="recycle-notice"
              class="text-blue-400 hover:text-blue-600 text-lg leading-none shrink-0">&times;</button>
    </div>`;

  /* -------------------------------------------------------------
     PAGE BODY (old layout)
  ------------------------------------------------------------- */
  const body = `
      <div class="flex items-center justify-between mb-2">
        <h1 class="text-2xl font-extrabold text-mpCharcoal">
          Dashboard
        </h1>
        <div class="flex items-center gap-2">
          <a href="/manager/coordinator/upload"
             class="inline-flex items-center gap-1.5 rounded-full border border-mpAccent px-4 py-1.5 text-xs font-semibold text-mpAccent hover:bg-mpAccent hover:text-white transition-colors">
            Upload a Post
          </a>
          <a href="/manager/promotion/new"
             class="px-4 py-2 bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-semibold rounded-lg text-sm">
            + Create Promotion
          </a>
        </div>
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
      ${recycleBanner}

      ${upcomingPromoCards}

      <h2 class="text-xl font-bold text-mpCharcoal mb-3">Pending Approval</h2>
      ${pendingCards}

      <div class="flex items-center justify-between mt-10 mb-3">
        <h2 class="text-xl font-bold text-mpCharcoal">Recent Activity</h2>
        <span class="text-xs text-mpMuted">${recent.length} post${recent.length !== 1 ? 's' : ''} in the last 14 days</span>
      </div>
      ${recentVisibleCards}
      ${recentCollapsedCards}
      ${recent.length > 5 ? `
        <button id="recent-toggle" type="button"
          class="mt-2 mb-4 text-xs font-semibold text-mpAccent hover:underline">
          Show ${recent.length - 5} more
        </button>
      ` : ''}

  <!-- Image lightbox -->
  <div id="img-lightbox"
       style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out">
    <img id="img-lightbox-img" src="" alt=""
         style="max-width:90vw;max-height:90vh;border-radius:12px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.6)" />
  </div>

  <script>
  document.addEventListener('click', function(e) {
    // Image zoom
    var zoomable = e.target.closest('.img-zoomable');
    if (zoomable) {
      var src = zoomable.getAttribute('data-img');
      if (src) {
        document.getElementById('img-lightbox-img').src = src;
        document.getElementById('img-lightbox').style.display = 'flex';
      }
      return;
    }
    if (e.target.closest('#img-lightbox')) {
      document.getElementById('img-lightbox').style.display = 'none';
      return;
    }

    // Recent activity section toggle
    if (e.target.id === 'recent-toggle') {
      var collapsed = document.getElementById('recent-collapsed');
      if (!collapsed) return;
      var showing = collapsed.style.display !== 'none';
      collapsed.style.display = showing ? 'none' : '';
      e.target.textContent = showing
        ? 'Show ' + collapsed.children.length + ' more'
        : 'Show less';
      return;
    }

    // Show more / show less
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

  // Confirm dialogs — replaces inline onclick="return confirm(...)"
  document.addEventListener('click', function(e) {
    var link = e.target.closest('[data-confirm]');
    if (!link) return;
    if (!confirm(link.dataset.confirm)) e.preventDefault();
  });

  // Dismiss banners — replaces inline onclick="document.getElementById(...).remove()"
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-dismiss-id]');
    if (!btn) return;
    var el = document.getElementById(btn.dataset.dismissId);
    if (el) el.remove();
  });

  // Hide broken images — replaces inline onerror="this.style.display='none'..."
  document.addEventListener('error', function(e) {
    if (e.target.tagName !== 'IMG') return;
    if (e.target.classList.contains('img-hide-on-error')) {
      e.target.style.display = 'none';
    }
    // BROKEN_IMG_PLACEHOLDER pattern: hide img, show sibling placeholder
    if (e.target.nextElementSibling && e.target.nextElementSibling.classList.contains('broken-placeholder')) {
      e.target.style.display = 'none';
      e.target.nextElementSibling.style.display = 'flex';
    }
  }, true); // useCapture required — error events don't bubble

  // Content type + placement live update helpers
  var MP_CT_PLACEMENT = {
    before_after: "reel", standard_post: "post", vendor_product: "story",
    vendor_promotion: "story", reviews: "post", education: "reel",
    celebration: "post", stylist_availability: "story",
  };
  var MP_PLACEMENT_PLATFORMS = {
    reel: ["Instagram", "Facebook", "TikTok"],
    post: ["Instagram", "Facebook", "Google Business"],
    story: ["Instagram", "Facebook"],
  };
  var MP_GMB_OFFER = ["vendor_promotion"];
  var MP_GMB_EXCLUDED = ["reviews", "stylist_availability"];

  function mpUpdatePlacement(selectEl) {
    var postId = selectEl.dataset.postId;
    var ct = selectEl.value;
    var rec = MP_CT_PLACEMENT[ct] || "post";
    var radio = document.querySelector('input[name="placement_' + postId + '"][value="' + rec + '"]');
    if (radio) radio.checked = true;
    document.getElementById('mp-placement-label-' + postId).textContent = "Recommended by MostlyPostly";
    mpUpdateReach(postId, rec, ct);
  }

  function mpOnPlacementOverride(postId) {
    var sel = document.querySelector('select[data-post-id="' + postId + '"]');
    var ct = sel ? sel.value : "standard_post";
    document.getElementById('mp-placement-label-' + postId).textContent = "";
    var radio = document.querySelector('input[name="placement_' + postId + '"]:checked');
    if (radio) mpUpdateReach(postId, radio.value, ct);
  }

  function mpUpdateReach(postId, placement, ct) {
    var platforms = (MP_PLACEMENT_PLATFORMS[placement] || ["Instagram", "Facebook"]).slice();
    if (MP_GMB_EXCLUDED.indexOf(ct) !== -1) platforms = platforms.filter(function(p) { return p !== "Google Business"; });
    if (MP_GMB_OFFER.indexOf(ct) !== -1 && platforms.indexOf("Google Business") === -1) platforms.push("Google Business");
    document.getElementById('mp-reach-' + postId).textContent = platforms.join(" · ");
  }

  // Intercept approve / post-now link clicks and submit as POST with content_type + placement
  document.addEventListener('click', function(e) {
    var link = e.target.closest('.mp-action-link');
    if (!link) return;
    e.preventDefault();
    var postId = link.dataset.actionPostId;
    var actionType = link.dataset.actionType;
    if (!postId || !actionType) return;

    var sel = document.querySelector('select[data-post-id="' + postId + '"]');
    var ct = sel ? sel.value : 'standard_post';
    var radio = document.querySelector('input[name="placement_' + postId + '"]:checked');
    var placement = radio ? radio.value : (MP_CT_PLACEMENT[ct] || 'post');
    var recommended = MP_CT_PLACEMENT[ct] || 'post';
    var overridden = placement !== recommended ? '1' : '0';

    var action = actionType === 'post-now' ? '/manager/post-now' : '/manager/approve';
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = action;
    var csrfMeta = document.querySelector('meta[name="csrf-token"]');
    var pairs = [['post_id', postId], ['content_type', ct], ['placement', placement], ['placement_overridden', overridden]];
    if (csrfMeta) pairs.push(['_csrf', csrfMeta.getAttribute('content')]);
    pairs.forEach(function(pair) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = pair[0];
      input.value = pair[1];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  });
  </script>
  `;

  return res.send(
    pageShell({
      title: "Dashboard",
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
router.get("/approve", requireAuth, requireRole("owner", "manager"), async (req, res) => {
  const id = req.query.post;
  if (!id) return res.redirect("/manager");

  const pendingPost = db.prepare(`
    SELECT *
    FROM posts
    WHERE id = ?
      AND salon_id = ?
      AND status = 'manager_pending'
  `).get(id, req.manager.salon_id);

  if (!pendingPost) {
    console.warn("⚠️ Dashboard approve: post not found or not pending", id);
    return res.redirect(req.query.return === "calendar" ? "/manager/calendar" : "/manager");
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

  const returnToApprove = req.query.return === "calendar" ? "/manager/calendar" : "/manager";
  return res.redirect(returnToApprove);
});

/* -------------------------------------------------------------
   APPROVE (POST — from approval UI with content_type + placement)
------------------------------------------------------------- */
router.post("/approve", requireAuth, requireRole("owner", "manager"), async (req, res) => {
  const id = req.body.post_id;
  if (!id) return res.redirect("/manager");

  const pendingPost = db.prepare(`
    SELECT *
    FROM posts
    WHERE id = ?
      AND salon_id = ?
      AND status = 'manager_pending'
  `).get(id, req.manager.salon_id);

  if (!pendingPost) {
    console.warn("⚠️ Dashboard approve (POST): post not found or not pending", id);
    return res.redirect("/manager");
  }

  // Save content_type + placement before approving (allowlist-validated)
  const rawContentType = req.body.content_type;
  const rawPlacement = req.body.placement;
  const contentType = VALID_CONTENT_TYPES.has(rawContentType) ? rawContentType : "standard_post";
  const placement = VALID_PLACEMENTS.has(rawPlacement) ? rawPlacement : getDefaultPlacement(contentType);
  const placementOverridden = parseInt(req.body.placement_overridden || "0", 10);

  db.prepare(`
    UPDATE posts SET content_type = ?, placement = ?, placement_overridden = ?
    WHERE id = ? AND salon_id = ?
  `).run(contentType, placement, placementOverridden, id, req.manager.salon_id);

  // Look up salon settings for notification prefs
  const salonSettings = db.prepare(
    `SELECT notify_on_approval, timezone FROM salons WHERE slug = ?`
  ).get(pendingPost.salon_id);

  // Approve and enqueue
  await handleManagerApproval(
    req.manager.phone || "dashboard",
    pendingPost,
    async () => {} // suppress built-in SMS — we send below with correct content
  );

  // Notify stylist if setting is enabled and they have a phone
  if (salonSettings?.notify_on_approval && pendingPost.stylist_phone) {
    try {
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
   POST NOW (GET — legacy / direct links)
------------------------------------------------------------- */
router.get("/post-now", requireAuth, requireRole("owner", "manager"), (req, res) => {
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

  const returnToPostNow = req.query.return === "calendar" ? "/manager/calendar" : "/manager";
  return res.redirect(returnToPostNow);
});

/* -------------------------------------------------------------
   POST NOW (POST — from approval UI with content_type + placement)
------------------------------------------------------------- */
router.post("/post-now", requireAuth, requireRole("owner", "manager"), (req, res) => {
  const id = req.body.post_id;
  const salon_id = req.manager.salon_id;

  if (id) {
    const rawContentType = req.body.content_type;
    const rawPlacement = req.body.placement;
    const contentType = VALID_CONTENT_TYPES.has(rawContentType) ? rawContentType : "standard_post";
    const placement = VALID_PLACEMENTS.has(rawPlacement) ? rawPlacement : getDefaultPlacement(contentType);
    const placementOverridden = parseInt(req.body.placement_overridden || "0", 10);

    db.prepare(`
      UPDATE posts
      SET content_type = ?, placement = ?, placement_overridden = ?
      WHERE id = ? AND salon_id = ?
    `).run(contentType, placement, placementOverridden, id, salon_id);

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
router.get("/cancel", requireAuth, requireRole("owner", "manager"), (req, res) => {
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
router.get("/cancel-post", requireAuth, requireRole("owner", "manager"), (req, res) => {
  const id = req.query.post;
  const salon_id = req.manager.salon_id;
  if (id) {
    db.prepare(
      `UPDATE posts SET status='cancelled', scheduled_for=NULL WHERE id=? AND salon_id=?`
    ).run(id, salon_id);
  }
  const returnTo = req.query.return === 'calendar' ? '/manager/calendar' : `/manager?salon=${encodeURIComponent(salon_id)}`;
  return res.redirect(returnTo);
});

/* -------------------------------------------------------------
   RETRY FAILED POST (Layer 4)
------------------------------------------------------------- */
router.post("/retry-post", requireAuth, requireRole("owner", "manager"), (req, res) => {
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
  const returnToRetry = req.body.return === "calendar" ? "/manager/calendar" : "/manager";
  return res.redirect(returnToRetry);
});

router.get("/deny", requireAuth, requireRole("owner", "manager"), (req, res) => {
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
      manager_id: req.manager?.id,
    })
  );
});

/* -------------------------------------------------------------
   DENY — SAVE
------------------------------------------------------------- */
router.post("/deny", requireAuth, requireRole("owner", "manager"), async (req, res) => {
  const { post_id, reason } = req.body;
  const salon_id = req.manager.salon_id;

  const post = db.prepare(`SELECT * FROM posts WHERE id = ? AND salon_id = ?`).get(post_id, salon_id);
  if (!post) return res.redirect(req.body.return === "calendar" ? "/manager/calendar" : "/manager");

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

  const returnToDeny = req.body.return === "calendar" ? "/manager/calendar" : "/manager";
  return res.redirect(returnToDeny);
});

/* -------------------------------------------------------------
   EDIT — FORM
------------------------------------------------------------- */
router.get("/edit/:id", requireAuth, requireRole("owner", "manager"), (req, res) => {
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
        >${esc(post.base_caption || post.caption || "")}</textarea>
        <p class="text-xs text-mpMuted mt-1">Hashtags, stylist credit, and booking link are added automatically when posted.</p>

        <button class="w-full bg-mpCharcoal hover:bg-mpCharcoalDark p-3 rounded-lg text-sm font-semibold text-white">
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
      manager_id: req.manager?.id,
      body,
    })
  );
});

/* -------------------------------------------------------------
   EDIT — SAVE
------------------------------------------------------------- */
router.post("/edit/:id", requireAuth, requireRole("owner", "manager"), (req, res) => {
  const id = req.params.id;
  const { caption } = req.body;

  // Normalize caption to prevent spacing expansion issues
  const cleaned = (caption || "")
    .replace(/\r\n/g, "\n")     // Normalize Windows-style newlines
    .replace(/\n{3,}/g, "\n\n") // Collapse 3+ blank lines into 1 blank line
    .trim();

  // Save cleaned caption to both columns — scheduler rebuilds full caption at publish time
  db.prepare(
    `UPDATE posts
     SET base_caption = ?, final_caption = ?, updated_at=datetime('now')
     WHERE id = ? AND salon_id = ?`
  ).run(cleaned, cleaned, id, req.manager.salon_id);

  // Redirect back to manager for the appropriate salon
  const salonSlug = req.manager?.salon_id || "";
  return res.redirect(`/manager?salon=${salonSlug}`);
});

/* -------------------------------------------------------------
   PROMOTION — FORM
------------------------------------------------------------- */
router.get("/promotion/new", requireAuth, requireRole("owner", "manager"), (req, res) => {
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

  return res.send(pageShell({ title: "Create Promotion", current: "manager", salon_id, manager_id: req.manager?.id, body }));
});

/* -------------------------------------------------------------
   PROMOTION — CREATE (POST)
------------------------------------------------------------- */
router.post("/promotion/create", requireAuth, requireRole("owner", "manager"), async (req, res) => {
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

/* -------------------------------------------------------------
   COORDINATOR UPLOAD — GET form
------------------------------------------------------------- */
router.get("/coordinator/upload", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;

  const stylists = db.prepare(
    "SELECT id, name FROM stylists WHERE salon_id = ? AND (active IS NULL OR active = 1) ORDER BY name"
  ).all(salon_id);

  const errorMsg = req.query.error === "missing"
    ? "Please select a stylist and upload a photo."
    : req.query.error === "stylist"
    ? "Stylist not found. Please try again."
    : req.query.error === "failed"
    ? "Something went wrong. Please try again."
    : "";

  const prefillDate = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : '';

  const body = `
    <section class="mb-8">
      <div class="flex items-center gap-3 mb-1">
        <a href="/manager" class="text-mpMuted hover:text-mpCharcoal text-sm">← Dashboard</a>
      </div>
      <h1 class="text-2xl font-extrabold text-mpCharcoal mt-4">Upload a Post</h1>
      <p class="mt-1 text-sm text-mpMuted">Upload a photo on behalf of a stylist.</p>
    </section>

    ${errorMsg ? `<div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">${esc(errorMsg)}</div>` : ""}

    <section class="rounded-2xl border border-mpBorder bg-white px-6 py-6 max-w-lg">
      <form method="POST" action="/manager/coordinator/upload" enctype="multipart/form-data" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold text-mpCharcoal mb-1.5">Stylist</label>
          <select name="stylist_id" required
            class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:ring-1 focus:ring-mpAccent">
            <option value="">Select a stylist...</option>
            ${stylists.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpCharcoal mb-1.5">Photo</label>
          <input type="file" name="photo" accept="image/*" required
            id="coord-photo-input"
            class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-mpCharcoal file:mr-3 file:rounded-full file:border-0 file:bg-mpAccent file:px-3 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-[#2E5E9E]" />
          <img id="coord-photo-preview" src="" alt="Preview" style="display:none;margin-top:.5rem;max-height:200px;border-radius:.5rem;border:1px solid #E2E8F0;object-fit:contain;" />
          <script>
            document.getElementById('coord-photo-input').addEventListener('change', function() {
              var preview = document.getElementById('coord-photo-preview');
              if (this.files && this.files[0]) {
                var reader = new FileReader();
                reader.onload = function(e) { preview.src = e.target.result; preview.style.display = 'block'; };
                reader.readAsDataURL(this.files[0]);
              } else {
                preview.style.display = 'none';
              }
            });
          </script>
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpCharcoal mb-1.5">Caption note <span class="font-normal text-mpMuted">(optional)</span></label>
          <textarea name="caption_note" rows="2" placeholder="Any context for the AI caption (e.g. 'balayage on a new client')"
            class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-mpCharcoal placeholder:text-mpMuted focus:border-mpAccent focus:ring-1 focus:ring-mpAccent"></textarea>
        </div>
        ${prefillDate ? `
        <div>
          <label class="block text-xs font-semibold text-mpCharcoal mb-1.5">Schedule for date</label>
          <input type="date" name="scheduled_date" value="${esc(prefillDate)}"
            class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:ring-1 focus:ring-mpAccent" />
          <p class="text-[11px] text-mpMuted mt-1">Post will be scheduled for this date. Time will be auto-assigned by the scheduler.</p>
        </div>
        ` : ''}
        <button type="submit"
          class="inline-flex items-center justify-center rounded-full bg-mpAccent px-6 py-2 text-sm font-semibold text-white shadow-md hover:bg-[#2E5E9E]">
          Upload &amp; Generate Caption
        </button>
      </form>
    </section>
  `;

  return res.send(pageShell({ title: "Upload a Post", current: "manager", salon_id, manager_id: req.manager?.id, body }));
});

/* -------------------------------------------------------------
   COORDINATOR UPLOAD — POST handler
------------------------------------------------------------- */
router.post("/coordinator/upload", requireAuth, coordinatorUpload.single("photo"), async (req, res) => {
  const salon_id = req.manager.salon_id;
  const manager_id = req.manager.id;

  try {
    const { stylist_id, caption_note, scheduled_date } = req.body;
    if (!stylist_id || !req.file) {
      return res.redirect("/manager/coordinator/upload?error=missing");
    }

    const stylistRow = db.prepare(
      "SELECT id, name, phone, instagram_handle FROM stylists WHERE id = ? AND salon_id = ?"
    ).get(stylist_id, salon_id);
    if (!stylistRow) return res.redirect("/manager/coordinator/upload?error=stylist");

    // Rename uploaded file to include original extension (multer strips it)
    const ext = path.extname(req.file.originalname || "") || ".jpg";
    const newFilename = `${crypto.randomUUID()}${ext}`;
    const newPath = path.join(UPLOADS_DIR, newFilename);
    renameSync(req.file.path, newPath);

    const imageUrl = toUploadUrl(newFilename);

    // Read file as base64 data URI for OpenAI (no network round-trip needed)
    const mimeType = req.file.mimetype || "image/jpeg";
    const fileBuffer = readFileSync(newPath);
    const imageDataUri = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

    // Generate AI caption
    const { generateCaption } = await import("../openai.js");
    const salonRow = db.prepare("SELECT * FROM salons WHERE slug = ?").get(salon_id);
    const fullSalon = getSalonPolicy(salon_id) || salonRow;
    const aiJson = await generateCaption({
      imageDataUrl: imageDataUri,
      notes: caption_note || "",
      salon: fullSalon,
      stylist: {
        stylist_name: stylistRow.name,
        name: stylistRow.name,
        instagram_handle: stylistRow.instagram_handle || null,
      },
      postType: "standard_post",
      city: salonRow?.city || "",
    });

    const caption = aiJson?.caption || "";

    // Save the post attributed to the selected stylist, tracked to the coordinator
    const stylistPayload = {
      stylist_id: stylistRow.id,
      manager_id,
      stylist_name: stylistRow.name,
      stylist_phone: stylistRow.phone || "",
      instagram_handle: stylistRow.instagram_handle || null,
      image_url: imageUrl,
      post_type: "standard_post",
      submitted_by: manager_id,
    };

    const savedPost = savePost(null, stylistPayload, caption, [], "manager_pending", null, { salon_id });

    if (scheduled_date && /^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
      const salonTzRow = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
      const tz = salonTzRow?.timezone || "America/Indiana/Indianapolis";
      const localDt = DateTime.fromISO(scheduled_date + "T10:00:00", { zone: tz });
      if (localDt.isValid) {
        const utcStr = localDt.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
        db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ?").run(utcStr, savedPost.id);
      }
    }

    return res.redirect(`/manager?notice=${encodeURIComponent(`Post uploaded for ${stylistRow.name} — pending approval`)}`);
  } catch (err) {
    console.error("[Coordinator Upload] Error:", err);
    return res.redirect("/manager/coordinator/upload?error=failed");
  }
});

export default router;
