// src/core/fetchInsights.js — Fetch FB + IG + GMB post-level insights and cache in DB
import { db } from "../../db.js";
import crypto from "crypto";
import { syncGmbInsights } from "./fetchGmbInsights.js";

const GRAPH = "https://graph.facebook.com/v22.0";

// ─── Facebook ────────────────────────────────────────────────────────────────

async function fetchFBInsights(fbPostId, pageToken) {
  // If the stored ID is a photo object ID (no underscore = not in pageId_postId format),
  // resolve it to the actual post ID which is required for post insights.
  let resolvedId = fbPostId;
  if (!String(fbPostId).includes("_")) {
    const resolveRes = await fetch(`${GRAPH}/${fbPostId}?fields=post_id&access_token=${pageToken}`);
    const resolveJson = await resolveRes.json();
    if (resolveJson.post_id) {
      resolvedId = resolveJson.post_id;
      console.log(`🔧 [FB Insights] Resolved photo ID ${fbPostId} → post ID ${resolvedId}`);
    }
  }

  // ── Try full insights (requires read_insights advanced access) ──
  const metrics = [
    "post_impressions",
    "post_impressions_unique",
    "post_engaged_users",
    "post_reactions_by_type_total",
  ].join(",");

  const insightsUrl = `${GRAPH}/${resolvedId}/insights?metric=${metrics}&access_token=${pageToken}`;
  const insightsRes = await fetch(insightsUrl);
  const insightsJson = await insightsRes.json();

  if (insightsRes.ok && !insightsJson.error) {
    const byName = {};
    for (const item of insightsJson.data || []) {
      byName[item.name] = item.values?.[0]?.value ?? 0;
    }
    const reactionsByType = byName["post_reactions_by_type_total"] || {};
    const totalReactions = typeof reactionsByType === "object"
      ? Object.values(reactionsByType).reduce((s, v) => s + (v || 0), 0)
      : (reactionsByType || 0);
    const impressions = byName["post_impressions"] || 0;
    const reach       = byName["post_impressions_unique"] || 0;
    const engaged     = byName["post_engaged_users"] || 0;
    return {
      platform:       "facebook",
      impressions, reach,
      engaged_users:  engaged,
      reactions:      totalReactions,
      link_clicks:    0,
      engagement_rate: reach > 0 ? parseFloat(((engaged / reach) * 100).toFixed(2)) : 0,
    };
  }

  // ── Fallback: pages_read_engagement fields (works without read_insights) ──
  // Covers the case where the app hasn't received advanced access to read_insights yet.
  console.warn(`⚠️ [FB] Insights API unavailable for ${resolvedId} (${insightsJson?.error?.code}), falling back to engagement fields`);

  const fieldsUrl = `${GRAPH}/${resolvedId}?fields=likes.summary(true),comments.summary(true),shares,reactions.summary(true)&access_token=${pageToken}`;
  const fieldsRes = await fetch(fieldsUrl);
  const fieldsJson = await fieldsRes.json();

  if (!fieldsRes.ok || fieldsJson.error) {
    throw new Error(`FB insights error for ${resolvedId}: ${fieldsJson?.error?.message || fieldsRes.status}`);
  }

  const likes     = fieldsJson.likes?.summary?.total_count || 0;
  const comments  = fieldsJson.comments?.summary?.total_count || 0;
  const shares    = fieldsJson.shares?.count || 0;
  const reactions = fieldsJson.reactions?.summary?.total_count || 0;
  const engaged   = likes + comments + shares;

  return {
    platform:       "facebook",
    impressions:    0,
    reach:          0,
    likes,
    comments,
    engaged_users:  engaged,
    reactions,
    link_clicks:    0,
    engagement_rate: 0, // can't compute without reach
  };
}

// ─── Instagram ───────────────────────────────────────────────────────────────
// mediaInfo is pre-fetched from /{igBusinessId}/media — avoids direct /{mediaId}?fields=
// which fails when the token doesn't have direct read access to that media object.

