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
// Extract day abbreviation from "Friday: 2pm for Color" → { day: "FRI", rest: "2pm for Color" }
// ─────────────────────────────────────────────────────────
function parseDayFromSlot(slot) {
  const match = slot.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[\s:,]*/i);
  if (match) {
    const day = match[1].slice(0, 3).toUpperCase();
    const rest = slot.slice(match[0].length).trim().replace(/^[:\-]\s*/, "");
    return { day, rest };
  }
  return { day: null, rest: slot };
}

// ─────────────────────────────────────────────────────────
// TEMPLATE 1 — tornCard
// White torn-paper card at top + accent badge pill cards.
// Inspired by IMG_5064: torn card houses headline, slots float
// independently over the photo below it.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg_tornCard({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font = `'Open Sans', Arial, Helvetica, sans-serif`;

  // Brand colors
  const ACCENT  = palette?.cta || palette?.accent || "#3B72B9";
  const DARK    = palette?.primary || "#1a1c22";
  const { r: dr, g: dg, b: db } = hexToRgb(DARK);

  // ── TORN HEADER CARD ──────────────────────────────────
  // White card at top of frame with a jagged/torn bottom edge.
  // The torn edge goes right-to-left so the path closes cleanly.
  const CL = 60;          // card left x
  const CR = W - 60;      // card right x (1020)
  const CT = 90;          // card top y
  const TORN_R = 16;      // corner radius

  // Torn bottom edge — interior points running right→left (excludes endpoints which are on card sides)
  // Straight L-commands between irregular Y offsets = torn paper look (not wave)
  const tornInner = [
    [950, 378], [870, 422], [790, 388],
    [710, 418], [630, 382], [550, 415], [470, 385],
    [390, 420], [310, 386], [220, 416], [140, 385],
  ];
  const tornStr = tornInner.map(([x, y]) => `L ${x},${y}`).join(" ");

  // Card path (clockwise): top-left → top-right → down right side →
  // torn bottom edge right→left → up left side → close
  const cardPath = `
    M ${CL + TORN_R},${CT}
    L ${CR - TORN_R},${CT}
    Q ${CR},${CT} ${CR},${CT + TORN_R}
    L ${CR},410
    ${tornStr}
    L ${CL},408
    L ${CL},${CT + TORN_R}
    Q ${CL},${CT} ${CL + TORN_R},${CT}
    Z
  `;

  // Drop shadow path — same shape offset 5px down/right
  const shadowInner = tornInner.map(([x, y]) => `L ${x + 5},${y + 5}`).join(" ");
  const shadowPath = `
    M ${CL + TORN_R + 5},${CT + 5}
    L ${CR - TORN_R + 5},${CT + 5}
    Q ${CR + 5},${CT + 5} ${CR + 5},${CT + TORN_R + 5}
    L ${CR + 5},415
    ${shadowInner}
    L ${CL + 5},413
    L ${CL + 5},${CT + TORN_R + 5}
    Q ${CL + 5},${CT + 5} ${CL + TORN_R + 5},${CT + 5}
    Z
  `;

  // ── SLOT PILLS ─────────────────────────────────────────
  // Individual floating pill cards for each time slot.
  // Left portion = accent-colored day badge; right = service + time text.
  // A clipPath per pill keeps the accent badge inside the rounded corners.
  const SLOT_START = 480;
  const SLOT_H     = 120;
  const SLOT_GAP   = 20;
  const slotCount  = Math.min(slots.length, 5);
  const BADGE_W    = 172; // width of accent day badge

  const slotCards = slots.slice(0, slotCount).map((slot, i) => {
    const y   = SLOT_START + i * (SLOT_H + SLOT_GAP);
    const cy  = y + SLOT_H / 2;  // vertical center
    const rx  = SLOT_H / 2;      // full pill radius
    const { day, rest } = parseDayFromSlot(slot);
    const label = day || String(i + 1);
    const text  = rest.length > 34 ? rest.slice(0, 33) + "…" : rest;

    return `
      <defs>
        <clipPath id="pill${i}">
          <rect x="${CL}" y="${y}" width="${CR - CL}" height="${SLOT_H}" rx="${rx}"/>
        </clipPath>
      </defs>
      <!-- Pill shadow -->
      <rect x="${CL + 4}" y="${y + 6}" width="${CR - CL}" height="${SLOT_H}" rx="${rx}"
        fill="black" fill-opacity="0.18"/>
      <!-- White pill -->
      <rect x="${CL}" y="${y}" width="${CR - CL}" height="${SLOT_H}" rx="${rx}"
        fill="white" fill-opacity="0.93"/>
      <!-- Accent badge (clipped to pill) -->
      <g clip-path="url(#pill${i})">
        <rect x="${CL}" y="${y}" width="${BADGE_W}" height="${SLOT_H}" fill="${ACCENT}"/>
      </g>
      <!-- Day label -->
      <text x="${CL + BADGE_W / 2}" y="${cy + 1}"
        font-family="${font}" font-size="38" font-weight="800"
        fill="white" text-anchor="middle" dominant-baseline="middle">
        ${escSvg(label)}
      </text>
      <!-- Service + time text -->
      <text x="${CL + BADGE_W + 28}" y="${cy + 1}"
        font-family="${font}" font-size="34" font-weight="700"
        fill="rgba(${dr},${dg},${db},0.92)" dominant-baseline="middle">
        ${escSvg(text)}
      </text>
    `;
  }).join("");

  // Bottom gradient starts 320px above bottom for handle/CTA legibility
  const BOT_Y = H - 340;

  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <!-- Subtle edge vignette — photo stays vivid -->
        <radialGradient id="vign" cx="50%" cy="42%" r="68%">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="82%"  stop-color="black" stop-opacity="0.10"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.30"/>
        </radialGradient>
        <!-- Bottom gradient for handle + CTA text readability -->
        <linearGradient id="botFade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.76"/>
        </linearGradient>
      </defs>

      <!-- Edge vignette — very light, photo breathes through -->
      <rect width="${W}" height="${H}" fill="url(#vign)"/>

      <!-- Bottom gradient for text legibility -->
      <rect x="0" y="${BOT_Y}" width="${W}" height="${H - BOT_Y}" fill="url(#botFade)"/>

      <!-- Torn header card: drop shadow -->
      <path d="${shadowPath}" fill="black" fill-opacity="0.16"/>

      <!-- Torn header card: white -->
      <path d="${cardPath}" fill="white" fill-opacity="0.95"/>

      <!-- Accent stripe at very top of card (brand pop) -->
      <rect x="${CL + TORN_R}" y="${CT}" width="${CR - CL - TORN_R * 2}" height="7"
        fill="${ACCENT}"/>

      <!-- Salon name eyebrow -->
      <text x="${W / 2}" y="${CT + 58}"
        font-family="${font}" font-size="21" font-weight="800"
        fill="${ACCENT}" text-anchor="middle" letter-spacing="6">
        ${escSvg(salonName.toUpperCase())}
      </text>

      <!-- NOW BOOKING — large punchy headline inside torn card -->
      <text x="${W / 2}" y="${CT + 170}"
        font-family="${font}" font-size="108" font-weight="800"
        fill="rgba(${dr},${dg},${db},0.95)" text-anchor="middle" letter-spacing="-3">
        NOW
      </text>
      <text x="${W / 2}" y="${CT + 288}"
        font-family="${font}" font-size="108" font-weight="800"
        fill="rgba(${dr},${dg},${db},0.95)" text-anchor="middle" letter-spacing="-3">
        BOOKING
      </text>

      <!-- Individual slot pill cards -->
      ${slotCards}

      <!-- Stylist name -->
      <text x="${W / 2}" y="${H - 178}"
        font-family="${font}" font-size="38" font-weight="700"
        fill="white" text-anchor="middle">
        ${escSvg(stylistName)}
      </text>

      ${instagramHandle ? `
      <!-- Instagram handle -->
      <text x="${W / 2}" y="${H - 124}"
        font-family="${font}" font-size="30" font-weight="600"
        fill="${ACCENT}" text-anchor="middle">
        @${escSvg(instagramHandle.replace(/^@/, ""))}
      </text>` : ""}

      <!-- CTA pill -->
      <rect x="180" y="${H - 90}" width="720" height="66" rx="33"
        fill="${ACCENT}" fill-opacity="0.95"/>
      <text x="${W / 2}" y="${H - 47}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="white" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio")}
      </text>
    </svg>
  `);
}

// ─────────────────────────────────────────────────────────
// TEMPLATE 2 — verticalLabel
// Large ghost "AVAILABILITY" watermark rotated along the left edge.
// Slot cards are rectangles (not pills) starting mid-frame.
// Thin accent bar runs full height on left edge.
// Inspired by IMG_5065 (urbanjonnys) vertical text treatment.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg_verticalLabel({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font   = `'Open Sans', Arial, Helvetica, sans-serif`;
  const ACCENT = palette?.cta || palette?.accent || "#3B72B9";
  const DARK   = palette?.primary || "#1a1c22";
  const { r: dr, g: dg, b: db } = hexToRgb(DARK);

  const CARD_L  = 110;
  const CARD_W  = W - CARD_L - 50;
  const SLOT_START = 430;
  const SLOT_H     = 112;
  const SLOT_GAP   = 18;
  const slotCount  = Math.min(slots.length, 5);
  const BADGE_W    = 162;

  const slotCards = slots.slice(0, slotCount).map((slot, i) => {
    const y  = SLOT_START + i * (SLOT_H + SLOT_GAP);
    const cy = y + SLOT_H / 2;
    const rx = 14;
    const { day, rest } = parseDayFromSlot(slot);
    const label = day || String(i + 1);
    const text  = rest.length > 34 ? rest.slice(0, 33) + "…" : rest;
    return `
      <defs>
        <clipPath id="vcard${i}">
          <rect x="${CARD_L}" y="${y}" width="${CARD_W}" height="${SLOT_H}" rx="${rx}"/>
        </clipPath>
      </defs>
      <rect x="${CARD_L + 4}" y="${y + 5}" width="${CARD_W}" height="${SLOT_H}" rx="${rx}"
        fill="black" fill-opacity="0.15"/>
      <rect x="${CARD_L}" y="${y}" width="${CARD_W}" height="${SLOT_H}" rx="${rx}"
        fill="white" fill-opacity="0.93"/>
      <g clip-path="url(#vcard${i})">
        <rect x="${CARD_L}" y="${y}" width="${BADGE_W}" height="${SLOT_H}" fill="${ACCENT}"/>
      </g>
      <text x="${CARD_L + BADGE_W / 2}" y="${cy}"
        font-family="${font}" font-size="36" font-weight="800"
        fill="white" text-anchor="middle" dominant-baseline="middle">
        ${escSvg(label)}
      </text>
      <text x="${CARD_L + BADGE_W + 24}" y="${cy}"
        font-family="${font}" font-size="33" font-weight="700"
        fill="rgba(${dr},${dg},${db},0.92)" dominant-baseline="middle">
        ${escSvg(text)}
      </text>`;
  }).join("");

  const BOT_Y = H - 320;
  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <radialGradient id="vign_vl" cx="55%" cy="45%" r="70%">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="80%"  stop-color="black" stop-opacity="0.12"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.35"/>
        </radialGradient>
        <linearGradient id="topFade_vl" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0.60"/>
          <stop offset="100%" stop-color="black" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="botFade_vl" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.80"/>
        </linearGradient>
      </defs>

      <rect width="${W}" height="${H}" fill="url(#vign_vl)"/>
      <rect x="0" y="0" width="${W}" height="400" fill="url(#topFade_vl)"/>
      <rect x="0" y="${BOT_Y}" width="${W}" height="${H - BOT_Y}" fill="url(#botFade_vl)"/>

      <!-- Ghost watermark rotated on left -->
      <text transform="translate(76, ${H / 2}) rotate(-90)"
        font-family="${font}" font-size="130" font-weight="800"
        fill="white" fill-opacity="0.07" text-anchor="middle" letter-spacing="16">
        AVAILABILITY
      </text>

      <!-- Thin accent bar, full left edge -->
      <rect x="0" y="0" width="8" height="${H}" fill="${ACCENT}"/>

      <!-- Salon name — top right -->
      <text x="${W - 56}" y="88"
        font-family="${font}" font-size="20" font-weight="800"
        fill="white" text-anchor="end" letter-spacing="5" fill-opacity="0.90">
        ${escSvg(salonName.toUpperCase())}
      </text>

      <!-- NOW BOOKING — top left area -->
      <text x="${CARD_L}" y="196"
        font-family="${font}" font-size="108" font-weight="800"
        fill="white" letter-spacing="-3">NOW</text>
      <text x="${CARD_L}" y="314"
        font-family="${font}" font-size="108" font-weight="800"
        fill="white" letter-spacing="-3">BOOKING</text>
      <rect x="${CARD_L}" y="326" width="260" height="7" rx="3.5" fill="${ACCENT}"/>

      ${slotCards}

      <text x="${W / 2}" y="${H - 178}"
        font-family="${font}" font-size="38" font-weight="700"
        fill="white" text-anchor="middle">${escSvg(stylistName)}</text>

      ${instagramHandle ? `
      <text x="${W / 2}" y="${H - 124}"
        font-family="${font}" font-size="30" font-weight="600"
        fill="${ACCENT}" text-anchor="middle">
        @${escSvg(instagramHandle.replace(/^@/, ""))}</text>` : ""}

      <rect x="180" y="${H - 90}" width="720" height="66" rx="33"
        fill="${ACCENT}" fill-opacity="0.95"/>
      <text x="${W / 2}" y="${H - 47}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="white" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio")}</text>
    </svg>
  `);
}

