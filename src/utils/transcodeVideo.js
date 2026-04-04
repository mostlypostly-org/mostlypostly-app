// src/utils/transcodeVideo.js
// Re-encodes a local video file to 30fps H.264/AAC MP4 so TikTok accepts it.
// Only processes local /uploads/videos/ URLs — external URLs are returned unchanged.
import ffmpegStatic from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "../../public/uploads/videos");

/**
 * Transcode a video URL to a TikTok-compatible MP4 (30fps, H.264, AAC).
 * Returns a new public URL pointing to the transcoded file.
 * Falls back to the original URL on any error so TikTok publish can still attempt.
 *
 * @param {string} videoUrl   - Public URL of the video (e.g. https://app.../uploads/videos/foo.mp4)
 * @param {string} baseUrl    - PUBLIC_BASE_URL (e.g. https://app.mostlypostly.com)
 * @returns {Promise<string>} - Public URL of transcoded video (or original on failure)
 */
export async function transcodeForTikTok(videoUrl, baseUrl) {
  const uploadsPrefix = `${baseUrl}/uploads/videos/`;
  if (!videoUrl.startsWith(uploadsPrefix)) {
    return videoUrl; // external URL — pass through unchanged
  }

  const filename   = path.basename(videoUrl);
  const inputPath  = path.join(UPLOADS_DIR, filename);
  const outName    = `tk-${filename}`;
  const outputPath = path.join(UPLOADS_DIR, outName);

  if (!fs.existsSync(inputPath)) {
    console.warn(`[Transcode] Input file not found: ${inputPath} — skipping`);
    return videoUrl;
  }

  // Skip re-transcoding if already done (e.g. retry)
  if (fs.existsSync(outputPath)) {
    console.log(`[Transcode] Using cached transcoded file: ${outName}`);
    return `${uploadsPrefix}${outName}`;
  }

  console.log(`[Transcode] Re-encoding ${filename} for TikTok (30fps H.264/AAC)…`);

  return new Promise((resolve) => {
    ffmpeg(inputPath)
      .setFfmpegPath(ffmpegStatic)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions([
        "-r 30",                // force 30fps
        "-crf 23",              // reasonable quality
        "-movflags +faststart", // streaming-friendly
      ])
      .output(outputPath)
      .on("end", () => {
        console.log(`[Transcode] Done → ${outName}`);
        resolve(`${uploadsPrefix}${outName}`);
      })
      .on("error", (err) => {
        console.error(`[Transcode] Failed: ${err.message} — using original`);
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
        resolve(videoUrl); // fall back to original
      })
      .run();
  });
}
