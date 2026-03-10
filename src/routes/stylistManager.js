// src/routes/stylistManager.js
// Modernized stylist management: list, add, edit, delete, CSV import/export.

import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import crypto from "crypto";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { TONE_GROUPS, TONE_VARIANT_MAP } from "../core/toneVariants.js";

const router = express.Router();

import { UPLOADS_DIR, toUploadUrl } from "../core/uploadPath.js";

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
           celebrations_enabled
    FROM stylists WHERE salon_id = ? ORDER BY COALESCE(first_name, name) ASC
  `).all(salon_id);

  const cards = stylists.map(s => {
    const displayName = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.name;
    const specialties = parseSpecialties(s.specialties);
    return `
      <div class="rounded-2xl border border-mpBorder bg-white p-4 flex gap-3 items-start">
        ${avatarHtml(s)}
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="text-sm font-semibold text-mpCharcoal">${safe(displayName)}</p>
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
        </div>
      </div>`;
  }).join("");

  const empty = stylists.length === 0
    ? `<div class="col-span-full text-center py-12 text-mpMuted text-sm">
         No stylists yet. Add your first team member above.
       </div>`
    : "";

  const body = `
    <section class="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">Team</h1>
        <p class="text-sm text-mpMuted mt-0.5">${stylists.length} service provider${stylists.length !== 1 ? "s" : ""} registered</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <a href="/manager/stylists/add${qs}"
           class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          + Add Stylist
        </a>
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

    <!-- CSV upload form (hidden, triggered by file input) -->
    <form id="csvUploadForm" method="POST" action="/manager/stylists/import${qs}" enctype="multipart/form-data" class="hidden">
      <input type="file" name="csv" id="csvFormInput" accept=".csv" />
    </form>

    <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      ${cards}${empty}
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
  const salon = db.prepare("SELECT tone FROM salons WHERE slug = ?").get(salon_id);
  res.send(pageShell({
    title: "Add Stylist",
    body: buildStylistForm({ salon_id, salonTone: salon?.tone, stylist: null, isEdit: false }),
    salon_id,
    current: "team",
  }));
});

// ── POST /add ─────────────────────────────────────────────────────────────────
router.post("/add", requireAuth, photoUpload.single("photo"), (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT tone FROM salons WHERE slug = ?").get(salon_id);
  const { first_name, last_name, phone, instagram_handle, tone_variant,
          birthday_mmdd, hire_date, bio, profile_url, celebrations_enabled } = req.body;

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
         photo_url, celebrations_enabled)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    );
    res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);
  } catch (err) {
    console.error("[stylistManager] add error:", err);
    res.send(pageShell({
      title: "Add Stylist",
      body: `<p class="text-red-500 text-sm mb-4">${safe(err.message)}</p>` +
            buildStylistForm({ salon_id, salonTone: salon?.tone, stylist: req.body, isEdit: false }),
      salon_id,
      current: "team",
    }));
  }
});

// ── GET /edit/:id ─────────────────────────────────────────────────────────────
router.get("/edit/:id", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon = db.prepare("SELECT tone FROM salons WHERE slug = ?").get(salon_id);
  const stylist = db.prepare("SELECT * FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  res.send(pageShell({
    title: "Edit Stylist",
    body: buildStylistForm({ salon_id, salonTone: salon?.tone, stylist, isEdit: true }),
    salon_id,
    current: "team",
  }));
});

