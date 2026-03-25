// src/scheduler.js — DB-Only Scheduler with content-type priority, daily caps, stylist fairness

import { DateTime } from "luxon";
import { db } from "../db.js";
import { createLogger } from "./utils/logHelper.js";
import { rehostTwilioMedia } from "./utils/rehostTwilioMedia.js";
import { publishToFacebook, publishToFacebookMulti, publishFacebookReel } from "./publishers/facebook.js";
import { publishToInstagram, publishToInstagramCarousel, publishStoryToInstagram, publishReelToInstagram } from "./publishers/instagram.js";
import { publishWhatsNewToGmb, publishOfferToGmb } from "./publishers/googleBusiness.js";
import { publishPhotoToTikTok, publishVideoToTikTok } from "./publishers/tiktok.js";
import { logEvent } from "./core/analyticsDb.js";
import { runCelebrationCheck } from "./core/celebrationScheduler.js";
import { runVendorSync } from './core/vendorSync.js';
import { slugify } from './core/utm.js';
import { checkAndAutoRecycle } from './core/contentRecycler.js';
import { pickNextPost } from './core/pickNextPost.js';
import { isEnabledFor } from './core/platformRouting.js';
import { composeFinalCaption } from './core/composeFinalCaption.js';
import { deriveFromPostType } from './core/contentType.js';

const log = createLogger("scheduler");

// Nightly vendor sync guard — resets on restart (acceptable — sync is idempotent)
const vendorSyncRanToday = new Map(); // key: "YYYY-MM-DD", value: true

// ENV flags
const FORCE_POST_NOW = process.env.FORCE_POST_NOW === "1";
const IGNORE_WINDOW  = process.env.SCHEDULER_IGNORE_WINDOW === "1";

// ===================== Content Type Config =====================

/**
 * Default priority order (highest priority first).
 * Availability is always first — time-sensitive.
 * Transformations drive the most reach, so they come second.
 */
export const DEFAULT_PRIORITY = [
  "availability",
  "before_after",
  "celebration",
  "celebration_story",
  "standard_post",
  "reel",
  "promotions",
  "product_education",
];

/**
 * Whether a post type publishes to the feed (counts against daily feed cap).
 * Availability and promotions go to Stories only — they don't consume feed quota.
 */
const FEED_TYPES = new Set([
  "standard_post",
  "before_after",
  "product_education",
  "celebration",
]);

function isStoryOnly(postType) {
  return postType === "availability" || postType === "promotions" || postType === "celebration_story";
}

function getPriorityIndex(postType, priorityOrder) {
  const idx = priorityOrder.indexOf(postType || "standard_post");
  return idx === -1 ? 99 : idx;
}

// ===================== Helpers =====================

function toSqliteTimestamp(dt) {
  return dt.toFormat("yyyy-LL-dd HH:mm:ss");
}

function withinPostingWindow(now, start, end) {
  const [sH, sM] = start.split(":").map(Number);
  const [eH, eM] = end.split(":").map(Number);
  const windowStart = now.set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
  const windowEnd   = now.set({ hour: eH, minute: eM, second: 59, millisecond: 999 });
  return now >= windowStart && now <= windowEnd;
}

const LUXON_WEEKDAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

/**
 * Check per-day posting schedule. Returns true if `now` falls within today's posting window.
 * Falls back to simple start/end if no per-day schedule is set.
 */
function withinScheduleWindow(now, postingSchedule, fallbackStart, fallbackEnd) {
  if (!postingSchedule) {
    return withinPostingWindow(now, fallbackStart, fallbackEnd);
  }
  // Luxon weekday: 1=Monday ... 7=Sunday
  const dayName = LUXON_WEEKDAYS[now.weekday - 1];
  const dayConfig = postingSchedule[dayName];
  if (!dayConfig || !dayConfig.enabled) return false;
  return withinPostingWindow(now, dayConfig.start, dayConfig.end);
}

/**
 * Find the next DateTime that falls inside the posting schedule.
 * Searches up to 7 days ahead. Returns the start of the next valid window.
 */
