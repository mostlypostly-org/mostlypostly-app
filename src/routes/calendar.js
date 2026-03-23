// src/routes/calendar.js
// Content calendar: 4-week month grid view at /manager/calendar
// Posts grouped by local salon date, color-coded by type.
// Vendor posts (vendor_campaign_id IS NOT NULL) show purple pill with vendor name.
// Day panel loads as HTML fragment via GET /day/:date
// Drag reschedule via POST /reschedule (preserves time-of-day, swaps date)
// Mount at: /manager/calendar

import express from "express";
import { db } from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) return res.redirect("/manager/login");
  next();
}

function toProxyUrl(url) {
  if (!url) return null;
  if (url.includes("api.twilio.com")) return `/api/media-proxy?url=${encodeURIComponent(url)}`;
  return url;
}

function safe(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline SVG platform icon badges — circular bubbles, no external CDN
// size: "sm" = 14px (grid mini-cards), "md" = 20px (day panel cards)
function platformIcons(salon, size = "md") {
  const px = size === "sm" ? 14 : 20;
  const icons = [];
  if (salon.facebook_page_token) {
    icons.push(`<svg width="${px}" height="${px}" viewBox="0 0 24 24" title="Facebook"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path d="M14 8h-1.5c-.3 0-.5.2-.5.5V10h2l-.3 2H12v6h-2v-6H8.5v-2H10V8.5C10 7.1 11.1 6 12.5 6H14v2z" fill="#fff"/></svg>`);
  }
  if (salon.instagram_business_id) {
    icons.push(`<svg width="${px}" height="${px}" viewBox="0 0 24 24" title="Instagram"><circle cx="12" cy="12" r="12" fill="#C13584"/><rect x="6.5" y="6.5" width="11" height="11" rx="3" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="12" cy="12" r="3" stroke="#fff" stroke-width="1.5" fill="none"/><circle cx="16" cy="8" r="0.8" fill="#fff"/></svg>`);
  }
  if (salon.tiktok_enabled) {
    icons.push(`<svg width="${px}" height="${px}" viewBox="0 0 24 24" title="TikTok"><circle cx="12" cy="12" r="12" fill="#010101"/><path d="M16.5 9.2a4.2 4.2 0 01-2.5-.8v3.9a3.4 3.4 0 11-3-3.4v1.9a1.5 1.5 0 101.1 1.5V6h1.9a2.3 2.3 0 002.5 2.1v1.1z" fill="#fff"/></svg>`);
  }
  if (salon.google_location_id) {
    icons.push(`<svg width="${px}" height="${px}" viewBox="0 0 24 24" title="Google Business"><circle cx="12" cy="12" r="12" fill="#fff" stroke="#dadce0" stroke-width="1"/><path d="M17.5 12.2h-5.4v1.8h3.1c-.3 1.5-1.6 2.5-3.1 2.5a3.5 3.5 0 010-7c.9 0 1.7.3 2.3.9l1.3-1.3A5.4 5.4 0 0012 7.5a5.5 5.5 0 000 11c2.8 0 5.2-2 5.5-4.8v-.5z" fill="#4285F4"/><path d="M7.2 12a4.8 4.8 0 01.3-1.7L5.9 9.1A5.5 5.5 0 005.5 12c0 1 .3 2 .7 2.8l1.6-1.3A4.8 4.8 0 017.2 12z" fill="#34A853"/><path d="M12 17.5c-1.4 0-2.6-.6-3.5-1.6l-1.6 1.3C8 18.5 9.9 19.5 12 19.5c1.7 0 3.3-.6 4.5-1.7l-1.7-1.3c-.7.6-1.7.9-2.8 1z" fill="#FBBC05"/></svg>`);
  }
  if (!icons.length) return "";
  const gap = size === "sm" ? "gap-0.5" : "gap-1";
  return `<div class="flex ${gap}">${icons.join("")}</div>`;
}

// Solid color class for the left bar on grid mini-cards
function calendarCardBarClass(post) {
  if (post.status === "failed") return "bg-red-500";
  if (post.status === "vendor_scheduled") return "bg-purple-300";
  if (post.vendor_campaign_id) return "bg-purple-500";
  const map = {
    standard_post:     "bg-blue-500",
    before_after:      "bg-teal-500",
    before_after_post: "bg-teal-500",
    availability:      "bg-green-500",
    promotion:         "bg-amber-500",
    promotions:        "bg-amber-500",
    celebration:       "bg-pink-500",
    celebration_story: "bg-pink-500",
    reel:              "bg-indigo-500",
  };
  return map[post.post_type] || "bg-gray-400";
}

// Color-coded pill class per post type (failed overrides, vendor overrides type)
function calendarPillClass(post) {
  if (post.status === "failed") return "bg-red-100 text-red-700";
  if (post.status === "vendor_scheduled") return "bg-white text-purple-600 border border-purple-300 border-dashed";
  if (post.vendor_campaign_id) return "bg-purple-100 text-purple-700 border-purple-200";
  const map = {
    standard_post:     "bg-blue-100 text-blue-700",
    before_after:      "bg-teal-100 text-teal-700",
    before_after_post: "bg-teal-100 text-teal-700",
    availability:      "bg-green-100 text-green-700",
    promotion:         "bg-amber-100 text-amber-700",
    promotions:        "bg-amber-100 text-amber-700",
    celebration:       "bg-pink-100 text-pink-700",
    celebration_story: "bg-pink-100 text-pink-700",
    reel:              "bg-indigo-100 text-indigo-700",
  };
  return map[post.post_type] || "bg-gray-100 text-gray-600";
}

// Short display label for the pill
function calendarPillLabel(post) {
  if (post.status === "failed") return "Failed";
  if (post.vendor_campaign_id && post.vendor_name) return post.vendor_name;
  const map = {
    standard_post:     "Post",
    before_after:      "B/A",
    before_after_post: "B/A",
    availability:      "Avail",
    promotion:         "Promo",
    promotions:        "Promo",
    celebration:       "Celeb",
    celebration_story: "Celeb",
    reel:              "Reel",
  };
  return map[post.post_type] || (post.post_type || "Post");
}

// Status badge label for day panel cards
function statusBadge(status) {
  const map = {
    manager_pending:  { label: "Pending Approval", color: "bg-orange-100 text-orange-700" },
    manager_approved: { label: "Scheduled",        color: "bg-gray-100 text-gray-600" },
    published:        { label: "✓ Published",      color: "bg-green-100 text-green-700" },
    failed:           { label: "Failed",            color: "bg-red-100 text-red-700" },
    vendor_scheduled: { label: "Vendor Scheduled",  color: "bg-purple-100 text-purple-700" },
  };
  const s = map[status] || { label: status, color: "bg-gray-100 text-gray-600" };
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.color}">${safe(s.label)}</span>`;
}

// Normalize post type to a canonical filter key
function normalizePostType(post) {
  if (post.vendor_campaign_id) return "vendor";
  const map = {
    before_after_post: "before_after",
    promotions:        "promotion",
    celebration_story: "celebration",
  };
  return map[post.post_type] || post.post_type || "standard_post";
}

