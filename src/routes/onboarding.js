// src/routes/onboarding.js
import express from "express";
import fs from "fs";
import path from "path";
import db from "../../db.js";

const router = express.Router();

/* ---------------------------------------------------------
   UTILITIES
--------------------------------------------------------- */

// Create or fetch the salon record for the manager
function ensureSalonRecord(manager) {
  const salon_id = manager.salon_id;

  let salon = db
    .prepare("SELECT * FROM salons WHERE salon_id = ?")
    .get(salon_id);

  if (!salon) {
    db.prepare(
      `INSERT INTO salons (
        salon_id, name, phone, website, booking_link,
        city, state, industry, timezone,
        instagram_handle, facebook_page_id,
        styled_by_rule, default_cta,
        posting_start_time, posting_end_time,
        auto_approval, spacing_min, spacing_max,
        manager_display_name, manager_title, manager_phone,
        status, status_step, created_at, updated_at
      ) VALUES (
        ?, '', '', '', '',
        '', '', '', '',
        '', '',
        'name', 'Book via link in bio.',
        '09:00', '19:00',
        0, 20, 45,
        '', '', '',
        'setup_incomplete', 'salon', datetime('now'), datetime('now')
      )`
    ).run(salon_id);

    salon = db.prepare("SELECT * FROM salons WHERE salon_id = ?").get(salon_id);
  }

  return salon;
}

// Writes salons/<id>.json at final step
function writeSalonJson(salon_id) {
  const salon = db.prepare("SELECT * FROM salons WHERE salon_id = ?").get(salon_id);

  const stylists = db
    .prepare("SELECT * FROM stylists WHERE salon_id = ? ORDER BY name ASC")
    .all(salon_id);

  const obj = {
    salon_id,
    name: salon.name,
    phone: salon.phone,
    website: salon.website,
    booking_link: salon.booking_link,
    city: salon.city,
    state: salon.state,
    industry: salon.industry,
    timezone: salon.timezone,

    social: {
      instagram_handle: salon.instagram_handle,
      facebook_page_id: salon.facebook_page_id
    },

    posting_rules: {
      start: salon.posting_start_time,
      end: salon.posting_end_time,
      auto_approval: !!salon.auto_approval,
      spacing_min: salon.spacing_min,
      spacing_max: salon.spacing_max
    },

    manager: {
      display_name: salon.manager_display_name,
      title: salon.manager_title,
      phone: salon.manager_phone
    },

    stylists
  };

  const outPath = path.join(process.cwd(), "salons", `${salon_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
}

/* ---------------------------------------------------------
   TEMPLATE WRAPPER (HYBRID LAYOUT)
--------------------------------------------------------- */

function pageTemplate({ step, stepLabel, nextStep, content }) {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Onboarding – Step ${step}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>

  <body class="bg-slate-950 text-slate-100">

    <div class="mx-auto max-w-5xl py-10 px-4 flex gap-12">

      <!-- Left: Progress + Intro -->
      <div class="w-1/3">
        <h1 class="text-3xl font-bold mb-4">Welcome to MostlyPostly</h1>
        <p class="text-slate-300 mb-6">Let’s set up your salon profile.</p>

        <div class="mb-8">
          <div class="text-sm text-slate-400 mb-2">Step ${step} of 6</div>
          <div class="w-full bg-slate-800 h-2 rounded">
            <div class="bg-indigo-500 h-2 rounded" style="width: ${(step / 6) * 100}%"></div>
          </div>
        </div>

        <h2 class="text-xl font-semibold">${stepLabel}</h2>
      </div>

      <!-- Right: Form Card -->
      <div class="w-2/3">
        <div class="bg-slate-900 border border-slate-700 rounded-xl p-6">
          ${content}
        </div>
      </div>

    </div>
  </body>
  </html>
  `;
}

/* ---------------------------------------------------------
   STEP 1 — SALON BASICS
--------------------------------------------------------- */
router.get("/salon", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const manager = req.session.manager;
  const salon = ensureSalonRecord(manager);

  res.send(pageTemplate({
    step: 1,
    stepLabel: "Salon Basics",
    content: `
      <form method="POST" class="space-y-4">
        <div>
          <label class="block mb-1 text-sm">Salon Name</label>
          <input name="name" class="w-full bg-slate-800 rounded p-2" value="${salon.name || ""}" required />
        </div>

        <div>
          <label class="block mb-1 text-sm">Phone</label>
          <input name="phone" class="w-full bg-slate-800 rounded p-2" value="${salon.phone || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Website</label>
          <input name="website" class="w-full bg-slate-800 rounded p-2" value="${salon.website || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Booking Link</label>
          <input name="booking_link" class="w-full bg-slate-800 rounded p-2" value="${salon.booking_link || ""}" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">City</label>
            <input name="city" class="w-full bg-slate-800 rounded p-2" value="${salon.city || ""}" />
          </div>
          <div>
            <label class="block mb-1 text-sm">State</label>
            <input name="state" class="w-full bg-slate-800 rounded p-2" value="${salon.state || ""}" />
          </div>
        </div>

        <div>
          <label class="block mb-1 text-sm">Industry</label>
          <select name="industry" class="w-full bg-slate-800 rounded p-2">
            <option value="salon" ${salon.industry === "salon" ? "selected" : ""}>Salon</option>
            <option value="spa" ${salon.industry === "spa" ? "selected" : ""}>Spa</option>
            <option value="barbershop" ${salon.industry === "barbershop" ? "selected" : ""}>Barbershop</option>
            <option value="other" ${salon.industry === "other" ? "selected" : ""}>Other</option>
          </select>
        </div>

        <div>
          <label class="block mb-1 text-sm">Timezone</label>
          <input name="timezone" class="w-full bg-slate-800 rounded p-2" value="${salon.timezone || "America/Chicago"}" />
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `
  }));
});


