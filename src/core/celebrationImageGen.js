// src/core/celebrationImageGen.js
// Generates dual-format celebration images: 1080x1080 (feed) + 1080x1920 (story).
// Uses sharp + SVG with embedded Google Fonts base64.
// Layers: stylist photo → vignette → accent bar → text → logo watermark → #MostlyPostly

import sharp from "sharp";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";
import { getFontBase64 } from "./fontLoader.js";

const CELEBRATIONS_DIR = path.join(UPLOADS_DIR, "celebrations");
fs.mkdirSync(CELEBRATIONS_DIR, { recursive: true });

const ACCENT_COLOR = "#3B72B9";

// Font style definitions
const FONT_STYLES = {
  script: {
    headlineFont:   "Great Vibes",
    headlineSizes:  { square: 110, story: 130 },
    headlineWeight: "normal",
    labelFont:      "Lato",
    labelWeight:    "300",
    letterSpacing:  "4",
  },
  editorial: {
    headlineFont:   "Montserrat",
    headlineSizes:  { square: 96, story: 116 },
    headlineWeight: "700",
    labelFont:      "Montserrat",
    labelWeight:    "400",
    letterSpacing:  "8",
  },
  playful: {
    headlineFont:   "Pacifico",
    headlineSizes:  { square: 88, story: 108 },
    headlineWeight: "normal",
    labelFont:      "Lato",
    labelWeight:    "400",
    letterSpacing:  "3",
  },
};

