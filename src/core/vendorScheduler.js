// src/core/vendorScheduler.js
// FEAT-014 — Vendor Post Scheduling Engine
//
// Runs daily. For each Pro salon with enabled + approved vendor feeds:
//   1. Finds active, non-expired campaigns under that vendor
//   2. Checks this month's post count vs frequency_cap
//   3. Generates an AI caption adapted to the salon's tone
//   4. Creates a post (manager_pending or enqueued) with vendor_campaign_id
//   5. Logs to vendor_post_log for cap tracking

import crypto from "crypto";
import { db } from "../../db.js";
import { enqueuePost } from "../scheduler.js";

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

async function generateVendorCaption({ campaign, salon, affiliateUrl }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn("Missing OPENAI_API_KEY — skipping vendor caption generation");
    return null;
  }

  const salonName = salon.name || "the salon";
  const tone      = salon.tone || "friendly and professional";

  // Validate affiliate URL — skip if malformed to prevent prompt injection
  let safeAffiliateUrl = null;
  if (affiliateUrl) {
    try {
      const parsed = new URL(affiliateUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        safeAffiliateUrl = parsed.href;
      } else {
        log.warn(`Skipping non-HTTP affiliate URL for campaign ${campaign.id}: ${affiliateUrl}`);
      }
    } catch {
      log.warn(`Invalid affiliate URL for campaign ${campaign.id}: ${affiliateUrl}`);
    }
  }

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
${campaign.tone_direction ? `Brand tone direction: ${campaign.tone_direction}` : ""}
${campaign.cta_instructions ? `CTA instructions: ${campaign.cta_instructions}` : ""}
${campaign.service_pairing_notes ? `Service pairing notes: ${campaign.service_pairing_notes}` : ""}
${safeAffiliateUrl ? `Include this partner link in the post: ${safeAffiliateUrl}` : ""}

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
  const thisMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

  log.info(`Running vendor scheduler for month: ${thisMonth}`);

  // 1. Get all Pro salons (active or trialing)
  const proSalons = db.prepare(`
    SELECT slug, name, tone, default_hashtags, require_manager_approval,
           posting_start_time, posting_end_time
    FROM salons
    WHERE plan IN ('pro')
      AND plan_status IN ('active', 'trialing')
  `).all();

  log.info(`Found ${proSalons.length} Pro salon(s)`);

  let totalCreated = 0;

  for (const salon of proSalons) {
    try {
      totalCreated += await processSalon(salon, thisMonth);
    } catch (err) {
      log.warn(`Error processing salon ${salon.slug}: ${err.message}`);
    }
  }

  log.info(`Vendor scheduler complete. Created ${totalCreated} post(s).`);
  return totalCreated;
}

async function processSalon(salon, thisMonth) {
  const salonId = salon.slug;
  let created = 0;

  // 2. Get enabled vendor feeds for this salon (Pro plan is the gate)
  const enabledVendors = db.prepare(`
    SELECT f.vendor_name, f.affiliate_url, f.category_filters
    FROM salon_vendor_feeds f
    WHERE f.salon_id = ?
      AND f.enabled = 1
  `).all(salonId);

  if (enabledVendors.length === 0) return 0;

  // 3. For each enabled vendor, get active non-expired campaigns (with optional category filter)
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
      try {
        const didCreate = await processCampaign(campaign, salon, thisMonth, affiliateUrl);
        if (didCreate) created++;
      } catch (err) {
        log.warn(`Error processing campaign ${campaign.id} for salon ${salonId}: ${err.message}`);
      }
    }
  }

  return created;
}

