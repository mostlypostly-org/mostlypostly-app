// src/routes/onboarding.js
import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import fetch from "node-fetch";
import db from "../../db.js";
import { UPLOADS_DIR, toUploadUrl } from "../core/uploadPath.js";

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw.trim() || null;
}

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

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
  const backRoute = step === 2 ? "salon" : step === 3 ? "brand" : step === 4 ? "rules" : step === 5 ? "manager" : "stylists";
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Onboarding – Step ${step}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            fontFamily: { sans: [‘"Plus Jakarta Sans"’, ‘ui-sans-serif’, ‘system-ui’, ‘sans-serif’] },
            colors: {
              mpCharcoal:     "#2B2D35",
              mpCharcoalDark: "#1a1c22",
              mpAccent:       "#D4897A",
              mpAccentLight:  "#F2DDD9",
              mpBg:           "#FDF8F6",
              mpCard:         "#FFFFFF",
              mpBorder:       "#EDE7E4",
              mpMuted:        "#7A7C85",
            }
          }
        }
      };
    </script>
    <style>
      body { font-family: ‘Plus Jakarta Sans’, ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; }
    </style>
  </head>

  <body>
    <!-- Header -->
    <header style="background:#fff;border-bottom:1px solid #EDE7E4;padding:12px 24px 12px 0;">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="height:40px;width:auto;display:block;" />
    </header>

    <div class="mx-auto max-w-5xl py-8 px-4 flex flex-col md:flex-row md:gap-12">

      <!-- Progress / step info (top on mobile, left sidebar on desktop) -->
      <div class="md:w-1/3 mb-6 md:mb-0">
        <h1 class="text-2xl font-extrabold mb-2" style="color:#2B2D35;">Set up your salon</h1>
        <p style="color:#7A7C85;font-size:14px;margin-bottom:20px;line-height:1.6;">Let’s get MostlyPostly configured for your team. It only takes a few minutes.</p>

        <div class="mb-4">
          <div style="font-size:12px;font-weight:600;color:#7A7C85;margin-bottom:8px;">Step ${step} of 7</div>
          <div style="width:100%;background:#EDE7E4;height:6px;border-radius:99px;overflow:hidden;">
            <div style="background:#D4897A;height:6px;border-radius:99px;width:${Math.round((step / 7) * 100)}%;transition:width 0.3s;"></div>
          </div>
        </div>

        <h2 class="text-lg font-bold" style="color:#2B2D35;">${stepLabel}</h2>
      </div>

      <!-- Form content -->
      <div class="md:w-2/3">
        <div style="background:#fff;border:1px solid #EDE7E4;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(43,45,53,0.05);">

          ${content}

          ${step > 1 ? `<a href="/onboarding/${backRoute}" style="display:inline-block;margin-top:20px;font-size:13px;color:#7A7C85;text-decoration:underline;">← Back</a>` : ""}
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
          <label class="block text-sm font-medium text-mpMuted mb-1">Salon Name</label>
          <input name="name" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                 value="${salon.name || ""}" required />
        </div>

        <!-- Business Phone -->
        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Business Phone</label>
          <input name="phone"
                 pattern="^\\d{10}$"
                 title="Enter a 10-digit phone number"
                 class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                 value="${salon.phone || ""}" />
        </div>

        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Website</label>
          <input name="website"
                 type="text"
                 placeholder="e.g. rejuvesalonspa.com"
                 class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                 value="${salon.website || ""}" />
        </div>

        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Booking Link</label>
          <input name="booking_link"
                 type="text"
                 placeholder="e.g. vagaro.com/your-salon"
                 class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                 value="${salon.booking_link || ""}" />
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">City</label>
            <input name="city" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                   value="${salon.city || ""}" />
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">State</label>
            <select name="state" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent appearance-none">
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
          <label class="block text-sm font-medium text-mpMuted mb-1">Industry</label>
          <select name="industry" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
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
          <label class="block text-sm font-medium text-mpMuted mb-1">Timezone</label>
          <select name="timezone" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
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

        <button style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;margin-top:16px;">
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
  const { name, phone, booking_link, city, state, industry, timezone } =
    req.body;

  // Normalize website URL — prepend https:// if no protocol given
  let website = (req.body.website || "").trim();
  if (website && !website.match(/^https?:\/\//i)) {
    website = "https://" + website;
  }
  let booking_link_normalized = (booking_link || "").trim();
  if (booking_link_normalized && !booking_link_normalized.match(/^https?:\/\//i)) {
    booking_link_normalized = "https://" + booking_link_normalized;
  }

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
      status_step='brand',
      updated_at=datetime('now')
     WHERE slug=?`
  ).run(
    name,
    phone,
    website,
    booking_link_normalized,
    city,
    state,
    industry,
    timezone,
    defaultHashtag,
    salon_id
  );

  res.redirect("/onboarding/brand");
});

/* ---------------------------------------------------------
   STEP 2 — BRAND PALETTE (extracted from website)
--------------------------------------------------------- */

async function extractPaletteFromWebsite(websiteUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !websiteUrl) return null;

  try {
    // Fetch the website HTML
    const resp = await fetch(websiteUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    const html = await resp.text();
    // Pull out only style/link/meta tags to keep token count low
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
{
  "primary": "#hex",
  "secondary": "#hex",
  "accent": "#hex",
  "accent_light": "#hex",
  "cta": "#hex"
}
All values must be hex color codes. No markdown, no explanation.`,
          },
          { role: "user", content: snippet },
        ],
      }),
    });
    const data = await gptResp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.warn("[Onboarding] Palette extraction failed:", err.message);
    return null;
  }
}