async function fetchImageBuffer(url) {
  const resp = await fetch(url, { timeout: 10000 });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function loadPhotoBuffer(profilePhotoUrl, width, height, accentHex) {
  try {
    let raw;
    if (profilePhotoUrl?.startsWith("http")) {
      raw = await fetchImageBuffer(profilePhotoUrl);
    } else if (profilePhotoUrl && fs.existsSync(profilePhotoUrl)) {
      raw = fs.readFileSync(profilePhotoUrl);
    } else {
      throw new Error("no photo");
    }
    return await sharp(raw)
      .resize(width, height, { fit: "cover", position: "attention" })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    // Fallback: gradient background using accent color
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${accentHex}" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#1a1c22"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#bg)"/>
    </svg>`;
    return await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }
}

async function buildOverlaySvg({ width, height, celebrationType, firstName, subLabel, accentHex, fontStyle }) {
  const style = FONT_STYLES[fontStyle] || FONT_STYLES.script;
  const isSquare = width === 1080 && height === 1080;
  const headlineSize = style.headlineSizes[isSquare ? "square" : "story"];

  const eyebrow = celebrationType === "birthday"
    ? "HAPPY BIRTHDAY"
    : "HAPPY WORK ANNIVERSARY";

  const safe = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Load fonts (returns null on failure — SVG falls back to system font)
  const headlineB64 = await getFontBase64(style.headlineFont);
  const labelB64    = style.labelFont !== style.headlineFont
    ? await getFontBase64(style.labelFont)
    : headlineB64;

  const fontFaces = [
    headlineB64 ? `@font-face { font-family: '${style.headlineFont}'; src: url('${headlineB64}'); }` : "",
    (labelB64 && style.labelFont !== style.headlineFont)
      ? `@font-face { font-family: '${style.labelFont}'; src: url('${labelB64}'); }`
      : "",
  ].filter(Boolean).join("\n    ");

  // Text block sits in the lower 38% of the image
  const textStartY   = Math.round(height * 0.62);
  const accentBarY   = textStartY - 20;
  const eyebrowY     = textStartY + 4;
  const nameY        = eyebrowY + headlineSize + 8;
  const subLabelY    = nameY + 38;
  const mpWatermarkY = height - 24;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <style>
    ${fontFaces}
    </style>
    <linearGradient id="vignette" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="black" stop-opacity="0"/>
      <stop offset="40%"  stop-color="black" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.88"/>
    </linearGradient>
  </defs>

  <!-- Full canvas vignette -->
  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#vignette)"/>

  <!-- Accent bar above text -->
  <rect x="48" y="${accentBarY}" width="72" height="3" fill="${safe(accentHex)}" rx="1.5"/>

  <!-- Eyebrow label -->
  <text x="48" y="${eyebrowY}"
    font-family="'${safe(style.labelFont)}', 'Helvetica Neue', Helvetica, sans-serif"
    font-size="17" font-weight="${style.labelWeight}"
    fill="rgba(255,255,255,0.65)"
    letter-spacing="${style.letterSpacing}">
    ${safe(eyebrow)}
  </text>

  <!-- First name — styled headline -->
  <text x="44" y="${nameY}"
    font-family="'${safe(style.headlineFont)}', 'Helvetica Neue', Helvetica, sans-serif"
    font-size="${headlineSize}" font-weight="${style.headlineWeight}"
    fill="white">
    ${safe(firstName)}
  </text>

  ${subLabel ? `
  <!-- Anniversary sub-label -->
  <text x="50" y="${subLabelY}"
    font-family="'${safe(style.labelFont)}', 'Helvetica Neue', Helvetica, sans-serif"
    font-size="24" font-weight="${style.labelWeight}"
    fill="rgba(255,255,255,0.6)"
    letter-spacing="2">
    ${safe(subLabel)}
  </text>` : ""}

  <!-- #MostlyPostly watermark — bottom left -->
  <text x="24" y="${mpWatermarkY}"
    font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"
    font-size="13" font-weight="400"
    fill="rgba(255,255,255,0.32)"
    letter-spacing="0.5">
    #MostlyPostly
  </text>
</svg>`;
}

async function buildLogoLayer(salonLogoPath, canvasWidth, canvasHeight) {
  if (!salonLogoPath || !fs.existsSync(salonLogoPath)) return null;

  try {
    const LOGO_W  = 110;
    const PADDING = 24;
    const rawLogo = fs.readFileSync(salonLogoPath);

    const logoResized = await sharp(rawLogo)
      .resize(LOGO_W, null, { fit: "inside" })
      .png()
      .toBuffer();

    const meta  = await sharp(logoResized).metadata();
    const logoW = meta.width  || LOGO_W;
    const logoH = meta.height || 60;

    // Apply 70% opacity via a white overlay composite using dest-in blend
    const tinted = await sharp({
      create: { width: logoW, height: logoH, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.70 } },
    })
      .png()
      .composite([{ input: logoResized, blend: "dest-in" }])
      .png()
      .toBuffer();

    return {
      input: tinted,
      top:  canvasHeight - logoH - PADDING,
      left: canvasWidth  - logoW  - PADDING,
    };
  } catch (err) {
    console.warn("[celebrationImageGen] Logo layer failed:", err.message);
    return null;
  }
}

async function renderImage({ photoBuffer, svgOverlay, logoLayer }) {
  const layers = [{ input: Buffer.from(svgOverlay), top: 0, left: 0 }];
  if (logoLayer) layers.push(logoLayer);

  return sharp(photoBuffer)
    .composite(layers)
    .jpeg({ quality: 88 })
    .toBuffer();
}

/**
 * Generate birthday/anniversary images in square (feed) and vertical (story) formats.
 *
 * @param {object} opts
 * @param {string}  opts.profilePhotoUrl         Stylist photo URL or absolute local path
 * @param {string}  [opts.salonLogoPath]         Absolute path to salon logo file
 * @param {string}  opts.firstName
 * @param {"birthday"|"anniversary"} opts.celebrationType
 * @param {number}  [opts.anniversaryYears]      e.g. 5
 * @param {string}  [opts.salonName]             Used in anniversary sub-label
 * @param {string}  [opts.accentColor]           Hex e.g. "#3B72B9"
 * @param {"script"|"editorial"|"playful"} [opts.fontStyle]
 * @returns {Promise<{ feedUrl: string, storyUrl: string }>}
 */
export async function generateCelebrationImage({
  profilePhotoUrl,
  salonLogoPath,
  firstName,
  celebrationType,
  anniversaryYears,
  salonName = "",
  accentColor = ACCENT_COLOR,
  fontStyle = "script",
}) {
  const subLabel = celebrationType === "anniversary" && anniversaryYears
    ? `${anniversaryYears} ${anniversaryYears === 1 ? "Year" : "Years"} · ${salonName}`
    : "";

  const SQUARE_W = 1080, SQUARE_H = 1080;
  const STORY_W  = 1080, STORY_H  = 1920;

  // Load photos and logo layers in parallel
  const [squarePhoto, storyPhoto, squareLogo, storyLogo] = await Promise.all([
    loadPhotoBuffer(profilePhotoUrl, SQUARE_W, SQUARE_H, accentColor),
    loadPhotoBuffer(profilePhotoUrl, STORY_W,  STORY_H,  accentColor),
    buildLogoLayer(salonLogoPath, SQUARE_W, SQUARE_H),
    buildLogoLayer(salonLogoPath, STORY_W,  STORY_H),
  ]);

  // Build SVG overlays (font fetching happens here)
  const [squareSvg, storySvg] = await Promise.all([
    buildOverlaySvg({ width: SQUARE_W, height: SQUARE_H, celebrationType, firstName, subLabel, accentHex: accentColor, fontStyle }),
    buildOverlaySvg({ width: STORY_W,  height: STORY_H,  celebrationType, firstName, subLabel, accentHex: accentColor, fontStyle }),
  ]);

  // Render both in parallel
  const [squareBuf, storyBuf] = await Promise.all([
    renderImage({ photoBuffer: squarePhoto, svgOverlay: squareSvg, logoLayer: squareLogo }),
    renderImage({ photoBuffer: storyPhoto,  svgOverlay: storySvg,  logoLayer: storyLogo }),
  ]);

  // Save to disk
  const feedFile  = `${crypto.randomUUID()}-feed.jpg`;
  const storyFile = `${crypto.randomUUID()}-story.jpg`;
  fs.writeFileSync(path.join(CELEBRATIONS_DIR, feedFile),  squareBuf);
  fs.writeFileSync(path.join(CELEBRATIONS_DIR, storyFile), storyBuf);

  return {
    feedUrl:  toUploadUrl(`celebrations/${feedFile}`),
    storyUrl: toUploadUrl(`celebrations/${storyFile}`),
  };
}