// ── GET / — Calendar month grid ───────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const manager_id = req.session.manager_id;

  const salon = db.prepare("SELECT timezone, facebook_page_token, instagram_business_id, tiktok_enabled, google_location_id FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  // Parse ?month=YYYY-MM or default to current month
  let monthParam = req.query.month;
  let monthStart;
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    monthStart = DateTime.fromISO(monthParam + "-01", { zone: tz }).startOf("month");
    if (!monthStart.isValid) monthStart = DateTime.now().setZone(tz).startOf("month");
  } else {
    monthStart = DateTime.now().setZone(tz).startOf("month");
  }

  // Compute Sunday-based grid start
  let gridStart = monthStart.startOf("week"); // Luxon weeks start Monday by default
  // Adjust back to Sunday if the week doesn't start on Sunday (weekday 7 = Sunday in Luxon)
  if (gridStart.weekday !== 7) gridStart = gridStart.minus({ days: gridStart.weekday });
  // Compute the Sunday that contains the last day of the month, then extend to Saturday
  let gridEndAnchor = monthStart.endOf("month").startOf("week");
  if (gridEndAnchor.weekday !== 7) gridEndAnchor = gridEndAnchor.minus({ days: gridEndAnchor.weekday });
  const gridEnd = gridEndAnchor.plus({ days: 6 }).endOf("day");
  // Number of weeks needed (5 or 6 depending on month layout)
  const totalWeeks = Math.round(gridEnd.diff(gridStart, "weeks").weeks);

  // UTC range for DB query
  const rangeStartUtc = gridStart.startOf("day").toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
  const rangeEndUtc   = gridEnd.endOf("day").toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  const posts = db.prepare(`
    SELECT p.id, p.post_type, p.status, p.scheduled_for, p.published_at, p.stylist_name,
           p.image_url, p.image_urls, p.final_caption, p.base_caption, p.vendor_campaign_id,
           vc.vendor_name
    FROM posts p
    LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
    WHERE p.salon_id = ?
      AND p.status NOT IN ('draft', 'cancelled')
      AND (p.scheduled_for BETWEEN ? AND ? OR p.published_at BETWEEN ? AND ?)
    ORDER BY COALESCE(p.scheduled_for, p.published_at) ASC
  `).all(salon_id, rangeStartUtc, rangeEndUtc, rangeStartUtc, rangeEndUtc);

  // Group posts by local salon date
  const byDate = new Map();
  for (const post of posts) {
    const rawTs = post.scheduled_for || post.published_at;
    if (!rawTs) continue;
    let dt = DateTime.fromSQL(rawTs, { zone: "utc" });
    if (!dt.isValid) dt = DateTime.fromISO(rawTs, { zone: "utc" });
    const localDate = dt.setZone(tz).toFormat("yyyy-LL-dd");
    if (!byDate.has(localDate)) byDate.set(localDate, []);
    byDate.get(localDate).push(post);
  }

  const prevMonth = monthStart.minus({ months: 1 }).toFormat("yyyy-LL");
  const nextMonth = monthStart.plus({ months: 1 }).toFormat("yyyy-LL");
  const monthLabel = monthStart.toFormat("MMMM yyyy");
  const today = DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");

  const DAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let rows = "";
  let cursor = gridStart;
  for (let week = 0; week < totalWeeks; week++) {
    let cells = "";
    for (let dow = 0; dow < 7; dow++) {
      const dateStr = cursor.toFormat("yyyy-LL-dd");
      const isCurrentMonth = cursor.month === monthStart.month;
      const isToday = dateStr === today;
      const isPast = dateStr < today;
      const dayPosts = byDate.get(dateStr) || [];

      const dayNumClass = isCurrentMonth
        ? "text-xs font-semibold text-mpCharcoal"
        : "text-xs font-semibold text-gray-300";

      const cellBg = isPast ? "bg-gray-100" : "bg-white";
      const cellBorder = isToday
        ? "ring-2 ring-mpAccent ring-inset"
        : "border border-mpBorder";

      let pills = "";
      const visible = dayPosts.slice(0, 3);
      for (const p of visible) {
        const lbl = calendarPillLabel(p);
        const barClass = calendarCardBarClass(p);
        const isDraggable = (p.status === "manager_approved" || p.status === "vendor_scheduled") && !!p.scheduled_for;
        const iconsHtml = platformIcons(salon, "sm");
        const postTypeNorm = normalizePostType(p);

        let publishedLine = "";
        if (p.status === "published" && p.published_at) {
          let pubDt = DateTime.fromSQL(p.published_at, { zone: "utc" });
          if (!pubDt.isValid) pubDt = DateTime.fromISO(p.published_at, { zone: "utc" });
          if (pubDt.isValid) publishedLine = `<div class="card-field-time text-[9px] text-green-600 mt-0.5 truncate">✓ ${pubDt.setZone(tz).toFormat("MMM d")}</div>`;
        }

        pills += `<div class="calendar-post-card relative bg-white rounded border border-mpBorder mb-1 overflow-hidden ${isDraggable ? "cursor-grab" : "cursor-default"}" data-id="${safe(p.id)}" data-post-type="${safe(postTypeNorm)}" data-status="${safe(p.status)}"${isDraggable ? ' data-draggable="true"' : ""}>
          <div class="absolute left-0 top-0 bottom-0 w-1 ${barClass}"></div>
          <div class="pl-2.5 pr-1.5 py-1">
            <div class="flex items-center justify-between gap-1">
              <span class="text-[10px] font-semibold text-mpCharcoal truncate">${safe(lbl)}</span>
              <div class="card-field-platforms">${iconsHtml}</div>
            </div>
            ${p.stylist_name ? `<div class="card-field-stylist text-[9px] text-mpMuted truncate mt-0.5">${safe(p.stylist_name)}</div>` : ""}
            <div class="card-field-caption text-[9px] text-mpMuted truncate mt-0.5">${safe((p.final_caption || p.base_caption || "").slice(0, 60))}</div>
            ${publishedLine}
          </div>
        </div>`;
      }
      if (dayPosts.length > 3) {
        pills += `<div class="text-[9px] text-mpMuted font-semibold pl-0.5">+${dayPosts.length - 3} more</div>`;
      }

      cells += `
        <div class="calendar-day-cell relative min-h-[110px] p-1.5 rounded-xl ${cellBg} ${cellBorder} cursor-pointer hover:border-mpAccent/40 transition-colors"
             data-date="${dateStr}">
          <div class="${dayNumClass} mb-1 select-none">${cursor.day}</div>
          ${pills}
        </div>`;
      cursor = cursor.plus({ days: 1 });
    }
    rows += `<div class="grid grid-cols-7 gap-1.5 mb-1.5">${cells}</div>`;
  }

  const body = `
    <!-- Day panel backdrop -->
    <div id="day-panel-backdrop" class="hidden fixed inset-0 z-30 bg-black/20" data-action="close-day-panel"></div>

    <!-- Day panel -->
    <div id="day-panel" class="hidden fixed inset-y-0 right-0 z-40 w-96 max-w-full bg-white border-l border-mpBorder shadow-2xl overflow-y-auto transition-transform">
      <div class="flex items-center justify-between px-5 py-4 border-b border-mpBorder sticky top-0 bg-white z-10">
        <h2 id="day-panel-title" class="text-base font-bold text-mpCharcoal"></h2>
        <button type="button" data-action="close-day-panel" class="text-mpMuted hover:text-mpCharcoal text-2xl leading-none">&times;</button>
      </div>
      <div id="day-panel-content" class="px-5 py-4"></div>
    </div>

    <div class="max-w-5xl mx-auto">
      <!-- Row 1: Page title, view toggle, New Post button, card settings gear -->
      <div class="mb-3 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-mpCharcoal">Content Calendar</h1>
          <p class="text-sm text-mpMuted mt-0.5">Click a day to see posts. Drag posts between days to reschedule.</p>
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <!-- View toggle (Month | Week | Agenda) -->
          <div id="view-toggle" class="inline-flex rounded-lg border border-mpBorder overflow-hidden">
            <button data-view="month" class="view-btn px-4 py-2 text-sm font-semibold transition-colors">Month</button>
            <button data-view="week" class="view-btn px-4 py-2 text-sm font-semibold transition-colors border-l border-mpBorder">Week</button>
            <button data-view="agenda" class="view-btn px-4 py-2 text-sm font-semibold transition-colors border-l border-mpBorder">Agenda</button>
          </div>
          <!-- Card settings gear -->
          <div id="card-settings-wrapper" class="relative">
            <button id="card-settings-btn" type="button" class="flex h-9 w-9 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" aria-label="Card display settings">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <div id="card-settings-dropdown" class="hidden absolute right-0 top-full mt-1 z-50 bg-white border border-mpBorder rounded-lg shadow-lg p-3 w-44">
              <p class="text-[10px] font-semibold text-mpMuted uppercase tracking-wide mb-2">Show on cards</p>
              <label class="flex items-center gap-2 text-xs text-mpCharcoal py-1 cursor-pointer">
                <input type="checkbox" class="card-setting-toggle rounded" data-card-field="showStylist" checked /> Stylist name
              </label>
              <label class="flex items-center gap-2 text-xs text-mpCharcoal py-1 cursor-pointer">
                <input type="checkbox" class="card-setting-toggle rounded" data-card-field="showPlatforms" checked /> Platforms
              </label>
              <label class="flex items-center gap-2 text-xs text-mpCharcoal py-1 cursor-pointer">
                <input type="checkbox" class="card-setting-toggle rounded" data-card-field="showTime" checked /> Published time
              </label>
              <label class="flex items-center gap-2 text-xs text-mpCharcoal py-1 cursor-pointer">
                <input type="checkbox" class="card-setting-toggle rounded" data-card-field="showCaption" checked /> Caption preview
              </label>
            </div>
          </div>
          <!-- + New Post button -->
          <a href="/manager/coordinator/upload" class="inline-flex items-center gap-1 rounded-full bg-mpAccent px-4 py-2 text-sm font-semibold text-white hover:bg-[#2E5E9E] transition-colors shadow-sm">
            <span class="text-base leading-none">+</span> New Post
          </a>
        </div>
      </div>

      <!-- Row 2: Nav arrows centered, funnel filter on left -->
      <div class="mb-4 relative flex items-center justify-center">
        <!-- Funnel filter toggle (absolute left) -->
        <button id="filter-funnel-btn" type="button" class="absolute left-0 flex h-8 w-8 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" aria-label="Toggle filters">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
        <!-- Nav arrows + month label (centered) -->
        <div id="nav-arrows" class="flex items-center gap-3">
          <a href="/manager/calendar?month=${prevMonth}"
             class="flex h-8 w-8 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" aria-label="Previous month">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </a>
          <span class="text-base font-semibold text-mpCharcoal min-w-[130px] text-center">${safe(monthLabel)}</span>
          <a href="/manager/calendar?month=${nextMonth}"
             class="flex h-8 w-8 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" aria-label="Next month">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
            </svg>
          </a>
        </div>
      </div>

      <!-- Filter bar (hidden by default, toggled by funnel icon) -->
      <div id="filter-bar" class="hidden mb-3 flex flex-wrap gap-1.5">
        <button data-filter-type="standard_post" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-700 border border-blue-200 transition-opacity">Post</button>
        <button data-filter-type="before_after" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-teal-100 text-teal-700 border border-teal-200 transition-opacity">B/A</button>
        <button data-filter-type="promotion" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700 border border-amber-200 transition-opacity">Promo</button>
        <button data-filter-type="availability" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-green-100 text-green-700 border border-green-200 transition-opacity">Avail</button>
        <button data-filter-type="celebration" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-pink-100 text-pink-700 border border-pink-200 transition-opacity">Celeb</button>
        <button data-filter-type="reel" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700 border border-indigo-200 transition-opacity">Reel</button>
        <button data-filter-type="vendor" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-700 border border-purple-200 transition-opacity">Vendor</button>
        <button data-filter-status="vendor_scheduled" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white text-purple-600 border border-purple-300 border-dashed transition-opacity">Vendor Sched</button>
        <span class="mx-1 text-mpBorder self-center">|</span>
        <button data-filter-status="manager_pending" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange-100 text-orange-700 border border-orange-200 transition-opacity">Pending</button>
        <button data-filter-status="manager_approved" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-600 border border-gray-200 transition-opacity">Scheduled</button>
        <button data-filter-status="published" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-green-100 text-green-700 border border-green-200 transition-opacity">Published</button>
        <button data-filter-status="failed" class="filter-chip inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 border border-red-200 transition-opacity">Failed</button>
      </div>

      <div id="calendar-view-body">
        <!-- Day-of-week headers -->
        <div class="grid grid-cols-7 gap-1.5 mb-1.5">
          ${DAY_HEADERS.map(d => `<div class="text-center text-[11px] font-semibold text-mpMuted py-1">${d}</div>`).join("")}
        </div>

        <!-- Calendar grid rows -->
        ${rows}

      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>
    <script>
    (function() {
      var panelEl    = document.getElementById('day-panel');
      var backdropEl = document.getElementById('day-panel-backdrop');
      var contentEl  = document.getElementById('day-panel-content');
      var titleEl    = document.getElementById('day-panel-title');
      var MONTHS     = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      window.currentDayPanelDate = null;

      window.closeDayPanel = function() {
        panelEl.classList.add('hidden');
        backdropEl.classList.add('hidden');
        window.currentDayPanelDate = null;
      };

      document.addEventListener('click', function(e) {
        if (e.target.closest('[data-action="close-day-panel"]')) closeDayPanel();
      });

      window.openDayPanel = function(date) {
        var parts = date.split('-');
        titleEl.textContent = MONTHS[parseInt(parts[1], 10)] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
        contentEl.textContent = 'Loading\u2026';
        panelEl.classList.remove('hidden');
        backdropEl.classList.remove('hidden');
        window.currentDayPanelDate = date;

        fetch('/manager/calendar/day/' + encodeURIComponent(date))
          .then(function(r) { return r.text(); })
          .then(function(html) {
            // Server escapes all user content via safe(); fragment is trusted server output
            contentEl.innerHTML = html; // eslint-disable-line no-unsanitized/property
          })
          .catch(function() {
            contentEl.textContent = 'Failed to load posts.';
          });
      };

      // ── Day cell init (click + drag) — called after every fragment swap ──────
      function initCalendarCells() {
        document.querySelectorAll('#calendar-view-body .calendar-day-cell').forEach(function(cell) {
          // skip cells already initialised
          if (cell._calInit) return;
          cell._calInit = true;

          cell.addEventListener('click', function(e) {
            if (e.target.closest('.calendar-post-card')) return;
            openDayPanel(cell.dataset.date);
          });

          if (typeof Sortable !== 'undefined') {
            Sortable.create(cell, {
              group: { name: 'calendar-posts', pull: true, put: true },
              draggable: '.calendar-post-card[data-draggable="true"]',
              animation: 0,
              ghostClass: 'opacity-40',
              onEnd: function(evt) {
                if (evt.from === evt.to) return;
                var postId    = evt.item.dataset.id;
                var newDate   = evt.to.dataset.date;
                var csrfToken = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
                fetch('/manager/calendar/reschedule', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                  body: JSON.stringify({ postId: postId, newDate: newDate }),
                })
                .then(function(r) { return r.json(); })
                .then(function(data) {
                  if (!data.ok) {
                    evt.from.insertBefore(evt.item, evt.from.firstChild);
                  } else {
                    // Refresh day panel if it's showing the source or destination date
                    var fromDate = evt.from.dataset.date;
                    var toDate   = evt.to.dataset.date;
                    var panelDate = window.currentDayPanelDate;
                    if (panelDate && (panelDate === fromDate || panelDate === toDate)) {
                      if (typeof window.openDayPanel === 'function') window.openDayPanel(panelDate);
                    }
                  }
                })
                .catch(function() { evt.from.insertBefore(evt.item, evt.from.firstChild); });
              },
            });
          }
        });
      }
      window.initCalendarCells = initCalendarCells;
      initCalendarCells();

      // ── localStorage keys and defaults ──────────────────────────────────────
      var LS_VIEW    = 'calendar_view';
      var LS_FILTERS = 'calendar_filters';
      var LS_CARD    = 'calendar_card_settings';

      var DEFAULT_FILTERS = {
        types:    { standard_post: true, before_after: true, promotion: true, availability: true, celebration: true, reel: true, vendor: true },
        statuses: { manager_pending: true, manager_approved: true, published: true, failed: true, vendor_scheduled: true }
      };
      var DEFAULT_CARD = { showStylist: true, showPlatforms: true, showTime: true, showCaption: true };

      function loadJSON(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) || fallback; }
        catch(e) { return fallback; }
      }
      function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

      // ── View toggle ──────────────────────────────────────────────────────────
      var activeView = localStorage.getItem(LS_VIEW) || 'month';

      function setActiveViewBtn(view) {
        document.querySelectorAll('.view-btn').forEach(function(btn) {
          if (btn.dataset.view === view) {
            btn.classList.add('bg-[#3B72B9]', 'text-white');
            btn.classList.remove('bg-white', 'text-[#2B2D35]', 'hover:bg-[#F8FAFC]');
          } else {
            btn.classList.remove('bg-[#3B72B9]', 'text-white');
            btn.classList.add('bg-white', 'text-[#2B2D35]', 'hover:bg-[#F8FAFC]');
          }
        });
      }

      function switchView(view) {
        localStorage.setItem(LS_VIEW, view);
        setActiveViewBtn(view);
        var navArrows = document.getElementById('nav-arrows');
        if (navArrows) {
          if (view === 'agenda' || view === 'week') {
            navArrows.classList.add('hidden');
          } else {
            navArrows.classList.remove('hidden');
          }
        }
        if (view === 'month') {
          window.location.href = '/manager/calendar' + window.location.search;
          return;
        }
        var qs = '';
        if (view === 'week') {
          var params = new URLSearchParams(window.location.search);
          var weekVal = params.get('week');
          if (weekVal) qs = '?week=' + encodeURIComponent(weekVal);
        }
        fetch('/manager/calendar/' + view + qs)
          .then(function(r) { return r.text(); })
          .then(function(html) {
            var body = document.getElementById('calendar-view-body');
            if (body) {
              body.innerHTML = html; // eslint-disable-line no-unsanitized/property
            }
            initCalendarCells();
            applyFilters();
            applyCardSettings();
          })
          .catch(function() {
            var body = document.getElementById('calendar-view-body');
            if (body) body.textContent = 'Failed to load view.';
          });
      }

      document.querySelectorAll('.view-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          switchView(btn.dataset.view);
        });
      });

      // Week nav delegation — innerHTML doesn't execute fragment scripts,
      // so handle .week-nav-btn clicks from the parent page.
      document.addEventListener('click', function(e) {
        var btn = e.target.closest('.week-nav-btn');
        if (!btn) return;
        var weekISO = btn.dataset.weekNav;
        if (!weekISO) return;
        fetch('/manager/calendar/week?week=' + encodeURIComponent(weekISO))
          .then(function(r) { return r.text(); })
          .then(function(html) {
            var body = document.getElementById('calendar-view-body');
            if (body) body.innerHTML = html; // eslint-disable-line no-unsanitized/property
            initCalendarCells();
            applyFilters();
            applyCardSettings();
          })
          .catch(function() {
            var body = document.getElementById('calendar-view-body');
            if (body) body.textContent = 'Failed to load week.';
          });
      });

      // Initialize view state on page load
      setActiveViewBtn(activeView);
      if (activeView === 'agenda' || activeView === 'week') {
        var navArrows = document.getElementById('nav-arrows');
        if (navArrows) navArrows.classList.add('hidden');
      }
      if (activeView !== 'month') {
        switchView(activeView);
      }

      // ── Filter logic ─────────────────────────────────────────────────────────
      var filters = loadJSON(LS_FILTERS, DEFAULT_FILTERS);
      // Ensure both keys exist (graceful upgrade if localStorage has old format)
      if (!filters.types) filters.types = DEFAULT_FILTERS.types;
      if (!filters.statuses) filters.statuses = DEFAULT_FILTERS.statuses;

      window.applyFilters = applyFilters;
      function applyFilters() {
        var cards = document.querySelectorAll('#calendar-view-body .calendar-post-card, #calendar-view-body .agenda-post-card');
        cards.forEach(function(card) {
          var type   = card.dataset.postType;
          var status = card.dataset.status;
          var typeOk   = filters.types[type]      !== false;
          var statusOk = filters.statuses[status] !== false;
          if (typeOk && statusOk) {
            card.classList.remove('hidden');
          } else {
            card.classList.add('hidden');
          }
        });
        checkEmptyState();
      }

      function renderFilterChips() {
        document.querySelectorAll('.filter-chip').forEach(function(chip) {
          var type   = chip.dataset.filterType;
          var status = chip.dataset.filterStatus;
          var active;
          if (type)   active = filters.types[type]      !== false;
          if (status) active = filters.statuses[status] !== false;
          if (active) {
            chip.classList.remove('opacity-30');
          } else {
            chip.classList.add('opacity-30');
          }
        });
      }

      document.querySelectorAll('.filter-chip').forEach(function(chip) {
        chip.addEventListener('click', function() {
          var type   = chip.dataset.filterType;
          var status = chip.dataset.filterStatus;
          if (type) {
            filters.types[type] = filters.types[type] === false ? true : false;
          }
          if (status) {
            filters.statuses[status] = filters.statuses[status] === false ? true : false;
          }
          saveJSON(LS_FILTERS, filters);
          renderFilterChips();
          applyFilters();
        });
      });

      renderFilterChips();
      applyFilters();

      // ── Funnel filter toggle ─────────────────────────────────────────────────
      var funnelBtn = document.getElementById('filter-funnel-btn');
      var filterBar = document.getElementById('filter-bar');
      if (funnelBtn && filterBar) {
        funnelBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          filterBar.classList.toggle('hidden');
        });
      }

      // ── Card settings ────────────────────────────────────────────────────────
      var cardSettings = loadJSON(LS_CARD, DEFAULT_CARD);

      function applyCardSettings() {
        var fieldMap = {
          showStylist:   '.card-field-stylist',
          showPlatforms: '.card-field-platforms',
          showTime:      '.card-field-time',
          showCaption:   '.card-field-caption',
        };
        Object.keys(fieldMap).forEach(function(key) {
          var selector = fieldMap[key];
          var visible  = cardSettings[key] !== false;
          document.querySelectorAll(selector).forEach(function(el) {
            el.style.display = visible ? '' : 'none';
          });
        });
      }

      window.applyCardSettings = applyCardSettings;

      // Gear dropdown open/close
      var gearBtn      = document.getElementById('card-settings-btn');
      var gearDropdown = document.getElementById('card-settings-dropdown');
      var gearWrapper  = document.getElementById('card-settings-wrapper');

      if (gearBtn && gearDropdown) {
        gearBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          gearDropdown.classList.toggle('hidden');
        });

        document.addEventListener('click', function(e) {
          if (gearWrapper && !gearWrapper.contains(e.target)) {
            gearDropdown.classList.add('hidden');
          }
        });
      }

      // Initialize checkboxes from saved settings, wire change handlers
      document.querySelectorAll('.card-setting-toggle').forEach(function(cb) {
        var field = cb.dataset.cardField;
        cb.checked = cardSettings[field] !== false;
        cb.addEventListener('change', function() {
          cardSettings[field] = cb.checked;
          saveJSON(LS_CARD, cardSettings);
          applyCardSettings();
        });
      });

      applyCardSettings();

      // ── Empty filter state ───────────────────────────────────────────────────
      function checkEmptyState() {
        var body = document.getElementById('calendar-view-body');
        if (!body) return;
        var cards   = body.querySelectorAll('.calendar-post-card, .agenda-post-card');
        var visible = Array.prototype.filter.call(cards, function(c) { return !c.classList.contains('hidden'); });
        var emptyMsg = document.getElementById('filter-empty-msg');
        if (cards.length > 0 && visible.length === 0) {
          if (!emptyMsg) {
            emptyMsg = document.createElement('p');
            emptyMsg.id = 'filter-empty-msg';
            emptyMsg.className = 'text-sm text-mpMuted text-center py-8';
            emptyMsg.textContent = 'No posts match the current filters.';
            body.appendChild(emptyMsg);
          }
          emptyMsg.style.display = '';
        } else {
          if (emptyMsg) emptyMsg.style.display = 'none';
        }
      }

      // ── Week sortable placeholder (wired in Plan 02) ─────────────────────────
      function initWeekSortable() {
        // Wired in Plan 02 when week view cells are rendered
      }

    })();
    </script>
  `;

  res.send(pageShell({ title: "Calendar", body, current: "calendar", salon_id, manager_id }));
});

