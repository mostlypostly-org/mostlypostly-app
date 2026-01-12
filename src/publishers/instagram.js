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

async function createIgMedia({ userId, imageUrl, caption, token, graphVer }) {
  const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || "",
    access_token: token,
  });
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

/**
 * publishToInstagram({ salon_id, caption, imageUrl })
 */
export async function publishToInstagram(input) {
  const { salon_id, caption, imageUrl } = input;

  if (!salon_id || salon_id === "global") {
    throw new Error("Instagram publish called without a valid salon_id");
  }

  console.log(`📷 [Instagram] Start publish for salon_id=${salon_id}`);

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
  // DB-based credential resolution (FIXED)
  // -------------------------------------------------------
  const salonRow = db
    .prepare(
      `
    SELECT
      instagram_business_id,
      facebook_page_token
    FROM salons
    WHERE id = ? OR slug = ?
    LIMIT 1
  `
    )
    .get(salon_id, salon_id);

  const userId = salonRow?.instagram_business_id || DEFAULT_IG_USER_ID;
  const token = salonRow?.facebook_page_token || DEFAULT_FB_TOKEN;
  const graphVer = DEFAULT_GRAPH_VER;

  if (!token || !userId) {
    console.warn("[Instagram] Missing IG creds", {
      salon_id,
      hasUserId: !!userId,
      hasToken: !!token,
    });
    throw new Error("Missing Instagram credentials (token or userId).");
  }

  const publicImageUrl = await ensurePublicImage(
    imageUrl,
    Date.now().toString(),
    salon_id
  );

  try {
    const creationId = await retryIg(
      () =>
        createIgMedia({
          userId,
          imageUrl: publicImageUrl,
          caption: igCaption,
          token,
          graphVer,
        }),
      "media create"
    );

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
