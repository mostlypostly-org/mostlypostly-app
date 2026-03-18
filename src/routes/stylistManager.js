// src/routes/stylistManager.js
// Modernized stylist management: list, add, edit, delete, CSV import/export.

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { TONE_GROUPS, TONE_VARIANT_MAP } from "../core/toneVariants.js";

const router = express.Router();

import { UPLOADS_DIR, toUploadUrl } from "../core/uploadPath.js";
import { PLAN_LIMITS } from "./billing.js";
import { sendViaTwilio } from "./twilio.js";
import { sendWelcomeSms } from "../core/stylistWelcome.js";

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim() || null;
}

function normalizeBirthday(raw) {
  if (!raw) return null;
  return String(raw).trim().replace(/\//g, "-") || null;
}

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `stylist-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const libraryUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `stylist-lib-${Date.now()}${ext}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp|gif)/.test(file.mimetype));
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// ── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.manager?.manager_phone) return res.redirect("/manager/login");
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safe(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseSpecialties(val) {
  if (!val) return [];
  try {
    const p = JSON.parse(val);
    if (Array.isArray(p)) return p.map(String).filter(Boolean);
  } catch {}
  return String(val).split(",").map(x => x.trim()).filter(Boolean);
}

function toneSelectOptions(currentKey = "", salonTone = "") {
  const defaultOpt = `<option value="" ${!currentKey ? "selected" : ""}>— Salon Default (${safe(salonTone || "warm & nurturing")}) —</option>`;
  const groups = TONE_GROUPS.map(g => `
    <optgroup label="${safe(g.label)}">
      ${g.variants.map(v => `
        <option value="${v.key}" ${currentKey === v.key ? "selected" : ""} title="${safe(v.desc)}">
          ${safe(v.label)}${v.key === g.key ? " (default)" : ""}
        </option>`).join("")}
    </optgroup>`).join("");
  return defaultOpt + groups;
}

function avatarHtml(s) {
  if (s.photo_url) {
    return `<img src="${safe(s.photo_url)}" alt="${safe(s.first_name || s.name)}"
              class="h-12 w-12 rounded-full object-cover border-2 border-mpBorder" />`;
  }
  const initials = [(s.first_name || s.name || "?")[0], (s.last_name || "")[0]].filter(Boolean).join("").toUpperCase();
  return `<div class="h-12 w-12 rounded-full bg-mpAccentLight flex items-center justify-center
                       text-mpAccent font-bold text-sm border-2 border-mpBorder">${safe(initials)}</div>`;
}

function toneBadge(s) {
  if (!s.tone_variant) return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] bg-mpBg text-mpMuted">Salon Default</span>`;
  const meta = TONE_VARIANT_MAP[s.tone_variant];
  return `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] bg-mpAccentLight text-mpAccent font-medium">${safe(meta?.label || s.tone_variant)}</span>`;
}

function activityDot(lastActivityAt) {
  if (!lastActivityAt) {
    return `<span title="No activity recorded" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#EF4444;flex-shrink:0;"></span>`;
  }
  const diffDays = (Date.now() - new Date(lastActivityAt + "Z").getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 7) {
    return `<span title="Active within 7 days" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22C55E;flex-shrink:0;"></span>`;
  }
  if (diffDays <= 30) {
    return `<span title="Active within 30 days" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#EAB308;flex-shrink:0;"></span>`;
  }
  return `<span title="No activity in 30+ days" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#EF4444;flex-shrink:0;"></span>`;
}

function celebBadge(birthday, hireDate) {
  const parts = [];
  if (birthday) parts.push(`<span title="Birthday: ${safe(birthday)}" class="text-base">🎂</span>`);
  if (hireDate) parts.push(`<span title="Work anniversary: ${safe(hireDate)}" class="text-base">🎉</span>`);
  return parts.join(" ");
}

// ── CSV template headers ──────────────────────────────────────────────────────
const CSV_HEADERS = [
  "first_name", "last_name", "phone", "instagram_handle",
  "tone_variant", "birthday_mmdd", "hire_date",
  "specialties", "bio", "profile_url",
];

const CSV_EXAMPLE = [
  "Jane", "Doe", "+13175550100", "janedoehair",
  "warm_playful", "03-15", "2021-06-01",
  "Balayage,Color Correction", "Specializing in lived-in blondes.", "https://salon.com/jane",
];