function nextScheduledWindow(now, postingSchedule, fallbackStart, fallbackEnd) {
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = now.plus({ days: daysAhead }).startOf("day");

    if (!postingSchedule) {
      // Use fallback window on same day first, then next day
      const [sH, sM] = fallbackStart.split(":").map(Number);
      const windowStart = candidate.set({ hour: sH, minute: sM });
      if (windowStart > now) return windowStart;
      continue;
    }

    const dayName = LUXON_WEEKDAYS[candidate.weekday - 1];
    const cfg = postingSchedule[dayName];
    if (!cfg || !cfg.enabled) continue;

    const [sH, sM] = cfg.start.split(":").map(Number);
    const windowStart = candidate.set({ hour: sH, minute: sM, second: 0, millisecond: 0 });
    if (windowStart > now) return windowStart;
  }
  // Last resort: 24 hours from now
  return now.plus({ hours: 24 });
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Count posts published to each platform today (UTC date).
 */
function getDailyPublishedCounts(salonId, dateStr) {
  const fb = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND fb_post_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, dateStr)?.n || 0;

  const ig = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND ig_media_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, dateStr)?.n || 0;

  const tiktok = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND tiktok_post_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, dateStr)?.n || 0;

  return { fb, ig, tiktok };
}

/**
 * Check stylist fairness: how many minutes ago was this stylist's most recent
 * scheduled or published post?  Returns null if none found.
 */
function minutesSinceLastStylistPost(salonId, stylistName, excludePostId) {
  if (!stylistName) return null;
  const row = db.prepare(
    `SELECT COALESCE(published_at, scheduled_for) AS last_time
     FROM posts
     WHERE salon_id=? AND stylist_name=? AND id!=?
       AND (status='manager_approved' OR status='published')
     ORDER BY COALESCE(published_at, scheduled_for) DESC
     LIMIT 1`
  ).get(salonId, stylistName, excludePostId || "");

  if (!row?.last_time) return null;
  const lastDt = DateTime.fromSQL(row.last_time, { zone: "utc" });
  return DateTime.utc().diff(lastDt, "minutes").minutes;
}

/**
 * DB-only salon policy lookup.
 * Returns BOTH flattened keys and legacy salon_info shape.
 */
function getSalonPolicy(salonSlug) {
  if (!salonSlug) return {};

  const row = db
    .prepare(`
      SELECT
        slug, name, phone, city, state, timezone,
        posting_start_time, posting_end_time, posting_schedule,
        spacing_min, spacing_max,
        ig_feed_daily_max, fb_feed_daily_max, tiktok_daily_max,
        fairness_window_min,
        content_priority, content_mix,
        facebook_page_id, facebook_page_token,
        instagram_business_id, instagram_handle,
        booking_url, default_cta, default_hashtags, tone,
        plan,
        google_location_id, google_access_token, google_refresh_token,
        google_business_name, google_token_expiry, gmb_enabled,
        tiktok_account_id, tiktok_access_token, tiktok_refresh_token,
        tiktok_token_expiry, tiktok_enabled,
        auto_recycle, caption_refresh_on_recycle, auto_publish,
        platform_routing
      FROM salons
      WHERE slug = ?
    `)
    .get(salonSlug);

  if (!row) return {};

  const posting_window = {
    start: row.posting_start_time || "09:00",
    end:   row.posting_end_time   || "19:00",
  };

  let priorityOrder = DEFAULT_PRIORITY;
  try {
    const parsed = JSON.parse(row.content_priority || "null");
    if (Array.isArray(parsed) && parsed.length) priorityOrder = parsed;
  } catch {}

  let posting_schedule = null;
  try {
    if (row.posting_schedule) posting_schedule = JSON.parse(row.posting_schedule);
  } catch {}

  return {
    ...row,
    posting_window,
    posting_schedule,
    priorityOrder,
    salon_info: { ...row, posting_window },
  };
}

// ===================== Draft Expiry =====================

/**
 * Mark stale draft and manager_pending posts as expired.
 * Drafts: stylist never approved → expire after 24h
 * Manager pending: manager never acted → expire after 48h
 * This preserves salon_post_number integrity (no gaps from deletes).
 */
