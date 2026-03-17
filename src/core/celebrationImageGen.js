// src/core/celebrationImageGen.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";
import { renderHtmlToJpeg } from "./puppeteerRenderer.js";
import { TEMPLATES } from "./postTemplates.js";

const CELEBRATIONS_DIR = path.join(UPLOADS_DIR, "celebrations");
fs.mkdirSync(CELEBRATIONS_DIR, { recursive: true });

const ACCENT_COLOR = "#3B72B9";
const FALLBACK_TEMPLATE = "script";

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
    const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Generate birthday/anniversary images in square (feed) and vertical (story) formats.
 *
 * @param {object} opts
 * @param {string}  opts.profilePhotoUrl
 * @param {string}  [opts.salonLogoPath]
 * @param {string}  opts.firstName
 * @param {"birthday"|"anniversary"} opts.celebrationType
 * @param {number}  [opts.anniversaryYears]
 * @param {string}  [opts.salonName]
 * @param {string}  [opts.accentColor]
 * @param {string}  [opts.template]   — key from TEMPLATES.celebration (default "script")
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
  primaryColor = null,
  template = FALLBACK_TEMPLATE,
}) {
  const buildHtml = TEMPLATES.celebration[template] || TEMPLATES.celebration[FALLBACK_TEMPLATE];
  if (!TEMPLATES.celebration[template]) {
    console.warn(`[CelebrationImage] Unknown template "${template}", falling back to "${FALLBACK_TEMPLATE}"`);
  }

  const subLabel = celebrationType === "anniversary" && anniversaryYears
    ? `${anniversaryYears} Year${anniversaryYears === 1 ? "" : "s"} · ${salonName}`
    : "";

  const [photoDataUri, logoDataUri] = await Promise.all([
    toBase64DataUri(profilePhotoUrl),
    salonLogoPath ? toBase64DataUri(salonLogoPath) : Promise.resolve(null),
  ]);

  const SQUARE_W = 1080, SQUARE_H = 1080;
  const STORY_W  = 1080, STORY_H  = 1920;

  const bandHex = primaryColor || "#1a1c22";
  const sharedOpts = { photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex: accentColor, bandHex };

  const [squareBuf, storyBuf] = await Promise.all([
    renderHtmlToJpeg(buildHtml({ width: SQUARE_W, height: SQUARE_H, ...sharedOpts }), SQUARE_W, SQUARE_H),
    renderHtmlToJpeg(buildHtml({ width: STORY_W,  height: STORY_H,  ...sharedOpts }), STORY_W,  STORY_H),
  ]);

  const feedFile  = `${crypto.randomUUID()}-feed.jpg`;
  const storyFile = `${crypto.randomUUID()}-story.jpg`;
  fs.writeFileSync(path.join(CELEBRATIONS_DIR, feedFile),  squareBuf);
  fs.writeFileSync(path.join(CELEBRATIONS_DIR, storyFile), storyBuf);

  return {
    feedUrl:  toUploadUrl(`celebrations/${feedFile}`),
    storyUrl: toUploadUrl(`celebrations/${storyFile}`),
  };
}