async function fetchIGInsights(igMediaId, pageToken, mediaInfo = null) {
  const mediaType = (mediaInfo?.media_type || "IMAGE").toUpperCase();
  const likes     = mediaInfo?.like_count    || 0;
  const comments  = mediaInfo?.comments_count || 0;

  // v22+: `impressions` removed. Use reach + saved + total_interactions.
  // Reels also support `plays`.
  const isReel = mediaType === "VIDEO" || mediaType === "REEL";
  const insightMetrics = isReel
    ? ["reach", "plays", "saved", "total_interactions"].join(",")
    : ["reach", "saved", "total_interactions"].join(",");

  const insightUrl = `${GRAPH}/${igMediaId}/insights?metric=${insightMetrics}&access_token=${pageToken}`;
  const insightRes = await fetch(insightUrl);
  const insightJson = await insightRes.json();

  const byName = {};
  if (insightRes.ok && !insightJson.error) {
    for (const item of insightJson.data || []) {
      byName[item.name] = item.values?.[0]?.value ?? item.value ?? 0;
    }
  } else if (insightJson.error) {
    console.warn(`⚠️ IG insights error ${igMediaId} (${mediaType}): ${insightJson.error.message}`);
  }

  const reach             = byName["reach"] || 0;
  const saves             = byName["saved"] || 0;
  const totalInteractions = byName["total_interactions"] || 0;
  const plays             = byName["plays"] || 0;
  const engaged           = totalInteractions || (likes + comments + saves);

  return {
    platform:       "instagram",
    impressions:    plays || reach,
    reach,
    likes,
    comments,
    saves,
    engaged_users:  engaged,
    engagement_rate: reach > 0 ? parseFloat(((engaged / reach) * 100).toFixed(2)) : 0,
  };
}

// ─── Upsert to DB ────────────────────────────────────────────────────────────

