// src/routes/postQueue.js
// Drag-and-drop post queue manager.
// Shows all queued (manager_approved) posts sorted by scheduled_for.
// Drag to reorder — server reassigns the existing time slots to the new order.
// Mount at: /manager/queue

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

function postTypeBadge(type) {
  const map = {
    standard_post:    { label: "Standard",     color: "bg-blue-100 text-blue-700" },
    before_after:     { label: "Before/After",  color: "bg-purple-100 text-purple-700" },
    before_after_post:{ label: "Before/After",  color: "bg-purple-100 text-purple-700" },
    availability:     { label: "Availability",  color: "bg-green-100 text-green-700" },
    promotions:       { label: "Promotion",     color: "bg-orange-100 text-orange-700" },
    product_education:{ label: "Education",     color: "bg-teal-100 text-teal-700" },
    celebration:      { label: "Celebration",   color: "bg-pink-100 text-pink-700" },
  };
  const t = map[type] || { label: type || "Post", color: "bg-gray-100 text-gray-600" };
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${t.color}">${t.label}</span>`;
}

// ── GET / — Queue page ────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const salon = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  const posts = db.prepare(`
    SELECT id, stylist_name, post_type, base_caption, final_caption,
           image_url, image_urls, scheduled_for, salon_post_number
    FROM posts
    WHERE salon_id = ? AND status = 'manager_approved' AND scheduled_for IS NOT NULL
    ORDER BY datetime(scheduled_for) ASC
  `).all(salon_id);

  const cards = posts.map((p, i) => {
    const caption = p.final_caption || p.base_caption || "";
    const preview = caption.length > 110 ? caption.slice(0, 110) + "…" : caption;

    let imgUrl = null;
    try { imgUrl = JSON.parse(p.image_urls || "[]")[0] || p.image_url; }
    catch { imgUrl = p.image_url; }
    imgUrl = toProxyUrl(imgUrl);

    const scheduledDt = DateTime.fromSQL(p.scheduled_for, { zone: "utc" }).setZone(tz);
    const timeDisplay = scheduledDt.toFormat("EEE, MMM d · h:mm a");

    return `
      <div class="queue-card group flex items-center gap-3 bg-white border border-mpBorder rounded-2xl px-4 py-3
                  cursor-default select-none hover:border-mpAccent/40 transition-colors"
           data-id="${safe(p.id)}">

        <!-- Drag handle -->
        <div class="drag-handle flex-shrink-0 cursor-grab active:cursor-grabbing text-mpBorder group-hover:text-mpMuted transition-colors">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
            <circle cx="7" cy="4" r="1.4"/><circle cx="13" cy="4" r="1.4"/>
            <circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/>
            <circle cx="7" cy="16" r="1.4"/><circle cx="13" cy="16" r="1.4"/>
          </svg>
        </div>

        <!-- Position -->
        <div class="position-num flex-shrink-0 w-5 text-center text-xs font-bold text-mpMuted">${i + 1}</div>

        <!-- Thumbnail (click to enlarge) -->
        <div class="flex-shrink-0 w-11 h-11 rounded-xl overflow-hidden bg-mpBg border border-mpBorder cursor-zoom-in"
             data-preview="${safe(imgUrl || '')}">
          ${imgUrl
            ? `<img src="${safe(imgUrl)}" class="w-full h-full object-cover pointer-events-none" />`
            : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px">📷</div>`}
        </div>

        <!-- Content -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-0.5">
            ${postTypeBadge(p.post_type)}
            <span class="text-xs text-mpMuted truncate">${safe(p.stylist_name || "Unknown")}</span>
          </div>
          <p class="text-sm text-mpCharcoal leading-snug line-clamp-1">${safe(preview)}</p>
        </div>

        <!-- Scheduled time + remove -->
        <div class="flex-shrink-0 text-right min-w-[130px]">
          <div class="scheduled-time text-xs font-semibold text-mpCharcoal">${timeDisplay}</div>
          <div class="text-[10px] text-mpMuted mt-0.5">Post #${safe(String(p.salon_post_number || "—"))}</div>
          <a href="/manager/cancel-post?post=${safe(p.id)}"
             class="text-[10px] text-red-400 hover:text-red-600 mt-1 inline-block"
             onclick="return confirm('Remove this post from the queue?')">Remove</a>
        </div>
      </div>`;
  }).join("");

  const body = `
    <div class="max-w-3xl mx-auto">
      <div class="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 class="text-2xl font-bold text-mpCharcoal">Post Queue</h1>
          <p class="text-sm text-mpMuted mt-0.5">
            Drag posts to reorder. Existing time slots are preserved — only the post order changes.
          </p>
        </div>
        <span class="flex-shrink-0 text-sm text-mpMuted">${posts.length} queued</span>
      </div>

      ${posts.length === 0 ? `
        <div class="text-center py-24 text-mpMuted">
          <div class="text-5xl mb-4">📭</div>
          <p class="font-semibold text-mpCharcoal mb-1">Nothing in the queue</p>
          <p class="text-sm">Approved posts will appear here ready to reorder.</p>
        </div>
      ` : `
        <div id="queue-list" class="space-y-2">
          ${cards}
        </div>

        <!-- Save status -->
        <div id="save-status"
             class="mt-4 text-center text-xs text-mpMuted opacity-0 transition-opacity duration-300">
          ✓ Order saved
        </div>
      `}
    </div>

    <!-- Image lightbox -->
    <div id="img-lightbox"
         style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out"
         onclick="this.style.display='none'">
      <img id="img-lightbox-img" src="" alt=""
           style="max-width:90vw;max-height:90vh;border-radius:12px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.6)" />
    </div>

    <script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js"></script>
    <script>
    (function() {
      const list = document.getElementById('queue-list');
      if (!list) return;

      // Thumbnail click → lightbox
      list.addEventListener('click', function(e) {
        const thumb = e.target.closest('[data-preview]');
        if (!thumb) return;
        const src = thumb.getAttribute('data-preview');
        if (!src) return;
        const lb = document.getElementById('img-lightbox');
        document.getElementById('img-lightbox-img').src = src;
        lb.style.display = 'flex';
      });

      const statusEl = document.getElementById('save-status');
      let saveTimer = null;

      function flashStatus(msg, isError) {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = isError ? '#dc2626' : '#6B7280';
        statusEl.style.opacity = '1';
        clearTimeout(statusEl._hideTimer);
        statusEl._hideTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 2500);
      }

      function updatePositions() {
        list.querySelectorAll('.position-num').forEach((el, i) => { el.textContent = i + 1; });
      }

      function saveOrder() {
        const ids = [...list.querySelectorAll('.queue-card')].map(el => el.dataset.id);
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
        flashStatus('Saving…', false);
        fetch('/manager/queue/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ ids }),
        })
        .then(r => r.json())
        .then(data => {
          if (!data.ok) { flashStatus('⚠ Save failed', true); return; }
          // Update displayed times to reflect new slot assignments
          list.querySelectorAll('.scheduled-time').forEach((el, i) => {
            if (data.slots[i]) el.textContent = data.slots[i];
          });
          flashStatus('✓ Order saved', false);
        })
        .catch(() => flashStatus('⚠ Save failed — try again', true));
      }

      Sortable.create(list, {
        handle: '.drag-handle',
        animation: 150,
        ghostClass: 'opacity-40',
        onEnd() {
          updatePositions();
          clearTimeout(saveTimer);
          saveTimer = setTimeout(saveOrder, 500);
        },
      });
    })();
    </script>
  `;

  res.send(pageShell({ title: "Post Queue", body, salon_id, current: "queue" }));
});

// ── POST /reorder — Reassign time slots to new order ─────────────────────────
router.post("/reorder", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) return res.json({ ok: false });

  const salon = db.prepare("SELECT timezone FROM salons WHERE slug = ?").get(salon_id);
  const tz = salon?.timezone || "America/Indiana/Indianapolis";

  // Fetch current scheduled times for only these posts (verify they belong to this salon)
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT id, scheduled_for FROM posts
    WHERE salon_id = ? AND id IN (${placeholders}) AND status = 'manager_approved'
  `).all(salon_id, ...ids);

  if (rows.length !== ids.length) return res.json({ ok: false });

  // Extract slots sorted chronologically — these are the "time positions" to fill
  const slots = rows
    .map(r => r.scheduled_for)
    .sort((a, b) => new Date(a) - new Date(b));

  // Assign slots to new post order in a single transaction
  const update = db.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ? AND salon_id = ?");
  db.transaction(() => {
    ids.forEach((id, i) => update.run(slots[i], id, salon_id));
  })();

  // Return formatted times for the client to update displayed values
  const formattedSlots = slots.map(s =>
    DateTime.fromSQL(s, { zone: "utc" }).setZone(tz).toFormat("EEE, MMM d · h:mm a")
  );

  res.json({ ok: true, slots: formattedSlots });
});

export default router;
