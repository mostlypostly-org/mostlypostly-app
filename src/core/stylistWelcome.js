// src/core/stylistWelcome.js
// Sends welcome SMS to newly added stylists and handles the quick-start follow-up.

import db from "../../db.js";
import { sendViaTwilio, sendViaRcs } from "../routes/twilio.js";

const WATCH_URL = "https://mostlypostly.com/watch";

/**
 * Send a welcome SMS to a stylist.
 * - No consent on file → full welcome + consent request
 * - Already consented → quick-start guide only (e.g. resend scenario)
 *
 * @param {object} stylist  - DB row with at least { id, name, phone, compliance_opt_in }
 * @param {string} salonName
 */
export async function sendWelcomeSms(stylist, salonName) {
  const { id, name, phone, compliance_opt_in } = stylist;
  if (!phone) return;

  const hasConsent = !!compliance_opt_in;

  if (!hasConsent) {
    await sendViaRcs(
      phone,
      `Hi ${name}! ${salonName} has added you to MostlyPostly — your AI social media assistant.\n\n` +
      `Text a photo and we'll create a professional Instagram & Facebook caption automatically.\n\n` +
      `🎬 See how it works: ${WATCH_URL}\n\n` +
      `💡 Tip: Text COLLAB to have your work show up on your personal Instagram too.\n\n` +
      `Tap Agree below or reply AGREE to get started. Reply STOP to opt out. Msg & data rates may apply.`,
      ["reply:AGREE"]
    );
  } else {
    await sendViaTwilio(
      phone,
      `👋 Hi ${name}! You're set up on MostlyPostly for ${salonName}.\n\n` +
      `🎬 Get started: ${WATCH_URL}\n\n` +
      `Text MENU anytime to see everything you can do.\n\n` +
      `💡 Text COLLAB to have your work show up on your personal Instagram too.\n\n` +
      `📸 Tip: Always send camera photos, not screenshots — they process fastest!`
    );
  }

  db.prepare(`UPDATE stylists SET welcome_sent_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * Send a welcome SMS to a newly added coordinator.
 * @param {object} coordinator - DB row with at least { name, phone }
 * @param {string} salonName
 */
export async function sendCoordinatorWelcomeSms(coordinator, salonName) {
  const { name, phone } = coordinator;
  if (!phone) return;

  await sendViaTwilio(
    phone,
    `You've been added as a coordinator at ${salonName}. ` +
    `To post for a stylist, text a photo and include their name ` +
    `(e.g. "Taylor did this color"). Reply HELP for guidance.`
  );
}

/**
 * Send the post-consent quick-start message (called from messageRouter after AGREE).
 */
export async function sendQuickStart(phone, name) {
  if (!phone) return;
  await sendViaTwilio(
    phone,
    `✅ You're all set${name ? `, ${name}` : ""}! Welcome to MostlyPostly.\n\n` +
    `🎬 Get started: ${WATCH_URL}\n\n` +
    `Text MENU anytime to see everything you can do.\n\n` +
    `📸 Tip: Always send camera photos, not screenshots — they process fastest!`
  );
}
