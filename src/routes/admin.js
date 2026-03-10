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
router.get("/templates", requireAuth, (req, res) => {
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

  // Brand palette
  let brandPalette = null;
  try {
    if (salonRow.brand_palette) brandPalette = JSON.parse(salonRow.brand_palette);
  } catch {}

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
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-2">Admin</h1>
      <p class="text-sm text-mpMuted">Manage social connections, posting rules, and team configuration.</p>
    </section>

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
          <button onclick="window.admin.openSalonInfo()" class="text-mpMuted hover:text-mpCharcoal text-xs">✏️</button>
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
              <button onclick="window.admin.openHashtags()" class="text-mpMuted hover:text-mpCharcoal text-xs">✏️</button>
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

    <!-- POSTING RULES — moved to Scheduler page -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <!-- Scheduler link card -->
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4 flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-1">
            <h2 class="text-sm font-semibold text-mpCharcoal">Posting Availability</h2>
            <button onclick="window.admin.openPostingRules()" class="text-mpMuted hover:text-mpCharcoal text-xs">✏️</button>
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
          <button onclick="window.admin.openManagerRules()" class="text-mpMuted hover:text-mpCharcoal text-xs">✏️</button>
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

    <!-- BRAND PALETTE -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-sm font-semibold text-mpCharcoal">Brand Color Palette</h2>
            <p class="text-[11px] text-mpMuted mt-0.5">Extracted from your website during setup. Used in AI-generated promotion images.</p>
          </div>
          <a href="/onboarding/brand?reset=1"
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
          <a href="/onboarding/brand" class="underline text-mpAccent ml-1">Edit palette</a>
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
            <a href="/onboarding/brand" class="text-xs text-mpAccent underline">
              ${salonRow.website ? "Extract colors from your website →" : "Set up brand palette →"}
            </a>
          </div>
        </div>
        `}
      </div>
    </section>

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

    <!-- TEAM MEMBERS — managed on dedicated Team page -->
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


  <!-- ═══════════════════════════════════════════════════════ -->
  <!-- STOCK PHOTOS                                           -->
  <!-- ═══════════════════════════════════════════════════════ -->
  ${(() => {
    const stockPhotos = db.prepare(
      `SELECT sp.id, sp.label, sp.url, sp.stylist_id, s.name AS stylist_name
       FROM stock_photos sp
       LEFT JOIN stylists s ON s.id = sp.stylist_id
       WHERE sp.salon_id = ?
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

  `;

  // Render page
  res.send(
    pageShell({
      title: "Admin",
      body,
      salon_id,
      manager_phone,
      current: "admin",
    })
  );
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
    tone_profile
  } = req.body;

  if (!salon_id) {
    return res.status(400).send("Missing salon_id");
  }

  try {
    db.prepare(`
      UPDATE salons
        SET
          name        = COALESCE(?, name),
          address     = COALESCE(?, address),
          city        = COALESCE(?, city),
          state       = COALESCE(?, state),
          zip         = COALESCE(?, zip),
          website     = COALESCE(?, website),
          booking_url = COALESCE(?, booking_url),
          industry    = COALESCE(?, industry),
          tone        = COALESCE(?, tone),
          updated_at  = datetime('now')
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
//   - Receives salon_id and hashtags_json (custom tags only)
//   - Preserves the first "salon tag" from existing default_hashtags
// -------------------------------------------------------
router.post("/update-hashtags", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id; // Always use session — never trust req.body.salon_id
  const { hashtags_json } = req.body;

  try {
    const salon = db
      .prepare("SELECT default_hashtags FROM salons WHERE slug = ?")
      .get(salon_id);

    let existing = [];
    if (salon && salon.default_hashtags) {
      try {
        existing = JSON.parse(salon.default_hashtags);
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];
      }
    }

    const salonTag = existing[0] || null;

    let custom = [];
    try {
      const parsed = JSON.parse(hashtags_json || "[]");
      if (Array.isArray(parsed)) custom = parsed;
    } catch {
      custom = [];
    }

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


    const merged = (salonTag ? [salonTag] : []).concat(custom);

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
// Export
// ───────────────────────────────────────────────────────────
export default router;
