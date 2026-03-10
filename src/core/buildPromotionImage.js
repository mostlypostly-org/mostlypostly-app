// src/core/buildPromotionImage.js
// Builds a 1080x1920 promotional story image using sharp.
// Background priority: salon stock → stylist stock → Pexels → solid fallback
// No more DALL-E — real photos only.

import sharp from "sharp";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { db } from "../../db.js";
import { fetchPexelsBackground } from "./pexels.js";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";

const W = 1080;
const H = 1920;

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function pickBackground(salonId, stylistId) {
  // 1. Salon-wide stock photos — pick randomly
  const salonPhotos = db.prepare(
    `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id IS NULL ORDER BY RANDOM() LIMIT 10`
  ).all(salonId);
  const salonPick = pickRandom(salonPhotos);
  if (salonPick?.url) {
    console.log("[Promotion] Using salon stock photo");
    return salonPick.url;
  }

  // 2. If stylist associated, use their photos
  if (stylistId) {
    const stylistRow = db.prepare(`SELECT photo_url FROM stylists WHERE id = ?`).get(stylistId);
    if (stylistRow?.photo_url) {
      console.log("[Promotion] Using stylist profile photo");
      return stylistRow.photo_url;
    }
    const stylistPhotos = db.prepare(
      `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id = ? ORDER BY RANDOM() LIMIT 5`
    ).all(salonId, stylistId);
    const stylistPick = pickRandom(stylistPhotos);
    if (stylistPick?.url) {
      console.log("[Promotion] Using stylist stock photo");
      return stylistPick.url;
    }
  }

  // 3. Pexels real photo fallback
  console.log("[Promotion] No stock photo — fetching Pexels background");
  return await fetchPexelsBackground("promotion");
}

