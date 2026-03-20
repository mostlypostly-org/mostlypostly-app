// src/core/composeFinalCaption.js
// ✅ Unified caption builder with intelligent spacing between sections

import { buildTrackingToken, buildShortUrl } from './trackingUrl.js';

const BRAND_TAG = process.env.MOSTLYPOSTLY_BRAND_TAG || "#MostlyPostly";

/**
 * Compose a final caption string with consistent, readable formatting.
 * - Merges AI + salon hashtags + brand tag (deduped)
 * - Handles both text and HTML modes
 * - Auto-adds clean spacing between caption, stylist, hashtags, CTA, and booking
 * - Enforces Instagram rule: no URLs + “Book via link in bio.”
 */

function normalizeHashtags(input) {
  if (!input) return [];

  // If already an array
  if (Array.isArray(input)) {
    return input
      .map(h => String(h).trim())
      .filter(Boolean);
  }

  // If JSON string
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed
          .map(h => String(h).trim())
          .filter(Boolean);
      }
    } catch {
      // Fall through
    }

    // Space or comma separated string
    return input
      .split(/[\s,]+/)
      .map(h => h.trim())
      .filter(Boolean);
  }

  return [];
}

export function composeFinalCaption({
  caption,
  hashtags = [],
  cta,
  instagramHandle,
  tiktokHandle,
  stylistName,
  bookingUrl,
  salon,
  platform = "generic",
  asHtml = false,
  salonId = null,
  postId = null,
  postType = null,
  stylistSlug = null,
  noBookingCta = false,
  }) {
  const parts = [];

  // --- Normalize inputs ---
  const text = (caption || "").trim();

  // Strip hashtags from AI caption text (hashtags are appended separately)
  // Also strip IG-only phrasing ("link in bio", "book via link in bio") that AI sometimes generates
  const cleanedText = text
    .replace(/#[\w-]+/g, "")
    .replace(/book via link in bio\.?/gi, "")
    .replace(/link in bio\.?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const ctaText = (cta || "").trim();
  const handle = ((instagramHandle || "") + "")
    .replace(/^@+/, "")
    .trim();
  const creditName = (stylistName || "").trim();
  const booking = (bookingUrl || "").trim();

  // --- 1️⃣ Caption body ---
  if (cleanedText) parts.push(cleanedText);


  // --- 2️⃣ "Styled By:" credit ---
  // TikTok: @tiktok_handle if set, else name; IG: @ig_handle if set, else name; FB: full name
  let credit = creditName ? `Styled By: ${creditName}` : "Styled By: Team Member";

  const ttHandle = ((tiktokHandle || "") + "").replace(/^@+/, "").trim();

  if (platform === "tiktok") {
    if (ttHandle) {
      credit = `Styled By: @${ttHandle}`;
    } else if (creditName) {
      credit = `Styled By: ${creditName}`;
    }
  } else if (platform === "instagram") {
    // IG → @handle if available, else full name
    if (handle) {
      credit = `Styled By: @${handle}`;
    } else if (creditName) {
      credit = `Styled By: ${creditName}`;
    }
  } else {
    // FB / generic: full name preferred over handle
    if (creditName) {
      credit = asHtml
        ? `Styled By: <a href="https://instagram.com/${handle || ""}">${creditName}</a>`
        : `Styled By: ${creditName}`;
    } else if (handle) {
      credit = `Styled By: @${handle}`;
    }
  }

  parts.push(credit);

  // --- 3️⃣ Hashtags ---
  const aiTags = normalizeHashtags(hashtags);
  const salonDefaults = normalizeHashtags(
    salon?.default_hashtags || salon?.salon_info?.default_hashtags
  );

  const tags = _mergeHashtags(aiTags, salonDefaults, BRAND_TAG);
  if (tags.length) parts.push(tags.join(" "));

  // --- 4️⃣ CTA ---
  if (ctaText) parts.push(ctaText);

  //
  // -------------------------------------------------------
  // INSTAGRAM RULES
  // -------------------------------------------------------
  //
  if (platform === "instagram") {
    let captionOut = parts.join("\n\n");

    // 1) Remove ALL URLs
    captionOut = captionOut.replace(/https?:\/\/\S+/gi, "").trim();

    // 2) Remove any leftover "Book:" / "Book now" lines (remnants after URL strip)
    captionOut = captionOut.replace(/^Book(?:\s*now)?:?\s*$/gim, "").trim();

    // 3) Strip "Book via link in bio" / "link in bio" that AI may have included
    //    (we control this ourselves below)
    captionOut = captionOut.replace(/book via link in bio\.?/gi, "").trim();

    // 4) Ensure correct CTA (only when a booking URL exists and not suppressed)
    if (booking && !noBookingCta && !captionOut.includes("Book via link in bio.")) {
      captionOut += `\n\nBook via link in bio.`;
    }

    // 5) Collapse multiple blank lines
    captionOut = captionOut.replace(/\n{3,}/g, "\n\n").trim();

    return captionOut;
  }

  // --- 5️⃣ Booking URL (non-IG only) ---
  // When salonId + postId are available, inject a tracking short URL so clicks
  // can be attributed in utm_clicks. Falls back to raw URL on any error.
  if (booking) {
    let bookingLine = `Book: ${booking}`;
    if (salonId && postId) {
      try {
        const token = buildTrackingToken({
          salonId,
          postId,
          clickType: 'booking',
          utmContent: postType || 'standard_post',
          utmTerm: stylistSlug || null,
          destination: booking,
        });
        bookingLine = `Book: ${buildShortUrl(token)}`;
      } catch {
        // fallback to raw URL — never block caption generation
      }
    }
    parts.push(bookingLine);
  }

  //
  // -------------------------------------------------------
  // NON-INSTAGRAM: Normal handling
  // -------------------------------------------------------
  //
  if (asHtml) return parts.join("<br/><br/>"); // double line for HTML

  // In plain text, insert exactly one blank line between non-empty blocks
  const spaced = [];
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i].trim();
    if (!cur) continue;
    if (spaced.length && spaced[spaced.length - 1] !== "") spaced.push(""); // blank line before new block
    spaced.push(cur);
  }
  return spaced.join("\n");
}

const MAX_HASHTAGS = 10;
const MAX_AI_HASHTAGS = 2;

/**
 * Merge and dedupe hashtags case-insensitively.
 * AI tags are capped at MAX_AI_HASHTAGS. Total capped at MAX_HASHTAGS.
 * Order: AI tags → salon defaults → brand tag.
 */
export function _mergeHashtags(aiTags = [], salonDefaults = [], brandTag = BRAND_TAG) {
  const cappedAi = (aiTags || []).slice(0, MAX_AI_HASHTAGS);
  const incoming = [...cappedAi, ...(salonDefaults || []), brandTag];
  const seen = new Set();
  const out = [];
  for (const raw of incoming) {
    const t = (raw || "").trim();
    if (!t) continue;
    const normalized = t.startsWith("#") ? t : `#${t}`;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}
