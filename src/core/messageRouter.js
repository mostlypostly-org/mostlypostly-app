// src/core/messageRouter.js
// MostlyPostly v0.5.15 — FB vs IG "Styled by" rules + IG rehost + consent + formatting
// --- top of messageRouter.js ---
import crypto from "crypto";
import { db, verifyTokenRow } from "../../db.js";  // ✅ single import (no duplicates)
import { enqueuePost } from "../scheduler.js";
import { getSalonPolicy } from "../scheduler.js";


// Manager tokens removed — managers authenticate via email/password only.
// Tokens are reserved for stylist portal access (future).

import { publishToFacebook } from "../publishers/facebook.js";
import { publishToInstagram } from "../publishers/instagram.js";
import { handleJoinCommand, continueJoinConversation } from "./joinManager.js";
import { isJoinInProgress } from "./joinSessionStore.js";
import {
  lookupStylist,
  lookupStylistByChatId,
  getSalonByStylist,
  loadSalons,
  saveConsentToDb,
} from "./salonLookup.js";
import {
  savePost,
  updatePostStatus,
  findPendingPostByManager,
  findPostAwaitingReason,
  findLatestDraft,
} from "../core/storage.js";
import { composeFinalCaption } from "./composeFinalCaption.js";
import { classifyPostType } from "./classifyPostType.js";
import { buildBeforeAfterCollage } from "./buildBeforeAfterCollage.js";
import { buildAvailabilityImage } from "./buildAvailabilityImage.js";
import { resolveDisplayName } from "./salonLookup.js";
import { isAvailabilityRequest, hasDateHint, parseDateRange } from "./availabilityRequest.js";
import {
  getZenotiClientForSalon,
  syncAvailabilityPool,
  getPooledStylistSlots,
  generateAndSaveAvailabilityPost,
} from "./zenotiSync.js";
// 🧠 Import moderation utility directly
import moderateAIOutput from "../utils/moderation.js";
import { sendQuickStart } from "./stylistWelcome.js";
import { getOrCreateLeaderboardToken } from "./gamification.js";
console.log("[Router Debug] moderateAIOutput type:", typeof moderateAIOutput);


// --------------------------------------
// Resolve a usable image URL from records
function resolveImageUrl(pending, draft) {
  return (
    pending?.image_url ||
    pending?.media_url ||
    pending?.source_image_url ||
    pending?.image ||
    draft?.image_url ||
    draft?.image ||
    null
  );
}

// --------------------------------------
// Timing helpers
function startTimer() { return performance.now(); }
function endTimer(start, label = "handleIncomingMessage") {
  const elapsed = (performance.now() - start).toFixed(2);
  console.log(`⏱ ${label}: ${elapsed}ms`);
}

// --------------------------------------
// Identity helpers
function getStylistName(stylist) {
  return (
    (stylist?.stylist_name ||
      stylist?.name ||
      stylist?.display_name ||
      stylist?.full_name ||
      "").toString().trim() || "Unknown Stylist"
  );
}
function getStylistHandle(stylist) {
  const raw = (
    stylist?.instagram_handle ||
    stylist?.ig ||
    stylist?.instagram ||
    ""
  ).toString().trim();
  const clean = raw.replace(/^@+/, "");
  return clean || null;
}

