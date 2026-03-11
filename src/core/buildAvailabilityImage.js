// src/core/buildAvailabilityImage.js
// Parses availability text via GPT, picks a background photo,
// overlays appointment slots with sharp, returns a public URL.

import sharp from "sharp";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../../db.js";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Embed Open Sans ExtraBold (800) as base64 so librsvg/sharp can use it on any server
const FONT_PATH = path.resolve(__dirname, "../../node_modules/@fontsource/open-sans/files/open-sans-latin-800-normal.woff2");
const FONT_B64 = fs.existsSync(FONT_PATH)
  ? fs.readFileSync(FONT_PATH).toString("base64")
  : null;
const FONT_FACE = FONT_B64
  ? `@font-face { font-family: 'Open Sans'; font-weight: 800; src: url('data:font/woff2;base64,${FONT_B64}') format('woff2'); }`
  : "";

// Instagram Story: 9:16
const W = 1080;
const H = 1920;

// ─────────────────────────────────────────────────────────
// Parse availability slots from free-form text via GPT
// ─────────────────────────────────────────────────────────
export async function parseAvailabilitySlots(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [text]; // fallback: treat whole text as one slot

  const systemPrompt = `You extract appointment availability from a stylist's message.
Return ONLY a JSON array of concise slot strings. Each string should be max 35 chars.
Format each slot as: "Day: Time for Service" (e.g. "Friday: 2pm for Color Service")
If no service is mentioned, use: "Day: Time" (e.g. "Friday: 2pm")
If a time range is given, use: "Friday: 2pm–4pm for Color"
Use the actual day name (Monday, Tuesday, etc.) not a date number.
Examples: ["Friday: 2pm for Color Service", "Saturday: 10am–12pm", "Monday: 3pm for Highlights"]
If no clear times exist, return the message split into short meaningful lines.`;

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
      }),
    });
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "[]";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, 6);
  } catch (err) {
    console.warn("[Availability] Slot parse failed:", err.message);
  }

  // Fallback: split on commas or newlines
  return text.split(/[,\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 6);
}

// ─────────────────────────────────────────────────────────
// Pick background: stylist photo → stylist stock → salon stock → Pexels
// ─────────────────────────────────────────────────────────
import { fetchPexelsBackground } from "./pexels.js";

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

async function pickBackground(stylistId, salonId) {
  // 1. Personal profile photo from stylists table
  if (stylistId) {
    const stylistRow = db.prepare(`SELECT photo_url FROM stylists WHERE id = ?`).get(stylistId);
    if (stylistRow?.photo_url) {
      console.log("[Availability] Using stylist personal photo");
      return stylistRow.photo_url;
    }

    // 2. Stylist-linked stock photos — pick randomly for variety
    const stylistPhotos = db.prepare(
      `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id = ? ORDER BY RANDOM() LIMIT 5`
    ).all(salonId, stylistId);
    const pick = pickRandom(stylistPhotos);
    if (pick?.url) {
      console.log("[Availability] Using stylist stock photo");
      return pick.url;
    }
  }

  // 3. Salon-wide stock photos — pick randomly
  const salonPhotos = db.prepare(
    `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id IS NULL ORDER BY RANDOM() LIMIT 10`
  ).all(salonId);
  const salonPick = pickRandom(salonPhotos);
  if (salonPick?.url) {
    console.log("[Availability] Using salon-wide stock photo");
    return salonPick.url;
  }

  // 4. Pexels real photo fallback
  console.log("[Availability] No stock photo found — fetching Pexels background");
  return await fetchPexelsBackground("availability");
}

