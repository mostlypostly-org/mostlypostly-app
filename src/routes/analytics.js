// src/routes/analytics.js — Social performance analytics dashboard
import express from "express";
import { db } from "../../db.js";
import { DateTime } from "luxon";
import { getSalonPolicy } from "../scheduler.js";
import { getAllSalons, getSalonName } from "../core/salonLookup.js";
import { syncSalonInsights } from "../core/fetchInsights.js";

const router = express.Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function navBar(current = "analytics", salon_id = "") {
  const qs = salon_id ? `?salon=${encodeURIComponent(salon_id)}` : "";
  const link = (href, label, key) =>
    `<a href="${href}" class="${
      current === key
        ? "text-mpCharcoal border-b-2 border-mpAccent font-semibold"
        : "text-mpMuted hover:text-mpCharcoal"
    } transition px-1 pb-1">${label}</a>`;
  return `
<header class="border-b border-mpBorder bg-white/90 backdrop-blur sticky top-0 z-30">
  <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
    <div class="flex items-center justify-between py-3">
      <a href="/manager${qs}" aria-label="MostlyPostly manager home">
        <img src="/public/logo/logo.png" alt="MostlyPostly" class="w-40 h-auto" />
      </a>
      <nav class="hidden items-center gap-8 text-sm font-medium md:flex">
        ${link(`/manager${qs}`, "Dashboard", "manager")}
        ${link(`/dashboard${qs}`, "Database", "database")}
        ${link(`/analytics${qs}`, "Analytics", "analytics")}
        ${link(`/manager/admin${qs}`, "Admin", "admin")}
        ${link(`/manager/logout${qs}`, "Logout", "logout")}
      </nav>
    </div>
  </div>
</header>`;
}

function pageShell({ title, body, salon_id = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
          colors: {
            mpCharcoal: "#2B2D35", mpCharcoalDark: "#1a1c22",
            mpAccent: "#D4897A", mpAccentLight: "#F2DDD9",
            mpBg: "#FDF8F6", mpCard: "#FFFFFF",
            mpBorder: "#EDE7E4", mpMuted: "#7A7C85",
          }
        }
      }
    };
  </script>
  <style>body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; }</style>
</head>
<body class="bg-mpBg text-mpCharcoal antialiased">
  ${navBar("analytics", salon_id)}
  <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    ${body}
  </main>
