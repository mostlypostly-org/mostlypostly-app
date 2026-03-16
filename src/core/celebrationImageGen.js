// src/core/celebrationImageGen.js
// Generates dual-format celebration images: 1080x1080 (feed) + 1080x1920 (story).
// Uses Puppeteer (headless Chrome) for browser-quality rendering.
// Layers: stylist photo → vignette → accent bar → large name text → logo → #MostlyPostly

import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";
import { renderHtmlToJpeg } from "./puppeteerRenderer.js";

const CELEBRATIONS_DIR = path.join(UPLOADS_DIR, "celebrations");
fs.mkdirSync(CELEBRATIONS_DIR, { recursive: true });

const ACCENT_COLOR = "#3B72B9";

// Font style definitions — Google Fonts loaded by the browser directly
const FONT_STYLES = {
  script: {
    googleFonts: "Great+Vibes|Lato:wght@300;400",
    headlineFont: "'Great Vibes', cursive",
    labelFont: "'Lato', sans-serif",
    labelWeight: "300",
    letterSpacing: "6px",
  },
  editorial: {
    googleFonts: "Montserrat:wght@400;700;800",
    headlineFont: "'Montserrat', sans-serif",
    headlineWeight: "800",
    labelFont: "'Montserrat', sans-serif",
    labelWeight: "400",
    letterSpacing: "8px",
  },
  playful: {
    googleFonts: "Pacifico|Lato:wght@400",
    headlineFont: "'Pacifico', cursive",
    labelFont: "'Lato', sans-serif",
    labelWeight: "400",
    letterSpacing: "4px",
  },
};

