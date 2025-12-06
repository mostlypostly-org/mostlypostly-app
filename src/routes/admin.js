// ───────────────────────────────────────────────────────────
// Admin Router — Fully synced with /public/admin.js modal system
// ───────────────────────────────────────────────────────────

import express from "express";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";
import crypto from "crypto";
import { isContentSafe, sanitizeText } from "../../src/utils/moderation.js";

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
router.get("/templates", requireAuth, (req, res) => {
  res.sendFile("public/admin-templates.html", {
    root: process.cwd(),
  });
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

  // Managers
  const dbManagers = db
    .prepare(
      `SELECT id, name, phone, role FROM managers WHERE salon_id = ? ORDER BY name ASC`
    )
    .all(salon_id);

  // Members
  const dbStylists = db
    .prepare(
      `SELECT id, name, phone, instagram_handle, specialties
       FROM stylists
       WHERE salon_id = ?
       ORDER BY name ASC`
    )
    .all(salon_id);

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
    city: salonRow.city,
    state: salonRow.state,
    website: salonRow.website,
    booking_url: salonRow.booking_url,
    timezone: salonRow.timezone || "America/Indiana/Indianapolis",
    industry: (salonRow.industry || "Salon").trim().replace(/\b\w/g, x => x.toUpperCase()),
    tone_profile: salonRow.tone || "default",
    auto_publish: !!salonRow.auto_publish,
    default_hashtags: defaultHashtags,
  };

  const settings = {
    posting_window: {
      start: salonRow.posting_start_time || "07:00",
      end: salonRow.posting_end_time || "20:00",
    },
    require_manager_approval: !!salonRow.require_manager_approval,
    random_delay_minutes: {
      min: salonRow.spacing_min ?? 20,
      max: salonRow.spacing_max ?? 45,
    },
  };

  // Team table rows
let teamRows = "";

// Managers
dbManagers.forEach((m) => {
  teamRows += `
    <tr class="border-b border-zinc-800/80">
      <td class="px-3 py-2 text-sm text-zinc-100">${m.name}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">Manager</td>
      <td class="px-3 py-2 text-xs text-zinc-300">${m.phone}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">—</td>
      <td class="px-3 py-2 text-xs text-zinc-300">—</td>
      <td class="px-3 py-2 text-xs text-zinc-300">—</td>
      <td class="px-3 py-2 text-xs text-zinc-300 text-right"></td>
    </tr>
  `;
});

// Members
dbStylists.forEach((s) => {
  let specialties = [];
  if (s.specialties) {
    try {
      const parsed = JSON.parse(s.specialties);
      if (Array.isArray(parsed)) specialties = parsed;
      else specialties = String(s.specialties).split(",").map(x => x.trim());
    } catch {
      specialties = String(s.specialties).split(",").map(x => x.trim());
    }
  }

  teamRows += `
    <tr class="border-b border-zinc-800/80">
      <td class="px-3 py-2 text-sm text-zinc-100">${s.name}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">Service Provider</td>
      <td class="px-3 py-2 text-xs text-zinc-300">${s.phone}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">${s.instagram_handle || "—"}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">${specialties.join(", ") || "—"}</td>
      <td class="px-3 py-2 text-xs text-zinc-300">—</td>

      <td class="px-3 py-2 text-xs text-zinc-300 text-right">
        <button
          class="text-xs text-indigo-400 hover:text-indigo-300 underline"
          onclick='window.admin.openEditStylist({
            id: ${JSON.stringify(s.id)},
            name: ${JSON.stringify(s.name)},
            phone: ${JSON.stringify(s.phone)},
            instagram: ${JSON.stringify(s.instagram_handle)},
            specialties: ${JSON.stringify(specialties)}
          })'
        >Edit</button>
      </td>
    </tr>
  `;
});

  // Build Admin Page HTML
  const body = `
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-2">Admin — <span class="text-mpPrimary">${
        info.name
      }</span></h1>
      <p class="text-sm text-zinc-400">Manage social connections, posting rules, and team configuration.</p>
    </section>

    <!-- SOCIAL CONNECTIONS -->
    <section class="mb-6 grid gap-4 md:grid-cols-[1.2fr,0.8fr]">

      <!-- Facebook & Instagram -->
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Facebook & Instagram</h2>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between">
            <dt class="text-zinc-400">Facebook Page ID</dt>
            <dd>${salonRow.facebook_page_id || "Not configured"}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-zinc-400">Instagram Handle</dt>
            <dd>${
              salonRow.instagram_handle
                ? "@" + salonRow.instagram_handle
                : "Not configured"
            }</dd>
          </div>
        </dl>

        <div class="mt-4">
          <a href="/auth/facebook/login?salon=${salon_id}"
             class="inline-flex items-center px-3 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700">
            Connect / Refresh Facebook & Instagram
          </a>
        </div>
        <p class="mt-2 text-[11px] text-zinc-500">
              Uses your MostlyPostly Facebook App to grant or refresh Page & Instagram permissions.
            </p>
      </div>

      <!-- Salon Info -->
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Business Info</h2>
          <button onclick="window.admin.openSalonInfo()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>

        <dl class="space-y-1 text-xs text-zinc-300">

          <div class="flex justify-between"><dt class="text-zinc-400">Name</dt><dd>${
            info.name
          }</dd></div>

          <div class="flex justify-between"><dt class="text-zinc-400">City</dt><dd>${
            info.city
          }</dd></div>

          <div class="flex justify-between"><dt class="text-zinc-400">State</dt><dd>${
            info.state
          }</dd></div>

          <div class="flex justify-between"><dt class="text-zinc-400">Website</dt><dd>${
            info.website
              ? `<a href="${info.website}" target="_blank" class="underline text-blue-400">Visit</a>`
              : "Not set"
          }</dd></div>

          <div class="flex justify-between"><dt class="text-zinc-400">Industry</dt><dd>${
            info.industry
          }</dd></div>

          <div class="flex justify-between"><dt class="text-zinc-400">Timezone</dt><dd>${
            info.timezone
          }</dd></div>

          <div class="flex justify-between">
            <dt class="text-zinc-400">Booking URL</dt>
            <dd>${
              info.booking_url
                ? `<a href="${info.booking_url}" target="_blank" class="underline text-blue-400">Visit</a>`
                : "Not set"
            }</dd>
          </div>

          <div class="flex justify-between"><dt class="text-zinc-400">Tone Profile</dt><dd>${
            info.tone_profile
          }</dd></div>

          <!-- Hashtags -->
          <div class="flex flex-col gap-1 mt-2">
            <div class="flex justify-between mb-1">
              <dt class="text-zinc-400">Default Hashtags</dt>
              <button onclick="window.admin.openHashtags()" class="text-slate-400 hover:text-white text-xs">✏️</button>
            </div>
            <dd class="flex flex-wrap gap-1">
              <!-- Primary salon tag (locked) -->
              <span class="inline-flex bg-slate-800 px-2 py-0.5 rounded-full text-[11px] font-semibold">
                ${info.default_hashtags[0] || ""}
              </span>

              <!-- Custom tags -->
              ${info.default_hashtags
                .slice(1)
                .map(
                  (tag) =>
                    `<span class="inline-flex bg-slate-800 px-2 py-0.5 rounded-full text-[11px]">${tag}</span>`
                )
                .join("")}
            </dd>

          </div>

        </dl>
      </div>
    </section>

    <!-- POSTING RULES -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <!-- Posting Window -->
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Posting Rules</h2>
          <button onclick="window.admin.openPostingRules()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>
          <p class="text-xs text-zinc-300 mb-3">
            MostlyPostly only posts inside your configured window (business local time).
          </p>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between">
            <dt class="text-zinc-400">Posting Window Start</dt>
            <dd>${fmtTime(settings.posting_window.start)}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-zinc-400">Posting Window End</dt>
            <dd>${fmtTime(settings.posting_window.end)}</dd>
          </div>
          <div class="flex justify-between">
              <dt class="text-zinc-400">Random Delay</dt>
            <dd>${settings.random_delay_minutes.min}–${settings.random_delay_minutes.max} min</dd>
          </div>
        </dl>
      </div>

      <!-- Manager Rules -->
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Manager Rules</h2>
          <button onclick="window.admin.openManagerRules()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>

        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between">
            <dt class="text-zinc-400">Require Manager Approval</dt>
            <dd>${salonRow.require_manager_approval ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-zinc-400">Notify member on approval</dt>
            <dd>${salonRow.notify_on_approval ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-zinc-400">Notify member on denial</dt>
            <dd>${salonRow.notify_on_denial ? "Enabled" : "Disabled"}</dd>
          </div>

          <div class="flex justify-between">
            <dt class="text-zinc-400">Auto Publish</dt>
            <dd>${info.auto_publish ? "Enabled" : "Disabled"}</dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- TEAM MEMBERS -->
    <section class="mb-6">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="mb-3">
          <div class="flex justify-between mb-1">
            <h2 class="text-sm font-semibold text-zinc-50">Registered Team Members</h2>

            <!-- Working Add Button -->
            <button onclick="window.admin.openAddStylist()"
              class="ml-3 text-xs font-semibold text-mpAccent hover:text-mpAccentDark">
              + Add
            </button>
          </div>
          <p class="text-[11px] text-zinc-400">
            Managers and members who can receive SMS and post through MostlyPostly.
          </p>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="bg-slate-950 text-zinc-400">
              <tr>
                <th class="px-3 py-2 text-left">Name</th>
                <th class="px-3 py-2 text-left">Role</th>
                <th class="px-3 py-2 text-left">Phone</th>
                <th class="px-3 py-2 text-left">IG Handle</th>
                <th class="px-3 py-2 text-left">Specialties</th>
                <th class="px-3 py-2 text-left">SMS Opt-in</th>
                <th class="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>${teamRows}</tbody>
          </table>
        </div>
      </div>
    </section>
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
            class="relative w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-700 p-6 shadow-xl">

            <!-- PERMANENT CLOSE BUTTON (NOT OVERWRITTEN) -->
            <button
              id="admin-modal-close"
              type="button"
              class="absolute top-3 right-3 text-lg text-slate-300 hover:text-white">
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
          data-city="${info.city}"
          data-state="${info.state}"
          data-website="${info.website}"
          data-booking-url="${info.booking_url}"
          data-timezone="${info.timezone}"
          data-tone="${info.tone_profile}"
          data-auto-publish="${info.auto_publish ? "1" : "0"}"

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

  `;

  // Render page
  res.send(
    pageShell({
      title: `Admin — ${info.name}`,
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
router.post("/update-salon-info", (req, res) => {
  const {
    salon_id,
    name,
    city,
    state,
    website,
    booking_url,
    industry,
    tone_profile
  } = req.body;


  if (!salon_id) {
    return res.status(400).send("Missing salon_id");
  }

  try {
    db.prepare(
      `
      UPDATE salons
        SET
          name        = COALESCE(?, name),
          city        = COALESCE(?, city),
          state       = COALESCE(?, state),
          website     = COALESCE(?, website),
          booking_url = COALESCE(?, booking_url),
          industry    = COALESCE(?, industry),
          tone        = COALESCE(?, tone),
          updated_at  = datetime('now')
        WHERE slug = ?

    `
    ).run(
      name || null,
      city || null,
      state || null,
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
// POST: Update Posting Rules  (ONLY posting window + spacing)
// -------------------------------------------------------
router.post("/update-posting-rules", requireAuth, (req, res) => {
  try {
    const {
      salon_id,
      posting_start_time,
      posting_end_time,
      spacing_min,
      spacing_max
    } = req.body;

    if (!salon_id) {
      return res.status(400).send("Missing salon_id");
    }

    const spacingMinInt = parseInt(spacing_min, 10) || 0;
    const spacingMaxInt = parseInt(spacing_max, 10) || 0;

    db.prepare(
      `
      UPDATE salons
      SET 
        posting_start_time = COALESCE(?, posting_start_time),
        posting_end_time   = COALESCE(?, posting_end_time),
        spacing_min        = COALESCE(?, spacing_min),
        spacing_max        = COALESCE(?, spacing_max),
        updated_at = datetime('now')
      WHERE slug = ?
    `
    ).run(
      posting_start_time || null,
      posting_end_time || null,
      spacingMinInt,
      spacingMaxInt,
      salon_id
    );

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
    const {
      salon_id,
      require_manager_approval,
      auto_approval,
      auto_publish,
      notify_on_approval,
      notify_on_denial
    } = req.body;

    if (!salon_id) {
      return res.status(400).send("Missing salon_id");
    }

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
router.post("/update-hashtags", (req, res) => {
  const { salon_id, hashtags_json } = req.body;

  if (!salon_id) {
    return res.status(400).send("Missing salon_id");
  }

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
  // Accept both ?salon and ?salon_id because some templates send salon_id
  const id = req.query.id;
  const salon = req.query.salon || req.query.salon_id;

  if (!id || !salon) {
    return res.status(400).send("Missing parameters");
  }

  try {
    db.prepare("DELETE FROM stylists WHERE id = ? AND salon_id = ?").run(id, salon);
    return res.redirect(`/manager/admin?salon=${encodeURIComponent(salon)}`);
  } catch (err) {
    console.error("Delete stylist failed:", err);
    return res.status(500).send("Failed to delete stylist");
  }
});


// ───────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────
export default router;