// ── GET / — Team list ─────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const qs = `?salon=${encodeURIComponent(salon_id)}`;

  const salon = db.prepare("SELECT * FROM salons WHERE slug = ?").get(salon_id);
  if (!salon) return res.redirect("/manager/login");

  const stylists = db.prepare(`
    SELECT id, name, first_name, last_name, phone, instagram_handle,
           specialties, photo_url, tone_variant,
           birthday_mmdd, hire_date, bio, profile_url,
           celebrations_enabled, last_activity_at
    FROM stylists WHERE salon_id = ? ORDER BY COALESCE(first_name, name) ASC
  `).all(salon_id);

  const portalMembers = db.prepare(`
    SELECT m.id, m.name, m.email, m.role, m.stylist_id, m.phone
    FROM managers m
    WHERE m.salon_id = ? AND m.role NOT IN ('owner')
    ORDER BY m.name ASC
  `).all(salon_id);

  // Set of stylist IDs that already have portal access (don't show grant button)
  const stylistsWithPortal = new Set(portalMembers.filter(m => m.stylist_id).map(m => m.stylist_id));

  const missingCelebCount = db.prepare(`
    SELECT COUNT(*) AS n FROM stylists
    WHERE salon_id = ? AND celebrations_enabled = 1
      AND (birthday_mmdd IS NULL OR hire_date IS NULL)
  `).get(salon_id)?.n || 0;

  // Plan limits
  const planLimits = PLAN_LIMITS[salon.plan] || PLAN_LIMITS.trial;
  const stylistLimit = planLimits.stylists; // null = unlimited (Pro)
  // Manager seats: only counts role='manager' — coordinators are always unlimited
  const managerSeatLimit = planLimits.managers; // null = unlimited
  const usedManagerSeats = portalMembers.filter(m => m.role === 'manager').length;
  const managerSeatsAvailable = managerSeatLimit === null || usedManagerSeats < managerSeatLimit;
  const atLimit = stylistLimit !== null && stylists.length >= stylistLimit;
  const nearLimit = stylistLimit !== null && !atLimit && stylists.length >= stylistLimit - 1;

  const usageLabel = stylistLimit !== null
    ? `${stylists.length} / ${stylistLimit} stylists`
    : `${stylists.length} stylists`;

  const usedCoordinatorSeats = portalMembers.filter(m => m.role === 'coordinator').length;
  const managerSeatLabel = managerSeatLimit === null
    ? `${usedManagerSeats} manager${usedManagerSeats !== 1 ? "s" : ""} · ${usedCoordinatorSeats} coordinator${usedCoordinatorSeats !== 1 ? "s" : ""}`
    : `${usedManagerSeats} / ${managerSeatLimit} manager seat${managerSeatLimit !== 1 ? "s" : ""} · ${usedCoordinatorSeats} coordinator${usedCoordinatorSeats !== 1 ? "s" : ""}`;

  const cards = stylists.map(s => {
    const displayName = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.name;
    const specialties = parseSpecialties(s.specialties);
    const hasPortal = stylistsWithPortal.has(s.id);
    const portalMember = portalMembers.find(m => m.stylist_id === s.id);
    const roleBadge = hasPortal
      ? `<span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-mpAccentLight text-mpAccent">${portalMember?.role === 'coordinator' ? 'Coordinator' : 'Manager'}</span>`
      : "";

    return `
      <div class="rounded-2xl border border-mpBorder bg-white p-4 flex gap-3 items-start">
        ${avatarHtml(s)}
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5 flex-wrap">
                ${activityDot(s.last_activity_at)}
                <p class="text-sm font-semibold text-mpCharcoal">${safe(displayName)}</p>
                <span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-mpBg text-mpMuted">Stylist</span>
                ${roleBadge}
              </div>
              <p class="text-xs text-mpMuted">${safe(s.phone)}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${celebBadge(s.birthday_mmdd, s.hire_date)}
              <a href="/manager/stylists/edit/${safe(s.id)}${qs}"
                 class="text-xs text-mpAccent hover:text-mpCharcoal font-medium underline whitespace-nowrap">Edit</a>
              <form method="POST" action="/manager/stylists/delete/${safe(s.id)}${qs}"
                    onsubmit="return confirm('Remove ${safe(displayName)}?')" class="inline">
                <button type="submit" class="text-xs text-red-400 hover:text-red-600 font-medium">Remove</button>
              </form>
            </div>
          </div>
          <div class="mt-1.5 flex flex-wrap gap-1.5 items-center">
            ${toneBadge(s)}
            ${s.instagram_handle ? `<span class="text-[11px] text-mpMuted">@${safe(s.instagram_handle)}</span>` : ""}
            ${specialties.slice(0, 3).map(sp =>
              `<span class="inline-flex px-2 py-0.5 rounded-full bg-mpBg text-[10px] text-mpMuted">${safe(sp)}</span>`
            ).join("")}
          </div>
          ${!hasPortal ? `
          <details class="mt-2">
            <summary class="text-[11px] text-mpAccent cursor-pointer hover:text-mpCharcoal font-medium select-none">+ Grant Portal Access</summary>
            <form method="POST" action="/manager/stylists/grant-access/${safe(s.id)}${qs}" class="mt-2 space-y-2 bg-mpBg rounded-xl p-3">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-[10px] font-semibold text-mpMuted mb-0.5">Role</label>
                  <select name="portal_role" class="w-full rounded-lg border border-mpBorder px-2 py-1.5 text-xs text-mpCharcoal bg-white focus:outline-none focus:ring-1 focus:ring-mpAccent">
                    ${managerSeatsAvailable ? `<option value="manager">Manager</option>` : `<option value="manager" disabled>Manager (no seats)</option>`}
                    <option value="coordinator">Coordinator</option>
                  </select>
                </div>
                <div>
                  <label class="block text-[10px] font-semibold text-mpMuted mb-0.5">Email</label>
                  <input type="email" name="email" required class="w-full rounded-lg border border-mpBorder px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-mpAccent" />
                </div>
              </div>
              <div>
                <label class="block text-[10px] font-semibold text-mpMuted mb-0.5">Temp Password</label>
                <input type="text" name="temp_password" required class="w-full rounded-lg border border-mpBorder px-2 py-1.5 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-mpAccent" placeholder="They can change after first login" />
              </div>
              <button type="submit" class="rounded-full bg-mpCharcoal px-4 py-1.5 text-[11px] font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
                Grant Access
              </button>
            </form>
          </details>` : ""}
        </div>
      </div>`;
  }).join("");

  const managerOnlyCards = portalMembers
    .filter(m => !m.stylist_id)
    .map(m => {
      const initials = (m.name || "?").split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
      const roleLabel = m.role === "coordinator" ? "Coordinator" : "Manager";
      const roleBg = m.role === "coordinator" ? "bg-purple-100 text-purple-700" : "bg-mpAccentLight text-mpAccent";
      return `
        <div class="rounded-2xl border border-mpBorder bg-white p-4 flex gap-3 items-start">
          <div class="h-12 w-12 rounded-full bg-mpAccentLight flex items-center justify-center text-mpAccent font-bold text-sm border-2 border-mpBorder flex-shrink-0">${safe(initials)}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="flex items-center gap-1.5 flex-wrap">
                  <p class="text-sm font-semibold text-mpCharcoal">${safe(m.name || m.email)}</p>
                  <span class="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold ${roleBg}">${roleLabel}</span>
                </div>
                <p class="text-xs text-mpMuted">${safe(m.email || "")}</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <a href="/manager/stylists/managers/edit/${safe(m.id)}${qs}"
                   class="text-xs text-mpAccent hover:text-mpCharcoal font-medium underline whitespace-nowrap">Edit</a>
                <form method="POST" action="/manager/stylists/managers/delete/${safe(m.id)}${qs}"
                      onsubmit="return confirm('Remove ${safe(m.name || m.email)}?')" class="inline">
                  <button type="submit" class="text-xs text-red-400 hover:text-red-600 font-medium">Remove</button>
                </form>
              </div>
            </div>
          </div>
        </div>`;
    }).join("");

  const empty = stylists.length === 0 && portalMembers.filter(m => !m.stylist_id).length === 0
    ? `<div class="col-span-full text-center py-12 text-mpMuted text-sm">
         No team members yet. Add your first team member above.
       </div>`
    : "";

  const upgradeNudge = (atLimit || nearLimit) && stylistLimit !== null ? `
    <div class="mt-3 flex items-center gap-2 rounded-xl bg-mpAccentLight border border-mpAccent/20 px-3 py-2">
      <span class="text-mpAccent text-sm">⚡</span>
      <p class="text-xs text-mpCharcoal flex-1">
        ${atLimit
          ? `You've reached your <strong>${stylistLimit}-stylist limit</strong> on the ${salon.plan} plan.`
          : `You're at <strong>${stylists.length} of ${stylistLimit}</strong> stylists on the ${salon.plan} plan.`}
        <a href="/manager/billing" class="font-semibold text-mpAccent underline ml-1">Upgrade for more →</a>
      </p>
    </div>` : "";

  const addBtn = `<a href="/manager/stylists/add${qs}"
      class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
     + Add Team Member
   </a>`;

  const body = `
    <section class="mb-6 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">Team</h1>
        <p class="text-sm text-mpMuted mt-0.5">${usageLabel} · ${managerSeatLabel}</p>
        ${upgradeNudge}
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        ${addBtn}
        <label class="inline-flex items-center gap-1.5 rounded-full border border-mpBorder px-4 py-2 text-xs font-semibold text-mpCharcoal hover:bg-mpBg cursor-pointer transition-colors">
          Upload CSV
          <input type="file" accept=".csv" class="hidden" id="csvFileInput" />
        </label>
        <a href="/manager/stylists/template${qs}"
           class="inline-flex items-center gap-1.5 rounded-full border border-mpBorder px-4 py-2 text-xs font-semibold text-mpMuted hover:bg-mpBg transition-colors">
          Download Template
        </a>
      </div>
    </section>

    ${missingCelebCount > 0 ? `
    <div class="rounded-xl border border-yellow-200 bg-yellow-50 px-4 py-3 mb-4 flex items-start gap-2 text-xs text-yellow-800">
      <svg class="w-4 h-4 flex-shrink-0 mt-0.5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <span><strong>${missingCelebCount} team ${missingCelebCount === 1 ? "member is" : "members are"} missing</strong> a birthday or hire date — add them to enable automatic celebration posts.</span>
    </div>` : ""}

    <!-- CSV upload form (hidden, triggered by file input) -->
    <form id="csvUploadForm" method="POST" action="/manager/stylists/import${qs}" enctype="multipart/form-data" class="hidden">
      <input type="file" name="csv" id="csvFormInput" accept=".csv" />
    </form>

    <!-- Stylist Quick Start Guide -->
    ${(() => {
      const twilioNum = process.env.TWILIO_PHONE_NUMBER || "";
      return `
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-sm font-semibold text-mpCharcoal">How Stylists Post</h2>
          <span class="text-[11px] text-mpMuted font-mono">${twilioNum || "No Twilio number configured"}</span>
        </div>
        <p class="text-xs text-mpMuted mb-4">Share this number and these steps with your team. New stylists receive a welcome text with instructions when you add them.</p>
        <ol class="space-y-2 text-xs text-mpCharcoal mb-4">
          <li class="flex gap-2"><span class="flex-shrink-0 w-5 h-5 rounded-full bg-mpAccentLight text-mpAccent font-bold text-[10px] flex items-center justify-center">1</span><span>Text a photo to <strong>${twilioNum || "your MostlyPostly number"}</strong> — add a note about the service if you like.</span></li>
          <li class="flex gap-2"><span class="flex-shrink-0 w-5 h-5 rounded-full bg-mpAccentLight text-mpAccent font-bold text-[10px] flex items-center justify-center">2</span><span>AI generates a branded caption. You'll get a link to review and edit it.</span></li>
          <li class="flex gap-2"><span class="flex-shrink-0 w-5 h-5 rounded-full bg-mpAccentLight text-mpAccent font-bold text-[10px] flex items-center justify-center">3</span><span>Review on the preview page — tweak or regenerate with notes, then submit for manager approval.</span></li>
          <li class="flex gap-2"><span class="flex-shrink-0 w-5 h-5 rounded-full bg-mpAccentLight text-mpAccent font-bold text-[10px] flex items-center justify-center">4</span><span>Once approved, the post is scheduled and publishes automatically.</span></li>
        </ol>
        <div class="border-t border-mpBorder pt-3 flex flex-wrap gap-3 text-[11px]">
          <span class="font-semibold text-mpMuted">SMS shortcuts:</span>
          <span class="font-mono bg-mpBg px-2 py-0.5 rounded text-mpCharcoal">APPROVE</span>
          <span class="text-mpMuted">— submit without editing</span>
          <span class="font-mono bg-mpBg px-2 py-0.5 rounded text-mpCharcoal">CANCEL</span>
          <span class="text-mpMuted">— discard draft</span>
        </div>
      </div>
    </section>`;
    })()}

    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      ${cards}${managerOnlyCards}${empty}
    </section>

    <script>
      const fileInput = document.getElementById("csvFileInput");
      const formInput = document.getElementById("csvFormInput");
      const form      = document.getElementById("csvUploadForm");
      if (fileInput) {
        fileInput.addEventListener("change", () => {
          if (!fileInput.files[0]) return;
          const dt = new DataTransfer();
          dt.items.add(fileInput.files[0]);
          formInput.files = dt.files;
          form.submit();
        });
      }
    </script>
  `;

  res.send(pageShell({ title: "Team", body, salon_id, current: "team" }));
});

// ── GET /add ──────────────────────────────────────────────────────────────────
router.get("/add", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT tone, plan FROM salons WHERE slug = ?").get(salon_id);
  const planLimits = PLAN_LIMITS[salon?.plan] || PLAN_LIMITS.trial;
  const managerSeatLimit = planLimits.managers;
  const usedSeats = db.prepare("SELECT COUNT(*) as c FROM managers WHERE salon_id = ? AND role = 'manager'").get(salon_id)?.c || 0;
  const managerSeatsAvailable = managerSeatLimit === null || usedSeats < managerSeatLimit;

  res.send(pageShell({
    title: "Add Team Member",
    body: buildTeamMemberForm({ salon_id, salonTone: salon?.tone, managerSeatsAvailable }),
    salon_id,
    current: "team",
  }));
});

// ── POST /add ─────────────────────────────────────────────────────────────────
router.post("/add", requireAuth, photoUpload.single("photo"), async (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT tone FROM salons WHERE slug = ?").get(salon_id);
  const { role = "stylist", first_name, last_name, phone, instagram_handle, tone_variant,
          birthday_mmdd, hire_date, bio, profile_url, celebrations_enabled, auto_approve,
          email, temp_password } = req.body;

  const qs = `?salon=${encodeURIComponent(salon_id)}`;

  if (role === "manager" || role === "coordinator") {
    // Create portal account
    if (!email || !temp_password) {
      return res.redirect(`/manager/stylists/add${qs}&error=Email+and+password+required+for+Manager+and+Coordinator`);
    }
    try {
      const password_hash = await bcrypt.hash(temp_password, 10);
      const id = crypto.randomUUID();
      const name = [first_name, last_name].filter(Boolean).join(" ") || email;
      db.prepare(`
        INSERT INTO managers (id, salon_id, name, phone, email, password_hash, role)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, salon_id, name, normalizePhone(phone) || null, email.toLowerCase().trim(), password_hash, role);
      return res.redirect(`/manager/stylists${qs}`);
    } catch (err) {
      console.error("[stylistManager] add manager error:", err);
      return res.redirect(`/manager/stylists/add${qs}&error=${encodeURIComponent(err.message)}`);
    }
  }

  // Stylist path (existing logic)
  const specialtiesRaw = req.body.specialties || "";
  const specialties = JSON.stringify(
    specialtiesRaw.split(",").map(x => x.trim()).filter(Boolean)
  );

  const photo_url = req.file ? toUploadUrl(req.file.filename) : null;
  const id = crypto.randomUUID();
  const name = [first_name, last_name].filter(Boolean).join(" ") || "Unknown";

  try {
    db.prepare(`
      INSERT INTO stylists
        (id, salon_id, name, first_name, last_name, phone, instagram_handle,
         tone_variant, birthday_mmdd, hire_date, specialties, bio, profile_url,
         photo_url, celebrations_enabled, auto_approve)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, salon_id, name, first_name || null, last_name || null,
      normalizePhone(phone), instagram_handle || null,
      tone_variant || null,
      normalizeBirthday(birthday_mmdd),
      hire_date || null,
      specialties,
      bio || null,
      profile_url || null,
      photo_url,
      celebrations_enabled === "1" ? 1 : 0,
      auto_approve === "1" ? 1 : 0,
    );

    // Send welcome SMS to new stylist
    const stylistPhone = normalizePhone(phone);
    const twilioNumber = process.env.TWILIO_PHONE_NUMBER || "";
    const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
    if (stylistPhone && twilioNumber) {
      const firstName = first_name || name.split(" ")[0] || "there";
      const welcomeMsg = [
        `Hi ${firstName}! Welcome to MostlyPostly — the easiest way to share your work on social media.`,
        ``,
        `To post, just text a photo to ${twilioNumber}. Add a quick note about the service if you like. AI will write a caption and send you a link to review it.`,
        ``,
        `🎬 Get started: https://mostlypostly.com/watch`,
        ``,
        `Text MENU anytime to see all the things you can do.`,
        ``,
        `Reply STOP to opt out. Msg & data rates may apply.`,
      ].join("\n");
      sendViaTwilio(stylistPhone, welcomeMsg).catch(err =>
        console.warn("[stylistManager] Welcome SMS failed:", err.message)
      );
    }

    res.redirect(`/manager/stylists${qs}`);
  } catch (err) {
    console.error("[stylistManager] add error:", err);
    const planLimits = PLAN_LIMITS[salon?.plan] || PLAN_LIMITS.trial;
    const managerSeatLimit = planLimits.managers;
    const usedSeats = db.prepare("SELECT COUNT(*) as c FROM managers WHERE salon_id = ? AND role = 'manager'").get(salon_id)?.c || 0;
    const managerSeatsAvailable = managerSeatLimit === null || usedSeats < managerSeatLimit;
    res.send(pageShell({
      title: "Add Team Member",
      body: `<p class="text-red-500 text-sm mb-4">${safe(err.message)}</p>` +
            buildTeamMemberForm({ salon_id, salonTone: salon?.tone, managerSeatsAvailable }),
      salon_id,
      current: "team",
    }));
  }
});

