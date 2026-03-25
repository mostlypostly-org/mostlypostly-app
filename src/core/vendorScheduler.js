// src/core/vendorScheduler.js
// FEAT-014 — Vendor Post Scheduling Engine
//
// Runs daily. For each Pro salon with enabled + approved vendor feeds:
//   1. Finds active, non-expired campaigns under that vendor
//   2. Pre-schedules posts across a 30-day window (vendor_scheduled status)
//   3. Divides the window into cap equal intervals; fills only empty intervals
//   4. Generates an AI caption adapted to the salon's tone
//   5. Logs to vendor_post_log for cap tracking

import crypto from "crypto";
import { DateTime } from "luxon";
import { db } from "../../db.js";
import { appendUtm, slugify } from './utm.js';
import { buildTrackingToken, buildShortUrl } from './trackingUrl.js';
import { mapVendorCampaignType } from './contentType.js';

// Ensure a URL stored as a relative path (/uploads/...) becomes absolute.
function resolveUrl(url) {
  if (!url) return null;
  if (url.startsWith("/")) {
    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    return base ? `${base}${url}` : url;
  }
  return url;
}

const tag = "[VendorScheduler]";
const log = {
  info:  (...a) => console.log(tag, ...a),
  warn:  (...a) => console.warn(tag, ...a),
};

// ─── Exported helpers (testable pure functions) ──────────────────────────────

export function normalizeHashtag(raw) {
  if (!raw) return "";
  const t = String(raw).trim();
  if (!t) return "";
  const withHash = t.startsWith("#") ? t : `#${t}`;
  if (withHash.includes(" ")) return ""; // malformed — skip silently
  return withHash;
}

/**
 * Build the locked hashtag block for vendor posts.
 * Order: first 3 salon defaults + up to 2 brand hashtags + up to 1 product hashtag + #MostlyPostly
 * Deduplicates case-insensitively. Appended AFTER AI caption — never passed to AI.
 */
export function buildVendorHashtagBlock({ salonHashtags, brandHashtags, productHashtag }) {
  const BRAND_TAG = "#MostlyPostly";
  const seen = new Set();
  const out = [];

  const add = (tag) => {
    const t = normalizeHashtag(tag);
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  (salonHashtags || []).slice(0, 3).forEach(add);
  (brandHashtags || []).slice(0, 2).forEach(add);
  if (productHashtag) add(productHashtag);
  add(BRAND_TAG);

  return out.join(" ");
}

// =====================================================
// OpenAI caption generation for vendor posts
// =====================================================

export async function generateVendorCaption({ campaign, salon, brandCaption }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("Missing OPENAI_API_KEY — skipping vendor caption generation");
    return null;
  }

  const salonName = salon.name || "the salon";
  const tone      = salon.tone || "friendly and professional";

  const systemPrompt = `You are a social media expert writing Instagram and Facebook posts for a hair salon.
Write a single post caption that:
- Sounds like it comes from ${salonName}, a hair salon
- Matches the salon's tone: "${tone}"
- Promotes the product/service naturally without sounding like an ad
- Is 2-4 sentences max
- Does NOT mention specific prices
- Ends with a subtle CTA if CTA instructions are provided
- Does NOT include any hashtags`;

  const userPrompt = `Write a social media caption for the following vendor product/campaign:

Brand: ${campaign.vendor_name}
Campaign: ${campaign.campaign_name}
Product: ${campaign.product_name || campaign.campaign_name}
Description: ${campaign.product_description || ""}
${campaign.cta_instructions ? `CTA instructions: ${campaign.cta_instructions}` : ""}
${campaign.service_pairing_notes ? `Service pairing notes: ${campaign.service_pairing_notes}` : ""}
${brandCaption ? `\nBrand-provided caption (use as messaging reference — key product claims, language, and tone — but rewrite entirely in the salon's voice):\n${brandCaption}` : ""}

Remember: this is for ${salonName} — write in their voice (${tone}), not the brand's voice.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.75,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      log.warn(`OpenAI error for campaign ${campaign.id}: ${err}`);
      return null;
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    log.warn(`OpenAI fetch failed for campaign ${campaign.id}: ${err.message}`);
    return null;
  }
}

// =====================================================
// Core scheduler function
// =====================================================