// ── GET /week — Week view fragment: 7-column grid for a single week ───────────
router.get("/week", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;

  const salon = db.prepare("SELECT timezone, facebook_page_token, instagram_business_id, tiktok_enabled, google_location_id FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  // Parse ?week=YYYY-MM-DD (Sunday). Default: current week's Sunday.
  let weekStart;
  const weekParam = req.query.week;
  if (weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
    const parsed = DateTime.fromISO(weekParam, { zone: tz });
    if (parsed.isValid) {
      weekStart = parsed.startOf("day");
    }
  }
  if (!weekStart) {
    const now = DateTime.now().setZone(tz);
    // Luxon weekday: Mon=1 ... Sat=6, Sun=7
    weekStart = now.weekday === 7 ? now.startOf("day") : now.minus({ days: now.weekday }).startOf("day");
  }

  const weekEnd = weekStart.plus({ days: 6 }).endOf("day");

  // UTC range for DB query
  const rangeStartUtc = weekStart.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
  const rangeEndUtc   = weekEnd.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  const posts = db.prepare(`
    SELECT p.id, p.post_type, p.status, p.scheduled_for, p.published_at, p.stylist_name,
           p.image_url, p.image_urls, p.final_caption, p.base_caption, p.vendor_campaign_id,
           vc.vendor_name
    FROM posts p
    LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
    WHERE p.salon_id = ?
      AND p.status NOT IN ('draft', 'cancelled')
      AND (p.scheduled_for BETWEEN ? AND ? OR p.published_at BETWEEN ? AND ?)
    ORDER BY COALESCE(p.scheduled_for, p.published_at) ASC
  `).all(salon_id, rangeStartUtc, rangeEndUtc, rangeStartUtc, rangeEndUtc);

  // Group posts by local salon date
  const byDate = new Map();
  for (const post of posts) {
    const rawTs = post.scheduled_for || post.published_at;
    if (!rawTs) continue;
    let dt = DateTime.fromSQL(rawTs, { zone: "utc" });
    if (!dt.isValid) dt = DateTime.fromISO(rawTs, { zone: "utc" });
    const localDate = dt.setZone(tz).toFormat("yyyy-LL-dd");
    if (!byDate.has(localDate)) byDate.set(localDate, []);
    byDate.get(localDate).push(post);
  }

  const prevWeekISO = weekStart.minus({ weeks: 1 }).toFormat("yyyy-LL-dd");
  const nextWeekISO = weekStart.plus({ weeks: 1 }).toFormat("yyyy-LL-dd");
  const weekLabel   = `${weekStart.toFormat("MMM d")} - ${weekEnd.toFormat("MMM d, yyyy")}`;
  const today       = DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");

  const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Day-of-week headers
  let dayHeaders = "";
  for (let i = 0; i < 7; i++) {
    const d = weekStart.plus({ days: i });
    dayHeaders += `<div class="text-center text-[11px] font-semibold text-mpMuted py-1">${SHORT_DAYS[i]} ${d.month}/${d.day}</div>`;
  }

  // Week cells
  let cells = "";
  for (let i = 0; i < 7; i++) {
    const cursor  = weekStart.plus({ days: i });
    const dateStr = cursor.toFormat("yyyy-LL-dd");
    const isToday = dateStr === today;
    const isPast = dateStr < today;
    const dayPosts = byDate.get(dateStr) || [];

    const cellBg = isPast ? "bg-gray-100" : "bg-white";
    const cellBorder = isToday ? "ring-2 ring-mpAccent ring-inset" : "border border-mpBorder";

    let pills = "";
    for (const p of dayPosts) {
      const lbl         = calendarPillLabel(p);
      const barClass    = calendarCardBarClass(p);
      const isDraggable = (p.status === "manager_approved" || p.status === "vendor_scheduled") && !!p.scheduled_for;
      const iconsHtml   = platformIcons(salon, "sm");
      const postTypeNorm = normalizePostType(p);

      let publishedLine = "";
      if (p.status === "published" && p.published_at) {
        let pubDt = DateTime.fromSQL(p.published_at, { zone: "utc" });
        if (!pubDt.isValid) pubDt = DateTime.fromISO(p.published_at, { zone: "utc" });
        if (pubDt.isValid) publishedLine = `<div class="card-field-time text-[9px] text-green-600 mt-0.5 truncate">&#10003; ${pubDt.setZone(tz).toFormat("MMM d h:mm a")}</div>`;
      } else if ((p.status === "manager_approved" || p.status === "manager_pending") && p.scheduled_for) {
        let schDt = DateTime.fromSQL(p.scheduled_for, { zone: "utc" });
        if (!schDt.isValid) schDt = DateTime.fromISO(p.scheduled_for, { zone: "utc" });
        if (schDt.isValid) publishedLine = `<div class="card-field-time text-[9px] text-mpMuted mt-0.5 truncate">${schDt.setZone(tz).toFormat("h:mm a")}</div>`;
      }

      pills += `<div class="calendar-post-card relative bg-white rounded border border-mpBorder mb-1 overflow-hidden ${isDraggable ? "cursor-grab" : "cursor-default"}" data-id="${safe(p.id)}" data-post-type="${safe(postTypeNorm)}" data-status="${safe(p.status)}"${isDraggable ? ' data-draggable="true"' : ""}>
        <div class="absolute left-0 top-0 bottom-0 w-1 ${barClass}"></div>
        <div class="pl-2.5 pr-1.5 py-1">
          <div class="flex items-center justify-between gap-1">
            <span class="text-[10px] font-semibold text-mpCharcoal truncate">${safe(lbl)}</span>
            <div class="card-field-platforms">${iconsHtml}</div>
          </div>
          ${p.stylist_name ? `<div class="card-field-stylist text-[9px] text-mpMuted truncate mt-0.5">${safe(p.stylist_name)}</div>` : ""}
          <div class="card-field-caption text-[9px] text-mpMuted truncate mt-0.5">${safe((p.final_caption || p.base_caption || "").slice(0, 60))}</div>
          ${publishedLine}
        </div>
      </div>`;
    }

    cells += `
      <div class="calendar-day-cell relative min-h-[calc(100vh-220px)] p-1.5 rounded-xl ${cellBg} ${cellBorder} cursor-pointer hover:border-mpAccent/40 transition-colors"
           data-date="${dateStr}">
        ${pills}
      </div>`;
  }

  const fragment = `
    <!-- Week navigation row -->
    <div class="mb-4 flex items-center justify-center gap-3">
      <button type="button" class="week-nav-btn flex h-8 w-8 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" data-week-nav="${prevWeekISO}" aria-label="Previous week">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
      </button>
      <span class="text-base font-semibold text-mpCharcoal min-w-[180px] text-center">${safe(weekLabel)}</span>
      <button type="button" class="week-nav-btn flex h-8 w-8 items-center justify-center rounded-lg border border-mpBorder text-mpMuted hover:bg-mpBg hover:text-mpCharcoal transition-colors" data-week-nav="${nextWeekISO}" aria-label="Next week">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>
      </button>
    </div>

    <!-- Day-of-week headers -->
    <div class="grid grid-cols-7 gap-1.5 mb-1.5">
      ${dayHeaders}
    </div>

    <!-- Week grid -->
    <div class="grid grid-cols-7 gap-1.5">
      ${cells}
    </div>

    <script>
    (function() {
      // Week navigation: clicking a nav button fetches the new week fragment
      document.querySelectorAll('.week-nav-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var weekISO = btn.dataset.weekNav;
          fetch('/manager/calendar/week?week=' + encodeURIComponent(weekISO))
            .then(function(r) { return r.text(); })
            .then(function(html) {
              var body = document.getElementById('calendar-view-body');
              if (body) {
                body.innerHTML = html; // eslint-disable-line no-unsanitized/property
              }
              if (typeof window.applyFilters === 'function') window.applyFilters();
              if (typeof window.applyCardSettings === 'function') window.applyCardSettings();
            })
            .catch(function() {
              var body = document.getElementById('calendar-view-body');
              if (body) body.textContent = 'Failed to load week.';
            });
        });
      });

      // SortableJS drag-to-reschedule on each week day cell
      document.querySelectorAll('#calendar-view-body .calendar-day-cell').forEach(function(cell) {
        Sortable.create(cell, {
          group: { name: 'calendar-posts', pull: true, put: true },
          draggable: '.calendar-post-card[data-draggable="true"]',
          animation: 0,
          ghostClass: 'opacity-40',
          onEnd: function(evt) {
            if (evt.from === evt.to) return;
            var postId    = evt.item.dataset.id;
            var newDate   = evt.to.dataset.date;
            var csrfToken = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
            fetch('/manager/calendar/reschedule', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
              body: JSON.stringify({ postId: postId, newDate: newDate }),
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (!data.ok) evt.from.insertBefore(evt.item, evt.from.firstChild);
            })
            .catch(function() { evt.from.insertBefore(evt.item, evt.from.firstChild); });
          },
        });

        // Day cell click opens day panel (skip if click on a post card)
        cell.addEventListener('click', function(e) {
          if (e.target.closest('.calendar-post-card')) return;
          if (typeof window.openDayPanel === 'function') window.openDayPanel(cell.dataset.date);
        });
      });
    })();
    <\/script>
  `;

  res.send(fragment);
});