// ── GET /edit/:id ─────────────────────────────────────────────────────────────
router.get("/edit/:id", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT tone, name FROM salons WHERE slug = ?").get(salon_id);
  const stylist = db.prepare("SELECT * FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const welcomed = req.query.welcomed || null;

  res.send(pageShell({
    title: "Edit Stylist",
    body: `${welcomed ? `
      <div class="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-xs text-green-800">
        ✅ Welcome SMS sent to <strong>${safe(welcomed)}</strong>.
      </div>` : ""}` + buildStylistForm({ salon_id, salonTone: salon?.tone, stylist, isEdit: true }),
    salon_id,
    current: "team",
  }));
});

// ── POST /edit/:id ────────────────────────────────────────────────────────────
router.post("/edit/:id", requireAuth, photoUpload.single("photo"), (req, res) => {
  const salon_id = req.manager.salon_id;
  const { first_name, last_name, phone, instagram_handle, tone_variant,
          birthday_mmdd, hire_date, bio, profile_url, celebrations_enabled,
          auto_approve } = req.body;

  const specialtiesRaw = req.body.specialties || "";
  const specialties = JSON.stringify(
    specialtiesRaw.split(",").map(x => x.trim()).filter(Boolean)
  );

  const name = [first_name, last_name].filter(Boolean).join(" ") || "Unknown";

  const existing = db.prepare("SELECT photo_url FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!existing) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const photo_url = req.file ? toUploadUrl(req.file.filename) : existing.photo_url;

  db.prepare(`
    UPDATE stylists SET
      name = ?, first_name = ?, last_name = ?, phone = ?,
      instagram_handle = ?, tone_variant = ?,
      birthday_mmdd = ?, hire_date = ?,
      specialties = ?, bio = ?, profile_url = ?,
      photo_url = ?, celebrations_enabled = ?, auto_approve = ?
    WHERE id = ? AND salon_id = ?
  `).run(
    name, first_name || null, last_name || null, normalizePhone(phone),
    instagram_handle || null, tone_variant || null,
    normalizeBirthday(birthday_mmdd), hire_date || null,
    specialties, bio || null, profile_url || null,
    photo_url, celebrations_enabled === "1" ? 1 : 0,
    auto_approve === "1" ? 1 : 0,
    req.params.id, salon_id,
  );

  res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);
});