async function toBase64DataUri(source) {
  try {
    let buf;
    if (source?.startsWith("http")) {
      const resp = await fetch(source, { timeout: 10000 });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      buf = Buffer.from(await resp.arrayBuffer());
    } else if (source && fs.existsSync(source)) {
      buf = fs.readFileSync(source);
    } else {
      throw new Error("no source");
    }
    // Detect mime type by magic bytes
    const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function buildHtml({ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex, fontStyle }) {
  const style = FONT_STYLES[fontStyle] || FONT_STYLES.script;
  const eyebrow = celebrationType === "birthday" ? "Happy Birthday" : "Happy Anniversary";
  const safe = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Responsive font size: clamp based on canvas height
  // For 1080×1080: ~180px name. For 1080×1920: ~220px name.
  const nameFontSize = Math.round(height * 0.165);
  const eyebrowFontSize = Math.round(height * 0.022);
  const subFontSize = Math.round(height * 0.028);

  const pad = Math.round(width * 0.055);
  const photoBg = photoDataUri ? `
    <!-- Blurred fill layer — no zoom distortion -->
    <img class="bg-blur" src="${photoDataUri}" />
    <!-- Sharp photo contained — no cropping -->
    <img class="bg-photo" src="${photoDataUri}" />
  ` : `<div class="bg-gradient"></div>`;

  const logoHtml = logoDataUri
    ? `<div class="logo-wrap"><img id="logo" src="${logoDataUri}" /></div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${style.googleFonts}&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  position: relative;
  background: #1a1c22;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
}

/* Blurred background fill — covers the whole canvas, no distortion */
.bg-blur {
  position: absolute;
  inset: -30px;
  width: calc(100% + 60px);
  height: calc(100% + 60px);
  object-fit: cover;
  object-position: center top;
  filter: blur(22px) brightness(0.45) saturate(1.1);
}

/* Sharp photo — contained (no crop), centered in top 68% of canvas */
.bg-photo {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 68%;
  object-fit: contain;
  object-position: center top;
}

.bg-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, ${accentHex}cc 0%, #1a1c22 100%);
}

/* Vignette — transparent at top, heavy at bottom */
.vignette {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(0,0,0,0.0)  0%,
    rgba(0,0,0,0.08) 30%,
    rgba(0,0,0,0.60) 58%,
    rgba(0,0,0,0.90) 75%,
    rgba(0,0,0,0.97) 100%
  );
}

/* Text content — pinned to bottom */
.content {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: ${Math.round(height * 0.05)}px ${pad}px ${Math.round(height * 0.07)}px;
}

.accent-bar {
  width: ${Math.round(width * 0.075)}px;
  height: ${Math.round(height * 0.004)}px;
  background: ${accentHex};
  border-radius: 2px;
  margin-bottom: ${Math.round(height * 0.018)}px;
}

.eyebrow {
  font-family: ${style.labelFont};
  font-size: ${eyebrowFontSize}px;
  font-weight: ${style.labelWeight || "400"};
  color: rgba(255,255,255,0.75);
  letter-spacing: ${style.letterSpacing};
  text-transform: uppercase;
  margin-bottom: ${Math.round(height * 0.01)}px;
  line-height: 1.2;
}

.name {
  font-family: ${style.headlineFont};
  font-size: ${nameFontSize}px;
  font-weight: ${style.headlineWeight || "normal"};
  color: #ffffff;
  line-height: 1.05;
  text-shadow: 0 4px 24px rgba(0,0,0,0.5);
  letter-spacing: ${fontStyle === "editorial" ? "2px" : "0"};
}

.sub-label {
  font-family: ${style.labelFont};
  font-size: ${subFontSize}px;
  font-weight: ${style.labelWeight || "400"};
  color: rgba(255,255,255,0.65);
  margin-top: ${Math.round(height * 0.014)}px;
  letter-spacing: 2px;
}

/* Logo — top right, frosted glass pill so it's legible on any background */
.logo-wrap {
  position: absolute;
  top: ${Math.round(height * 0.028)}px;
  right: ${pad}px;
  background: rgba(0,0,0,0.28);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border-radius: ${Math.round(height * 0.012)}px;
  padding: ${Math.round(height * 0.012)}px ${Math.round(width * 0.022)}px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.logo-wrap img {
  max-width: ${Math.round(width * 0.20)}px;
  max-height: ${Math.round(height * 0.055)}px;
  object-fit: contain;
  display: block;
}

/* Watermark — bottom left */
.watermark {
  position: absolute;
  bottom: ${Math.round(height * 0.022)}px;
  left: ${pad}px;
  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: ${Math.round(height * 0.014)}px;
  font-weight: 400;
  color: rgba(255,255,255,0.35);
  letter-spacing: 0.5px;
}
</style>
</head>
<body>
  ${photoBg}
  <div class="vignette"></div>

  <div class="content">
    <div class="accent-bar"></div>
    <div class="eyebrow">${safe(eyebrow)}</div>
    <div class="name">${safe(firstName)}</div>
    ${subLabel ? `<div class="sub-label">${safe(subLabel)}</div>` : ""}
  </div>

  ${logoHtml}
  <div class="watermark">#MostlyPostly</div>

  ${logoDataUri ? `<script>
  // Sample brightness at the logo area (top-right) to decide white vs dark logo
  window.addEventListener('load', function() {
    var bgImg = document.querySelector('.bg-photo') || document.querySelector('.bg-blur');
    var logo  = document.getElementById('logo');
    if (!bgImg || !logo) return;
    try {
      var c = document.createElement('canvas');
      c.width = 80; c.height = 40;
      var ctx = c.getContext('2d');
      ctx.drawImage(bgImg, bgImg.naturalWidth * 0.65, 0, bgImg.naturalWidth * 0.35, bgImg.naturalHeight * 0.12, 0, 0, 80, 40);
      var d = ctx.getImageData(0, 0, 80, 40).data;
      var brightness = 0;
      for (var i = 0; i < d.length; i += 4) brightness += (d[i] * 299 + d[i+1] * 587 + d[i+2] * 114) / 1000;
      brightness /= (d.length / 4);
      // Light background → dark logo; dark background → white logo
      logo.style.filter = brightness > 140 ? 'brightness(0)' : 'brightness(0) invert(1)';
    } catch(e) {
      logo.style.filter = 'brightness(0) invert(1)'; // fallback white
    }
  });
  </script>` : ''}
</body>
</html>`;
}

/**
 * Generate birthday/anniversary images in square (feed) and vertical (story) formats.
 *
 * @param {object} opts
 * @param {string}  opts.profilePhotoUrl         Stylist photo URL or absolute local path
 * @param {string}  [opts.salonLogoPath]         Absolute path to salon logo file
 * @param {string}  opts.firstName
 * @param {"birthday"|"anniversary"} opts.celebrationType
 * @param {number}  [opts.anniversaryYears]
 * @param {string}  [opts.salonName]
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
  const subLabel = "";

  // Load photo and logo as base64 in parallel
  const [photoDataUri, logoDataUri] = await Promise.all([
    toBase64DataUri(profilePhotoUrl),
    salonLogoPath ? toBase64DataUri(salonLogoPath) : Promise.resolve(null),
  ]);

  const SQUARE_W = 1080, SQUARE_H = 1080;
  const STORY_W  = 1080, STORY_H  = 1920;

  const sharedOpts = { photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex: accentColor, fontStyle };

  // Render both formats in parallel
  const [squareBuf, storyBuf] = await Promise.all([
    renderHtmlToJpeg(buildHtml({ width: SQUARE_W, height: SQUARE_H, ...sharedOpts }), SQUARE_W, SQUARE_H),
    renderHtmlToJpeg(buildHtml({ width: STORY_W,  height: STORY_H,  ...sharedOpts }), STORY_W,  STORY_H),
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
