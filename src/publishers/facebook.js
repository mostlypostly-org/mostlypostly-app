// src/publishers/facebook.js — multi-tenant aware, single + multi-photo
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

  // Attempt photo post first (URL-based)
  if (imageUrl && typeof imageUrl === "string") {
    console.log("📤 [Facebook] Attempting photo post with URL…");
    let urlMsg = null;
    try {
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
        urlMsg = data?.error?.message || "Unknown FB photo error";
        console.warn("⚠️ [Facebook] Photo URL upload failed:", urlMsg, "| URL:", imageUrl);
      } else {
        console.log("✅ [Facebook] Photo post success:", data);
        return data;
      }
    } catch (err) {
      urlMsg = err.message;
      console.warn("⚠️ [Facebook] Photo URL upload threw:", urlMsg);
    }

    // URL-based upload failed — try binary upload for self-hosted images.
    // This handles cases where Facebook's CDN cannot reach our server URL,
    // or where a relative path was stored instead of an absolute URL.
    const selfBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const resolvedImageUrl = imageUrl.startsWith("/") && selfBase ? `${selfBase}${imageUrl}` : imageUrl;
    if (selfBase && (resolvedImageUrl.startsWith(selfBase))) {
      console.log("📤 [Facebook] Attempting binary upload for self-hosted image…");
      try {
        const imgRes = await fetch(resolvedImageUrl);
        if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        const ext = imageUrl.split(".").pop()?.split("?")[0]?.toLowerCase() || "jpg";
        const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";

        const formData = new FormData();
        formData.append("source", new Blob([imgBuffer], { type: mimeType }), `image.${ext}`);
        formData.append("caption", safeCaption);
        formData.append("access_token", token);

        const binaryRes = await fetch(endpointPhoto, { method: "POST", body: formData });
        const binaryData = await binaryRes.json();

        if (!binaryRes.ok || binaryData.error) {
          const binaryMsg = binaryData?.error?.message || "Unknown binary upload error";
          console.error("❌ [Facebook] Binary upload also failed:", binaryMsg);
          throw new Error(`Facebook photo upload failed — URL: ${urlMsg} | binary: ${binaryMsg}`);
        }

        console.log("✅ [Facebook] Binary photo upload success:", binaryData);
        return binaryData;
      } catch (binaryErr) {
        // Re-throw combined error — never fall back to text-only when an image was expected
        const msg = binaryErr.message.startsWith("Facebook photo upload failed")
          ? binaryErr.message
          : `Facebook photo upload failed — URL: ${urlMsg} | binary: ${binaryErr.message}`;
        console.error("❌ [Facebook]", msg);
        throw new Error(msg);
      }
    }

    // External image URL that Facebook couldn't fetch — throw so the post retries
    throw new Error(`Facebook photo upload failed: ${urlMsg}`);
  }

  // No image provided — text-only feed post
  console.log("📝 [Facebook] No image provided — posting text-only to feed…");
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

/**
 * publishToFacebookMulti(pageOrSalon, caption, imageUrls, tokenOverride?)
 * Posts multiple photos as a single multi-photo feed post using attached_media.
 */
export async function publishToFacebookMulti(pageOrSalon, caption, imageUrls, tokenOverride = null) {
  if (!imageUrls?.length) throw new Error("publishToFacebookMulti: no imageUrls");

  let pageId, token, graphVersion = "v19.0";
  if (typeof pageOrSalon === "object" && pageOrSalon !== null) {
    pageId = pageOrSalon.facebook_page_id;
    token = pageOrSalon.facebook_page_token || process.env.FACEBOOK_PAGE_TOKEN || process.env.FACEBOOK_SYSTEM_USER_TOKEN;
    graphVersion = pageOrSalon.graph_version || graphVersion;
  } else {
    pageId = pageOrSalon;
    token = tokenOverride || process.env.FACEBOOK_PAGE_TOKEN || process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  }

  if (!pageId) throw new Error("publishToFacebookMulti: invalid pageId");
  if (!token)  throw new Error("publishToFacebookMulti: missing token");

  const safeCaption = (caption || "").toString().slice(0, 2200);
  const endpointPhoto = `https://graph.facebook.com/${graphVersion}/${pageId}/photos`;
  const endpointFeed  = `https://graph.facebook.com/${graphVersion}/${pageId}/feed`;

  console.log(`🚀 [Facebook Multi] Posting ${imageUrls.length} photos to pageId=${pageId}`);

  // 1. Upload each photo as unpublished, collect photo IDs
  const photoIds = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const res = await fetch(endpointPhoto, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: imageUrls[i], published: false, access_token: token }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.id) {
      throw new Error(`FB photo upload ${i} failed: ${data?.error?.message || res.status}`);
    }
    photoIds.push(data.id);
    console.log(`  ✅ [Facebook Multi] Photo ${i} uploaded: id=${data.id}`);
  }

  // 2. Post to feed with attached_media
  const attached = photoIds.map(id => ({ media_fbid: id }));
  const feedRes = await fetch(endpointFeed, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: safeCaption, attached_media: attached, access_token: token }),
  });
  const feedData = await feedRes.json();
  if (!feedRes.ok || feedData.error) {
    throw new Error(`FB multi-photo feed post failed: ${feedData?.error?.message || feedRes.status}`);
  }

  console.log("✅ [Facebook Multi] Feed post success:", feedData);
  return feedData;
}