function upsertInsights(postId, salonId, metrics) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO post_insights
      (id, post_id, salon_id, platform, fetched_at,
       impressions, reach, likes, comments, shares, saves,
       reactions, engaged_users, link_clicks, other_clicks,
       video_views, engagement_rate)
    VALUES
      (@id, @post_id, @salon_id, @platform, datetime('now','utc'),
       @impressions, @reach, @likes, @comments, @shares, @saves,
       @reactions, @engaged_users, @link_clicks, @other_clicks,
       @video_views, @engagement_rate)
    ON CONFLICT(post_id, platform) DO UPDATE SET
      fetched_at      = excluded.fetched_at,
      impressions     = excluded.impressions,
      reach           = excluded.reach,
      likes           = excluded.likes,
      comments        = excluded.comments,
      shares          = excluded.shares,
      saves           = excluded.saves,
      reactions       = excluded.reactions,
      engaged_users   = excluded.engaged_users,
      link_clicks     = excluded.link_clicks,
      other_clicks    = excluded.other_clicks,
      video_views     = excluded.video_views,
      engagement_rate = excluded.engagement_rate
  `).run({
    id,
    post_id:        postId,
    salon_id:       salonId,
    platform:       metrics.platform,
    impressions:    metrics.impressions    || 0,
    reach:          metrics.reach          || 0,
    likes:          metrics.likes          || 0,
    comments:       metrics.comments       || 0,
    shares:         metrics.shares         || 0,
    saves:          metrics.saves          || 0,
    reactions:      metrics.reactions      || 0,
    engaged_users:  metrics.engaged_users  || 0,
    link_clicks:    metrics.link_clicks    || 0,
    other_clicks:   metrics.other_clicks   || 0,
    video_views:    metrics.video_views    || 0,
    engagement_rate: metrics.engagement_rate || 0,
  });
}

// ─── Fetch all IG media from the business account (paginated) ────────────────
// Returns a Map of mediaId → {id, like_count, comments_count, media_type, timestamp}

async function fetchAllIGMedia(igBusinessId, pageToken) {
  const mediaMap = new Map();
  let url = `${GRAPH}/${igBusinessId}/media?fields=id,like_count,comments_count,media_type,timestamp&limit=100&access_token=${pageToken}`;

  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error || !json.data) {
      console.warn("⚠️ IG media list error:", json.error?.message || "no data");
      break;
    }
    for (const m of json.data) mediaMap.set(m.id, m);
    url = json.paging?.next || null;
  }

  return mediaMap;
}

// ─── Main sync ───────────────────────────────────────────────────────────────

export async function syncSalonInsights(salon) {
  const pageToken    = salon.facebook_page_token || process.env.FACEBOOK_PAGE_TOKEN;
  const igBusinessId = salon.instagram_business_id;
  if (!pageToken) return { synced: 0, errors: ["No Facebook page token configured"] };

  const salonSlug = salon.slug || salon.salon_id || salon.id;

  const publishedPosts = db.prepare(`
    SELECT id, fb_post_id, ig_media_id, salon_id, published_at
    FROM posts
    WHERE salon_id = ? AND status = 'published'
      AND (fb_post_id IS NOT NULL OR ig_media_id IS NOT NULL)
    ORDER BY published_at DESC
    LIMIT 100
  `).all(salonSlug);

  // Fetch all IG media from the business account so we can match by ID or timestamp.
  // This avoids direct /{mediaId}?fields= calls which fail when the token doesn't
  // have read access to media from a previous OAuth connection.
  let igMediaMap = new Map();
  if (igBusinessId) {
    try {
      igMediaMap = await fetchAllIGMedia(igBusinessId, pageToken);
      console.log(`📷 [Insights] Loaded ${igMediaMap.size} IG media items from account`);
    } catch (err) {
      console.warn("⚠️ [Insights] Could not fetch IG media list:", err.message);
    }
  }

  let synced = 0;
  const errors = [];

  for (const post of publishedPosts) {
    // ── Facebook ──────────────────────────────────────────────────────────
    if (post.fb_post_id) {
      try {
        const metrics = await fetchFBInsights(post.fb_post_id, pageToken);
        upsertInsights(post.id, post.salon_id, metrics);
        synced++;
      } catch (err) {
        errors.push(`FB ${post.fb_post_id}: ${err.message}`);
      }
    }

    // ── Instagram ─────────────────────────────────────────────────────────
    if (igBusinessId && igMediaMap.size > 0) {
      // Try stored ID first; if not in the IG media list, try timestamp match
      let igMediaId  = post.ig_media_id;
      let mediaInfo  = igMediaId ? igMediaMap.get(igMediaId) : null;

      if (!mediaInfo && post.published_at) {
        const postTime = new Date(post.published_at + "Z").getTime();
        for (const [id, m] of igMediaMap) {
          if (Math.abs(new Date(m.timestamp).getTime() - postTime) < 5 * 60 * 1000) {
            igMediaId = id;
            mediaInfo = m;
            // Fix the stale media ID in DB
            db.prepare(`UPDATE posts SET ig_media_id=? WHERE id=?`).run(id, post.id);
            console.log(`🔧 [Insights] Updated ig_media_id for post ${post.id}: ${post.ig_media_id} → ${id}`);
            break;
          }
        }
      }

      if (igMediaId && mediaInfo) {
        try {
          const metrics = await fetchIGInsights(igMediaId, pageToken, mediaInfo);
          upsertInsights(post.id, post.salon_id, metrics);
          synced++;
        } catch (err) {
          errors.push(`IG ${igMediaId}: ${err.message}`);
        }
      } else if (post.ig_media_id) {
        errors.push(`IG ${post.ig_media_id}: not found in IG media list (may be from a different account)`);
      }
    } else if (post.ig_media_id) {
      // No igBusinessId configured — skip IG sync
      errors.push(`IG ${post.ig_media_id}: no instagram_business_id configured for salon`);
    }
  }

  // ── Google Business Profile ────────────────────────────────────────────────
  if (salon.google_location_id && salon.google_refresh_token) {
    await syncGmbInsights(salon);
  }

  return { synced, errors };
}
