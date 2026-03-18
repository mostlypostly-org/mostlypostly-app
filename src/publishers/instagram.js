// src/publishers/instagram.js — multi-tenant + safe enhancements
import "../env.js";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { rehostTwilioMedia } from "../utils/rehostTwilioMedia.js";
import { logEvent } from "../core/analyticsDb.js";
import { db } from "../../db.js";

console.log("🌍 PUBLIC_BASE_URL =", process.env.PUBLIC_BASE_URL);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_GRAPH_VER = process.env.FB_GRAPH_VERSION || "v24.0";
const DEFAULT_IG_USER_ID = process.env.INSTAGRAM_USER_ID;
const DEFAULT_FB_TOKEN = process.env.FACEBOOK_GRAPH_TOKEN;

const IG_MEDIA_MAX_WAIT_MS = Number(process.env.IG_MEDIA_MAX_WAIT_MS || 30000);
const IG_MEDIA_POLL_INTERVAL_MS = Number(
  process.env.IG_MEDIA_POLL_INTERVAL_MS || 1500
);

const HOST_BASE = process.env.PUBLIC_BASE_URL;

if (!HOST_BASE) {
  throw new Error(
    "PUBLIC_BASE_URL is required for Instagram publishing (ngrok or production URL)"
  );
}

const PUBLIC_DIR =
  process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");

/**
 * Build the collaborators array for IG media creation.
 * Returns an array with the handle (without @) if the stylist is opted in,
 * or undefined if not.
 */
export function buildCollaborators(stylist) {
  if (!stylist?.ig_collab || !stylist?.instagram_handle) return undefined;
  const handle = stylist.instagram_handle.replace(/^@/, "").trim();
  if (!handle) return undefined;
  return [handle];
}

async function saveToPublic(jpgBuffer, filenameBase = Date.now().toString()) {
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
  const fileName = `${filenameBase}.jpg`;
  const fullPath = path.join(PUBLIC_DIR, fileName);
  await fs.writeFile(fullPath, jpgBuffer);
  return `${HOST_BASE}/public/${fileName}`;
}

async function ensurePublicImage(imageUrl, nameHint, salonId) {
  if (!imageUrl) throw new Error("Missing imageUrl");

  if (/^https:\/\/api\.twilio\.com\//i.test(imageUrl)) {
    console.log("🔄 [Instagram] Rehosting Twilio image…");
    return await rehostTwilioMedia(imageUrl, salonId || null);
  }

  if (/^https:\/\/api\.telegram\.org\/file\//i.test(imageUrl)) {
    const resp = await fetch(imageUrl);
    if (!resp.ok)
      throw new Error(`Telegram file fetch failed (${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1000)
      throw new Error("Downloaded image appears empty (size < 1KB).");
    return await saveToPublic(buf, nameHint);
  }

  return imageUrl;
}

async function createIgMedia({ userId, imageUrl, caption, token, graphVer, collaborators }) {
  const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || "",
    access_token: token,
  });
  if (collaborators?.length) {
    for (const handle of collaborators) {
      params.append("collaborators", handle);
    }
  }
  const resp = await fetch(url, { method: "POST", body: params });
  const data = await resp.json();
  if (!resp.ok || !data?.id) {
    throw new Error(
      `IG media create failed: ${resp.status} ${JSON.stringify(data)}`
    );
  }
  return data.id;
}

async function waitForContainer(creationId, token, graphVer) {
  const deadline = Date.now() + IG_MEDIA_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const url = `https://graph.facebook.com/${graphVer}/${creationId}?fields=status_code&access_token=${encodeURIComponent(
      token
    )}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data?.status_code === "FINISHED") return;
    if (data?.status_code === "ERROR")
      throw new Error("IG container ERROR status");
    await new Promise((r) => setTimeout(r, IG_MEDIA_POLL_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for IG container.");
}

async function publishContainer(creationId, userId, token, graphVer) {
  const url = `https://graph.facebook.com/${graphVer}/${userId}/media_publish`;
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: token,
  });
  const resp = await fetch(url, { method: "POST", body: params });
  const data = await resp.json();
  if (!resp.ok || !data?.id) {
    throw new Error(
      `IG media publish failed: ${resp.status} ${JSON.stringify(data)}`
    );
  }
  return data;
}