// ── GET /agenda — 30-day rolling list of posts grouped by date ────────────────
router.get("/agenda", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;

  const salon = db.prepare("SELECT timezone, facebook_page_token, instagram_business_id, tiktok_enabled, google_location_id FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  // Compute 30-day range in salon timezone
  const now       = DateTime.now().setZone(tz);
  const rangeStart = now.startOf("day");
  const rangeEnd   = rangeStart.plus({ days: 30 }).endOf("day");

  const rangeStartUtc = rangeStart.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
  const rangeEndUtc   = rangeEnd.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  const posts = db.prepare(`
    SELECT p.id, p.post_type, p.status, p.scheduled_for, p.published_at, p.stylist_name,
           p.image_url, p.image_urls, p.final_caption, p.base_caption, p.vendor_campaign_id,
           p.salon_post_number, vc.vendor_name
    FROM posts p
    LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
    WHERE p.salon_id = ?
      AND p.status NOT IN ('draft', 'cancelled')
      AND (p.scheduled_for BETWEEN ? AND ? OR p.published_at BETWEEN ? AND ?)
    ORDER BY COALESCE(p.scheduled_for, p.published_at) ASC
  `).all(salon_id, rangeStartUtc, rangeEndUtc, rangeStartUtc, rangeEndUtc);

  if (posts.length === 0) {
    res.send(`<p class="text-sm text-mpMuted text-center py-12">No upcoming posts in the next 30 days.</p>`);
    return;
  }

  // Group posts by local salon date
  const byDate = new Map();
  const dateOrder = [];
  for (const post of posts) {
    const rawTs = post.scheduled_for || post.published_at;
    if (!rawTs) continue;
    let dt = DateTime.fromSQL(rawTs, { zone: "utc" });
    if (!dt.isValid) dt = DateTime.fromISO(rawTs, { zone: "utc" });
    const localDate = dt.setZone(tz).toFormat("yyyy-LL-dd");
    if (!byDate.has(localDate)) {
      byDate.set(localDate, []);
      dateOrder.push(localDate);
    }
    byDate.get(localDate).push(post);
  }

  // Sort dates chronologically
  dateOrder.sort();

  let html = "";

  const todayStr = now.toFormat("yyyy-LL-dd");

  for (const dateStr of dateOrder) {
    const datePosts = byDate.get(dateStr);
    const dt = DateTime.fromISO(dateStr, { zone: tz });
    const isAgendaToday = dateStr === todayStr;
    const dateLabel = isAgendaToday ? `Today — ${dt.toFormat("EEEE, MMMM d")}` : dt.toFormat("EEEE, MMMM d");

    let cards = "";
    for (const p of datePosts) {
      const postTypeNorm = normalizePostType(p);

      // Thumbnail
      let imgUrl = null;
      try { imgUrl = JSON.parse(p.image_urls || "[]")[0] || p.image_url; } catch { imgUrl = p.image_url; }
      imgUrl = toProxyUrl(imgUrl);

      const thumbnail = imgUrl
        ? `<img src="${safe(imgUrl)}" alt="Post thumbnail" class="w-[60px] h-[60px] rounded-lg object-cover flex-shrink-0 border border-mpBorder" />`
        : `<div class="w-[60px] h-[60px] rounded-lg bg-mpBg flex items-center justify-center flex-shrink-0 text-2xl border border-mpBorder">&#128247;</div>`;

      // Time display
      const rawTs = p.scheduled_for || p.published_at;
      let timeDt = DateTime.fromSQL(rawTs, { zone: "utc" });
      if (!timeDt.isValid) timeDt = DateTime.fromISO(rawTs, { zone: "utc" });
      const timeDisplay = timeDt.isValid ? timeDt.setZone(tz).toFormat("h:mm a") : "";

      // Name display
      const isVendor = !!p.vendor_campaign_id;
      const nameDisplay = isVendor ? safe(p.vendor_name || "Vendor") : safe(p.stylist_name || "Unknown");

      // Type label
      const typeLabel = isVendor
        ? `<span class="text-[10px] font-semibold text-purple-700">Vendor · ${safe(p.vendor_name || "Brand")}</span>`
        : `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${calendarPillClass(p)}">${safe(calendarPillLabel(p))}</span>`;

      // Caption preview (120 chars)
      const caption = p.final_caption || p.base_caption || "";
      const preview = caption.length > 120 ? caption.slice(0, 120) + "\u2026" : caption;

      cards += `
      <div class="agenda-post-card bg-white rounded-lg border border-mpBorder p-3 shadow-sm mb-2 cursor-pointer hover:border-mpAccent/40 transition-colors" data-post-type="${safe(postTypeNorm)}" data-status="${safe(p.status)}" data-date="${safe(dateStr)}">
        <div class="flex gap-3">
          ${thumbnail}
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-0.5">
              <span class="font-medium text-sm text-mpCharcoal truncate card-field-stylist">${nameDisplay}</span>
              <span class="text-xs text-mpMuted ml-2 flex-shrink-0 card-field-time">${safe(timeDisplay)}</span>
            </div>
            <div class="card-field-platforms">${platformIcons(salon, "md")}</div>
            <div class="flex items-center gap-1.5 mt-1 flex-wrap">
              ${typeLabel}
              ${statusBadge(p.status)}
            </div>
            <p class="text-sm text-mpMuted line-clamp-2 mt-2 card-field-caption">${safe(preview)}</p>
          </div>
        </div>
      </div>`;
    }

    html += `
    <div class="mb-6">
      <h3 class="text-sm font-bold mb-2 sticky top-0 py-1 z-10 ${isAgendaToday ? "text-mpAccent bg-[#F8FAFC]" : "text-mpCharcoal bg-[#F8FAFC]"}">${safe(dateLabel)}</h3>
      ${cards}
    </div>`;
  }

  html += `
  <script>
  (function() {
    document.querySelectorAll('.agenda-post-card').forEach(function(card) {
      card.addEventListener('click', function() {
        if (typeof window.openDayPanel === 'function') window.openDayPanel(card.dataset.date);
      });
    });
  })();
  <\/script>`;

  res.send(html);
});