function paletteSwatches(palette) {
  const colors = [
    { key: "primary",      label: "Primary" },
    { key: "secondary",    label: "Secondary" },
    { key: "accent",       label: "Accent" },
    { key: "accent_light", label: "Light Accent" },
    { key: "cta",          label: "CTA / Button" },
  ];
  return colors.map(({ key, label }) => `
    <div class="flex items-center gap-3">
      <div id="swatch-${key}" class="w-12 h-12 rounded-xl border border-mpBorder shadow-sm flex-shrink-0"
           style="background:${palette[key] || '#cccccc'}"></div>
      <div class="flex-1">
        <p class="text-sm font-medium" style="color:#2B2D35;">${label}</p>
        <input type="text" name="${key}" value="${palette[key] || ''}" placeholder="#000000"
               style="font-family:monospace;font-size:13px;border:1px solid #EDE7E4;border-radius:8px;padding:4px 10px;width:110px;color:#2B2D35;background:#fff;"
               oninput="var el=document.getElementById('swatch-${key}');if(this.value.match(/^#[0-9a-fA-F]{6}$/))el.style.background=this.value;" />
      </div>
    </div>
  `).join("");
}

router.get("/brand", async (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  // ?reset=1 clears palette and re-extracts
  if (req.query.reset) {
    db.prepare("UPDATE salons SET brand_palette=NULL WHERE slug=?").run(manager.salon_id);
    return res.redirect("/onboarding/brand");
  }

  const salon = ensureSalonRecord(manager);

  // Load existing palette if already set
  let palette = null;
  try { if (salon.brand_palette) palette = JSON.parse(salon.brand_palette); } catch {}

  // Extract from website if not yet set
  if (!palette && salon.website) {
    palette = await extractPaletteFromWebsite(salon.website);
  }

  const hasPalette = palette && Object.keys(palette).length > 0;

  res.send(pageTemplate({
    step: 2,
    stepLabel: "Brand Colors",
    content: hasPalette ? `
      <p class="text-mpMuted text-sm mb-5">
        We pulled your brand colors from <span class="text-mpAccent font-mono">${salon.website || "your website"}</span>.
        Confirm they look right before continuing.
      </p>
      <form method="POST" class="space-y-4">
        ${paletteSwatches(palette)}
        <div class="pt-4 border-t border-mpBorder mt-4">
          <p class="text-xs mb-4" style="color:#7A7C85;">These colors will be used on your availability and promotion posts. Edit any hex value above to adjust.</p>
          <button type="submit" style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;">
            Looks good — Continue →
          </button>
          <a href="/onboarding/brand?reset=1" style="display:block;text-align:center;font-size:13px;color:#7A7C85;text-decoration:underline;margin-top:12px;">
            Re-extract colors
          </a>
        </div>
      </form>
    ` : `
      <p class="text-sm mb-5" style="color:#7A7C85;">
        ${salon.website
          ? `We couldn't automatically extract colors from <span style="font-family:monospace;color:#D4897A;">${salon.website}</span>.`
          : `No website set — colors couldn't be auto-extracted.`}
        Enter your brand colors manually below, or skip to set them later in Admin.
      </p>
      <form method="POST" class="space-y-4">
        ${paletteSwatches({ primary: "", secondary: "", accent: "", accent_light: "", cta: "" })}
        <div class="pt-4 border-t border-mpBorder mt-2">
          <p class="text-xs mb-4" style="color:#7A7C85;">These colors will be used on your promotion and availability posts. You can update them anytime in Admin → Brand Colors.</p>
          <button type="submit" style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;">
            Save Colors — Continue →
          </button>
          <button type="submit" name="skip" value="1" style="display:block;width:100%;margin-top:12px;background:transparent;border:none;font-size:13px;color:#7A7C85;text-decoration:underline;cursor:pointer;text-align:center;">
            Skip for now
          </button>
        </div>
      </form>
    `,
  }));
});

router.post("/brand", (req, res) => {
  const manager = getSessionManager(req);
  if (!manager) return res.redirect("/manager/login");

  if (!req.body.skip) {
    const { primary, secondary, accent, accent_light, cta } = req.body;
    const palette = JSON.stringify({ primary, secondary, accent, accent_light, cta });
    db.prepare("UPDATE salons SET brand_palette=?, status_step='rules', updated_at=datetime('now') WHERE slug=?")
      .run(palette, manager.salon_id);
  } else {
    db.prepare("UPDATE salons SET status_step='rules', updated_at=datetime('now') WHERE slug=?")
      .run(manager.salon_id);
  }

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
            <label class="block text-sm font-medium text-mpMuted mb-1">Posting Window Start</label>
            <select name="posting_start_time" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
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
            <label class="block text-sm font-medium text-mpMuted mb-1">Posting Window End</label>
            <select name="posting_end_time" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
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
            <label class="block text-sm font-medium text-mpMuted mb-1">Spacing Min (minutes)</label>
            <input name="spacing_min" type="number" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                   value="${salon.spacing_min || 20}" />
            <p class="text-xs text-mpMuted mt-1">Recommended: 20 minutes</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">Spacing Max (minutes)</label>
            <input name="spacing_max" type="number" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
                   value="${salon.spacing_max || 45}" />
            <p class="text-xs text-mpMuted mt-1">Recommended: 45 minutes</p>
          </div>
        </div>

        <!-- Auto-approval -->
        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Auto-Approval</label>
          <select name="auto_approval" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
            <option value="0" ${salon.auto_approval ? "" : "selected"}>Disabled</option>
            <option value="1" ${salon.auto_approval ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <!-- Auto-publish -->
        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Auto-Publish</label>
          <select name="auto_publish" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
            <option value="0" ${salon.auto_publish ? "" : "selected"}>Disabled</option>
            <option value="1" ${salon.auto_publish ? "selected" : ""}>Enabled</option>
          </select>
        </div>

        <!-- Tone Profile -->
        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Tone Profile</label>
          <select name="tone" class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent">
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

        <button style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;margin-top:16px;">
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
          <label class="block text-sm font-medium text-mpMuted mb-1">Manager Name</label>
          <input class="w-full border border-mpBorder bg-mpBg rounded-xl px-4 py-2.5 text-sm text-mpMuted opacity-60 cursor-not-allowed"
                 value="${ms?.name || salon.manager_display_name || ""}"
                 disabled />
          <input type="hidden" name="manager_display_name"
                 value="${ms?.name || salon.manager_display_name || ""}">
        </div>

        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Title</label>
          <input class="w-full border border-mpBorder bg-mpBg rounded-xl px-4 py-2.5 text-sm text-mpMuted opacity-60 cursor-not-allowed"
                 value="${salon.manager_title || "Owner"}"
                 disabled />
          <input type="hidden" name="manager_title"
                 value="${salon.manager_title || "Owner"}">
        </div>

        <div>
          <label class="block text-sm font-medium text-mpMuted mb-1">Manager Phone</label>
          <input class="w-full border border-mpBorder bg-mpBg rounded-xl px-4 py-2.5 text-sm text-mpMuted opacity-60 cursor-not-allowed"
                 value="${ms?.phone || salon.manager_phone || ""}"
                 disabled />
          <input type="hidden" name="manager_phone"
                 value="${ms?.phone || salon.manager_phone || ""}">
        </div>

        <button style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;margin-top:16px;">
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
        <div class="grid grid-cols-5 gap-4 mb-3 items-center text-xs py-2 border-b border-mpBorder last:border-0">
          <div class="truncate font-semibold text-mpCharcoal">${s.name || "—"}</div>
          <div class="truncate text-mpMuted">${s.phone || "—"}</div>
          <div class="truncate text-mpMuted">${s.instagram_handle || "—"}</div>
          <div class="truncate text-mpMuted">${specLabel || "—"}</div>
          <div class="flex justify-end gap-2">
            <a href="/onboarding/stylists?edit=${s.id}"
               class="text-[11px] px-2.5 py-1 rounded-lg border border-mpBorder bg-white text-mpCharcoal hover:border-mpAccent transition">
              Edit
            </a>
            <form method="POST" action="/onboarding/stylists/delete" class="inline">
              <input type="hidden" name="stylist_id" value="${s.id}" />
              <button type="submit"
                class="text-[11px] px-2.5 py-1 rounded-lg border border-red-200 bg-white text-red-400 hover:bg-red-50 hover:border-red-400 transition">
                ✕
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
        "<p class='text-mpMuted mb-4 text-sm'>No stylists added yet.</p>"
      }

      <div class="border-t border-mpBorder mt-4 pt-4">
        <h3 class="text-sm font-semibold text-mpCharcoal mb-2">
          ${editStylist ? "Edit Stylist" : "Add Stylist"}
        </h3>

        <form id="stylist-form" method="POST" enctype="multipart/form-data" class="space-y-4">

          <input type="hidden" name="stylist_id" value="${
            editStylist ? editStylist.id : ""
          }" />

          <div class="grid grid-cols-3 gap-4">
            <input
              name="stylist_name"
              placeholder="Stylist Name"
              class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
              value="${editStylist ? editStylist.name || "" : ""}"
            />
            <input
              name="stylist_phone"
              placeholder="Phone (10 digits)"
              class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
              value="${editStylist ? editStylist.phone || "" : ""}"
            />
            <input
              name="stylist_ig"
              placeholder="@instagram"
              class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
              value="${editStylist ? editStylist.instagram_handle || "" : ""}"
            />
          </div>

          <!-- Stylist Photo -->
          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">Stylist Photo <span class="text-mpMuted font-normal">(used for availability posts)</span></label>
            ${editStylist?.photo_url
              ? `<div class="mb-2 flex items-center gap-3">
                   <img src="${editStylist.photo_url}" class="w-16 h-16 rounded-xl object-cover border border-mpBorder" />
                   <span class="text-xs text-mpMuted">Current photo — upload a new one to replace</span>
                 </div>`
              : ""}
            <input type="file" name="stylist_photo" accept="image/*"
              class="w-full text-sm text-mpMuted file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:bg-mpBg file:text-mpCharcoal file:border file:border-mpBorder hover:file:bg-mpAccentLight" />
          </div>

          <!-- Specialties tag input -->
          <div>
            <label class="block text-sm font-medium text-mpMuted mb-1">Specialties</label>
            <div id="specialties-tags" class="flex flex-wrap gap-2 mb-2"></div>
            <input
              type="text"
              id="specialty-input"
              placeholder="Type a specialty, press Tab or Enter to add"
              class="w-full border border-mpBorder bg-white rounded-xl px-4 py-2.5 text-sm text-mpCharcoal focus:outline-none focus:ring-2 focus:ring-mpAccent/20 focus:border-mpAccent"
            />
            <input type="hidden" name="specialties_json" id="specialties-json" />
            <p class="text-[11px] text-mpMuted mt-1">
              Suggestions: Men's Grooming, Vivids, Balayage, Lived-in Blonde, Short Haircuts, Extensions, Spa, Coloring
            </p>
          </div>

          <button style="width:100%;background:#2B2D35;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;">
            ${editStylist ? "Save Changes" : "Add Stylist"}
          </button>

        </form>

        <form method="POST" action="/onboarding/review">
          <button style="width:100%;background:#D4897A;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;margin-top:24px;">
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
                "inline-flex items-center gap-1 rounded-full bg-mpAccentLight px-3 py-1 text-xs text-mpCharcoal border border-mpBorder";
              const label = document.createElement("span");
              label.textContent = spec;
              const btn = document.createElement("button");
              btn.type = "button";
              btn.textContent = "×";
              btn.className = "text-mpMuted hover:text-red-400";
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
            if (e.key === "Enter" || e.key === "Tab") {
              const value = (input.value || "").trim();
              if (!value) return;
              e.preventDefault();
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

router.post("/stylists", stylistPhotoUpload.single("stylist_photo"), (req, res) => {
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

  // Split full name into first/last
  const nameParts = (stylist_name || "").trim().split(/\s+/);
  const first_name = nameParts[0] || null;
  const last_name = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;
  const phone = normalizePhone(stylist_phone);

  // Build public photo URL if a file was uploaded
  const photoUrl = req.file ? toUploadUrl(req.file.filename) : null;

  if (stylist_id) {
    // UPDATE existing stylist — only overwrite photo if a new one was uploaded
    if (photoUrl) {
      db.prepare(
        `UPDATE stylists
         SET name = ?, first_name = ?, last_name = ?, phone = ?, instagram_handle = ?, specialties = ?, photo_url = ?
         WHERE id = ? AND salon_id = ?`
      ).run(stylist_name, first_name, last_name, phone, stylist_ig, specs, photoUrl, stylist_id, salon_id);
    } else {
      db.prepare(
        `UPDATE stylists
         SET name = ?, first_name = ?, last_name = ?, phone = ?, instagram_handle = ?, specialties = ?
         WHERE id = ? AND salon_id = ?`
      ).run(stylist_name, first_name, last_name, phone, stylist_ig, specs, stylist_id, salon_id);
    }
  } else {
    // INSERT new stylist
    db.prepare(
      `INSERT INTO stylists (id, salon_id, name, first_name, last_name, phone, instagram_handle, specialties, photo_url)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(salon_id, stylist_name, first_name, last_name, phone, stylist_ig, specs, photoUrl);
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
          <div class="text-sm space-y-1 text-mpMuted">
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
          <div class="text-sm space-y-1 text-mpMuted">
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
          <div class="text-sm space-y-1 text-mpMuted">
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
          <ul class="text-sm text-mpMuted space-y-1">
            ${
              stylistHtml ||
              "<li>No stylists added.</li>"
            }
          </ul>
        </div>

        <form method="POST" action="/onboarding/complete">
          <button style="width:100%;background:#D4897A;color:#fff;font-weight:700;padding:12px;border-radius:999px;border:none;font-size:14px;cursor:pointer;margin-top:24px;">
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

  res.redirect("/manager");
});

export default router;
