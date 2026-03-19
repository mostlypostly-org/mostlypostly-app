// src/routes/leaderboard.js
// Public breakroom TV leaderboard — /leaderboard/:token
// No login required. Secured by an opaque random token.
// Auto-refreshes every 60 seconds. Designed for landscape TV display.

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

// Avatar initials from a display name
function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Rank ring / glow color
const RANK_COLORS = {
  1: { ring: "#F59E0B", glow: "rgba(245,158,11,0.35)", label: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
  2: { ring: "#94A3B8", glow: "rgba(148,163,184,0.25)", label: "#CBD5E1", bg: "rgba(148,163,184,0.10)" },
  3: { ring: "#CD7C4E", glow: "rgba(205,124,78,0.25)",  label: "#D4A27A", bg: "rgba(205,124,78,0.10)" },
};

const CROWN  = ["🥇", "🥈", "🥉"];
const RANK_LABEL = ["1st", "2nd", "3rd"];

// ── Hourly rank snapshot for up/down arrows ───────────────────────────────
const rankSnapshots = new Map(); // salonId -> { hour, ranks: Map<name, rank> }

function getPrevRanks(salonId, currentBoard) {
  const currentHour = Math.floor(Date.now() / (60 * 60 * 1000));
  const snap = rankSnapshots.get(salonId);
  const prevRanks = snap ? snap.ranks : null;
  if (!snap || snap.hour !== currentHour) {
    rankSnapshots.set(salonId, {
      hour: currentHour,
      ranks: new Map(currentBoard.map(s => [s.stylist_name, s.rank])),
    });
  }
  return prevRanks;
}

function rankArrow(name, currentRank, prevRanks) {
  if (!prevRanks) return "";
  const prev = prevRanks.get(name);
  if (prev == null || prev === currentRank) return "";
  return prev > currentRank
    ? `<span style="color:#22C55E;font-weight:800;font-size:.75rem;">▲</span>`
    : `<span style="color:#EF4444;font-weight:800;font-size:.75rem;">▼</span>`;
}

router.get("/:token", (req, res) => {
  const salon = getSalonByLeaderboardToken(req.params.token);
  if (!salon) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not Found</title></head>
      <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#0F172A;color:#94A3B8">
        <p>Leaderboard not found. Ask your manager to share the correct link.</p>
      </body></html>
    `);
  }

  const period      = "month";
  const leaderboard = getLeaderboard(salon.slug, period);
  const bonusActive = isBonusActive(salon.slug);
  const multiplier  = getBonusMultiplier(salon.slug);
  const prevRanks   = getPrevRanks(salon.slug, leaderboard);

  const top3   = leaderboard.slice(0, 3);
  const allRows = leaderboard;                  // full list always shown in right panel
  const maxPts  = top3[0]?.points || 1;         // for progress bar scaling

  // ── Logo ─────────────────────────────────────────────────────────────────
  const logoHtml = salon.logo_url
    ? `<img src="${esc(salon.logo_url)}" alt="${esc(salon.name)}" style="height:44px;width:auto;object-fit:contain;" />`
    : `<span style="font-size:1.25rem;font-weight:800;color:#fff;letter-spacing:-0.02em">${esc(salon.name)}</span>`;

  // ── Bonus banner ─────────────────────────────────────────────────────────
  const bonusBanner = bonusActive ? `
    <div class="pulse-slow" style="display:flex;align-items:center;gap:.625rem;border-radius:9999px;background:rgba(245,158,11,0.18);border:1px solid rgba(245,158,11,0.5);padding:.5rem 1.25rem;">
      <span style="font-size:1.1rem">🎯</span>
      <span style="font-size:.8rem;font-weight:800;color:#F59E0B;letter-spacing:.06em;text-transform:uppercase">${multiplier}× DOUBLE POINTS ACTIVE</span>
    </div>` : "";

  // ── Hero: top 3 podium ───────────────────────────────────────────────────
  // Order: 2nd (left) · 1st (center, tallest) · 3rd (right)
  const podiumOrder = [top3[1], top3[0], top3[2]];
  const podiumSizes = [
    { avatar: 88,  nameSz: "1.1rem", ptSz: "1.6rem", labelSz: ".7rem",  mt: "3.5rem" },  // 2nd
    { avatar: 112, nameSz: "1.4rem", ptSz: "2.2rem", labelSz: ".75rem", mt: "0" },        // 1st
    { avatar: 80,  avatar: 80, nameSz: "1rem",  ptSz: "1.4rem", labelSz: ".7rem",  mt: "5rem" },  // 3rd
  ];

  const podiumCards = podiumOrder.map((s, i) => {
    if (!s) return `<div style="flex:1"></div>`;
    const rankIdx = s.rank - 1; // 0=1st,1=2nd,2=3rd
    const rc = RANK_COLORS[s.rank] || RANK_COLORS[3];
    const sz = podiumSizes[i];
    const av = sz.avatar || 88;
    const ini = initials(s.stylist_name);
    const isCenter = i === 1;

    // Post type breakdown — small dots
    const typeBreakdown = Object.entries(s.by_type || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type, cnt]) => {
        const label = type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return `<span style="font-size:.65rem;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.7);padding:.2rem .55rem;border-radius:9999px;white-space:nowrap">${label} ×${cnt}</span>`;
      }).join("");

    return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:.625rem;margin-top:${sz.mt};padding:.75rem .5rem;">
        <!-- Rank badge + Avatar -->
        <div style="position:relative;display:inline-flex;">
          <!-- Glow ring -->
          <div style="position:absolute;inset:-4px;border-radius:50%;box-shadow:0 0 0 3px ${rc.ring},0 0 20px 4px ${rc.glow};border-radius:50%;"></div>
          <!-- Avatar circle -->
          <div style="width:${av}px;height:${av}px;border-radius:50%;background:linear-gradient(135deg,#1e293b,#0f172a);border:3px solid ${rc.ring};display:flex;align-items:center;justify-content:center;font-size:${Math.round(av * 0.34)}px;font-weight:900;color:${rc.ring};letter-spacing:-.02em;position:relative;z-index:1;">
            ${ini}
          </div>
          <!-- Rank badge -->
          <div style="position:absolute;bottom:-6px;right:-6px;width:26px;height:26px;border-radius:50%;background:#0F172A;border:2px solid ${rc.ring};display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:900;color:${rc.ring};z-index:2;">
            ${s.rank}
          </div>
        </div>

        <!-- Crown / medal -->
        <div style="font-size:${isCenter ? "1.6rem" : "1.1rem"};line-height:1;">${CROWN[rankIdx] || ""}</div>

        <!-- Name -->
        <div style="font-size:${sz.nameSz};font-weight:800;color:#fff;text-align:center;line-height:1.2;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${esc(s.stylist_name)}
        </div>

        <!-- Points -->
        <div style="display:flex;align-items:baseline;gap:.3rem;">
          <span style="font-size:${sz.ptSz};font-weight:900;color:${rc.label};line-height:1;">${s.points}</span>
          <span style="font-size:.75rem;font-weight:600;color:rgba(255,255,255,0.4);">pts</span>
        </div>

        <!-- Post count + streak + arrow -->
        <div style="display:flex;align-items:center;gap:.5rem;font-size:.72rem;color:rgba(255,255,255,0.5);">
          <span>${s.post_count} post${s.post_count !== 1 ? "s" : ""}</span>
          ${s.streak > 1 ? `<span style="color:#F59E0B;font-weight:700;">🔥 ${s.streak}wk streak</span>` : ""}
          ${rankArrow(s.stylist_name, s.rank, prevRanks)}
        </div>

        <!-- Post type breakdown -->
        ${typeBreakdown ? `<div style="display:flex;flex-wrap:wrap;gap:.3rem;justify-content:center;max-width:180px;">${typeBreakdown}</div>` : ""}

        <!-- Podium platform bar -->
        <div style="width:100%;height:${isCenter ? "56px" : s.rank === 2 ? "40px" : "28px"};background:${rc.bg};border:1px solid ${rc.ring}22;border-radius:.75rem .75rem 0 0;margin-top:.25rem;"></div>
      </div>`;
  }).join("");

  // ── Ranked list — ALL stylists, medals for top 3 ─────────────────────────
  const MEDALS = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const TOP3_RING = { 1: "#F59E0B", 2: "#94A3B8", 3: "#CD7C4E" };

  const allRowsHtml = allRows.map((s, idx) => {
    const pct     = Math.round((s.points / maxPts) * 100);
    const ini     = initials(s.stylist_name);
    const isEven  = idx % 2 === 0;
    const arrow   = rankArrow(s.stylist_name, s.rank, prevRanks);
    const medal   = MEDALS[s.rank] || null;
    const ringClr = TOP3_RING[s.rank] || null;

    const typePills = Object.entries(s.by_type || {})
      .sort((a, b) => b[1] - a[1])
      .map(([type, cnt]) => {
        const label = type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        return `<span style="font-size:.6rem;background:#EBF3FF;color:#3B72B9;padding:.15rem .45rem;border-radius:9999px;white-space:nowrap;">${label} ×${cnt}</span>`;
      }).join("");

    // Top 3: show medal emoji as the rank indicator; others: plain numbered circle
    const rankCell = medal
      ? `<div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:1.3rem;line-height:1;">${medal}</div>`
      : `<div style="width:32px;height:32px;border-radius:50%;background:#F1F5F9;border:1.5px solid #E2E8F0;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:800;color:#475569;">${s.rank}</div>`;

    return `
      <div class="lb-row" style="display:flex;align-items:center;gap:1rem;padding:.75rem 1.25rem;background:${isEven ? "#fff" : "#F8FAFC"};border-bottom:1px solid #E2E8F0;">
        <!-- Rank / medal + movement arrow -->
        <div style="display:flex;flex-direction:column;align-items:center;gap:.15rem;flex-shrink:0;width:32px;">
          ${rankCell}
          ${arrow}
        </div>
        <!-- Avatar -->
        <div style="width:40px;height:40px;border-radius:50%;background:${ringClr ? "#1e293b" : "#F1F5F9"};border:2px solid ${ringClr || "#E2E8F0"};display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:800;color:${ringClr || "#94A3B8"};flex-shrink:0;">
          ${ini}
        </div>
        <!-- Name + progress bar + content type pills -->
        <div style="flex:1;min-width:0;">
          <div style="font-size:.95rem;font-weight:700;color:#0F172A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.stylist_name)}</div>
          <div style="margin-top:.3rem;height:5px;background:#E2E8F0;border-radius:9999px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${ringClr ? `linear-gradient(90deg,${ringClr},${ringClr}99)` : "linear-gradient(90deg,#3B72B9,#60A5FA)"};border-radius:9999px;transition:width .6s ease;"></div>
          </div>
          ${typePills ? `<div style="display:flex;flex-wrap:wrap;gap:.25rem;margin-top:.35rem;">${typePills}</div>` : ""}
        </div>
        <!-- Streak -->
        <div style="width:80px;text-align:center;flex-shrink:0;">
          ${s.streak > 1
            ? `<span style="font-size:.75rem;font-weight:700;color:#F59E0B;">🔥 ${s.streak}wk</span>`
            : `<span style="font-size:.75rem;color:#CBD5E1;">—</span>`}
        </div>
        <!-- Posts -->
        <div style="width:60px;text-align:right;font-size:.8rem;color:#64748B;flex-shrink:0;">${s.post_count} post${s.post_count !== 1 ? "s" : ""}</div>
        <!-- Points -->
        <div style="width:80px;text-align:right;flex-shrink:0;">
          <span style="font-size:1.1rem;font-weight:900;color:${ringClr || "#3B72B9"};">${s.points}</span>
          <span style="font-size:.65rem;color:#94A3B8;"> pts</span>
        </div>
      </div>`;
  }).join("");

  // ── Empty state ───────────────────────────────────────────────────────────
  const emptyState = !leaderboard.length ? `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;color:rgba(255,255,255,0.3);padding:4rem;">
      <div style="font-size:4rem;">📸</div>
      <p style="font-size:1.5rem;font-weight:800;color:rgba(255,255,255,0.5);">No posts yet this month</p>
      <p style="font-size:1rem;">Text a photo to get on the board!</p>
    </div>` : "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(salon.name)} — Leaderboard</title>
  <meta http-equiv="refresh" content="60" />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', ui-sans-serif, sans-serif;
      background: #F8FAFC;
      color: #0F172A;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    @keyframes pulse-slow { 0%,100%{opacity:1} 50%{opacity:.55} }
    .pulse-slow { animation: pulse-slow 2.2s ease-in-out infinite; }
    @keyframes shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position: 400px 0; }
    }
    .shimmer {
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%);
      background-size: 400px 100%;
      animation: shimmer 3s infinite;
    }
    /* Mobile: single-column stacked layout */
    @media (max-width: 768px) {
      body { overflow: auto; height: auto; }
      .lb-main { flex-direction: column !important; overflow: visible !important; }
      .lb-hero {
        width: 100% !important;
        min-height: 320px !important;
        overflow: visible !important;
        flex-shrink: 0 !important;
        padding: 1rem 1rem 1rem !important;
      }
      .lb-podium { flex: none !important; }
      .lb-list {
        flex: none !important;
        overflow: visible !important;
        border-left: none !important;
        border-top: 2px solid #E2E8F0 !important;
        background: #F8FAFC !important;
      }
      .lb-list-header { display: none !important; }
      .lb-footer { display: none !important; }
      .lb-header { padding: 0.75rem 1rem !important; }
    }
  </style>
