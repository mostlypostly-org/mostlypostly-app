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
// Parse a hex color to {r,g,b}
// ─────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const h = (hex || "#2B2D35").replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

// ─────────────────────────────────────────────────────────
// Build the availability story image — torn paper design
//
// Photo shows through fully in the top half (just a light
// vignette at edges). Lower half has an artistic torn-paper
// panel in the salon's brand color. The top edge of the panel
// is ragged/torn — sharp zigzag polygon points, not a smooth
// gradient rectangle. Text lives on the panel.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font = `'Open Sans', Arial, Helvetica, sans-serif`;

  // Brand palette — panel uses primary or a dark fallback
  const panelHex = palette?.primary || palette?.secondary || "#2B2D35";
  const { r, g, b } = hexToRgb(panelHex);
  const ACCENT   = palette?.cta || palette?.accent || "#D4897A";
  const ACCENT2  = palette?.accent_light || "rgba(255,255,255,0.18)";

  // Torn edge base Y — panel starts around 54% down so photo dominates
  const TEAR_BASE = Math.round(H * 0.54);

  // Torn paper top edge — irregular zigzag points (fixed, not random)
  // Each point: [x, y-offset-from-TEAR_BASE] — positive = lower (into panel)
  // Sharp angles create the torn/ripped paper look
  const tearEdge = [
    [0,    38],
    [68,    8],
    [135,  55],
    [215,  16],
    [295,  68],
    [370,  22],
    [445,  58],
    [520,   6],
    [600,  62],
    [680,  24],
    [755,  52],
    [840,  10],
    [920,  48],
    [1000, 18],
    [1080, 42],
  ];

  // Build the torn panel SVG path
  // Start top-left below the tear, trace the jagged edge, fill down to bottom
  const edgePts = tearEdge.map(([x, dy]) => `${x},${TEAR_BASE + dy}`).join(" L ");
  const panelPath = `M 0,${TEAR_BASE + 38} L ${edgePts} L ${W},${H} L 0,${H} Z`;

  // Shadow layer behind torn edge — gives paper the lifted/layered look
  // Same path shifted down 12px and slightly darker, lower opacity
  const shadowEdge = tearEdge.map(([x, dy]) => `${x},${TEAR_BASE + dy + 12}`).join(" L ");
  const shadowPath = `M 0,${TEAR_BASE + 50} L ${shadowEdge} L ${W},${H} L 0,${H} Z`;

  // Text layout within the panel
  const TEXT_Y     = TEAR_BASE + 95;   // first text element baseline
  const SLOT_START = TEXT_Y + 230;     // where slot rows begin
  const SLOT_H     = 76;
  const SLOT_GAP   = 10;
  const slotCount  = Math.min(slots.length, 4);

  const slotRows = slots.slice(0, slotCount).map((slot, i) => {
    const rowY = SLOT_START + i * (SLOT_H + SLOT_GAP);
    return `
      <!-- Accent mark — short vertical bar, left of slot text -->
      <rect x="68" y="${rowY + 8}" width="5" height="${SLOT_H - 16}" rx="2"
        fill="${ACCENT}" />
      <text x="92" y="${rowY + SLOT_H * 0.68}"
        font-family="${font}" font-size="38" font-weight="800"
        fill="white" fill-opacity="0.95">${escSvg(slot)}</text>
    `;
  }).join("");

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <!-- Very light vignette — photo breathes in the top half -->
        <radialGradient id="vign" cx="50%" cy="35%" r="72%">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="85%"  stop-color="black" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.38"/>
        </radialGradient>
        <!-- Top edge gradient so photo fades into torn panel naturally -->
        <linearGradient id="fadeToPanel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stop-color="black" stop-opacity="0"/>
          <stop offset="70%" stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="rgb(${r},${g},${b})" stop-opacity="0.6"/>
        </linearGradient>
      </defs>

      <!-- Light vignette over whole photo — keeps photo vivid -->
      <rect width="${W}" height="${H}" fill="url(#vign)"/>

      <!-- Soft fade from photo into torn panel — avoids hard seam -->
      <rect x="0" y="${TEAR_BASE - 200}" width="${W}" height="260"
        fill="url(#fadeToPanel)"/>

      <!-- Shadow layer — gives torn edge depth/lift -->
      <path d="${shadowPath}" fill="rgb(${Math.max(0,r-30)},${Math.max(0,g-30)},${Math.max(0,b-30)})" fill-opacity="0.45"/>

      <!-- Torn paper panel — salon brand color -->
      <path d="${panelPath}" fill="rgba(${r},${g},${b},0.90)"/>

      <!-- Salon name — spaced caps, accent color, above headline -->
      <text x="68" y="${TEXT_Y + 42}"
        font-family="${font}" font-size="24" font-weight="800"
        fill="${ACCENT}" letter-spacing="7" fill-opacity="0.95">
        ${escSvg(salonName.toUpperCase())}
      </text>

      <!-- NOW BOOKING — large, punchy headline -->
      <text x="68" y="${TEXT_Y + 148}"
        font-family="${font}" font-size="100" font-weight="800"
        fill="white" letter-spacing="-3" fill-opacity="0.97">
        NOW
      </text>
      <text x="68" y="${TEXT_Y + 248}"
        font-family="${font}" font-size="100" font-weight="800"
        fill="white" letter-spacing="-3" fill-opacity="0.97">
        BOOKING
      </text>

      <!-- Slot rows -->
      ${slotRows}

      <!-- Stylist name -->
      <text x="${W / 2}" y="${H - 136}"
        font-family="${font}" font-size="34" font-weight="700"
        fill="white" text-anchor="middle" fill-opacity="0.88">
        ${escSvg(stylistName)}
      </text>

      ${instagramHandle ? `
      <text x="${W / 2}" y="${H - 94}"
        font-family="${font}" font-size="28" font-weight="600"
        fill="${ACCENT}" text-anchor="middle" fill-opacity="0.95">
        @${escSvg(instagramHandle.replace(/^@/, ""))}
      </text>` : ""}

      <!-- CTA bar — slightly rounded rectangle, not a full pill — less corporate -->
      <rect x="68" y="${H - 66}" width="${W - 136}" height="48" rx="6"
        fill="${ACCENT}" fill-opacity="0.95"/>
      <text x="${W / 2}" y="${H - 34}"
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
  // Slight modulate: keep saturation vivid (photo should feel present)
  // but reduce brightness a touch so the torn panel text pops
  let bgLayer;
  if (bgUrl) {
    try {
      const bgBuf = await fetchBuffer(bgUrl);
      bgLayer = await sharp(bgBuf)
        .resize(W, H, { fit: "cover", position: "center" })
        .modulate({ brightness: 0.88, saturation: 1.05 })
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
