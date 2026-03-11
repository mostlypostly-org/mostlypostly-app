// src/routes/help.js — Public knowledge base for stylists (no auth required)

import express from "express";
import db from "../../db.js";

const router = express.Router();

function shell(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — MostlyPostly Help</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            mpCharcoal: "#2B2D35", mpAccent: "#3B72B9",
            mpAccentLight: "#EBF3FF", mpBg: "#FDF8F6",
            mpBorder: "#EDE7E4", mpMuted: "#7A7C85",
          }
        }
      }
    };
  </script>
  <style>
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; }
  </style>
</head>
<body class="max-w-xl mx-auto px-5 pb-16">
  <header style="padding:18px 0 14px; margin-bottom:24px; border-bottom:1px solid #EDE7E4;">
    <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="height:36px;width:auto;" />
  </header>
  ${body}
  <footer class="mt-12 pt-6 border-t border-mpBorder text-center text-xs text-mpMuted">
    Questions? Text your manager or email <a href="mailto:support@mostlypostly.com" class="text-mpAccent underline">support@mostlypostly.com</a>
  </footer>
</body>
</html>`;
}

function card(icon, title, body) {
  return `
  <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5 mb-4 shadow-sm">
    <div class="flex items-center gap-2 mb-3">
      <span class="text-xl">${icon}</span>
      <h2 class="text-base font-bold text-mpCharcoal">${title}</h2>
    </div>
    ${body}
  </div>`;
}

// ── GET /help/stylists — Stylist quick-start landing page ─────────────────────
router.get("/stylists", (req, res) => {
  res.send(shell("Stylist Quick Start", `
    <h1 class="text-2xl font-extrabold text-mpCharcoal mb-1">Stylist Quick Start</h1>
    <p class="text-sm text-mpMuted mb-6">Everything you need to start sharing your work on social media in minutes.</p>

    ${card("📸", "How to Post", `
      <ol class="space-y-3 text-sm text-mpCharcoal">
        <li class="flex gap-3">
          <span class="flex-shrink-0 w-6 h-6 rounded-full bg-mpAccentLight text-mpAccent font-bold text-xs flex items-center justify-center">1</span>
          <span><strong>Text a photo</strong> to your salon's MostlyPostly number. Add a short note about the service if you like — e.g. <em>"warm balayage, client wanted beach waves"</em>.</span>
        </li>
        <li class="flex gap-3">
          <span class="flex-shrink-0 w-6 h-6 rounded-full bg-mpAccentLight text-mpAccent font-bold text-xs flex items-center justify-center">2</span>
          <span><strong>AI writes a caption</strong> in your salon's brand voice. You'll get a text back with a link to review it.</span>
        </li>
        <li class="flex gap-3">
          <span class="flex-shrink-0 w-6 h-6 rounded-full bg-mpAccentLight text-mpAccent font-bold text-xs flex items-center justify-center">3</span>
          <span><strong>Review your caption</strong> on the preview page. Add notes and regenerate, or submit it as-is.</span>
        </li>
        <li class="flex gap-3">
          <span class="flex-shrink-0 w-6 h-6 rounded-full bg-mpAccentLight text-mpAccent font-bold text-xs flex items-center justify-center">4</span>
          <span><strong>Your manager approves</strong> it (if required), and the post publishes automatically during your salon's posting window.</span>
        </li>
      </ol>
    `)}

    ${card("💬", "SMS Commands", `
      <div class="space-y-2 text-sm">
        <div class="flex gap-3 items-start">
          <span class="font-mono bg-mpBg border border-mpBorder px-2 py-0.5 rounded text-xs text-mpCharcoal flex-shrink-0">APPROVE</span>
          <span class="text-mpMuted">Skip the preview link and submit your caption directly for manager review.</span>
        </div>
        <div class="flex gap-3 items-start">
          <span class="font-mono bg-mpBg border border-mpBorder px-2 py-0.5 rounded text-xs text-mpCharcoal flex-shrink-0">CANCEL</span>
          <span class="text-mpMuted">Discard the current caption draft. No post will be created.</span>
        </div>
        <div class="flex gap-3 items-start">
          <span class="font-mono bg-mpBg border border-mpBorder px-2 py-0.5 rounded text-xs text-mpCharcoal flex-shrink-0">STOP</span>
          <span class="text-mpMuted">Opt out of MostlyPostly SMS messages.</span>
        </div>
      </div>
    `)}

    ${card("✨", "What You Can Post", `
      <ul class="space-y-2 text-sm text-mpCharcoal">
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Client hair photos</strong> — color, cuts, extensions, blowouts, any finished look</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Before &amp; After</strong> — send two photos in one text for a side-by-side collage</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Availability</strong> — text "I have openings Friday 2pm and Saturday 10am" to create an availability post</span></li>
      </ul>
    `)}

    ${card("🎨", "Personalizing Your Posts", `
      <p class="text-sm text-mpMuted mb-3">Want captions that sound more like <em>you</em>? Here's how to tell your manager:</p>
      <ul class="space-y-2 text-sm text-mpCharcoal">
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Your tone</strong> — text your manager a few words that describe how you talk to clients (e.g. "fun and casual" or "professional and educational")</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Profile photo</strong> — send your manager 1–2 professional headshots to use in availability posts</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Best work photos</strong> — send up to 10 of your best client photos so AI has examples of your style</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span><strong>Your specialties</strong> — let your manager know what services you specialize in so captions highlight them</span></li>
      </ul>
    `)}

    ${card("📜", "Terms & Messaging Consent", `
      <p class="text-sm text-mpMuted mb-3">MostlyPostly sends you SMS messages when your captions are ready. Standard message and data rates may apply.</p>
      <ul class="space-y-1 text-sm text-mpCharcoal">
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span>Reply <strong>STOP</strong> at any time to stop receiving messages</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span>Reply <strong>HELP</strong> for support info</span></li>
        <li class="flex gap-2"><span class="text-mpAccent">●</span><span>Message frequency depends on how often you post</span></li>
      </ul>
      <div class="mt-3 flex gap-3 flex-wrap text-xs">
        <a href="/legal/terms.html" class="text-mpAccent underline">Terms of Service</a>
        <a href="/legal/privacy.html" class="text-mpAccent underline">Privacy Policy</a>
        <a href="/legal/sms-consent.html" class="text-mpAccent underline">SMS Consent Policy</a>
      </div>
    `)}
  `));
});

// ── GET /help — redirect to stylist guide ──────────────────────────────────────
router.get("/", (req, res) => {
  res.redirect("/help/stylists");
});

export default router;
