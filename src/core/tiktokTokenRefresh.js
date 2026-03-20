// src/core/tiktokTokenRefresh.js
import { db } from "../../db.js";
import { encrypt, decrypt } from "./encryption.js";

/**
 * Returns a valid TikTok access token for the salon.
 * Silently refreshes using the stored refresh token if expired or within 5 min.
 * Updates salons row in place.
 */
export async function refreshTiktokToken(salon) {
  const accessToken  = salon.tiktok_access_token  ? decrypt(salon.tiktok_access_token)  : null;
  const refreshToken = salon.tiktok_refresh_token ? decrypt(salon.tiktok_refresh_token) : null;

  const expiry = salon.tiktok_token_expiry ? new Date(salon.tiktok_token_expiry) : null;
  const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);

  if (expiry && expiry > fiveMinFromNow && accessToken) {
    return accessToken;
  }

  if (!refreshToken) {
    throw new Error(`[TikTok] No refresh token for salon ${salon.slug}`);
  }

  if (!process.env.TIKTOK_CLIENT_KEY || !process.env.TIKTOK_CLIENT_SECRET) {
    throw new Error("[TikTok] Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET env vars");
  }

  const params = new URLSearchParams({
    client_key:    process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const resp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`[TikTok] Token refresh failed: ${JSON.stringify(data)}`);
  }

  const newExpiry = new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString();

  db.prepare(`
    UPDATE salons SET tiktok_access_token = ?, tiktok_token_expiry = ? WHERE slug = ?
  `).run(encrypt(data.access_token), newExpiry, salon.slug);

  salon.tiktok_access_token = encrypt(data.access_token);
  salon.tiktok_token_expiry = newExpiry;

  console.log(`[TikTok] Token refreshed for salon ${salon.slug}, expires ${newExpiry}`);
  return data.access_token;
}