export async function runVendorScheduler() {
  const LOOKAHEAD_DAYS = 14;
  const windowStart = new Date();
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(windowStart.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  log.info(`Running vendor scheduler. Window: ${windowStart.toISOString().slice(0,10)} → ${windowEnd.toISOString().slice(0,10)}`);

  const proSalons = db.prepare(`
    SELECT slug, name, tone, default_hashtags, require_manager_approval,
           posting_start_time, posting_end_time, timezone,
           COALESCE(vendor_monthly_cap, 8) AS vendor_monthly_cap
    FROM salons
    WHERE plan IN ('pro')
      AND plan_status IN ('active', 'trialing')
  `).all();

  log.info(`Found ${proSalons.length} Pro salon(s)`);

  let totalCreated = 0;
  for (const salon of proSalons) {
    try {
      totalCreated += await processSalon(salon, windowStart, windowEnd);
    } catch (err) {
      log.warn(`Error processing salon ${salon.slug}: ${err.message}`);
    }
  }

  log.info(`Vendor scheduler complete. Created ${totalCreated} post(s).`);
  return totalCreated;
}

async function processSalon(salon, windowStart, windowEnd) {
  const salonId = salon.slug;
  const monthlyCapTotal = salon.vendor_monthly_cap ?? 8;
  let created = 0;

  // 1. Count all vendor posts this month (any status including published) —
  //    this is the global throttle regardless of which campaign produced them.
  const monthStart = new Date(windowStart.getFullYear(), windowStart.getMonth(), 1);
  const monthEnd   = new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1);
  const monthStartSql = monthStart.toISOString().replace("T", " ").slice(0, 19);
  const monthEndSql   = monthEnd.toISOString().replace("T", " ").slice(0, 19);

  const { vendorMonthCount } = db.prepare(`
    SELECT COUNT(*) AS vendorMonthCount
    FROM posts
    WHERE salon_id = ?
      AND vendor_campaign_id IS NOT NULL
      AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
      AND scheduled_for >= ?
      AND scheduled_for < ?
  `).get(salonId, monthStartSql, monthEndSql);

  const monthlyBudgetRemaining = monthlyCapTotal - vendorMonthCount;

  if (monthlyBudgetRemaining <= 0) {
    log.info(`Salon ${salonId}: monthly vendor cap reached (${vendorMonthCount}/${monthlyCapTotal}) — skipping all campaigns`);
    return 0;
  }

  log.info(`Salon ${salonId}: monthly vendor budget ${vendorMonthCount}/${monthlyCapTotal} used, ${monthlyBudgetRemaining} remaining`);

  // 2. Get enabled vendor feeds for this salon (Pro plan is the gate)
  //    JOIN vendor_brands to get platform-level frequency controls.
  const enabledVendors = db.prepare(`
    SELECT f.vendor_name, f.affiliate_url, f.category_filters,
           f.frequency_cap AS salon_cap,
           COALESCE(b.min_gap_days, 3) AS min_gap_days,
           COALESCE(b.platform_max_cap, 6) AS platform_max_cap
    FROM salon_vendor_feeds f
    LEFT JOIN vendor_brands b ON b.vendor_name = f.vendor_name
    WHERE f.salon_id = ?
      AND f.enabled = 1
  `).all(salonId);

  if (enabledVendors.length === 0) return 0;

  // 3. Collect ALL campaigns across ALL enabled vendors into a flat list,
  //    then sort by last-scheduled timestamp (oldest first) so the campaign
  //    that was used most recently gets its NEXT slot after others.
  //    This promotes alternation: A → B → A → B rather than A A A → B B B.
  const allCampaignItems = [];

  for (const vendor of enabledVendors) {
    const vendorName      = vendor.vendor_name;
    const affiliateUrl    = vendor.affiliate_url || null;
    const categoryFilters = (() => {
      try { return JSON.parse(vendor.category_filters || "[]"); } catch { return []; }
    })();

    let campaignSql = `
      SELECT * FROM vendor_campaigns
      WHERE vendor_name = ?
        AND active = 1
        AND (expires_at IS NULL OR expires_at >= date('now'))
    `;
    const queryParams = [vendorName];
    if (categoryFilters.length > 0) {
      campaignSql += ` AND category IN (${categoryFilters.map(() => "?").join(",")})`;
      queryParams.push(...categoryFilters);
    }
    campaignSql += " ORDER BY created_at ASC";

    const campaigns = db.prepare(campaignSql).all(...queryParams);
    for (const campaign of campaigns) {
      allCampaignItems.push({ campaign, vendor, vendorName, affiliateUrl });
    }
  }

  // Look up each campaign's most recently scheduled/published post time
  for (const item of allCampaignItems) {
    const lastPost = db.prepare(`
      SELECT scheduled_for FROM posts
      WHERE salon_id = ? AND vendor_campaign_id = ?
        AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
        AND scheduled_for IS NOT NULL
      ORDER BY scheduled_for DESC LIMIT 1
    `).get(salonId, item.campaign.id);
    item.lastScheduledMs = lastPost?.scheduled_for
      ? new Date(lastPost.scheduled_for.replace(" ", "T") + "Z").getTime()
      : 0;
  }

  // Sort: campaign used least recently goes first → it gets earlier time slots
  allCampaignItems.sort((a, b) => a.lastScheduledMs - b.lastScheduledMs);

  if (allCampaignItems.length > 1) {
    const names = allCampaignItems.map(i => `"${i.campaign.campaign_name}" (last: ${i.lastScheduledMs ? new Date(i.lastScheduledMs).toISOString().slice(0,10) : 'never'})`);
    log.info(`Salon ${salonId}: campaign processing order → ${names.join(", ")}`);
  }

  let budgetRemaining = monthlyBudgetRemaining;

  // Round-robin: each campaign fills ONE slot per pass before any campaign gets a second.
  // This ensures true alternation (A → B → C → A) rather than (A A A → B B B).
  let anyCreated;
  do {
    anyCreated = false;
    for (const { campaign, vendor, vendorName, affiliateUrl } of allCampaignItems) {
      if (budgetRemaining <= 0) break;
      try {
        const count = await processCampaign(campaign, salon, windowStart, windowEnd, affiliateUrl, vendorName, vendor.min_gap_days, budgetRemaining, 1);
        if (count > 0) {
          created += count;
          budgetRemaining -= count;
          anyCreated = true;
        }
      } catch (err) {
        log.warn(`Error processing campaign ${campaign.id} for salon ${salonId}: ${err.message}`);
      }
    }
  } while (anyCreated && budgetRemaining > 0);

  return created;
}

