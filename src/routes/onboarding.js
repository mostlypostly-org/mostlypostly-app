// src/routes/onboarding.js
import express from "express";
import fs from "fs";
import path from "path";
import db from "../../db.js";

const router = express.Router();

/* ---------------------------------------------------------
   SESSION + HELPERS
--------------------------------------------------------- */

function getSessionManager(req) {
  if (req.session && req.session.manager) {
    return req.session.manager;
  }

  if (req.session?.manager_id && req.session?.salon_id) {
    return {
      id: req.session.manager_id,
      salon_id: req.session.salon_id,
    };
  }

  return null;
}

function getManagerSignupInfo(managerId) {
  return db.prepare(
    `SELECT name, phone FROM managers WHERE id = ?`
  ).get(managerId);
}

// Ensure salon row exists in DB for this manager (by slug)
function ensureSalonRecord(manager) {
  const salon_id = manager.salon_id;

  let salon = db
    .prepare("SELECT * FROM salons WHERE slug = ?")
    .get(salon_id);

  if (!salon) {
    db.prepare(
      `INSERT INTO salons (id, slug, name)
       VALUES (lower(hex(randomblob(16))), ?, '')`
    ).run(salon_id);

    salon = db
      .prepare("SELECT * FROM salons WHERE slug = ?")
      .get(salon_id);
  }

  return salon;
}

function writeSalonJson(salon_id) {
  const salon = db
    .prepare("SELECT * FROM salons WHERE slug = ?")
    .get(salon_id);

  const stylists = db
    .prepare(
      "SELECT id, name, phone, instagram_handle, specialties FROM stylists WHERE salon_id = ? ORDER BY name ASC"
    )
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
      facebook_page_id: salon.facebook_page_id,
    },

    posting_rules: {
      start: salon.posting_start_time,
      end: salon.posting_end_time,
      auto_approval: !!salon.auto_approval,
      spacing_min: salon.spacing_min,
      spacing_max: salon.spacing_max,
      auto_publish: !!salon.auto_publish,
      tone: salon.tone,
    },

    manager: {
      display_name: salon.manager_display_name,
      title: salon.manager_title,
      phone: salon.manager_phone,
    },

    stylists: stylists.map((s) => {
      let specs = [];
      try {
        specs = s.specialties ? JSON.parse(s.specialties) : [];
        if (!Array.isArray(specs)) specs = [];
      } catch (e) {
        specs = [];
      }
      return {
        id: s.id,
        name: s.name,
        phone: s.phone,
        instagram_handle: s.instagram_handle,
        specialties: specs,
      };
    }),
  };

  const outPath = path.join(process.cwd(), "salons", `${salon_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
}

/* ---------------------------------------------------------
   PAGE TEMPLATE
--------------------------------------------------------- */

function pageTemplate({ step, stepLabel, content }) {
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

      <!-- Left -->
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

      <!-- Right -->
      <div class="w-2/3">
        <div class="bg-slate-900 border border-slate-700 rounded-xl p-6">

          ${content}

          ${
            step > 1
              ? `<a href="/onboarding/${
                  step === 2
                    ? "salon"
                    : step === 3
                    ? "salon"
                    : step === 4
                    ? "rules"
                    : step === 5
                    ? "manager"
                    : "stylists"
                }"
                    class="inline-block mt-6 text-slate-300 hover:text-white text-sm underline">
                  ← Back
                </a>`
              : ""
          }
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
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(manager);

  res.send(
    pageTemplate({
      step: 1,
      stepLabel: "Salon Basics",
      content: `
      <form method="POST" class="space-y-4">

        <div>
          <label class="block mb-1 text-sm">Salon Name</label>
          <input name="name" class="w-full bg-slate-800 rounded p-2"
                 value="${salon.name || ""}" required />
        </div>

        <!-- Business Phone -->
        <div>
          <label class="block mb-1 text-sm">Business Phone</label>
          <input name="phone"
                 pattern="^\\d{10}$"
                 title="Enter a 10-digit phone number"
                 class="w-full bg-slate-800 rounded p-2"
                 value="${salon.phone || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Website</label>
          <input name="website"
                 type="url"
                 placeholder="https://example.com"
                 class="w-full bg-slate-800 rounded p-2"
                 value="${salon.website || ""}" />
        </div>

        <div>
          <label class="block mb-1 text-sm">Booking Link</label>
          <input name="booking_link"
                 type="url"
                 placeholder="https://booking.com/your-salon"
                 class="w-full bg-slate-800 rounded p-2"
                 value="${salon.booking_link || ""}" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">City</label>
            <input name="city" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.city || ""}" />
          </div>

          <div>
            <label class="block mb-1 text-sm">State</label>
            <select name="state" class="w-full bg-slate-800 rounded p-2">
              ${[
                "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
                "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
                "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
                "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
                "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"
              ]
                .map(
                  (st) =>
                    `<option value="${st}" ${
                      salon.state === st ? "selected" : ""
                    }>${st}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>

        <div>
          <label class="block mb-1 text-sm">Industry</label>
          <select name="industry" class="w-full bg-slate-800 rounded p-2">
            <option value="salon" ${
              salon.industry === "salon" ? "selected" : ""
            }>Salon</option>
            <option value="spa" ${
              salon.industry === "spa" ? "selected" : ""
            }>Spa</option>
            <option value="barbershop" ${
              salon.industry === "barbershop" ? "selected" : ""
            }>Barbershop</option>
            <option value="other" ${
              salon.industry === "other" ? "selected" : ""
            }>Other</option>
          </select>
        </div>

        <!-- Timezone -->
        <div>
          <label class="block mb-1 text-sm">Timezone</label>
          <select name="timezone" class="w-full bg-slate-800 rounded p-2">
            ${[
              ["Eastern (US & Canada)", "America/New_York"],
              ["Central (US & Canada)", "America/Chicago"],
              ["Mountain (US & Canada)", "America/Denver"],
              ["Mountain (No DST) — Arizona", "America/Phoenix"],
              ["Pacific (US & Canada)", "America/Los_Angeles"],
              ["Alaska", "America/Anchorage"],
              ["Hawaii", "Pacific/Honolulu"],
            ]
              .map(([label, tz]) => {
                const selected = salon.timezone === tz ? "selected" : "";
                return `<option value="${tz}" ${selected}>${label}</option>`;
              })
              .join("")}
          </select>
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `,
    })
  );
});

