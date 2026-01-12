// src/utils/rehostTwilioMedia.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const PUBLIC_DIR = path.resolve("public/uploads");
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/**
 * Rehost Twilio media with guaranteed HTTPS public URL
 * Safari blocks mixed-content images (HTTP inside HTTPS pages)
 * Meta (Facebook/Instagram) also requires HTTPS URLs.
 *
 * PUBLIC_BASE_URL should be set to your ngrok / production HTTPS URL:
 *   PUBLIC_BASE_URL=https://your-app.ngrok-free.dev
 */
export async function rehostTwilioMedia(twilioUrl, salon_id = "") {
  if (!/^https:\/\/api\.twilio\.com/i.test(twilioUrl)) {
    console.log(`✅ [${salon_id || "global"}] Already public:`, twilioUrl);
    return twilioUrl;
  }

  console.log(`🌐 [${salon_id || "global"}] Rehosting Twilio media:`, twilioUrl);

  const authHeader =
    "Basic " +
    Buffer.from(
      `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
    ).toString("base64");

  const response = await fetch(twilioUrl, {
    headers: { Authorization: authHeader },
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`Twilio fetch failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const fileName = `twilio-${Date.now()}.jpg`;
  const filePath = path.join(PUBLIC_DIR, fileName);
  fs.writeFileSync(filePath, buffer);

  // 💡 Public URL Guarantee: Always HTTPS
  // Preferred: PUBLIC_BASE_URL (ngrok / production)
  // Fallback: build https://localhost URL
  let base = process.env.PUBLIC_BASE_URL;

  if (!base) {
    console.warn(
      "⚠️ PUBLIC_BASE_URL not set — using https://localhost:3000 (requires local HTTPS server)"
    );
    base = "https://localhost:3000"; // local HTTPS assumed
  }

  const publicUrl = `${base.replace(/\/$/, "")}/uploads/${fileName}`;
  console.log(`✅ [${salon_id || "global"}] Twilio media rehosted:`, publicUrl);

  return publicUrl;
}
