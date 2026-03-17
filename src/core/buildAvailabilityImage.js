// src/core/buildAvailabilityImage.js
// HTML/Puppeteer availability story image generator.
// Template selected per salon via salons.availability_template column.

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { db } from "../../db.js";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";
import { renderHtmlToJpeg } from "./puppeteerRenderer.js";
import { TEMPLATES } from "./postTemplates.js";
import { fetchPexelsBackground } from "./pexels.js";

// Instagram Story: 9:16
const W = 1080;
const H = 1920;
const FALLBACK_TEMPLATE = "script";

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

// ─────────────────────────────────────────────────────────
// Convert URL or local file path to base64 data URI
// Handles Twilio authenticated URLs, HTTP URLs, and local paths.
// ─────────────────────────────────────────────────────────
async function toBase64DataUri(source) {
  try {
    let buf;
    if (source?.startsWith("http")) {
      const isTwilio = /^https:\/\/api\.twilio\.com/i.test(source);
      const headers = isTwilio
        ? { Authorization: "Basic " + Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString("base64") }
        : {};
      const resp = await fetch(source, { headers, redirect: "follow", timeout: 10000 });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      buf = Buffer.from(await resp.arrayBuffer());
    } else if (source && fs.existsSync(source)) {
      buf = fs.readFileSync(source);
    } else {
      throw new Error("no source");
    }
    const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.warn("[Availability] toBase64DataUri failed for source:", (source || "").slice(0, 80), err?.message);
    return null;
  }
}

/**
 * Build the availability story image.
 *
 * @param {object} opts
 * @param {string}   opts.text            - Raw availability message from stylist (used if slots not pre-built)
 * @param {string[]} [opts.slots]         - Pre-built slot strings (e.g. from Zenoti sync) — skips GPT parse
 * @param {string}   opts.stylistName
 * @param {string}   opts.salonName
 * @param {string}   opts.salonId
 * @param {string}   [opts.stylistId]
 * @param {string}   [opts.instagramHandle]
 * @param {string}   [opts.bookingCta]
 * @param {string}   [opts.submittedImageUrl] - Photo submitted with the message (wins over stock)
 * @returns {Promise<string>}  Public URL of the saved story JPEG
 */
export async function buildAvailabilityImage({ text, slots: prebuiltSlots, stylistName, salonName, salonId, stylistId, instagramHandle, bookingCta, submittedImageUrl, templateKey }) {
  console.log("[Availability] Building story image…");

  // 1. Parse slots — skip GPT if pre-structured slots provided (e.g. from Zenoti sync)
  const slots = prebuiltSlots && prebuiltSlots.length
    ? prebuiltSlots
    : await parseAvailabilitySlots(text);
  console.log("[Availability] Slots parsed:", slots);

  // 2. Pick background URL
  const bgUrl = submittedImageUrl || await pickBackground(stylistId, salonId);

  // 3. Load salon row: template key, palette, logo
  const salonRow = db.prepare(
    `SELECT availability_template, brand_palette, logo_url FROM salons WHERE slug = ?`
  ).get(salonId) || {};

  const template = templateKey || salonRow.availability_template || FALLBACK_TEMPLATE;
  let palette = {};
  try { if (salonRow.brand_palette) palette = JSON.parse(salonRow.brand_palette); } catch {}

  const accentHex = palette.cta || palette.accent || "#3B72B9";
  const bandHex   = palette.primary || "#1a1c22";

  // 4. Resolve logo path (prefer local file over HTTP self-fetch)
  const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  let logoSource = null;
  if (salonRow.logo_url) {
    if (PUBLIC_BASE && salonRow.logo_url.startsWith(PUBLIC_BASE + "/uploads/")) {
      const rel = salonRow.logo_url.slice(PUBLIC_BASE.length);
      const abs = path.resolve("public" + rel);
      logoSource = fs.existsSync(abs) ? abs : salonRow.logo_url;
    } else if (salonRow.logo_url.startsWith("/uploads/")) {
      const abs = path.resolve("public" + salonRow.logo_url);
      logoSource = fs.existsSync(abs) ? abs : null;
    } else {
      logoSource = salonRow.logo_url;
    }
  }

  // 5. Convert photo and logo to base64 data URIs for Puppeteer
  const [photoDataUri, logoDataUri] = await Promise.all([
    bgUrl ? toBase64DataUri(bgUrl) : Promise.resolve(null),
    logoSource ? toBase64DataUri(logoSource) : Promise.resolve(null),
  ]);

  // 6. Select template builder with fallback
  const buildHtml = TEMPLATES.availability[template] || TEMPLATES.availability[FALLBACK_TEMPLATE];
  if (!TEMPLATES.availability[template]) {
    console.warn(`[Availability] Unknown template "${template}", falling back to "${FALLBACK_TEMPLATE}"`);
  }

  // 7. Build HTML and render via Puppeteer
  const html = buildHtml({ width: W, height: H, photoDataUri, logoDataUri, stylistName, salonName, slots, bookingCta, instagramHandle, accentHex, bandHex });
  let buf;
  try {
    buf = await renderHtmlToJpeg(html, W, H);
  } catch (err) {
    console.error("[Availability] Puppeteer render failed:", err.message);
    throw err;
  }

  // 8. Save and return public URL
  const fileName = `availability-${crypto.randomUUID()}.jpg`;
  const filePath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, buf);

  const publicUrl = toUploadUrl(fileName);
  console.log("[Availability] Story image saved:", publicUrl);
  return publicUrl;
}