router.post("/salon", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const manager = req.session.manager;
  const salon_id = manager.salon_id;
  const { name, phone, website, booking_link, city, state, industry, timezone } = req.body;

  db.prepare(
    `UPDATE salons SET 
      name=?, phone=?, website=?, booking_link=?, 
      city=?, state=?, industry=?, timezone=?,
      status_step='social', updated_at=datetime('now')
     WHERE salon_id=?`
  ).run(name, phone, website, booking_link, city, state, industry, timezone, salon_id);

  res.redirect("/onboarding/social");
});

/* ---------------------------------------------------------
   STEP 2 — SOCIAL SETUP
--------------------------------------------------------- */
router.get("/social", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(req.session.manager);

  res.send(pageTemplate({
    step: 2,
    stepLabel: "Social Setup",
    content: `
      <form method="POST" class="space-y-4">
        <div>
          <label class="block mb-1 text-sm">Instagram Handle (@username)</label>
          <input name="instagram_handle" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.instagram_handle || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Facebook Page ID</label>
          <input name="facebook_page_id" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.facebook_page_id || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Default CTA</label>
          <input name="default_cta" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.default_cta || "Book via link in bio."}" />
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `
  }));
});


router.post("/social", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;
  const { instagram_handle, facebook_page_id, default_cta } = req.body;

  db.prepare(
    `UPDATE salons SET 
      instagram_handle=?, facebook_page_id=?, default_cta=?,
      status_step='rules', updated_at=datetime('now')
     WHERE salon_id=?`
  ).run(instagram_handle, facebook_page_id, default_cta, salon_id);

  res.redirect("/onboarding/rules");
});

/* ---------------------------------------------------------
   STEP 3 — POSTING RULES
--------------------------------------------------------- */
router.get("/rules", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(req.session.manager);

  res.send(pageTemplate({
    step: 3,
    stepLabel: "Posting Rules",
    content: `
      <form method="POST" class="space-y-4">

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">Posting Window Start</label>
            <input name="posting_start_time" type="time" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.posting_start_time || "09:00"}" />
          </div>

          <div>
            <label class="block mb-1 text-sm">Posting Window End</label>
            <input name="posting_end_time" type="time" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.posting_end_time || "19:00"}" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">Spacing Min (minutes)</label>
            <input name="spacing_min" type="number" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.spacing_min || 20}" />
          </div>

          <div>
            <label class="block mb-1 text-sm">Spacing Max (minutes)</label>
            <input name="spacing_max" type="number" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.spacing_max || 45}" />
          </div>
        </div>

        <div>
          <label class="block mb-1 text-sm">Auto-Approval</label>
          <select name="auto_approval" class="w-full bg-slate-800 rounded p-2">
            <option value="0" ${salon.auto_approval ? "" : "selected"}>Disabled</option>
            <option value="1" ${salon.auto_approval ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `
  }));
});


router.post("/rules", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;
  const {
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    auto_approval
  } = req.body;

  db.prepare(
    `UPDATE salons SET 
      posting_start_time=?, posting_end_time=?, 
      spacing_min=?, spacing_max=?, auto_approval=?,
      status_step='manager', updated_at=datetime('now')
     WHERE salon_id=?`
  ).run(
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    auto_approval,
    salon_id
  );

  res.redirect("/onboarding/manager");
});