async function fetchBuffer(url) {
  const isTwilio = /^https:\/\/api\.twilio\.com/i.test(url);
  const headers = isTwilio
    ? {
        Authorization: "Basic " + Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString("base64"),
      }
    : {};
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─────────────────────────────────────────────────────────
// Build the availability story image — photo-first design
// Large background photo shows through, text lives in a
// frosted glass panel at the bottom. Clean and editorial.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font = `'Open Sans', Arial, Helvetica, sans-serif`;

  // Brand palette with sensible defaults
  const ACCENT  = palette?.cta    || palette?.accent || "#3B72B9";
  const LIGHT   = palette?.accent_light || "#EBF3FF";

  // Layout: glass panel starts at 55% down — photo visible in top half
  const PANEL_Y     = Math.round(H * 0.52);
  const PANEL_H     = H - PANEL_Y;
  const SLOT_H      = 88;
  const SLOTS_START = PANEL_Y + 230;
  const slotCount   = Math.min(slots.length, 5);

  const slotRows = slots.slice(0, slotCount).map((slot, i) => {
    const y = SLOTS_START + i * (SLOT_H + 12);
    const isFirst = i === 0;
    return `
      <rect x="60" y="${y}" width="${W - 120}" height="${SLOT_H}" rx="16"
        fill="white" fill-opacity="${isFirst ? "0.18" : "0.12"}" />
      <line x1="84" y1="${y + 18}" x2="84" y2="${y + SLOT_H - 18}"
        stroke="${ACCENT}" stroke-width="4" stroke-linecap="round"/>
      <text x="112" y="${y + 56}"
        font-family="${font}" font-size="36" font-weight="800"
        fill="white">${escSvg(slot)}</text>
    `;
  }).join("");

  // Thin accent line above "NOW BOOKING"
  const accentLineY = PANEL_Y + 100;

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <!-- Subtle vignette — darkens edges, barely touches center -->
        <radialGradient id="vign" cx="50%" cy="40%" r="75%">
          <stop offset="0%"   stop-color="black" stop-opacity="0" />
          <stop offset="100%" stop-color="black" stop-opacity="0.55" />
        </radialGradient>
        <!-- Bottom panel: dark frosted glass feel -->
        <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0.55" />
          <stop offset="100%" stop-color="black" stop-opacity="0.82" />
        </linearGradient>
      </defs>

      <!-- Vignette over entire image -->
      <rect width="${W}" height="${H}" fill="url(#vign)" />

      <!-- Frosted bottom panel -->
      <rect x="0" y="${PANEL_Y}" width="${W}" height="${PANEL_H}" fill="url(#panel)" />

      <!-- Thin accent line -->
      <rect x="60" y="${accentLineY}" width="80" height="5" rx="2.5" fill="${ACCENT}" />

      <!-- Salon name — small, elegant, above headline -->
      <text x="60" y="${PANEL_Y + 76}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="${LIGHT}" letter-spacing="5">
        ${escSvg(salonName.toUpperCase())}
      </text>

      <!-- "NOW BOOKING" headline -->
      <text x="60" y="${PANEL_Y + 170}"
        font-family="${font}" font-size="86" font-weight="800"
        fill="white" letter-spacing="-1">
        NOW BOOKING
      </text>

      <!-- Slot rows -->
      ${slotRows}

      <!-- Stylist credit + Instagram at very bottom -->
      <text x="${W / 2}" y="${H - 120}"
        font-family="${font}" font-size="34" font-weight="700"
        fill="white" text-anchor="middle" fill-opacity="0.9">
        ${escSvg(stylistName)}
      </text>

      ${instagramHandle ? `
      <text x="${W / 2}" y="${H - 76}"
        font-family="${font}" font-size="28" font-weight="600"
        fill="${ACCENT}" text-anchor="middle">
        @${escSvg(instagramHandle.replace(/^@/, ""))}
      </text>` : ""}

      <!-- Booking CTA pill -->
      <rect x="60" y="${H - 52}" width="${W - 120}" height="44" rx="22"
        fill="${ACCENT}" fill-opacity="0.92" />
      <text x="${W / 2}" y="${H - 22}"
        font-family="${font}" font-size="26" font-weight="800"
        fill="white" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio")}
      </text>
    </svg>
  `);
}

function escSvg(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the availability story image.
 *
 * @param {object} opts
 * @param {string}   opts.text        - Raw availability message from stylist
 * @param {string}   opts.stylistName
 * @param {string}   opts.salonName
 * @param {string}   opts.salonId
 * @param {string}   opts.stylistId
 * @param {string}   opts.bookingCta
 * @returns {Promise<string>}  Public URL of the saved story image
 */
export async function buildAvailabilityImage({ text, stylistName, salonName, salonId, stylistId, instagramHandle, bookingCta, submittedImageUrl }) {
  console.log("[Availability] Building story image…");

  // 1. Parse slots
  const slots = await parseAvailabilitySlots(text);
  console.log("[Availability] Slots parsed:", slots);

  // 2. Pick background — submitted photo wins, then stock/DALL-E
  const bgUrl = submittedImageUrl || await pickBackground(stylistId, salonId);

  // 3. Fetch and resize background to story dimensions
  let bgLayer;
  if (bgUrl) {
    try {
      const bgBuf = await fetchBuffer(bgUrl);
      bgLayer = await sharp(bgBuf)
        .resize(W, H, { fit: "cover", position: "center" })
        .toBuffer();
    } catch (err) {
      console.warn("[Availability] Background fetch failed, trying Pexels:", err.message);
      const pexelsUrl = await fetchPexelsBackground("availability");
      if (pexelsUrl) {
        try {
          const buf = await fetchBuffer(pexelsUrl);
          bgLayer = await sharp(buf)
            .resize(W, H, { fit: "cover", position: "center" })
            .toBuffer();
        } catch { bgLayer = null; }
      }
    }
  }

  // Fallback: dark gradient solid background
  if (!bgLayer) {
    bgLayer = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 20, g: 20, b: 35 } },
    }).jpeg().toBuffer();
  }

  // 4. Load brand palette from DB
  let palette = null;
  try {
    const salonRow = db.prepare("SELECT brand_palette FROM salons WHERE slug = ?").get(salonId);
    if (salonRow?.brand_palette) palette = JSON.parse(salonRow.brand_palette);
  } catch { /* use defaults */ }

  // 5. Build SVG overlay
  const overlay = buildOverlaySvg({ slots, stylistName, salonName, bookingCta, instagramHandle, palette });

  // 5. Composite
  const finalBuf = await sharp(bgLayer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  // 6. Save and return public URL
  const fileName  = `availability-${Date.now()}.jpg`;
  const filePath  = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, finalBuf);

  const publicUrl = toUploadUrl(fileName);
  console.log("[Availability] Story image saved:", publicUrl);
  return publicUrl;
}
