// src/publishers/tiktok.js
import { refreshTiktokToken } from "../core/tiktokTokenRefresh.js";

const API_BASE = "https://open.tiktokapis.com/v2";

// Privacy level preference order — most public first.
// TikTok requires the value to be in the creator's allowed list.
const PRIVACY_PREFERENCE = [
  "PUBLIC_TO_EVERYONE",
  "FOLLOWER_OF_CREATOR",
  "MUTUAL_FOLLOW_FRIENDS",
  "SELF_ONLY",
];

/**
 * Query the creator info endpoint to get account-specific posting constraints.
 * Returns privacy_level_options, disable_* flags, etc.
 * Falls back to safe defaults on any error so publish can still proceed.
 */
async function getCreatorInfo(accessToken) {
  try {
    const resp = await fetch(`${API_BASE}/post/publish/creator_info/query/`, {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({}),
    });
    const data = await resp.json();
    if (resp.ok && data.error?.code === "ok" && data.data) {
      return data.data;
    }
    console.warn("[TikTok] creator_info query returned non-ok:", JSON.stringify(data.error));
  } catch (err) {
    console.warn("[TikTok] creator_info query failed:", err.message);
  }
  // Safe fallback — let TikTok reject if needed rather than crashing here
  return {
    privacy_level_options: ["PUBLIC_TO_EVERYONE"],
    comment_disabled: false,
    duet_disabled:    false,
    stitch_disabled:  false,
  };
}

/**
 * Pick the most public privacy level the creator actually supports.
 */
function pickPrivacyLevel(creatorInfo) {
  const allowed = creatorInfo?.privacy_level_options ?? [];
  for (const level of PRIVACY_PREFERENCE) {
    if (allowed.includes(level)) return level;
  }
  // If TikTok returns an unexpected list, use the first option they provided
  return allowed[0] ?? "PUBLIC_TO_EVERYONE";
}

/**
 * Publish a photo post to TikTok.
 * @param {object} salon - Full salon row (needs tiktok_access_token, slug)
 * @param {string[]} imageUrls - Array of 1–35 public image URLs
 * @param {string} caption - Caption text (max 2200 chars)
 * @returns {string} publish_id
 */
export async function publishPhotoToTikTok(salon, imageUrls, caption) {
  const accessToken = await refreshTiktokToken(salon);

  const validImages = imageUrls.filter(Boolean).slice(0, 35);
  if (validImages.length === 0) {
    throw new Error("[TikTok] Photo post requires at least one image URL");
  }

  const safeCaption = (caption || "").trim().slice(0, 2200) || ".";

  const creatorInfo  = await getCreatorInfo(accessToken);
  const privacyLevel = pickPrivacyLevel(creatorInfo);
  console.log(`[TikTok] Using privacy_level=${privacyLevel} for salon ${salon.slug}`);

  const body = {
    post_info: {
      title:         safeCaption,
      privacy_level: privacyLevel,
    },
    source_info: {
      source:            "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images:      validImages,
    },
    post_mode:  "DIRECT_POST",
    media_type: "PHOTO",
  };

  console.log(`[TikTok] Photo post_info:`, JSON.stringify(body.post_info));
  console.log(`[TikTok] Photo source_info images:`, validImages.length, validImages[0]?.slice(0,80));

  const resp = await fetch(`${API_BASE}/post/publish/content/init/`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok || data.error?.code !== "ok") {
    console.error(`[TikTok] Full error response:`, JSON.stringify(data));
    throw new Error(`[TikTok] Photo post failed: ${JSON.stringify(data.error || data)}`);
  }

  const publishId = data.data?.publish_id;
  if (!publishId) {
    throw new Error(`[TikTok] Photo post response missing publish_id: ${JSON.stringify(data)}`);
  }
  console.log(`[TikTok] Photo post published for salon ${salon.slug}: ${publishId}`);
  return publishId;
}

/**
 * Publish a video Reel to TikTok.
 * @param {object} salon - Full salon row
 * @param {string} videoUrl - Public URL to the video (mp4/mov)
 * @param {string} caption - Caption text (max 2200 chars)
 * @returns {string} publish_id
 */
export async function publishVideoToTikTok(salon, videoUrl, caption) {
  const accessToken = await refreshTiktokToken(salon);

  if (!videoUrl) {
    throw new Error("[TikTok] Video post requires a video URL");
  }

  const safeCaption = (caption || "").trim().slice(0, 2200) || ".";

  const creatorInfo  = await getCreatorInfo(accessToken);
  const privacyLevel = pickPrivacyLevel(creatorInfo);
  console.log(`[TikTok] Using privacy_level=${privacyLevel} for salon ${salon.slug}`);

  const body = {
    post_info: {
      title:           safeCaption,
      privacy_level:   privacyLevel,
      disable_duet:    creatorInfo.duet_disabled    ?? false,
      disable_stitch:  creatorInfo.stitch_disabled  ?? false,
      disable_comment: creatorInfo.comment_disabled ?? false,
    },
    source_info: {
      source:    "PULL_FROM_URL",
      video_url: videoUrl,
    },
    post_mode:  "DIRECT_POST",
    media_type: "VIDEO",
  };

  const resp = await fetch(`${API_BASE}/post/publish/video/init/`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json();
  if (!resp.ok || data.error?.code !== "ok") {
    throw new Error(`[TikTok] Video post failed: ${JSON.stringify(data.error || data)}`);
  }

  const publishId = data.data?.publish_id;
  if (!publishId) {
    throw new Error(`[TikTok] Video post response missing publish_id: ${JSON.stringify(data)}`);
  }
  console.log(`[TikTok] Video post published for salon ${salon.slug}: ${publishId}`);
  return publishId;
}