function expireStalePosts() {
  try {
    const expiredDrafts = db.prepare(`
      UPDATE posts
      SET status = 'expired'
      WHERE status = 'draft'
        AND datetime(created_at) < datetime('now', '-24 hours')
    `).run();

    const expiredPending = db.prepare(`
      UPDATE posts
      SET status = 'expired'
      WHERE status = 'manager_pending'
        AND datetime(created_at) < datetime('now', '-48 hours')
    `).run();

    const total = expiredDrafts.changes + expiredPending.changes;
    if (total > 0) {
      console.log(`🗑️ [Expiry] Expired ${expiredDrafts.changes} draft(s) + ${expiredPending.changes} pending post(s)`);
    }
  } catch (err) {
    console.error("❌ [Expiry] Failed:", err);
  }
}

// ===================== Recovery =====================

async function recoverMissedPosts() {
  try {
    const missed = db
      .prepare(`
        SELECT id, salon_id, scheduled_for, retry_count
        FROM posts
        WHERE (status IN ('manager_approved','vendor_scheduled') OR status='failed')
          AND scheduled_for IS NOT NULL
          AND datetime(scheduled_for) < datetime('now')
          AND (retry_count IS NULL OR retry_count < 3)
      `)
      .all();

    if (!missed.length) return;

    console.log(`🔁 [Recovery] ${missed.length} overdue post(s)`);

    const now = DateTime.utc();
    for (const post of missed) {
      const salon          = getSalonPolicy(post.salon_id);
      const min            = salon?.spacing_min ?? 20;
      const max            = salon?.spacing_max ?? 45;
      const delay          = randomDelay(min, max);
      const tz             = salon?.timezone || "America/Indiana/Indianapolis";
      const windowStartT   = salon?.posting_start_time || "09:00";
      const windowEndT     = salon?.posting_end_time   || "19:00";
      const postingSched   = salon?.posting_schedule   || null;
      let   scheduledUtc   = now.plus({ minutes: delay });
      const localScheduled = scheduledUtc.setZone(tz);
      if (!withinScheduleWindow(localScheduled, postingSched, windowStartT, windowEndT)) {
        scheduledUtc = nextScheduledWindow(localScheduled, postingSched, windowStartT, windowEndT).toUTC();
      }
      const newTime = toSqliteTimestamp(scheduledUtc);

      db.prepare(
        `UPDATE posts
         SET scheduled_for=?,
             status='manager_approved',
             retry_count = COALESCE(retry_count,0)+1
         WHERE id=?`
      ).run(newTime, post.id);

      logEvent({
        event: "scheduler_recovered_post",
        salon_id: post.salon_id,
        post_id: post.id,
        data: { newTime },
      });
    }
  } catch (err) {
    console.error("❌ [Recovery] Failed:", err);
  }
}

// ===================== Core Run =====================