function buildOverlaySvg({ salonName, product, discount, specialText, expiresLabel, palette }) {
  const ACCENT  = palette?.cta    || palette?.accent || "#D4897A";
  const LIGHT   = palette?.accent_light || "#F2DDD9";
  const DARK    = palette?.primary || "#2B2D35";

  // Layout: large photo up top, dark glass panel bottom ~50%
  const PANEL_Y = Math.round(H * 0.48);
  const PANEL_H = H - PANEL_Y;

  // Product name — wrap long names across 2 lines
  const productWords = String(product || "").split(" ");
  let productLine1 = product;
  let productLine2 = "";
  if (productWords.length > 3) {
    const mid = Math.ceil(productWords.length / 2);
    productLine1 = productWords.slice(0, mid).join(" ");
    productLine2 = productWords.slice(mid).join(" ");
  }

  const discountBadge = discount ? `
    <!-- Discount badge — accent color pill -->
    <rect x="${W / 2 - 220}" y="${PANEL_Y + 96}" width="440" height="110" rx="55"
      fill="${ACCENT}" />
    <text x="${W / 2}" y="${PANEL_Y + 167}"
      font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="900"
      fill="white" text-anchor="middle">
      ${esc(discount)} OFF
    </text>
  ` : "";

  const discountShift = discount ? 140 : 0;
  const productY = PANEL_Y + 250 + discountShift;

  const specialBlock = specialText ? `
    <text x="60" y="${productY + (productLine2 ? 200 : 130)}"
      font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="600"
      fill="${LIGHT}" fill-opacity="0.85">
      ${esc(specialText)}
    </text>
  ` : "";

  const expiresBlock = expiresLabel ? `
    <text x="60" y="${H - 150}"
      font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600"
      fill="white" fill-opacity="0.60">
      Offer expires ${esc(expiresLabel)}
    </text>
  ` : "";

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- Vignette: darkens corners, lets center of photo breathe -->
        <radialGradient id="vign" cx="50%" cy="35%" r="70%">
          <stop offset="0%"   stop-color="black" stop-opacity="0" />
          <stop offset="100%" stop-color="black" stop-opacity="0.6" />
        </radialGradient>
        <!-- Bottom panel gradient -->
        <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0.60" />
          <stop offset="100%" stop-color="black" stop-opacity="0.88" />
        </linearGradient>
      </defs>

      <!-- Photo vignette overlay -->
      <rect width="${W}" height="${H}" fill="url(#vign)" />

      <!-- Bottom glass panel -->
      <rect x="0" y="${PANEL_Y}" width="${W}" height="${PANEL_H}" fill="url(#panel)" />

      <!-- Thin accent bar at panel edge -->
      <rect x="60" y="${PANEL_Y + 36}" width="100" height="5" rx="2.5" fill="${ACCENT}" />

      <!-- "EXCLUSIVE OFFER" eyebrow -->
      <text x="60" y="${PANEL_Y + 80}"
        font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700"
        fill="${ACCENT}" letter-spacing="6">
        EXCLUSIVE OFFER
      </text>

      ${discountBadge}

      <!-- Product / Service name -->
      <text x="60" y="${productY}"
        font-family="Arial, Helvetica, sans-serif" font-size="82" font-weight="900"
        fill="white">
        ${esc(productLine1)}
      </text>
      ${productLine2 ? `
      <text x="60" y="${productY + 90}"
        font-family="Arial, Helvetica, sans-serif" font-size="82" font-weight="900"
        fill="white">
        ${esc(productLine2)}
      </text>` : ""}

      ${specialBlock}

      ${expiresBlock}

      <!-- Salon name — small at very bottom -->
      <text x="60" y="${H - 100}"
        font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700"
        fill="white" fill-opacity="0.55" letter-spacing="4">
        ${esc(salonName.toUpperCase())}
      </text>

      <!-- CTA pill -->
      <rect x="60" y="${H - 72}" width="${W - 120}" height="56" rx="28"
        fill="${ACCENT}" />
      <text x="${W / 2}" y="${H - 35}"
        font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="800"
        fill="white" text-anchor="middle" letter-spacing="2">
        BOOK NOW · LINK IN BIO
      </text>
    </svg>
  `);
}

/**
 * @param {object} opts
 * @param {string}  opts.salonId
 * @param {string}  opts.salonName
 * @param {string}  opts.product       - Product or service name
 * @param {string}  [opts.discount]    - e.g. "20%" or "$15"
 * @param {string}  [opts.specialText] - e.g. "Limited time only!"
 * @param {string}  [opts.expiresAt]   - ISO date string
 * @param {string}  [opts.stylistId]   - Associate a stylist's photos
 * @returns {Promise<string>}  Public URL of the saved promo image
 */
export async function buildPromotionImage({ salonId, salonName, product, discount, specialText, expiresAt, stylistId }) {
  console.log("[Promotion] Building story image…");

  const expiresLabel = expiresAt
    ? new Date(expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  // Load brand palette from DB
  let palette = null;
  try {
    const salonRow = db.prepare("SELECT brand_palette FROM salons WHERE slug = ?").get(salonId);
    if (salonRow?.brand_palette) palette = JSON.parse(salonRow.brand_palette);
  } catch {}

  // Background
  const bgUrl = await pickBackground(salonId, stylistId || null);
  let bgLayer;
  if (bgUrl) {
    try {
      const buf = await fetchBuffer(bgUrl);
      bgLayer = await sharp(buf).resize(W, H, { fit: "cover", position: "center" }).toBuffer();
    } catch (err) {
      console.warn("[Promotion] Background fetch failed:", err.message);
    }
  }
  if (!bgLayer) {
    // Solid dark fallback — better than nothing
    bgLayer = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 30, g: 25, b: 35 } },
    }).jpeg().toBuffer();
  }

  const overlay = buildOverlaySvg({ salonName, product, discount, specialText, expiresLabel, palette });

  const finalBuf = await sharp(bgLayer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  const fileName = `promo-${Date.now()}.jpg`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), finalBuf);

  const publicUrl = toUploadUrl(fileName);
  console.log("[Promotion] Image saved:", publicUrl);
  return publicUrl;
}