// ── GET /edit/:id/photos — photo library page ─────────────────────────────────
router.get("/edit/:id/photos", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const stylist = db.prepare("SELECT id, name, photo_url FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const photos = db.prepare(
    `SELECT id, url, category, label FROM stock_photos WHERE salon_id = ? AND stylist_id = ? ORDER BY created_at DESC`
  ).all(salon_id, stylist.id);

  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const photoCards = photos.length
    ? photos.map(p => `
        <div class="relative group rounded-2xl overflow-hidden border border-mpBorder bg-white shadow-sm">
          <img src="${safe(p.url)}" class="w-full h-44 object-cover" />
          <div class="px-3 py-2.5">
            <span class="inline-block text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-mpAccentLight text-mpAccent">${safe(p.category || "general")}</span>
            ${p.label ? `<p class="text-xs text-mpMuted mt-1 truncate">${safe(p.label)}</p>` : `<p class="text-xs text-mpBorder mt-1">No label</p>`}
          </div>
          <form method="POST" action="/manager/stylists/${safe(stylist.id)}/photos/delete${qs}" class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <input type="hidden" name="photo_id" value="${safe(p.id)}" />
            <button class="rounded-full bg-white border border-mpBorder shadow px-2.5 py-1 text-xs font-semibold text-red-500 hover:bg-red-50 transition-colors">Remove</button>
          </form>
        </div>`).join("")
    : `<p class="text-sm text-mpMuted col-span-full">No photos uploaded yet.</p>`;

  const body = `
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold text-mpCharcoal">Photo Library — ${safe(stylist.name)}</h1>
        <p class="text-sm text-mpMuted mt-0.5">
          <a href="/manager/stylists/edit/${safe(stylist.id)}${qs}" class="text-mpAccent hover:underline">← Back to stylist</a>
        </p>
      </div>
      <label for="photo-file-input"
        class="shrink-0 inline-flex items-center gap-2 rounded-full bg-mpCharcoal px-5 py-2.5 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors cursor-pointer">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        Select Photos
      </label>
    </div>

    <!-- Upload form — hidden file input, preview grid shown after selection -->
    <form id="photo-upload-form" method="POST" action="/manager/stylists/${safe(stylist.id)}/photos/upload${qs}" enctype="multipart/form-data">
      <input id="photo-file-input" type="file" name="photos" accept="image/*" multiple style="display:none" />

      <!-- Preview area — shown after files selected -->
      <div id="upload-preview-area" style="display:none" class="mb-6">
        <div class="rounded-2xl border border-mpBorder bg-white p-5 shadow-sm">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-sm font-bold text-mpCharcoal">Tag your photos before uploading</h2>
            <button type="button" onclick="clearSelection()" class="text-xs text-mpMuted hover:text-red-500 transition-colors">Clear selection</button>
          </div>
          <div id="photo-preview-grid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 mb-5"></div>
          <div class="flex items-center justify-between pt-4 border-t border-mpBorder">
            <p id="upload-count-label" class="text-xs text-mpMuted"></p>
            <button type="submit" id="upload-submit-btn"
              class="inline-flex items-center gap-2 rounded-full bg-mpAccent px-6 py-2.5 text-sm font-bold text-white hover:bg-[#2E5E9E] transition-colors">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
              Upload Photos
            </button>
          </div>
        </div>
      </div>

      <!-- Empty state prompt — label wraps the drop zone so clicking anywhere opens the picker -->
      <label for="photo-file-input" id="upload-empty-state"
        class="block rounded-2xl border-2 border-dashed border-mpBorder bg-mpBg p-10 text-center mb-6 cursor-pointer hover:border-mpAccent transition-colors">
        <div class="mx-auto w-12 h-12 rounded-2xl bg-mpAccentLight flex items-center justify-center mb-3">
          <svg class="w-6 h-6 text-mpAccent" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3 20.25h18M20.25 7.5l-.625.025M12 12.75a3 3 0 110-6 3 3 0 010 6z"/></svg>
        </div>
        <p class="text-sm font-semibold text-mpCharcoal">Click to select photos</p>
        <p class="text-xs text-mpMuted mt-1">JPEG, PNG, WebP · Up to 10 MB each · Select multiple at once</p>
      </label>
    </form>

    <!-- Uploaded photos grid -->
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-sm font-bold text-mpCharcoal">Uploaded Photos <span class="font-normal text-mpMuted">(${photos.length})</span></h2>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
      ${photoCards}
    </div>

    <script>
      const fileInput = document.getElementById('photo-file-input');
      const previewArea = document.getElementById('upload-preview-area');
      const emptyState = document.getElementById('upload-empty-state');
      const previewGrid = document.getElementById('photo-preview-grid');
      const countLabel = document.getElementById('upload-count-label');

      const CATEGORIES = [
        { value: 'styling', label: 'Stylist Work' },
        { value: 'profile', label: 'Profile / Headshot' },
      ];

      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files);
        if (!files.length) return;

        previewGrid.innerHTML = '';
        files.forEach((file, i) => {
          const reader = new FileReader();
          reader.onload = (e) => {
            const card = document.createElement('div');
            card.className = 'rounded-xl border border-mpBorder bg-white overflow-hidden';
            card.innerHTML = \`
              <div class="relative">
                <img src="\${e.target.result}" class="w-full h-36 object-cover" />
                <div class="absolute top-1.5 left-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white">\${i + 1}</div>
              </div>
              <div class="p-2.5 space-y-2">
                <select name="categories" class="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-mpAccent">
                  \${CATEGORIES.map(c => '<option value="' + c.value + '">' + c.label + '</option>').join('')}
                </select>
                <input type="text" name="labels" placeholder="Label (optional)"
                  class="w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-mpAccent" />
              </div>
            \`;
            previewGrid.appendChild(card);
          };
          reader.readAsDataURL(file);
        });

        countLabel.textContent = files.length === 1 ? '1 photo selected' : files.length + ' photos selected';
        previewArea.style.display = '';
        emptyState.style.display = 'none';
      });

      function clearSelection() {
        fileInput.value = '';
        previewGrid.innerHTML = '';
        previewArea.style.display = 'none';
        emptyState.style.display = '';
      }

      // Show spinner on submit
      document.getElementById('photo-upload-form').addEventListener('submit', () => {
        const btn = document.getElementById('upload-submit-btn');
        btn.disabled = true;
        btn.textContent = 'Uploading…';
      });
    </script>
  `;

  res.send(pageShell({ title: `${stylist.name} Photos`, body, salon_id, current: "team" }));
});