export async function runSchedulerOnce() {
  // Fire celebration check (runs only at 6am salon-local, once per day)
  runCelebrationCheck().catch(err =>
    console.error("[Scheduler] CelebrationCheck error:", err.message)
  );

  // Nightly vendor sync — fire at 2am UTC (off-peak, before US business hours)
  const vendorSyncToday = new Date().toISOString().slice(0, 10);
  const utcHour = new Date().getUTCHours();
  if (utcHour === 2 && !vendorSyncRanToday.has(vendorSyncToday)) {
    vendorSyncRanToday.set(vendorSyncToday, true);
    runVendorSync().catch(err =>
      console.error('[Scheduler] VendorSync error:', err.message)
    );
  }

  expireStalePosts();

  // Auto-recycle check — runs for all salons with auto_recycle enabled
  try {
    const recycleTargets = db.prepare(
      `SELECT slug FROM salons WHERE auto_recycle = 1`
    ).all();
    for (const { slug } of recycleTargets) {
      try {
        await checkAndAutoRecycle(slug);
      } catch (err) {
        console.error(`[Scheduler] Auto-recycle error for ${slug}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Auto-recycle scan error:', err.message);
  }

  try {
    const tenants = db
      .prepare(`
        SELECT DISTINCT salon_id
        FROM posts
        WHERE status IN ('manager_approved','vendor_scheduled')
          AND scheduled_for IS NOT NULL
      `)
      .all()
      .map((r) => r.salon_id);

    if (!tenants.length) {
      console.log("✅ [Scheduler] No queued posts due right now.");
      return;
    }

    const nowUtc    = DateTime.utc();
    const todayStr  = nowUtc.toFormat("yyyy-LL-dd");

    for (const salonId of tenants) {
      const salon = getSalonPolicy(salonId);

      if (!salon?.slug) {
        console.error(`❌ [Scheduler] Salon not found: ${salonId}`);
        continue;
      }

      // --- Fetch due posts ---
      const due = db
        .prepare(`
          SELECT *
          FROM posts
          WHERE status IN ('manager_approved','vendor_scheduled')
            AND scheduled_for IS NOT NULL
            AND datetime(scheduled_for) <= datetime('now')
            AND salon_id=?
          ORDER BY datetime(scheduled_for) ASC
        `)
        .all(salonId);

      if (!due.length) continue;

      console.log(`⚡ [Scheduler] ${due.length} due for ${salonId}`);

      const tz             = salon.timezone || "America/Indiana/Indianapolis";

      // --- Select next post by cadence-aware distribution ---
      const nextPost = pickNextPost(due, salonId, tz);
      if (nextPost) {
        // Move selected post to front of due array
        const idx = due.findIndex(p => p.id === nextPost.id);
        if (idx > 0) {
          due.splice(idx, 1);
          due.unshift(nextPost);
        }
      }
      const windowStart    = salon.posting_start_time || "09:00";
      const windowEnd      = salon.posting_end_time   || "19:00";
      const postingSchedule = salon.posting_schedule || null;

      // --- Daily cap counters (track within this run) ---
      const fbDailyCap = salon.fb_feed_daily_max ?? 4;
      const igDailyCap = salon.ig_feed_daily_max ?? 5;
      const counts     = getDailyPublishedCounts(salonId, todayStr);
      let fbPostedToday = counts.fb;
      let igPostedToday = counts.ig;
      let tiktokPostedToday = counts.tiktok ?? 0;
      const tiktokDailyCap  = salon.tiktok_daily_max ?? 3;

      for (const post of due) {
        const localNow  = nowUtc.setZone(tz);
        const postType  = post.post_type || "standard_post";
        const resolvedPlacement = post.placement || deriveFromPostType(postType);
        // "reel" | "story" | "post"
        const storyOnly = resolvedPlacement === "story";

        // --- Posting window check ---
        if (!IGNORE_WINDOW && !FORCE_POST_NOW) {
          if (!withinScheduleWindow(localNow, postingSchedule, windowStart, windowEnd)) {
            const nextWindow = nextScheduledWindow(localNow, postingSchedule, windowStart, windowEnd);
            // Convert next window back to UTC for DB storage
            const nextUtc = nextWindow.toUTC();
            const retry = toSqliteTimestamp(nextUtc);
            console.log(`⏸️ [${post.id}] Outside window (${localNow.weekdayLong}) → next window ${retry}`);
            db.prepare(
              `UPDATE posts SET scheduled_for=?, status='manager_approved' WHERE id=?`
            ).run(retry, post.id);
            continue;
          }
        }

        // --- Daily cap check (feed posts only) ---
        if (!storyOnly && !FORCE_POST_NOW) {
          if (fbPostedToday >= fbDailyCap) {
            const tomorrow = nowUtc.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
            console.log(`🚫 [${post.id}] FB daily cap (${fbDailyCap}) reached → reschedule tomorrow`);
            db.prepare(`UPDATE posts SET scheduled_for=? WHERE id=?`)
              .run(toSqliteTimestamp(tomorrow), post.id);
            continue;
          }
          if (igPostedToday >= igDailyCap) {
            const tomorrow = nowUtc.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
            console.log(`🚫 [${post.id}] IG daily cap (${igDailyCap}) reached → reschedule tomorrow`);
            db.prepare(`UPDATE posts SET scheduled_for=? WHERE id=?`)
              .run(toSqliteTimestamp(tomorrow), post.id);
            continue;
          }
        }

        try {
          const fbPageId = salon.facebook_page_id || salon?.salon_info?.facebook_page_id;
          const fbToken  = salon.facebook_page_token || salon?.salon_info?.facebook_page_token;

          if (!fbPageId || !fbToken) {
            throw new Error("Missing Facebook credentials in salons table");
          }

          // Resolve image URLs
          let allRaw;
          if (postType === "before_after") {
            allRaw = post.image_url ? [post.image_url] : [];
          } else {
            const rawUrls = (() => {
              try { return JSON.parse(post.image_urls || "[]"); } catch { return []; }
            })();
            allRaw = rawUrls.length ? rawUrls : (post.image_url ? [post.image_url] : []);
          }

          // Rehost any Twilio-signed URLs
          const allImages = await Promise.all(
            allRaw.map(url =>
              url?.includes("api.twilio.com")
                ? rehostTwilioMedia(url, post.salon_id)
                : url
            )
          );

          // Guard: Instagram and Facebook photo posts require at least one image
          if (allImages.length === 0 || !allImages[0]) {
            throw new Error("No image URL available for this post — cannot publish to Instagram or Facebook");
          }

          // --- Derive platform-specific captions ---
          const isVendorPost = !!post.vendor_campaign_id;
          let fbCaption, igCaption;

          if (isVendorPost) {
            // Vendor posts: use pre-built final_caption (assembled by vendorScheduler.js)
            fbCaption = post.final_caption;
            // IG: strip "Shop today: URL" line, strip any remaining URLs
            igCaption = post.final_caption
              .replace(/\n\nShop today: https?:\/\/\S+/gi, '')
              .replace(/https?:\/\/\S+/gi, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          } else {
            // Standard posts: rebuild from base_caption + metadata at publish time
            // (same pattern as TikTok publish block — ensures manager edits don't lose metadata)
            const postStylist = post.stylist_id
              ? db.prepare('SELECT instagram_handle, name FROM stylists WHERE id = ?').get(post.stylist_id)
              : null;
            let postHashtags = [];
            try { postHashtags = JSON.parse(post.hashtags || '[]'); } catch (_e) { /* ignore */ }

            fbCaption = composeFinalCaption({
              caption:         post.base_caption || post.final_caption || '',
              hashtags:        postHashtags,
              stylistName:     post.stylist_name || '',
              instagramHandle: postStylist?.instagram_handle || '',
              bookingUrl:      salon.booking_url || '',
              salon,
              platform:        'facebook',
              salonId:         salon.slug,
              postId:          post.id,
              postType:        postType,
              stylistSlug:     post.stylist_name ? slugify(post.stylist_name) : null,
            }).trim();

            igCaption = composeFinalCaption({
              caption:         post.base_caption || post.final_caption || '',
              hashtags:        postHashtags,
              stylistName:     post.stylist_name || '',
              instagramHandle: postStylist?.instagram_handle || '',
              bookingUrl:      salon.booking_url || '',
              salon,
              platform:        'instagram',
              postType:        postType,
            }).trim();
          }

          const isMulti = allImages.length > 1;
          console.log(`📸 [Scheduler] Publishing ${allImages.length} image(s) for ${post.id} (${postType}, ${isMulti ? "carousel" : "single"})`);

          let fbResp = null;
          let igResp = null;

          if (resolvedPlacement === "reel") {
            // -- Reel publish (REEL-06, REEL-07) --------------------------
            // FB and IG publish independently — one failure does not block the other
            const videoUrl = allImages[0] || post.image_url;
            console.log(`[Scheduler] Publishing reel ${post.id} to FB + IG + TikTok`);

            if (isEnabledFor(salon, postType, 'facebook')) {
              try {
                fbResp = await publishFacebookReel(
                  salon,       // pass full salon object — publishFacebookReel extracts page_id, token, graph_version
                  fbCaption,
                  videoUrl
                );
              } catch (fbErr) {
                console.error(`[Scheduler] FB Reel failed for ${post.id}:`, fbErr.message);
                // fbResp stays null — IG still proceeds
              }
            }

            if (isEnabledFor(salon, postType, 'instagram')) {
              try {
                igResp = await publishReelToInstagram({
                  salon_id: salon.slug,
                  videoUrl,
                  caption: igCaption,
                });
              } catch (igErr) {
                console.error(`[Scheduler] IG Reel failed for ${post.id}:`, igErr.message);
                // If both failed, throw so the outer catch handles retry
                if (!fbResp) throw igErr;
              }
            }
          } else if (resolvedPlacement === "story") {
            // story placement → IG + FB Stories only (no GMB, no TikTok)
            if (isEnabledFor(salon, postType, 'instagram')) {
              const image        = allImages[0] || post.image_url;
              const storyLinkUrl = salon.booking_url || salon.booking_link || null;
              igResp = await publishStoryToInstagram({
                salon_id: salon.slug,
                imageUrl: image,
                linkUrl:  storyLinkUrl,
              });
            }
          } else if (isMulti) {
            if (isEnabledFor(salon, postType, 'facebook')) {
              fbResp = await publishToFacebookMulti(fbPageId, fbCaption, allImages, fbToken);
            }
            if (isEnabledFor(salon, postType, 'instagram')) {
              igResp = await publishToInstagramCarousel({
                salon_id:  salon.slug,
                caption:   igCaption,
                imageUrls: allImages,
              });
            }
          } else {
            if (isEnabledFor(salon, postType, 'facebook')) {
              const image = allImages[0] || post.image_url;
              fbResp = await publishToFacebook(fbPageId, fbCaption, image, fbToken);
            }
            if (isEnabledFor(salon, postType, 'instagram')) {
              const image = allImages[0] || post.image_url;
              igResp = await publishToInstagram({
                salon_id:               salon.slug,
                imageUrl:               image,
                caption:                igCaption,
                instagram_business_id:  salon.instagram_business_id || salon?.salon_info?.instagram_business_id,
                stylist_id:             post.stylist_id || null,
              });
            }
          }

          const fbPostId = fbResp?.post_id || fbResp?.id || null;

          db.prepare(
            `UPDATE posts
             SET status='published',
                 fb_post_id=?,
                 ig_media_id=?,
                 published_at=datetime('now','utc')
             WHERE id=?`
          ).run(fbPostId, igResp?.id || null, post.id);

          // Increment in-run counters (feed posts only)
          if (!storyOnly) {
            if (fbResp) fbPostedToday++;
            if (igResp) igPostedToday++;
          }

          console.log(`✅ [${post.id}] Published (fb today: ${fbPostedToday}/${fbDailyCap}, ig today: ${igPostedToday}/${igDailyCap})`);

          // --- GMB publish (independent — does not block FB/IG) ---
          // GMB only for "post" placement; reels and stories are excluded.
          // content_type "reviews" and "stylist_availability" are also excluded.
          const contentType = post.content_type || null;
          const gmbSkippedByContentType = contentType === "reviews"
            || contentType === "stylist_availability";
          const gmbEligible = ["growth", "pro"].includes(salon.plan)
            && salon.gmb_enabled
            && salon.google_location_id
            && salon.google_refresh_token
            && resolvedPlacement === "post"   // GMB only for feed posts (no reels, no stories)
            && !gmbSkippedByContentType
            && isEnabledFor(salon, postType, 'gmb');

          if (gmbEligible) {
            try {
              const caption   = fbCaption;
              const image     = allImages[0] || post.image_url;
              const todayIso  = new Date().toISOString().split("T")[0];
              // Use content_type for routing when available; fall back to post_type heuristic
              const isOffer   = (contentType === "vendor_promotion"
                || ["promotions", "vendor_post"].includes(postType))
                && !!post.promotion_expires_at;
              let gmbResp;

              if (isOffer) {
                gmbResp = await publishOfferToGmb(salon, caption, image, {
                  title:     post.product_name || salon.name,
                  startDate: todayIso,
                  endDate:   post.promotion_expires_at,
                });
              } else {
                gmbResp = await publishWhatsNewToGmb(salon, caption, image);
              }

              if (gmbResp?.id) {
                db.prepare("UPDATE posts SET google_post_id = ? WHERE id = ?")
                  .run(gmbResp.id, post.id);
                console.log(`✅ [${post.id}] GMB published: ${gmbResp.id}`);
              }
            } catch (gmbErr) {
              console.error(`⚠️ [${post.id}] GMB publish failed (FB/IG unaffected):`, gmbErr.message);
            }
          }

          // --- TikTok publish (independent — does not block FB/IG/GMB) ---
          // Stories are excluded from TikTok (no story-type support).
          // Reels are explicitly included; feed posts are also eligible.
          const tiktokEligible = salon.tiktok_enabled
            && salon.tiktok_access_token
            && salon.tiktok_refresh_token
            && resolvedPlacement !== "story"   // stories never go to TikTok
            && isEnabledFor(salon, postType, 'tiktok');

          if (tiktokEligible && tiktokPostedToday < tiktokDailyCap) {
            try {
              // Build a dedicated TikTok caption: @tiktok_handle credit, no booking URL
              const tiktokStylist = post.stylist_id
                ? db.prepare('SELECT tiktok_handle, name FROM stylists WHERE id = ?').get(post.stylist_id)
                : null;
              const tiktokCaption = composeFinalCaption({
                caption:      post.base_caption || post.final_caption || "",
                hashtags:     (() => { try { return JSON.parse(post.hashtags || "[]"); } catch { return []; } })(),
                stylistName:  post.stylist_name || "",
                tiktokHandle: tiktokStylist?.tiktok_handle || "",
                salon,
                platform:     "tiktok",
                noBookingCta: true,
              }).trim();

              let tiktokPublishId;
              const isVideo = resolvedPlacement === "reel"
                || /\.(mp4|mov|avi|webm)$/i.test(allImages[0] || "");

              if (isVideo) {
                const videoUrl = allImages[0] || post.image_url;
                tiktokPublishId = await publishVideoToTikTok(salon, videoUrl, tiktokCaption);
              } else {
                tiktokPublishId = await publishPhotoToTikTok(salon, allImages, tiktokCaption);
              }

              if (tiktokPublishId) {
                db.prepare("UPDATE posts SET tiktok_post_id = ? WHERE id = ?")
                  .run(tiktokPublishId, post.id);
                tiktokPostedToday++;
                console.log(`✅ [${post.id}] TikTok published: ${tiktokPublishId}`);
              }
            } catch (tiktokErr) {
              console.error(`⚠️ [${post.id}] TikTok publish failed (FB/IG unaffected):`, tiktokErr.message);
            }
          }

        } catch (err) {
          console.error(`❌ [${post.id}] Failed:`, err.message);

          const newRetryCount = (post.retry_count || 0) + 1;
          const MAX_RETRIES   = 3;

          if (newRetryCount >= MAX_RETRIES) {
            console.error(`🚫 [${post.id}] Max retries — marking failed`);
            db.prepare(
              `UPDATE posts SET status='failed', retry_count=?, error_message=? WHERE id=?`
            ).run(newRetryCount, err.message.slice(0, 500), post.id);

            // Layer 2: SMS manager on permanent failure
            try {
              const mgr = db.prepare(
                `SELECT phone FROM managers WHERE salon_id=? AND role IN ('owner','manager') AND phone IS NOT NULL ORDER BY rowid LIMIT 1`
              ).get(post.salon_id);
              if (mgr?.phone) {
                const { translatePostError } = await import("./core/postErrorTranslator.js");
                const friendlyErr = translatePostError(err.message);
                const { sendViaTwilio } = await import("./routes/twilio.js");
                await sendViaTwilio(mgr.phone,
                  `⚠️ MostlyPostly: A post by ${post.stylist_name || "a stylist"} failed to publish after 3 attempts. ${friendlyErr} Log in to retry or dismiss: https://app.mostlypostly.com/manager`
                );
              }
            } catch (smsErr) {
              console.warn(`[Scheduler] Failed to send failure SMS:`, smsErr.message);
            }
          } else {
            const min   = salon.spacing_min ?? 20;
            const max   = salon.spacing_max ?? 45;
            const retry = toSqliteTimestamp(nowUtc.plus({ minutes: randomDelay(min, max) }));
            db.prepare(
              `UPDATE posts SET status='manager_approved', scheduled_for=?, retry_count=?, error_message=? WHERE id=?`
            ).run(retry, newRetryCount, err.message.slice(0, 500), post.id);
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err);
  }
}