// ─────────────────────────────────────────────────────────
// TEMPLATE 3 — ghostPills
// Consistent dark overlay over full photo. Big "NOW BOOKING"
// headline sits directly on the photo (no card). Slots are
// transparent outlined pills with accent circle badges.
// Inspired by IMG_5066 (manesby.tayla) — text on photo aesthetic.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg_ghostPills({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font   = `'Open Sans', Arial, Helvetica, sans-serif`;
  const ACCENT = palette?.cta || palette?.accent || "#3B72B9";

  const SLOT_START = 580;
  const SLOT_H     = 104;
  const SLOT_GAP   = 18;
  const slotCount  = Math.min(slots.length, 5);
  const BADGE_R    = 40;

  const slotCards = slots.slice(0, slotCount).map((slot, i) => {
    const y  = SLOT_START + i * (SLOT_H + SLOT_GAP);
    const cy = y + SLOT_H / 2;
    const { day, rest } = parseDayFromSlot(slot);
    const label = day || String(i + 1);
    const text  = rest.length > 32 ? rest.slice(0, 31) + "…" : rest;
    return `
      <rect x="60" y="${y}" width="960" height="${SLOT_H}" rx="${SLOT_H / 2}"
        fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.55)" stroke-width="2"/>
      <circle cx="${60 + SLOT_H / 2}" cy="${cy}" r="${BADGE_R}" fill="${ACCENT}" fill-opacity="0.95"/>
      <text x="${60 + SLOT_H / 2}" y="${cy}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="white" text-anchor="middle" dominant-baseline="middle">
        ${escSvg(label)}</text>
      <text x="${60 + SLOT_H + 18}" y="${cy}"
        font-family="${font}" font-size="34" font-weight="700"
        fill="white" dominant-baseline="middle">
        ${escSvg(text)}</text>`;
  }).join("");

  const BOT_Y = H - 320;
  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <filter id="txtShadow_gp">
          <feDropShadow dx="0" dy="2" stdDeviation="6"
            flood-color="black" flood-opacity="0.72"/>
        </filter>
        <linearGradient id="topFade_gp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0.65"/>
          <stop offset="100%" stop-color="black" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="botFade_gp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.82"/>
        </linearGradient>
      </defs>

      <!-- Consistent dark overlay — photo still shows, feels cinematic -->
      <rect width="${W}" height="${H}" fill="black" fill-opacity="0.36"/>
      <rect x="0" y="0" width="${W}" height="520" fill="url(#topFade_gp)"/>
      <rect x="0" y="${BOT_Y}" width="${W}" height="${H - BOT_Y}" fill="url(#botFade_gp)"/>

      <!-- Salon name -->
      <text x="${W / 2}" y="86"
        font-family="${font}" font-size="20" font-weight="800"
        fill="${ACCENT}" text-anchor="middle" letter-spacing="7"
        filter="url(#txtShadow_gp)">
        ${escSvg(salonName.toUpperCase())}</text>

      <!-- Large headline directly on photo -->
      <text x="68" y="234"
        font-family="${font}" font-size="120" font-weight="800"
        fill="white" letter-spacing="-4" filter="url(#txtShadow_gp)">NOW</text>
      <text x="68" y="366"
        font-family="${font}" font-size="120" font-weight="800"
        fill="white" letter-spacing="-4" filter="url(#txtShadow_gp)">BOOKING</text>
      <rect x="68" y="382" width="320" height="7" rx="3.5" fill="${ACCENT}"/>

      <!-- "with stylistName" subline -->
      <text x="68" y="442"
        font-family="${font}" font-size="30" font-weight="600"
        fill="rgba(255,255,255,0.78)" filter="url(#txtShadow_gp)">
        with ${escSvg(stylistName)}</text>

      ${slotCards}

      ${instagramHandle ? `
      <text x="${W / 2}" y="${H - 124}"
        font-family="${font}" font-size="30" font-weight="600"
        fill="${ACCENT}" text-anchor="middle" filter="url(#txtShadow_gp)">
        @${escSvg(instagramHandle.replace(/^@/, ""))}</text>` : `
      <text x="${W / 2}" y="${H - 124}"
        font-family="${font}" font-size="30" font-weight="600"
        fill="rgba(255,255,255,0.80)" text-anchor="middle">
        ${escSvg(stylistName)}</text>`}

      <rect x="180" y="${H - 90}" width="720" height="66" rx="33"
        fill="${ACCENT}" fill-opacity="0.95"/>
      <text x="${W / 2}" y="${H - 47}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="white" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio")}</text>
    </svg>
  `);
}

// ─────────────────────────────────────────────────────────
// TEMPLATE 4 — sideStrip
// Accent-colored vertical strip on the left (salon name inside,
// rotated). "NOW BOOKING" on the photo at top right. Slot cards
// are white with a small accent circle badge — a structured,
// editorial-meets-editorial salon feel.
// ─────────────────────────────────────────────────────────
function buildOverlaySvg_sideStrip({ slots, stylistName, salonName, bookingCta, instagramHandle, palette }) {
  const font   = `'Open Sans', Arial, Helvetica, sans-serif`;
  const ACCENT = palette?.cta || palette?.accent || "#3B72B9";
  const DARK   = palette?.primary || "#1a1c22";
  const { r: dr, g: dg, b: db } = hexToRgb(DARK);

  const STRIP_W = 188;
  const CARD_L  = STRIP_W + 28;
  const CARD_W  = W - CARD_L - 48;
  const SLOT_START = 500;
  const SLOT_H     = 112;
  const SLOT_GAP   = 20;
  const slotCount  = Math.min(slots.length, 5);
  const BADGE_R    = 38;

  const slotCards = slots.slice(0, slotCount).map((slot, i) => {
    const y  = SLOT_START + i * (SLOT_H + SLOT_GAP);
    const cy = y + SLOT_H / 2;
    const rx = 16;
    const { day, rest } = parseDayFromSlot(slot);
    const label = day || String(i + 1);
    const text  = rest.length > 30 ? rest.slice(0, 29) + "…" : rest;
    const badgeCx = CARD_L + BADGE_R + 16;
    return `
      <rect x="${CARD_L + 4}" y="${y + 5}" width="${CARD_W}" height="${SLOT_H}" rx="${rx}"
        fill="black" fill-opacity="0.15"/>
      <rect x="${CARD_L}" y="${y}" width="${CARD_W}" height="${SLOT_H}" rx="${rx}"
        fill="white" fill-opacity="0.93"/>
      <circle cx="${badgeCx}" cy="${cy}" r="${BADGE_R}" fill="${ACCENT}"/>
      <text x="${badgeCx}" y="${cy}"
        font-family="${font}" font-size="28" font-weight="800"
        fill="white" text-anchor="middle" dominant-baseline="middle">
        ${escSvg(label)}</text>
      <text x="${badgeCx + BADGE_R + 22}" y="${cy}"
        font-family="${font}" font-size="32" font-weight="700"
        fill="rgba(${dr},${dg},${db},0.92)" dominant-baseline="middle">
        ${escSvg(text)}</text>`;
  }).join("");

  const BOT_Y = H - 310;
  const centerX = (STRIP_W + W) / 2;
  return Buffer.from(`
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <style>${FONT_FACE}</style>
        <radialGradient id="vign_ss" cx="62%" cy="45%" r="62%">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="80%"  stop-color="black" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.28"/>
        </radialGradient>
        <linearGradient id="topFade_ss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0.62"/>
          <stop offset="100%" stop-color="black" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="botFade_ss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="black" stop-opacity="0"/>
          <stop offset="100%" stop-color="black" stop-opacity="0.80"/>
        </linearGradient>
      </defs>

      <rect width="${W}" height="${H}" fill="url(#vign_ss)"/>
      <rect x="${STRIP_W}" y="0" width="${W - STRIP_W}" height="480"
        fill="url(#topFade_ss)"/>
      <rect x="${STRIP_W}" y="${BOT_Y}" width="${W - STRIP_W}" height="${H - BOT_Y}"
        fill="url(#botFade_ss)"/>

      <!-- Accent side strip — photo shows through slightly -->
      <rect x="0" y="0" width="${STRIP_W}" height="${H}"
        fill="${ACCENT}" fill-opacity="0.90"/>
      <!-- Subtle inner highlight on strip right edge -->
      <rect x="${STRIP_W - 6}" y="0" width="6" height="${H}"
        fill="white" fill-opacity="0.15"/>

      <!-- Salon name rotated inside strip -->
      <text transform="translate(${STRIP_W / 2}, ${H / 2}) rotate(-90)"
        font-family="${font}" font-size="26" font-weight="800"
        fill="white" fill-opacity="0.90" text-anchor="middle" letter-spacing="8">
        ${escSvg(salonName.toUpperCase())}</text>

      <!-- Small white rule in strip, top area -->
      <rect x="32" y="130" width="${STRIP_W - 64}" height="4" rx="2"
        fill="white" fill-opacity="0.45"/>

      <!-- NOW BOOKING on the photo side -->
      <text x="${CARD_L}" y="234"
        font-family="${font}" font-size="108" font-weight="800"
        fill="white" letter-spacing="-3">NOW</text>
      <text x="${CARD_L}" y="352"
        font-family="${font}" font-size="108" font-weight="800"
        fill="white" letter-spacing="-3">BOOKING</text>
      <rect x="${CARD_L}" y="366" width="240" height="7" rx="3.5" fill="white" fill-opacity="0.70"/>

      ${slotCards}

      <text x="${centerX}" y="${H - 178}"
        font-family="${font}" font-size="36" font-weight="700"
        fill="white" text-anchor="middle">${escSvg(stylistName)}</text>

      ${instagramHandle ? `
      <text x="${centerX}" y="${H - 124}"
        font-family="${font}" font-size="28" font-weight="600"
        fill="white" fill-opacity="0.82" text-anchor="middle">
        @${escSvg(instagramHandle.replace(/^@/, ""))}</text>` : ""}

      <!-- CTA pill — white with accent text (inverted for contrast on dark strip) -->
      <rect x="${STRIP_W + 40}" y="${H - 90}" width="${W - STRIP_W - 88}" height="66" rx="33"
        fill="white" fill-opacity="0.95"/>
      <text x="${centerX}" y="${H - 47}"
        font-family="${font}" font-size="26" font-weight="800"
        fill="${ACCENT}" text-anchor="middle">
        ${escSvg(bookingCta || "Book via link in bio")}</text>
    </svg>
  `);
}

// ─────────────────────────────────────────────────────────
// Dispatcher — picks a random template each time
// ─────────────────────────────────────────────────────────
const OVERLAY_TEMPLATES = ["tornCard", "verticalLabel", "ghostPills", "sideStrip"];

function buildOverlaySvg(opts) {
  const template = OVERLAY_TEMPLATES[Math.floor(Math.random() * OVERLAY_TEMPLATES.length)];
  console.log(`[Availability] Using layout template: ${template}`);
  switch (template) {
    case "verticalLabel": return buildOverlaySvg_verticalLabel(opts);
    case "ghostPills":    return buildOverlaySvg_ghostPills(opts);
    case "sideStrip":     return buildOverlaySvg_sideStrip(opts);
    default:              return buildOverlaySvg_tornCard(opts);
  }
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
