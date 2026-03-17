// ───────────────────────────────────────────────────────────
// Admin Router — Fully synced with /public/admin.js modal system
// ───────────────────────────────────────────────────────────

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";
import crypto from "crypto";
import { isContentSafe, sanitizeText } from "../../src/utils/moderation.js";

import { UPLOADS_DIR } from "../core/uploadPath.js";
import { PLAN_LIMITS } from "./billing.js";
import { sendWelcomeSms } from "../core/stylistWelcome.js";
import { generateCelebrationImage } from "../core/celebrationImageGen.js";
import { generateCelebrationCaption } from "../core/celebrationCaption.js";
import { TEMPLATE_META } from "../core/postTemplates.js";
import { buildAvailabilityImage } from "../core/buildAvailabilityImage.js";

const managerPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `manager-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const stockPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `stock-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const stylistPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `stylist-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const salonLogoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".png";
      cb(null, `salon-logo-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const router = express.Router();

// ───────────────────────────────────────────────────────────
// Auth middleware (your existing requireAuth)
// ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.manager || !req.manager.manager_phone) {
    return res.redirect("/manager/login");
  }
  next();
}

// Helper: Format times into human-readable format
function fmtTime(val) {
  if (!val) return "—";
  const [h, m] = val.split(":").map((x) => parseInt(x, 10));
  const dt = DateTime.fromObject({ hour: h, minute: m || 0 });
  return dt.toFormat("h:mm a");
}

// Serve admin modal templates
// NOTE: must use res.send (not res.sendFile) so the CSRF middleware can inject
// the _csrf token into form fields before the content reaches the browser.
router.get("/templates", (req, res) => {
  const filePath = path.join(process.cwd(), "public", "admin-templates.html");
  const html = fs.readFileSync(filePath, "utf8");
  res.type("html").send(html);
});


