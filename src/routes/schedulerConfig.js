// src/routes/schedulerConfig.js — Scheduler Configuration Page

import express from "express";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";
import { getSchedulerStats, DEFAULT_PRIORITY } from "../scheduler.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────
// Plan definitions — posts/month limit and max daily cap per platform.
// The daily cap max prevents a manager from setting a rate that implies
// more posts than their plan could ever supply, while still giving them
// full control to tune DOWN as low as they want.
// ─────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  trial:   { label: "Trial",   posts_per_month: 20,  max_daily: 3  },
  starter: { label: "Starter", posts_per_month: 60,  max_daily: 4  },
  growth:  { label: "Growth",  posts_per_month: 200, max_daily: 8  },
  pro:     { label: "Pro",     posts_per_month: 500, max_daily: 20 },
};

function getPlanDef(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.starter;
}

function requireAuth(req, res, next) {
  if (!req.manager?.manager_phone) return res.redirect("/manager/login");
  next();
}

function fmtScheduled(iso) {
  if (!iso) return "—";
  try {
    return DateTime.fromSQL(iso, { zone: "utc" }).toLocal().toFormat("MMM d • h:mm a");
  } catch { return iso; }
}

function fmtTime(val) {
  if (!val) return "—";
  const [h, m] = val.split(":").map(Number);
  return DateTime.fromObject({ hour: h, minute: m || 0 }).toFormat("h:mm a");
}

const CONTENT_TYPE_LABELS = {
  availability:      "Availability",
  before_after:      "Before & After",
  celebration:       "Staff Celebrations",
  standard_post:     "Standard Service Post",
  promotions:        "Promotions",
  product_education: "Product Education",
  vendor_promotion:  "Vendor Brand Promotions",
};

const CONTENT_TYPE_DESCRIPTIONS = {
  availability:      "Open slot announcements — time-sensitive, shown for 24 hours.",
  before_after:      "Transformation posts — highest engagement and reach for salons.",
  celebration:       "Birthday and work anniversary posts for your team.",
  standard_post:     "AI-generated posts from stylist photos sent via SMS.",
  promotions:        "Special offers, seasonal deals, and limited-time pricing.",
  product_education: "Service spotlights and product education posts.",
  vendor_promotion:  "Brand partner campaigns (Aveda, Redken, etc.). Pro plan only.",
};

const MIX_DEFAULTS = {
  before_after:      40,
  standard_post:     30,
  promotions:        15,
  product_education: 10,
  celebration:        5,
};

