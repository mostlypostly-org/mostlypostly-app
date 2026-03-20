// src/core/videoDownload.js
// Downloads video MMS attachments from Twilio with Basic auth and saves locally.
// Exported VIDEO_DIR is served publicly via the existing /uploads static mount in server.js.

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import fetch from "node-fetch";
import { UPLOADS_DIR } from "./uploadPath.js";

export const VIDEO_DIR = path.join(UPLOADS_DIR, "videos");

// Ensure the videos directory exists at module load (mirrors uploadPath.js pattern)
fsSync.mkdirSync(VIDEO_DIR, { recursive: true });

/**
 * Downloads a Twilio-hosted video MMS URL using Basic auth, saves it to VIDEO_DIR,
 * and returns the local file path plus the public-facing URL.
 *
 * @param {string} twilioUrl - The MediaUrl from Twilio (e.g. https://api.twilio.com/...)
 * @returns {{ filePath: string, publicUrl: string, filename: string }}
 */
export async function downloadTwilioVideo(twilioUrl) {
  try {
    const creds = Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

    const resp = await fetch(twilioUrl, {
      headers: { Authorization: `Basic ${creds}` },
    });

    if (!resp.ok) {
      throw new Error(`Video download failed: ${resp.status}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = `${randomUUID()}.mp4`;
    const filePath = path.join(VIDEO_DIR, filename);

    await fs.writeFile(filePath, buffer);

    const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const publicUrl = `${base}/uploads/videos/${filename}`;

    return { filePath, publicUrl, filename };
  } catch (err) {
    console.error("[videoDownload]", err.message);
    throw err;
  }
}