// ── POST /edit/:id/photos/upload — multi-file ─────────────────────────────────
router.post("/:id/photos/upload", requireAuth, libraryUpload.array("photos", 20), (req, res) => {
  const salon_id = req.manager.salon_id;
  const stylist = db.prepare("SELECT id FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist || !req.files?.length) return res.redirect(`/manager/stylists/edit/${req.params.id}/photos?salon=${encodeURIComponent(salon_id)}`);

  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

  // labels and categories arrive as parallel arrays (or single strings if only 1 file)
  const rawLabels = Array.isArray(req.body.labels) ? req.body.labels : [req.body.labels ?? ""];
  const rawCats   = Array.isArray(req.body.categories) ? req.body.categories : [req.body.categories ?? "styling"];

  const insert = db.prepare(`
    INSERT INTO stock_photos (id, salon_id, stylist_id, label, url, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((files) => {
    files.forEach((file, i) => {
      const url      = `${base}/uploads/${file.filename}`;
      const category = ["styling", "profile"].includes(rawCats[i]) ? rawCats[i] : "styling";
      const label    = (rawLabels[i] || "").trim() || null;
      insert.run(crypto.randomUUID(), salon_id, stylist.id, label, url, category);
    });
  });

  insertMany(req.files);

  res.redirect(`/manager/stylists/edit/${stylist.id}/photos?salon=${encodeURIComponent(salon_id)}`);
});

// ── POST /:id/photos/delete ───────────────────────────────────────────────────
router.post("/:id/photos/delete", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const { photo_id } = req.body;
  if (photo_id) {
    const row = db.prepare("SELECT url FROM stock_photos WHERE id = ? AND salon_id = ?").get(photo_id, salon_id);
    if (row) {
      db.prepare("DELETE FROM stock_photos WHERE id = ?").run(photo_id);
      // Remove local file if it's a local upload
      try {
        const localPath = path.join(UPLOADS_DIR, path.basename(row.url));
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      } catch { /* ignore */ }
    }
  }
  res.redirect(`/manager/stylists/edit/${req.params.id}/photos?salon=${encodeURIComponent(salon_id)}`);
});

// ── POST /delete/:id ──────────────────────────────────────────────────────────
router.post("/delete/:id", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  db.prepare("DELETE FROM stylists WHERE id = ? AND salon_id = ?").run(req.params.id, salon_id);
  res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);
});

// ── POST /resend-welcome/:id ───────────────────────────────────────────────────
router.post("/resend-welcome/:id", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const stylist = db.prepare("SELECT * FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const salon = db.prepare("SELECT name FROM salons WHERE slug = ?").get(salon_id);
  try {
    await sendWelcomeSms(stylist, salon?.name || "your salon");
  } catch (err) {
    console.error("[resend-welcome] error:", err.message);
  }
  res.redirect(`/manager/stylists/edit/${stylist.id}?salon=${encodeURIComponent(salon_id)}&welcomed=${encodeURIComponent(stylist.first_name || stylist.name || "stylist")}`);
});

// ── GET /template — CSV download ──────────────────────────────────────────────
router.get("/template", requireAuth, (_req, res) => {
  const lines = [
    CSV_HEADERS.join(","),
    CSV_EXAMPLE.map(v => `"${v}"`).join(","),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"stylists-template.csv\"");
  res.send(lines.join("\n"));
});

// ── POST /import — CSV bulk import ────────────────────────────────────────────
router.post("/import", requireAuth, csvUpload.single("csv"), (req, res) => {
  const salon_id = req.manager.salon_id;
  if (!req.file) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const text = req.file.buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  // Parse header row to map column positions
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());

  const getCol = (row, key) => {
    const idx = header.indexOf(key);
    return idx >= 0 ? (row[idx] || "").trim() : "";
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO stylists
      (id, salon_id, name, first_name, last_name, phone, instagram_handle,
       tone_variant, birthday_mmdd, hire_date, specialties, bio, profile_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let imported = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 2) continue;

    const first_name = getCol(row, "first_name");
    const last_name  = getCol(row, "last_name");
    const phone      = getCol(row, "phone");
    if (!phone) continue; // phone is required

    const name = [first_name, last_name].filter(Boolean).join(" ") || "Unknown";
    const specialties = JSON.stringify(
      getCol(row, "specialties").split(",").map(x => x.trim()).filter(Boolean)
    );
    try {
      insert.run(
        crypto.randomUUID(), salon_id, name, first_name || null, last_name || null,
        phone,
        getCol(row, "instagram_handle") || null,
        getCol(row, "tone_variant") || null,
        getCol(row, "birthday_mmdd") || null,
        getCol(row, "hire_date") || null,
        specialties,
        getCol(row, "bio") || null,
        getCol(row, "profile_url") || null,
      );
      imported++;
    } catch (err) {
      console.warn("[stylistManager] CSV import row skip:", err.message);
    }
  }

  console.log(`[stylistManager] Imported ${imported} stylists for ${salon_id}`);
  res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);
});

// ── Shared form builder ───────────────────────────────────────────────────────
function buildStylistForm({ salon_id, salonTone, stylist, isEdit }) {
  const s = stylist || {};
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const action = isEdit
    ? `/manager/stylists/edit/${safe(s.id)}${qs}`
    : `/manager/stylists/add${qs}`;

  const specialtiesArr = parseSpecialties(s.specialties);
  const specialtiesJson = JSON.stringify(specialtiesArr);

  const fieldRow = (label, name, type = "text", value = "", hint = "") => `
    <div>
      <label class="block text-xs font-semibold text-mpMuted mb-1">${label}</label>
      <input type="${type}" name="${name}" value="${safe(value)}"
             class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent" />
      ${hint ? `<p class="text-[11px] text-mpMuted mt-0.5">${hint}</p>` : ""}
    </div>`;

  return `
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold">${isEdit ? "Edit" : "Add"} Stylist</h1>
        <p class="text-sm text-mpMuted mt-0.5">
          <a href="/manager/stylists${qs}" class="text-mpAccent underline">← Back to Team</a>
        </p>
      </div>
      ${isEdit ? `
      <div class="flex items-center gap-2 flex-shrink-0">
        <form method="POST" action="/manager/stylists/resend-welcome/${safe(s.id)}${qs}"
              onsubmit="return confirm('Resend welcome SMS to ${safe(s.first_name || s.name)}?')">
          <button type="submit"
                  class="inline-flex items-center gap-1.5 rounded-full border border-mpBorder bg-white px-4 py-2 text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors">
            💬 Resend Welcome
          </button>
        </form>
        <a href="/manager/stylists/edit/${safe(s.id)}/photos${qs}"
           class="inline-flex items-center gap-1.5 rounded-full bg-mpAccent px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          📷 Photo Library
        </a>
      </div>` : ""}
    </div>

    <form method="POST" action="${action}" enctype="multipart/form-data">
      <div class="rounded-2xl border border-mpBorder bg-white p-6 space-y-5 max-w-2xl">

        <!-- Photo -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Profile Photo</label>
          ${isEdit && s.photo_url
            ? `<img src="${safe(s.photo_url)}" class="h-16 w-16 rounded-full object-cover border border-mpBorder mb-2" />`
            : ""}
          <input type="file" name="photo" accept="image/*"
                 class="text-sm text-mpMuted file:mr-3 file:rounded-full file:border-0
                        file:bg-mpAccentLight file:px-3 file:py-1.5 file:text-xs file:font-semibold
                        file:text-mpAccent hover:file:bg-mpAccent hover:file:text-white" />
          <p class="text-[11px] text-mpMuted mt-0.5">Used in celebration posts. JPG, PNG or WebP, max 10MB.</p>
        </div>

        <!-- Name -->
        <div class="grid grid-cols-2 gap-3">
          ${fieldRow("First Name", "first_name", "text", s.first_name || "")}
          ${fieldRow("Last Name", "last_name", "text", s.last_name || "")}
        </div>

        ${fieldRow("Phone Number", "phone", "tel", s.phone || "", "Include country code, e.g. +13175550100")}
        ${fieldRow("Instagram Handle", "instagram_handle", "text", s.instagram_handle || "", "Without @")}

        <!-- Tone Variant -->
        <div>
          <div class="flex items-center gap-2 mb-1">
            <label class="text-xs font-semibold text-mpMuted">Caption Tone</label>
            <button type="button" id="tone-help-btn"
                    class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-mpBorder text-mpMuted text-[10px] font-bold hover:bg-mpAccent hover:text-white transition-colors">?</button>
          </div>
          <select name="tone_variant"
                  class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent">
            ${toneSelectOptions(s.tone_variant || "", salonTone)}
          </select>
          <p class="text-[11px] text-mpMuted mt-0.5">Personalizes AI caption voice for this stylist. Defaults to salon tone if not set.</p>
        </div>

        <!-- Tone reference modal -->
        <div id="tone-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
          <div class="absolute inset-0 bg-black/40 backdrop-blur-sm" id="tone-modal-backdrop"></div>
          <div class="relative z-10 bg-white rounded-2xl border border-mpBorder shadow-xl w-full max-w-lg max-h-[80vh] overflow-y-auto p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-sm font-bold text-mpCharcoal">Caption Tone Reference</h3>
              <button type="button" id="tone-modal-close" class="text-mpMuted hover:text-mpCharcoal text-lg leading-none">×</button>
            </div>
            <div class="space-y-4">
              ${TONE_GROUPS.map(g => `
                <div>
                  <p class="text-xs font-bold text-mpCharcoal mb-1">${safe(g.label)}</p>
                  <p class="text-[11px] text-mpMuted mb-2">${safe(g.description)}</p>
                  <ul class="space-y-1">
                    ${g.variants.map(v => `
                      <li class="text-[11px] flex gap-2">
                        <span class="font-semibold text-mpCharcoal min-w-[90px]">${safe(v.label)}</span>
                        <span class="text-mpMuted">${safe(v.desc)}</span>
                      </li>`).join("")}
                  </ul>
                </div>`).join("")}
            </div>
          </div>
        </div>
        <script>
          (function() {
            const btn = document.getElementById("tone-help-btn");
            const modal = document.getElementById("tone-modal");
            const close = document.getElementById("tone-modal-close");
            const backdrop = document.getElementById("tone-modal-backdrop");
            if (!btn || !modal) return;
            btn.addEventListener("click", () => modal.classList.remove("hidden"));
            close?.addEventListener("click", () => modal.classList.add("hidden"));
            backdrop?.addEventListener("click", () => modal.classList.add("hidden"));
          })();
        </script>

        <!-- Birthday -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Birthday (Month & Day)</label>
          <input type="text" name="birthday_mmdd" value="${safe(s.birthday_mmdd || "")}"
                 placeholder="MM-DD  e.g. 03-15"
                 pattern="[01][0-9]-[0-3][0-9]"
                 class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent" />
          <p class="text-[11px] text-mpMuted mt-0.5">Used for annual birthday celebration posts. Format: MM-DD</p>
        </div>

        <!-- Hire Date -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Start Date (Work Anniversary)</label>
          <input type="date" name="hire_date" value="${safe(s.hire_date || "")}"
                 class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent" />
          <p class="text-[11px] text-mpMuted mt-0.5">Used to post annual work anniversary celebrations.</p>
        </div>

        <!-- Specialties tag input -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Specialties / Service Hashtags</label>
          <div id="spec-tags" class="flex flex-wrap gap-1.5 mb-2"></div>
          <input type="text" id="spec-input"
                 placeholder="Type a specialty, press Tab or Enter to add"
                 class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent" />
          <input type="hidden" name="specialties" id="spec-hidden" />
          <p class="text-[11px] text-mpMuted mt-0.5">Used to enrich AI captions and add relevant hashtags.</p>
        </div>

        <!-- Bio -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Short Bio</label>
          <textarea name="bio" rows="2"
                    placeholder="Specializing in lived-in color and effortless blondes..."
                    class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent resize-none">${safe(s.bio || "")}</textarea>
          <p class="text-[11px] text-mpMuted mt-0.5">Used in celebration captions when no profile URL is set.</p>
        </div>

        <!-- Profile URL -->
        ${fieldRow("Profile URL", "profile_url", "url", s.profile_url || "", "Link to stylist page on salon website. Used in celebration post captions.")}

        <!-- Celebrations -->
        <div class="flex items-center gap-2">
          <input type="checkbox" name="celebrations_enabled" value="1" id="celeb_check"
                 ${s.celebrations_enabled !== 0 ? "checked" : ""}
                 class="h-4 w-4 rounded border-mpBorder text-mpAccent" />
          <label for="celeb_check" class="text-xs text-mpMuted">Enable birthday &amp; anniversary celebration posts</label>
        </div>

        <!-- Auto-approve -->
        <div class="flex items-center gap-2">
          <input type="checkbox" name="auto_approve" value="1" id="auto_approve_check"
                 ${s.auto_approve ? "checked" : ""}
                 class="h-4 w-4 rounded border-mpBorder text-mpAccent" />
          <label for="auto_approve_check" class="text-xs text-mpMuted">Auto-approve — posts go straight to queue when stylist approves (no manager review)</label>
        </div>

        <!-- Submit -->
        <div class="flex gap-3 pt-2">
          <button type="submit"
                  class="rounded-full bg-mpCharcoal px-6 py-2.5 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
            ${isEdit ? "Save Changes" : "Add Stylist"}
          </button>
          <a href="/manager/stylists${qs}"
             class="rounded-full border border-mpBorder px-6 py-2.5 text-sm font-semibold text-mpMuted hover:bg-mpBg transition-colors">
            Cancel
          </a>
        </div>
      </div>

      <script>
        (function() {
          const input = document.getElementById("spec-input");
          const container = document.getElementById("spec-tags");
          const hidden = document.getElementById("spec-hidden");
          if (!input || !container || !hidden) return;

          let tags = ${specialtiesJson};

          function sync() { hidden.value = tags.join(", "); }

          function renderTags() {
            container.innerHTML = "";
            tags.forEach((tag, i) => {
              const chip = document.createElement("span");
              chip.className = "inline-flex items-center gap-1 rounded-full bg-mpAccentLight border border-mpBorder px-3 py-1 text-xs text-mpCharcoal";
              const lbl = document.createElement("span");
              lbl.textContent = tag;
              const rm = document.createElement("button");
              rm.type = "button";
              rm.textContent = "×";
              rm.className = "text-mpMuted hover:text-red-400 leading-none";
              rm.onclick = () => { tags.splice(i, 1); sync(); renderTags(); };
              chip.appendChild(lbl);
              chip.appendChild(rm);
              container.appendChild(chip);
            });
          }

          function addTag() {
            const val = input.value.trim();
            if (val && !tags.includes(val)) { tags.push(val); sync(); renderTags(); }
            input.value = "";
          }

          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === "Tab") {
              if (input.value.trim()) { e.preventDefault(); addTag(); }
            }
          });

          input.closest("form").addEventListener("submit", sync);
          sync();
          renderTags();
        })();
      </script>

      <!-- Tone reference card -->
      <div class="mt-6 rounded-2xl border border-mpBorder bg-white p-5 max-w-2xl">
        <h3 class="text-sm font-semibold text-mpCharcoal mb-3">Tone Variant Reference</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          ${TONE_GROUPS.map(g => `
            <div class="rounded-xl border border-mpBorder p-3">
              <p class="text-xs font-bold text-mpCharcoal mb-1">${safe(g.label)}</p>
              <p class="text-[11px] text-mpMuted mb-2">${safe(g.description)}</p>
              <ul class="space-y-0.5">
                ${g.variants.map(v => `
                  <li class="text-[11px] text-mpMuted">
                    <span class="font-medium text-mpCharcoal">${safe(v.label)}</span> — ${safe(v.desc)}
                  </li>`).join("")}
              </ul>
            </div>`).join("")}
        </div>
      </div>
    </form>
  `;
}

// ── Simple CSV line parser (handles quoted fields) ────────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(field); field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

// ── POST /grant-access/:stylistId — Grant portal access to existing stylist ───
router.post("/grant-access/:stylistId", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const stylist = db.prepare("SELECT * FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.stylistId, salon_id);
  if (!stylist) return res.redirect(`/manager/stylists${qs}`);

  const { portal_role = "coordinator", email, temp_password } = req.body;
  if (!email || !temp_password) return res.redirect(`/manager/stylists${qs}`);

  try {
    const password_hash = await bcrypt.hash(temp_password, 10);
    const id = crypto.randomUUID();
    const name = [stylist.first_name, stylist.last_name].filter(Boolean).join(" ") || stylist.name;
    db.prepare(`
      INSERT INTO managers (id, salon_id, name, phone, email, password_hash, role, stylist_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, salon_id, name, stylist.phone || null, email.toLowerCase().trim(), password_hash, portal_role, stylist.id);
    res.redirect(`/manager/stylists${qs}`);
  } catch (err) {
    console.error("[stylistManager] grant-access error:", err);
    res.redirect(`/manager/stylists${qs}`);
  }
});

