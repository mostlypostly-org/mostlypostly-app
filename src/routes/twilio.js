// src/routes/twilio.js — MostlyPostly (multi-tenant, photo-first, using updateStylistConsent)
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import { db } from "../../db.js";

import {
  handleJoinCommand,
  continueJoinConversation,
} from "../core/joinManager.js";
import { joinSessions } from "../core/joinSessionStore.js";
import {
  lookupStylist,
  findStylistDirect,
  updateStylistConsent, // ✅ use the helper your codebase actually exports
} from "../core/salonLookup.js";
import { handleIncomingMessage } from "../core/messageRouter.js";
import moderateAIOutput from "../utils/moderation.js";

// ======================================================
// ✅ Twilio Client + helper to send outbound SMS
// ======================================================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function hasSmsConsent(phone) {
  const row =
    db.prepare(`
      SELECT compliance_opt_in
      FROM managers
      WHERE phone = ?
    `).get(phone)
    ||
    db.prepare(`
      SELECT compliance_opt_in
      FROM stylists
      WHERE phone = ?
    `).get(phone);

  return row?.compliance_opt_in === 1;
}


export async function sendViaTwilio(to, body) {
  try {
    const opts = process.env.TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, to, body }
      : { from: process.env.TWILIO_PHONE_NUMBER, to, body };

    const resp = await client.messages.create(opts);
    console.log(`[Twilio → ${to}] id=${resp.sid} :: ${body.slice(0, 140)}`);
  } catch (err) {
    console.error("⚠️ [Twilio Send Error]:", err.message);
  }
}

const MessagingResponse = twilio.twiml.MessagingResponse;

export default function twilioRoute(drafts, _lookupStylist, generateCaption) {
  const router = express.Router();

  // Twilio posts application/x-www-form-urlencoded by default
  router.use(bodyParser.urlencoded({ extended: true }));

    router.post("/", async (req, res) => {
    const from = (req.body.From || "").trim();
    const toNumber = (req.body.To || "").trim();
    const text = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const imageUrl = numMedia > 0 ? req.body[`MediaUrl${numMedia - 1}`] : null;

    console.log("🔔 [Twilio] Webhook:", {
      from,
      to: toNumber,
      hasText: text.length > 0,
      numMedia,
      imageUrl: imageUrl || null,
    });

    const upperInit = text.toUpperCase();

    // =========================================================
    // 🧠  Decide what to reply immediately to Twilio (ACK)
    // =========================================================
    try {
      const twiml = new MessagingResponse();

      if (
          /^(JOIN|CANCEL|SETUP|AGREE|APPROVE|DENY|EDIT|RESET)\b/i.test(text) ||
          joinSessions.has(from)
        ) {
          // 🧠 These are command flows — respond silently (no "Got it" message)
          res.type("text/xml").send(twiml.toString());
        } else {
          // ✅ Normal messages (photo or caption) → friendly auto-ACK
          twiml.message("✅ Got it! Creating your preview 💇‍♀️");
          res.type("text/xml").send(twiml.toString());
        }

    } catch {
      try { res.status(200).end(); } catch {}
    }

    // ============================================
    // 🧠 Background pipeline (non-blocking)
    // ============================================
    try {
      // --- JOIN FLOW ---
      if (upperInit.startsWith("JOIN")) {
        await handleJoinCommand(from, lookupStylist, text, (msg) => sendViaTwilio(from, msg));
        return;
      }
      if (joinSessions.has(from)) {
        await continueJoinConversation(from, text, (msg) => sendViaTwilio(from, msg));
        return;
      }

      // --- CONSENT FLOW ---
      if (upperInit === "AGREE") {
        const now = new Date().toISOString();

        // 1️⃣ Try MANAGER first
        let result = db.prepare(`
          UPDATE managers
          SET
            compliance_opt_in = 1,
            compliance_timestamp = ?,
            consent = json_set(
              COALESCE(consent, '{}'),
              '$.sms_opt_in', true,
              '$.timestamp', ?
            )
          WHERE phone = ?
        `).run(now, now, from);

        let role = "manager";

        // 2️⃣ If no manager row updated, try STYLIST
        if (result.changes === 0) {
          result = db.prepare(`
            UPDATE stylists
            SET
              compliance_opt_in = 1,
              compliance_timestamp = ?,
              consent = json_set(
                COALESCE(consent, '{}'),
                '$.sms_opt_in', true,
                '$.timestamp', ?
              )
            WHERE phone = ?
          `).run(now, now, from);

          role = "stylist";
        }

        // 3️⃣ If neither updated → error
        if (result.changes === 0) {
          await sendViaTwilio(
            from,
            "⚠️ Couldn’t find your account. Please contact your salon manager."
          );
          return;
        }

        console.log(`✅ SMS consent persisted to DB for ${role}:`, from);

        await sendViaTwilio(
          from,
          "✅ Thanks! Your SMS consent has been recorded."
        );

        return;
      }


      // --- STYLIST & SALON CONTEXT ---
      const match = findStylistDirect(from) || lookupStylist(from);
      if (!match || !match.stylist) {
        await sendViaTwilio(from, "🚫 You’re not registered with any salon. Ask your manager to add you.");
        return;
      }

      // --- SMS CONSENT GATE (DB-backed) ---
      if (!hasSmsConsent(from)) {
        await sendViaTwilio(
          from,
          "MostlyPostly: Please review our SMS Consent, Privacy, and Terms:\n" +
          "https://mostlypostly.com/legal/sms-consent.html/\n" +
          "Reply *AGREE* to opt in"
        );
        return;
      }


      const salon_id =
        match?.salon_id ||
        match?.salon?.salon_id ||
        match?.salon_info?.id ||
        match?.salon_info?.salon_id ||
        match?.stylist?.salon_id ||
        null;

      if (!salon_id) {
        console.warn("⚠️ No salon_id on stylist record — pipeline will continue but analytics may be limited.");
      }

      // --- MAIN PIPELINE (photo-first: allow image-only) ---
      if (!imageUrl && !text) {
        await sendViaTwilio(from, "📸 Please send a photo or a caption text to create a preview.");
        return;
      }

      console.log("🧠 [Twilio] Calling handleIncomingMessage for:", { from, imageUrl, text });

      await handleIncomingMessage({
        source: "twilio",
        chatId: from,
        toNumber,
        text,
        imageUrl,
        drafts,
        lookupStylist,
        generateCaption,
        moderateAIOutput,
        tenant: { salon_id },
        sendMessage: {
          sendText: async (target, msg) => sendViaTwilio(target || from, msg),
        },
        io: null,
      });

      console.log("✅ [Twilio] handleIncomingMessage finished:", from);
    } catch (err) {
      console.error("❌ [Twilio] Async pipeline error:", err);
      try { await sendViaTwilio(from, "⚠️ Something went wrong. Please try again in a moment."); } catch {}
    }
  });

  return router;
}
