// src/core/composeFinalCaption.js
// ✅ Unified caption builder with intelligent spacing between sections

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
  stylistName,
  bookingUrl,
  salon,
  platform = "generic",
  asHtml = false
  }) {
  const parts = [];

  // --- Normalize inputs ---
  const text = (caption || "").trim();

  // Strip hashtags from AI caption text (hashtags are appended separately)
  const cleanedText = text
    .replace(/#[\w-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const ctaText = (cta || "").trim();
  const handle = ((instagramHandle || salon?.salon_info?.instagram_handle || "") + "")
    .replace(/^@+/, "")
    .trim();
  const creditName = (stylistName || "").trim();
  const booking = (bookingUrl || "").trim();

  // --- 1️⃣ Caption body ---
  if (cleanedText) parts.push(cleanedText);


  // --- 2️⃣ "Styled by" credit ---
  let credit = "Styled by a stylist";

  if (platform === "instagram") {
    // IG → always show @handle if available
    if (handle) {
      credit = `Styled by @${handle}`;
    } else if (creditName) {
      credit = `Styled by ${creditName}`;
    }
  } else {
    // Other platforms preserve HTML option
    if (handle) {
      credit = asHtml
        ? `Styled by <a href="https://instagram.com/${handle}">@${handle}</a>`
        : `Styled by @${handle}`;
    } else if (creditName) {
      credit = `Styled by ${creditName}`;
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

  // --- 5️⃣ Booking URL (IG removes it later) ---
  if (booking) parts.push(`Book: ${booking}`);

  //
  // -------------------------------------------------------
  // INSTAGRAM RULES
  // -------------------------------------------------------
  //
  if (platform === "instagram") {
    let captionOut = parts.join("\n\n");

    // 1) Remove ALL URLs
    captionOut = captionOut.replace(/https?:\/\/\S+/gi, "").trim();

    // 2) Ensure correct CTA
    if (!captionOut.includes("Book via link in bio.")) {
      captionOut += `\n\nBook via link in bio.`;
    }

    // 3) Return IG-specific output
    return captionOut;
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

/**
 * Merge and dedupe hashtags case-insensitively.
 */
export function _mergeHashtags(aiTags = [], salonDefaults = [], brandTag = BRAND_TAG) {
  const incoming = [...(aiTags || []), ...(salonDefaults || []), brandTag];
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
  }
  return out;
}