// ===================== Enqueue =====================

export function enqueuePost(post) {
  const salon = getSalonPolicy(post.salon_id);

  const min   = salon?.spacing_min ?? 20;
  const max   = salon?.spacing_max ?? 45;
  let   delay = randomDelay(min, max);

  // --- Stylist fairness: avoid back-to-back posts from same stylist ---
  const fairnessWindow = salon?.fairness_window_min ?? 180;
  const minutesSince   = minutesSinceLastStylistPost(post.salon_id, post.stylist_name, post.id);

  if (minutesSince !== null && minutesSince < fairnessWindow) {
    const extraNeeded = Math.ceil(fairnessWindow - minutesSince);
    if (delay < extraNeeded) {
      console.log(`⏳ [Enqueue] Stylist fairness: adding ${extraNeeded - delay}min extra delay for ${post.stylist_name}`);
      delay = extraNeeded + randomDelay(5, 15); // add a little extra jitter
    }
  }

  const tz              = salon?.timezone || "America/Indiana/Indianapolis";
  const windowStartTime = salon?.posting_start_time || "09:00";
  const windowEndTime   = salon?.posting_end_time   || "19:00";
  const postingSchedule = salon?.posting_schedule   || null;

  let scheduledUtc = DateTime.utc().plus({ minutes: delay });

  // If the computed time falls outside the posting window, push it to the next window open
  const localScheduled = scheduledUtc.setZone(tz);
  if (!withinScheduleWindow(localScheduled, postingSchedule, windowStartTime, windowEndTime)) {
    const nextWindow = nextScheduledWindow(localScheduled, postingSchedule, windowStartTime, windowEndTime);
    scheduledUtc = nextWindow.toUTC();
    console.log(`📅 [Enqueue] ${post.id} outside posting window → pushed to ${scheduledUtc.toISO()} (${nextWindow.toISO()} local)`);
  }

  const scheduled = toSqliteTimestamp(scheduledUtc);

  // Note: UTM tracking short URL injection removed here.
  // composeFinalCaption now handles booking URL tracking token injection at publish time
  // (when salonId + postId are passed to it in the publish block).

  db.prepare(
    `UPDATE posts SET status='manager_approved', scheduled_for=? WHERE id=?`
  ).run(scheduled, post.id);

  console.log(`🪵 [Enqueue] ${post.id} → ${scheduled} (${delay}min delay, type: ${post.post_type || "standard_post"})`);
  return { ...post, status: "manager_approved", scheduled_for: scheduled };
}