// --------------------------------------
// Formatting utilities
function prettifyBody(body) {
  const srcLines = String(body || "").split("\n");
  const out = [];

  const isStyled = (s) => /^Styled by /.test(s);
  const isIG = (s) => /^IG:\s/.test(s);
  const isHashtag = (s) => /^#/.test(s);
  const isCTA = (s) => /^_.*_$/.test(s) || /^Book\b/i.test(s) || /^Schedule\b/i.test(s);
  const isBooking = (s) => /^Book:\s/i.test(s);

  for (let i = 0; i < srcLines.length; i++) {
    const ln = srcLines[i].replace(/\s+$/g, "");
    const prev = out.length ? out[out.length - 1] : "";
    const prevTrim = prev.trim();

    const curStyled = isStyled(ln);
    const curIG = isIG(ln);
    const curHashtag = isHashtag(ln);
    const curCTA = isCTA(ln);
    const curBooking = isBooking(ln);

    let needBlankBefore = false;

    if (curStyled) {
      if (out.length && prevTrim !== "") needBlankBefore = true;
    } else if (curIG) {
      if (!isStyled(prevTrim) && prevTrim !== "") needBlankBefore = true;
    } else if (curHashtag) {
      if (!isHashtag(prevTrim) && prevTrim !== "") needBlankBefore = true;
    } else if (curCTA) {
      if (isHashtag(prevTrim)) needBlankBefore = true;
    } else if (curBooking) {
      if (prevTrim !== "" && !curCTA) needBlankBefore = true;
    }

    if (needBlankBefore && out.length && out[out.length - 1] !== "") out.push("");
    out.push(ln);
  }

  // Ensure exactly one blank line AFTER the LAST hashtag block
  let lastHashIdx = -1;
  for (let i = 0; i < out.length; i++) if (isHashtag(out[i].trim())) lastHashIdx = i;

  if (lastHashIdx >= 0) {
    let nextIdx = -1;
    for (let j = lastHashIdx + 1; j < out.length; j++) {
      const t = out[j].trim();
      if (t === "" || isHashtag(t)) continue;
      nextIdx = j; break;
    }
    if (nextIdx > 0) {
      const before = out.slice(0, lastHashIdx + 1);
      const nextBlock = out[nextIdx];
      const after = out.slice(nextIdx + 1);
      const result = [...before, "", nextBlock, ...after];
      out.splice(0, out.length, ...result);
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Ensure a "Styled by <Name>" line exists or overwrite the current one
function enforceCreditName(caption, stylistName) {
  const name = (stylistName || "Unknown Stylist").toString().trim();
  const lines = String(caption || "").split("\n");
  const idx = lines.findIndex((l) => /^Styled by /.test(l));
  if (idx >= 0) {
    lines[idx] = `Styled by ${name}`;
    return lines.join("\n");
  }
  if (lines.length) {
    lines.splice(1, 0, `Styled by ${name}`);
    return lines.join("\n");
  }
  return `Styled by ${name}`;
}

// Insert IG URL *under* the Styled by line (used for Facebook)
function insertIGUnderStyledBy(caption, instagramHandle) {
  const rawHandle = (instagramHandle || "").toString().trim().replace(/^@+/, "");
  if (!rawHandle) return caption;
  const igLine = `IG: https://instagram.com/${rawHandle}`;
  const lines = String(caption || "").split("\n");
  const idx = lines.findIndex((l) => /^Styled by /.test(l));
  if (idx >= 0) {
    if (lines[idx + 1] && lines[idx + 1].trim() === igLine) return caption;
    lines.splice(idx + 1, 0, igLine);
    return lines.join("\n");
  }
  return `${caption}\n${igLine}`;
}

// Replace the "Styled by ..." line with a custom value
function replaceStyledByLine(caption, newLine) {
  const lines = String(caption || "").split("\n");
  const idx = lines.findIndex((l) => /^Styled by /.test(l));
  if (idx >= 0) {
    lines[idx] = newLine;
    return lines.join("\n");
  }
  // If not found, insert near top
  if (lines.length) {
    lines.splice(1, 0, newLine);
    return lines.join("\n");
  }
  return newLine;
}

// Remove any IG URL helper line (for Instagram caption)
function removeIGUrlLine(caption) {
  const lines = String(caption || "").split("\n").filter((l) => !/^IG:\s/.test(l.trim()));
  return lines.join("\n");
}

function buildFacebookCaption(baseCaption, stylistName, igHandle) {
  const FB_SPACER = "\u200B";

  let c = enforceCreditName(baseCaption, stylistName); // "Styled by Full Name"
  c = insertIGUnderStyledBy(c, igHandle);              // IG URL directly under Styled by
  c = prettifyBody(c);                                  // normalize sections/collapses

  // Convert any blank lines into FB-safe spacer lines
  const lines = c.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.trim() === "") {
      // Use spacer so Facebook preserves the blank line visually
      // Also dedupe consecutive blank/spacer lines to a single spacer
      if (out.length && out[out.length - 1] !== FB_SPACER) out.push(FB_SPACER);
    } else {
      out.push(ln);
    }
  }

  return out.join("\n").trim();
}

function buildInstagramCaption(baseCaption, stylistName, igHandle) {
  const handle = (igHandle || "").replace(/^@+/, "");
  let c;
  if (handle) {
    c = replaceStyledByLine(baseCaption, `Styled by @${handle}`); // IG wants @handle
  } else {
    c = enforceCreditName(baseCaption, stylistName);              // fallback to name
  }

  // Remove IG URL helper line and any raw booking URLs (non-clickable on IG)
  c = removeIGUrlLine(c);

  const IG_BOOKING_CTA = process.env.IG_BOOKING_CTA || "Book via link in bio.";

  // Strip any line starting with "Book: http(s)://..." since IG doesn't hyperlink captions
  const lines = c.split("\n");
  const filtered = [];
  let removedBookingUrl = false;

  for (const line of lines) {
    if (/^\s*Book:\s*https?:\/\//i.test(line.trim())) {
      removedBookingUrl = true;
      continue; // drop the raw URL line
    }
    filtered.push(line);
  }

  // If we removed a booking URL line, add a clean CTA instead
  if (removedBookingUrl && !filtered.join("\n").includes(IG_BOOKING_CTA)) {
    // Ensure a blank line before CTA if the previous block isn't empty
    if (filtered.length && filtered[filtered.length - 1].trim() !== "") filtered.push("");
    filtered.push(IG_BOOKING_CTA);
  }

  c = filtered.join("\n");
  return prettifyBody(c);
}

// --------------------------------------
// Consent session (in-memory)
const consentSessions = new Map(); // chatId -> { status: 'pending' | 'granted', queued?: { imageUrl, text } }

// Track stylists who recently received a "no availability" response so WRONG replies can be attributed
// Shape: Map<chatId, { salonId, stylistId, stylistName, stylistPhone, at: timestamp }>
const noAvailabilityRecent = new Map();
const NO_AVAIL_TTL_MS = 60 * 60 * 1000; // 1 hour

function hasConsent(stylist) {
  return !!(stylist?.compliance_opt_in) || !!(stylist?.consent?.sms_opt_in);
}
function isAgreementMessage(text) {
  return /^\s*(AGREE|I AGREE|YES|YES I AGREE)\s*$/i.test(text || "");
}
function queueConsentAndPrompt(chatId, imageUrls, text, sendMessage, stylist) {
  consentSessions.set(chatId, { status: "pending", queued: { imageUrls: imageUrls || [], text } });
  const prompt = `
MostlyPostly: Please review our SMS Consent, Privacy, and Terms:
https://mostlypostly.github.io/mostlypostly-legal/

Reply *AGREE* to opt in. Reply STOP to opt out. MENU for commands. Msg&data rates may apply.

`.trim();
  return sendMessage.sendText(chatId, prompt);
}
function markConsentGranted(chatId) {
  const cur = consentSessions.get(chatId) || {};
  consentSessions.set(chatId, { ...cur, status: "granted" });
}
function getQueuedIfAny(chatId) {
  const cur = consentSessions.get(chatId);
  return cur?.queued || null;
}

// --------------------------------------
// Manager Preview (Telegram) — unchanged visuals
async function sendManagerPreviewPhoto(chatId, imageUrl, { draft, stylist, salon }) {
  try {
    const salonInfo = salon?.salon_info ? salon.salon_info : (salon || {});
    const salonName = salonInfo.salon_name || salonInfo.name || "Salon";
    const stylistName = getStylistName(stylist);
    const stylistHandle = getStylistHandle(stylist);
    const bookingUrl = salonInfo?.booking_url || "";

    let fullBody = composeFinalCaption({
      caption: draft?.caption || "",
      hashtags: draft?.hashtags || [],
      cta: draft?.cta || "",
      instagramHandle: stylistHandle || null,
      stylistName,
      bookingUrl,
      salon: { salon_info: salonInfo },
      asHtml: false
    });

    // Preview format keeps: "Styled by Name" + IG URL under it
    fullBody = buildFacebookCaption(fullBody, stylistName, stylistHandle);
    const notifyText = `${salonName} — New Post for Review

👤 From: ${stylistName}
📸 Instagram: ${stylistHandle ? `@${stylistHandle}` : "N/A"}

💬 Full Caption Preview:
${fullBody}

Reply "APPROVE" to post or "DENY" to reject.
`.slice(0, 1000);

    if (!imageUrl?.startsWith("https://api.telegram.org/file/")) {
      throw new Error("Invalid Telegram file URL");
    }

    const resp = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          photo: imageUrl,
          caption: notifyText,
          parse_mode: "HTML"
        })
      }
    );

    const data = await resp.json();
    if (!data.ok) throw new Error(data.description || "Telegram sendPhoto failed");
    console.log("✅ Manager preview sent successfully");
    return data;
  } catch (err) {
    console.error("🚫 sendPhoto failed:", err.message);
    const salonInfo = salon?.salon_info ? salon.salon_info : (salon || {});
    const salonName = salonInfo.salon_name || salonInfo.name || "Salon";
    const stylistName = getStylistName(stylist);
    const stylistHandle = getStylistHandle(stylist);
    const bookingUrl = salonInfo?.booking_url || "";

    let fullBody = composeFinalCaption({
      caption: draft?.caption || "",
      hashtags: draft?.hashtags || [],
      cta: draft?.cta || "",
      instagramHandle: stylistHandle || null,
      stylistName,
      bookingUrl,
      salon: { salon_info: salonInfo },
      asHtml: false
    });
    fullBody = buildFacebookCaption(fullBody, stylistName, stylistHandle);

    const fallback = `${salonName} — New Post for Review

👤 From: ${stylistName}
📸 Instagram: ${stylistHandle ? `@${stylistHandle}` : "N/A"}

💬 Full Caption Preview:
${fullBody}

Reply "APPROVE" to post or "DENY" to reject.
📸 ${imageUrl}`.slice(0, 3900);

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: fallback })
    });
  }
}

