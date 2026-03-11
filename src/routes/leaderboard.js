// src/routes/leaderboard.js
// Public breakroom TV leaderboard — /leaderboard/:token
// No login required. Secured by an opaque random token.
// Auto-refreshes every 60 seconds. Designed for landscape TV display.
// Light-mode design: white header ensures all salon logos are visible.

import express from "express";
import {
  getSalonByLeaderboardToken,
  getLeaderboard,
  isBonusActive,
  getBonusMultiplier,
} from "../core/gamification.js";

const router = express.Router();

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const medals = ["🥇", "🥈", "🥉"];

// Podium platform colors: 2nd=charcoal, 1st=coral, 3rd=warm gray
const platColors = ["#2B2D35", "#3B72B9", "#A8A09C"];

router.get("/:token", (req, res) => {
  const salon = getSalonByLeaderboardToken(req.params.token);
  if (!salon) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title></head>
      <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#F5F0EC;color:#7A7C85">
        <p>Leaderboard not found. Ask your manager to share the correct link.</p>
      </body></html>
    `);
  }

  const period = "month"; // TV always shows current month
  const leaderboard = getLeaderboard(salon.slug, period);
  const bonusActive = isBonusActive(salon.slug);
  const multiplier  = getBonusMultiplier(salon.slug);

  const top3 = leaderboard.slice(0, 3);
  const rest  = leaderboard.slice(3, 10);

  // ── Top 3 podium ─────────────────────────────────────────────────────────
  // Display order: 2nd, 1st, 3rd for visual podium effect
  const podiumOrder   = [top3[1], top3[0], top3[2]].filter(Boolean);
  const podiumHeights = top3[1] ? ["h-32", "h-44", "h-24"] : ["", "h-44", ""];

  const podiumCards = podiumOrder.map((s, i) => {
    const isCenter = i === 1;
    const platColor = platColors[i];
    const nameSz    = isCenter ? "text-2xl" : "text-lg";
    const ptSz      = isCenter ? "text-4xl" : "text-2xl";
    const medal     = medals[s.rank - 1] || "";
    const height    = podiumHeights[i];
    return `
      <div class="flex flex-col items-center gap-2 flex-1">
        <div class="text-4xl">${medal}</div>
        <div class="${nameSz} font-extrabold text-center leading-tight" style="color:#2B2D35">${esc(s.stylist_name)}</div>
        <div class="${ptSz} font-black" style="color:#3B72B9">${s.points}<span class="text-base font-semibold ml-1" style="color:#9CA3AF">pts</span></div>
        <div class="text-xs" style="color:#7A7C85">${s.post_count} post${s.post_count !== 1 ? "s" : ""}${s.streak > 1 ? ` · 🔥 ${s.streak}wk` : ""}</div>
        <div class="w-full ${height} rounded-t-2xl" style="background:${platColor}"></div>
      </div>`;
  }).join("");

  // ── Rest of leaderboard ───────────────────────────────────────────────────
  const restRows = rest.map(s => `
    <div class="flex items-center gap-4 py-3 border-b last:border-0" style="border-color:#E5DCDA">
      <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white" style="background:#2B2D35">${s.rank}</span>
      <span class="flex-1 text-lg font-semibold" style="color:#2B2D35">${esc(s.stylist_name)}</span>
      <span class="font-bold text-xl" style="color:#3B72B9">${s.points} <span class="text-xs font-normal" style="color:#9CA3AF">pts</span></span>
      <span class="text-sm w-20 text-right" style="color:#7A7C85">${s.post_count} posts</span>
      ${s.streak > 1 ? `<span class="text-sm w-16 text-right" style="color:#7A7C85">🔥 ${s.streak}wk</span>` : `<span class="w-16"></span>`}
    </div>`).join("");

  const emptyState = !leaderboard.length ? `
    <div class="col-span-full flex flex-col items-center justify-center py-20" style="color:#7A7C85">
      <p class="text-2xl font-bold">No posts yet this month</p>
      <p class="text-lg mt-2">Text a photo to get started!</p>
    </div>` : "";

  // ── Logo — white header means any logo color is visible ───────────────────
  const logoHtml = salon.logo_url
    ? `<img src="${esc(salon.logo_url)}" alt="${esc(salon.name)}" class="h-12 w-auto object-contain" />`
    : `<span class="text-xl font-extrabold" style="color:#2B2D35">${esc(salon.name)}</span>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(salon.name)} — Leaderboard</title>
  <meta http-equiv="refresh" content="60" />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', ui-sans-serif, sans-serif;
      background: #F5F0EC;
      color: #2B2D35;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    @keyframes pulse-slow { 0%,100% { opacity:1; } 50% { opacity:.6; } }
    .pulse-slow { animation: pulse-slow 2s ease-in-out infinite; }
    .h-32 { height: 8rem; }
    .h-44 { height: 11rem; }
    .h-24 { height: 6rem; }
    .rounded-t-2xl { border-radius: 1rem 1rem 0 0; }
  </style>
</head>
<body>

  <!-- Header — pure white so any salon logo reads clearly -->
  <header style="background:#fff;border-bottom:1px solid #E5DCDA;box-shadow:0 1px 4px rgba(43,45,53,0.06);display:flex;align-items:center;justify-content:space-between;padding:1.25rem 2.5rem;">
    <div style="display:flex;align-items:center;gap:1rem;">
      ${logoHtml}
      <div style="width:1px;height:2rem;background:#E5DCDA"></div>
      <div>
        <p style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#7A7C85">Team Leaderboard</p>
        <p style="font-size:14px;font-weight:700;color:#2B2D35">This Month</p>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:1.5rem;">
      ${bonusActive ? `
      <div class="pulse-slow" style="display:flex;align-items:center;gap:.5rem;border-radius:9999px;border:1px solid rgba(59,114,185,0.4);background:rgba(59,114,185,0.12);padding:.625rem 1.25rem;">
        <span style="font-size:1.25rem">🎯</span>
        <span style="font-size:14px;font-weight:700;color:#3B72B9">${multiplier}× DOUBLE POINTS ACTIVE</span>
      </div>` : ""}
      <div style="text-align:right;">
        <p style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#9CA3AF">Powered by</p>
        <p style="font-size:14px;font-weight:700;color:#2B2D35">MostlyPostly</p>
      </div>
    </div>
  </header>

  <!-- Main content -->
  <main style="flex:1;display:flex;gap:2rem;padding:2rem 2.5rem;overflow:hidden;">

    <div style="flex:1;display:flex;flex-direction:column;gap:2rem;">

      ${emptyState}

      ${top3.length ? `
      <!-- Podium -->
      <div style="display:flex;align-items:flex-end;justify-content:center;gap:1.5rem;padding-bottom:1rem;">
        ${podiumCards}
      </div>` : ""}

      ${rest.length ? `
      <!-- 4th–10th -->
      <div style="background:#fff;border:1px solid #E5DCDA;border-radius:1rem;padding:.5rem 1.5rem;box-shadow:0 1px 4px rgba(43,45,53,0.06);">
        ${restRows}
      </div>` : ""}

    </div>

  </main>

  <!-- Footer -->
  <footer style="background:#fff;border-top:1px solid #E5DCDA;padding:1rem 2.5rem;display:flex;align-items:center;justify-content:space-between;">
    <p style="font-size:12px;color:#7A7C85">Auto-refreshes every 60 seconds</p>
    <p style="font-size:12px;color:#7A7C85">Points based on published posts · Streaks = consecutive weeks with a post</p>
  </footer>

</body>
</html>`);
});

export default router;