</body>
</html>`;
}

function resolveSalonId(req) {
  const fromToken = req.manager?.salon_id || req.salon_id || null;
  const fromQuery = req.query.salon || req.query.salon_id || null;
  if (fromToken) return fromToken;
  if (fromQuery) return fromQuery;
  try {
    const all = getAllSalons();
    const ids = Object.keys(all || {});
    if (ids.length === 1) return ids[0];
  } catch {}
  return null;
}

function fmt(n) {
  if (n === null || n === undefined) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

function pct(n) {
  if (!n || n === 0) return "—";
  return Number(n).toFixed(1) + "%";
}

function statCard(label, value, sub) {
  return `
  <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
    <p class="text-xs font-bold uppercase tracking-widest text-mpMuted">${label}</p>
    <p class="mt-2 text-3xl font-extrabold text-mpCharcoal">${value}</p>
    ${sub ? `<p class="mt-1 text-xs text-mpMuted">${sub}</p>` : ""}
  </div>`;
}

function postTypeLabel(t) {
  return { standard: "Standard", before_after: "Before & After", availability: "Availability", promotion: "Promotion" }[t] || t || "Standard";
}

// ─── GET /analytics ───────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const salon_id = resolveSalonId(req);
  const qs = salon_id ? `?salon=${encodeURIComponent(salon_id)}` : "";

  if (!salon_id) {
    return res.status(400).send(pageShell({
      title: "Missing salon",
      salon_id: "",
      body: `<div class="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
        No salon context detected. Add <code>?salon=&lt;id&gt;</code> to the URL.
      </div>`,
    }));
  }

  const salonName = getSalonName(salon_id);
  const salonPolicy = getSalonPolicy(salon_id) || {};
  const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";

  // Volume
  const totalPublished = db.prepare(`SELECT COUNT(*) as c FROM posts WHERE salon_id=? AND status='published'`).get(salon_id).c;
  const thisMonth = db.prepare(`
    SELECT COUNT(*) as c FROM posts
    WHERE salon_id=? AND status='published'
      AND strftime('%Y-%m', published_at) = strftime('%Y-%m', 'now')
  `).get(salon_id).c;

  // Insight aggregates
  const igAgg = db.prepare(`
    SELECT SUM(impressions) as impressions, SUM(reach) as reach,
           SUM(likes) as likes, SUM(comments) as comments, SUM(saves) as saves,
           SUM(engaged_users) as engaged, AVG(engagement_rate) as avg_er, COUNT(*) as post_count
    FROM post_insights pi JOIN posts p ON p.id=pi.post_id
    WHERE p.salon_id=? AND pi.platform='instagram'
  `).get(salon_id);

  const fbAgg = db.prepare(`
    SELECT SUM(impressions) as impressions, SUM(reach) as reach,
           SUM(reactions) as reactions, SUM(link_clicks) as link_clicks,
           SUM(engaged_users) as engaged, AVG(engagement_rate) as avg_er, COUNT(*) as post_count
    FROM post_insights pi JOIN posts p ON p.id=pi.post_id
    WHERE p.salon_id=? AND pi.platform='facebook'
  `).get(salon_id);

  const totalReach       = (igAgg?.reach || 0) + (fbAgg?.reach || 0);
  const totalImpressions = (igAgg?.impressions || 0) + (fbAgg?.impressions || 0);
  const totalEngaged     = (igAgg?.engaged || 0) + (fbAgg?.engaged || 0);
  const combinedER       = totalReach > 0 ? (totalEngaged / totalReach) * 100 : 0;
  const totalLinkClicks  = fbAgg?.link_clicks || 0;
  const hasInsights      = (igAgg?.post_count || 0) + (fbAgg?.post_count || 0) > 0;

  // Top posts by engagement
  const topPosts = db.prepare(`
    SELECT p.id, p.final_caption, p.post_type, p.stylist_name, p.published_at, p.image_url,
           MAX(pi.engagement_rate) as top_er,
           MAX(CASE WHEN pi.platform='instagram' THEN pi.likes    ELSE 0 END) as ig_likes,
           MAX(CASE WHEN pi.platform='instagram' THEN pi.comments ELSE 0 END) as ig_comments,
           MAX(CASE WHEN pi.platform='instagram' THEN pi.saves    ELSE 0 END) as ig_saves,
           MAX(CASE WHEN pi.platform='instagram' THEN pi.reach    ELSE 0 END) as ig_reach,
           MAX(CASE WHEN pi.platform='facebook'  THEN pi.reactions   ELSE 0 END) as fb_reactions,
           MAX(CASE WHEN pi.platform='facebook'  THEN pi.link_clicks ELSE 0 END) as fb_clicks,
           MAX(CASE WHEN pi.platform='facebook'  THEN pi.reach       ELSE 0 END) as fb_reach
    FROM posts p JOIN post_insights pi ON pi.post_id=p.id
    WHERE p.salon_id=?
    GROUP BY p.id ORDER BY top_er DESC LIMIT 6
  `).all(salon_id);

  // Engagement by post type
  const byType = db.prepare(`
    SELECT p.post_type, COUNT(DISTINCT p.id) as count,
           AVG(pi.engagement_rate) as avg_er, SUM(pi.reach) as total_reach
    FROM posts p JOIN post_insights pi ON pi.post_id=p.id
    WHERE p.salon_id=? GROUP BY p.post_type ORDER BY avg_er DESC
  `).all(salon_id);

  // Recent published posts
  const recent = db.prepare(`
    SELECT p.id, p.stylist_name, p.post_type, p.published_at, p.fb_post_id, p.ig_media_id,
           pi_ig.engagement_rate as ig_er, pi_ig.likes as ig_likes, pi_ig.reach as ig_reach,
           pi_ig.saves as ig_saves, pi_fb.reactions as fb_reactions,
           pi_fb.link_clicks as fb_clicks, pi_fb.reach as fb_reach
    FROM posts p
    LEFT JOIN post_insights pi_ig ON pi_ig.post_id=p.id AND pi_ig.platform='instagram'
    LEFT JOIN post_insights pi_fb ON pi_fb.post_id=p.id AND pi_fb.platform='facebook'
    WHERE p.salon_id=? AND p.status='published'
    ORDER BY datetime(p.published_at) DESC LIMIT 20
  `).all(salon_id);

  // ── HTML ──────────────────────────────────────────────────────────

  const syncBanner = !hasInsights ? `
    <div class="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 rounded-2xl border border-mpBorder bg-mpAccentLight px-5 py-4">
      <div>
        <p class="text-sm font-bold text-mpCharcoal">No social insights synced yet</p>
        <p class="text-xs text-mpMuted mt-0.5">Click Sync to pull likes, reach, saves, and engagement from Facebook &amp; Instagram.</p>
      </div>
      <button onclick="runSync()" class="shrink-0 rounded-full bg-mpCharcoal px-5 py-2.5 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">Sync Now</button>
    </div>` : "";

  const summaryCards = `
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
    ${statCard("Published Posts", fmt(totalPublished), `${thisMonth} this month`)}
    ${statCard("Total Reach", fmt(totalReach), "FB + Instagram")}
    ${statCard("Total Impressions", fmt(totalImpressions), "FB + Instagram")}
    ${statCard("Combined Eng. Rate", pct(combinedER), "Engaged / reach")}
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
    ${statCard("IG Likes", fmt(igAgg?.likes || 0), "All time")}
    ${statCard("IG Comments", fmt(igAgg?.comments || 0), "All time")}
    ${statCard("IG Saves", fmt(igAgg?.saves || 0), "All time")}
    ${statCard("Book Now Clicks", fmt(totalLinkClicks), "Link clicks from FB posts")}
  </div>`;

  const platformSplit = `
  <div class="grid gap-4 sm:grid-cols-2 mb-8">
    <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
      <div class="flex items-center gap-2 mb-4">
        <div class="h-8 w-8 rounded-lg bg-gradient-to-br from-purple-500 to-pink-400 flex items-center justify-center text-white text-xs font-bold">IG</div>
        <h3 class="font-bold text-mpCharcoal">Instagram</h3>
        <span class="ml-auto text-xs text-mpMuted">${igAgg?.post_count || 0} posts synced</span>
      </div>
      <div class="grid grid-cols-3 gap-3 text-center">
        <div><p class="text-xl font-extrabold text-mpCharcoal">${fmt(igAgg?.reach || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Reach</p></div>
        <div><p class="text-xl font-extrabold text-mpCharcoal">${fmt(igAgg?.likes || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Likes</p></div>
        <div><p class="text-xl font-extrabold text-mpAccent">${pct(igAgg?.avg_er || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Eng. Rate</p></div>
      </div>
    </div>
    <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
      <div class="flex items-center gap-2 mb-4">
        <div class="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center text-white text-xs font-bold">FB</div>
        <h3 class="font-bold text-mpCharcoal">Facebook</h3>
        <span class="ml-auto text-xs text-mpMuted">${fbAgg?.post_count || 0} posts synced</span>
      </div>
      <div class="grid grid-cols-3 gap-3 text-center">
        <div><p class="text-xl font-extrabold text-mpCharcoal">${fmt(fbAgg?.reach || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Reach</p></div>
        <div><p class="text-xl font-extrabold text-mpCharcoal">${fmt(fbAgg?.reactions || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Reactions</p></div>
        <div><p class="text-xl font-extrabold text-mpAccent">${pct(fbAgg?.avg_er || 0)}</p><p class="text-[10px] uppercase tracking-wide text-mpMuted mt-0.5">Eng. Rate</p></div>
      </div>
    </div>
  </div>`;

  const topPostsHtml = topPosts.length > 0 ? `
  <div class="mb-8">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-base font-bold text-mpCharcoal">Top Performing Posts</h2>
      <span class="text-xs text-mpMuted">By engagement rate</span>
    </div>
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      ${topPosts.map((p, i) => {
        const caption = (p.final_caption || "").slice(0, 90) + (p.final_caption?.length > 90 ? "…" : "");
        const pubDate = p.published_at ? DateTime.fromSQL(p.published_at, { zone: "utc" }).setZone(tz).toFormat("MMM d") : "—";
        const medals = ["🥇","🥈","🥉"];
        return `
        <div class="rounded-2xl border border-mpBorder bg-white p-4 shadow-sm flex flex-col gap-3">
          ${p.image_url
            ? `<img src="${p.image_url}" alt="" class="w-full h-36 object-cover rounded-xl" />`
            : `<div class="w-full h-36 rounded-xl bg-mpBg flex items-center justify-center text-mpMuted text-xs">No image</div>`}
          <div>
            <div class="flex items-center gap-2 mb-1">
              ${medals[i] ? `<span>${medals[i]}</span>` : ""}
              <span class="rounded-full bg-mpAccentLight px-2 py-0.5 text-[10px] font-bold text-mpAccent uppercase">${postTypeLabel(p.post_type)}</span>
              <span class="ml-auto text-[10px] text-mpMuted">${pubDate}</span>
            </div>
            <p class="text-xs text-mpMuted leading-relaxed line-clamp-2">${caption}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center border-t border-mpBorder pt-3">
            <div><p class="text-sm font-bold text-mpCharcoal">${fmt((p.ig_reach || 0) + (p.fb_reach || 0))}</p><p class="text-[10px] text-mpMuted">Reach</p></div>
            <div><p class="text-sm font-bold text-mpCharcoal">${fmt((p.ig_likes || 0) + (p.fb_reactions || 0))}</p><p class="text-[10px] text-mpMuted">Likes</p></div>
            <div><p class="text-sm font-bold text-mpAccent">${pct(p.top_er)}</p><p class="text-[10px] text-mpMuted">Eng. %</p></div>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>` : "";

  const byTypeHtml = byType.length > 0 ? `
  <div class="mb-8 rounded-2xl border border-mpBorder bg-white shadow-sm overflow-hidden">
    <div class="px-5 py-4 border-b border-mpBorder">
      <h2 class="text-base font-bold text-mpCharcoal">Engagement by Content Type</h2>
      <p class="text-xs text-mpMuted mt-0.5">Which types of posts resonate most with your audience.</p>
    </div>
    <table class="w-full text-sm">
      <thead class="bg-mpBg text-xs uppercase tracking-wide text-mpMuted">
        <tr>
          <th class="px-5 py-3 text-left">Content Type</th>
          <th class="px-5 py-3 text-right">Posts</th>
          <th class="px-5 py-3 text-right">Total Reach</th>
          <th class="px-5 py-3 text-right">Avg Eng. Rate</th>
        </tr>
      </thead>
      <tbody>
        ${byType.map(row => `
        <tr class="border-t border-mpBorder hover:bg-mpBg/60">
          <td class="px-5 py-3 font-medium text-mpCharcoal">${postTypeLabel(row.post_type)}</td>
          <td class="px-5 py-3 text-right text-mpMuted">${row.count}</td>
          <td class="px-5 py-3 text-right text-mpMuted">${fmt(row.total_reach)}</td>
          <td class="px-5 py-3 text-right font-semibold text-mpAccent">${pct(row.avg_er)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : "";

  const recentTable = `
  <div class="rounded-2xl border border-mpBorder bg-white shadow-sm overflow-hidden">
    <div class="flex items-center justify-between px-5 py-4 border-b border-mpBorder">
      <div>
        <h2 class="text-base font-bold text-mpCharcoal">Recent Published Posts</h2>
        <p class="text-xs text-mpMuted mt-0.5">Last 20 posts with performance data.</p>
      </div>
      <button onclick="runSync()" id="syncBtn" class="rounded-full border border-mpBorder bg-mpBg px-4 py-1.5 text-xs font-semibold text-mpCharcoal hover:border-mpAccent hover:bg-white transition-colors">
        Sync Insights
      </button>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-mpBg text-xs uppercase tracking-wide text-mpMuted">
          <tr>
            <th class="px-4 py-3 text-left">Stylist</th>
            <th class="px-4 py-3 text-left">Type</th>
            <th class="px-4 py-3 text-center">Platforms</th>
            <th class="px-4 py-3 text-right">Reach</th>
            <th class="px-4 py-3 text-right">Likes</th>
            <th class="px-4 py-3 text-right">Saves</th>
            <th class="px-4 py-3 text-right">Eng. %</th>
            <th class="px-4 py-3 text-right">Link Clicks</th>
            <th class="px-4 py-3 text-left">Published</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map(p => {
            const pubDate = p.published_at ? DateTime.fromSQL(p.published_at, { zone: "utc" }).setZone(tz).toFormat("MMM d, h:mm a") : "—";
            const platforms = [
              p.ig_media_id ? `<span class="text-[10px] rounded-full bg-gradient-to-br from-purple-500 to-pink-400 text-white px-2 py-0.5 font-bold">IG</span>` : "",
              p.fb_post_id  ? `<span class="text-[10px] rounded-full bg-blue-600 text-white px-2 py-0.5 font-bold">FB</span>` : "",
            ].filter(Boolean).join(" ");
            return `
            <tr class="border-t border-mpBorder hover:bg-mpBg/60">
              <td class="px-4 py-3 font-medium text-mpCharcoal">${p.stylist_name || "?"}</td>
              <td class="px-4 py-3 text-xs text-mpMuted">${postTypeLabel(p.post_type)}</td>
              <td class="px-4 py-3 text-center">${platforms || "<span class='text-mpMuted text-xs'>—</span>"}</td>
              <td class="px-4 py-3 text-right text-mpMuted">${fmt((p.ig_reach || 0) + (p.fb_reach || 0))}</td>
              <td class="px-4 py-3 text-right text-mpMuted">${fmt(p.ig_likes || 0)}</td>
              <td class="px-4 py-3 text-right text-mpMuted">${fmt(p.ig_saves || 0)}</td>
              <td class="px-4 py-3 text-right font-semibold ${p.ig_er ? "text-mpAccent" : "text-mpMuted"}">${pct(p.ig_er)}</td>
              <td class="px-4 py-3 text-right text-mpMuted">${fmt(p.fb_clicks || 0)}</td>
              <td class="px-4 py-3 text-xs text-mpMuted">${pubDate}</td>
            </tr>`;
          }).join("") || `<tr><td colspan="9" class="px-4 py-8 text-center text-mpMuted text-sm">No published posts yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;

  const syncScript = `
  <div id="sync-toast" class="fixed bottom-6 right-6 hidden z-50">
    <div class="rounded-2xl bg-mpCharcoal text-white px-5 py-3 text-sm font-medium shadow-xl"></div>
  </div>
  <script>
    async function runBackfill() {
      const toast = document.getElementById('sync-toast');
      const msg = toast.querySelector('div');
      toast.classList.remove('hidden');
      msg.textContent = 'Backfilling FB post IDs...';
      try {
        const res = await fetch('/analytics/backfill-fb-ids${qs}', { method: 'POST' });
        const data = await res.json();
        msg.textContent = res.ok
          ? 'Matched ' + data.matched + ' of ' + data.scanned + ' posts to FB IDs.'
          : 'Error: ' + (data.error || 'unknown');
        setTimeout(() => {
          toast.classList.add('hidden');
          if (res.ok && data.matched > 0) location.reload();
        }, 3000);
      } catch(e) {
        msg.textContent = 'Backfill failed: ' + e.message;
        setTimeout(() => toast.classList.add('hidden'), 3000);
      }
    }
    async function runResetBackfill() {
      if (!confirm('This will clear all stored FB post IDs and re-match from the live Facebook page. Continue?')) return;
      const toast = document.getElementById('sync-toast');
      const msg = toast.querySelector('div');
      toast.classList.remove('hidden');
      msg.textContent = 'Resetting & relinking FB post IDs...';
      try {
        const res = await fetch('/analytics/reset-and-backfill-fb-ids${qs}', { method: 'POST' });
        const data = await res.json();
        msg.textContent = res.ok
          ? 'Cleared ' + data.cleared + ' IDs, fetched ' + data.fb_posts_fetched + ' FB posts, matched ' + data.matched + '.'
          : 'Error: ' + (data.error || 'unknown');
        setTimeout(() => { toast.classList.add('hidden'); if (res.ok) location.reload(); }, 4000);
      } catch(e) {
        msg.textContent = 'Reset failed: ' + e.message;
        setTimeout(() => toast.classList.add('hidden'), 3000);
      }
    }
    async function runSync() {
      const btn = document.getElementById('syncBtn');
      const toast = document.getElementById('sync-toast');
      const msg = toast.querySelector('div');
      if (btn) { btn.textContent = 'Syncing...'; btn.disabled = true; }
      try {
        const res = await fetch('/analytics/sync${qs}', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = 'Error: ' + (data.error || 'unknown');
        } else if (data.errors && data.errors.length) {
          msg.textContent = 'Synced ' + data.synced + ' records. ' + data.errors.length + ' error(s): ' + data.errors[0];
        } else {
          msg.textContent = 'Synced ' + data.synced + ' insight records.';
        }
        toast.classList.remove('hidden');
        setTimeout(() => { toast.classList.add('hidden'); if (res.ok && data.synced > 0) location.reload(); }, 4000);
      } catch(e) {
        msg.textContent = 'Sync failed: ' + e.message;
        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3000);
      } finally {
        if (btn) { btn.textContent = 'Sync Insights'; btn.disabled = false; }
      }
    }
  </script>`;

  const body = `
    <div class="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div>
        <h1 class="text-2xl font-extrabold text-mpCharcoal">Analytics — <span class="text-mpAccent">${salonName}</span></h1>
        <p class="mt-1 text-sm text-mpMuted">Social performance across Facebook and Instagram.</p>
      </div>
      <div class="flex gap-2">
        <button onclick="runResetBackfill()" class="shrink-0 rounded-full border border-mpBorder bg-white px-4 py-2.5 text-sm font-semibold text-mpCharcoal hover:border-mpAccent transition-colors">
          Reset &amp; Relink FB
        </button>
        <button onclick="runSync()" class="shrink-0 rounded-full bg-mpCharcoal px-5 py-2.5 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Sync Insights
        </button>
      </div>
    </div>
    ${syncBanner}
    ${summaryCards}
    ${platformSplit}
    ${topPostsHtml}
    ${byTypeHtml}
    ${recentTable}
    ${syncScript}
  `;

  res.send(pageShell({ title: `Analytics — ${salonName}`, body, salon_id }));
});

// ─── POST /analytics/reset-and-backfill-fb-ids ───────────────────────────────
// Clears all existing fb_post_id values then re-matches from the live FB page
// timeline. Use this when stored IDs are stale (e.g. after re-authenticating).

router.post("/reset-and-backfill-fb-ids", async (req, res) => {
  const salon_id = resolveSalonId(req);
  if (!salon_id) return res.status(400).json({ error: "No salon context" });

  const salonRow = db.prepare(
    `SELECT facebook_page_id, facebook_page_token FROM salons WHERE slug=?`
  ).get(salon_id);

  if (!salonRow?.facebook_page_id || !salonRow?.facebook_page_token) {
    return res.status(400).json({ error: "Salon missing Facebook credentials" });
  }

  const { facebook_page_id: pageId, facebook_page_token: token } = salonRow;

  // Clear all existing fb_post_id values for this salon
  const cleared = db.prepare(
    `UPDATE posts SET fb_post_id=NULL WHERE salon_id=? AND status='published'`
  ).run(salon_id).changes;

  // Fetch FB page posts (paginate up to 200)
  const fbPosts = [];
  let fbUrl = `https://graph.facebook.com/v22.0/${pageId}/feed?fields=id,created_time&limit=100&access_token=${token}`;
  while (fbUrl && fbPosts.length < 200) {
    const fbRes = await fetch(fbUrl);
    const fbJson = await fbRes.json();
    if (!fbRes.ok || fbJson.error) {
      return res.status(502).json({ error: fbJson?.error?.message || "FB API error" });
    }
    fbPosts.push(...(fbJson.data || []));
    fbUrl = fbJson.paging?.next || null;
  }

  // Match DB posts to FB posts by timestamp (±5 min window)
  const dbPosts = db.prepare(`
    SELECT id, published_at FROM posts
    WHERE salon_id=? AND status='published'
    ORDER BY datetime(published_at) DESC LIMIT 200
  `).all(salon_id);

  let matched = 0;
  for (const dbPost of dbPosts) {
    if (!dbPost.published_at) continue;
    const dbTime = new Date(dbPost.published_at + "Z").getTime();
    const fbMatch = fbPosts.find(fp => Math.abs(new Date(fp.created_time).getTime() - dbTime) < 5 * 60 * 1000);
    if (fbMatch) {
      db.prepare(`UPDATE posts SET fb_post_id=? WHERE id=?`).run(fbMatch.id, dbPost.id);
      matched++;
    }
  }

  res.json({ cleared, fb_posts_fetched: fbPosts.length, db_posts_scanned: dbPosts.length, matched });
});

// ─── POST /analytics/backfill-fb-ids ─────────────────────────────────────────
// Fetches the page's recent posts from FB Graph API and matches them to DB rows
// that are missing fb_post_id, using published_at timestamp proximity.

router.post("/backfill-fb-ids", async (req, res) => {
  const salon_id = resolveSalonId(req);
  if (!salon_id) return res.status(400).json({ error: "No salon context" });

  const salonRow = db.prepare(
    `SELECT facebook_page_id, facebook_page_token FROM salons WHERE slug=?`
  ).get(salon_id);

  if (!salonRow?.facebook_page_id || !salonRow?.facebook_page_token) {
    return res.status(400).json({ error: "Salon missing Facebook credentials" });
  }

  const { facebook_page_id: pageId, facebook_page_token: token } = salonRow;

  // Fetch last 100 posts from the FB page feed (feed includes photo posts)
  const fbUrl = `https://graph.facebook.com/v22.0/${pageId}/feed?fields=id,created_time&limit=100&access_token=${token}`;
  const fbRes = await fetch(fbUrl);
  const fbJson = await fbRes.json();

  if (!fbRes.ok || fbJson.error) {
    return res.status(502).json({ error: fbJson?.error?.message || "FB API error" });
  }

  const fbPosts = fbJson.data || [];

  // Get our DB posts that are published but missing fb_post_id
  const dbPosts = db.prepare(`
    SELECT id, published_at FROM posts
    WHERE salon_id=? AND status='published' AND (fb_post_id IS NULL OR fb_post_id='')
    ORDER BY datetime(published_at) DESC LIMIT 200
  `).all(salon_id);

  let matched = 0;
  for (const dbPost of dbPosts) {
    if (!dbPost.published_at) continue;
    const dbTime = new Date(dbPost.published_at + "Z").getTime();
    const fbMatch = fbPosts.find(fp => Math.abs(new Date(fp.created_time).getTime() - dbTime) < 5 * 60 * 1000);
    if (fbMatch) {
      db.prepare(`UPDATE posts SET fb_post_id=? WHERE id=?`).run(fbMatch.id, dbPost.id);
      matched++;
    }
  }

  res.json({ scanned: dbPosts.length, fb_posts_fetched: fbPosts.length, matched });
});

// ─── POST /analytics/sync ─────────────────────────────────────────────────────

router.post("/sync", async (req, res) => {
  const salon_id = resolveSalonId(req);
  if (!salon_id) return res.status(400).json({ error: "No salon context" });

  const salonRow = db.prepare(
    `SELECT facebook_page_token, facebook_page_id, instagram_business_id FROM salons WHERE slug=?`
  ).get(salon_id);

  const salon = {
    slug: salon_id,
    facebook_page_token: salonRow?.facebook_page_token || process.env.FACEBOOK_PAGE_TOKEN,
    facebook_page_id:    salonRow?.facebook_page_id,
    instagram_business_id: salonRow?.instagram_business_id,
  };

  if (!salon.facebook_page_token) {
    return res.status(400).json({ error: "No Facebook page token found. Reconnect Facebook in Admin." });
  }

  try {
    const result = await syncSalonInsights(salon);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /analytics/debug ─────────────────────────────────────────────────────
// Diagnostic endpoint: tests the Facebook page token and IG account access.

router.get("/debug", async (req, res) => {
  const salon_id = resolveSalonId(req);
  if (!salon_id) return res.status(400).json({ error: "No salon context" });

  const salonRow = db.prepare(
    `SELECT facebook_page_id, facebook_page_token, instagram_business_id, instagram_handle FROM salons WHERE slug=?`
  ).get(salon_id);

  if (!salonRow?.facebook_page_token) {
    return res.json({ error: "No Facebook page token stored. Reconnect Facebook in Admin." });
  }

  const { facebook_page_id: pageId, facebook_page_token: token, instagram_business_id: igId } = salonRow;
  const GRAPH = "https://graph.facebook.com/v22.0";
  const report = { salon_id, pageId, igId, checks: [] };

  // 1. Test page token validity
  try {
    const r = await fetch(`${GRAPH}/${pageId}?fields=name,id&access_token=${token}`);
    const j = await r.json();
    report.checks.push({ test: "FB page token", ok: !j.error, detail: j.error?.message || `Page: ${j.name} (${j.id})` });
  } catch (e) {
    report.checks.push({ test: "FB page token", ok: false, detail: e.message });
  }

  // 2. Test FB page insights permission (page_fans = follower count, reliable read_insights check)
  try {
    const r = await fetch(`${GRAPH}/${pageId}/insights?metric=page_fans&period=lifetime&access_token=${token}`);
    const j = await r.json();
    report.checks.push({ test: "FB page insights", ok: !j.error, detail: j.error?.message || `${(j.data||[]).length} metric rows returned` });
  } catch (e) {
    report.checks.push({ test: "FB page insights", ok: false, detail: e.message });
  }

  // 3. Test IG business account access
  if (igId) {
    try {
      const r = await fetch(`${GRAPH}/${igId}?fields=id,username,followers_count&access_token=${token}`);
      const j = await r.json();
      report.checks.push({ test: "IG account", ok: !j.error, detail: j.error?.message || `@${j.username} (${j.followers_count} followers)` });
    } catch (e) {
      report.checks.push({ test: "IG account", ok: false, detail: e.message });
    }

    // 4. Test IG media list
    try {
      const r = await fetch(`${GRAPH}/${igId}/media?fields=id,timestamp,media_type&limit=3&access_token=${token}`);
      const j = await r.json();
      report.checks.push({ test: "IG media list", ok: !j.error, detail: j.error?.message || `${(j.data||[]).length} recent media items` });
      if (!j.error && j.data?.length) {
        // 5. Test insights on the most recent IG post
        const mediaId = j.data[0].id;
        const mediaType = (j.data[0].media_type || "IMAGE").toUpperCase();
        const metrics = (mediaType === "VIDEO" || mediaType === "REEL")
          ? "reach,plays,saved,total_interactions"
          : "reach,saved,total_interactions";
        const ir = await fetch(`${GRAPH}/${mediaId}/insights?metric=${metrics}&access_token=${token}`);
        const ij = await ir.json();
        report.checks.push({ test: `IG post insights (${mediaId}, ${mediaType})`, ok: !ij.error, detail: ij.error?.message || `${(ij.data||[]).length} metrics returned` });
      }
    } catch (e) {
      report.checks.push({ test: "IG media list", ok: false, detail: e.message });
    }
  } else {
    report.checks.push({ test: "IG account", ok: false, detail: "No instagram_business_id in DB — reconnect Facebook in Admin" });
  }

  // 6. Test FB post insights on an actual stored fb_post_id
  const sampleFbPost = db.prepare(
    `SELECT fb_post_id FROM posts WHERE salon_id=? AND fb_post_id IS NOT NULL AND fb_post_id != '' LIMIT 1`
  ).get(salon_id);
  if (sampleFbPost) {
    const pid = sampleFbPost.fb_post_id;
    try {
      // Resolve photo ID to post ID if needed
      let resolvedId = pid;
      if (!String(pid).includes("_")) {
        const rr = await fetch(`${GRAPH}/${pid}?fields=post_id&access_token=${token}`);
        const rj = await rr.json();
        if (rj.post_id) resolvedId = rj.post_id;
      }
      const r = await fetch(`${GRAPH}/${resolvedId}/insights?metric=post_impressions,post_impressions_unique,post_engaged_users&access_token=${token}`);
      const j = await r.json();
      report.checks.push({ test: `FB post insights (${pid}→${resolvedId})`, ok: !j.error, detail: j.error?.message || `${(j.data||[]).length} metrics returned` });
    } catch (e) {
      report.checks.push({ test: `FB post insights (${pid})`, ok: false, detail: e.message });
    }
  }

  // 7. Count DB posts with/without media IDs
  const postStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN fb_post_id IS NOT NULL AND fb_post_id != '' THEN 1 ELSE 0 END) as has_fb_id,
      SUM(CASE WHEN ig_media_id IS NOT NULL AND ig_media_id != '' THEN 1 ELSE 0 END) as has_ig_id
    FROM posts WHERE salon_id=? AND status='published'
  `).get(salon_id);
  report.postStats = postStats;

  res.json(report);
});

export default router;
