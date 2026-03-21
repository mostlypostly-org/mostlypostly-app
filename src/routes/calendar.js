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

// Color-coded pill class per post type (failed overrides, vendor overrides type)
function calendarPillClass(post) {
  if (post.status === "failed") return "bg-red-100 text-red-700";
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
    manager_pending:  { label: "Pending Approval", color: "bg-yellow-100 text-yellow-700" },
    manager_approved: { label: "Scheduled",        color: "bg-blue-100 text-blue-700" },
    published:        { label: "Published",         color: "bg-green-100 text-green-700" },
    failed:           { label: "Failed",            color: "bg-red-100 text-red-700" },
  };
  const s = map[status] || { label: status, color: "bg-gray-100 text-gray-600" };
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.color}">${safe(s.label)}</span>`;
}

// ── GET / — Calendar month grid ───────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const manager_id = req.session.manager_id;

  const salon = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
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

  // Compute Sunday-based grid start (5 weeks to cover any month)
  let gridStart = monthStart.startOf("week"); // Luxon weeks start Monday by default
  // Adjust back to Sunday if the week doesn't start on Sunday (weekday 7 = Sunday in Luxon)
  if (gridStart.weekday !== 7) gridStart = gridStart.minus({ days: gridStart.weekday });
  const gridEnd = gridStart.plus({ weeks: 5 }).endOf("day");

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
  for (let week = 0; week < 5; week++) {
    let cells = "";
    for (let dow = 0; dow < 7; dow++) {
      const dateStr = cursor.toFormat("yyyy-LL-dd");
      const isCurrentMonth = cursor.month === monthStart.month;
      const isToday = dateStr === today;
      const dayPosts = byDate.get(dateStr) || [];

      const dayNumClass = isCurrentMonth
        ? "text-xs font-semibold text-mpCharcoal"
        : "text-xs font-semibold text-gray-300";

      const cellBorder = isToday
        ? "ring-2 ring-mpAccent ring-inset"
        : "border border-mpBorder";

      let pills = "";
      const visible = dayPosts.slice(0, 3);
      for (const p of visible) {
        const cls = calendarPillClass(p);
        const lbl = calendarPillLabel(p);
        const isDraggable = p.status === "manager_approved" && !!p.scheduled_for;
        pills += `<div class="calendar-post-card ${isDraggable ? "cursor-grab" : "cursor-default"} px-1.5 py-0.5 rounded text-[10px] font-semibold truncate mb-0.5 ${cls}" data-id="${safe(p.id)}"${isDraggable ? ' data-draggable="true"' : ""}>${safe(lbl)}</div>`;
      }
      if (dayPosts.length > 3) {
        pills += `<div class="text-[9px] text-mpMuted font-semibold pl-0.5">+${dayPosts.length - 3} more</div>`;
      }

      cells += `
        <div class="calendar-day-cell relative min-h-[100px] p-1.5 rounded-xl bg-white ${cellBorder} cursor-pointer hover:border-mpAccent/40 transition-colors"
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
      <!-- Month navigation header -->
      <div class="mb-5 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-mpCharcoal">Content Calendar</h1>
          <p class="text-sm text-mpMuted mt-0.5">Click a day to see posts. Drag posts between days to reschedule.</p>
        </div>
        <div class="flex items-center gap-3">
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

      <!-- Day-of-week headers -->
      <div class="grid grid-cols-7 gap-1.5 mb-1.5">
        ${DAY_HEADERS.map(d => `<div class="text-center text-[11px] font-semibold text-mpMuted py-1">${d}</div>`).join("")}
      </div>

      <!-- Calendar grid rows -->
      ${rows}

      <!-- Color legend -->
      <div class="mt-4 flex flex-wrap gap-2 items-center">
        <span class="text-[11px] text-mpMuted font-semibold mr-1">Key:</span>
        ${[
          ["bg-blue-100 text-blue-700",    "Post"],
          ["bg-teal-100 text-teal-700",    "Before/After"],
          ["bg-amber-100 text-amber-700",  "Promo"],
          ["bg-green-100 text-green-700",  "Avail"],
          ["bg-pink-100 text-pink-700",    "Celeb"],
          ["bg-indigo-100 text-indigo-700","Reel"],
          ["bg-purple-100 text-purple-700","Vendor"],
          ["bg-red-100 text-red-700",      "Failed"],
        ].map(([cls, lbl]) => `<span class="inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${cls}">${lbl}</span>`).join("")}
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

      window.closeDayPanel = function() {
        panelEl.classList.add('hidden');
        backdropEl.classList.add('hidden');
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

      document.querySelectorAll('.calendar-day-cell').forEach(function(cell) {
        cell.addEventListener('click', function(e) {
          if (e.target.closest('.calendar-post-card')) return;
          openDayPanel(cell.dataset.date);
        });
      });

      document.querySelectorAll('.calendar-day-cell').forEach(function(cell) {
        Sortable.create(cell, {
          group: { name: 'calendar-posts', pull: true, put: true },
          draggable: '.calendar-post-card[data-draggable="true"]',
          animation: 150,
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
      });
    })();
    </script>
  `;

  res.send(pageShell({ title: "Calendar", body, current: "calendar", salon_id, manager_id }));
});