async function processCampaign(campaign, salon, windowStart, windowEnd, affiliateUrl, vendorName, minGapDays, monthlyBudget, maxNewPosts = Infinity) {
  const salonId = salon.slug;
  const tz = salon.timezone || "America/Indiana/Indianapolis";
  const cap = Math.min(campaign.frequency_cap ?? 3, monthlyBudget ?? Infinity);

  // 4. Require a photo
  if (!campaign.photo_url) {
    log.warn(`  Skipping campaign ${campaign.id} ("${campaign.campaign_name}") — no photo_url set`);
    return 0;
  }

  // Clamp effective window end to campaign expiration date (end of that day, salon timezone)
  let effectiveWindowEnd = windowEnd;
  if (campaign.expires_at) {
    const expiryEndOfDay = DateTime.fromISO(campaign.expires_at, { zone: tz }).endOf("day").toJSDate();
    if (expiryEndOfDay < effectiveWindowEnd) {
      effectiveWindowEnd = expiryEndOfDay;
      log.info(`  Campaign ${campaign.id} expires ${campaign.expires_at} — clamping window to ${expiryEndOfDay.toISOString().slice(0, 10)}`);
    }
    if (effectiveWindowEnd <= windowStart) {
      log.info(`  Campaign ${campaign.id} expires before window start — skipping`);
      return 0;
    }
  }

  // Recalculate lookahead based on clamped window
  const effectiveLookaheadMs = effectiveWindowEnd.getTime() - windowStart.getTime();

  // 5. Count existing vendor posts from this campaign in the effective window
  const windowStartSql = windowStart.toISOString().replace("T", " ").slice(0, 19);
  const windowEndSql   = effectiveWindowEnd.toISOString().replace("T", " ").slice(0, 19);

  const { existingCount } = db.prepare(`
    SELECT COUNT(*) AS existingCount
    FROM posts
    WHERE salon_id = ?
      AND vendor_campaign_id = ?
      AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
      AND scheduled_for BETWEEN ? AND ?
  `).get(salonId, campaign.id, windowStartSql, windowEndSql);

  if (existingCount >= cap) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: window full (${existingCount}/${cap}) — skipping`);
    return 0;
  }

  // 6. Divide effective window into cap equal intervals; fill ALL empty intervals this run
  const intervalMs = effectiveLookaheadMs / cap;
  const minGapMs   = minGapDays * 24 * 60 * 60 * 1000;
  let created = 0;

  // Track latest scheduled time across ALL vendor campaigns for this salon (cross-campaign gap).
  // Includes published posts so manually-published vendor content is counted too.
  const latestExistingRow = db.prepare(`
    SELECT scheduled_for FROM posts
    WHERE salon_id = ?
      AND vendor_campaign_id IS NOT NULL
      AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
    ORDER BY scheduled_for DESC LIMIT 1
  `).get(salonId);
  let lastScheduledMs = latestExistingRow?.scheduled_for
    ? new Date(latestExistingRow.scheduled_for.replace(" ", "T") + "Z").getTime()
    : null;

  // 8. Build locked hashtag block (campaign-level constant — computed once, outside the loop)
  const brandCfg = db.prepare(`SELECT brand_hashtags FROM vendor_brands WHERE vendor_name = ?`).get(campaign.vendor_name);
  const brandHashtags = (() => { try { return JSON.parse(brandCfg?.brand_hashtags || "[]"); } catch { return []; } })();
  const salonDefaultTags = (() => { try { return JSON.parse(salon.default_hashtags || "[]"); } catch { return []; } })();
  const lockedBlock = buildVendorHashtagBlock({ salonHashtags: salonDefaultTags, brandHashtags, productHashtag: campaign.product_hashtag || null });

  for (let i = 0; i < cap; i++) {
    const intStart = new Date(windowStart.getTime() + i * intervalMs);
    const intEnd   = new Date(Math.min(windowStart.getTime() + (i + 1) * intervalMs, effectiveWindowEnd.getTime()));
    const intStartSql = intStart.toISOString().replace("T", " ").slice(0, 19);
    const intEndSql   = intEnd.toISOString().replace("T", " ").slice(0, 19);

    const { slotTaken } = db.prepare(`
      SELECT COUNT(*) AS slotTaken
      FROM posts
      WHERE salon_id = ?
        AND vendor_campaign_id = ?
        AND status IN ('vendor_scheduled','manager_pending','manager_approved','published')
        AND scheduled_for BETWEEN ? AND ?
    `).get(salonId, campaign.id, intStartSql, intEndSql);

    if (slotTaken > 0) continue; // manager moved a post here — respect it

    // Pin to interval midpoint ± 1 day jitter — keeps posts evenly spaced
    // rather than randomly distributed across the full interval (which causes large gaps).
    const dayMs = 24 * 60 * 60 * 1000;
    const midpointMs = intStart.getTime() + intervalMs / 2;
    const jitterMs = (Math.random() * 2 - 1) * dayMs; // -1 to +1 day
    const candidateDayMs = Math.max(intStart.getTime(), Math.min(intEnd.getTime() - dayMs, midpointMs + jitterMs));
    const candidateDay = new Date(candidateDayMs);

    const [startH, startM] = (salon.posting_start_time || "09:00").split(":").map(Number);
    const [endH,   endM]   = (salon.posting_end_time   || "20:00").split(":").map(Number);
    const windowMinutes = Math.max(1, (endH * 60 + endM) - (startH * 60 + startM));
    const randMinutes = Math.floor(Math.random() * windowMinutes);
    const postHour   = startH + Math.floor((startM + randMinutes) / 60);
    const postMinute = (startM + randMinutes) % 60;

    const localDt = DateTime.fromObject(
      { year: candidateDay.getUTCFullYear(), month: candidateDay.getUTCMonth() + 1, day: candidateDay.getUTCDate(),
        hour: postHour, minute: postMinute, second: 0 },
      { zone: tz }
    );
    const candidateMs  = localDt.toMillis();
    const scheduledFor = localDt.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

    // Enforce minimum gap between vendor posts for this campaign
    if (lastScheduledMs !== null && candidateMs - lastScheduledMs < minGapMs) {
      const gapDays = ((candidateMs - lastScheduledMs) / 86_400_000).toFixed(1);
      log.info(`  Skipping interval ${i} — gap ${gapDays}d < required ${minGapDays}d minimum`);
      continue;
    }

    // 7. Generate AI caption for this slot
    let caption;
    if (campaign.source === "pdf_sync" && campaign.caption_body) {
      log.info(`  Generating AI caption with PDF brand brief for salon ${salonId} / campaign "${campaign.campaign_name}" (interval ${i})`);
      caption = await generateVendorCaption({ campaign, salon, brandCaption: campaign.caption_body });
    } else {
      log.info(`  Generating AI caption for salon ${salonId} / campaign "${campaign.campaign_name}" (interval ${i})`);
      caption = await generateVendorCaption({ campaign, salon });
    }
    if (!caption) {
      log.warn(`  Skipping interval ${i} for campaign ${campaign.id} — no caption available`);
      continue; // skip this slot, try next interval
    }

    // 9. salon_post_number
    const { maxnum } = db.prepare(`SELECT MAX(salon_post_number) AS maxnum FROM posts WHERE salon_id = ?`).get(salonId) || {};
    const salon_post_number = (maxnum || 0) + 1;

    // 10. Build post
    const postId = crypto.randomUUID();
    const now    = new Date().toISOString();

    let trackedCaption;
    if (affiliateUrl) {
      const utmContent  = `vendor_${slugify(campaign.vendor_name)}`;
      const destination = appendUtm(affiliateUrl, { source: "mostlypostly", medium: "social", campaign: salonId, content: utmContent });
      try {
        const token    = buildTrackingToken({ salonId, postId, clickType: "vendor", vendorName: campaign.vendor_name, utmContent, destination });
        const shortUrl = buildShortUrl(token);
        trackedCaption = caption + "\n\nShop today: " + shortUrl + (lockedBlock ? "\n\n" + lockedBlock : "");
      } catch (err) {
        log.warn(`  UTM token creation failed: ${err.message}`);
        trackedCaption = caption + (lockedBlock ? "\n\n" + lockedBlock : "");
      }
    } else {
      trackedCaption = caption + (lockedBlock ? "\n\n" + lockedBlock : "");
    }

    const vendorContentType = mapVendorCampaignType(campaign.category);
    db.prepare(`
      INSERT INTO posts (id, salon_id, stylist_name, image_url, base_caption, final_caption,
                         post_type, status, vendor_campaign_id, scheduled_for, salon_post_number, created_at, updated_at,
                         content_type, placement)
      VALUES (@id, @salon_id, @stylist_name, @image_url, @base_caption, @final_caption,
              @post_type, @status, @vendor_campaign_id, @scheduled_for, @salon_post_number, @created_at, @updated_at,
              @content_type, @placement)
    `).run({
      id: postId, salon_id: salonId,
      stylist_name: `${campaign.vendor_name} (Campaign)`,
      image_url: resolveUrl(campaign.photo_url),
      base_caption: caption, final_caption: trackedCaption,
      post_type: "standard_post",
      status: "vendor_scheduled",
      vendor_campaign_id: campaign.id,
      scheduled_for: scheduledFor,
      salon_post_number,
      created_at: now, updated_at: now,
      content_type: vendorContentType,
      placement: "story",
    });

    // 11. Log to vendor_post_log
    const postedMonth = scheduledFor.slice(0, 7);
    db.prepare(`
      INSERT INTO vendor_post_log (id, salon_id, campaign_id, post_id, posted_month, created_at)
      VALUES (@id, @salon_id, @campaign_id, @post_id, @posted_month, @created_at)
    `).run({ id: crypto.randomUUID(), salon_id: salonId, campaign_id: campaign.id, post_id: postId, posted_month: postedMonth, created_at: now });

    lastScheduledMs = candidateMs;
    log.info(`  ✅ Created vendor_scheduled post ${postId} for salon ${salonId} → ${scheduledFor} (interval ${i})`);
    created++;
    if (created >= maxNewPosts) break; // yield to other campaigns in round-robin
  }

  if (created === 0) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: no new slots to fill (all taken or captions unavailable)`);
  }

  return created;
}
