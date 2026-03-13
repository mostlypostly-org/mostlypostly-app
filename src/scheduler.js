// src/scheduler.js — DB-Only Scheduler with content-type priority, daily caps, stylist fairness

import { DateTime } from "luxon";
import { db } from "../db.js";
import { createLogger } from "./utils/logHelper.js";
import { rehostTwilioMedia } from "./utils/rehostTwilioMedia.js";
import { publishToFacebook, publishToFacebookMulti } from "./publishers/facebook.js";
import { publishToInstagram, publishToInstagramCarousel, publishStoryToInstagram } from "./publishers/instagram.js";
import { logEvent } from "./core/analyticsDb.js";

const log = createLogger("scheduler");

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
  "standard_post",
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
  return postType === "availability" || postType === "promotions";
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

  return { fb, ig };
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
        booking_url, default_cta, default_hashtags, tone
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
        WHERE (status='manager_approved' OR status='failed')
          AND scheduled_for IS NOT NULL
          AND datetime(scheduled_for) < datetime('now')
          AND (retry_count IS NULL OR retry_count < 3)
      `)
      .all();

    if (!missed.length) return;

    console.log(`🔁 [Recovery] ${missed.length} overdue post(s)`);

    const now = DateTime.utc();
    for (const post of missed) {
      const salon = getSalonPolicy(post.salon_id);
      const min   = salon?.spacing_min ?? 20;
      const max   = salon?.spacing_max ?? 45;
      const delay = randomDelay(min, max);
      const newTime = toSqliteTimestamp(now.plus({ minutes: delay }));

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
  expireStalePosts();

  try {
    const tenants = db
      .prepare(`
        SELECT DISTINCT salon_id
        FROM posts
        WHERE status='manager_approved'
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
          WHERE status='manager_approved'
            AND scheduled_for IS NOT NULL
            AND datetime(scheduled_for) <= datetime('now')
            AND salon_id=?
          ORDER BY datetime(scheduled_for) ASC
        `)
        .all(salonId);

      if (!due.length) continue;

      // --- Sort by content priority ---
      const priorityOrder = salon.priorityOrder || DEFAULT_PRIORITY;
      due.sort((a, b) =>
        getPriorityIndex(a.post_type, priorityOrder) -
        getPriorityIndex(b.post_type, priorityOrder)
      );

      console.log(`⚡ [Scheduler] ${due.length} due for ${salonId}`);

      const tz             = salon.timezone || "America/Indiana/Indianapolis";
      const windowStart    = salon.posting_start_time || "09:00";
      const windowEnd      = salon.posting_end_time   || "19:00";
      const postingSchedule = salon.posting_schedule || null;

      // --- Daily cap counters (track within this run) ---
      const fbDailyCap = salon.fb_feed_daily_max ?? 4;
      const igDailyCap = salon.ig_feed_daily_max ?? 5;
      const counts     = getDailyPublishedCounts(salonId, todayStr);
      let fbPostedToday = counts.fb;
      let igPostedToday = counts.ig;

      for (const post of due) {
        const localNow  = nowUtc.setZone(tz);
        const postType  = post.post_type || "standard_post";
        const storyOnly = isStoryOnly(postType);

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

          const isMulti = allImages.length > 1;
          console.log(`📸 [Scheduler] Publishing ${allImages.length} image(s) for ${post.id} (${postType}, ${isMulti ? "carousel" : "single"})`);

          let fbResp = null;
          let igResp = null;

          if (storyOnly) {
            // Availability + Promotions → Stories only
            const image        = allImages[0] || post.image_url;
            const storyLinkUrl = salon.booking_url || salon.booking_link || null;
            igResp = await publishStoryToInstagram({
              salon_id: salon.slug,
              imageUrl: image,
              linkUrl:  storyLinkUrl,
            });
          } else if (isMulti) {
            fbResp = await publishToFacebookMulti(fbPageId, post.final_caption, allImages, fbToken);
            igResp = await publishToInstagramCarousel({
              salon_id:  salon.slug,
              caption:   post.final_caption,
              imageUrls: allImages,
            });
          } else {
            const image = allImages[0] || post.image_url;
            fbResp = await publishToFacebook(fbPageId, post.final_caption, image, fbToken);
            igResp = await publishToInstagram({
              salon_id:               salon.slug,
              imageUrl:               image,
              caption:                post.final_caption,
              instagram_business_id:  salon.instagram_business_id || salon?.salon_info?.instagram_business_id,
            });
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

        } catch (err) {
          console.error(`❌ [${post.id}] Failed:`, err.message);

          const newRetryCount = (post.retry_count || 0) + 1;
          const MAX_RETRIES   = 3;

          if (newRetryCount >= MAX_RETRIES) {
            console.error(`🚫 [${post.id}] Max retries — marking failed`);
            db.prepare(
              `UPDATE posts SET status='failed', retry_count=?, error_message=? WHERE id=?`
            ).run(newRetryCount, err.message.slice(0, 500), post.id);
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

  const scheduled = toSqliteTimestamp(DateTime.utc().plus({ minutes: delay }));

  db.prepare(
    `UPDATE posts SET status='manager_approved', scheduled_for=? WHERE id=?`
  ).run(scheduled, post.id);

  console.log(`🪵 [Enqueue] ${post.id} → ${scheduled} (${delay}min, type: ${post.post_type || "standard_post"})`);
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