// ===================== Stats (for Scheduler Config page) =====================

export function getSchedulerStats(salonId) {
  const todayStr = DateTime.utc().toFormat("yyyy-LL-dd");

  const queued = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND status='manager_approved' AND scheduled_for IS NOT NULL`
  ).get(salonId)?.n || 0;

  const publishedToday = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND status='published' AND date(published_at)=?`
  ).get(salonId, todayStr)?.n || 0;

  const failed = db.prepare(
    `SELECT COUNT(*) AS n FROM posts WHERE salon_id=? AND status='failed'`
  ).get(salonId)?.n || 0;

  const nextPost = db.prepare(
    `SELECT scheduled_for, post_type, stylist_name FROM posts
     WHERE salon_id=? AND status='manager_approved' AND scheduled_for IS NOT NULL
     ORDER BY datetime(scheduled_for) ASC LIMIT 1`
  ).get(salonId);

  const fbToday = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND fb_post_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, todayStr)?.n || 0;

  const igToday = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND ig_media_id IS NOT NULL AND date(published_at)=?`
  ).get(salonId, todayStr)?.n || 0;

  return { queued, publishedToday, failed, nextPost, fbToday, igToday };
}

// ===================== Boot =====================

export function startScheduler() {
  log("SCHEDULER_START", { mode: "db-only" });

  expireStalePosts();
  recoverMissedPosts();

  const intervalSeconds = Number(process.env.SCHEDULER_INTERVAL_SECONDS) || 60;
  console.log(`🕓 [Scheduler] Interval active: every ${intervalSeconds}s`);
  setInterval(runSchedulerOnce, intervalSeconds * 1000);
}

// ✅ Required by instagram publisher and legacy imports
export { getSalonPolicy };
