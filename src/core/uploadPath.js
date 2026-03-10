// src/core/uploadPath.js
// Single source of truth for the uploads directory.
// Production: UPLOADS_DIR=/data/uploads (Render persistent disk)
// Dev/staging: falls back to public/uploads (ephemeral, fine for dev)

import path from "path";
import fs from "fs";

export const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.resolve("public/uploads");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Returns the public URL for an uploaded file given just its filename.
 * e.g. toUploadUrl("stock-123.jpg") → "https://app.mostlypostly.com/uploads/stock-123.jpg"
 */
export function toUploadUrl(filename) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/uploads/${filename}`;
}