// ── GET /managers/edit/:id ────────────────────────────────────────────────────
router.get("/managers/edit/:id", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const mgr = db.prepare("SELECT * FROM managers WHERE id = ? AND salon_id = ? AND role != 'owner'").get(req.params.id, salon_id);
  if (!mgr) return res.redirect(`/manager/stylists${qs}`);

  const inputCls = "w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent";
  const body = `
    <div class="mb-6">
      <h1 class="text-2xl font-bold">Edit Team Member</h1>
      <p class="text-sm text-mpMuted mt-0.5"><a href="/manager/stylists${qs}" class="text-mpAccent underline">← Back to Team</a></p>
    </div>
    <form method="POST" action="/manager/stylists/managers/edit/${safe(mgr.id)}${qs}" class="space-y-4 max-w-lg">
      <div class="rounded-2xl border border-mpBorder bg-white p-6 space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">First Name</label>
            <input type="text" name="first_name" value="${safe((mgr.name || "").split(" ")[0])}" class="${inputCls}" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Last Name</label>
            <input type="text" name="last_name" value="${safe((mgr.name || "").split(" ").slice(1).join(" "))}" class="${inputCls}" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Email</label>
          <input type="email" name="email" value="${safe(mgr.email || "")}" class="${inputCls}" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Role</label>
          <select name="role" class="${inputCls}">
            <option value="manager" ${mgr.role === "manager" ? "selected" : ""}>Manager</option>
            <option value="coordinator" ${mgr.role === "coordinator" ? "selected" : ""}>Coordinator</option>
          </select>
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">New Password (leave blank to keep current)</label>
          <input type="text" name="new_password" class="${inputCls}" placeholder="Optional" />
        </div>
      </div>
      <div class="flex gap-3">
        <button type="submit" class="rounded-full bg-mpCharcoal px-6 py-2.5 text-sm font-bold text-white hover:bg-mpCharcoalDark transition-colors">Save Changes</button>
        <a href="/manager/stylists${qs}" class="inline-flex items-center rounded-full border border-mpBorder px-6 py-2.5 text-sm font-medium text-mpMuted hover:bg-mpBg transition-colors">Cancel</a>
      </div>
    </form>
  `;
  res.send(pageShell({ title: "Edit Team Member", body, salon_id, current: "team" }));
});

