// src/core/postErrorTranslator.js
// Translates raw Facebook/Instagram API error messages into plain English
// for display on the manager dashboard.

const RULES = [
  // Facebook token / permission errors
  { match: /pages_read_engagement|pages_manage_metadata|pages_show_list|impersonating a user/i,
    text: "Facebook connection needs to be refreshed. Go to Admin → Integrations and reconnect Facebook." },
  { match: /token.*expir|expir.*token|OAuthException/i,
    text: "Facebook session expired. Reconnect your Facebook account in Admin → Integrations." },
  { match: /access token/i,
    text: "Facebook access token is invalid. Reconnect Facebook in Admin → Integrations." },

  // Instagram errors
  { match: /IG media create failed|IG media publish failed|IG carousel/i,
    text: "Instagram rejected the post. Check that your Instagram Business account is still connected." },
  { match: /IG container ERROR/i,
    text: "Instagram couldn't process the image. It may be too large or in an unsupported format." },
  { match: /Timed out waiting for IG/i,
    text: "Instagram took too long to process the image. Will retry automatically." },
  { match: /IG story/i,
    text: "Instagram story post failed. Check your Instagram connection in Admin → Integrations." },

  // Rate limits
  { match: /rate limit|too many calls|spam/i,
    text: "Posted too frequently. Facebook/Instagram rate limit reached — will retry later." },

  // Network / timeout
  { match: /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network/i,
    text: "Network error while posting. Will retry automatically." },

  // Image issues
  { match: /photo upload failed|image.*invalid|unsupported.*format/i,
    text: "The image couldn't be uploaded. It may be corrupted or in an unsupported format." },
];

/**
 * Returns a plain-English error message for a raw API error string.
 * Falls back to a generic message if no rule matches.
 */
export function translatePostError(rawError) {
  if (!rawError) return "Unknown error. Please retry or contact support.";
  for (const rule of RULES) {
    if (rule.match.test(rawError)) return rule.text;
  }
  return "Post failed to publish. Tap Retry to try again, or check your Facebook/Instagram connection.";
}