/* ---------------------------------------------------------
   STEP 4 — MANAGER PROFILE
--------------------------------------------------------- */
router.get("/manager", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(req.session.manager);

  res.send(pageTemplate({
    step: 4,
    stepLabel: "Manager Profile",
    content: `
      <form method="POST" class="space-y-4">

        <div>
          <label class="block mb-1 text-sm">Display Name</label>
          <input name="manager_display_name" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.manager_display_name || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Title</label>
          <input name="manager_title" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.manager_title || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Phone</label>
          <input name="manager_phone" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.manager_phone || ""}" />
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `
  }));
});


router.post("/manager", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;
  const {
    manager_display_name,
    manager_title,
    manager_phone
  } = req.body;

  db.prepare(
    `UPDATE salons SET 
      manager_display_name=?, manager_title=?, manager_phone=?,
      status_step='stylists', updated_at=datetime('now')
     WHERE salon_id=?`
  ).run(manager_display_name, manager_title, manager_phone, salon_id);

  res.redirect("/onboarding/stylists");
});

/* ---------------------------------------------------------
   STEP 5 — STYLISTS
--------------------------------------------------------- */
router.get("/stylists", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;

  const stylists = db
    .prepare("SELECT * FROM stylists WHERE salon_id=? ORDER BY name ASC")
    .all(salon_id);

  const stylistRows = stylists
    .map(s => `
      <div class="grid grid-cols-3 gap-4 mb-4">
        <input class="bg-slate-800 rounded p-2" value="${s.name}" disabled />
        <input class="bg-slate-800 rounded p-2" value="${s.phone}" disabled />
        <input class="bg-slate-800 rounded p-2" value="${s.instagram_handle}" disabled />
      </div>
    `)
    .join("");

  res.send(pageTemplate({
    step: 5,
    stepLabel: "Stylists",
    content: `
      ${stylistRows || "<p class='text-slate-400 mb-4'>No stylists added yet.</p>"}

      <form method="POST" class="space-y-4 border-t border-slate-700 pt-4">

        <div class="grid grid-cols-3 gap-4">
          <input name="stylist_name" placeholder="Stylist Name" class="bg-slate-800 rounded p-2" />
          <input name="stylist_phone" placeholder="Phone" class="bg-slate-800 rounded p-2" />
          <input name="stylist_ig" placeholder="@instagram" class="bg-slate-800 rounded p-2" />
        </div>

        <button class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Add Stylist
        </button>

      </form>

      <form method="POST" action="/onboarding/review">
        <button class="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 rounded p-3 font-semibold">
          Continue to Review →
        </button>
      </form>
    `
  }));
});


router.post("/stylists", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;
  const { stylist_name, stylist_phone, stylist_ig } = req.body;

  if (stylist_name || stylist_phone || stylist_ig) {
    db.prepare(
      `INSERT INTO stylists (id, salon_id, name, phone, instagram_handle)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
    ).run(salon_id, stylist_name, stylist_phone, stylist_ig);
  }

  res.redirect("/onboarding/stylists");
});

/* ---------------------------------------------------------
   STEP 6 — REVIEW + COMPLETE
--------------------------------------------------------- */
router.get("/review", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(req.session.manager);

  const stylists = db
    .prepare("SELECT * FROM stylists WHERE salon_id=? ORDER BY name ASC")
    .all(salon.salon_id);

  const stylistHtml = stylists
    .map(s => `<li>${s.name} – ${s.phone} – ${s.instagram_handle}</li>`)
    .join("");

  res.send(pageTemplate({
    step: 6,
    stepLabel: "Review & Complete",
    content: `
      <p class="mb-4 text-slate-300">Please review your information. You can go back if needed.</p>

      <pre class="bg-slate-800 p-4 rounded text-xs text-slate-300 mb-6" style="max-height:300px; overflow:auto;">
${JSON.stringify(salon, null, 2)}
      </pre>

      <p class="text-sm mb-4">Stylists:</p>
      <ul class="mb-6 text-slate-300 text-sm">
        ${stylistHtml || "<li>No stylists added.</li>"}
      </ul>

      <form method="POST" action="/onboarding/complete">
        <button class="w-full bg-emerald-600 hover:bg-emerald-700 rounded p-3 font-semibold">
          Finish & Activate Salon →
        </button>
      </form>
    `
  }));
});


router.post("/complete", (req, res) => {
  if (!req.session.manager) return res.redirect("/manager/login");

  const salon_id = req.session.manager.salon_id;

  // Write JSON
  writeSalonJson(salon_id);

  // Activate salon
  db.prepare(
    `UPDATE salons SET 
       status='active', status_step='complete',
       updated_at=datetime('now')
     WHERE salon_id=?`
  ).run(salon_id);

  return res.redirect(`/dashboard?salon=${salon_id}`);
});

export default router;