// ─────────────────────────────────────────────────────────
// GET /manager/scheduler
// ─────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;

  const salon = db.prepare(`SELECT * FROM salons WHERE slug=?`).get(salon_id);
  if (!salon) return res.redirect("/manager");

  const stats   = getSchedulerStats(salon_id);
  const planDef = getPlanDef(salon.plan || "starter");

  // --- Current billing cycle usage ---
  const cycleStart = salon.billing_cycle_start
    ? DateTime.fromISO(salon.billing_cycle_start)
    : DateTime.utc().startOf("month");
  const cycleStartStr = cycleStart.toFormat("yyyy-LL-dd");

  const postsThisCycle = db.prepare(
    `SELECT COUNT(*) AS n FROM posts
     WHERE salon_id=? AND status='published' AND date(published_at) >= ?`
  ).get(salon_id, cycleStartStr)?.n || 0;

  const daysIntoCycle  = Math.max(1, DateTime.utc().diff(cycleStart, "days").days);
  const daysInMonth    = 30;
  const dailyAvgActual = postsThisCycle / daysIntoCycle;
  const projectedMonth = Math.round(dailyAvgActual * daysInMonth);

  // --- Cap settings ---
  const fbCap       = Math.min(salon.fb_feed_daily_max ?? 4, planDef.max_daily);
  const igCap       = Math.min(salon.ig_feed_daily_max ?? 4, planDef.max_daily);
  const tkCap       = Math.min(salon.tiktok_daily_max  ?? 3, planDef.max_daily);
  const fairnessMin = salon.fairness_window_min ?? 180;
  const postingStart = salon.posting_start_time || "09:00";
  const postingEnd   = salon.posting_end_time   || "19:00";
  const spacingMin   = salon.spacing_min ?? 20;
  const spacingMax   = salon.spacing_max ?? 45;

  // Effective daily = min(ig, fb) since one post publishes to both
  const effectiveDailyCap   = Math.min(igCap, fbCap);
  const rawImpliedMonthly   = effectiveDailyCap * daysInMonth;
  // Cap display at plan limit — showing more than the plan allows is misleading
  const capImpliedMonthly   = Math.min(rawImpliedMonthly, planDef.posts_per_month);
  const planPct             = Math.min(100, Math.round((capImpliedMonthly / planDef.posts_per_month) * 100));
  const actualPct           = Math.min(100, Math.round((postsThisCycle / planDef.posts_per_month) * 100));
  // Separately track whether caps actually exceed the plan ceiling (for the warning message)
  const capsExceedPlan      = rawImpliedMonthly > planDef.posts_per_month;

  const paceColor = planPct >= 100 ? "text-yellow-600" : planPct >= 80 ? "text-yellow-600" : "text-green-600";
  const paceBarBg = planPct >= 100 ? "bg-yellow-400"   : planPct >= 80 ? "bg-yellow-400"   : "bg-green-400";
  const paceMsg   = capsExceedPlan
    ? `Your daily caps could produce up to ${rawImpliedMonthly} posts/month, but your plan includes ${planDef.posts_per_month}. The scheduler will stop at your plan limit.`
    : planPct >= 80
    ? `You're using most of your plan quota. Consider upgrading if you want more posting headroom.`
    : `You have room to increase your posting frequency if your team has more content.`;

  // --- Today's usage bars ---
  const fbCapPct    = Math.min(100, Math.round((stats.fbToday / fbCap) * 100));
  const igCapPct    = Math.min(100, Math.round((stats.igToday / igCap) * 100));
  const capBarColor = (pct) => pct >= 100 ? "bg-red-400" : pct >= 75 ? "bg-yellow-400" : "bg-green-400";

  // --- Content types enabled ---
  const DEFAULT_TYPES_ENABLED = {
    standard_post: true, before_after: true, availability: true,
    celebration: true, promotions: true, product_education: true, vendor_promotion: false,
  };
  let contentTypesEnabled = { ...DEFAULT_TYPES_ENABLED };
  try {
    const parsed = JSON.parse(salon.content_types_enabled || "null");
    if (parsed && typeof parsed === "object") contentTypesEnabled = { ...DEFAULT_TYPES_ENABLED, ...parsed };
  } catch {}

  const isPro = (salon.plan || "trial") === "pro";

  // --- Content priority rows ---
  let priorityOrder = [...DEFAULT_PRIORITY];
  try {
    const parsed = JSON.parse(salon.content_priority || "null");
    if (Array.isArray(parsed) && parsed.length) priorityOrder = parsed;
  } catch {}

  const priorityRows = priorityOrder.map((type, i) => `
    <div class="flex items-center gap-3 rounded-xl border border-mpBorder bg-white px-4 py-3" data-type="${type}">
      <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mpAccentLight text-xs font-bold text-mpAccent">${i + 1}</span>
      <span class="flex-1 text-sm font-medium text-mpCharcoal">${CONTENT_TYPE_LABELS[type] || type}</span>
      <div class="flex gap-1">
        <button type="button" onclick="movePriority(${i}, -1)" ${i === 0 ? "disabled" : ""}
          class="rounded px-2 py-1 text-xs text-mpMuted hover:text-mpCharcoal hover:bg-mpBg disabled:opacity-30">▲</button>
        <button type="button" onclick="movePriority(${i}, 1)" ${i === priorityOrder.length - 1 ? "disabled" : ""}
          class="rounded px-2 py-1 text-xs text-mpMuted hover:text-mpCharcoal hover:bg-mpBg disabled:opacity-30">▼</button>
      </div>
    </div>
  `).join("");

  // --- Content mix inputs ---
  let contentMix = { ...MIX_DEFAULTS };
  try {
    const parsed = JSON.parse(salon.content_mix || "null");
    if (parsed && typeof parsed === "object") contentMix = { ...MIX_DEFAULTS, ...parsed };
  } catch {}

  const mixInputs = Object.entries(contentMix)
    .filter(([type]) => type !== "availability" && type !== "celebration")
    .map(([type, pct]) => `
      <div class="flex items-center gap-3">
        <label class="w-44 text-sm text-mpMuted shrink-0">${CONTENT_TYPE_LABELS[type] || type}</label>
        <input type="number" name="mix_${type}" value="${pct}" min="0" max="100"
          class="w-20 rounded-lg border border-mpBorder px-3 py-1.5 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
        <span class="text-xs text-mpMuted">%</span>
      </div>
    `).join("");

  const body = `
    <section class="mb-6 flex items-start justify-between gap-4 flex-wrap">
      <div>
        <h1 class="text-2xl font-bold text-mpCharcoal">Scheduler</h1>
        <p class="mt-1 text-sm text-mpMuted">Configure posting windows, daily caps, content priority, and fairness rules.</p>
      </div>
      <span class="inline-flex items-center gap-2 rounded-full border border-mpBorder bg-white px-4 py-1.5 text-xs font-semibold text-mpMuted shadow-sm">
        <span class="h-2 w-2 rounded-full bg-mpAccent"></span>
        ${planDef.label} Plan &mdash; ${planDef.posts_per_month} posts/month
      </span>
    </section>

    <!-- Queue Status Cards -->
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-mpMuted">Queued</p>
        <p class="mt-1 text-3xl font-extrabold text-mpCharcoal">${stats.queued}</p>
        <p class="mt-1 text-xs text-mpMuted">posts waiting to publish</p>
      </div>
      <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-mpMuted">Published Today</p>
        <p class="mt-1 text-3xl font-extrabold text-mpCharcoal">${stats.publishedToday}</p>
        <p class="mt-1 text-xs text-mpMuted">across all platforms</p>
      </div>
      <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-mpMuted">Next Post</p>
        <p class="mt-1 text-sm font-bold text-mpCharcoal">${stats.nextPost ? fmtScheduled(stats.nextPost.scheduled_for) : "None queued"}</p>
        <p class="mt-1 text-xs text-mpMuted">${stats.nextPost ? (CONTENT_TYPE_LABELS[stats.nextPost.post_type] || stats.nextPost.post_type) : "—"}</p>
      </div>
      <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
        <p class="text-xs font-semibold uppercase tracking-wide text-mpMuted">Failed Posts</p>
        <p class="mt-1 text-3xl font-extrabold ${stats.failed > 0 ? "text-red-500" : "text-mpCharcoal"}">${stats.failed}</p>
        <p class="mt-1 text-xs text-mpMuted">${stats.failed > 0 ? "needs attention" : "all clear"}</p>
      </div>
    </div>

    <!-- Monthly Pace + Cycle Usage (combined card) -->
    <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm mb-6">
      <div class="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div>
          <h2 class="text-sm font-bold text-mpCharcoal">Monthly Pace &amp; Plan Usage</h2>
          <p class="mt-0.5 text-xs text-mpMuted">Based on your current daily cap settings and this billing cycle's actual activity.</p>
        </div>
        <a href="/manager/billing?salon=${salon_id}" class="text-xs font-semibold text-mpAccent hover:text-mpCharcoal transition-colors shrink-0">
          Manage Plan &rarr;
        </a>
      </div>

      <div class="grid gap-6 sm:grid-cols-2">

        <!-- Cap-implied monthly pace (live, updates with JS) -->
        <div>
          <div class="flex items-end justify-between mb-1">
            <p class="text-xs font-semibold text-mpMuted uppercase tracking-wide">Your Cap Allows</p>
            <p class="text-sm font-bold ${paceColor}" id="paceNumber">${capImpliedMonthly} posts/month</p>
          </div>
          <div class="h-2.5 rounded-full bg-mpBg overflow-hidden mb-2">
            <div id="paceBar" class="h-2.5 rounded-full ${paceBarBg} transition-all" style="width:${planPct}%"></div>
          </div>
          <p class="text-[11px] text-mpMuted" id="paceMsg">${paceMsg}</p>
        </div>

        <!-- Actual cycle usage (static) -->
        <div>
          <div class="flex items-end justify-between mb-1">
            <p class="text-xs font-semibold text-mpMuted uppercase tracking-wide">Used This Cycle</p>
            <p class="text-sm font-bold text-mpCharcoal">${postsThisCycle} / ${planDef.posts_per_month}</p>
          </div>
          <div class="h-2.5 rounded-full bg-mpBg overflow-hidden mb-2">
            <div class="h-2.5 rounded-full ${capBarColor(actualPct)} transition-all" style="width:${actualPct}%"></div>
          </div>
          <p class="text-[11px] text-mpMuted">
            ${postsThisCycle === 0 ? "No posts published yet this cycle." :
              `Averaging ~${dailyAvgActual.toFixed(1)} posts/day. Projected: ~${projectedMonth} this month.`}
          </p>
        </div>

      </div>

      <!-- Today's platform bars -->
      <div class="mt-5 pt-5 border-t border-mpBorder">
        <p class="text-xs font-semibold uppercase tracking-wide text-mpMuted mb-3">Today's Platform Usage</p>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="flex items-center justify-between text-xs mb-1">
              <span class="font-medium text-mpCharcoal">Instagram Feed</span>
              <span class="text-mpMuted">${stats.igToday} / ${igCap}</span>
            </div>
            <div class="h-2 rounded-full bg-mpBg overflow-hidden">
              <div class="h-2 rounded-full ${capBarColor(igCapPct)} transition-all" style="width:${igCapPct}%"></div>
            </div>
          </div>
          <div>
            <div class="flex items-center justify-between text-xs mb-1">
              <span class="font-medium text-mpCharcoal">Facebook Feed</span>
              <span class="text-mpMuted">${stats.fbToday} / ${fbCap}</span>
            </div>
            <div class="h-2 rounded-full bg-mpBg overflow-hidden">
              <div class="h-2 rounded-full ${capBarColor(fbCapPct)} transition-all" style="width:${fbCapPct}%"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <form method="POST" action="/manager/scheduler/update" class="space-y-6">
      <input type="hidden" name="salon_id" value="${salon_id}" />

      <!-- Posting Window -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Posting Window</h2>
        <p class="text-xs text-mpMuted mb-5">MostlyPostly only publishes within this window (your salon's local time). Posts queued outside this window are held until it opens.</p>
        <div class="grid gap-4 sm:grid-cols-3">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Window Start</label>
            <input type="time" name="posting_start_time" value="${postingStart}"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Window End</label>
            <input type="time" name="posting_end_time" value="${postingEnd}"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Timezone</label>
            <p class="rounded-lg border border-mpBorder bg-mpBg px-3 py-2 text-sm text-mpMuted">${salon.timezone || "America/Indiana/Indianapolis"}</p>
          </div>
        </div>
        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Min Spacing Between Posts (minutes)</label>
            <input type="number" name="spacing_min" value="${spacingMin}" min="5" max="240"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Max Spacing Between Posts (minutes)</label>
            <input type="number" name="spacing_max" value="${spacingMax}" min="5" max="480"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
          </div>
        </div>
      </div>

      <!-- Platform Connections -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Platform Connections</h2>
        <p class="text-xs text-mpMuted mb-5">Active platforms your content publishes to. Connect additional platforms in Admin → Social Connections.</p>
        <div class="space-y-3">

          <!-- Facebook -->
          <div class="flex items-center justify-between py-2.5 border-b border-mpBorder">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-[#1877F2]/10 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4 text-[#1877F2]" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
              </div>
              <div>
                <p class="text-sm font-medium text-mpCharcoal">Facebook</p>
                <p class="text-[11px] text-mpMuted">${salon.facebook_page_id ? `Page ID: ${salon.facebook_page_id}` : "Not connected — set up in Admin → Social Connections"}</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${salon.facebook_page_id ? "bg-green-50 text-green-700 border border-green-200" : "bg-gray-100 text-gray-400 border border-gray-200"}">
              ${salon.facebook_page_id ? "Connected" : "Not connected"}
            </span>
          </div>

          <!-- Instagram -->
          <div class="flex items-center justify-between py-2.5 border-b border-mpBorder">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-[#E1306C]/10 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4 text-[#E1306C]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
              </div>
              <div>
                <p class="text-sm font-medium text-mpCharcoal">Instagram</p>
                <p class="text-[11px] text-mpMuted">${salon.instagram_handle ? `@${salon.instagram_handle}` : "Not connected — set up in Admin → Social Connections"}</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold ${salon.instagram_business_id ? "bg-green-50 text-green-700 border border-green-200" : "bg-gray-100 text-gray-400 border border-gray-200"}">
              ${salon.instagram_business_id ? "Connected" : "Not connected"}
            </span>
          </div>

          <!-- TikTok — Coming Soon -->
          <div class="flex items-center justify-between py-2.5 border-b border-mpBorder opacity-60">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.95a8.16 8.16 0 004.77 1.52V7.03a4.85 4.85 0 01-1-.34z"/></svg>
              </div>
              <div>
                <p class="text-sm font-medium text-mpCharcoal">TikTok</p>
                <p class="text-[11px] text-mpMuted">Short-form video publishing — in development</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold bg-mpAccentLight text-mpAccent border border-mpAccent/20">
              Coming Soon
            </span>
          </div>

          <!-- Google My Business — Coming Soon -->
          <div class="flex items-center justify-between py-2.5 border-b border-mpBorder opacity-60">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81z"/></svg>
              </div>
              <div>
                <p class="text-sm font-medium text-mpCharcoal">Google My Business</p>
                <p class="text-[11px] text-mpMuted">Google Business posts — in development</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold bg-mpAccentLight text-mpAccent border border-mpAccent/20">
              Coming Soon
            </span>
          </div>

          <!-- Yelp — Coming Soon -->
          <div class="flex items-center justify-between py-2.5 opacity-60">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4 text-gray-400" fill="currentColor" viewBox="0 0 24 24"><path d="M20.16 12.6l-4.25-1.06a1 1 0 00-1.1.5 1 1 0 00.17 1.18l3.14 2.98a1 1 0 001.48-.17 5.35 5.35 0 00.56-3.43zm-8.07 5.49l-1.5 4.08a1 1 0 00.6 1.28 9.4 9.4 0 003.6.43 1 1 0 00.85-1.08l-.39-4.32a1 1 0 00-.95-.91 1 1 0 00-1.21.52zm-3.12-2.5L4.9 17.47a1 1 0 00-.09 1.45 9.4 9.4 0 002.68 2.01 1 1 0 001.35-.43l2.01-3.8a1 1 0 00-.27-1.24 1 1 0 00-1.61.13zm-.32-4.46L4.4 9.77a1 1 0 00-1.31.58 9.4 9.4 0 00-.28 3.55 1 1 0 001.01.93l4.35-.16a1 1 0 00.94-.83 1 1 0 00-.46-1.21zM12 2a9.4 9.4 0 00-2.86.44 1 1 0 00-.64 1.23l1.38 4.16A1 1 0 0011 8.7a1 1 0 001.08-.33L14.87 4.8A1 1 0 0014.6 3.4 9.4 9.4 0 0012 2z"/></svg>
              </div>
              <div>
                <p class="text-sm font-medium text-mpCharcoal">Yelp</p>
                <p class="text-[11px] text-mpMuted">Yelp business updates — in development</p>
              </div>
            </div>
            <span class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold bg-mpAccentLight text-mpAccent border border-mpAccent/20">
              Coming Soon
            </span>
          </div>

        </div>
      </div>

      <!-- Platform Daily Caps — FB + IG only (active platforms) -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <div class="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <h2 class="text-base font-bold text-mpCharcoal">Platform Daily Caps</h2>
          <span class="text-[11px] text-mpMuted rounded-full border border-mpBorder px-2.5 py-1">
            ${planDef.label} plan max: <strong>${planDef.max_daily}/day per platform</strong>
          </span>
        </div>
        <p class="text-xs text-mpMuted mb-5">
          Maximum feed posts per day per platform. You can set these as low as 1 — useful for quality control or slower periods.
          Stories and availability posts don't count against these limits.
        </p>
        <div class="grid gap-6 sm:grid-cols-2">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Instagram Feed (posts/day)</label>
            <input type="number" id="igCapInput" name="ig_feed_daily_max"
              value="${igCap}" min="1" max="${planDef.max_daily}"
              oninput="updatePace()"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
            <div class="mt-1.5 flex items-center justify-between text-[11px]">
              <span class="text-mpMuted">Plan max: ${planDef.max_daily}/day</span>
              <span class="text-mpMuted">Rec: 3–5</span>
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1.5">Facebook Feed (posts/day)</label>
            <input type="number" id="fbCapInput" name="fb_feed_daily_max"
              value="${fbCap}" min="1" max="${planDef.max_daily}"
              oninput="updatePace()"
              class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
            <div class="mt-1.5 flex items-center justify-between text-[11px]">
              <span class="text-mpMuted">Plan max: ${planDef.max_daily}/day</span>
              <span class="text-mpMuted">Rec: 2–4</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Content Priority -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Content Priority</h2>
        <p class="text-xs text-mpMuted mb-5">When multiple posts are ready at the same time, they publish in this order. Availability is always most urgent — time-sensitive content disappears after 24 hours.</p>
        <input type="hidden" name="content_priority" id="priorityInput" value="${JSON.stringify(priorityOrder)}" />
        <div class="space-y-2" id="priorityList">
          ${priorityRows}
        </div>
      </div>

      <!-- Content Mix Targets -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Content Mix Targets</h2>
        <p class="text-xs text-mpMuted mb-5">
          Your target breakdown by content type. This is a planning reference — the scheduler uses priority order above for real-time decisions.
          Before &amp; After posts consistently drive the most reach for salons.
        </p>
        <div class="space-y-3 max-w-sm">
          ${mixInputs}
        </div>
        <div id="mixTotal" class="mt-4 text-xs text-mpMuted"></div>
      </div>

      <!-- Content Type Toggles -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Content Type Controls</h2>
        <p class="text-xs text-mpMuted mb-5">
          Enable or disable specific content types. Disabled types are skipped by the scheduler entirely —
          useful if you manage celebrations elsewhere, or want to pause vendor posts temporarily.
        </p>
        <div class="space-y-3">
          ${Object.entries(CONTENT_TYPE_LABELS).map(([type, label]) => {
            const enabled = contentTypesEnabled[type] !== false;
            const isVendor = type === "vendor_promotion";
            const locked = isVendor && !isPro;
            return `
            <div class="flex items-start justify-between gap-4 py-2 border-b border-mpBorder last:border-0">
              <div class="flex-1">
                <p class="text-sm font-medium text-mpCharcoal flex items-center gap-2">
                  ${label}
                  ${locked ? `<span class="text-[10px] bg-mpBg border border-mpBorder rounded-full px-2 py-0.5 text-mpMuted font-semibold">Pro</span>` : ""}
                </p>
                <p class="text-[11px] text-mpMuted mt-0.5">${CONTENT_TYPE_DESCRIPTIONS[type] || ""}</p>
              </div>
              <label class="relative inline-flex items-center ${locked ? "cursor-not-allowed opacity-50" : "cursor-pointer"} shrink-0 mt-0.5">
                <input type="checkbox" name="ctype_${type}" value="1"
                       ${enabled ? "checked" : ""}
                       ${locked ? "disabled" : ""}
                       class="sr-only peer" />
                <div class="w-10 h-6 bg-mpBorder peer-focus:ring-2 peer-focus:ring-mpAccent rounded-full peer
                            peer-checked:bg-mpAccent after:content-[''] after:absolute after:top-0.5 after:left-0.5
                            after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all
                            peer-checked:after:translate-x-4"></div>
              </label>
            </div>`;
          }).join("")}
        </div>
        ${!isPro ? `<p class="mt-4 text-[11px] text-mpMuted">Vendor Brand Promotions require a <a href="/manager/billing?salon=${salon_id}" class="text-mpAccent underline">Pro plan</a>.</p>` : ""}
      </div>

      <!-- Stylist Fairness -->
      <div class="rounded-2xl border border-mpBorder bg-white px-6 py-5 shadow-sm">
        <h2 class="text-base font-bold text-mpCharcoal mb-1">Stylist Fairness</h2>
        <p class="text-xs text-mpMuted mb-5">
          Prevents the same stylist from dominating the feed. If their last post was within this window, the next one is delayed until the gap passes.
          With ${salon.fairness_window_min ?? 180} minutes set, no stylist appears more than once every ${Math.round((salon.fairness_window_min ?? 180) / 60)} hours.
        </p>
        <div class="max-w-xs">
          <label class="block text-xs font-semibold text-mpMuted mb-1.5">Minimum Gap Per Stylist (minutes)</label>
          <input type="number" name="fairness_window_min" value="${fairnessMin}" min="0" max="1440"
            class="w-full rounded-lg border border-mpBorder px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none" />
          <p class="mt-1 text-[11px] text-mpMuted">120 min = max 2 posts/stylist per 4-hr shift. Set to 0 to disable.</p>
        </div>
      </div>

      <div class="flex items-center gap-3 pb-8">
        <button type="submit"
          class="rounded-full bg-mpCharcoal px-7 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-mpCharcoalDark transition-colors">
          Save Scheduler Settings
        </button>
        <a href="/manager?salon=${salon_id}" class="text-sm text-mpMuted hover:text-mpCharcoal transition-colors">Cancel</a>
      </div>
    </form>

    <script>
      // ── Plan constants (injected server-side) ──────────────
      const PLAN_POSTS_PER_MONTH = ${planDef.posts_per_month};
      const PLAN_MAX_DAILY       = ${planDef.max_daily};
      const PLAN_LABEL           = "${planDef.label}";

      // ── Live pace calculator ───────────────────────────────
      function updatePace() {
        const igVal = parseInt(document.getElementById('igCapInput')?.value, 10) || 1;
        const fbVal = parseInt(document.getElementById('fbCapInput')?.value, 10) || 1;

        // One post publishes to both FB and IG — effective daily = lower of the two
        const effectiveDaily = Math.min(igVal, fbVal);
        const rawMonthly = effectiveDaily * 30;
        const capsExceedPlan = rawMonthly > PLAN_POSTS_PER_MONTH;
        const impliedMonthly = Math.min(rawMonthly, PLAN_POSTS_PER_MONTH);
        const pct = Math.min(100, Math.round((impliedMonthly / PLAN_POSTS_PER_MONTH) * 100));

        const paceNum = document.getElementById('paceNumber');
        const paceBar = document.getElementById('paceBar');
        const paceMsg = document.getElementById('paceMsg');

        if (paceNum) paceNum.textContent = impliedMonthly + ' posts/month';

        if (paceBar) {
          paceBar.style.width = pct + '%';
          paceBar.className = 'h-2.5 rounded-full transition-all ' +
            (pct >= 80 ? 'bg-yellow-400' : 'bg-green-400');
        }

        if (paceNum) {
          paceNum.className = 'text-sm font-bold ' +
            (pct >= 80 ? 'text-yellow-600' : 'text-green-600');
        }

        if (paceMsg) {
          if (capsExceedPlan) {
            paceMsg.textContent = 'Your daily caps could produce up to ' + rawMonthly + ' posts/month, but your plan includes ' + PLAN_POSTS_PER_MONTH + '. The scheduler will stop at your plan limit.';
          } else if (pct >= 80) {
            paceMsg.textContent = 'You\\'re using most of your ' + PLAN_LABEL + ' plan quota. Consider upgrading if you want more posting headroom.';
          } else {
            paceMsg.textContent = 'You have room to increase your posting frequency — your plan allows ' + PLAN_POSTS_PER_MONTH + ' posts/month.';
          }
        }
      }

      // ── Content mix total validator ──────────────────────────
      function updateMixTotal() {
        const inputs = document.querySelectorAll('[name^="mix_"]');
        let total = 0;
        inputs.forEach(el => { total += parseInt(el.value, 10) || 0; });
        const el = document.getElementById('mixTotal');
        if (!el) return;
        if (total === 100) {
          el.textContent = 'Total: 100% — perfect.';
          el.className = 'mt-4 text-xs text-green-600 font-medium';
        } else {
          el.textContent = 'Total: ' + total + '% — adjust to reach 100%.';
          el.className = 'mt-4 text-xs ' + (total > 100 ? 'text-red-500' : 'text-yellow-600') + ' font-medium';
        }
      }

      document.querySelectorAll('[name^="mix_"]').forEach(el => {
        el.addEventListener('input', updateMixTotal);
      });
      updateMixTotal();

      // ── Priority reorder logic ─────────────────────────────
      const priorityInput = document.getElementById('priorityInput');

      function movePriority(index, direction) {
        const list  = document.getElementById('priorityList');
        const items = Array.from(list.children);
        const newIndex = index + direction;
        if (newIndex < 0 || newIndex >= items.length) return;

        const moving  = items[index];
        const sibling = items[newIndex];
        if (direction === -1) {
          list.insertBefore(moving, sibling);
        } else {
          list.insertBefore(sibling, moving);
        }

        // Re-number and re-wire
        Array.from(list.children).forEach((el, i) => {
          el.querySelector('span').textContent = i + 1;
          const btns = el.querySelectorAll('button');
          btns[0].disabled = i === 0;
          btns[1].disabled = i === list.children.length - 1;
          btns[0].setAttribute('onclick', 'movePriority(' + i + ', -1)');
          btns[1].setAttribute('onclick', 'movePriority(' + i + ', 1)');
        });

        priorityInput.value = JSON.stringify(Array.from(list.children).map(el => el.dataset.type));
      }
    </script>
  `;

  res.send(pageShell({
    title: "Scheduler",
    body,
    current: "scheduler",
    salon_id,
    manager_phone: req.manager.manager_phone || "",
  }));
});