// ── GET /day/:date — HTML fragment for day panel ──────────────────────────────
router.get("/day/:date", requireAuth, (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).send("Invalid date");

  const salon_id = req.session.salon_id;
  const salon = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
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
    res.send(`<p class="text-sm text-mpMuted text-center py-6">No posts on this day.</p>`);
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
    const typeLabel = isVendor
      ? `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-700">${safe(p.vendor_name || "Vendor")}</span>`
      : `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${calendarPillClass(p)}">${safe(calendarPillLabel(p))}</span>`;

    // CSRF token read from res.locals (set by csrf middleware on every request)
    const csrfToken = res.locals?.csrfToken || "";

    let actions = "";
    if (p.status === "manager_pending") {
      actions = `
        <a href="/manager/approve?post=${safe(p.id)}&return=calendar"
           class="text-[11px] text-green-600 hover:text-green-800 font-semibold">Approve</a>
        <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden')"
           class="text-[11px] text-red-400 hover:text-red-600 font-semibold">Deny</button>
        <a href="/manager/post-now?post=${safe(p.id)}&return=calendar"
           class="text-[11px] text-mpAccent hover:text-mpCharcoal font-semibold ml-auto"
           onclick="return confirm('Publish this post right now?')">Post Now</a>`;
      // Inline deny form (initially hidden, toggled by Deny button above)
      actions += `
        <form method="POST" action="/manager/deny" class="hidden w-full mt-2 space-y-1">
          <input type="hidden" name="_csrf" value="${safe(csrfToken)}" />
          <input type="hidden" name="post_id" value="${safe(p.id)}" />
          <input type="hidden" name="return" value="calendar" />
          <textarea name="reason" required placeholder="Reason for denial..."
            class="w-full p-2 rounded border border-mpBorder bg-mpBg text-xs text-mpCharcoal h-16"></textarea>
          <button type="submit"
            class="text-[11px] font-semibold text-white bg-red-600 hover:bg-red-700 px-3 py-1 rounded">Submit Denial</button>
        </form>`;
    } else if (p.status === "manager_approved") {
      actions = `
        <a href="/manager/post-now?post=${safe(p.id)}&return=calendar"
           class="text-[11px] text-mpAccent hover:text-mpCharcoal font-semibold"
           onclick="return confirm('Publish this post right now?')">Post Now</a>
        <a href="/manager/cancel-post?post=${safe(p.id)}"
           class="text-[11px] text-red-400 hover:text-red-600 font-semibold"
           onclick="return confirm('Remove from queue?')">Remove</a>`;
    } else if (p.status === "failed") {
      actions = `
        <form method="POST" action="/manager/retry-post" style="display:inline">
          <input type="hidden" name="_csrf" value="${safe(csrfToken)}" />
          <input type="hidden" name="post_id" value="${safe(p.id)}" />
          <input type="hidden" name="return" value="calendar" />
          <button type="submit" class="text-[11px] text-amber-600 hover:text-amber-800 font-semibold">Retry</button>
        </form>`;
    }

    return `
      <div class="border border-mpBorder rounded-xl p-3 mb-3">
        <div class="flex gap-3">
          ${imgUrl
            ? `<img src="${safe(imgUrl)}" alt="Post thumbnail" class="w-14 h-14 rounded-lg object-cover flex-shrink-0 border border-mpBorder" />`
            : `<div class="w-14 h-14 rounded-lg bg-mpBg flex items-center justify-center flex-shrink-0 text-2xl">&#128247;</div>`}
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 flex-wrap mb-1">
              ${typeLabel}
              ${statusBadge(p.status)}
              ${timeDisplay ? `<span class="text-[10px] text-mpMuted">${safe(timeDisplay)}</span>` : ""}
            </div>
            <p class="text-xs text-mpMuted truncate mb-0.5">${safe(p.stylist_name || "Unknown")}</p>
            <p class="text-xs text-mpCharcoal line-clamp-2 leading-relaxed">${safe(preview)}</p>
          </div>
        </div>
        ${actions ? `<div class="mt-2 pt-2 border-t border-mpBorder flex flex-wrap items-center gap-3">${actions}</div>` : ""}
      </div>`;
  }).join("");

  res.send(cards);
});

// ── POST /reschedule — Drag reschedule (preserves time-of-day, changes date) ──
router.post("/reschedule", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const { postId, newDate } = req.body;

  if (!postId || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
    return res.json({ ok: false, error: "Invalid input" });
  }

  const post = db.prepare(
    "SELECT scheduled_for FROM posts WHERE id = ? AND salon_id = ? AND status = 'manager_approved'"
  ).get(postId, salon_id);

  if (!post?.scheduled_for) {
    return res.json({ ok: false, error: "Post not found or not scheduled" });
  }

  // Parse as UTC, replace date portion only (preserves time-of-day component)
  const original = DateTime.fromSQL(post.scheduled_for, { zone: "utc" });
  const [y, mo, d] = newDate.split("-").map(Number);
  const updated = original.set({ year: y, month: mo, day: d });
  const newTimestamp = updated.toFormat("yyyy-LL-dd HH:mm:ss");

  db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ? AND salon_id = ?")
    .run(newTimestamp, postId, salon_id);

  res.json({ ok: true });
});

export default router;
export { calendarPillClass };
