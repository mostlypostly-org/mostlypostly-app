// src/core/fetchGmbInsights.js — Sync Google Business Profile local post insights
import { db } from "../../db.js";
import { refreshGmbToken } from "./googleTokenRefresh.js";

const GMB_BASE = "https://mybusiness.googleapis.com/v4";

/**
 * Syncs GMB local post insights for a salon into the post_insights table.
 * platform='google', impressions=VIEWS, link_clicks=CLICKS.
 * Best-effort: wraps everything in try/catch and never throws.
 */
export async function syncGmbInsights(salon) {
  try {
    const locationId = salon.google_location_id;
    if (!locationId) {
      console.warn(`[GMB Insights] No google_location_id for salon ${salon.slug}`);
      return { synced: 0 };
    }

    const accessToken = await refreshGmbToken(salon);

    // ── Fetch all local posts for this location ──────────────────────────────
    const listUrl = `${GMB_BASE}/${locationId}/localPosts?pageSize=100`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const listJson = await listRes.json();

    if (!listRes.ok || listJson.error) {
      console.warn(`[GMB Insights] Failed to list localPosts for ${salon.slug}:`, listJson.error?.message || listRes.status);
      return { synced: 0 };
    }

    const localPosts = listJson.localPosts || [];
    if (localPosts.length === 0) {
      console.log(`[GMB Insights] No local posts found for salon ${salon.slug}`);
      return { synced: 0 };
    }

    // ── Find which of those posts we have a record for in our DB ─────────────
    const knownPostIds = new Set(
      db.prepare("SELECT google_post_id FROM posts WHERE salon_id = ? AND google_post_id IS NOT NULL")
        .all(salon.slug).map(r => r.google_post_id)
    );

    const matchedPosts = localPosts.filter(p => knownPostIds.has(p.name));
    if (matchedPosts.length === 0) {
      console.log(`[GMB Insights] No matched local posts for salon ${salon.slug}`);
      return { synced: 0 };
    }

    const postNames = matchedPosts.map(p => p.name);

    // ── Build the time range (90 days back → now) ────────────────────────────
    const nowSec        = Math.floor(Date.now() / 1000);
    const ninetyDaysSec = nowSec - 90 * 24 * 60 * 60;

    const insightsBody = (metric) => JSON.stringify({
      localPostNames: postNames,
      basicMetric: metric,
      dailyRange: {
        startTime: { seconds: ninetyDaysSec },
        endTime:   { seconds: nowSec },
      },
    });

    const insightsHeaders = {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    // ── Fetch VIEW counts ────────────────────────────────────────────────────
    const viewsRes  = await fetch(`${GMB_BASE}/${locationId}/localPosts:reportInsights`, {
      method:  "POST",
      headers: insightsHeaders,
      body:    insightsBody("LOCAL_POST_VIEWS_SEARCH"),
    });
    const viewsJson = await viewsRes.json();

    if (!viewsRes.ok || viewsJson.error) {
      console.warn(`[GMB Insights] Views insights error for ${salon.slug}:`, viewsJson.error?.message || viewsRes.status);
    }

    // ── Fetch CLICK counts ───────────────────────────────────────────────────
    const clicksRes  = await fetch(`${GMB_BASE}/${locationId}/localPosts:reportInsights`, {
      method:  "POST",
      headers: insightsHeaders,
      body:    insightsBody("LOCAL_POST_ACTIONS_CALL_TO_ACTION"),
    });
    const clicksJson = await clicksRes.json();

    if (!clicksRes.ok || clicksJson.error) {
      console.warn(`[GMB Insights] Clicks insights error for ${salon.slug}:`, clicksJson.error?.message || clicksRes.status);
    }

    // ── Build lookup maps: localPostName → total metric value ────────────────
    function buildMetricMap(insightsResult) {
      const map = new Map();
      for (const item of (insightsResult.localPostMetrics || [])) {
        const total = (item.metricValues || []).reduce((sum, mv) => {
          // Each metricValue has a `value` field (string in GMB API — coerce to int)
          return sum + (parseInt(mv.value, 10) || 0);
        }, 0);
        map.set(item.localPostName, total);
      }
      return map;
    }

    const viewsMap  = buildMetricMap(viewsJson);
    const clicksMap = buildMetricMap(clicksJson);

    // ── Upsert insights for each matched post ────────────────────────────────
    const upsert = db.prepare(`
      INSERT INTO post_insights (post_id, platform, impressions, link_clicks, fetched_at)
      VALUES (?, 'google', ?, ?, datetime('now'))
      ON CONFLICT(post_id, platform) DO UPDATE SET
        impressions = excluded.impressions,
        link_clicks = excluded.link_clicks,
        fetched_at  = excluded.fetched_at
    `);

    let synced = 0;
    for (const localPostName of postNames) {
      const postRow = db.prepare("SELECT id FROM posts WHERE google_post_id = ? AND salon_id = ?")
        .get(localPostName, salon.slug);
      if (!postRow) continue;

      const views  = viewsMap.get(localPostName)  || 0;
      const clicks = clicksMap.get(localPostName) || 0;

      upsert.run(postRow.id, views, clicks);
      synced++;
    }

    console.log(`[GMB Insights] Synced ${synced} posts for salon ${salon.slug}`);
    return { synced };

  } catch (err) {
    console.error(`[GMB Insights] Error syncing salon ${salon.slug}:`, err.message);
    return { synced: 0 };
  }
}