// ── POST /edit/:id ────────────────────────────────────────────────────────────
router.post("/edit/:id", requireAuth, photoUpload.single("photo"), (req, res) => {
  const salon_id = req.manager.salon_id;
  const { first_name, last_name, phone, instagram_handle, tone_variant,
          birthday_mmdd, hire_date, bio, profile_url, celebrations_enabled } = req.body;

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
      photo_url = ?, celebrations_enabled = ?
    WHERE id = ? AND salon_id = ?
  `).run(
    name, first_name || null, last_name || null, normalizePhone(phone),
    instagram_handle || null, tone_variant || null,
    normalizeBirthday(birthday_mmdd), hire_date || null,
    specialties, bio || null, profile_url || null,
    photo_url, celebrations_enabled === "1" ? 1 : 0,
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
        <div class="relative group rounded-2xl overflow-hidden border border-mpBorder bg-white">
          <img src="${safe(p.url)}" class="w-full h-44 object-cover" />
          <div class="px-3 py-2">
            <span class="inline-block text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 bg-mpAccentLight text-mpAccent">${safe(p.category || "general")}</span>
            ${p.label ? `<p class="text-xs text-mpMuted mt-0.5 truncate">${safe(p.label)}</p>` : ""}
          </div>
          <form method="POST" action="/manager/stylists/${safe(stylist.id)}/photos/delete${qs}" class="absolute top-2 right-2">
            <input type="hidden" name="photo_id" value="${safe(p.id)}" />
            <button class="rounded-full bg-white border border-mpBorder shadow px-2 py-0.5 text-xs text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100">Remove</button>
          </form>
        </div>`).join("")
    : `<p class="text-sm text-mpMuted col-span-2">No photos uploaded yet.</p>`;

  const body = `
    <div class="mb-6">
      <h1 class="text-2xl font-bold">Photo Library — ${safe(stylist.name)}</h1>
      <p class="text-sm text-mpMuted mt-0.5">
        <a href="/manager/stylists/edit/${safe(stylist.id)}${qs}" class="text-mpAccent underline">← Back to stylist</a>
      </p>
    </div>

    <div class="rounded-2xl border border-mpBorder bg-white p-6 mb-6 max-w-2xl">
      <h2 class="text-sm font-bold text-mpCharcoal mb-1">Upload Photos</h2>
      <p class="text-xs text-mpMuted mb-4">These photos are used as backgrounds for availability and promotion posts. Upload in-chair shots, styling photos, or professional headshots.</p>
      <form method="POST" action="/manager/stylists/${safe(stylist.id)}/photos/upload${qs}" enctype="multipart/form-data" class="space-y-3">
        <input type="file" name="photo" accept="image/*" required multiple
          class="w-full text-sm text-mpMuted file:mr-3 file:py-1.5 file:px-3 file:rounded-full file:border-0
                 file:text-xs file:font-semibold file:bg-mpAccentLight file:text-mpAccent
                 hover:file:bg-mpAccent hover:file:text-white transition-colors" />
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Category</label>
            <select name="category" class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent">
              <option value="styling">Stylist Work</option>
              <option value="profile">Profile / Headshot</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-mpMuted mb-1">Label <span class="font-normal text-mpMuted">(optional)</span></label>
            <input type="text" name="label" placeholder="e.g. Balayage session"
              class="w-full rounded-xl border border-mpBorder px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent" />
          </div>
        </div>
        <button class="inline-flex items-center gap-1.5 rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Upload Photos
        </button>
      </form>
    </div>

    <div class="grid grid-cols-2 sm:grid-cols-3 gap-4 max-w-2xl">
      ${photoCards}
    </div>
  `;

  res.send(pageShell({ title: `${stylist.name} Photos`, body, salon_id, current: "team" }));
});

// ── POST /edit/:id/photos/upload ──────────────────────────────────────────────
router.post("/:id/photos/upload", requireAuth, libraryUpload.single("photo"), (req, res) => {
  const salon_id = req.manager.salon_id;
  const stylist = db.prepare("SELECT id FROM stylists WHERE id = ? AND salon_id = ?").get(req.params.id, salon_id);
  if (!stylist || !req.file) return res.redirect(`/manager/stylists?salon=${encodeURIComponent(salon_id)}`);

  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const url = `${base}/uploads/${req.file.filename}`;
  const category = ["styling", "profile"].includes(req.body.category) ? req.body.category : "styling";
  const label = (req.body.label || "").trim() || null;

  db.prepare(`
    INSERT INTO stock_photos (id, salon_id, stylist_id, label, url, category)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), salon_id, stylist.id, label, url, category);

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
      <a href="/manager/stylists/edit/${safe(s.id)}/photos${qs}"
         class="inline-flex items-center gap-1.5 rounded-full bg-mpAccent px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors flex-shrink-0">
        📷 Photo Library
      </a>` : ""}
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

export default router;