async function processCampaign(campaign, salon, thisMonth, affiliateUrl) {
  const salonId = salon.slug;

  // 4. Check monthly post count against frequency_cap
  const cap = campaign.frequency_cap || 4;
  const { count: monthCount } = db.prepare(`
    SELECT COUNT(*) AS count
    FROM vendor_post_log
    WHERE salon_id = ? AND campaign_id = ? AND posted_month = ?
  `).get(salonId, campaign.id, thisMonth);

  if (monthCount >= cap) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: at cap (${monthCount}/${cap})`);
    return false;
  }

  // 5. Make sure we haven't already scheduled a pending/approved post from this
  //    campaign this month (avoid duplicating on repeated scheduler runs)
  const existing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM posts
    WHERE salon_id = ?
      AND vendor_campaign_id = ?
      AND status IN ('manager_pending', 'manager_approved', 'published')
      AND strftime('%Y-%m', created_at) = ?
  `).get(salonId, campaign.id, thisMonth);

  if ((existing?.count || 0) > 0) {
    log.info(`  Salon ${salonId} / campaign ${campaign.id}: post already exists this month, skipping`);
    return false;
  }

  // 6. Require a photo — both FB and IG need an image URL
  if (!campaign.photo_url) {
    log.warn(`  Skipping campaign ${campaign.id} ("${campaign.campaign_name}") — no photo_url set`);
    return false;
  }

  // Generate AI caption adapted to salon's tone
  log.info(`  Generating caption for salon ${salonId} / campaign "${campaign.campaign_name}"`);
  const caption = await generateVendorCaption({ campaign, salon, affiliateUrl });

  if (!caption) {
    log.warn(`  Skipping campaign ${campaign.id} — caption generation failed`);
    return false;
  }

  // Build locked hashtag block — appended AFTER AI caption, never passed to AI
  const brandCfg = db.prepare(
    `SELECT brand_hashtags FROM vendor_brands WHERE vendor_name = ?`
  ).get(campaign.vendor_name);
  const brandHashtags = (() => {
    try { return JSON.parse(brandCfg?.brand_hashtags || "[]"); } catch { return []; }
  })();
  const salonDefaultTags = (() => {
    try { return JSON.parse(salon.default_hashtags || "[]"); } catch { return []; }
  })();
  const lockedBlock = buildVendorHashtagBlock({
    salonHashtags: salonDefaultTags,
    brandHashtags,
    productHashtag: campaign.product_hashtag || null,
  });
  const finalCaption = caption + (lockedBlock ? `\n\n${lockedBlock}` : "");

  // 7. Compute next salon post number
  const { maxnum } = db.prepare(
    `SELECT MAX(salon_post_number) AS maxnum FROM posts WHERE salon_id = ?`
  ).get(salonId) || {};
  const salon_post_number = (maxnum || 0) + 1;

  // 8. Build the post row
  const postId = crypto.randomUUID();
  const now    = new Date().toISOString();
  const status = salon.require_manager_approval ? "manager_pending" : "manager_approved";

  db.prepare(`
    INSERT INTO posts (
      id, salon_id, stylist_name, image_url,
      base_caption, final_caption,
      post_type, status,
      vendor_campaign_id,
      salon_post_number, created_at, updated_at
    ) VALUES (
      @id, @salon_id, @stylist_name, @image_url,
      @base_caption, @final_caption,
      @post_type, @status,
      @vendor_campaign_id,
      @salon_post_number, @created_at, @updated_at
    )
  `).run({
    id:                  postId,
    salon_id:            salonId,
    stylist_name:        `${campaign.vendor_name} (Campaign)`,
    image_url:           campaign.photo_url || null,
    base_caption:        caption,        // AI text only, no hashtags
    final_caption:       finalCaption,   // AI text + locked hashtag block
    post_type:           "standard_post",
    status,
    vendor_campaign_id:  campaign.id,
    salon_post_number,
    created_at:          now,
    updated_at:          now,
  });

  // 9. Log to vendor_post_log
  db.prepare(`
    INSERT INTO vendor_post_log (id, salon_id, campaign_id, post_id, posted_month, created_at)
    VALUES (@id, @salon_id, @campaign_id, @post_id, @posted_month, @created_at)
  `).run({
    id:           crypto.randomUUID(),
    salon_id:     salonId,
    campaign_id:  campaign.id,
    post_id:      postId,
    posted_month: thisMonth,
    created_at:   now,
  });

  // 10. If auto-enqueue (no manager approval required), schedule it
  if (status === "manager_approved") {
    try {
      const postRow = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(postId);
      if (postRow) enqueuePost(postRow);
    } catch (err) {
      log.warn(`  enqueuePost failed for vendor post ${postId}: ${err.message}`);
    }
  }

  log.info(`  ✅ Created vendor post ${postId} (${status}) for salon ${salonId} from campaign "${campaign.campaign_name}"`);
  return true;
}
