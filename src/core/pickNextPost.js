// src/core/pickNextPost.js — Cadence-aware post selector
//
// Selects the optimal next post to publish based on 7-day rolling
// content-type distribution, weekday rules, promotion caps, and reel bonus.
//
// SCHED-01: most under-represented type wins
// SCHED-02: standard posts stay within 50-60% of rolling window
// SCHED-03: before_after only on Tue/Wed/Thu
// SCHED-04: promotions capped at 2/week, never back-to-back
// SCHED-05: availability only on Tue/Wed/Thu
// SCHED-06: reels are bonus content — score -1, not counted in distribution

import { db } from '../../db.js';
import { DateTime } from 'luxon';
import { DEFAULT_PRIORITY } from '../scheduler.js';

// Target distribution ratios (min/max of 7-day rolling window)
const TARGETS = {
  standard_post:  { min: 0.50, max: 0.60 },
  before_after:   { min: 0.15, max: 0.20 },
  promotions:     { min: 0.00, max: 0.14 },
  availability:   { min: 0.00, max: 0.14 },
};

// Mid-week days: Tuesday(2), Wednesday(3), Thursday(4)
const MID_WEEK = new Set([2, 3, 4]);

/**
 * Selects the optimal next post to publish from a list of candidates.
 *
 * @param {Array} posts - Array of post objects with { id, post_type, ... }
 * @param {string} salonId - The salon slug to scope DB queries
 * @param {string} [timezone] - IANA timezone string (defaults to Indianapolis)
 * @returns {Object|null} The selected post, or null if posts array is empty
 */
export function pickNextPost(posts, salonId, timezone) {
  if (!posts.length) return null;

  const tz = timezone || 'America/Indiana/Indianapolis';

  // 1. Query content-type distribution from last 7 published posts (reels excluded)
  const distRows = db.prepare(`
    SELECT post_type, COUNT(*) AS cnt
    FROM (
      SELECT post_type FROM posts
      WHERE salon_id = ? AND status = 'published' AND post_type != 'reel'
      ORDER BY published_at DESC
      LIMIT 7
    )
    GROUP BY post_type
  `).all(salonId);

  // Build distribution map: { post_type: count }
  const dist = {};
  for (const row of distRows) {
    dist[row.post_type] = row.cnt;
  }

  // 2. Query the last published post type (for back-to-back promotion guard)
  const lastRow = db.prepare(`
    SELECT post_type FROM posts
    WHERE salon_id = ? AND status = 'published'
    ORDER BY published_at DESC LIMIT 1
  `).get(salonId);
  const lastPublishedType = lastRow?.post_type || null;

  // 3. Query promotion count in the last 7 days
  const promoRow = db.prepare(`
    SELECT COUNT(*) AS n FROM posts
    WHERE salon_id = ? AND status = 'published'
      AND post_type = 'promotions'
      AND datetime(published_at) >= datetime('now', '-7 days')
  `).get(salonId);
  const promoCount = promoRow?.n || 0;

  // 4. Determine current weekday using Luxon (1=Mon, 2=Tue, ..., 7=Sun)
  const localNow = DateTime.utc().setZone(tz);
  const weekday = localNow.weekday;
  const isMidWeek = MID_WEEK.has(weekday);

  // 5. Filter out ineligible candidates
  let filtered = posts.filter(post => {
    const type = post.post_type;

    // SCHED-03 + SCHED-05: availability and before_after only on mid-week days
    if (!isMidWeek && (type === 'availability' || type === 'before_after')) {
      return false;
    }

    // SCHED-04: cap promotions at 2/week
    if (type === 'promotions' && promoCount >= 2) {
      return false;
    }

    // SCHED-04: never publish promotions back-to-back
    if (type === 'promotions' && lastPublishedType === 'promotions') {
      return false;
    }

    return true;
  });

  // 6. If all candidates were filtered out, fall back to full posts array (never stall)
  if (filtered.length === 0) {
    filtered = posts;
  }

  // 7. Score each candidate by deficit from target ratio
  const totalRecent = Object.values(dist).reduce((a, b) => a + b, 0) || 1;

  const scored = filtered.map(post => {
    const type = post.post_type || 'standard_post';

    // SCHED-06: reel posts are bonus content — lowest priority score
    if (type === 'reel') {
      return { post, score: -1 };
    }

    const target = TARGETS[type] || { min: 0, max: 0.15 };
    const current = (dist[type] || 0) / totalRecent;
    const deficit = target.min - current; // positive = under-represented

    return { post, score: deficit };
  });

  // 8. Sort by deficit DESC (most needed first), tiebreak by DEFAULT_PRIORITY index
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
    const aIdx = DEFAULT_PRIORITY.indexOf(a.post.post_type || 'standard_post');
    const bIdx = DEFAULT_PRIORITY.indexOf(b.post.post_type || 'standard_post');
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  return scored[0]?.post || posts[0];
}
