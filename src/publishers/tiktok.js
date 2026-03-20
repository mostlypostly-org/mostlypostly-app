// src/publishers/tiktok.js
import { refreshTiktokToken } from "../core/tiktokTokenRefresh.js";

const API_BASE = "https://open.tiktokapis.com/v2";

/**
 * Publish a photo post to TikTok.
 * @param {object} salon - Full salon row (needs tiktok_access_token, slug)
 * @param {string[]} imageUrls - Array of 1–35 public image URLs
 * @param {string} caption - Caption text (max 2200 chars)
 * @returns {string} publish_id
 */
export async function publishPhotoToTikTok(salon, imageUrls, caption) {
  const accessToken = await refreshTiktokToken(salon);

  const body = {
    post_info: {
      title:           caption.slice(0, 2200),
      privacy_level:   "PUBLIC_TO_EVERYONE",
      disable_duet:    false,
      disable_stitch:  false,
      disable_comment: false,
      auto_add_music:  true,
    },
    source_info: {
      source:            "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images:      imageUrls.slice(0, 35),
    },
    post_mode:  "DIRECT_POST",
    media_type: "PHOTO",
  };

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
    throw new Error(`[TikTok] Photo post failed: ${JSON.stringify(data.error || data)}`);
  }

  const publishId = data.data?.publish_id;
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

  const body = {
    post_info: {
      title:           caption.slice(0, 2200),
      privacy_level:   "PUBLIC_TO_EVERYONE",
      disable_duet:    false,
      disable_stitch:  false,
      disable_comment: false,
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
  console.log(`[TikTok] Video post published for salon ${salon.slug}: ${publishId}`);
  return publishId;
}
