// src/core/celebrationImageGen.js
// Generates celebration post images: stylist photo + salon logo overlay
// + gradient text card with name and celebration type.
// Uses sharp for compositing. Output saved to public/uploads/celebrations/.

import sharp from "sharp";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";

const CELEBRATIONS_DIR = path.join(UPLOADS_DIR, "celebrations");
fs.mkdirSync(CELEBRATIONS_DIR, { recursive: true });

const CANVAS_SIZE = 1080;
const LOGO_SIZE   = 180;  // logo width in top-right corner

// Brand colors (fallback if salon has no palette)
const ACCENT_COLOR = "#3B72B9";
const DARK_COLOR   = "#2B2D35";

/**
 * Download an image from a URL and return a Buffer.
 */
async function fetchImageBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image: ${url} → ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Build the SVG text + gradient overlay.
 * @param {string} celebrationType  "birthday" | "anniversary"
 * @param {string} displayName      "Jane D."
 * @param {string} subLabel         e.g. "5 Years with Vanity Lounge"  (anniversary only)
 * @param {string} accentHex        brand accent color
 */
function buildOverlaySvg(celebrationType, displayName, subLabel, accentHex = ACCENT_COLOR) {
  const emoji      = celebrationType === "birthday" ? "🎂" : "🎉";
  const headline   = celebrationType === "birthday"
    ? "Happy Birthday!"
    : "Happy Work Anniversary!";

  // Escape for SVG
  const safe = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `
<svg width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="black" stop-opacity="0"/>
      <stop offset="50%"  stop-color="black" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.88"/>
    </linearGradient>
  </defs>

  <!-- Bottom gradient -->
  <rect x="0" y="${CANVAS_SIZE * 0.45}" width="${CANVAS_SIZE}" height="${CANVAS_SIZE * 0.55}"
        fill="url(#grad)"/>

  <!-- Accent top stripe (8px) -->
  <rect x="0" y="0" width="${CANVAS_SIZE}" height="8" fill="${safe(accentHex)}"/>

  <!-- Emoji + headline -->
  <text x="60" y="870"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="44" font-weight="600"
        fill="${safe(accentHex)}" letter-spacing="1">
    ${emoji}  ${safe(headline)}
  </text>

  <!-- Name — large -->
  <text x="60" y="970"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="82" font-weight="800"
        fill="white" letter-spacing="-1">
    ${safe(displayName)}
  </text>

  ${subLabel ? `
  <!-- Sub-label (anniversary years) -->
  <text x="62" y="1040"
        font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
        font-size="32" font-weight="400"
        fill="rgba(255,255,255,0.75)">
    ${safe(subLabel)}
  </text>` : ""}
</svg>`.trim();
}

/**
 * Generate a celebration card image.
 *
 * @param {object} opts
 * @param {string}  opts.profilePhotoUrl   Stylist profile photo (URL or local path)
 * @param {string}  opts.salonLogoPath     Absolute path to salon logo file
 * @param {string}  opts.firstName         Stylist first name
 * @param {string}  opts.lastName          Stylist last name (only initial used)
 * @param {"birthday"|"anniversary"} opts.celebrationType
 * @param {number}  [opts.anniversaryYears] Number of years (anniversary only)
 * @param {string}  [opts.salonName]       Used in anniversary sub-label
 * @param {string}  [opts.accentColor]     Hex color for accents
 * @returns {Promise<string>}              Public URL path e.g. "/uploads/celebrations/abc123.jpg"
 */
export async function generateCelebrationImage({
  profilePhotoUrl,
  salonLogoPath,
  firstName,
  lastName,
  celebrationType,
  anniversaryYears,
  salonName = "",
  accentColor = ACCENT_COLOR,
}) {
  const displayName = `${firstName} ${lastName ? lastName[0] + "." : ""}`.trim();
  const subLabel    = celebrationType === "anniversary" && anniversaryYears
    ? `${anniversaryYears} ${anniversaryYears === 1 ? "Year" : "Years"} with ${salonName}`
    : "";

  // 1. Load + resize profile photo to square canvas
  let photoBuffer;
  if (profilePhotoUrl?.startsWith("http")) {
    photoBuffer = await fetchImageBuffer(profilePhotoUrl);
  } else if (profilePhotoUrl && fs.existsSync(profilePhotoUrl)) {
    photoBuffer = fs.readFileSync(profilePhotoUrl);
  } else {
    // Fallback: solid brand-color background
    photoBuffer = await sharp({
      create: {
        width: CANVAS_SIZE, height: CANVAS_SIZE,
        channels: 3,
        background: { r: 43, g: 45, b: 53 }, // mpCharcoal
      }
    }).jpeg().toBuffer();
  }

  const baseImage = await sharp(photoBuffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "cover", position: "top" })
    .jpeg({ quality: 90 })
    .toBuffer();

  // 2. Build SVG overlay
  const svgOverlay = Buffer.from(buildOverlaySvg(celebrationType, displayName, subLabel, accentColor));

  // 3. Build compositing layers
  const layers = [
    { input: svgOverlay, top: 0, left: 0 },
  ];

  // 4. Overlay salon logo in top-right corner (if logo exists)
  const logoPath = salonLogoPath || path.resolve("public/logo/logo-mark.png");
  if (fs.existsSync(logoPath)) {
    try {
      const logoBuffer = await sharp(fs.readFileSync(logoPath))
        .resize(LOGO_SIZE, null, { fit: "inside" })  // maintain aspect ratio
        .png()
        .toBuffer();

      const logoMeta  = await sharp(logoBuffer).metadata();
      const logoH     = logoMeta.height || 60;
      const PADDING   = 30;

      layers.push({
        input: logoBuffer,
        top:   PADDING,
        left:  CANVAS_SIZE - (logoMeta.width || LOGO_SIZE) - PADDING,
      });
    } catch (err) {
      console.warn("[celebrationImageGen] Logo overlay failed:", err.message);
    }
  }

  // 5. Composite everything
  const outputFilename = `${crypto.randomUUID()}.jpg`;
  const outputPath     = path.join(CELEBRATIONS_DIR, outputFilename);

  await sharp(baseImage)
    .composite(layers)
    .jpeg({ quality: 88 })
    .toFile(outputPath);

  return toUploadUrl(`celebrations/${outputFilename}`);
}