// ── POST /managers/edit/:id ───────────────────────────────────────────────────
router.post("/managers/edit/:id", requireAuth, async (req, res) => {
  const salon_id = req.manager.salon_id;
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const mgr = db.prepare("SELECT id FROM managers WHERE id = ? AND salon_id = ? AND role != 'owner'").get(req.params.id, salon_id);
  if (!mgr) return res.redirect(`/manager/stylists${qs}`);

  const { first_name, last_name, email, role, new_password } = req.body;
  const name = [first_name, last_name].filter(Boolean).join(" ") || email;

  try {
    if (new_password && new_password.trim()) {
      const password_hash = await bcrypt.hash(new_password.trim(), 10);
      db.prepare("UPDATE managers SET name=?, email=?, role=?, password_hash=?, updated_at=datetime('now') WHERE id=? AND salon_id=?")
        .run(name, (email || "").toLowerCase().trim(), role, password_hash, mgr.id, salon_id);
    } else {
      db.prepare("UPDATE managers SET name=?, email=?, role=?, updated_at=datetime('now') WHERE id=? AND salon_id=?")
        .run(name, (email || "").toLowerCase().trim(), role, mgr.id, salon_id);
    }
    res.redirect(`/manager/stylists${qs}`);
  } catch (err) {
    console.error("[stylistManager] manager edit error:", err);
    res.redirect(`/manager/stylists${qs}`);
  }
});

// ── POST /managers/delete/:id ─────────────────────────────────────────────────
router.post("/managers/delete/:id", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  db.prepare("DELETE FROM managers WHERE id = ? AND salon_id = ? AND role != 'owner'").run(req.params.id, salon_id);
  res.redirect(`/manager/stylists${qs}`);
});