</head>
<body>

  <!-- ── Header ─────────────────────────────────────────────────────────── -->
  <header class="lb-header" style="
    background: #ffffff;
    border-bottom: 1px solid #E2E8F0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 2rem;
    flex-shrink: 0;
  ">
    <div style="display:flex;align-items:center;gap:1rem;">
      ${logoHtml}
      <div style="width:1px;height:2rem;background:#E2E8F0"></div>
      <div>
        <p style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#3B72B9">Team Leaderboard</p>
        <p style="font-size:.9rem;font-weight:700;color:#3B72B9">This Month</p>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:1.25rem;">
      ${bonusBanner}
      <div style="text-align:right;">
        <p style="font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:#3B72B9">Powered by</p>
        <p style="font-size:.8rem;font-weight:800;color:#3B72B9">MostlyPostly</p>
      </div>
    </div>
  </header>

  <!-- ── Main ───────────────────────────────────────────────────────────── -->
  <main class="lb-main" style="flex:1;display:flex;overflow:hidden;">

    <!-- Left: dark hero with podium (always 45%) -->
    <div class="lb-hero" style="
      width: 45%;
      background: linear-gradient(175deg, #0F172A 0%, #1a2744 60%, #0d1f3c 100%);
      display: flex;
      flex-direction: column;
      padding: 1.5rem 2rem 0;
      position: relative;
      overflow: hidden;
      flex-shrink: 0;
    ">
      <!-- Subtle texture shimmer -->
      <div class="shimmer" style="position:absolute;inset:0;pointer-events:none;"></div>

      ${emptyState}

      ${top3.length ? `
      <!-- Section label -->
      <p style="font-size:.65rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,0.3);text-align:center;margin-bottom:.5rem;position:relative;">
        Top Performers
      </p>

      <!-- Podium -->
      <div class="lb-podium" style="display:flex;align-items:flex-end;justify-content:center;gap:1rem;flex:1;position:relative;">
        ${podiumCards}
      </div>` : ""}
    </div>

    <!-- Right: full ranked list — always visible -->
    <div class="lb-list" style="flex:1;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid #E2E8F0;">
      <!-- List header -->
      <div class="lb-list-header" style="display:flex;align-items:center;gap:1rem;padding:.625rem 1.25rem;background:#F1F5F9;border-bottom:2px solid #E2E8F0;flex-shrink:0;">
        <div style="width:32px;"></div>
        <div style="width:40px;"></div>
        <div style="flex:1;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8;">Stylist</div>
        <div style="width:80px;text-align:center;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8;">Streak</div>
        <div style="width:60px;text-align:right;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8;">Posts</div>
        <div style="width:80px;text-align:right;font-size:.65rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8;">Points</div>
      </div>
      <!-- All stylists rows -->
      <div style="flex:1;overflow-y:auto;">
        ${allRowsHtml || `<div style="padding:3rem;text-align:center;color:#94A3B8;font-size:.9rem;">No posts yet this month</div>`}
      </div>
    </div>

  </main>

  <!-- ── Footer ─────────────────────────────────────────────────────────── -->
  <footer class="lb-footer" style="
    background: #fff;
    border-top: 1px solid #E2E8F0;
    padding: .625rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  ">
    <p style="font-size:.7rem;color:#94A3B8;">Auto-refreshes every 60 seconds</p>
    <p style="font-size:.7rem;color:#94A3B8;">Points based on published posts &nbsp;·&nbsp; 🔥 = consecutive weeks with a post</p>
  </footer>

</body>
</html>`);
});

export default router;
