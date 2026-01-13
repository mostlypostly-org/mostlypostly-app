// src/routes/twilio.js — MostlyPostly (multi-tenant, photo-first, using updateStylistConsent)
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";

import {
  handleJoinCommand,
  continueJoinConversation,
} from "../core/joinManager.js";
import { joinSessions } from "../core/joinSessionStore.js";

import { handleIncomingMessage } from "../core/messageRouter.js";
import moderateAIOutput from "../utils/moderation.js";

// ======================================================
// ✅ Twilio Client + helper to send outbound SMS
// ======================================================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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

      // --- MAIN PIPELINE (photo-first: allow image-only) ---
      if (!imageUrl && !text) {
        await sendViaTwilio(from, "📸 Please send a photo or a caption text to create a preview.");
        return;
      }

      console.log("🧠 [Twilio] Calling handleIncomingMessage for:", { from, imageUrl, text });

      await handleIncomingMessage({
        source: "twilio",
        chatId: from,
        text,
        imageUrl,
        drafts,
        generateCaption,
        moderateAIOutput,
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
