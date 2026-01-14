// src/core/messageRouter.js
// MostlyPostly v0.5.15 — FB vs IG "Styled by" rules + IG rehost + consent + formatting
// --- top of messageRouter.js ---
import crypto from "crypto";
import { db, verifyTokenRow } from "../../db.js";  // ✅ single import (no duplicates)
import { enqueuePost } from "../scheduler.js";
import { getSalonPolicy } from "../scheduler.js";


// --- Ensure manager_tokens table exists (runs only once safely) ---
db.prepare(`
  CREATE TABLE IF NOT EXISTS manager_tokens (
    token TEXT PRIMARY KEY,
    salon_id TEXT,
    manager_phone TEXT,
    expires_at TEXT
  )
`).run();

// --- Issue & verify token ---
// --- Issue & verify token ---
// salonSlug should match managers.salon_id (e.g. 'rejuve-salon-spa')
function issueManagerToken(salonSlug, managerPhone) {
  const token = crypto.randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Detect schema for backwards compatibility
    const cols = db.prepare("PRAGMA table_info(manager_tokens)").all();
    const hasManagerId = cols.some(c => c.name === "manager_id");

    if (hasManagerId) {
      // 🔍 Find the real manager row in the DB
      let mgrRow = null;

      if (salonSlug) {
        mgrRow = db.prepare(
          "SELECT id FROM managers WHERE phone = ? AND salon_id = ? LIMIT 1"
        ).get(managerPhone, salonSlug);
      } else {
        mgrRow = db.prepare(
          "SELECT id FROM managers WHERE phone = ? LIMIT 1"
        ).get(managerPhone);
      }

      if (!mgrRow) {
        throw new Error(
          `No manager row found for phone=${managerPhone || "null"} salon=${salonSlug || "null"}`
        );
      }

      // Insert token tied to the actual manager_id
      db.prepare(`
        INSERT INTO manager_tokens (id, manager_id, token, expires_at, salon_id, manager_phone)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
      `).run(
        mgrRow.id,
        token,
        expires,
        salonSlug || null,
        managerPhone || null
      );
    } else {
      // Legacy schema without manager_id
      db.prepare(`
        INSERT INTO manager_tokens (token, salon_id, manager_phone, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(token, salonSlug || null, managerPhone || null, expires);
    }

    const verify = db.prepare(
      "SELECT id, manager_id, token, expires_at, salon_id, manager_phone FROM manager_tokens WHERE token = ?"
    ).get(token);

    console.log("🔑 Token stored row:", verify);
    return token;
  } catch (err) {
    console.error("❌ Failed to insert or verify token:", err.message);
    return null;
  }
}

import { publishToFacebook } from "../publishers/facebook.js";
import { publishToInstagram } from "../publishers/instagram.js";
import { handleJoinCommand, continueJoinConversation } from "./joinManager.js";
import { isJoinInProgress } from "./joinSessionStore.js";
import {
  lookupStylist,
  lookupStylistByChatId,
  getSalonByStylist,
  loadSalons,
} from "./salonLookup.js";
import {
  savePost,
  updatePostStatus,
  findPendingPostByManager,
  findPostAwaitingReason,
  saveStylistConsent,
} from "../core/storage.js";
import { composeFinalCaption } from "./composeFinalCaption.js";
// 🧠 Import moderation utility directly
import moderateAIOutput from "../utils/moderation.js";
import { rehostTwilioMedia } from "../utils/rehostTwilioMedia.js";
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

function hasConsent(stylist) {
  const legacy = stylist?.compliance_opt_in === true;
  const modern = stylist?.consent?.sms_opt_in === true;
  return legacy && modern;
}
function isAgreementMessage(text) {
  return /^\s*(AGREE|I AGREE|YES|YES I AGREE)\s*$/i.test(text || "");
}
function queueConsentAndPrompt(chatId, imageUrl, text, sendMessage, stylist) {
  consentSessions.set(chatId, { status: "pending", queued: { imageUrl, text } });
  const prompt = `
MostlyPostly: Please review our SMS Consent, Privacy, and Terms:
https://mostlypostly.github.io/mostlypostly-legal/

Reply *AGREE* to opt in. Reply STOP to opt out. HELP for help. Msg&data rates may apply.

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
      instagramHandle: null,
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
      instagramHandle: null,
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
  chatId, text, imageUrl, drafts,
  generateCaption, moderateAIOutput, sendMessage,
  stylist, salon
  }) {
  console.log("📸 [Router] New image received (consented):", imageUrl);

  // 1️⃣ Generate AI caption object
  // Hydrate salon with DB-backed config (tone, hashtags, rules, etc.)
  const fullSalon = getSalonPolicy(
    salon?.slug || salon?.salon_id || salon?.id
  );

  const aiJson = await generateCaption({
    imageDataUrl: imageUrl,
    notes: text || "",
    salon: fullSalon,
    stylist,
    city: stylist?.city || ""
  });


  aiJson.image_url = imageUrl;
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

  // Save draft
  drafts.set(chatId, { ...aiJson, final_caption: previewCaption, base_caption: baseCaption });

  // 5️⃣ Send stylist preview
  const preview = `
  💇‍♀️ *MostlyPostly Preview (Full Post)*

  ${previewCaption}

  Reply *APPROVE* to continue, *REGENERATE*, or *CANCEL* to stop.
  `.trim();

  await sendMessage.sendText(chatId, preview);
}

// --------------------------------------
// MAIN HANDLER
export async function handleIncomingMessage({
  source,
  chatId,
  text,
  imageUrl,
  drafts,
  generateCaption,
  moderateAIOutput,
  sendMessage,
  io
}) {
  const start = startTimer();
  console.log(`💬 [Router] Message received from ${source}:`, { chatId, text, imageUrl });

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

  // 🧾 Enforce salon-level consent policy
  const salonRequiresConsent = !!salon?.salon_info?.compliance?.stylist_sms_consent_required;
  const stylistOptedIn =
    stylist?.compliance_opt_in === true ||
    stylist?.consent?.sms_opt_in === true;

  // If salon requires consent but stylist hasn't agreed yet → block
  if (salonRequiresConsent && !stylistOptedIn) {
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

    // Persist consent to salons/<file>.json
    const now = new Date().toISOString();
    const persist = saveStylistConsent(chatId, {
      compliance_opt_in: true,
      compliance_timestamp: now,
      consent: { sms_opt_in: true, timestamp: now }
    });
    if (!persist.ok) {
      console.error("⚠️ Failed to persist consent:", persist.error);
    } else {
      console.log("✅ Consent persisted:", persist.file);
    }

    // Reload salons so live cache reflects the change
    await loadSalons();

    // Continue with queued content if any
    const queued = getQueuedIfAny(chatId);
    await sendMessage.sendText(chatId, "✅ Thanks! Consent received. Continuing…");
    
    if (queued?.imageUrl) {
      await processNewImageFlow({
        chatId,
        text: queued.text,
        imageUrl: queued.imageUrl,
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

    await sendMessage.sendText(chatId, "📸 Please send a photo with a short note to generate your caption.");
    endTimer(start);
    return;
  }

  // CANCEL
  if (command === "CANCEL") {
    drafts.delete(chatId);
    await sendMessage.sendText(chatId, "🛑 Cancelled. No action taken.");
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
    const draft = drafts.get(chatId);

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

      const requiresManager = Number(salonRow?.require_manager_approval) === 1;

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
        instagramHandle: null,
        stylistName,
        bookingUrl: fullSalon?.booking_url || bookingUrl,
        salon: fullSalon,                           
        asHtml: false,
      });

      if (requiresManager) {
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
          image_url: draft.image_url || null,
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

        const token = issueManagerToken(salonKey, manager.phone);
        console.log("🔑 Manager token created:", token);



          const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
          const managerLink = `${BASE_URL}/manager/login?token=${token}`;

          const notifyBody = `✂️ MostlyPostly: New post from ${stylistName}

          Review here: ${managerLink}

          (Reply APPROVE to auto-schedule this post for your next available slot.)`;

          if (manager?.phone) {
            console.log("📤 Sending manager approval link via Twilio →", manager.phone);
            await sendMessage.sendText(manager.phone, notifyBody);
          } else if (manager?.chat_id) {
          console.log("📤 No phone found — using Telegram fallback");
          await sendManagerPreviewPhoto(manager.chat_id, draft.image_url, {
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
      let image = null;

      if (draft?.image_url) {
        image = await rehostTwilioMedia(draft.image_url, draft.salon_id);

        // SAFETY CHECK — NEVER allow Twilio URLs downstream
        if (image.includes("api.twilio.com")) {
          throw new Error("❌ Twilio URL leaked — rehosting failed");
        }
      }

      // Build per-network captions
      const fbCaption = buildFacebookCaption(baseCaption, stylistName, stylistHandle);
      const igCaption = buildInstagramCaption(baseCaption, stylistName, stylistHandle);

      // ✅ Always rehost Twilio media to ensure a public URL for Meta (FB + IG)
      let rehostedUrl = null;
      try {
        const draftImage = draft?.image_url || null;

        if (!draftImage) {
          throw new Error("No image URL available for publishing");
        }

        // ALWAYS rehost unless already public HTTPS
        // ALWAYS rehost unless already public HTTPS
        if (!draftImage.startsWith("https://")) {
          let tmpPath = await rehostTwilioMedia(
            draftImage,
            salon?.salon_id || "unknown"
          );

          const PUBLIC_BASE_URL =
            process.env.PUBLIC_BASE_URL ||
            process.env.BASE_URL;

          if (!PUBLIC_BASE_URL) {
            throw new Error("PUBLIC_BASE_URL is not defined");
          }

          // 🔑 FORCE absolute public HTTPS URL (Instagram requires this)
          rehostedUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${tmpPath.startsWith("/") ? tmpPath : `/${tmpPath}`}`;

          console.log(`🌐 Rehosted image (public) → ${rehostedUrl}`);
        } else {
          rehostedUrl = draftImage;
        }

      } catch (err) {
        console.error("❌ Image rehost failed:", err.message);
        throw err; // STOP publish — IG requires public HTTPS
      }


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

  // REGENERATE
  if (command === "REGENERATE") {
    const draft = drafts.get(chatId);
    if (!draft?.image_url) {
      await sendMessage.sendText(chatId, "⚠️ No previous image found. Please send a new photo first.");
      endTimer(start);
      return;
    }

    await sendMessage.sendText(chatId, "🔄 Regenerating a fresh caption...");
    try {
      // ✅ Hydrate salon exactly like initial flow
      const fullSalon = getSalonPolicy(
        salon?.slug || salon?.salon_id || salon?.id
      );

      const aiJson = await generateCaption({
        imageDataUrl: draft.image_url,
        notes: draft.original_notes || "",
        salon: fullSalon,
        stylist,
        city: stylist?.city || ""
      });

      aiJson.image_url = draft.image_url;
      aiJson.original_notes = draft.original_notes;
      drafts.set(chatId, aiJson);

      const bookingUrlR = salon?.salon_info?.booking_url || "";
      let regenBase = composeFinalCaption({
        caption: aiJson.caption,
        hashtags: aiJson.hashtags,
        cta: aiJson.cta,
        instagramHandle: null,
        stylistName: getStylistName(stylist),
        bookingUrl: bookingUrlR,
        salon: fullSalon,
        asHtml: false
      });

      // Stylist preview remains FB-style
      const regenPreview = buildFacebookCaption(regenBase, getStylistName(stylist), getStylistHandle(stylist));

      const preview = `
      💇‍♀️ *MostlyPostly Preview (Regenerated)*

      ${regenPreview}

      Reply *APPROVE* to continue, *REGENERATE*, or *CANCEL* to start over.
      `.trim();

      await sendMessage.sendText(chatId, preview);
    } catch (err) {
      console.error("⚠️ [Router] Regeneration failed:", err);
      await sendMessage.sendText(chatId, "⚠️ Could not regenerate caption. Try again later.");
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


  // NEW PHOTO — Consented?
  if (imageUrl) {
  const alreadyOptedIn =
    stylist?.compliance_opt_in ||
    stylist?.consent?.sms_opt_in ||
    (stylist?.role === "manager" &&
      (stylist?.compliance_opt_in || stylist?.consent?.sms_opt_in));

  if (!alreadyOptedIn && consentSessions.get(chatId)?.status !== "granted") {
    await queueConsentAndPrompt(chatId, imageUrl, text, sendMessage, stylist);
    endTimer(start);
    return;
  }

    await processNewImageFlow({
      chatId,
      text,
      imageUrl,
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
      stylist?.compliance_opt_in ||
      stylist?.consent?.sms_opt_in ||
      (stylist?.role === "manager" &&
        (stylist?.compliance_opt_in || stylist?.consent?.sms_opt_in))
    ) &&
    consentSessions.get(chatId)?.status !== "granted"
    ) {
      await queueConsentAndPrompt(chatId, null, null, sendMessage, stylist);
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