// ── Unified Add Team Member form ──────────────────────────────────────────────
function buildTeamMemberForm({ salon_id, salonTone, managerSeatsAvailable }) {
  const qs = `?salon=${encodeURIComponent(salon_id)}`;
  const inputCls = "w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent";

  return `
    <div class="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold">Add Team Member</h1>
        <p class="text-sm text-mpMuted mt-0.5">
          <a href="/manager/stylists${qs}" class="text-mpAccent underline">← Back to Team</a>
        </p>
      </div>
    </div>

    <form method="POST" action="/manager/stylists/add${qs}" enctype="multipart/form-data">
      <div class="rounded-2xl border border-mpBorder bg-white p-6 space-y-5 max-w-2xl">

        <!-- Role Selector -->
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-2">Role</label>
          <div class="flex gap-2 flex-wrap" id="roleButtons">
            <button type="button" data-role="stylist"
              class="role-btn rounded-full px-4 py-2 text-xs font-semibold border-2 border-mpCharcoal bg-mpCharcoal text-white transition-colors">
              Stylist
            </button>
            <button type="button" data-role="manager"
              class="role-btn rounded-full px-4 py-2 text-xs font-semibold border-2 transition-colors
              ${managerSeatsAvailable ? "border-mpBorder bg-white text-mpMuted hover:border-mpCharcoal hover:text-mpCharcoal" : "border-mpBorder bg-mpBg text-gray-300 cursor-not-allowed"}"
              ${!managerSeatsAvailable ? 'disabled title="No manager seats available on your plan"' : ""}>
              Manager ${!managerSeatsAvailable ? "(No seats)" : ""}
            </button>
            <button type="button" data-role="coordinator"
              class="role-btn rounded-full px-4 py-2 text-xs font-semibold border-2 border-mpBorder bg-white text-mpMuted hover:border-mpCharcoal hover:text-mpCharcoal transition-colors">
              Coordinator
            </button>
          </div>
          <p class="text-[11px] text-mpMuted mt-1.5">
            <strong>Stylist</strong> — posts via SMS/text. <strong>Manager</strong> — manages team and approves posts (seat-limited). <strong>Coordinator</strong> — approves posts and views analytics (unlimited).
          </p>
          <input type="hidden" name="role" id="selectedRole" value="stylist" />
        </div>

        <!-- Common Fields -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">First Name</label>
            <input type="text" name="first_name" class="${inputCls}" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Last Name</label>
            <input type="text" name="last_name" class="${inputCls}" />
          </div>
        </div>
        <div>
          <label class="block text-xs font-semibold text-mpMuted mb-1">Phone Number</label>
          <input type="tel" name="phone" class="${inputCls}" placeholder="+13175550100" />
          <p class="text-[11px] text-mpMuted mt-0.5">Required for Stylists (they text photos to this number). Optional for Manager/Coordinator.</p>
        </div>

        <!-- Stylist-specific fields -->
        <div id="stylist-fields">
          <div class="space-y-5">
            <div>
              <label class="block text-xs font-semibold text-mpMuted mb-1">Profile Photo</label>
              <input type="file" name="photo" accept="image/*"
                     class="text-sm text-mpMuted file:mr-3 file:rounded-full file:border-0
                            file:bg-mpAccentLight file:px-3 file:py-1.5 file:text-xs file:font-semibold
                            file:text-mpAccent hover:file:bg-mpAccent hover:file:text-white" />
              <p class="text-[11px] text-mpMuted mt-0.5">Used in celebration posts.</p>
            </div>
            <div>
              <label class="block text-xs font-semibold text-mpMuted mb-1">Instagram Handle</label>
              <input type="text" name="instagram_handle" class="${inputCls}" placeholder="Without @" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-mpMuted mb-1">Caption Tone</label>
              <select name="tone_variant" class="${inputCls}">
                ${toneSelectOptions("", salonTone)}
              </select>
              <p class="text-[11px] text-mpMuted mt-0.5">Personalizes AI caption voice. Defaults to salon tone if not set.</p>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-mpMuted mb-1">Birthday (MM-DD)</label>
                <input type="text" name="birthday_mmdd" class="${inputCls}" placeholder="03-15" />
              </div>
              <div>
                <label class="block text-xs font-semibold text-mpMuted mb-1">Hire Date</label>
                <input type="date" name="hire_date" class="${inputCls}" />
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold text-mpMuted mb-1">Specialties</label>
              <input type="text" name="specialties" class="${inputCls}" placeholder="Balayage, Color Correction" />
              <p class="text-[11px] text-mpMuted mt-0.5">Comma-separated.</p>
            </div>
            <div>
              <label class="block text-xs font-semibold text-mpMuted mb-1">Bio</label>
              <input type="text" name="bio" class="${inputCls}" />
            </div>
            <div class="flex items-center gap-2">
              <input type="checkbox" name="celebrations_enabled" value="1" id="celeb_check" checked
                     class="h-4 w-4 rounded border-mpBorder text-mpAccent" />
              <label for="celeb_check" class="text-xs text-mpMuted">Enable birthday &amp; anniversary celebration posts</label>
            </div>
            <div class="flex items-center gap-2">
              <input type="checkbox" name="auto_approve" value="1" id="auto_approve_check"
                     class="h-4 w-4 rounded border-mpBorder text-mpAccent" />
              <label for="auto_approve_check" class="text-xs text-mpMuted">Auto-approve — posts go straight to queue when stylist approves (no manager review)</label>
            </div>
          </div>
        </div>

        <!-- Portal (Manager/Staff) fields -->
        <div id="portal-fields" class="hidden space-y-4">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Email Address</label>
            <input type="email" name="email" class="${inputCls}" placeholder="they'll use this to log in" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Temporary Password</label>
            <input type="text" name="temp_password" class="${inputCls}" placeholder="They can change it after first login" />
            <p class="text-[11px] text-mpMuted mt-0.5">Share this with them directly. Not sent automatically.</p>
          </div>
        </div>

      </div>

      <div class="mt-4 flex gap-3">
        <button type="submit"
          class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-6 py-2.5 text-sm font-bold text-white hover:bg-mpCharcoalDark transition-colors">
          Add Team Member
        </button>
        <a href="/manager/stylists${qs}"
           class="inline-flex items-center rounded-full border border-mpBorder px-6 py-2.5 text-sm font-medium text-mpMuted hover:bg-mpBg transition-colors">
          Cancel
        </a>
      </div>
    </form>

    <script>
      (function() {
        const roleBtns = document.querySelectorAll(".role-btn");
        const roleInput = document.getElementById("selectedRole");
        const stylistFields = document.getElementById("stylist-fields");
        const portalFields = document.getElementById("portal-fields");

        roleBtns.forEach(btn => {
          if (btn.disabled) return;
          btn.addEventListener("click", () => {
            const role = btn.dataset.role;
            roleInput.value = role;
            roleBtns.forEach(b => {
              if (b.disabled) return;
              b.classList.remove("border-mpCharcoal", "bg-mpCharcoal", "text-white");
              b.classList.add("border-mpBorder", "bg-white", "text-mpMuted");
            });
            btn.classList.add("border-mpCharcoal", "bg-mpCharcoal", "text-white");
            btn.classList.remove("border-mpBorder", "bg-white", "text-mpMuted");
            if (role === "stylist") {
              stylistFields.classList.remove("hidden");
              portalFields.classList.add("hidden");
            } else {
              stylistFields.classList.add("hidden");
              portalFields.classList.remove("hidden");
            }
          });
        });
      })();
    </script>
  `;
}

export default router;
