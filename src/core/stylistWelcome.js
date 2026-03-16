// src/core/stylistWelcome.js
// Sends welcome SMS to newly added stylists and handles the quick-start follow-up.

import db from "../../db.js";
import { sendViaTwilio, sendViaRcs } from "../routes/twilio.js";

const KB_URL = "https://mostlypostly.com/kb/stylist-texting.html";

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
      `Tap Agree below or reply AGREE to get started. Reply STOP to opt out. Msg & data rates may apply.`,
      ["reply:AGREE"]
    );
  } else {
    await sendViaTwilio(
      phone,
      `👋 Hi ${name}! Here's your MostlyPostly quick-start guide for ${salonName}:\n\n` +
      `📖 ${KB_URL}\n\n` +
      `📸 Tip: Always send camera photos, not screenshots — they process fastest!`
    );
  }

  db.prepare(`UPDATE stylists SET welcome_sent_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * Send the post-consent quick-start message (called from messageRouter after AGREE).
 */
export async function sendQuickStart(phone, name) {
  if (!phone) return;
  await sendViaTwilio(
    phone,
    `✅ You're all set${name ? `, ${name}` : ""}! Welcome to MostlyPostly.\n\n` +
    `📖 Quick-start guide: ${KB_URL}\n\n` +
    `📸 Tip: Always send camera photos, not screenshots — they process fastest!`
  );
}
