// src/utils/transcodeVideo.js
// Re-encodes a video to 30fps H.264/AAC MP4 so TikTok accepts it.
// Reads from the public URL directly (ffmpeg supports HTTP inputs), so this
// works even when the local file was wiped by a Render deploy.
import ffmpegStatic from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Prefer system ffmpeg (avoids SIGSEGV in Render's restricted container).
// Falls back to the bundled static binary for local dev.
const SYSTEM_FFMPEG_PATHS = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
const FFMPEG_PATH = process.env.FFMPEG_PATH
  || SYSTEM_FFMPEG_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } })
  || ffmpegStatic;
console.log(`[Transcode] Using ffmpeg: ${FFMPEG_PATH}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOADS_DIR = path.join(__dirname, "../../public/uploads/videos");

/**
 * Transcode a video URL to a TikTok-compatible MP4 (30fps, H.264, AAC).
 * Reads from the URL directly so local file presence is not required.
 * Returns a new public URL pointing to the transcoded file.
 * Falls back to the original URL on any error.
 *
 * @param {string} videoUrl   - Public URL of the video
 * @param {string} baseUrl    - PUBLIC_BASE_URL (e.g. https://app.mostlypostly.com)
 * @returns {Promise<string>} - Public URL of transcoded video (or original on failure)
 */
export async function transcodeForTikTok(videoUrl, baseUrl) {
  const uploadsPrefix = `${baseUrl}/uploads/videos/`;
  if (!videoUrl.startsWith(uploadsPrefix)) {
    return videoUrl; // external URL — pass through unchanged
  }

  const filename   = path.basename(videoUrl);
  const outName    = `tk-${filename}`;
  const outputPath = path.join(UPLOADS_DIR, outName);

  // Skip re-transcoding if already done (e.g. retry)
  if (fs.existsSync(outputPath)) {
    console.log(`[Transcode] Using cached transcoded file: ${outName}`);
    return `${uploadsPrefix}${outName}`;
  }

  // Ensure output directory exists
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  console.log(`[Transcode] Re-encoding ${filename} for TikTok (30fps H.264/AAC)…`);

  return new Promise((resolve) => {
    // Read directly from the public URL — no local file required
    ffmpeg(videoUrl)
      .setFfmpegPath(FFMPEG_PATH)
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
        resolve(videoUrl);
      })
      .run();
  });
}