// ─────────────────────────────────────────────────────────
// POST /manager/scheduler/update
// ─────────────────────────────────────────────────────────
router.post("/update", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;

  // Re-fetch plan to enforce server-side cap maximums
  const salon   = db.prepare(`SELECT plan FROM salons WHERE slug=?`).get(salon_id);
  const planDef = getPlanDef(salon?.plan || "starter");

  const {
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    ig_feed_daily_max,
    fb_feed_daily_max,
    tiktok_daily_max,
    fairness_window_min,
    content_priority,
  } = req.body;

  // Build content_types_enabled from checkboxes
  const allTypes = ["standard_post","before_after","availability","celebration","promotions","product_education","vendor_promotion"];
  const contentTypesEnabled = {};
  for (const type of allTypes) {
    contentTypesEnabled[type] = req.body[`ctype_${type}`] === "1";
  }

  // Clamp daily caps to plan maximum server-side (manager can go lower, never higher than plan)
  function clampCap(val) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 1) return 1;
    return Math.min(n, planDef.max_daily);
  }

  // Build content mix
  const mixTypes = ["before_after", "standard_post", "promotions", "product_education", "celebration"];
  const contentMix = {};
  for (const type of mixTypes) {
    const val = parseInt(req.body[`mix_${type}`], 10);
    if (!isNaN(val)) contentMix[type] = Math.max(0, Math.min(100, val));
  }

  // Validate priority JSON
  let priorityJson = null;
  try {
    const parsed = JSON.parse(content_priority || "null");
    if (Array.isArray(parsed) && parsed.length) priorityJson = JSON.stringify(parsed);
  } catch {}

  db.prepare(`
    UPDATE salons
    SET
      posting_start_time  = COALESCE(?, posting_start_time),
      posting_end_time    = COALESCE(?, posting_end_time),
      spacing_min         = COALESCE(?, spacing_min),
      spacing_max         = COALESCE(?, spacing_max),
      ig_feed_daily_max   = ?,
      fb_feed_daily_max   = ?,
      tiktok_daily_max    = COALESCE(?, tiktok_daily_max),
      fairness_window_min = COALESCE(?, fairness_window_min),
      content_priority    = COALESCE(?, content_priority),
      content_mix            = ?,
      content_types_enabled  = ?,
      updated_at             = datetime('now')
    WHERE slug = ?
  `).run(
    posting_start_time || null,
    posting_end_time   || null,
    parseInt(spacing_min, 10) || null,
    parseInt(spacing_max, 10) || null,
    clampCap(ig_feed_daily_max),
    clampCap(fb_feed_daily_max),
    tiktok_daily_max != null ? clampCap(tiktok_daily_max) : null,
    parseInt(fairness_window_min, 10) >= 0 ? parseInt(fairness_window_min, 10) : null,
    priorityJson,
    Object.keys(contentMix).length ? JSON.stringify(contentMix) : null,
    JSON.stringify(contentTypesEnabled),
    salon_id
  );

  console.log(`✅ [SchedulerConfig] Saved for ${salon_id} (plan: ${planDef.label}, max daily: ${planDef.max_daily})`);
  return res.redirect(`/manager/scheduler?salon=${salon_id}`);
});

export default router;
