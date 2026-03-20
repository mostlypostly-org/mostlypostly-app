// src/core/gamification.js
// Core logic for FEAT-015: Stylist Gamification & Leaderboard
//
// Points are computed at query time from the posts table — never stored
// per-post. This keeps the data always accurate and avoids drift if
// point values are changed retroactively.

import crypto from "crypto";
import { db } from "../../db.js";
import { DateTime } from "luxon";

// ─── System defaults ─────────────────────────────────────────────────────────

export const DEFAULT_POINTS = {
  standard_post:     10,
  before_after:      15,
  availability:       8,
  promotions:        12,
  celebration:        5,
  product_education: 10,
  vendor_promotion:   5,
  reel:              20,
};

// Map DB post_type values (may have underscores or spaces) to canonical keys
function canonicalType(raw = "") {
  return raw.toLowerCase().replace(/\s+/g, "_").trim();
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

export function getSettings(salonId) {
  return db.prepare(
    `SELECT * FROM gamification_settings WHERE salon_id = ?`
  ).get(salonId) || null;
}

export function getOrCreateSettings(salonId) {
  const existing = getSettings(salonId);
  if (existing) return existing;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO gamification_settings (id, salon_id)
    VALUES (?, ?)
    ON CONFLICT(salon_id) DO NOTHING
  `).run(id, salonId);

  return getSettings(salonId);
}

export function getPointValue(salonId, postType) {
  const settings = getSettings(salonId);
  const key = canonicalType(postType);
  const dbKey = `pts_${key}`;
  if (settings && settings[dbKey] != null) return settings[dbKey];
  return DEFAULT_POINTS[key] ?? 10;
}

// ─── Bonus / double-points ────────────────────────────────────────────────────

export function isBonusActive(salonId) {
  const s = getSettings(salonId);
  if (!s || s.bonus_multiplier <= 1 || !s.bonus_active_until) return false;
  return new Date(s.bonus_active_until) > new Date();
}

export function getBonusMultiplier(salonId) {
  return isBonusActive(salonId)
    ? (getSettings(salonId)?.bonus_multiplier ?? 1)
    : 1;
}

export function activateBonus(salonId, multiplier = 2, hours = 72) {
  getOrCreateSettings(salonId);
  const until = DateTime.utc().plus({ hours }).toISO();
  db.prepare(`
    UPDATE gamification_settings
    SET bonus_multiplier = ?, bonus_active_until = ?, updated_at = datetime('now')
    WHERE salon_id = ?
  `).run(multiplier, until, salonId);
  return until;
}

export function deactivateBonus(salonId) {
  db.prepare(`
    UPDATE gamification_settings
    SET bonus_multiplier = 1.0, bonus_active_until = NULL, updated_at = datetime('now')
    WHERE salon_id = ?
  `).run(salonId);
}

// ─── Shortage detection ───────────────────────────────────────────────────────

export function isShortage(salonId) {
  const s = getSettings(salonId);
  const threshold = s?.shortage_threshold ?? 5;

  const { count } = db.prepare(`
    SELECT COUNT(*) AS count FROM posts
    WHERE salon_id = ?
      AND status IN ('manager_approved')
      AND scheduled_for >= datetime('now')
      AND scheduled_for <= datetime('now', '+7 days')
  `).get(salonId);

  return { shortage: count < threshold, queued: count, threshold };
}

// ─── Period SQL helpers ───────────────────────────────────────────────────────

function periodFilter(period) {
  switch (period) {
    case "week":    return `AND date(published_at) >= date('now', '-6 days')`;
    case "month":   return `AND strftime('%Y-%m', published_at) = strftime('%Y-%m', 'now')`;
    case "quarter": return `AND published_at >= datetime('now', '-3 months')`;
    case "year":    return `AND strftime('%Y', published_at) = strftime('%Y', 'now')`;
    default:        return ""; // all time
  }
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

/**
 * Returns leaderboard rows for a salon, ranked by points descending.
 * Points = SUM over each post of getPointValue(postType) * bonusMultiplier (if active during that post's published_at).
 *
 * Because bonus periods can change retroactively, we apply the CURRENT multiplier
 * to all posts in the selected period. This is intentional — it matches the
 * "double points this week" framing (the whole period gets the bonus).
 */
export function getLeaderboard(salonId, period = "month") {
  const pf = periodFilter(period);
  const multiplier = getBonusMultiplier(salonId);

  // Pull all published posts in the period for this salon
  const posts = db.prepare(`
    SELECT stylist_name, post_type, COUNT(*) AS cnt
    FROM posts
    WHERE salon_id = ?
      AND status = 'published'
      AND stylist_name IS NOT NULL
      AND stylist_name != ''
      AND stylist_name NOT LIKE '% (Campaign)'
      ${pf}
    GROUP BY stylist_name, post_type
    ORDER BY stylist_name
  `).all(salonId);

  // Aggregate by stylist
  const map = new Map();
  for (const row of posts) {
    const name = row.stylist_name;
    if (!map.has(name)) {
      map.set(name, { stylist_name: name, points: 0, post_count: 0, by_type: {} });
    }
    const entry = map.get(name);
    const pts = getPointValue(salonId, row.post_type) * row.cnt * multiplier;
    entry.points += pts;
    entry.post_count += row.cnt;
    const ct = canonicalType(row.post_type);
    entry.by_type[ct] = (entry.by_type[ct] || 0) + row.cnt;
  }

  // Add streak
  const stylists = [...map.values()];
  for (const s of stylists) {
    s.streak = getStreak(salonId, s.stylist_name);
    s.points = Math.round(s.points);
  }

  // Sort by points desc, then post_count desc
  stylists.sort((a, b) => b.points - a.points || b.post_count - a.post_count);

  // Assign ranks (ties share rank)
  let rank = 1;
  for (let i = 0; i < stylists.length; i++) {
    if (i > 0 && stylists[i].points < stylists[i - 1].points) rank = i + 1;
    stylists[i].rank = rank;
  }

  return stylists;
}

// ─── Coordinator Leaderboard ─────────────────────────────────────────────────

/**
 * Returns coordinator leaderboard rows ranked by points descending.
 * Points = SUM of (getPointValue(postType) * 0.5) per post submitted by coordinator.
 * Coordinators are identified by posts.submitted_by JOIN managers.id.
 */
export function getCoordinatorLeaderboard(salonId, period = "month") {
  const pf = periodFilter(period);

  const posts = db.prepare(`
    SELECT m.name AS coordinator_name, m.id AS coordinator_id, p.post_type, COUNT(*) AS cnt
    FROM posts p
    JOIN managers m ON m.id = p.submitted_by
    WHERE p.salon_id = ?
      AND p.status = 'published'
      AND p.submitted_by IS NOT NULL
      ${pf}
    GROUP BY p.submitted_by, p.post_type
    ORDER BY m.name
  `).all(salonId);

  const map = new Map();
  for (const row of posts) {
    const name = row.coordinator_name;
    if (!map.has(name)) {
      map.set(name, { coordinator_name: name, coordinator_id: row.coordinator_id, points: 0, post_count: 0 });
    }
    const entry = map.get(name);
    const pts = Math.round(getPointValue(salonId, row.post_type) * 0.5) * row.cnt;
    entry.points += pts;
    entry.post_count += row.cnt;
  }

  const coordinators = [...map.values()];
  coordinators.sort((a, b) => b.points - a.points || b.post_count - a.post_count);

  let rank = 1;
  for (let i = 0; i < coordinators.length; i++) {
    if (i > 0 && coordinators[i].points < coordinators[i - 1].points) rank = i + 1;
    coordinators[i].rank = rank;
  }

  return coordinators;
}

// ─── Streak ───────────────────────────────────────────────────────────────────

/**
 * Counts consecutive calendar weeks (Mon–Sun) with at least one published post.
 * Starts from the most recent completed week and walks backwards.
 */
function getStreak(salonId, stylistName) {
  // Get distinct ISO weeks with at least one published post
  const weeks = db.prepare(`
    SELECT DISTINCT strftime('%Y-%W', published_at) AS yw
    FROM posts
    WHERE salon_id = ?
      AND stylist_name = ?
      AND status = 'published'
    ORDER BY yw DESC
  `).all(salonId, stylistName).map(r => r.yw);

  if (!weeks.length) return 0;

  // Build a set for O(1) lookup
  const weekSet = new Set(weeks);

  // Start from current week and walk back
  let streak = 0;
  let cursor = DateTime.utc().startOf("week"); // Monday

  // If no post yet this week, start checking from last week
  const thisWeekKey = cursor.toFormat("yyyy-WW").replace("-", "-").slice(0, 7);
  if (!weekSet.has(thisWeekKey)) {
    cursor = cursor.minus({ weeks: 1 });
  }

  for (let i = 0; i < 52; i++) {
    const key = cursor.toFormat("yyyy") + "-" + cursor.toFormat("WW");
    if (!weekSet.has(key)) break;
    streak++;
    cursor = cursor.minus({ weeks: 1 });
  }

  return streak;
}

// ─── Recent posts (for TV display) ───────────────────────────────────────────

export function getRecentPublishedPosts(salonId, limit = 8) {
  return db.prepare(`
    SELECT id, stylist_name, image_url, final_caption, post_type, published_at
    FROM posts
    WHERE salon_id = ?
      AND status = 'published'
      AND image_url IS NOT NULL
    ORDER BY published_at DESC
    LIMIT ?
  `).all(salonId, limit);
}

// ─── Leaderboard token ────────────────────────────────────────────────────────

export function getOrCreateLeaderboardToken(salonId) {
  const row = db.prepare("SELECT leaderboard_token FROM salons WHERE slug = ?").get(salonId);
  if (row?.leaderboard_token) return row.leaderboard_token;

  const token = crypto.randomUUID();
  db.prepare("UPDATE salons SET leaderboard_token = ? WHERE slug = ?").run(token, salonId);
  return token;
}

export function regenerateLeaderboardToken(salonId) {
  const token = crypto.randomUUID();
  db.prepare("UPDATE salons SET leaderboard_token = ? WHERE slug = ?").run(token, salonId);
  return token;
}

export function getSalonByLeaderboardToken(token) {
  return db.prepare(
    `SELECT slug, name, logo_url, tone, leaderboard_token FROM salons WHERE leaderboard_token = ?`
  ).get(token) || null;
}
