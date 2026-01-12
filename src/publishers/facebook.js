// src/publishers/facebook.js — multi-tenant aware, backward compatible
import fetch from "node-fetch";

/**
 * Publish a post to a Facebook Page.
 *
 * Supported signatures:
 *
 * 1) Legacy:
 *    publishToFacebook(pageId, caption, imageUrl, tokenOverride)
 *
 * 2) DB-backed:
 *    publishToFacebook(
 *      { facebook_page_id, facebook_page_token, graph_version? },
 *      caption,
 *      imageUrl
 *    )
 */
export async function publishToFacebook(
  pageOrSalon,
  caption,
  imageUrl = null,
  tokenOverride = null
) {
  let pageId;
  let token;
  let graphVersion = "v19.0";

  // 🧠 NEW: salon object signature
  if (typeof pageOrSalon === "object" && pageOrSalon !== null) {
    pageId = pageOrSalon.facebook_page_id;
    token =
      pageOrSalon.facebook_page_token ||
      process.env.FACEBOOK_PAGE_TOKEN ||
      process.env.FACEBOOK_SYSTEM_USER_TOKEN;

    graphVersion = pageOrSalon.graph_version || graphVersion;
  }
  // 🧠 LEGACY: string pageId signature
  else {
    pageId = pageOrSalon;
    token =
      tokenOverride ||
      process.env.FACEBOOK_PAGE_TOKEN ||
      process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  }

  if (!pageId || typeof pageId !== "string") {
    console.error("❌ [Facebook] Invalid pageId:", pageOrSalon);
    throw new Error("Facebook publisher received invalid pageId");
  }

  if (!token) {
    throw new Error(
      "Missing Facebook access token (no salon token and no env token)"
    );
  }

  const safeCaption = (caption || "").toString().slice(0, 2200);
  const endpointPhoto = `https://graph.facebook.com/${graphVersion}/${pageId}/photos`;
  const endpointFeed = `https://graph.facebook.com/${graphVersion}/${pageId}/feed`;

  console.log(
    `🚀 [Facebook] Posting to pageId=${pageId} hasImage=${!!imageUrl} dbToken=${!!pageOrSalon?.facebook_page_token}`
  );

  // Attempt photo post first
  if (imageUrl && typeof imageUrl === "string") {
    try {
      console.log("📤 [Facebook] Attempting photo post with URL…");
      const res = await fetch(endpointPhoto, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: safeCaption,
          url: imageUrl,
          access_token: token,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        const msg = data?.error?.message || "Unknown FB photo error";
        console.warn("⚠️ [Facebook] Photo upload failed:", msg);
      } else {
        console.log("✅ [Facebook] Photo post success:", data);
        return data;
      }
    } catch (err) {
      console.warn(
        "⚠️ [Facebook] Photo upload threw error, falling back to feed:",
        err.message
      );
    }
  }

  // Fallback to text-only post
  console.log("ℹ️ [Facebook] Falling back to text-only feed post…");
  const feedRes = await fetch(endpointFeed, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: safeCaption,
      access_token: token,
    }),
  });

  const feedData = await feedRes.json();
  if (!feedRes.ok || feedData.error) {
    const msg = feedData?.error?.message || "Unknown FB feed error";
    console.error("❌ [Facebook] Feed post failed:", msg);
    throw new Error(msg);
  }

  console.log("✅ [Facebook] Feed post success:", feedData);
  return feedData;
}
