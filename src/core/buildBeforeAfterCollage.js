// src/core/buildBeforeAfterCollage.js
// Composites two images side-by-side with "Before" / "After" labels.
// Returns a public URL to the saved collage.

import sharp from "sharp";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { UPLOADS_DIR, toUploadUrl } from "./uploadPath.js";

const OUTPUT_WIDTH  = 1080; // Instagram square-friendly
const OUTPUT_HEIGHT = 1080;
const HALF          = OUTPUT_WIDTH / 2;
const LABEL_HEIGHT  = 60;
const FONT_SIZE     = 36;

async function fetchImageBuffer(url, salon_id = "") {
  // If Twilio URL, auth it
  const isTwilio = /^https:\/\/api\.twilio\.com/i.test(url);
  const headers = isTwilio
    ? {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString("base64"),
      }
    : {};

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function labelSvg(text, width, height) {
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.55)" />
      <text
        x="${width / 2}"
        y="${height / 2 + FONT_SIZE / 3}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${FONT_SIZE}"
        font-weight="bold"
        fill="white"
        text-anchor="middle"
        letter-spacing="3"
      >${text.toUpperCase()}</text>
    </svg>
  `);
}

/**
 * Build a side-by-side Before / After collage.
 *
 * @param {string[]} imageUrls  - [beforeUrl, afterUrl]
 * @param {string}   salon_id
 * @returns {Promise<string>}   Public URL of the saved collage
 */
export async function buildBeforeAfterCollage(imageUrls, salon_id = "") {
  if (!imageUrls || imageUrls.length < 2) {
    throw new Error("Before/After collage requires exactly 2 images.");
  }

  const [beforeUrl, afterUrl] = imageUrls;

  console.log(`[BeforeAfter] Fetching images for collage…`);
  const [beforeBuf, afterBuf] = await Promise.all([
    fetchImageBuffer(beforeUrl, salon_id),
    fetchImageBuffer(afterUrl, salon_id),
  ]);

  // Resize each half to fit the panel, cropped to fill
  const [beforeResized, afterResized] = await Promise.all([
    sharp(beforeBuf)
      .resize(HALF, OUTPUT_HEIGHT, { fit: "cover", position: "center" })
      .toBuffer(),
    sharp(afterBuf)
      .resize(HALF, OUTPUT_HEIGHT, { fit: "cover", position: "center" })
      .toBuffer(),
  ]);

  // Build label overlays (bottom strip)
  const beforeLabel = labelSvg("Before", HALF, LABEL_HEIGHT);
  const afterLabel  = labelSvg("After",  HALF, LABEL_HEIGHT);

  // Composite each panel with its label
  const [beforePanel, afterPanel] = await Promise.all([
    sharp(beforeResized)
      .composite([{ input: beforeLabel, gravity: "south" }])
      .toBuffer(),
    sharp(afterResized)
      .composite([{ input: afterLabel, gravity: "south" }])
      .toBuffer(),
  ]);

  // Join side-by-side on a blank canvas
  const collage = await sharp({
    create: {
      width:      OUTPUT_WIDTH,
      height:     OUTPUT_HEIGHT,
      channels:   3,
      background: { r: 15, g: 23, b: 42 }, // slate-950
    },
  })
    .composite([
      { input: beforePanel, left: 0,    top: 0 },
      { input: afterPanel,  left: HALF, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  const fileName   = `collage-${Date.now()}.jpg`;
  const filePath   = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(filePath, collage);

  const publicUrl = toUploadUrl(fileName);

  console.log(`[BeforeAfter] Collage saved: ${publicUrl}`);
  return publicUrl;
}