// ── GET /day/:date — HTML fragment for day panel ──────────────────────────────
router.get("/day/:date", requireAuth, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send("Invalid date");

  const salon_id = req.session.salon_id;
  const salon = db.prepare("SELECT timezone, facebook_page_token, instagram_business_id, tiktok_enabled, google_location_id FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  const dayStart = DateTime.fromISO(date, { zone: tz }).startOf("day");
  const dayEnd   = dayStart.endOf("day");
  const utcStart = dayStart.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
  const utcEnd   = dayEnd.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  const posts = db.prepare(`
    SELECT p.id, p.post_type, p.status, p.scheduled_for, p.published_at, p.stylist_name,
           p.image_url, p.image_urls, p.final_caption, p.base_caption,
           p.vendor_campaign_id, p.salon_post_number, vc.vendor_name
    FROM posts p
    LEFT JOIN vendor_campaigns vc ON p.vendor_campaign_id = vc.id
    WHERE p.salon_id = ?
      AND p.status NOT IN ('draft', 'cancelled')
      AND (p.scheduled_for BETWEEN ? AND ? OR p.published_at BETWEEN ? AND ?)
    ORDER BY COALESCE(p.scheduled_for, p.published_at) ASC
  `).all(salon_id, utcStart, utcEnd, utcStart, utcEnd);

  if (posts.length === 0) {
    res.send(`<p class="text-sm text-mpMuted text-center py-6">No posts on this day.</p>
      <div class="mt-4 pt-4 border-t border-mpBorder text-center">
        <a href="/manager/coordinator/upload?date=${safe(date)}" class="text-xs font-semibold text-mpAccent hover:underline">+ Post for this day</a>
      </div>`);
    return;
  }

  const cards = posts.map(p => {
    let imgUrl = null;
    try { imgUrl = JSON.parse(p.image_urls || "[]")[0] || p.image_url; }
    catch { imgUrl = p.image_url; }
    imgUrl = toProxyUrl(imgUrl);

    const caption = p.final_caption || p.base_caption || "";
    const preview = caption.length > 120 ? caption.slice(0, 120) + "\u2026" : caption;

    let timeDt = DateTime.fromSQL(p.scheduled_for || p.published_at, { zone: "utc" });
    if (!timeDt.isValid) timeDt = DateTime.fromISO(p.scheduled_for || p.published_at, { zone: "utc" });
    const timeDisplay = timeDt.isValid ? timeDt.setZone(tz).toFormat("h:mm a") : "";

    const isVendor = !!p.vendor_campaign_id;
    const nameDisplay = isVendor ? safe(p.vendor_name || "Vendor") : safe(p.stylist_name || "Unknown");
    const typeLabel = isVendor
      ? `<span class="text-[10px] font-semibold text-purple-700">Vendor · ${safe(p.vendor_name || "Brand")}</span>`
      : `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${calendarPillClass(p)}">${safe(calendarPillLabel(p))}</span>`;
    const cardStyle = isVendor ? ` style="border-left: 4px solid #7C3AED"` : "";
    const platformIconsRow = platformIcons(salon, "md");

    // CSRF token read from res.locals (set by csrf middleware on every request)
    const csrfToken = res.locals?.csrfToken || "";

    let actions = "";
    if (!isVendor) {
      if (p.status === "manager_pending") {
        actions = `
          <a href="/manager/approve?post=${safe(p.id)}&return=calendar"
             class="text-xs font-semibold text-white bg-mpAccent hover:opacity-90 px-3 py-1.5 rounded-lg transition-opacity">Approve</a>
          <button type="button" onclick="this.closest('.day-panel-card').querySelector('.deny-form').classList.toggle('hidden')"
             class="text-xs font-semibold text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-3 py-1.5 rounded-lg transition-colors">Deny</button>
          <a href="/manager/post-now?post=${safe(p.id)}&return=calendar"
             class="text-xs font-semibold text-mpAccent hover:text-mpCharcoal border border-mpBorder hover:border-mpAccent px-3 py-1.5 rounded-lg transition-colors ml-auto"
             onclick="return confirm('Publish this post right now?')">Post Now</a>`;
        actions += `
          <form method="POST" action="/manager/deny" class="deny-form hidden w-full mt-2 space-y-1">
            <input type="hidden" name="_csrf" value="${safe(csrfToken)}" />
            <input type="hidden" name="post_id" value="${safe(p.id)}" />
            <input type="hidden" name="return" value="calendar" />
            <textarea name="reason" required placeholder="Reason for denial..."
              class="w-full p-2 rounded border border-mpBorder bg-mpBg text-xs text-mpCharcoal h-16"></textarea>
            <button type="submit"
              class="text-xs font-semibold text-white bg-red-600 hover:bg-red-700 px-3 py-1.5 rounded-lg">Submit Denial</button>
          </form>`;
      } else if (p.status === "manager_approved") {
        actions = `
          <a href="/manager/post-now?post=${safe(p.id)}&return=calendar"
             class="text-xs font-semibold text-white bg-mpAccent hover:opacity-90 px-3 py-1.5 rounded-lg transition-opacity"
             onclick="return confirm('Publish this post right now?')">Post Now</a>
          <a href="/manager/cancel-post?post=${safe(p.id)}&return=calendar"
             class="text-xs font-semibold text-red-500 hover:text-red-700 border border-red-200 hover:border-red-400 px-3 py-1.5 rounded-lg transition-colors"
             onclick="return confirm('Remove from queue?')">Remove</a>`;
      } else if (p.status === "failed") {
        actions = `
          <form method="POST" action="/manager/retry-post" style="display:inline">
            <input type="hidden" name="_csrf" value="${safe(csrfToken)}" />
            <input type="hidden" name="post_id" value="${safe(p.id)}" />
            <input type="hidden" name="return" value="calendar" />
            <button type="submit" class="text-xs font-semibold text-amber-600 hover:text-amber-800 border border-amber-200 px-3 py-1.5 rounded-lg">Retry</button>
          </form>`;
      }
    }

    return `
      <div class="day-panel-card bg-white rounded-lg border border-mpBorder p-3 shadow-sm mb-3"${cardStyle}>
        <div class="flex gap-3">
          ${imgUrl
            ? `<img src="${safe(imgUrl)}" alt="Post thumbnail" class="w-[60px] h-[60px] rounded-lg object-cover flex-shrink-0 border border-mpBorder" />`
            : `<div class="w-[60px] h-[60px] rounded-lg bg-mpBg flex items-center justify-center flex-shrink-0 text-2xl border border-mpBorder">&#128247;</div>`}
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-0.5">
              <span class="font-medium text-sm text-mpCharcoal truncate">${nameDisplay}</span>
              ${timeDisplay ? `<span class="text-xs text-mpMuted ml-2 flex-shrink-0">${safe(timeDisplay)}</span>` : ""}
            </div>
            ${platformIconsRow}
            <div class="flex items-center gap-1.5 mt-1 flex-wrap">
              ${typeLabel}
              ${statusBadge(p.status)}
            </div>
            ${preview ? `<p class="text-sm text-mpMuted line-clamp-2 mt-2">${safe(preview)}</p>` : ""}
          </div>
        </div>
        ${actions ? `<div class="mt-2 pt-2 border-t border-mpBorder flex flex-wrap items-center gap-2">${actions}</div>` : ""}
      </div>`;
  }).join("");

  res.send(cards + `
    <div class="mt-4 pt-4 border-t border-mpBorder text-center">
      <a href="/manager/coordinator/upload?date=${safe(date)}" class="text-xs font-semibold text-mpAccent hover:underline">+ Post for this day</a>
    </div>`);
});

// ── POST /reschedule — Drag reschedule (preserves time-of-day, changes date) ──
router.post("/reschedule", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const { postId, newDate } = req.body;

  if (!postId || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return res.json({ ok: false, error: "Invalid input" });
  }

  const post = db.prepare(
    "SELECT scheduled_for FROM posts WHERE id = ? AND salon_id = ? AND status IN ('manager_approved', 'vendor_scheduled')"
  ).get(postId, salon_id);

  if (!post?.scheduled_for) {
    return res.json({ ok: false, error: "Post not found or not scheduled" });
  }

  const salon = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  // Convert original UTC to local salon time, replace the local date portion, convert back to UTC.
  // newDate is already a local salon date (from the calendar grid), so we must swap in local space
  // to avoid cross-midnight posts landing on the wrong calendar day.
  const original = DateTime.fromSQL(post.scheduled_for, { zone: "utc" }).setZone(tz);
  const [y, mo, d] = newDate.split("-").map(Number);
  const updated = original.set({ year: y, month: mo, day: d });
  const newTimestamp = updated.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");

  db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ? AND salon_id = ?")
    .run(newTimestamp, postId, salon_id);

  res.json({ ok: true });
});

export default router;
export { calendarPillClass };
