// src/scheduler.js — DB-Only Scheduler (Final, with getSalonPolicy export)

import { DateTime } from "luxon";
import { db } from "../db.js";
import { createLogger } from "./utils/logHelper.js";
import { rehostTwilioMedia } from "./utils/rehostTwilioMedia.js";
import { publishToFacebook } from "./publishers/facebook.js";
import { publishToInstagram } from "./publishers/instagram.js";
import { logEvent } from "./core/analyticsDb.js";

const log = createLogger("scheduler");

// ENV flags
const FORCE_POST_NOW = process.env.FORCE_POST_NOW === "1";
const IGNORE_WINDOW = process.env.SCHEDULER_IGNORE_WINDOW === "1";

// ===================== Helpers =====================

function toSqliteTimestamp(dt) {
  return dt.toFormat("yyyy-LL-dd HH:mm:ss");
}

function withinPostingWindow(now, start, end) {
  const [sH, sM] = start.split(":").map(Number);
  const [eH, eM] = end.split(":").map(Number);
  const windowStart = now.set({ hour: sH, minute: sM });
  const windowEnd = now.set({ hour: eH, minute: eM });
  return now >= windowStart && now <= windowEnd;
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * DB-only salon policy lookup.
 * Kept for backward compatibility (some publishers import this).
 * Returns BOTH flattened keys and legacy salon_info shape.
 */
function getSalonPolicy(salonSlug) {
  if (!salonSlug) return {};

  const row = db
    .prepare(`
      SELECT
        slug,
        name,
        phone,
        city,
        state,
        timezone,
        posting_start_time,
        posting_end_time,
        spacing_min,
        spacing_max,
        facebook_page_id,
        facebook_page_token,
        instagram_business_id,
        instagram_handle,
        booking_url,
        default_cta,
        default_hashtags,
        tone
      FROM salons
      WHERE slug = ?
    `)
    .get(salonSlug);

  if (!row) return {};

  const posting_window = {
    start: row.posting_start_time || "09:00",
    end: row.posting_end_time || "19:00",
  };

  return {
    ...row,
    posting_window,
    salon_info: {
      ...row,
      posting_window,
    },
  };
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
      const min = salon?.spacing_min ?? salon?.salon_info?.spacing_min ?? 20;
      const max = salon?.spacing_max ?? salon?.salon_info?.spacing_max ?? 45;

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

    const nowUtc = DateTime.utc();

    for (const salonId of tenants) {
      const salon = getSalonPolicy(salonId);

      if (!salon?.slug) {
        console.error(`❌ [Scheduler] Salon not found: ${salonId}`);
        continue;
      }

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

      console.log(`⚡ [Scheduler] ${due.length} due for ${salonId}`);

      const tz = salon.timezone || "America/Indiana/Indianapolis";
      const windowStart = salon.posting_start_time || "09:00";
      const windowEnd = salon.posting_end_time || "19:00";

      for (const post of due) {
        const localNow = nowUtc.setZone(tz);

        if (!IGNORE_WINDOW && !FORCE_POST_NOW) {
          if (!withinPostingWindow(localNow, windowStart, windowEnd)) {
            const retry = toSqliteTimestamp(nowUtc.plus({ hours: 1 }));
            console.log(`⏸️ [${post.id}] Outside window → ${retry}`);

            db.prepare(
              `UPDATE posts
               SET scheduled_for=?, status='manager_approved'
               WHERE id=?`
            ).run(retry, post.id);
            continue;
          }
        }

        try {
          const fbPageId =
            salon.facebook_page_id || salon?.salon_info?.facebook_page_id;
          const fbToken =
            salon.facebook_page_token || salon?.salon_info?.facebook_page_token;

          if (!fbPageId || !fbToken) {
            throw new Error("Missing Facebook credentials in salons table");
          }

          const image =
            post.image_url?.includes("api.twilio.com")
              ? await rehostTwilioMedia(post.image_url, post.salon_id)
              : post.image_url;

          const fbResp = await publishToFacebook(
            fbPageId,
            post.final_caption,
            image,
            fbToken
          );

          const igResp = await publishToInstagram({
            salon_id: salon.slug,
            imageUrl: image,
            caption: post.final_caption,
            instagram_business_id:
              salon.instagram_business_id || salon?.salon_info?.instagram_business_id,
          });

          db.prepare(
            `UPDATE posts
             SET status='published',
                 fb_post_id=?,
                 ig_media_id=?,
                 published_at=datetime('now','utc')
             WHERE id=?`
          ).run(fbResp?.post_id, igResp?.id, post.id);

          console.log(`✅ [${post.id}] Published`);
        } catch (err) {
          console.error(`❌ [${post.id}] Failed:`, err.message);

          const min = salon.spacing_min ?? 20;
          const max = salon.spacing_max ?? 45;
          const retry = toSqliteTimestamp(
            nowUtc.plus({ minutes: randomDelay(min, max) })
          );

          db.prepare(
            `UPDATE posts
             SET status='manager_approved',
                 scheduled_for=?
             WHERE id=?`
          ).run(retry, post.id);
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

  const min = salon?.spacing_min ?? 20;
  const max = salon?.spacing_max ?? 45;
  const delay = randomDelay(min, max);

  const scheduled = toSqliteTimestamp(DateTime.utc().plus({ minutes: delay }));

  db.prepare(
    `UPDATE posts
     SET status='manager_approved',
         scheduled_for=?
     WHERE id=?`
  ).run(scheduled, post.id);

  console.log(`🪵 [Enqueue] ${post.id} → ${scheduled}`);
  return { ...post, status: "manager_approved", scheduled_for: scheduled };
}

// ===================== Boot =====================

export function startScheduler() {
  log("SCHEDULER_START", { mode: "db-only" });

  recoverMissedPosts();

  const intervalSeconds =
    Number(process.env.SCHEDULER_INTERVAL_SECONDS) || 60;

  console.log(`🕓 [Scheduler] Interval active: every ${intervalSeconds}s`);

  setInterval(runSchedulerOnce, intervalSeconds * 1000);
}

// ✅ Required by instagram publisher (and any legacy imports)
export { getSalonPolicy };
