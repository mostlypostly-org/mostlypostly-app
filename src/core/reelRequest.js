// src/core/reelRequest.js
// Detects when a stylist wants to post a reel/video via keyword or natural language.

const FAST_PATH = [
  "reel",
  "post reel",
  "post a reel",
  "upload reel",
  "upload video",
  "share a reel",
  "share reel",
  "post my reel",
  "post video",
];

const INTENT_PATTERNS = [
  /i'?d\s+like\s+to\s+(post|share|upload)/i,
  /i\s+want\s+to\s+(post|share|upload)/i,
  /can\s+i\s+(post|upload|share)/i,
  /post\s+my\s+video/i,
  /share\s+my\s+video/i,
];

/**
 * Returns true if the message is a reel upload request.
 * Fast path: exact/substring keyword match.
 * Intent path: regex patterns for natural language variants.
 *
 * @param {string} text - Incoming SMS text
 * @returns {boolean}
 */
export function isReelRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  if (FAST_PATH.some(kw => t === kw || t.includes(kw))) return true;
  return INTENT_PATTERNS.some(re => re.test(t));
}