router.post("/salon", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;
  const { name, phone, website, booking_link, city, state, industry, timezone } =
    req.body;

  const defaultHashtag = "#" + (name || "").replace(/\s+/g, "");

  db.prepare(
    `UPDATE salons SET 
      name=?,
      phone=?,
      website=?,
      booking_link=?,
      city=?,
      state=?,
      industry=?,
      timezone=?,
      default_hashtags=?,
      status_step='rules',
      updated_at=datetime('now')
     WHERE slug=?`
  ).run(
    name,
    phone,
    website,
    booking_link,
    city,
    state,
    industry,
    timezone,
    defaultHashtag,
    salon_id
  );

  res.redirect("/onboarding/rules");
});

/* ---------------------------------------------------------
   STEP 3 — POSTING RULES + TONE
--------------------------------------------------------- */

router.get("/rules", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(manager);

    // 12-hour time options, stored as 24-hour strings in DB
  // Limited to 7:00 AM – 10:00 PM in 1-hour increments
  const timeOptions = [
    ["7:00 AM", "07:00"],
    ["8:00 AM", "08:00"],
    ["9:00 AM", "09:00"],
    ["10:00 AM", "10:00"],
    ["11:00 AM", "11:00"],
    ["12:00 PM", "12:00"],
    ["1:00 PM", "13:00"],
    ["2:00 PM", "14:00"],
    ["3:00 PM", "15:00"],
    ["4:00 PM", "16:00"],
    ["5:00 PM", "17:00"],
    ["6:00 PM", "18:00"],
    ["7:00 PM", "19:00"],
    ["8:00 PM", "20:00"],
    ["9:00 PM", "21:00"],
    ["10:00 PM", "22:00"],
  ];

  // Default to 9:00 AM – 9:00 PM if nothing saved yet
  const startValue = salon.posting_start_time || "09:00";
  const endValue = salon.posting_end_time || "21:00";


  res.send(
    pageTemplate({
      step: 3,
      stepLabel: "Posting Rules & Tone",
      content: `
      <form method="POST" class="space-y-4">

        <!-- Posting window (12-hour dropdowns) -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">Posting Window Start</label>
            <select name="posting_start_time" class="w-full bg-slate-800 rounded p-2 text-sm">
              ${timeOptions
                .map(
                  ([label, val]) =>
                    `<option value="${val}" ${
                      val === startValue ? "selected" : ""
                    }>${label}</option>`
                )
                .join("")}
            </select>
          </div>

          <div>
            <label class="block mb-1 text-sm">Posting Window End</label>
            <select name="posting_end_time" class="w-full bg-slate-800 rounded p-2 text-sm">
              ${timeOptions
                .map(
                  ([label, val]) =>
                    `<option value="${val}" ${
                      val === endValue ? "selected" : ""
                    }>${label}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>

        <!-- Spacing Min / Max -->
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block mb-1 text-sm">Spacing Min (minutes)</label>
            <input name="spacing_min" type="number" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.spacing_min || 20}" />
            <p class="text-xs text-slate-400 mt-1">Recommended: 20 minutes</p>
          </div>

          <div>
            <label class="block mb-1 text-sm">Spacing Max (minutes)</label>
            <input name="spacing_max" type="number" class="w-full bg-slate-800 rounded p-2"
                   value="${salon.spacing_max || 45}" />
            <p class="text-xs text-slate-400 mt-1">Recommended: 45 minutes</p>
          </div>
        </div>

        <!-- Auto-approval -->
        <div>
          <label class="block mb-1 text-sm">Auto-Approval</label>
          <select name="auto_approval" class="w-full bg-slate-800 rounded p-2">
            <option value="0" ${salon.auto_approval ? "" : "selected"}>Disabled</option>
            <option value="1" ${salon.auto_approval ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <!-- Auto-publish -->
        <div>
          <label class="block mb-1 text-sm">Auto-Publish</label>
          <select name="auto_publish" class="w-full bg-slate-800 rounded p-2">
            <option value="0" ${salon.auto_publish ? "" : "selected"}>Disabled</option>
            <option value="1" ${salon.auto_publish ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <!-- Tone Profile -->
        <div>
          <label class="block mb-1 text-sm">Tone Profile</label>
          <select name="tone" class="w-full bg-slate-800 rounded p-2">
            ${[
              "Professional",
              "Fun & Energetic",
              "Clean & Modern",
              "Bold & Trendy",
              "Warm & Friendly",
              "Minimalistic",
              "Classic Salon Voice",
            ]
              .map((opt) => {
                const selected = salon.tone === opt ? "selected" : "";
                return `<option value="${opt}" ${selected}>${opt}</option>`;
              })
              .join("")}
          </select>
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>
      </form>
    `,
    })
  );
});

router.post("/rules", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;

  const {
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    auto_approval,
    auto_publish,
    tone,
  } = req.body;

  db.prepare(
    `UPDATE salons SET 
      posting_start_time=?,
      posting_end_time=?,
      spacing_min=?,
      spacing_max=?,
      auto_approval=?,
      auto_publish=?,
      tone=?,
      status_step='manager',
      updated_at=datetime('now')
     WHERE slug=?`
  ).run(
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    auto_approval,
    auto_publish,
    tone,
    salon_id
  );

  res.redirect("/onboarding/manager");
});

/* ---------------------------------------------------------
   STEP 4 — MANAGER PROFILE
--------------------------------------------------------- */

router.get("/manager", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(manager);
  const ms = getManagerSignupInfo(manager.id);

  res.send(
    pageTemplate({
      step: 4,
      stepLabel: "Manager Profile",
      content: `
      <form method="POST" class="space-y-4">

        <div>
          <label class="block mb-1 text-sm">Manager Name</label>
          <input class="w-full bg-slate-800 rounded p-2 opacity-60 cursor-not-allowed"
                 value="${ms?.name || salon.manager_display_name || ""}"
                 disabled />
          <input type="hidden" name="manager_display_name"
                 value="${ms?.name || salon.manager_display_name || ""}">
        </div>

        <div>
          <label class="block mb-1 text-sm">Title</label>
          <input class="w-full bg-slate-800 rounded p-2 opacity-60 cursor-not-allowed"
                 value="${salon.manager_title || "Owner"}"
                 disabled />
          <input type="hidden" name="manager_title"
                 value="${salon.manager_title || "Owner"}">
        </div>

        <div>
          <label class="block mb-1 text-sm">Manager Phone</label>
          <input class="w-full bg-slate-800 rounded p-2 opacity-60 cursor-not-allowed"
                 value="${ms?.phone || salon.manager_phone || ""}"
                 disabled />
          <input type="hidden" name="manager_phone"
                 value="${ms?.phone || salon.manager_phone || ""}">
        </div>

        <button class="w-full mt-4 bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
          Continue →
        </button>

      </form>
    `,
    })
  );
});

router.post("/manager", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;

  const { manager_display_name, manager_title, manager_phone } = req.body;

  db.prepare(
    `UPDATE salons SET 
      manager_display_name=?,
      manager_title=?,
      manager_phone=?,
      status_step='stylists',
      updated_at=datetime('now')
     WHERE slug=?`
  ).run(manager_display_name, manager_title, manager_phone, salon_id);

  res.redirect("/onboarding/stylists");
});

/* ---------------------------------------------------------
   STEP 5 — STYLISTS (WITH SPECIALTIES, EDIT & DELETE)
--------------------------------------------------------- */

router.get("/stylists", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;

  const stylists = db
    .prepare(
      "SELECT id, name, phone, instagram_handle, specialties FROM stylists WHERE salon_id=? ORDER BY name ASC"
    )
    .all(salon_id);

  // Are we editing an existing stylist?
  const editId = req.query.edit || "";
  const editStylist = stylists.find((s) => s.id === editId) || null;

  function parseSpecs(row) {
    if (!row || !row.specialties) return [];
    try {
      const parsed = JSON.parse(row.specialties);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const editSpecialties = parseSpecs(editStylist);
  const editSpecialtiesJson = JSON.stringify(editSpecialties);

  const stylistRows = stylists
    .map((s) => {
      const specs = parseSpecs(s);
      const specLabel = specs.join(", ");
      return `
        <div class="grid grid-cols-5 gap-4 mb-3 items-center text-xs">
          <div class="truncate font-semibold text-slate-100">${s.name || "—"}</div>
          <div class="truncate text-slate-300">${s.phone || "—"}</div>
          <div class="truncate text-slate-300">${s.instagram_handle || "—"}</div>
          <div class="truncate text-slate-300">${specLabel || "—"}</div>
          <div class="flex justify-end gap-2">
            <a href="/onboarding/stylists?edit=${s.id}"
               class="text-[11px] px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:border-indigo-500">
              Edit
            </a>
            <form method="POST" action="/onboarding/stylists/delete" class="inline">
              <input type="hidden" name="stylist_id" value="${s.id}" />
              <button type="submit"
                class="text-[11px] px-2 py-1 rounded bg-slate-800 border border-red-500 hover:bg-red-600 hover:text-white">
                🗑
              </button>
            </form>
          </div>
        </div>
      `;
    })
    .join("");

  res.send(
    pageTemplate({
      step: 5,
      stepLabel: "Stylists & Specialties",
      content: `
      ${
        stylistRows ||
        "<p class='text-slate-400 mb-4 text-sm'>No stylists added yet.</p>"
      }

      <div class="border-t border-slate-700 mt-4 pt-4">
        <h3 class="text-sm font-semibold text-slate-100 mb-2">
          ${editStylist ? "Edit Stylist" : "Add Stylist"}
        </h3>

        <form id="stylist-form" method="POST" class="space-y-4">

          <input type="hidden" name="stylist_id" value="${
            editStylist ? editStylist.id : ""
          }" />

          <div class="grid grid-cols-3 gap-4">
            <input
              name="stylist_name"
              placeholder="Stylist Name"
              class="bg-slate-800 rounded p-2 text-sm"
              value="${editStylist ? editStylist.name || "" : ""}"
            />
            <input
              name="stylist_phone"
              placeholder="Phone (10 digits)"
              class="bg-slate-800 rounded p-2 text-sm"
              value="${editStylist ? editStylist.phone || "" : ""}"
            />
            <input
              name="stylist_ig"
              placeholder="@instagram"
              class="bg-slate-800 rounded p-2 text-sm"
              value="${editStylist ? editStylist.instagram_handle || "" : ""}"
            />
          </div>

          <!-- Specialties tag input -->
          <div>
            <label class="block mb-1 text-sm">Specialties</label>
            <div id="specialties-tags" class="flex flex-wrap gap-2 mb-2"></div>
            <input
              type="text"
              id="specialty-input"
              placeholder="Type a specialty and press Enter"
              class="w-full bg-slate-800 rounded p-2 text-sm"
            />
            <input type="hidden" name="specialties_json" id="specialties-json" />
            <p class="text-[11px] text-slate-400 mt-1">
              Suggestions: Men's Grooming, Vivids, Balayage, Lived-in Blonde, Short Haircuts, Extensions, Spa, Coloring
            </p>
          </div>

          <button class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-3 font-semibold">
            ${editStylist ? "Save Changes" : "Add Stylist"}
          </button>

        </form>

        <form method="POST" action="/onboarding/review">
          <button class="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 rounded p-3 font-semibold">
            Continue to Review →
          </button>
        </form>
      </div>

      <script>
        (function() {
          const input = document.getElementById("specialty-input");
          const container = document.getElementById("specialties-tags");
          const hidden = document.getElementById("specialties-json");
          const form = document.getElementById("stylist-form");

          if (!input || !container || !hidden || !form) return;

          let specialties = ${editSpecialtiesJson || "[]"};

          function renderTags() {
            container.innerHTML = "";
            specialties.forEach((spec, idx) => {
              const chip = document.createElement("span");
              chip.className =
                "inline-flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-100 border border-slate-700";
              const label = document.createElement("span");
              label.textContent = spec;
              const btn = document.createElement("button");
              btn.type = "button";
              btn.textContent = "×";
              btn.className = "text-slate-400 hover:text-red-400";
              btn.addEventListener("click", () => {
                specialties.splice(idx, 1);
                syncHidden();
                renderTags();
              });
              chip.appendChild(label);
              chip.appendChild(btn);
              container.appendChild(chip);
            });
          }

          function syncHidden() {
            hidden.value = JSON.stringify(specialties);
          }

          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const value = (input.value || "").trim();
              if (!value) return;
              if (!specialties.includes(value)) {
                specialties.push(value);
                syncHidden();
                renderTags();
              }
              input.value = "";
            }
          });

          form.addEventListener("submit", () => {
            syncHidden();
          });

          // Initial render
          syncHidden();
          renderTags();
        })();
      </script>
    `,
    })
  );
});

router.post("/stylists", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;
  const {
    stylist_id,
    stylist_name,
    stylist_phone,
    stylist_ig,
    specialties_json,
  } = req.body;

  const specs =
    specialties_json && specialties_json.trim()
      ? specialties_json.trim()
      : "[]";

  if (!stylist_name && !stylist_phone && !stylist_ig && specs === "[]") {
    return res.redirect("/onboarding/stylists");
  }

  if (stylist_id) {
    // UPDATE existing stylist
    db.prepare(
      `UPDATE stylists
       SET name = ?, phone = ?, instagram_handle = ?, specialties = ?
       WHERE id = ? AND salon_id = ?`
    ).run(stylist_name, stylist_phone, stylist_ig, specs, stylist_id, salon_id);
  } else {
    // INSERT new stylist
    db.prepare(
      `INSERT INTO stylists (id, salon_id, name, phone, instagram_handle, specialties)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)`
    ).run(salon_id, stylist_name, stylist_phone, stylist_ig, specs);
  }

  res.redirect("/onboarding/stylists");
});

// Delete stylist during onboarding
router.post("/stylists/delete", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;
  const { stylist_id } = req.body;

  if (stylist_id) {
    db.prepare(
      `DELETE FROM stylists WHERE id = ? AND salon_id = ?`
    ).run(stylist_id, salon_id);
  }

  res.redirect("/onboarding/stylists");
});

/* ---------------------------------------------------------
   STEP 6 — REVIEW & COMPLETE
--------------------------------------------------------- */

router.post("/review", (req, res) => {
  res.redirect("/onboarding/review");
});

router.get("/review", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon = ensureSalonRecord(manager);

  const stylists = db
    .prepare(
      "SELECT id, name, phone, instagram_handle, specialties FROM stylists WHERE salon_id=? ORDER BY name ASC"
    )
    .all(manager.salon_id);

  function formatPhone(p) {
    if (!p) return "";
    if (p.length !== 10) return p;
    return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
  }

  const timezoneMap = {
    "America/New_York": "Eastern (US & Canada)",
    "America/Chicago": "Central (US & Canada)",
    "America/Denver": "Mountain (US & Canada)",
    "America/Phoenix": "Mountain (No DST) — Arizona",
    "America/Los_Angeles": "Pacific (US & Canada)",
    "America/Anchorage": "Alaska",
    "Pacific/Honolulu": "Hawaii",
  };

  const formattedTimezone =
    timezoneMap[salon.timezone] || salon.timezone || "";

  const formattedIndustry = salon.industry
    ? salon.industry.charAt(0).toUpperCase() + salon.industry.slice(1)
    : "";

  const stylistHtml = stylists
    .map((s) => {
      let specs = [];
      try {
        specs = s.specialties ? JSON.parse(s.specialties) : [];
        if (!Array.isArray(specs)) specs = [];
      } catch (e) {
        specs = [];
      }
      const specLabel = specs.join(", ");
      return `<li><strong>${s.name}</strong> — ${formatPhone(
        s.phone
      )} — ${s.instagram_handle || "—"}${
        specLabel ? " — " + specLabel : ""
      }</li>`;
    })
    .join("");

  res.send(
    pageTemplate({
      step: 6,
      stepLabel: "Review & Complete",
      content: `
      <div class="space-y-8">

        <!-- SALON DETAILS -->
        <div>
          <h3 class="text-lg font-semibold mb-2">Salon Details</h3>
          <div class="text-sm space-y-1 text-slate-300">
            <div><strong>Name:</strong> ${salon.name}</div>
            <div><strong>Business Phone:</strong> ${formatPhone(
              salon.phone
            )}</div>
            <div><strong>City:</strong> ${salon.city}</div>
            <div><strong>State:</strong> ${salon.state}</div>
            <div><strong>Website:</strong> ${salon.website}</div>
            <div><strong>Booking Link:</strong> ${salon.booking_link}</div>
            <div><strong>Timezone:</strong> ${formattedTimezone}</div>
            <div><strong>Industry:</strong> ${formattedIndustry}</div>
            <div><strong>Default Hashtag:</strong> ${
              salon.default_hashtags || ""
            }</div>
          </div>
        </div>

        <!-- POSTING RULES -->
        <div>
          <h3 class="text-lg font-semibold mb-2">Posting Rules</h3>
          <div class="text-sm space-y-1 text-slate-300">
            <div><strong>Window:</strong> ${
              salon.posting_start_time
            } → ${salon.posting_end_time}</div>
            <div><strong>Auto-Approval:</strong> ${
              salon.auto_approval ? "Enabled" : "Disabled"
            }</div>
            <div><strong>Auto-Publish:</strong> ${
              salon.auto_publish ? "Enabled" : "Disabled"
            }</div>
            <div><strong>Spacing:</strong> ${salon.spacing_min}–${
        salon.spacing_max
      } minutes</div>
            <div><strong>Tone Profile:</strong> ${salon.tone || "Default"}</div>
          </div>
        </div>

        <!-- MANAGER -->
        <div>
          <h3 class="text-lg font-semibold mb-2">Manager</h3>
          <div class="text-sm space-y-1 text-slate-300">
            <div><strong>Name:</strong> ${salon.manager_display_name}</div>
            <div><strong>Title:</strong> ${salon.manager_title}</div>
            <div><strong>Phone:</strong> ${formatPhone(
              salon.manager_phone
            )}</div>
          </div>
        </div>

        <!-- STYLISTS -->
        <div>
          <h3 class="text-lg font-semibold mb-2">Stylists</h3>
          <ul class="text-sm text-slate-300 space-y-1">
            ${
              stylistHtml ||
              "<li>No stylists added.</li>"
            }
          </ul>
        </div>

        <form method="POST" action="/onboarding/complete">
          <button class="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 rounded p-3 font-semibold">
            Finish & Activate Salon →
          </button>
        </form>
      </div>
    `,
    })
  );
});

router.post("/complete", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  const salon_id = manager.salon_id;

  writeSalonJson(salon_id);

  db.prepare(
    `UPDATE salons SET 
       status='active',
       status_step='complete',
       updated_at=datetime('now')
     WHERE slug=?`
  ).run(salon_id);

  res.redirect(`/dashboard?salon=${salon_id}`);
});

export default router;