async function retryIg(fn, label, retries = 2, delayMs = 1500) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === retries) break;
      console.warn(
        `⚠️ [Instagram] Retry ${i + 1}/${retries} on ${label}:`,
        err.message
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function resolveIgCredentials(salon_id) {
  const salonRow = db
    .prepare(`SELECT instagram_business_id, facebook_page_token FROM salons WHERE id = ? OR slug = ? LIMIT 1`)
    .get(salon_id, salon_id);
  return {
    userId: salonRow?.instagram_business_id || DEFAULT_IG_USER_ID,
    token:  salonRow?.facebook_page_token  || DEFAULT_FB_TOKEN,
    graphVer: DEFAULT_GRAPH_VER,
  };
}

/**
 * publishToInstagramCarousel({ salon_id, caption, imageUrls })
 * Uses the IG Carousel API for 2–10 images.
 */
export async function publishToInstagramCarousel({ salon_id, caption, imageUrls }) {
  if (!salon_id) throw new Error("publishToInstagramCarousel: missing salon_id");
  if (!imageUrls?.length) throw new Error("publishToInstagramCarousel: no imageUrls");

  const { userId, token, graphVer } = await resolveIgCredentials(salon_id);
  if (!token || !userId) throw new Error("Missing Instagram credentials for carousel.");

  // Normalize caption (same as single-image path)
  let igCaption = (caption || "").trim();
  igCaption = igCaption.replace(/<a[^>]*href="https?:\/\/instagram\.com\/([^"]+)"[^>]*>@[^<]+<\/a>/gi, "@$1");
  igCaption = igCaption.replace(/https?:\/\/\S+/gi, "").trim();
  if (!/book via link in bio/i.test(igCaption)) {
    igCaption += (igCaption ? "\n\n" : "") + "Book via link in bio.";
  }

  console.log(`📷 [Instagram Carousel] ${imageUrls.length} images for salon_id=${salon_id}`);
  // Note: collaborator tagging is not supported on carousel posts (IG API limitation).
  // Opted-in stylists will still be @mentioned in the caption but won't receive a
  // collab invite. Single-image posts via publishToInstagram() do support collaborators.

  // 1. Rehost and create a carousel item container for each image
  const itemIds = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const publicUrl = await ensurePublicImage(imageUrls[i], `${Date.now()}_${i}`, salon_id);
    const itemId = await retryIg(async () => {
      const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
      const params = new URLSearchParams({
        image_url: publicUrl,
        is_carousel_item: "true",
        access_token: token,
      });
      const resp = await fetch(url, { method: "POST", body: params });
      const data = await resp.json();
      if (!resp.ok || !data?.id) {
        throw new Error(`IG carousel item ${i} create failed: ${resp.status} ${JSON.stringify(data)}`);
      }
      return data.id;
    }, `carousel item ${i}`);
    itemIds.push(itemId);
  }

  // 2. Create the carousel container
  const carouselId = await retryIg(async () => {
    const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
    const params = new URLSearchParams({
      media_type: "CAROUSEL",
      children: itemIds.join(","),
      caption: igCaption,
      access_token: token,
    });
    const resp = await fetch(url, { method: "POST", body: params });
    const data = await resp.json();
    if (!resp.ok || !data?.id) {
      throw new Error(`IG carousel container create failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return data.id;
  }, "carousel container");

  // 3. Wait for ready
  await waitForContainer(carouselId, token, graphVer);

  // 4. Publish
  const publishRes = await retryIg(
    () => publishContainer(carouselId, userId, token, graphVer),
    "carousel publish"
  );

  logEvent({ event: "instagram_carousel_publish_success", salon_id, data: { media_id: publishRes.id, count: imageUrls.length } });
  return { id: publishRes.id, status: "success", type: "carousel" };
}

/**
 * publishStoryToInstagram({ salon_id, imageUrl })
 * Publishes a single image as an Instagram Story.
 */
export async function publishStoryToInstagram({ salon_id, imageUrl, linkUrl }) {
  if (!salon_id) throw new Error("publishStoryToInstagram: missing salon_id");
  if (!imageUrl) throw new Error("publishStoryToInstagram: missing imageUrl");

  const { userId, token, graphVer } = await resolveIgCredentials(salon_id);
  if (!token || !userId) throw new Error("Missing Instagram credentials for story.");

  const publicUrl = await ensurePublicImage(imageUrl, `story-${Date.now()}`, salon_id);

  console.log(`📖 [Instagram Story] Publishing for salon_id=${salon_id}`);

  const creationId = await retryIg(async () => {
    const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
    const body = {
      image_url: publicUrl,
      media_type: "STORIES",
      access_token: token,
    };
    if (linkUrl) {
      body.link = linkUrl;
      body.link_sticker_url = linkUrl;
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || !data?.id) {
      throw new Error(`IG story create failed: ${resp.status} ${JSON.stringify(data)}`);
    }
    return data.id;
  }, "story create");

  await waitForContainer(creationId, token, graphVer);

  const publishRes = await retryIg(
    () => publishContainer(creationId, userId, token, graphVer),
    "story publish"
  );

  logEvent({ event: "instagram_story_publish_success", salon_id, data: { media_id: publishRes.id } });
  console.log(`✅ [Instagram Story] Published: ${publishRes.id}`);
  return { id: publishRes.id, status: "success", type: "story" };
}

/**
 * publishToInstagram({ salon_id, caption, imageUrl, imageUrls? })
 * Routes to carousel automatically when imageUrls has 2+ entries.
 */
export async function publishToInstagram(input) {
  const { salon_id, caption, imageUrl, imageUrls, stylist_id } = input;

  // Route to carousel if multiple images provided
  const allUrls = imageUrls?.length ? imageUrls : (imageUrl ? [imageUrl] : []);
  if (allUrls.length > 1) {
    // Carousel posts: collaborator tagging not supported (handled by publishToInstagramCarousel)
    return publishToInstagramCarousel({ salon_id, caption, imageUrls: allUrls });
  }

  if (!salon_id || salon_id === "global") {
    throw new Error("Instagram publish called without a valid salon_id");
  }

  console.log(`📷 [Instagram] Start publish for salon_id=${salon_id}`);

  // ── Collaborator lookup ──────────────────────────────────────────────
  let collaborators;
  if (stylist_id) {
    try {
      const stylistRow = db.prepare(
        `SELECT instagram_handle, ig_collab FROM stylists WHERE id = ?`
      ).get(stylist_id);
      collaborators = buildCollaborators(stylistRow);
    } catch (err) {
      console.warn("[Instagram] Collaborator lookup failed, continuing without:", err.message);
    }
  }

  // -------------------------------------------------------
  // Caption normalization (UNCHANGED)
  // -------------------------------------------------------
  let igCaption = (caption || "").trim();

  igCaption = igCaption.replace(
    /<a[^>]*href="https?:\/\/instagram\.com\/([^"]+)"[^>]*>@[^<]+<\/a>/gi,
    "@$1"
  );

  igCaption = igCaption.replace(/https?:\/\/\S+/gi, "").trim();

  if (!/book via link in bio/i.test(igCaption)) {
    igCaption += (igCaption ? "\n\n" : "") + "Book via link in bio.";
  }

  // -------------------------------------------------------
  // Credential resolution via shared helper
  // -------------------------------------------------------
  const { userId, token, graphVer } = await resolveIgCredentials(salon_id);

  if (!token || !userId) {
    console.warn("[Instagram] Missing IG creds", { salon_id, hasUserId: !!userId, hasToken: !!token });
    throw new Error("Missing Instagram credentials (token or userId).");
  }

  const publicImageUrl = await ensurePublicImage(
    imageUrl,
    Date.now().toString(),
    salon_id
  );

  try {
    let creationId;
    try {
      creationId = await retryIg(
        () =>
          createIgMedia({
            userId,
            imageUrl: publicImageUrl,
            caption: igCaption,
            token,
            graphVer,
            collaborators,
          }),
        "media create"
      );
    } catch (createErr) {
      // If error mentions collaborators, retry without them (non-blocking)
      if (collaborators && /collaborator/i.test(createErr.message)) {
        console.warn("[Instagram] Collaborator tag rejected, retrying without:", createErr.message);
        creationId = await retryIg(
          () =>
            createIgMedia({
              userId,
              imageUrl: publicImageUrl,
              caption: igCaption,
              token,
              graphVer,
            }),
          "media create (no collab)"
        );
      } else {
        throw createErr;
      }
    }

    await waitForContainer(creationId, token, graphVer);

    const publishRes = await retryIg(
      () => publishContainer(creationId, userId, token, graphVer),
      "media publish"
    );

    logEvent({
      event: "instagram_publish_success",
      salon_id,
      data: { media_id: publishRes.id, image_url: publicImageUrl },
    });

    return { id: publishRes.id, status: "success" };
  } catch (err) {
    console.error("❌ [Instagram] Publish failed:", err.message);
    logEvent({
      event: "instagram_publish_failed",
      salon_id,
      data: { error: err.message },
    });
    throw err;
  }
}