// --------------------------------------
// New image → AI → store draft → preview to stylist
async function processNewImageFlow({
  chatId, text, imageUrls = [], drafts,
  generateCaption, moderateAIOutput, sendMessage,
  stylist, salon
  }) {
  const imageUrl = imageUrls[0] || null;
  console.log(`📸 [Router] New image(s) received (consented): ${imageUrls.length} image(s)`);

  // 0️⃣ Classify post type from message text
  const postType = classifyPostType(text || "");

  // 0b️⃣ Before/After: build side-by-side collage, replace image list
  let activeImageUrls = [...imageUrls];
  let activeImageUrl  = imageUrl;

  if (postType === "before_after") {
    if (imageUrls.length < 2) {
      await sendMessage.sendText(chatId,
        "For a Before/After post please send exactly 2 photos — the Before photo first, then the After photo."
      );
      return;
    }
    try {
      const collageUrl = await buildBeforeAfterCollage(imageUrls.slice(0, 2), salon?.salon_id || "");
      // Keep original URLs in activeImageUrls so swap can rebuild; collage goes in activeImageUrl
      activeImageUrls  = imageUrls.slice(0, 2);
      activeImageUrl   = collageUrl;
      console.log(`[Router] Before/After collage ready: ${collageUrl}`);
    } catch (err) {
      console.error("❌ [Router] Collage build failed:", err.message);
      await sendMessage.sendText(chatId, "Sorry, we couldn't build the collage. Please try again.");
      return;
    }
  }

  // 0c️⃣ Availability: build story image and skip normal caption flow
  if (postType === "availability") {
    try {

      const fullSalon = getSalonPolicy(salon?.slug || salon?.salon_id || salon?.id);
      const salonName = fullSalon?.name || fullSalon?.salon_info?.salon_name || "the salon";
      const bookingCta = fullSalon?.booking_url
        ? "Tap to Book ↑"
        : (fullSalon?.default_cta || "Book via link in bio.");

      const storyImageUrl = await buildAvailabilityImage({
        text: text || "",
        stylistName: resolveDisplayName(stylist, salon?.salon_id || salon?.id || ""),
        salonName,
        salonId: salon?.salon_id || salon?.id || "",
        stylistId: stylist?.stylist_id || stylist?.id || null,
        instagramHandle: stylist?.instagram_handle || null,
        bookingCta,
        submittedImageUrl: imageUrls[0] || null,
      });

      // Save as draft with the story image
      const savedDraft = savePost(
        chatId,
        {
          ...stylist,
          image_url: storyImageUrl,
          image_urls: [storyImageUrl],
          final_caption: text || "Availability post",
          post_type: "availability",
        },
        text || "Availability post",
        [],
        "draft",
        null,
        salon
      );

      // Send portal link
      const postId = savedDraft?.id;
      if (postId) {
        const portalToken = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          INSERT INTO stylist_portal_tokens (id, post_id, token, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(crypto.randomUUID(), postId, portalToken, expiresAt);

        const baseUrl = process.env.PUBLIC_BASE_URL || "";
        const portalUrl = `${baseUrl}/stylist/${postId}?token=${portalToken}`;
        await sendMessage.sendText(chatId,
          `Your availability post is ready! Review it here:\n${portalUrl}\n\nOr reply APPROVE to submit now, or CANCEL to discard. (Link expires in 24 hours.)`
        );
      }
    } catch (err) {
      console.error("❌ [Router] Availability flow failed:", err.message);
      await sendMessage.sendText(chatId, "Sorry, we couldn't build your availability post. Please try again.");
    }
    return;
  }

  // 1️⃣ Generate AI caption object
  // Hydrate salon with DB-backed config (tone, hashtags, rules, etc.)
  const fullSalon = getSalonPolicy(
    salon?.slug || salon?.salon_id || salon?.id
  );

  const aiJson = await generateCaption({
    imageDataUrl: activeImageUrl,
    notes: text || "",
    salon: fullSalon,
    stylist,
    postType,
    city: stylist?.city || ""
  });


  aiJson.image_url = activeImageUrl;
  aiJson.original_notes = text;

  // 2️⃣ Extract the caption for moderation
  const aiCaption = aiJson.caption || aiJson.text || "";

  // 3️⃣ Run moderation check
  const moderation = await moderateAIOutput({ caption: aiCaption }, text);
  const safe = moderation.safe !== false;

  if (!safe) {
    await sendMessage.sendText(chatId, "⚠️ This caption or note was flagged. Please resend a different photo.");
    drafts.delete(chatId);
    return;
  }

  // 4️⃣ Build the final caption and stylist preview
  const bookingUrl = salon?.salon_info?.booking_url || "";
  const stylistName = getStylistName(stylist);
  const stylistHandle = getStylistHandle(stylist);

  const baseCaption = composeFinalCaption({
    caption: aiJson.caption,
    hashtags: aiJson.hashtags,
    cta: aiJson.cta,
    instagramHandle: null,
    stylistName,
    bookingUrl,
    salon: fullSalon,
    asHtml: false,
  });

  // Stylist preview remains FB-style (name + IG URL under it)
  const previewCaption = buildFacebookCaption(baseCaption, stylistName, stylistHandle);

  // Save draft to memory AND DB so it survives a server restart
  const draftPayload = { ...aiJson, final_caption: previewCaption, base_caption: baseCaption, image_urls: activeImageUrls, post_type: postType };

  try {
    const savedDraft = savePost(
      chatId,
      { ...stylist, image_url: activeImageUrl, image_urls: activeImageUrls, final_caption: previewCaption, post_type: postType },
      aiJson.caption,
      aiJson.hashtags || [],
      "draft",
      null,
      salon
    );
    if (savedDraft?.id) {
      draftPayload._db_id = savedDraft.id;
    }
  } catch (err) {
    console.warn("⚠️ [processNewImageFlow] Could not persist draft to DB:", err.message);
  }

  drafts.set(chatId, draftPayload);

  // 5️⃣ Generate portal token and send link instead of inline caption
  const postId = draftPayload._db_id;
  if (postId) {
    try {
      const portalToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO stylist_portal_tokens (id, post_id, token, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(crypto.randomUUID(), postId, portalToken, expiresAt);

      const baseUrl = process.env.PUBLIC_BASE_URL || "";
      const portalUrl = `${baseUrl}/stylist/${postId}?token=${portalToken}`;

      const previewMsg =
        `Your caption preview is ready!\n\n` +
        `Review or edit here:\n${portalUrl}\n\n` +
        `Or tap a button below (or reply APPROVE/REDO/CANCEL). Link expires in 24 hours.`;

      if (sendMessage.sendRcs) {
        await sendMessage.sendRcs(chatId, previewMsg, ["reply:APPROVE", "reply:REDO", "reply:CANCEL"]);
      } else {
        await sendMessage.sendText(chatId, previewMsg);
      }
    } catch (err) {
      console.warn("⚠️ Could not generate portal token, falling back to SMS preview:", err.message);
      await sendMessage.sendText(chatId, `Preview:\n\n${previewCaption}\n\nReply APPROVE to submit or CANCEL to discard.`);
    }
  } else {
    // DB save failed — fall back to SMS preview
    await sendMessage.sendText(chatId, `Preview:\n\n${previewCaption}\n\nReply APPROVE to submit or CANCEL to discard.`);
  }
}

// --------------------------------------
// Restore a DB draft row into the shape the APPROVE/REGENERATE handlers expect
function restoreDraftFromDb(row) {
  let hashtags = [];
  try { hashtags = JSON.parse(row.hashtags || "[]"); } catch { /* leave empty */ }
  let imageUrls = [];
  try { imageUrls = JSON.parse(row.image_urls || "[]"); } catch { /* leave empty */ }
  if (!imageUrls.length && row.image_url) imageUrls = [row.image_url];
  return {
    caption: row.base_caption || row.final_caption || "",
    hashtags,
    cta: row.cta || "",
    image_url: row.image_url || null,
    image_urls: imageUrls,
    original_notes: row.original_notes || "",
    final_caption: row.final_caption || "",
    base_caption: row.base_caption || "",
    service_type: row.service_type || "other",
    _db_id: row.id,
    _restored: true,
  };
}

// --------------------------------------
// MAIN HANDLER
export async function handleIncomingMessage({
  source,
  chatId,
  text,
  imageUrl,    // single URL (Telegram / legacy callers)
  imageUrls,   // array from Twilio MMS
  drafts,
  generateCaption,
  moderateAIOutput,
  sendMessage,
  io
}) {
  const start = startTimer();
  // Normalize: merge imageUrl + imageUrls into one canonical array
  const allImageUrls = imageUrls?.length ? imageUrls : (imageUrl ? [imageUrl] : []);
  const primaryImageUrl = allImageUrls[0] || null;
  console.log(`💬 [Router] Message received from ${source}:`, { chatId, text, images: allImageUrls.length });

  const cleanText = (text || "").trim();
  const command = cleanText.toUpperCase();

  // 🔍 Lookup stylist + salon in one pass
  const lookupResult = lookupStylist(chatId);

  const stylist = lookupResult?.stylist || {
    stylist_name: "Guest User",
    salon_name: "Unknown",
    city: "Unknown",
    role: "stylist"
  };

  const salon = lookupResult?.salon || null;

  // Also try manager lookup (used for consent handling)
  const manager = stylist?.role === "manager" ? stylist : null;
  const hasConsent =
    stylist?.compliance_opt_in ||
    stylist?.consent?.sms_opt_in ||
    manager?.compliance_opt_in ||
    manager?.consent?.sms_opt_in;

  const role = stylist.role?.toLowerCase() || "stylist";
  console.log(
    `${role === "manager" ? "👔 Manager" : "💇 Stylist"} resolved: ${
      getStylistName(stylist)
    } @ ${salon?.salon_info?.name || stylist.salon_name || "Unknown Salon"}`
  );

  // ✅ Validate user and consent before continuing
  if (!stylist || stylist.salon_name === "Unknown" || !stylist.salon_info) {
    await sendMessage.sendText(
      chatId,
      "🚫 You’re not registered with any salon. Please contact your salon manager to be added to MostlyPostly before posting."
    );
    endTimer(start);
    return;
  }

  if (!salon) {
    await sendMessage.sendText(
      chatId,
      "⚠️ Your salon is not properly linked in MostlyPostly. Please contact your manager."
    );
    endTimer(start);
    return;
  }

  // 📍 Track stylist activity on every inbound message
  const _stylistId = stylist?.id || stylist?.stylist_id;
  if (_stylistId) {
    try {
      db.prepare(`UPDATE stylists SET last_activity_at = datetime('now') WHERE id = ?`).run(_stylistId);
    } catch {}
  }

  // 🧾 Enforce salon-level consent policy
  const salonRequiresConsent = !!salon?.salon_info?.compliance?.stylist_sms_consent_required;
  const stylistOptedIn =
    !!(stylist?.compliance_opt_in) ||
    !!(stylist?.consent?.sms_opt_in);

  // If salon requires consent but stylist hasn't agreed yet → block
  // Managers bypass consent — they accepted ToS at signup
  if (salonRequiresConsent && !stylistOptedIn && role !== "manager") {
    console.warn(`⚠️ Consent required for ${stylist.name || stylist.stylist_name} @ ${salon.salon_info?.name}`);
    await queueConsentAndPrompt(chatId, imageUrl, text, sendMessage, stylist);
    endTimer(start);
    return;
  }

  // Join flow?
  if (isJoinInProgress(chatId)) {
    const result = await continueJoinConversation(chatId, cleanText, sendMessage.sendText);
    if (result.done) console.log(`✅ Join flow completed for ${chatId}`);
    endTimer(start);
    return;
  }

  // =========================
  // CONSENT: stylist typed AGREE
  // =========================
  if (isAgreementMessage(cleanText) && consentSessions.get(chatId)?.status === "pending") {
    markConsentGranted(chatId);

    // Persist consent to DB (primary) — survives server restarts
    const now = new Date().toISOString();
    const persist = saveConsentToDb(chatId, {
      compliance_opt_in: true,
      compliance_timestamp: now,
      consent: { sms_opt_in: true, timestamp: now }
    });
    if (!persist.ok) {
      console.error("⚠️ Failed to persist consent to DB:", persist.error);
    }

    // Continue with queued content if any
    const queued = getQueuedIfAny(chatId);
    await sendMessage.sendText(chatId, "✅ Thanks! Consent received. Continuing…");
    
    if (queued?.imageUrls?.length) {
      await processNewImageFlow({
        chatId,
        text: queued.text,
        imageUrls: queued.imageUrls,
        drafts,
        generateCaption,
        moderateAIOutput,
        sendMessage,
        stylist,
        salon: getSalonByStylist(chatId) || salon
      });

      consentSessions.set(chatId, { status: "granted" });
      endTimer(start);
      return;
    }

    await sendQuickStart(chatId, stylist?.name || stylist?.stylist_name || null);
    endTimer(start);
    return;
  }

  // CANCEL
  if (command === "CANCEL") {
    const cancelDraft = drafts.get(chatId);
    const dbId = cancelDraft?._db_id;
    if (dbId) {
      try { updatePostStatus(dbId, "cancelled"); } catch (err) {
        console.warn("⚠️ Could not cancel DB draft:", err.message);
      }
    }
    drafts.delete(chatId);
    await sendMessage.sendText(chatId, "🛑 Cancelled. No action taken.");
    endTimer(start);
    return;
  }

  // WRONG — stylist disputes a "no availability" result
  if (command === "WRONG") {
    const recent = noAvailabilityRecent.get(chatId);
    if (recent && Date.now() - recent.at < NO_AVAIL_TTL_MS) {
      try {
        db.prepare(`
          INSERT INTO platform_issues (id, salon_id, stylist_id, stylist_name, stylist_phone, issue_type, description, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'availability_incorrect',
            'Stylist replied WRONG to a no-availability response. Zenoti data may be missing appointments.',
            'open', ?)
        `).run(
          crypto.randomUUID(), recent.salonId, recent.stylistId,
          recent.stylistName, recent.stylistPhone, new Date().toISOString()
        );
        noAvailabilityRecent.delete(chatId);
        console.log(`[Issues] Flagged availability issue for ${recent.stylistName} @ ${recent.salonId}`);
      } catch (err) {
        console.error("[Issues] Failed to create platform issue:", err.message);
      }
      await sendMessage.sendText(chatId,
        "Got it — we've flagged this for review. Your salon manager will be notified if there's an issue with your availability data."
      );
    } else {
      await sendMessage.sendText(chatId,
        "Not sure what that's in response to. Try texting \"Post availability\" to pull your schedule."
      );
    }
    endTimer(start);
    return;
  }

  // LEADERBOARD — send the public leaderboard URL
  if (/^(leaderboard|who('?s| is) (leading|winning|in the lead)|rankings?)$/i.test(cleanText)) {
    const salonId = salon?.salon_id || salon?.id || salon?.salon_info?.slug;
    try {
      const token = getOrCreateLeaderboardToken(salonId);
      const baseUrl = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
      await sendMessage.sendText(chatId,
        `🏆 Here's the team leaderboard:\n${baseUrl}/leaderboard/${token}`
      );
    } catch (err) {
      console.error("[Router] Leaderboard command error:", err.message);
      await sendMessage.sendText(chatId, "Sorry, couldn't load the leaderboard right now. Try again in a moment.");
    }
    endTimer(start);
    return;
  }

  // MENU — list available stylist commands
  if (/^(menu|what can i do)$/i.test(cleanText)) {
    await sendMessage.sendText(chatId,
      `Here's what you can do with MostlyPostly:\n\n` +
      `📸 *Standard post* — text 1–3 photos and we'll write a caption\n` +
      `🔄 *Before & after* — text 2 photos with "before and after" or "transformation"\n` +
      `📅 *Post my availability* — pulls your open slots from your booking software\n` +
      `🏆 *Leaderboard* — see where you rank on the team\n\n` +
      `After a caption preview:\n` +
      `• Reply APPROVE to submit\n` +
      `• Reply REDO to regenerate\n` +
      `• Reply CANCEL to discard`
    );
    endTimer(start);
    return;
  }

  // JOIN (managers)
  if (/^JOIN\b/i.test(cleanText)) {
    if (role !== "manager") {
      await sendMessage.sendText(chatId, "🚫 Only managers can use the JOIN command.");
      endTimer(start);
      return;
    }
    await handleJoinCommand(chatId, lookupStylist, cleanText, sendMessage.sendText);
    endTimer(start);
    return;
  }

  // APPROVE
  if (/^APPROVE\b/i.test(command)) {
    let draft = drafts.get(chatId);

    // If in-memory draft is gone (e.g. server restarted mid-flow), try DB
    if (!draft) {
      const dbDraft = findLatestDraft(chatId);
      if (dbDraft) {
        console.log(`[Router] Restored draft from DB for ${chatId} (server may have restarted)`);
        draft = restoreDraftFromDb(dbDraft);
        drafts.set(chatId, draft);
      }
    }

    // Keep original Twilio URL in DB — the media proxy handles display.
    // Only rehost temporarily for Telegram image previews (not stored).
    let imageUrl = draft?.image_url || null;
    let telegramPreviewUrl = imageUrl;


    if (!draft) {
      const pending = findPendingPostByManager(chatId);
      if (pending) {
        await handleManagerApproval(chatId, pending, sendMessage.sendText);
        endTimer(start);
        return;
      }
      await sendMessage.sendText(chatId, "⚠️ No draft found. Please send a photo first.");
      endTimer(start);
      return;
    }

      // 🔒 ALWAYS resolve manager approval from DB (never from cached salon object)
      const salonSlug =
        salon?.salon_info?.slug ||
        salon?.slug ||
        salon?.salon_id;

      const salonRow = db.prepare(`
        SELECT require_manager_approval
        FROM salons
        WHERE slug = ?
        LIMIT 1
      `).get(salonSlug);

      // Per-stylist auto-approve overrides salon-level manager approval requirement
      const stylistRow = db.prepare(`SELECT auto_approve FROM stylists WHERE phone = ? AND salon_id = ? LIMIT 1`)
        .get(from, salonSlug);
      const stylistAutoApprove = Number(stylistRow?.auto_approve) === 1;

      const requiresManager = Number(salonRow?.require_manager_approval) === 1 && !stylistAutoApprove;

      console.log("🔐 Manager approval resolved from DB:", {
        salonSlug,
        requiresManager
      });

      console.log("🧨 FORCE DEBUG requiresManager", {
      salon_info_flag: salon?.salon_info?.require_manager_approval,
      salon_flag: salon?.require_manager_approval,
      typeof_salon_flag: typeof salon?.require_manager_approval,
      requiresManager
    });

    const manager = db.prepare(`
      SELECT id, name, phone, chat_id
      FROM managers
      WHERE salon_id = ?
      LIMIT 1
    `).get(salon?.salon_id || salon?.id || salon?.salon_info?.slug);

    if (requiresManager && !manager) {
      console.error(
        "🚫 Manager approval required but no manager found for salon:",
        salon?.salon_id
      );

      await sendMessage.sendText(
        chatId,
        "⚠️ Manager approval is required, but no manager is configured for your salon."
      );

      endTimer(start);
      return;
    }

    // 🔧 HARDENING: Manager exists but has no delivery method (SMS or Telegram)
    if (
      requiresManager &&
      manager &&
      !manager.phone &&
      !manager.chat_id
    ) {
      console.warn(
        `⚠️ Manager exists but has no delivery method for salon ${salon?.salon_id}`
      );

      await sendMessage.sendText(
        chatId,
        "⚠️ Manager approval is required, but the manager does not have SMS or Telegram configured. Please contact support."
      );

      endTimer(start);
      return;
    }

    const bookingUrl = salon?.salon_info?.booking_url || "";
    const stylistName = getStylistName(stylist);
    const stylistHandle = getStylistHandle(stylist);

    // ✅ Always use DB-hydrated salon when composing captions
    const fullSalon = getSalonPolicy(
      salon?.slug || salon?.salon_id || salon?.id || salon?.salon_info?.id
    );

      // Base caption (single source of truth)
      let baseCaption = composeFinalCaption({
        caption: draft.caption || "Beautiful new style!",
        hashtags: draft.hashtags || [],              
        cta: draft.cta || "Book your next visit today!",
        instagramHandle: stylistHandle || null,
        stylistName,
        bookingUrl: fullSalon?.booking_url || bookingUrl,
        salon: fullSalon,                           
        asHtml: false,
      });

      // Managers can self-approve — skip the manager-approval gate
      if (requiresManager && role !== "manager") {
        console.log(`🕓 [Router] Manager approval required for ${stylistName}`);
        console.log("👔 Manager loaded for approval:", manager?.name, manager?.phone, manager?.chat_id);

        const stylistWithManager = {
          ...stylist,
          manager_phone: manager?.phone || null,
          manager_chat_id: manager?.chat_id ?? null,
          image_url: imageUrl,
          final_caption: baseCaption,
          booking_url: bookingUrl,
          instagram_handle: stylistHandle
        };

        // ✅ Save post with stylist_name and salon_id populated
        const pendingPost = await savePost(
          chatId,
          {
            ...stylistWithManager,
            stylist_name: stylistName || "Unknown Stylist",
            salon_id: salon?.salon_id || salon?.id || salon?.salon_info?.id || "unknown",
          },
          draft.caption,
          draft.hashtags || [],
          "manager_pending",
          io,
          salon
        );                

        // Double-check that data persisted
        console.log("💾 Post saved with stylist_name + salon_id:", {
          id: pendingPost?.id,
          stylist_name: stylistName,
          salon_id: salon?.salon_id || salon?.id || salon?.salon_info?.id,
        });


        if (!pendingPost?.id) {
          await sendMessage.sendText(chatId, "⚠️ Could not save your post. Please try again.");
          endTimer(start);
          return;
        }

        const persistPayload = {
          ...draft,
          final_caption: buildFacebookCaption(baseCaption, stylistName, stylistHandle),
          stylist_name: stylistName,
          instagram_handle: stylistHandle,
          booking_url: bookingUrl,
          image_url: imageUrl || null,
          status: "manager_pending"
        };
        await updatePostStatus(pendingPost.id, "manager_pending", persistPayload);

        console.log("💾 Post persisted (manager_pending):", { id: pendingPost.id });

        // =====================================================
        // ✅ v0.8 — Simplified Manager Link Notification (Twilio)
        // =====================================================

        // Dynamically resolve the salon identifier
        const salonIdentifier =
          salon.salon_id ||
          salon.id ||
          salon?.salon_info?.id ||
          salon?.salon_info?.name?.toLowerCase().replace(/\s+/g, "") ||
          "unknown";

          const salonKey =
          salon?.salon_id ||
          salon?.id ||
          salon?.salon_info?.id ||
          (salon?.salon_info?.slug) ||
          (salon?.salon_name?.toLowerCase().replace(/\s+/g, "")) ||
          "unknown";

          const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
          const managerLink = `${BASE_URL}/manager`;

          const notifyBody = `MostlyPostly: New post from ${stylistName} is waiting for your approval.

Log in to review: ${managerLink}

(Or reply APPROVE to auto-schedule for your next available slot.)`;

          if (manager?.phone) {
            console.log("📤 Sending manager approval link via Twilio →", manager.phone);
            await sendMessage.sendText(manager.phone, notifyBody);
          } else if (manager?.chat_id) {
          console.log("📤 No phone found — using Telegram fallback");
          // Rehost just for Telegram preview (not stored to DB)
          if (telegramPreviewUrl && /^https:\/\/api\.twilio\.com/i.test(telegramPreviewUrl)) {
            try {
              telegramPreviewUrl = await rehostTwilioMedia(telegramPreviewUrl, salon?.salon_id || "unknown");
            } catch { /* use original if rehost fails */ }
          }
          await sendManagerPreviewPhoto(manager.chat_id, telegramPreviewUrl || draft.image_url, {
            draft,
            stylist,
            salon,
          });
          } else {
          console.warn("⚠️ No manager contact configured.");
        }

        await sendMessage.sendText(chatId, "✅ Your post is pending manager approval before publishing.");
        drafts.delete(chatId);
        endTimer(start);
        return;
      }

    const igSalonId =
    salon?.salon_id ||
    salon?.id ||
    salon?.salon_info?.id;

    // --------------------------
    // Direct post path
    // --------------------------
    let fbResult = null; // ensure it's visible across try/catch
    try {
      // Build per-network captions
      const fbCaption = buildFacebookCaption(baseCaption, stylistName, stylistHandle);
      const igCaption = buildInstagramCaption(baseCaption, stylistName, stylistHandle);

      // Rehost Twilio URL → public HTTPS for FB/IG (temporary, not stored to DB)
      const draftImage = draft?.image_url || null;
      if (!draftImage) throw new Error("No image URL available for publishing");

      const rehostedUrl = await rehostTwilioMedia(draftImage, salon?.salon_id || "unknown");
      console.log(`🌐 Rehosted image for direct publish → ${rehostedUrl}`);


      // 🔒 ALWAYS reload salon from DB to guarantee FB token exists
      const salonRow = db.prepare(`
        SELECT facebook_page_id, facebook_page_token, slug, id
        FROM salons
        WHERE id = ? OR slug = ?
      `).get(
        salon?.salon_id || salon?.id,
        salon?.salon_id || salon?.id
      );

      if (!salonRow?.facebook_page_token) {
        throw new Error("Missing Facebook access token in DB for salon");
      }

      // ✅ Publish to Facebook first
      fbResult = await publishToFacebook(
        {
          facebook_page_id: salonRow.facebook_page_id,
          facebook_page_token: salonRow.facebook_page_token,
          slug: salonRow.slug,
          id: salonRow.id
        },
        fbCaption,
        rehostedUrl
      );


      // Define fbLink *before* logging or sending messages
      const fbLink =
        fbResult?.link ||
        (fbResult?.post_id
          ? `https://facebook.com/${fbResult.post_id.replace("_", "/posts/")}`
          : "✅ Facebook post created, but link unavailable.");

      console.log(`🚀 Facebook post published successfully: ${fbLink}`);

      await sendMessage.sendText(
        chatId,
        `✅ *Approved and posted!*\n\n${fbCaption}\n\n${fbLink}`
      );

      const imageForIg = rehostedUrl;

      // ✅ Instagram MUST use the SAME public HTTPS image as Facebook
      console.log("📷 IG FINAL IMAGE URL:", rehostedUrl);

      await publishToInstagram({
        salon_id: igSalonId,
        caption: igCaption,
        imageUrl: rehostedUrl
      });

      drafts.delete(chatId);
    } catch (err) {
      console.error("🚫 [Router] Facebook post failed:", err);
      await sendMessage.sendText(
        chatId,
        "⚠️ Could not post to Facebook. Check server logs."
      );
    }

    endTimer(start);
    return;
  }
  
  // DENY + reason
  if (command === "DENY") {
    const pending = findPendingPostByManager(chatId);
    if (pending) {
      await sendMessage.sendText(chatId, `✏️ Please provide a short reason for denying ${pending.stylist_name || "this stylist"}'s post.`);
      await updatePostStatus(pending.id, "awaiting_reason");
      endTimer(start);
      return;
    }
  }

  const awaitingReason = findPostAwaitingReason(chatId);
  if (awaitingReason) {
    await updatePostStatus(awaitingReason.id, "manager_denied", cleanText);
    await sendMessage.sendText(awaitingReason.stylist_phone, `❌ Your post was denied.\n\nReason: ${cleanText}`);
    await sendMessage.sendText(chatId, "✅ Denial reason recorded. Stylist notified.");
    endTimer(start);
    return;
  }

  // REGENERATE — redirect to portal (editing now happens on the web)
  if (command === "REGENERATE" || command === "REDO") {
    const draft = drafts.get(chatId) || (() => {
      const row = findLatestDraft(chatId);
      return row ? restoreDraftFromDb(row) : null;
    })();

    const postId = draft?._db_id;
    if (!postId) {
      await sendMessage.sendText(chatId, "No draft found. Please send a new photo first.");
      endTimer(start);
      return;
    }

    // Issue a fresh portal link
    try {
      const portalToken = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO stylist_portal_tokens (id, post_id, token, expires_at) VALUES (?, ?, ?, ?)`)
        .run(crypto.randomUUID(), postId, portalToken, expiresAt);
      const portalUrl = `${process.env.PUBLIC_BASE_URL || ""}/stylist/${postId}?token=${portalToken}`;
      await sendMessage.sendText(chatId, `Use this link to edit and regenerate your caption:\n${portalUrl}`);
    } catch (err) {
      console.error("⚠️ Could not generate portal token:", err.message);
      await sendMessage.sendText(chatId, "Unable to generate your edit link. Please try sending a new photo.");
    }
    endTimer(start);
    return;
  }

  // 🚫 Prevent AI preview or image handling during JOIN setup
  if (/^(join|cancel|setup|agree)\b/i.test(cleanText) || isJoinInProgress(chatId)) {
    console.log("⚠️ Skipping preview — active JOIN or setup command detected");
    endTimer(start);
    return;
  }


  // SMS availability request → pull from integrated booking software if connected.
  // Uses a 30-minute in-memory pool: the first request syncs ALL mapped stylists for the
  // salon; subsequent requests within 30 minutes read from the cache without hitting Zenoti.
  if (!primaryImageUrl && isAvailabilityRequest(cleanText)) {
    const salonId   = salon?.salon_id || salon?.id || salon?.salon_info?.slug;
    const stylistId = stylist?.id || stylist?.stylist_id;

    // Check for an active booking software integration (currently: Zenoti)
    const integration = salonId
      ? db.prepare(`SELECT platform FROM salon_integrations WHERE salon_id = ? AND sync_enabled = 1 LIMIT 1`).get(salonId)
      : null;

    if (integration) {
      // Fetch this stylist's full DB row (need integration_employee_id)
      const stylistRow = stylistId
        ? db.prepare(`SELECT id, name, instagram_handle, integration_employee_id FROM stylists WHERE id = ?`).get(stylistId)
        : null;

      if (stylistRow?.integration_employee_id) {
        try {
          const salonRow = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salonId);
          // No date hint → show all upcoming openings (full pool window: today + 14 days)
          const dateRange = hasDateHint(cleanText)
            ? parseDateRange(cleanText)
            : {
                startDate: new Date().toISOString().slice(0, 10),
                endDate:   new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
              };

          // Use pool if fresh, otherwise trigger a full salon sync (all stylists)
          let slots = getPooledStylistSlots(salonId, stylistRow.id, dateRange);
          if (!slots) {
            console.log(`[Router] Availability pool miss for salon=${salonId} — syncing all stylists`);
            const pool = await syncAvailabilityPool(salonId);
            // Read from the freshly synced pool
            slots = pool
              ? (pool.get(stylistRow.id) || [])
                  .filter(b => b.dateStr >= dateRange.startDate && b.dateStr <= dateRange.endDate)
                  .slice(0, 5)
                  .map(b => b.label)
              : [];
          } else {
            console.log(`[Router] Availability pool hit for salon=${salonId}, stylist=${stylistRow.name}`);
          }

          if (slots.length) {
            const result = await generateAndSaveAvailabilityPost({ salon: salonRow, stylist: stylistRow, slots });
            if (result?.postId) {
              const portalToken = crypto.randomBytes(32).toString("hex");
              const expiresAt   = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
              db.prepare(`INSERT INTO stylist_portal_tokens (id, post_id, token, expires_at) VALUES (?, ?, ?, ?)`)
                .run(crypto.randomUUID(), result.postId, portalToken, expiresAt);
              const portalUrl = `${process.env.PUBLIC_BASE_URL || ""}/stylist/${result.postId}?token=${portalToken}`;
              await sendMessage.sendText(chatId,
                `Your availability post is ready! Review it here:\n${portalUrl}\n\nOr reply APPROVE to submit now, or CANCEL to discard. (Link expires in 24 hours.)`
              );
            }
          } else {
            // Record so a "WRONG" reply within 1 hour creates a platform issue
            noAvailabilityRecent.set(chatId, {
              salonId:      salonId,
              stylistId:    stylistRow.id,
              stylistName:  stylistRow.name,
              stylistPhone: chatId,
              at:           Date.now(),
            });
            await sendMessage.sendText(chatId,
              "No open availability was found in your schedule for the next 14 days. Please confirm your appointments are up to date in your salon software.\n\nIf you believe this is incorrect, reply WRONG and we'll flag it for review."
            );
          }
        } catch (err) {
          console.error("[Router] SMS availability sync error:", err.message);
          await sendMessage.sendText(chatId, "Sorry, we couldn't pull your availability right now. Please try again.");
        }
        endTimer(start);
        return;
      }
      // Stylist not mapped to the integration → fall through to GPT text-parse path
    }
    // No integration → fall through to GPT text-parse path (stylist texts their own times)
  }

  // Availability posts don't require an image — route them directly (GPT-based text parse)
  if (!primaryImageUrl && classifyPostType(text || "") === "availability") {
    const alreadyOptedIn =
      role === "manager" ||
      stylist?.compliance_opt_in ||
      stylist?.consent?.sms_opt_in;

    if (!alreadyOptedIn && consentSessions.get(chatId)?.status !== "granted") {
      await queueConsentAndPrompt(chatId, [], text, sendMessage, stylist);
      endTimer(start);
      return;
    }

    await processNewImageFlow({
      chatId,
      text,
      imageUrls: [],
      drafts,
      generateCaption,
      moderateAIOutput,
      sendMessage,
      stylist,
      salon
    });

    endTimer(start);
    return;
  }

  // NEW PHOTO — Consented?
  if (primaryImageUrl) {
  const alreadyOptedIn =
    role === "manager" ||
    stylist?.compliance_opt_in ||
    stylist?.consent?.sms_opt_in;

  if (!alreadyOptedIn && consentSessions.get(chatId)?.status !== "granted") {
    await queueConsentAndPrompt(chatId, allImageUrls, text, sendMessage, stylist);
    endTimer(start);
    return;
  }

    await processNewImageFlow({
      chatId,
      text,
      imageUrls: allImageUrls,
      drafts,
      generateCaption,
      moderateAIOutput,
      sendMessage,
      stylist,
      salon
    });

    endTimer(start);
    return;
  }

  // Default
  if (
    !(
      role === "manager" ||
      stylist?.compliance_opt_in ||
      stylist?.consent?.sms_opt_in
    ) &&
    consentSessions.get(chatId)?.status !== "granted"
    ) {
      await queueConsentAndPrompt(chatId, [], null, sendMessage, stylist);
      endTimer(start);
      return;
    }

  await sendMessage.sendText(chatId, "📸 Please send a *photo* with a short note (like 'blonde balayage' or 'men’s cut').");
  endTimer(start);
}

// --------------------------------------
// Manager approval → mark for scheduler
async function handleManagerApproval(managerIdentifier, pendingPost, sendText) {
  console.log("🧩 Debug: Pending post ID:", pendingPost.id, "final_caption:", !!pendingPost.final_caption);
  console.log("🧾 Stored final_caption preview:", pendingPost.final_caption?.slice?.(0, 100));

  try {
    // Update DB to queue post for scheduler
    db.prepare(`
      UPDATE posts
      SET status='manager_approved',
          approved_by=?,
          approved_at=datetime('now')
      WHERE id=?`).run(managerIdentifier, pendingPost.id);

    enqueuePost(pendingPost);

    await sendText(managerIdentifier, "✅ Approved — your post will be scheduled automatically using your businesses posting rules.");
    await sendText(pendingPost.stylist_phone, "✅ Manager approved your post! It’s queued for publishing soon.");

    console.log(`🕓 Manager SMS approval queued post ${pendingPost.id} for scheduler.`);
  } catch (err) {
    console.error("❌ Manager SMS approval scheduling failed:", err.message);
    await sendText(managerIdentifier, "⚠️ Could not schedule this post. Try again later.");
  }
}
export { handleManagerApproval };
