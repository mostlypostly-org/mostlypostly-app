// src/core/buildAvailabilityImage.js
// Parses availability text via GPT, picks a background photo,
// overlays appointment slots with sharp, returns a public URL.

import sharp from "sharp";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { db } from "../../db.js";

const PUBLIC_DIR = path.resolve("public/uploads");
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

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
Return ONLY a JSON array of concise slot strings. Each string should be short (max 30 chars).
Examples: ["Tue Mar 5 · 10am–12pm", "Wed Mar 6 · 2pm–4pm", "Thu Mar 7 · 9am–11am"]
If no clear times, return the message split into short lines.`;

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
// Pick background: stylist photo → salon stock → DALL-E
// ─────────────────────────────────────────────────────────
async function pickBackground(stylistId, salonId) {
  // 1. Personal photo — check both stylists and managers tables
  if (stylistId) {
    const stylistRow = db.prepare(`SELECT photo_url FROM stylists WHERE id = ?`).get(stylistId);
    if (stylistRow?.photo_url) {
      console.log("[Availability] Using stylist personal photo");
      return stylistRow.photo_url;
    }

    const managerRow = db.prepare(`SELECT photo_url FROM managers WHERE id = ?`).get(stylistId);
    if (managerRow?.photo_url) {
      console.log("[Availability] Using manager personal photo");
      return managerRow.photo_url;
    }

    // 2. Stylist-linked stock photo
    const stockStyled = db.prepare(
      `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id = ? LIMIT 1`
    ).get(salonId, stylistId);
    if (stockStyled?.url) {
      console.log("[Availability] Using stylist stock photo");
      return stockStyled.url;
    }
  }

  // 3. Salon-wide stock photo
  const stockSalon = db.prepare(
    `SELECT url FROM stock_photos WHERE salon_id = ? AND stylist_id IS NULL ORDER BY created_at DESC LIMIT 1`
  ).get(salonId);
  if (stockSalon?.url) {
    console.log("[Availability] Using salon-wide stock photo");
    return stockSalon.url;
  }

  // 4. DALL-E generated background
  console.log("[Availability] No stock photo found — generating DALL-E background");
  return await generateDalleBackground();
}

async function generateDalleBackground() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: "Elegant modern hair salon interior, soft natural lighting, blurred bokeh background, warm tones, professional photography, vertical 9:16 format",
        n: 1,
        size: "1024x1792",
      }),
    });
    const data = await resp.json();
    const url = data?.data?.[0]?.url;
    if (url) {
      console.log("[Availability] DALL-E background generated");
      return url;
    }
  } catch (err) {
    console.warn("[Availability] DALL-E generation failed:", err.message);
  }
  return null;
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
// Build the availability story image
// ─────────────────────────────────────────────────────────
function buildOverlaySvg({ slots, stylistName, salonName, bookingCta }) {
  const slotLineHeight = 68;
  const headerH = 300;
  const footerH = 260;
  const slotsH = slots.length * slotLineHeight + 40;
  const totalH = H;

  // Slot rows
  const slotRows = slots.map((slot, i) => `
    <g>
      <rect x="60" y="${headerH + 20 + i * slotLineHeight}" width="${W - 120}" height="56"
        rx="12" fill="rgba(255,255,255,0.12)" />
      <text x="${W / 2}" y="${headerH + 20 + i * slotLineHeight + 36}"
        font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600"
        fill="white" text-anchor="middle">${escSvg(slot)}</text>
    </g>
  `).join("");

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <!-- Dark gradient overlay -->
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="rgba(0,0,0,0.70)" />
          <stop offset="40%"  stop-color="rgba(0,0,0,0.40)" />
          <stop offset="70%"  stop-color="rgba(0,0,0,0.40)" />
          <stop offset="100%" stop-color="rgba(0,0,0,0.75)" />
        </linearGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#grad)" />

      <!-- Salon name -->
      <text x="${W / 2}" y="140"
        font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700"
        fill="rgba(255,255,255,0.75)" text-anchor="middle" letter-spacing="4">
        ${escSvg(salonName.toUpperCase())}
      </text>

      <!-- "NOW BOOKING" header -->
      <text x="${W / 2}" y="220"
        font-family="Arial, Helvetica, sans-serif" font-size="68" font-weight="900"
        fill="white" text-anchor="middle" letter-spacing="2">
        NOW BOOKING
      </text>

      <!-- Divider -->
      <line x1="120" y1="255" x2="${W - 120}" y2="255" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>

      <!-- Availability slots -->
      ${slotRows}

      <!-- Stylist name -->
      <text x="${W / 2}" y="${H - 180}"
        font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700"
        fill="white" text-anchor="middle">
        ${escSvg(stylistName)}
      </text>

      <!-- Booking CTA -->
      <rect x="140" y="${H - 150}" width="${W - 280}" height="70" rx="35"
        fill="rgba(255,255,255,0.18)" />
      <text x="${W / 2}" y="${H - 105}"
        font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600"
        fill="white" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio.")}
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
export async function buildAvailabilityImage({ text, stylistName, salonName, salonId, stylistId, bookingCta }) {
  console.log("[Availability] Building story image…");

  // 1. Parse slots
  const slots = await parseAvailabilitySlots(text);
  console.log("[Availability] Slots parsed:", slots);

  // 2. Pick background
  const bgUrl = await pickBackground(stylistId, salonId);

  // 3. Fetch and resize background to story dimensions
  let bgLayer;
  if (bgUrl) {
    try {
      const bgBuf = await fetchBuffer(bgUrl);
      bgLayer = await sharp(bgBuf)
        .resize(W, H, { fit: "cover", position: "center" })
        .toBuffer();
    } catch (err) {
      console.warn("[Availability] Background fetch failed, using solid fallback:", err.message);
      bgLayer = null;
    }
  }

  // Fallback: dark gradient solid background
  if (!bgLayer) {
    bgLayer = await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 20, g: 20, b: 35 } },
    }).jpeg().toBuffer();
  }

  // 4. Build SVG overlay
  const overlay = buildOverlaySvg({ slots, stylistName, salonName, bookingCta });

  // 5. Composite
  const finalBuf = await sharp(bgLayer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  // 6. Save and return public URL
  const fileName  = `availability-${Date.now()}.jpg`;
  const filePath  = path.join(PUBLIC_DIR, fileName);
  fs.writeFileSync(filePath, finalBuf);

  const base = (process.env.PUBLIC_BASE_URL || "https://localhost:3000").replace(/\/$/, "");
  const publicUrl = `${base}/uploads/${fileName}`;
  console.log("[Availability] Story image saved:", publicUrl);
  return publicUrl;
}