// ───────────────────────────────────────────────────────────
// GET /manager/admin — Render Admin Page
// ───────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id;
  const manager_phone = req.manager?.manager_phone;

  // Load salon row
  const salonRow = db
    .prepare(`SELECT * FROM salons WHERE slug = ?`)
    .get(salon_id);

  if (!salonRow) {
    return res.send(
      pageShell({
        title: "Admin — Not Found",
        body: `<div class="text-red-400 font-semibold">Salon not found in database.</div>`,
        salon_id,
        manager_phone,
        current: "admin",
      })
    );
  }

  // Members
  const dbStylists = db
    .prepare(
      `SELECT id, name, phone, instagram_handle, specialties, photo_url
       FROM stylists
       WHERE salon_id = ?
       ORDER BY name ASC`
    )
    .all(salon_id);

  // Role check
  const isOwner = (() => {
    const mgr = db.prepare("SELECT role FROM managers WHERE id = ?").get(req.manager.id);
    return !mgr || mgr.role === "owner";
  })();

  // MFA status for this manager
  const mfaEnabled = !!db.prepare("SELECT manager_id FROM manager_mfa WHERE manager_id = ?").get(req.manager.id);
  const mfaError = req.query.mfa_error;
  const mfaMsg   = req.query.mfa === "disabled" ? "Two-factor authentication has been disabled."
                 : req.query.mfa === "already_enabled" ? "MFA is already enabled on this account."
                 : null;

  // Last 10 security events for this manager
  const securityEvents = db.prepare(
    `SELECT event_type, ip_address, created_at FROM security_events
     WHERE manager_id = ? ORDER BY created_at DESC LIMIT 10`
  ).all(req.manager.id);

  // Open issues for this salon flagged by stylists
  const openIssues = (() => {
    try {
      return db.prepare(
        `SELECT * FROM platform_issues WHERE salon_id = ? AND status != 'resolved' ORDER BY created_at DESC`
      ).all(salon_id);
    } catch { return []; }
  })();

  // Feature requests for this salon
  const allRequests = (() => {
    try {
      return db.prepare(`
        SELECT fr.*,
               (SELECT 1 FROM feature_request_votes WHERE feature_request_id = fr.id AND salon_id = ?) AS my_vote
        FROM feature_requests
        WHERE status != 'declined'
        ORDER BY vote_count DESC, fr.created_at DESC
        LIMIT 50
      `).all(salon_id);
    } catch { return []; }
  })();

  const statusLabel = { submitted: 'Submitted', under_review: 'Under Review', planned: '📅 Planned', live: '✅ Live', declined: 'Declined' };
  const statusColor = { submitted: 'bg-gray-100 text-gray-600', under_review: 'bg-blue-100 text-blue-700', planned: 'bg-purple-100 text-purple-700', live: 'bg-green-100 text-green-700', declined: 'bg-red-100 text-red-600' };

  const featureRequestsHtml = allRequests.length === 0
    ? `<div class="px-6 py-8 text-center text-sm text-mpMuted">No requests yet — be the first to submit an idea!</div>`
    : `<div class="divide-y">${allRequests.map(r => `
    <div class="px-6 py-4 flex gap-4 items-start">
      <form method="POST" action="/manager/admin/feature-requests/${r.id}/vote" class="flex flex-col items-center shrink-0 w-12">
        <button type="submit" class="text-lg ${r.my_vote ? 'text-mpAccent' : 'text-gray-300 hover:text-mpAccent'}" title="${r.my_vote ? 'Remove vote' : 'Vote for this'}">▲</button>
        <span class="text-sm font-bold text-mpCharcoal">${r.vote_count}</span>
      </form>
      <div class="flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <p class="text-sm font-medium text-mpCharcoal">${r.title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>
          <span class="text-xs px-2 py-0.5 rounded-full shrink-0 ${statusColor[r.status] || statusColor.submitted}">${statusLabel[r.status] || r.status}</span>
        </div>
        ${r.description ? `<p class="text-xs text-mpMuted mt-0.5">${r.description.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</p>` : ''}
        <p class="text-xs text-mpMuted mt-1">${new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
      </div>
    </div>
  `).join('')}</div>`;

  // Brand palette
  let brandPalette = null;
  try {
    if (salonRow.brand_palette) brandPalette = JSON.parse(salonRow.brand_palette);
  } catch {}

  const celebTemplate = salonRow.celebration_template || "script";
  const availTemplate = salonRow.availability_template || "script";

  // Normalize hashtags
  let defaultHashtags = [];
  if (
    typeof salonRow.default_hashtags === "string" &&
    salonRow.default_hashtags.trim().length
  ) {
    try {
      const parsed = JSON.parse(salonRow.default_hashtags);
      if (Array.isArray(parsed)) defaultHashtags = parsed;
      else defaultHashtags = salonRow.default_hashtags.split(",");
    } catch {
      defaultHashtags = salonRow.default_hashtags.split(",");
    }
  }

  defaultHashtags = defaultHashtags
    .map((t) => String(t || "").trim())
    .filter((t) => t.length)
    .map((t) => {
      const cleaned = t.replace(/^#+/, "");
      return `#${cleaned}`;
    })
    .slice(0, 5);

  const info = {
    name: salonRow.name,
    logo_url: salonRow.logo_url || "",
    address: salonRow.address || "",
    city: salonRow.city || "",
    state: salonRow.state || "",
    zip: salonRow.zip || "",
    website: salonRow.website,
    booking_url: salonRow.booking_url,
    timezone: salonRow.timezone || "America/Indiana/Indianapolis",
    industry: salonRow.industry || "Hair Salon",
    tone_profile: salonRow.tone || "default",
    auto_publish: !!salonRow.auto_publish,
    default_hashtags: defaultHashtags,
  };

  // Parse per-day posting schedule (migration 020)
  const DEFAULT_DAY_SCHEDULE = (start = "09:00", end = "20:00") => ({
    monday:    { enabled: true,  start, end },
    tuesday:   { enabled: true,  start, end },
    wednesday: { enabled: true,  start, end },
    thursday:  { enabled: true,  start, end },
    friday:    { enabled: true,  start, end },
    saturday:  { enabled: true,  start: "10:00", end: "18:00" },
    sunday:    { enabled: false, start: "10:00", end: "18:00" },
  });

  let postingSchedule;
  try {
    postingSchedule = salonRow.posting_schedule
      ? JSON.parse(salonRow.posting_schedule)
      : DEFAULT_DAY_SCHEDULE(
          salonRow.posting_start_time || "09:00",
          salonRow.posting_end_time   || "20:00"
        );
  } catch {
    postingSchedule = DEFAULT_DAY_SCHEDULE();
  }

  const settings = {
    posting_window: {
      start: salonRow.posting_start_time || "09:00",
      end: salonRow.posting_end_time || "20:00",
    },
    posting_schedule: postingSchedule,
    require_manager_approval: !!salonRow.require_manager_approval,
    random_delay_minutes: {
      min: salonRow.spacing_min ?? 20,
      max: salonRow.spacing_max ?? 45,
    },
  };

  // Build Admin Page HTML
  const body = `
    ${req.query.notice ? `<div class="rounded-xl border border-green-200 bg-green-50 px-4 py-3 mb-4 text-xs text-green-800 font-medium">${req.query.notice}</div>` : ""}
    ${!isOwner ? `
    <div class="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 mb-4 flex items-center gap-2 text-xs text-yellow-800">
      <svg class="w-4 h-4 flex-shrink-0 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
      <span><strong>Manager view</strong> — Settings below are read-only. Contact your account owner to make changes.</span>
    </div>
    ` : ""}

    <!-- Tab Navigation -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold mb-4">Admin</h1>
      <div class="flex gap-1 border-b border-mpBorder overflow-x-auto" id="admin-tabs" style="position:relative;z-index:10">
        <button type="button" data-tab="business" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:#3B72B9;color:#3B72B9">Business</button>
        <button type="button" data-tab="branding" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:transparent;color:#7A7C85">Branding</button>
        <button type="button" data-tab="posting" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:transparent;color:#7A7C85">Posting</button>
        <button type="button" data-tab="photos" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:transparent;color:#7A7C85">Stock Photos</button>
        <button type="button" data-tab="security" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:transparent;color:#7A7C85">Security</button>
        <button type="button" data-tab="feedback" class="admin-tab-btn px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 cursor-pointer" style="border-color:transparent;color:#7A7C85">Issues &amp; Feedback${openIssues.length > 0 ? ` <span style="margin-left:4px;display:inline-flex;align-items:center;background:#ffedd5;padding:1px 6px;border-radius:9999px;font-size:11px;font-weight:600;color:#c2410c">${openIssues.length}</span>` : ""}</button>
      </div>
    </div>

    <div ${!isOwner ? 'class="opacity-50 pointer-events-none select-none"' : ""}>

    <!-- BUSINESS TAB -->
    <div id="admin-panel-business" class="admin-panel">

    <!-- SOCIAL CONNECTIONS -->
    <section class="mb-6 grid gap-4 md:grid-cols-[1.2fr,0.8fr]">

      <!-- Facebook & Instagram -->
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <h2 class="text-sm font-semibold text-mpCharcoal mb-2">Facebook & Instagram</h2>
        <dl class="space-y-1 text-xs text-mpCharcoal">
          <div class="flex justify-between">
            <dt class="text-mpMuted">Facebook Page ID</dt>
            <dd>${salonRow.facebook_page_id || "Not configured"}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-mpMuted">Instagram Handle</dt>
            <dd>${
              salonRow.instagram_handle
                ? "@" + salonRow.instagram_handle
                : "Not configured"
            }</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-mpMuted">Facebook Page Token</dt>
            <dd>${salonRow.facebook_page_token ? "Stored ✓" : "Not configured"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-mpMuted">Instagram Business ID</dt>
            <dd>${salonRow.instagram_business_id || "Not configured"}</dd>
          </div>
        </dl>

        <div class="mt-4">
          <a href="/auth/facebook/login?salon=${salon_id}"
             class="inline-flex items-center px-3 py-2 rounded-md text-sm font-medium bg-mpCharcoal text-white hover:bg-mpCharcoalDark">
            Connect / Refresh Facebook & Instagram
          </a>
        </div>
        <p class="mt-2 text-[11px] text-mpCharcoal0">
              Uses your MostlyPostly Facebook App to grant or refresh Page & Instagram permissions.
            </p>
      </div>

      <!-- Salon Info -->
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold text-mpCharcoal">Business Info</h2>
          <a href="/manager/admin/edit/business-info" class="text-xs text-mpAccent hover:text-mpCharcoal font-medium">Edit</a>
        </div>

        <!-- Logo -->
        <div class="mb-3 flex items-center gap-3">
          <div class="w-14 h-14 rounded-xl border border-mpBorder bg-mpBg flex items-center justify-center overflow-hidden flex-shrink-0">
            ${info.logo_url
              ? `<img src="${info.logo_url}" alt="Logo" class="w-full h-full object-contain" />`
              : `<span class="text-xl text-mpMuted">🏪</span>`
            }
          </div>
          <form method="POST" action="/manager/admin/update-salon-logo" enctype="multipart/form-data" class="flex-1">
            <input type="hidden" name="salon_id" value="${salon_id}" />
            <label class="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-mpBorder
              bg-mpBg text-xs font-medium text-mpMuted hover:border-mpAccent hover:text-mpCharcoal transition-colors">
              <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
              </svg>
              Upload Logo
              <input type="file" name="logo" accept="image/*" class="hidden" onchange="this.closest('form').submit()" />
            </label>
          </form>
        </div>

        <dl class="space-y-1 text-xs text-mpCharcoal">

          <div class="flex justify-between"><dt class="text-mpMuted">Name</dt><dd>${
            info.name
          }</dd></div>

          ${info.address ? `<div class="flex justify-between"><dt class="text-mpMuted">Address</dt><dd class="text-right max-w-[60%]">${info.address}</dd></div>` : ""}

          <div class="flex justify-between"><dt class="text-mpMuted">City / State</dt><dd>${
            [info.city, info.state, info.zip].filter(Boolean).join(", ") || "Not set"
          }</dd></div>

          <div class="flex justify-between"><dt class="text-mpMuted">Website</dt><dd>${
            info.website
              ? `<a href="${info.website}" target="_blank" class="underline text-blue-400">Visit</a>`
              : "Not set"
          }</dd></div>

          <div class="flex justify-between"><dt class="text-mpMuted">Industry</dt><dd>${
            info.industry
          }</dd></div>

          <div class="flex justify-between"><dt class="text-mpMuted">Timezone</dt><dd>${
            info.timezone
          }</dd></div>

          <div class="flex justify-between">
            <dt class="text-mpMuted">Booking URL</dt>
            <dd>${
              info.booking_url
                ? `<a href="${info.booking_url}" target="_blank" class="underline text-blue-400">Visit</a>`
                : "Not set"
            }</dd>
          </div>

          <div class="flex justify-between"><dt class="text-mpMuted">Tone Profile</dt><dd>${
            info.tone_profile
          }</dd></div>

          <!-- Hashtags -->
          <div class="flex flex-col gap-1 mt-2">
            <div class="flex justify-between mb-1">
              <dt class="text-mpMuted">Default Hashtags</dt>
            </div>
            <dd class="flex flex-wrap gap-1">
              <!-- Primary salon tag (locked) -->
              <span class="inline-flex bg-mpBg px-2 py-0.5 rounded-full text-[11px] font-semibold">
                ${info.default_hashtags[0] || ""}
              </span>

              <!-- Custom tags -->
              ${info.default_hashtags
                .slice(1)
                .map(
                  (tag) =>
                    `<span class="inline-flex bg-mpBg px-2 py-0.5 rounded-full text-[11px]">${tag}</span>`
                )
                .join("")}
            </dd>

          </div>

        </dl>
      </div>
    </section>

    <!-- TEAM MEMBERS — in Business tab -->
    ${(() => {
      const planLimits = PLAN_LIMITS[salonRow.plan] || PLAN_LIMITS.trial;
      const stylistLimit = planLimits.stylists; // null = unlimited (Pro)
      const atLimit = stylistLimit !== null && dbStylists.length >= stylistLimit;
      const pct = stylistLimit ? Math.round((dbStylists.length / stylistLimit) * 100) : 0;
      const barColor = pct >= 100 ? "bg-red-400" : pct >= 75 ? "bg-yellow-400" : "bg-mpAccent";
      return `
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4 flex flex-col justify-between">
        <div>
          <h2 class="text-sm font-semibold text-mpCharcoal mb-1">Team Members</h2>
          <p class="text-xs text-mpMuted mb-3">
            Add stylists, set tone variants, upload profile photos, configure birthdays and anniversaries,
            and manage celebration posts — all from the Team page.
          </p>
          ${stylistLimit !== null ? `
          <div class="mb-2">
            <div class="flex justify-between text-xs mb-1">
              <span class="text-mpMuted">Stylists used</span>
              <span class="font-semibold text-mpCharcoal">${dbStylists.length} / ${stylistLimit}</span>
            </div>
            <div class="w-full bg-gray-100 rounded-full h-1.5">
              <div class="${barColor} h-1.5 rounded-full" style="width:${Math.min(100,pct)}%"></div>
            </div>
          </div>
          ${atLimit ? `<p class="text-xs text-red-500 font-medium mb-1">Stylist limit reached. <a href="/manager/billing" class="underline text-mpAccent">Upgrade to add more →</a></p>` : ""}
          ` : `<p class="text-xs text-mpMuted mb-1">${dbStylists.length} stylists · <span class="text-mpCharcoal font-medium">Unlimited</span> on Pro</p>`}
        </div>
        <div class="mt-3">
          <a href="/manager/stylists?salon=${salon_id}"
             class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
            Manage Team
          </a>
        </div>
      </div>
    </section>`;
    })()}

    </div><!-- end admin-panel-business -->

    <!-- POSTING TAB -->
    <div id="admin-panel-posting" class="admin-panel hidden">

    <!-- POSTING RULES — moved to Scheduler page -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <!-- Scheduler link card -->
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4 flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-1">
            <h2 class="text-sm font-semibold text-mpCharcoal">Posting Availability</h2>
          </div>
          <p class="text-xs text-mpMuted mb-3">Days and times when posts can be published, in your salon's timezone.</p>
          <dl class="space-y-1 text-xs text-mpCharcoal mb-4">
            ${(() => {
              const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
              const labels = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
              const sched = postingSchedule;
              return days.map(d => {
                const cfg = sched[d];
                if (!cfg || !cfg.enabled) {
                  return `<div class="flex justify-between"><dt class="text-mpMuted">${labels[d]}</dt><dd class="text-gray-400">Off</dd></div>`;
                }
                return `<div class="flex justify-between"><dt class="text-mpMuted">${labels[d]}</dt><dd>${fmtTime(cfg.start)} – ${fmtTime(cfg.end)}</dd></div>`;
              }).join("");
            })()}
            <div class="flex justify-between pt-1 border-t border-mpBorder mt-1">
              <dt class="text-mpMuted">Spacing</dt>
              <dd>${settings.random_delay_minutes.min}–${settings.random_delay_minutes.max} min</dd>
            </div>
          </dl>
        </div>
        <a href="/manager/scheduler?salon=${salon_id}"
           class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors self-start">
          Open Scheduler Settings
        </a>
      </div>

      <!-- Manager Rules -->
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-mpCharcoal">Manager Rules</h2>
          <a href="/manager/admin/edit/manager-rules" class="text-xs text-mpAccent hover:text-mpCharcoal font-medium">Edit</a>
        </div>

        <dl class="space-y-1 text-xs text-mpCharcoal">
          <div class="flex justify-between">
            <dt class="text-mpMuted">Require Manager Approval</dt>
            <dd>${salonRow.require_manager_approval ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-mpMuted">Notify member on approval</dt>
            <dd>${salonRow.notify_on_approval ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-mpMuted">Notify member on denial</dt>
            <dd>${salonRow.notify_on_denial ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-mpMuted">Auto Publish</dt>
            <dd>${info.auto_publish ? "Enabled" : "Disabled"}</dd>
          </div>
        </dl>
      </div>
    </section>

    </div><!-- end admin-panel-posting -->

    <!-- BRANDING TAB -->
    <div id="admin-panel-branding" class="admin-panel hidden">

    <!-- BRAND PALETTE -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-sm font-semibold text-mpCharcoal">Brand Color Palette</h2>
            <p class="text-[11px] text-mpMuted mt-0.5">Extracted from your website during setup. Used in AI-generated promotion images.</p>
          </div>
          <a href="/manager/admin/extract-brand"
             class="text-xs text-mpAccent hover:text-mpCharcoal underline whitespace-nowrap">
            Re-extract
          </a>
        </div>
        ${brandPalette ? `
        <div class="flex flex-wrap gap-4">
          ${[
            { key: "primary",      label: "Primary" },
            { key: "secondary",    label: "Secondary" },
            { key: "accent",       label: "Accent" },
            { key: "accent_light", label: "Accent Light" },
            { key: "cta",          label: "CTA / Button" },
          ].map(({ key, label }) => {
            const hex = brandPalette[key] || null;
            return hex ? `
              <div class="flex flex-col items-center gap-1.5">
                <div class="w-12 h-12 rounded-xl border border-mpBorder shadow-sm" style="background:${hex}"></div>
                <p class="text-[10px] font-bold text-mpMuted uppercase tracking-wide">${label}</p>
                <p class="text-[10px] font-mono text-mpCharcoal">${hex}</p>
              </div>` : "";
          }).join("")}
        </div>
        <p class="mt-3 text-[10px] text-mpMuted">
          These colors are automatically applied to promotion image overlays instead of the default gold theme.
          <a href="/manager/admin/extract-brand" class="underline text-mpAccent ml-1">Re-extract palette</a>
        </p>
        ` : `
        <div class="flex items-center gap-3 py-3">
          <div class="flex gap-2">
            ${["#e0e0e0","#c8c8c8","#b0b0b0","#989898","#808080"].map(c =>
              `<div class="w-10 h-10 rounded-xl border border-mpBorder" style="background:${c}"></div>`
            ).join("")}
          </div>
          <div>
            <p class="text-xs text-mpMuted">No palette extracted yet.</p>
            <a href="/manager/admin/extract-brand" class="text-xs text-mpAccent underline">
              ${salonRow.website ? "Extract colors from your website →" : "Set up brand palette →"}
            </a>
          </div>
        </div>
        `}
      </div>
    </section>

    <!-- CELEBRATION POST STYLE -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5">
        <h2 class="text-sm font-semibold text-mpCharcoal mb-1">Celebration Post Style</h2>
        <p class="text-xs text-mpMuted mb-4">Choose a visual template for birthday and anniversary posts. Preview any template with a test stylist before saving.</p>

        <!-- Template cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
          ${Object.entries(TEMPLATE_META.celebration).map(([key, meta]) => {
            const isActive = key === celebTemplate;
            return `
            <div class="relative rounded-xl border-2 p-4
              ${isActive ? "border-mpAccent bg-mpAccentLight" : "border-mpBorder bg-mpBg"}">
              ${isActive ? `<div class="absolute top-2 right-2 w-5 h-5 rounded-full bg-mpAccent flex items-center justify-center">
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
              </div>` : ""}
              <p class="text-sm font-semibold text-mpCharcoal pr-6">${meta.label}</p>
              <p class="text-xs text-mpMuted mt-0.5 mb-3">${meta.desc}</p>
              <form method="POST" action="/manager/admin/celebration-template">
                <input type="hidden" name="template" value="${key}" />
                <button type="submit"
                  class="text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors
                    ${isActive
                      ? "border-mpAccent bg-mpAccent text-white cursor-default"
                      : "border-mpBorder bg-white text-mpCharcoal hover:border-mpAccent hover:text-mpAccent"}">
                  ${isActive ? "Active" : "Set as Default"}
                </button>
              </form>
            </div>`;
          }).join("")}
        </div>

        <!-- Preview generator -->
        <div class="rounded-xl border border-mpBorder bg-mpBg px-4 py-4">
          <p class="text-xs font-semibold text-mpCharcoal mb-3">Generate a test preview (opens in new tab — no post created)</p>
          <form method="GET" action="/manager/admin/celebration-preview" target="_blank"
                class="flex flex-wrap gap-3 items-end">
            <div>
              <label class="block text-[11px] text-mpMuted mb-1">Template</label>
              <select name="template" class="rounded-lg border border-mpBorder bg-white px-3 py-2 text-sm text-mpCharcoal focus:outline-none focus:border-mpAccent">
                ${Object.entries(TEMPLATE_META.celebration).map(([key, meta]) =>
                  `<option value="${key}" ${key === celebTemplate ? "selected" : ""}>${meta.label}</option>`
                ).join("")}
              </select>
            </div>
            <div>
              <label class="block text-[11px] text-mpMuted mb-1">Stylist</label>
              <select name="stylist" class="rounded-lg border border-mpBorder bg-white px-3 py-2 text-sm text-mpCharcoal focus:outline-none focus:border-mpAccent">
                ${db.prepare("SELECT id, name FROM stylists WHERE salon_id = ? ORDER BY name ASC").all(salon_id)
                  .map(s => `<option value="${s.id}">${s.name}</option>`).join("") || '<option value="">No stylists yet</option>'}
              </select>
            </div>
            <div>
              <label class="block text-[11px] text-mpMuted mb-1">Type</label>
              <select name="type" class="rounded-lg border border-mpBorder bg-white px-3 py-2 text-sm text-mpCharcoal focus:outline-none focus:border-mpAccent">
                <option value="birthday">Birthday</option>
                <option value="anniversary">Anniversary</option>
              </select>
            </div>
            <button type="submit"
              class="rounded-full bg-mpCharcoal px-5 py-2 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
              Preview →
            </button>
          </form>
        </div>
      </div>
    </section>

    <!-- AVAILABILITY POST STYLE SECTION -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5">
        <h2 class="text-sm font-semibold text-mpCharcoal mb-1">Availability Post Style</h2>
        <p class="text-xs text-mpMuted mb-4">Choose a visual template for availability posts. Preview any template before saving.</p>

        <!-- Template cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
          ${Object.entries(TEMPLATE_META.availability).map(([key, meta]) => {
            const isActive = key === availTemplate;
            return `
            <div class="relative rounded-xl border-2 p-4
              ${isActive ? "border-mpAccent bg-mpAccentLight" : "border-mpBorder bg-mpBg"}">
              ${isActive ? `<div class="absolute top-2 right-2 w-5 h-5 rounded-full bg-mpAccent flex items-center justify-center">
                <svg class="w-3 h-3 text-white" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
              </div>` : ""}
              <p class="text-sm font-semibold text-mpCharcoal pr-6">${meta.label}</p>
              <p class="text-xs text-mpMuted mt-0.5 mb-3">${meta.desc}</p>
              <form method="POST" action="/manager/admin/availability-template">
                <input type="hidden" name="template" value="${key}" />
                <button type="submit"
                  class="text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors
                    ${isActive
                      ? "border-mpAccent bg-mpAccent text-white cursor-default"
                      : "border-mpBorder bg-white text-mpCharcoal hover:border-mpAccent hover:text-mpAccent"}">
                  ${isActive ? "Active" : "Set as Default"}
                </button>
              </form>
            </div>`;
          }).join("")}
        </div>

        <!-- Preview generator -->
        <div class="rounded-xl border border-mpBorder bg-mpBg px-4 py-4">
          <p class="text-xs font-semibold text-mpCharcoal mb-3">Generate a test preview (opens in new tab — no post created)</p>
          <form method="GET" action="/manager/admin/availability-preview" target="_blank"
                class="flex flex-wrap gap-3 items-end">
            <div>
              <label class="block text-[11px] text-mpMuted mb-1">Template</label>
              <select name="template" class="rounded-lg border border-mpBorder bg-white px-3 py-2 text-sm text-mpCharcoal focus:outline-none focus:border-mpAccent">
                ${Object.entries(TEMPLATE_META.availability).map(([key, meta]) =>
                  `<option value="${key}" ${key === availTemplate ? "selected" : ""}>${meta.label}</option>`
                ).join("")}
              </select>
            </div>
            <div>
              <label class="block text-[11px] text-mpMuted mb-1">Stylist</label>
              <select name="stylist" class="rounded-lg border border-mpBorder bg-white px-3 py-2 text-sm text-mpCharcoal focus:outline-none focus:border-mpAccent">
                ${db.prepare("SELECT id, name FROM stylists WHERE salon_id = ? ORDER BY name ASC").all(salon_id)
                  .map(s => `<option value="${s.id}">${s.name}</option>`).join("") || '<option value="">No stylists yet</option>'}
              </select>
            </div>
            <button type="submit"
              class="rounded-full bg-mpCharcoal px-5 py-2 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
              Preview →
            </button>
          </form>
        </div>
      </div>
    </section>

    </div><!-- end admin-panel-branding -->

    <!-- SECURITY TAB -->
    <div id="admin-panel-security" class="admin-panel hidden">

    <!-- ACCOUNT SECURITY -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5">
        <h2 class="text-sm font-semibold text-mpCharcoal mb-1">Account Security</h2>
        <p class="text-xs text-mpMuted mb-4">Protect your account with two-factor authentication. Required when using booking system or ad integrations.</p>

        ${mfaMsg ? `<div class="rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-xs text-green-700 font-medium mb-3">${mfaMsg}</div>` : ""}
        ${mfaError === "wrong_password" ? `<div class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600 font-medium mb-3">Incorrect password — MFA not disabled.</div>` : ""}

        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-mpCharcoal">Two-Factor Authentication (TOTP)</span>
            ${mfaEnabled
              ? `<span class="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">● Enabled</span>`
              : `<span class="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-mpMuted">Not enabled</span>`
            }
          </div>
          ${mfaEnabled
            ? `<button onclick="document.getElementById('mfa-disable-form').classList.toggle('hidden')" class="text-xs text-red-400 hover:text-red-600 underline">Disable</button>`
            : `<a href="/manager/mfa/setup" class="inline-flex items-center gap-1 rounded-full bg-mpCharcoal px-4 py-1.5 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">Enable MFA →</a>`
          }
        </div>

        ${mfaEnabled ? `
        <div id="mfa-disable-form" class="hidden border-t border-mpBorder pt-4 mt-2">
          <p class="text-xs text-mpMuted mb-2">Enter your password to confirm disabling MFA.</p>
          <form method="POST" action="/manager/mfa/disable" class="flex gap-2 items-center">
            <input type="password" name="password" placeholder="Your password" required
              class="flex-1 text-sm rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-mpCharcoal placeholder:text-gray-400 focus:outline-none focus:border-mpAccent" />
            <button type="submit" class="rounded-full bg-red-500 hover:bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors">Disable</button>
          </form>
        </div>` : ""}

        ${securityEvents.length ? `
        <div class="border-t border-mpBorder pt-3 mt-3">
          <p class="text-xs font-semibold text-mpCharcoal mb-2">Recent Security Events</p>
          <div class="space-y-1">
            ${securityEvents.map(e => `
              <div class="flex justify-between text-[11px]">
                <span class="${e.event_type.includes('failure') || e.event_type.includes('mfa_disable') ? 'text-red-500' : 'text-mpMuted'}">${e.event_type.replace(/_/g,' ')}</span>
                <span class="text-mpMuted">${e.created_at}</span>
              </div>`).join("")}
          </div>
        </div>` : ""}
      </div>
    </section>

    </div><!-- end admin-panel-security -->

                <!-- Modal Backdrop -->
        <div
          id="admin-modal-backdrop"
          class="hidden fixed inset-0 bg-black/60 backdrop-blur-sm z-40">
        </div>

        <!-- Modal Wrapper -->
        <div
          id="admin-modal"
          class="hidden fixed inset-0 z-50 flex items-center justify-center p-6">
          <div
            id="admin-modal-panel"
            class="relative w-full max-w-lg rounded-2xl bg-white border border-mpBorder p-6 shadow-xl">

            <!-- PERMANENT CLOSE BUTTON (NOT OVERWRITTEN) -->
            <button
              id="admin-modal-close"
              type="button"
              class="absolute top-3 right-3 text-lg text-mpMuted hover:text-mpCharcoal">
              ✕
            </button>

            <!-- THIS is what admin.js replaces on openModal -->
            <div id="admin-modal-content"></div>
          </div>
        </div>

        <!-- Load Modal Templates -->
        <div
          id="admin-templates-root"
          class="hidden"
          data-url="/manager/admin/templates"

          data-salon-id="${salon_id}"

          data-name="${info.name}"
          data-address="${info.address}"
          data-city="${info.city}"
          data-state="${info.state}"
          data-zip="${info.zip}"
          data-website="${info.website}"
          data-industry="${salonRow.industry || ""}"
          data-booking-url="${info.booking_url}"
          data-timezone="${info.timezone}"
          data-tone="${info.tone_profile}"
          data-auto-publish="${info.auto_publish ? "1" : "0"}"

          data-posting-schedule='${JSON.stringify(settings.posting_schedule)}'
          data-posting-start="${settings.posting_window.start}"
          data-posting-end="${settings.posting_window.end}"
          data-spacing-min="${settings.random_delay_minutes.min}"
          data-spacing-max="${settings.random_delay_minutes.max}"

          data-require-manager-approval="${settings.require_manager_approval ? "1" : "0"}"
          data-auto-approval="${salonRow.auto_approval ? "1" : "0"}"
          data-notify-approval="${salonRow.notify_on_approval ? "1" : "0"}"
          data-notify-denial="${salonRow.notify_on_denial ? "1" : "0"}"

          data-salon-tag="${info.default_hashtags[0] || ""}"
          data-custom-hashtags='${JSON.stringify(info.default_hashtags.slice(1))}'
        ></div>

        <!-- Admin modal templates inlined — loaded from DOM, no async fetch -->
        <div id="admin-modal-templates" class="hidden">
          ${fs.readFileSync(path.join(process.cwd(), "public", "admin-templates.html"), "utf8")}
        </div>

  </div><!-- end owner-only sections -->

  <!-- STOCK PHOTOS TAB PANEL (outside owner-only div — editable by all managers) -->
  <div id="admin-panel-photos" class="admin-panel hidden">
  ${(() => {
    const stockPhotos = db.prepare(
      `SELECT sp.id, sp.label, sp.url
       FROM stock_photos sp
       WHERE sp.salon_id = ? AND sp.stylist_id IS NULL
       ORDER BY sp.created_at DESC`
    ).all(salon_id);

    const stylists = db.prepare(
      `SELECT id, name FROM stylists WHERE salon_id = ? ORDER BY name ASC`
    ).all(salon_id);

    const managers = db.prepare(
      `SELECT id, name FROM managers WHERE salon_id = ? ORDER BY name ASC`
    ).all(salon_id);

    const photoCards = stockPhotos.length
      ? stockPhotos.map(p => `
          <div class="flex items-center gap-3 bg-mpBg rounded-xl p-3">
            <img src="${p.url}" class="w-16 h-16 rounded-lg object-cover border border-mpBorder flex-shrink-0" />
            <div class="flex-1 min-w-0">
              <p class="text-sm text-mpCharcoal font-medium truncate">${p.label || "Unlabeled"}</p>
              <p class="text-xs text-mpMuted">${p.stylist_name ? "Stylist: " + p.stylist_name : "Salon-wide"}</p>
            </div>
            <form method="POST" action="/manager/admin/stock-photos/delete?salon=${salon_id}" class="flex-shrink-0">
              <input type="hidden" name="photo_id" value="${p.id}" />
              <button class="text-xs text-red-400 hover:text-red-600 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors">Remove</button>
            </form>
          </div>
        `).join("")
      : `<p class="text-mpMuted text-xs italic py-2">No stock photos uploaded yet.</p>`;

    const stylistOptions = [
      ...managers.map(m => `<option value="${m.id}">${m.name} (Manager)</option>`),
      ...stylists.map(s => `<option value="${s.id}">${s.name}</option>`),
    ].join("");

    return `
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <div class="flex items-center justify-between mb-1">
          <h2 class="text-sm font-semibold text-mpCharcoal">Stock Photos</h2>
          <span class="text-[11px] text-mpMuted">${stockPhotos.length} photo${stockPhotos.length !== 1 ? "s" : ""}</span>
        </div>
        <p class="text-[11px] text-mpMuted mb-4">Background images used for availability and promotion posts. Upload salon-wide photos here. To add photos for a specific stylist, use the <a href="/manager/stylists?salon=${salon_id}" class="text-mpAccent underline">Team → Edit Stylist → Photo Library</a> page.</p>

        <div class="space-y-2 mb-5">
          ${photoCards}
        </div>

        <form method="POST" action="/manager/admin/stock-photos/upload?salon=${salon_id}"
              enctype="multipart/form-data"
              class="border border-mpBorder rounded-xl p-4 space-y-3 bg-mpBg">
          <h3 class="text-xs font-bold text-mpCharcoal">Upload New Photo</h3>
          <input type="file" name="stock_photo" accept="image/*" required
            class="w-full text-sm text-mpMuted file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0
                   file:text-xs file:font-semibold file:bg-mpAccentLight file:text-mpAccent
                   hover:file:bg-mpAccent hover:file:text-white transition-colors" />
          <div class="grid grid-cols-2 gap-3">
            <input name="label" placeholder="Label (optional)"
              class="w-full border border-mpBorder rounded-xl px-3 py-2 text-sm text-mpCharcoal bg-white focus:outline-none focus:ring-2 focus:ring-mpAccent" />
            <select name="category" class="w-full border border-mpBorder rounded-xl px-3 py-2 text-sm text-mpCharcoal bg-white focus:outline-none focus:ring-2 focus:ring-mpAccent">
              <option value="general">General</option>
              <option value="interior">Interior</option>
              <option value="exterior">Exterior</option>
              <option value="education">Education</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label class="block text-[11px] text-mpMuted mb-1">Link to a stylist (optional)</label>
            <select name="stylist_id" class="w-full border border-mpBorder rounded-xl px-3 py-2 text-sm text-mpCharcoal bg-white focus:outline-none focus:ring-2 focus:ring-mpAccent">
              <option value="">Salon-wide</option>
              ${stylistOptions}
            </select>
          </div>
          <button class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
            Upload Stock Photo
          </button>
        </form>
      </div>
    </section>
    `;
  })()}
  </div><!-- end admin-panel-photos -->

  <!-- ISSUES & FEEDBACK TAB PANEL (outside owner-only div — accessible to all managers) -->
  <div id="admin-panel-feedback" class="admin-panel hidden">
    ${openIssues.length > 0 ? `
    <!-- Stylist Issues Alert -->
    <section class="mb-6">
      <div class="rounded-2xl border border-orange-200 bg-orange-50 px-5 py-4">
        <div class="flex items-start gap-3">
          <div class="text-orange-500 text-xl mt-0.5">⚠️</div>
          <div class="flex-1">
            <h2 class="text-sm font-semibold text-orange-800 mb-1">
              Availability Data Issue${openIssues.length > 1 ? "s" : ""}
              <span class="ml-2 inline-flex items-center rounded-full bg-orange-200 px-2 py-0.5 text-xs font-semibold text-orange-800">${openIssues.length} open</span>
            </h2>
            <p class="text-xs text-orange-700 mb-3">
              One or more stylists reported their availability looked incorrect. This usually means appointments in your salon software don't match what the system found. Please verify appointments are entered correctly.
            </p>
            <div class="space-y-2">
              ${openIssues.map(issue => `
                <div class="text-xs bg-white rounded-lg border border-orange-100 px-3 py-2 flex items-center justify-between">
                  <div>
                    <span class="font-medium text-orange-800">${issue.stylist_name || "Unknown stylist"}</span>
                    <span class="text-orange-500 ml-2">${new Date(issue.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    <span class="ml-2 text-orange-400">${(issue.issue_type || "").replace(/_/g, " ")}</span>
                  </div>
                  <span class="text-orange-400 capitalize">${issue.status}</span>
                </div>
              `).join("")}
            </div>
            <p class="text-xs text-orange-600 mt-3">Issues are reviewed by MostlyPostly support. If you need immediate help, contact <a href="mailto:support@mostlypostly.com" class="underline font-medium">support@mostlypostly.com</a>.</p>
          </div>
        </div>
      </div>
    </section>
    ` : ""}

    <!-- Feature Requests -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white overflow-hidden">
        <div class="px-6 py-4 border-b">
          <h2 class="font-semibold text-mpCharcoal">Feature Requests &amp; Ideas</h2>
          <p class="text-xs text-mpMuted mt-0.5">Submit ideas, vote on what matters most. Our team reviews all submissions.</p>
        </div>

        <!-- Submit new request form -->
        <div class="px-6 py-4 border-b bg-gray-50">
          <form method="POST" action="/manager/admin/feature-requests" class="space-y-3">
            <div>
              <label class="block text-xs font-medium text-mpCharcoal mb-1">Your idea (required)</label>
              <input type="text" name="title" required maxlength="120" placeholder="e.g. Auto-schedule posts for peak engagement times"
                class="w-full border border-mpBorder rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mpAccent/20">
            </div>
            <div>
              <label class="block text-xs font-medium text-mpCharcoal mb-1">More detail (optional)</label>
              <textarea name="description" rows="2" maxlength="500" placeholder="Describe the problem it solves or how you'd use it..."
                class="w-full border border-mpBorder rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-mpAccent/20 resize-none"></textarea>
            </div>
            <button type="submit" class="px-4 py-2 bg-mpAccent text-white text-sm font-medium rounded-lg hover:bg-mpCharcoalDark transition-colors">
              Submit Idea
            </button>
          </form>
        </div>

        <!-- Feature request list (loaded server-side) -->
        ${featureRequestsHtml}
      </div>
    </section>
  </div><!-- end admin-panel-feedback -->

  <script>
  (function() {
    var ACCENT = '#3B72B9';
    var MUTED  = '#7A7C85';
    var validTabs = ['business','branding','posting','photos','security','feedback'];

    function adminTab(name) {
      // Hide all panels
      document.querySelectorAll('.admin-panel').forEach(function(p) {
        p.style.display = 'none';
      });
      // Reset all tab buttons
      document.querySelectorAll('.admin-tab-btn').forEach(function(b) {
        b.style.borderColor = 'transparent';
        b.style.color = MUTED;
      });
      // Show target panel
      var panel = document.getElementById('admin-panel-' + name);
      if (panel) panel.style.display = 'block';
      // Activate target button
      var btn = document.querySelector('[data-tab="' + name + '"]');
      if (btn) {
        btn.style.borderColor = ACCENT;
        btn.style.color = ACCENT;
      }
      history.replaceState(null, '', location.pathname + '#' + name);
    }

    // Wire up click handlers
    document.getElementById('admin-tabs').addEventListener('click', function(e) {
      var btn = e.target.closest('[data-tab]');
      if (btn) adminTab(btn.getAttribute('data-tab'));
    });

    // Restore from hash, or show default
    var hash = location.hash.replace('#', '');
    adminTab(validTabs.includes(hash) ? hash : 'business');
  })();
  </script>

  `;

  // Render page
  res.send(
    pageShell({
      title: "Admin",
      body,
      salon_id,
      manager_phone,
      manager_id: req.manager.id,
      current: "admin",
    })
  );
});

// -------------------------------------------------------
// GET: Re-extract brand palette from website
// -------------------------------------------------------
router.get("/extract-brand", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT website FROM salons WHERE slug = ?").get(salon_id);
  if (!salon?.website) {
    return res.redirect("/manager/admin?notice=No+website+configured.+Set+a+website+in+Business+Info+first.");
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const resp = await fetch(salon.website, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
    const html = await resp.text();
    const snippet = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<img[^>]*>/gi, "")
      .slice(0, 8000);

    const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `You are a brand color extractor. Given website HTML, identify the 5 key brand colors.
Return ONLY valid JSON with these exact keys:
{ "primary": "#hex", "secondary": "#hex", "accent": "#hex", "accent_light": "#hex", "cta": "#hex" }
All values must be hex color codes. No markdown, no explanation.`,
          },
          { role: "user", content: snippet },
        ],
      }),
    });
    const data = await gptResp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    const palette = JSON.parse(raw.replace(/```json|```/g, "").trim());
    db.prepare("UPDATE salons SET brand_palette = ?, updated_at = datetime('now') WHERE slug = ?")
      .run(JSON.stringify(palette), salon_id);
    return res.redirect("/manager/admin?notice=Brand+colors+updated.");
  } catch (err) {
    console.error("[Admin] Brand extraction failed:", err.message);
    return res.redirect("/manager/admin?notice=Could+not+extract+colors.+Try+again+or+check+your+website+URL.");
  }
});

// -------------------------------------------------------
// GET: Edit Business Info page
// -------------------------------------------------------
router.get("/edit/business-info", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const manager_phone = req.manager?.manager_phone;
  const row = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salon_id);
  if (!row) return res.redirect("/manager/admin");

  let defaultHashtags = [];
  try {
    const parsed = JSON.parse(row.default_hashtags || "[]");
    defaultHashtags = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const salonTag = defaultHashtags[0] || "";
  const customTags = defaultHashtags.slice(1);

  const tzOptions = [
    ["America/New_York",               "Eastern (US & Canada)"],
    ["America/Chicago",                "Central (US & Canada)"],
    ["America/Indiana/Indianapolis",   "Eastern — Indiana"],
    ["America/Denver",                 "Mountain (US & Canada)"],
    ["America/Phoenix",                "Mountain (No DST) — Arizona"],
    ["America/Los_Angeles",            "Pacific (US & Canada)"],
    ["America/Anchorage",              "Alaska"],
    ["Pacific/Honolulu",               "Hawaii"],
  ];
  const cur_tz = row.timezone || "America/Indiana/Indianapolis";

  const industryOptions = ["Hair Salon","Beauty Salon","Nail Salon","Spa","Barber Shop","Med Spa"];
  const toneOptions = ["Professional","Fun & Energetic","Clean & Modern","Bold & Trendy","Warm & Friendly","Minimalistic","Classic Salon Voice"];

  const inputCls = "w-full mt-1 border border-mpBorder bg-mpBg rounded-lg px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none focus:ring-2 focus:ring-mpAccent/20";

  const body = `
    <div class="max-w-lg mx-auto">
      <div class="mb-6 flex items-center gap-3">
        <a href="/manager/admin" class="text-mpMuted hover:text-mpCharcoal text-sm">← Admin</a>
        <h1 class="text-xl font-bold text-mpCharcoal">Edit Business Info</h1>
      </div>

      <form method="POST" action="/manager/admin/update-salon-info" class="space-y-4 bg-white rounded-2xl border border-mpBorder p-6 mb-6">
        <div>
          <label class="text-xs font-semibold text-mpMuted">Salon Name</label>
          <input name="name" value="${row.name || ""}" class="${inputCls}" />
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Street Address</label>
          <input name="address" value="${row.address || ""}" placeholder="123 Main St" class="${inputCls}" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs font-semibold text-mpMuted">City</label>
            <input name="city" value="${row.city || ""}" class="${inputCls}" />
          </div>
          <div>
            <label class="text-xs font-semibold text-mpMuted">State</label>
            <select name="state" class="${inputCls}">
              <option value="">Select State</option>
              ${["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","MA","MD","ME","MI","MN","MO","MS","MT","NC","ND","NE","NH","NJ","NM","NV","NY","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VA","VT","WA","WI","WV","WY"]
                .map(s => `<option value="${s}"${row.state === s ? " selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">ZIP</label>
          <input name="zip" value="${row.zip || ""}" class="${inputCls}" />
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Website</label>
          <input name="website" value="${row.website || ""}" class="${inputCls}" />
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Booking URL</label>
          <input name="booking_url" value="${row.booking_url || ""}" class="${inputCls}" />
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Industry</label>
          <select name="industry" class="${inputCls}">
            ${industryOptions.map(o => `<option${row.industry === o ? " selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Timezone</label>
          <select name="timezone" class="${inputCls}">
            ${tzOptions.map(([val, label]) => `<option value="${val}"${cur_tz === val ? " selected" : ""}>${label}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Brand Voice / Tone</label>
          <select name="tone_profile" class="${inputCls}">
            ${toneOptions.map(o => `<option${(row.tone || "") === o ? " selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
        <!-- Default Hashtags (merged into same form) -->
        <div id="hashtags" class="border-t border-mpBorder pt-4 mt-2">
          <p class="text-xs font-semibold text-mpMuted mb-3">Default Hashtags</p>
          <div class="space-y-3">
            <div>
              <label class="text-xs font-semibold text-mpMuted">Primary Salon Tag</label>
              <input name="salon_tag" value="${salonTag}" class="${inputCls}" />
              <p class="text-[11px] text-mpMuted mt-1">Used on every post. Usually your salon handle.</p>
            </div>
            <div>
              <label class="text-xs font-semibold text-mpMuted">Custom Hashtags (up to 2, space or comma separated)</label>
              <input name="custom_tags_raw" value="${customTags.join(" ")}"
                placeholder="#balayage #haircolor" class="${inputCls}" />
              <p class="text-[11px] text-mpMuted mt-1">Max 3 total (salon tag + 2 custom). Stylists can add up to 2 more on each post.</p>
            </div>
          </div>
        </div>

        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-semibold rounded-full py-2.5 transition-colors">Save Changes</button>
          <a href="/manager/admin" class="flex-1 text-center border border-mpBorder rounded-full py-2.5 text-sm text-mpMuted hover:text-mpCharcoal transition-colors">Cancel</a>
        </div>
      </form>
    </div>`;

  res.send(pageShell({ title: "Edit Business Info", body, salon_id, manager_phone, current: "admin" }));
});

// -------------------------------------------------------
// GET: Edit Manager Rules page
// -------------------------------------------------------
router.get("/edit/manager-rules", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const manager_phone = req.manager?.manager_phone;
  const row = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salon_id);
  if (!row) return res.redirect("/manager/admin");

  const selectCls = "w-full mt-1 border border-mpBorder bg-mpBg rounded-lg px-3 py-2 text-sm text-mpCharcoal focus:border-mpAccent focus:outline-none focus:ring-2 focus:ring-mpAccent/20";
  const sel = (val) => val ? ' selected' : '';

  const body = `
    <div class="max-w-lg mx-auto">
      <div class="mb-6 flex items-center gap-3">
        <a href="/manager/admin" class="text-mpMuted hover:text-mpCharcoal text-sm">← Admin</a>
        <h1 class="text-xl font-bold text-mpCharcoal">Edit Manager Rules</h1>
      </div>
      <form method="POST" action="/manager/admin/update-manager-rules" class="space-y-4 bg-white rounded-2xl border border-mpBorder p-6">
        <div>
          <label class="text-xs font-semibold text-mpMuted">Require Manager Approval</label>
          <p class="text-[11px] text-mpMuted mb-1">When enabled, all stylist posts require your approval before publishing.</p>
          <select name="require_manager_approval" class="${selectCls}">
            <option value="0"${sel(!row.require_manager_approval)}>Disabled</option>
            <option value="1"${sel(row.require_manager_approval)}>Enabled</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Auto Publish</label>
          <p class="text-[11px] text-mpMuted mb-1">Automatically publish approved posts on schedule without manual confirmation.</p>
          <select name="auto_publish" class="${selectCls}">
            <option value="0"${sel(!row.auto_publish)}>Disabled</option>
            <option value="1"${sel(row.auto_publish)}>Enabled</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Notify Stylist on Approval</label>
          <select name="notify_on_approval" class="${selectCls}">
            <option value="0"${sel(!row.notify_on_approval)}>Disabled</option>
            <option value="1"${sel(row.notify_on_approval)}>Enabled</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-semibold text-mpMuted">Notify Stylist on Denial</label>
          <select name="notify_on_denial" class="${selectCls}">
            <option value="0"${sel(!row.notify_on_denial)}>Disabled</option>
            <option value="1"${sel(row.notify_on_denial)}>Enabled</option>
          </select>
        </div>
        <div class="flex gap-3 pt-2">
          <button type="submit" class="flex-1 bg-mpCharcoal hover:bg-mpCharcoalDark text-white font-semibold rounded-full py-2.5 transition-colors">Save</button>
          <a href="/manager/admin" class="flex-1 text-center border border-mpBorder rounded-full py-2.5 text-sm text-mpMuted hover:text-mpCharcoal transition-colors">Cancel</a>
        </div>
      </form>
    </div>`;

  res.send(pageShell({ title: "Manager Rules", body, salon_id, manager_phone, current: "admin" }));
});

// -------------------------------------------------------
// POST: Update Salon Info
// -------------------------------------------------------
router.post("/update-salon-info", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id; // Always use session — never trust req.body.salon_id
  const {
    name,
    address,
    city,
    state,
    zip,
    website,
    booking_url,
    industry,
    tone_profile,
    timezone,
    salon_tag,
    custom_tags_raw
  } = req.body;

  if (!salon_id) {
    return res.status(400).send("Missing salon_id");
  }

  try {
    // Build hashtags from the plain text fields — no client-side JS needed
    let hashtagsValue = null;
    if (salon_tag !== undefined || custom_tags_raw !== undefined) {
      const tagClean = (t) => t.trim().replace(/^#+/, "");
      const salonTagCleaned = salon_tag ? tagClean(salon_tag) : "";
      const customCleaned = (custom_tags_raw || "")
        .split(/[,\s]+/)
        .map(tagClean)
        .filter(Boolean)
        .slice(0, 2);
      const all = (salonTagCleaned ? [`#${salonTagCleaned}`] : [])
        .concat(customCleaned.map(t => `#${t}`));
      if (all.length > 0) {
        hashtagsValue = JSON.stringify(all);
      } else {
        hashtagsValue = "[]";
      }
    }

    db.prepare(`
      UPDATE salons
        SET
          name             = COALESCE(?, name),
          address          = COALESCE(?, address),
          city             = COALESCE(?, city),
          state            = COALESCE(?, state),
          zip              = COALESCE(?, zip),
          website          = COALESCE(?, website),
          booking_url      = COALESCE(?, booking_url),
          industry         = COALESCE(?, industry),
          tone             = COALESCE(?, tone),
          timezone         = COALESCE(?, timezone),
          default_hashtags = COALESCE(?, default_hashtags),
          updated_at       = datetime('now')
        WHERE slug = ?
    `).run(
      name || null,
      address || null,
      city || null,
      state || null,
      zip || null,
      website || null,
      booking_url || null,
      industry || null,
      tone_profile || null,
      timezone || null,
      hashtagsValue,
      salon_id
    );

    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[Admin] update-salon-info failed:", err);
    return res.status(500).send("Failed to update salon info");
  }
});

// -------------------------------------------------------
// POST: Update Salon Logo
// -------------------------------------------------------
router.post("/update-salon-logo", requireAuth, salonLogoUpload.single("logo"), (req, res) => {
  const salon_id = req.manager.salon_id; // Always use session — never trust req.body.salon_id
  if (!req.file) {
    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  }
  const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const logoUrl = `${PUBLIC_BASE_URL}/uploads/${req.file.filename}`;
  db.prepare("UPDATE salons SET logo_url = ? WHERE slug = ?").run(logoUrl, salon_id);
  return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
});

// -------------------------------------------------------
// POST: Update Posting Rules  (ONLY posting window + spacing)
// -------------------------------------------------------
router.post("/update-posting-rules", requireAuth, (req, res) => {
  try {
    const salon_id = req.manager.salon_id; // Always use session — never trust req.body.salon_id
    const {
      posting_schedule_json,
      spacing_min,
      spacing_max
    } = req.body;

    if (!salon_id) {
      return res.status(400).send("Missing salon_id");
    }

    const spacingMinInt = parseInt(spacing_min, 10) || 20;
    const spacingMaxInt = parseInt(spacing_max, 10) || 45;

    // Validate and parse the per-day schedule JSON
    let scheduleJson = null;
    if (posting_schedule_json) {
      try {
        const parsed = JSON.parse(posting_schedule_json);
        // Also extract a representative start/end from Monday (or first enabled day) for legacy fallback
        const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
        const firstEnabled = days.find(d => parsed[d]?.enabled) || "monday";
        const legacyStart = parsed[firstEnabled]?.start || "09:00";
        const legacyEnd   = parsed[firstEnabled]?.end   || "20:00";
        scheduleJson = JSON.stringify(parsed);

        db.prepare(
          `UPDATE salons
           SET posting_schedule    = ?,
               posting_start_time  = ?,
               posting_end_time    = ?,
               spacing_min         = ?,
               spacing_max         = ?,
               updated_at          = datetime('now')
           WHERE slug = ?`
        ).run(scheduleJson, legacyStart, legacyEnd, spacingMinInt, spacingMaxInt, salon_id);
      } catch {
        return res.status(400).send("Invalid posting schedule format");
      }
    } else {
      db.prepare(
        `UPDATE salons
         SET spacing_min = ?,
             spacing_max = ?,
             updated_at  = datetime('now')
         WHERE slug = ?`
      ).run(spacingMinInt, spacingMaxInt, salon_id);
    }

    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[Admin] update-posting-rules failed:", err);
    res.status(500).send("Failed to update posting rules");
  }
});

// -------------------------------------------------------
// POST: Update Manager Rules (ONLY approval, publish, notify)
// -------------------------------------------------------
router.post("/update-manager-rules", requireAuth, (req, res) => {
  try {
    const salon_id = req.manager.salon_id; // Always use session — never trust req.body.salon_id
    const {
      require_manager_approval,
      auto_approval,
      auto_publish,
      notify_on_approval,
      notify_on_denial
    } = req.body;

    db.prepare(
      `
      UPDATE salons
      SET
        require_manager_approval   = ?,
        auto_approval              = ?,
        auto_publish               = ?,
        notify_on_approval         = ?,
        notify_on_denial           = ?,
        updated_at                 = datetime('now')
      WHERE slug = ?
    `
    ).run(
      require_manager_approval === "1" ? 1 : 0,
      auto_approval === "1" ? 1 : 0,
      auto_publish === "1" ? 1 : 0,
      notify_on_approval === "1" ? 1 : 0,
      notify_on_denial === "1" ? 1 : 0,
      salon_id
    );

    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[Admin] update-manager-rules failed:", err);
    res.status(500).send("Failed to update manager rules");
  }
});


// -------------------------------------------------------
// POST: Update Hashtags
//   - Receives hashtags_json — the full merged array (salon tag + custom tags)
// -------------------------------------------------------
router.post("/update-hashtags", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const { hashtags_json } = req.body;

  try {
    let custom = [];
    try {
      const parsed = JSON.parse(hashtags_json || "[]");
      if (Array.isArray(parsed)) custom = parsed;
    } catch {
      custom = [];
    }

    // Keep salonTag logic as fallback for any callers that don't include it
    const salonTag = null;

    // 🔒 Moderation: block bad words in hashtags
    const badHashtag = custom.find(tag => !isContentSafe("", [tag], ""));
    if (badHashtag) {
      return res.send(`
        <h1 style="color:red;font-family:sans-serif">❌ Blocked Hashtag</h1>
        <p>The hashtag "<strong>${badHashtag}</strong>" contains inappropriate or restricted terms.</p>
        <p>Please remove it and try again.</p>
        <a href="/manager/admin?salon=${encodeURIComponent(salon_id)}">Return to Admin</a>
      `);
    }


    const merged = (salonTag ? [salonTag] : []).concat(custom).slice(0, 3);

    db.prepare(
      `
      UPDATE salons
      SET
        default_hashtags = ?,
        updated_at       = datetime('now')
      WHERE slug = ?
    `
    ).run(JSON.stringify(merged), salon_id);

    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[Admin] update-hashtags failed:", err);
    return res.status(500).send("Failed to update hashtags");
  }
});

// -------------------------------------------------------
// POST: Add Member
// -------------------------------------------------------
router.post("/add-stylist", (req, res) => {
  const { salon_id, name, phone, instagram_handle } = req.body;

  if (!salon_id) {
    return res.status(400).send("Missing salon_id");
  }

  if (!name || !phone) {
    return res.status(400).send("Name and phone are required");
  }

  const id = crypto.randomUUID();

  let specialties = [];
    try {
      specialties = JSON.parse(req.body.specialties_json || "[]");
    } catch {
      specialties = [];
    }

    // 🔒 Moderation: block bad words in specialties
    const badSpec = specialties.find(s => !isContentSafe("", [], s));
    if (badSpec) {
      return res.send(`
        <h1 style="color:red;font-family:sans-serif">❌ Blocked Specialty</h1>
        <p>The specialty "<strong>${badSpec}</strong>" contains inappropriate or restricted terms.</p>
        <p>Please remove it and try again.</p>
        <a href="/manager/admin?salon=${encodeURIComponent(salon_id)}">Return to Admin</a>
      `);
    }

  try {
    db.prepare(
      `
      INSERT INTO stylists (id, salon_id, name, phone, instagram_handle, specialties)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      salon_id,
      name,
      phone,
      instagram_handle || null,
      JSON.stringify([])
    );

    // Send welcome SMS to the new stylist (non-blocking)
    if (phone) {
      const salonRow = db.prepare(`SELECT name FROM salons WHERE slug = ?`).get(salon_id);
      const salonName = salonRow?.name || "your salon";
      sendWelcomeSms({ id, name, phone, compliance_opt_in: 0 }, salonName)
        .catch(err => console.error("[Admin] welcome SMS failed:", err.message));
    }

    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[Admin] add-member failed:", err);
    return res.status(500).send("Failed to add member");
  }
});

// -------------------------------------------------------
// POST: Update Member
// -------------------------------------------------------
router.post("/update-stylist", (req, res) => {
  const { id, name, phone, instagram_handle } = req.body;

  const specialties = req.body.specialties_json
  ? JSON.parse(req.body.specialties_json)
  : [];

  // 🔒 Moderation: block bad words in specialties
  const badSpec = specialties.find(s => !isContentSafe("", [], s));
  if (badSpec) {
    return res.send(`
      <h1 style="color:red;font-family:sans-serif">❌ Blocked Specialty</h1>
      <p>The specialty "<strong>${badSpec}</strong>" contains inappropriate or restricted terms.</p>
      <p>Please remove it and try again.</p>
      <a href="/manager/admin">Return to Admin</a>
    `);
  }


  if (!id) {
    return res.status(400).send("Missing member id");
  }

  try {
    const stylist = db
      .prepare("SELECT salon_id FROM stylists WHERE id = ?")
      .get(id);

    if (!stylist) {
      return res.status(404).send("Member not found");
    }

    db.prepare(
      `
      UPDATE stylists
      SET
        name             = COALESCE(?, name),
        phone            = COALESCE(?, phone),
        instagram_handle = COALESCE(?, instagram_handle),
        specialties      = COALESCE(?, specialties),
        updated_at       = datetime('now')
      WHERE id = ?
    `
    ).run(
      name || null,
      phone || null,
      instagram_handle || null,
      JSON.stringify(specialties),
      id
    );


    return res.redirect(
      `/manager/admin?salon=${encodeURIComponent(stylist.salon_id)}`
    );
  } catch (err) {
    console.error("[Admin] update-stylist failed:", err);
    return res.status(500).send("Failed to update member");
  }
});

router.get("/delete-stylist", requireAuth, (req, res) => {
  const id = req.query.id;
  const salon_id = req.manager.salon_id; // Always use session — never trust URL params

  if (!id) {
    return res.status(400).send("Missing parameters");
  }

  try {
    db.prepare("DELETE FROM stylists WHERE id = ? AND salon_id = ?").run(id, salon_id);
    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("Delete stylist failed:", err);
    return res.status(500).send("Failed to delete stylist");
  }
});


// ───────────────────────────────────────────────────────────
// MY PROFILE — Save manager stylist profile
// ───────────────────────────────────────────────────────────
router.post("/update-my-profile", requireAuth, managerPhotoUpload.single("manager_photo"), (req, res) => {
  const salon_id  = req.query.salon || req.manager?.salon_id;
  const manager_id = req.manager?.id;
  if (!manager_id) return res.redirect(`/manager/admin?salon=${salon_id}`);

  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const photoUrl = req.file ? `${base}/uploads/${req.file.filename}` : null;

  const instagram_handle     = (req.body.instagram_handle || "").replace(/^@+/, "").trim() || null;
  const specialties          = (req.body.specialties || "").trim() || null;
  const preferred_music_genre = (req.body.preferred_music_genre || "").trim() || null;

  if (photoUrl) {
    db.prepare(`
      UPDATE managers
      SET instagram_handle = ?, photo_url = ?, specialties = ?, preferred_music_genre = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(instagram_handle, photoUrl, specialties, preferred_music_genre, manager_id);
  } else {
    db.prepare(`
      UPDATE managers
      SET instagram_handle = ?, specialties = ?, preferred_music_genre = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(instagram_handle, specialties, preferred_music_genre, manager_id);
  }

  console.log(`[Admin] Manager profile updated: ${manager_id}`);
  return res.redirect(`/manager/admin?salon=${salon_id}`);
});

// ───────────────────────────────────────────────────────────
// STOCK PHOTOS — Upload
// ───────────────────────────────────────────────────────────
router.post("/stock-photos/upload", requireAuth, stockPhotoUpload.single("stock_photo"), (req, res) => {
  const salon_id = req.query.salon || req.manager?.salon_id;
  if (!req.file) return res.redirect(`/manager/admin?salon=${salon_id}`);

  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const url  = `${base}/uploads/${req.file.filename}`;
  const label      = (req.body.label || "").trim() || null;
  const stylist_id = req.body.stylist_id || null;
  const category   = ["general", "interior", "exterior", "education", "other"].includes(req.body.category) ? req.body.category : "general";

  db.prepare(`
    INSERT INTO stock_photos (id, salon_id, stylist_id, label, url, category)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)
  `).run(salon_id, stylist_id || null, label, url, category);

  console.log(`[Admin] Stock photo uploaded for salon ${salon_id}: ${url}`);
  return res.redirect(`/manager/admin?salon=${salon_id}`);
});

// ───────────────────────────────────────────────────────────
// STOCK PHOTOS — Delete
// ───────────────────────────────────────────────────────────
router.post("/stock-photos/delete", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id; // Always use session
  const { photo_id } = req.body;

  if (photo_id) {
    const row = db.prepare(`SELECT url FROM stock_photos WHERE id = ? AND salon_id = ?`).get(photo_id, salon_id);
    if (row) {
      db.prepare(`DELETE FROM stock_photos WHERE id = ? AND salon_id = ?`).run(photo_id, salon_id);
      // Optionally remove the file from disk
      try {
        const filePath = path.join(path.resolve("public"), new URL(row.url).pathname);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch { /* ignore file removal errors */ }
    }
  }

  return res.redirect(`/manager/admin?salon=${salon_id}`);
});

// ───────────────────────────────────────────────────────────
// GET /manager/admin/stylist/:id — JSON for edit modal
// ───────────────────────────────────────────────────────────
router.get("/stylist/:id", requireAuth, (req, res) => {
  const { id } = req.params;
  const salon_id = req.manager.salon_id;

  const stylist = db
    .prepare(`SELECT id, name, phone, instagram_handle, specialties, photo_url
              FROM stylists WHERE id = ? AND salon_id = ?`)
    .get(id, salon_id);

  if (!stylist) return res.status(404).json({ error: "Not found" });

  const stockPhotos = db
    .prepare(`SELECT id, label, url FROM stock_photos
              WHERE salon_id = ? AND stylist_id = ?
              ORDER BY created_at DESC`)
    .all(salon_id, id);

  let specialties = [];
  if (stylist.specialties) {
    try {
      const p = JSON.parse(stylist.specialties);
      specialties = Array.isArray(p) ? p : String(stylist.specialties).split(",").map(x => x.trim());
    } catch {
      specialties = String(stylist.specialties).split(",").map(x => x.trim());
    }
  }

  res.json({ ...stylist, specialties, stock_photos: stockPhotos });
});

// ───────────────────────────────────────────────────────────
// POST /manager/admin/update-stylist-full — profile + photo upload
// ───────────────────────────────────────────────────────────
router.post("/update-stylist-full", requireAuth, stylistPhotoUpload.single("stylist_photo"), (req, res) => {
  const { id, name, phone, instagram_handle } = req.body;
  const salon_id = req.manager.salon_id;

  if (!id) return res.status(400).send("Missing stylist id");

  let specialties = [];
  try {
    specialties = JSON.parse(req.body.specialties_json || "[]");
  } catch { specialties = []; }

  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const photoUrl = req.file ? `${base}/uploads/${req.file.filename}` : null;

  if (photoUrl) {
    db.prepare(`
      UPDATE stylists
      SET name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          instagram_handle = COALESCE(?, instagram_handle),
          specialties = ?,
          photo_url = ?,
          updated_at = datetime('now')
      WHERE id = ? AND salon_id = ?
    `).run(name || null, phone || null, instagram_handle || null, JSON.stringify(specialties), photoUrl, id, salon_id);
  } else {
    db.prepare(`
      UPDATE stylists
      SET name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          instagram_handle = COALESCE(?, instagram_handle),
          specialties = ?,
          updated_at = datetime('now')
      WHERE id = ? AND salon_id = ?
    `).run(name || null, phone || null, instagram_handle || null, JSON.stringify(specialties), id, salon_id);
  }

  return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon_id)}`);
});

// ───────────────────────────────────────────────────────────
// POST: Resend Welcome SMS to a stylist
// ───────────────────────────────────────────────────────────
router.post("/resend-welcome/:stylistId", requireAuth, async (req, res) => {
  const { stylistId } = req.params;
  const salon_id = req.manager.salon_id;

  const stylist = db.prepare(
    `SELECT id, name, phone, compliance_opt_in FROM stylists WHERE id = ? AND salon_id = ?`
  ).get(stylistId, salon_id);

  if (!stylist) return res.status(404).json({ ok: false, error: "Stylist not found" });
  if (!stylist.phone) return res.status(400).json({ ok: false, error: "Stylist has no phone number" });

  const salonRow = db.prepare(`SELECT name FROM salons WHERE slug = ?`).get(salon_id);
  const salonName = salonRow?.name || "your salon";

  try {
    await sendWelcomeSms(stylist, salonName);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[Admin] resend-welcome failed:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ───────────────────────────────────────────────────────────
// POST /feature-requests — Submit new feature request
// ───────────────────────────────────────────────────────────
router.post("/feature-requests", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id;
  const { title, description } = req.body;
  if (!title?.trim()) return res.redirect("/manager/admin#feedback");

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    db.prepare(`
      INSERT INTO feature_requests (id, title, description, submitted_by, status, public, vote_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'submitted', 0, 1, ?, ?)
    `).run(id, title.trim().slice(0, 120), (description || '').trim().slice(0, 500), salon_id, now, now);
    // Auto-vote by submitter
    db.prepare(`
      INSERT OR IGNORE INTO feature_request_votes (id, feature_request_id, salon_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(crypto.randomUUID(), id, salon_id, now);
  } catch (err) {
    console.error('[Admin] Feature request insert failed:', err.message);
  }
  res.redirect("/manager/admin#feedback");
});

// ───────────────────────────────────────────────────────────
// POST /feature-requests/:id/vote — Toggle vote on a request
// ───────────────────────────────────────────────────────────
router.post("/feature-requests/:id/vote", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id;
  const { id } = req.params;
  try {
    const existing = db.prepare(`SELECT id FROM feature_request_votes WHERE feature_request_id = ? AND salon_id = ?`).get(id, salon_id);
    if (existing) {
      db.prepare(`DELETE FROM feature_request_votes WHERE feature_request_id = ? AND salon_id = ?`).run(id, salon_id);
      db.prepare(`UPDATE feature_requests SET vote_count = MAX(0, vote_count - 1), updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    } else {
      db.prepare(`INSERT OR IGNORE INTO feature_request_votes (id, feature_request_id, salon_id, created_at) VALUES (?, ?, ?, ?)`).run(crypto.randomUUID(), id, salon_id, new Date().toISOString());
      db.prepare(`UPDATE feature_requests SET vote_count = vote_count + 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
    }
  } catch (err) {
    console.error('[Admin] Vote toggle failed:', err.message);
  }
  res.redirect("/manager/admin#feedback");
});

// ───────────────────────────────────────────────────────────
// GET /manager/admin/test-celebration — Generate a test celebration post
// ───────────────────────────────────────────────────────────
router.get("/test-celebration", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const { stylist: stylistId, type: celebType = "birthday" } = req.query;

  try {
    if (!stylistId) {
      return res.status(400).send("Missing ?stylist=<id> query param");
    }

    const stylist = db.prepare(`
      SELECT id, name, first_name, photo_url, hire_date
      FROM stylists WHERE id = ? AND salon_id = ?
    `).get(stylistId, salon_id);

    if (!stylist) {
      return res.status(404).send("Stylist not found");
    }

    const salon = db.prepare(`
      SELECT name, tone, brand_palette, celebration_template, logo_url
      FROM salons WHERE slug = ?
    `).get(salon_id);

    const template = salon.celebration_template || "script";

    const palette = (() => {
      try { return JSON.parse(salon.brand_palette || "{}"); }
      catch { return {}; }
    })();
    const accentColor = palette.cta || palette.accent || "#3B72B9";

    const logoUrl = salon.logo_url;
    let logoPath = null;
    if (logoUrl?.startsWith("http")) {
      logoPath = logoUrl; // toBase64DataUri handles HTTP URLs
    } else if (logoUrl?.startsWith("/uploads/")) {
      const abs = path.resolve("public" + logoUrl);
      if (fs.existsSync(abs)) logoPath = abs;
    }

    const firstName = stylist.first_name || stylist.name?.split(" ")[0] || stylist.name || "Team Member";
    const anniversaryYears = celebType === "anniversary" && stylist.hire_date
      ? Math.floor(DateTime.now().diff(DateTime.fromISO(stylist.hire_date), "years").years)
      : undefined;

    const { feedUrl, storyUrl } = await generateCelebrationImage({
      profilePhotoUrl: stylist.photo_url,
      salonLogoPath:   logoPath,
      firstName,
      celebrationType: celebType,
      anniversaryYears,
      salonName: salon.name,
      accentColor,
      template,
    });

    const caption = await generateCelebrationCaption({
      firstName,
      salonName:       salon.name,
      tone:            salon.tone || "warm and professional",
      celebrationType: celebType,
      anniversaryYears,
    });

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const scheduledFeed  = DateTime.utc().plus({ minutes: 5 }).toFormat("yyyy-LL-dd HH:mm:ss");
    const scheduledStory = DateTime.utc().plus({ minutes: 8 }).toFormat("yyyy-LL-dd HH:mm:ss");

    const insertPost = (imageUrl, postType, scheduledFor) => {
      const id = crypto.randomUUID();
      const postNum = db.prepare(`SELECT MAX(salon_post_number) AS m FROM posts WHERE salon_id = ?`).get(salon_id)?.m || 0;
      db.prepare(`
        INSERT INTO posts (
          id, salon_id, stylist_name, stylist_id,
          image_url, base_caption, final_caption,
          post_type, status, scheduled_for, salon_post_number, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manager_approved', ?, ?, ?)
      `).run(id, salon_id, stylist.name, stylist.id, imageUrl, caption, caption, postType, scheduledFor, postNum + 1, now);
      return id;
    };

    insertPost(feedUrl, "celebration", scheduledFeed);
    insertPost(storyUrl, "celebration_story", scheduledStory);

    console.log(`[Admin] Test celebration (${celebType}) created for ${firstName} in salon ${salon_id}`);

    res.redirect("/manager/admin?notice=Test+celebration+post+queued#branding");
  } catch (err) {
    console.error("[Admin] test-celebration error:", err.message);
    res.status(500).send(`Error generating test post: ${err.message}`);
  }
});

// GET: Celebration template preview (opens image in new tab, no post created)
router.get("/celebration-preview", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const validTemplates = Object.keys(TEMPLATE_META.celebration);
  const rawTemplate = req.query.template;
  const template = validTemplates.includes(rawTemplate) ? rawTemplate : "script";
  const { stylist: stylistId, type = "birthday" } = req.query;

  if (!stylistId) return res.redirect("/manager/admin?tab=branding&err=No+stylist+selected");

  const stylist = db.prepare(`SELECT * FROM stylists WHERE id = ? AND salon_id = ?`).get(stylistId, salon_id);
  if (!stylist) return res.redirect("/manager/admin?tab=branding&err=Stylist+not+found");

  const salon = db.prepare(`SELECT name, brand_palette, logo_url FROM salons WHERE slug = ?`).get(salon_id);
  const palette = (() => { try { return JSON.parse(salon.brand_palette || "{}"); } catch { return {}; } })();
  const accentColor = palette.cta || palette.accent || "#3B72B9";
  const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  let logoPath = null;
  if (salon.logo_url) {
    if (PUBLIC_BASE && salon.logo_url.startsWith(PUBLIC_BASE + "/uploads/")) {
      const rel = salon.logo_url.slice(PUBLIC_BASE.length);
      const abs = path.resolve("public" + rel);
      logoPath = fs.existsSync(abs) ? abs : salon.logo_url;
    } else if (salon.logo_url.startsWith("http")) {
      logoPath = salon.logo_url;
    } else if (salon.logo_url.startsWith("/uploads/")) {
      const abs = path.resolve("public" + salon.logo_url);
      logoPath = fs.existsSync(abs) ? abs : null;
    }
  }
  const firstName = stylist.first_name || stylist.name?.split(" ")[0] || stylist.name || "Team";
  const celebrationType = type === "anniversary" ? "anniversary" : "birthday";

  try {
    const { feedUrl } = await generateCelebrationImage({
      profilePhotoUrl: stylist.photo_url,
      salonLogoPath:   logoPath,
      firstName,
      celebrationType,
      anniversaryYears: celebrationType === "anniversary" ? 3 : undefined,
      salonName: salon.name,
      accentColor,
      primaryColor: palette.primary || null,
      template,
    });
    res.redirect(feedUrl);
  } catch (err) {
    console.error("[Admin] Celebration preview failed:", err.message);
    res.status(500).send(`<p style="font-family:sans-serif;padding:2rem">Preview failed: ${err.message}</p>`);
  }
});

// POST: Save celebration template selection
router.post("/celebration-template", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const valid = Object.keys(TEMPLATE_META.celebration);
  const template = valid.includes(req.body.template) ? req.body.template : "script";
  db.prepare(`UPDATE salons SET celebration_template = ? WHERE slug = ?`).run(template, salon_id);
  res.redirect("/manager/admin#branding");
});

// GET: Availability template preview (opens image in new tab, no post created)
router.get("/availability-preview", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const validTemplates = Object.keys(TEMPLATE_META.availability);
  const rawTemplate = req.query.template;
  const template = validTemplates.includes(rawTemplate) ? rawTemplate : "script";
  const { stylist: stylistId } = req.query;

  if (!stylistId) return res.redirect("/manager/admin?tab=branding&err=No+stylist+selected");

  const stylist = db.prepare(`SELECT * FROM stylists WHERE id = ? AND salon_id = ?`).get(stylistId, salon_id);
  if (!stylist) return res.redirect("/manager/admin?tab=branding&err=Stylist+not+found");

  const salon = db.prepare(`SELECT name FROM salons WHERE slug = ?`).get(salon_id);
  const MOCK_SLOTS = ["Tuesday: 2:00pm · Color", "Wednesday: 10:00am · Haircut", "Friday: 3:30pm · Blowout"];
  try {
    const imageUrl = await buildAvailabilityImage({
      slots:           MOCK_SLOTS,
      stylistName:     stylist.name,
      salonName:       salon?.name || "",
      salonId:         salon_id,
      stylistId:       stylist.id,
      instagramHandle: stylist.instagram_handle || null,
      bookingCta:      "Book via link in bio",
      templateKey:     template,
    });
    res.redirect(imageUrl);
  } catch (err) {
    console.error("[Admin] Availability preview failed:", err.message);
    const safeMsg = String(err.message || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    res.status(500).send(`<p style="font-family:sans-serif;padding:2rem">Preview failed: ${safeMsg}</p>`);
  }
});

// POST: Save availability template selection
router.post("/availability-template", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const valid    = Object.keys(TEMPLATE_META.availability);
  const template = valid.includes(req.body.template) ? req.body.template : "script";
  db.prepare(`UPDATE salons SET availability_template = ? WHERE slug = ?`).run(template, salon_id);
  res.redirect("/manager/admin#branding");
});

// ───────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────
export default router;
