// src/routes/vendorAdmin.js
// Internal MostlyPostly admin route for managing vendor campaign content
// and overriding salon plan/status for testing.
// Protected by INTERNAL_SECRET env var — NOT accessible to salon managers.
// Mount at: /internal/vendors
//
// Usage:
//   GET  /internal/vendors?secret=<INTERNAL_SECRET>     — dashboard (salons + campaigns)
//   POST /internal/vendors/set-plan?secret=<...>        — override salon plan
//   POST /internal/vendors/upload?secret=<...>          — upload vendor CSV
//   POST /internal/vendors/delete/:id?secret=<...>      — delete campaign
//   GET  /internal/vendors/template?secret=<...>        — download CSV template

import express from "express";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import db from "../../db.js";
import { UPLOADS_DIR } from "../core/uploadPath.js";

const router = express.Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PROOF_DIR = path.join(UPLOADS_DIR, "vendor-proofs");
fs.mkdirSync(PROOF_DIR, { recursive: true });
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PROOF_DIR),
    filename: (_req, file, cb) => cb(null, `proof-${Date.now()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single("proof_file");

// CSV column spec
const CSV_HEADERS = [
  "vendor_name",
  "campaign_name",
  "product_name",
  "product_description",
  "photo_url",
  "hashtags",
  "tone_direction",
  "cta_instructions",
  "service_pairing_notes",
  "expires_at",
  "frequency_cap",
];

const CSV_EXAMPLE = [
  "Aveda",
  "Spring Color Launch 2026",
  "Aveda Full Spectrum Color",
  "Long-lasting professional color that protects the integrity of every strand.",
  "https://aveda.com/images/full-spectrum.jpg",
  "#AvedaColor,#FullSpectrum,#SalonExclusive",
  "professional and educational",
  "Ask your stylist about our full Aveda color menu.",
  "Pairs beautifully with balayage, highlights, and full color services.",
  "2026-09-30",
  "4",
];

// ── Auth ──────────────────────────────────────────────────────────────────────

// Step 1: secret in URL
function requireSecret(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) return res.status(503).send("INTERNAL_SECRET env var not set.");
  if (req.query.secret !== secret) return res.status(403).send("Forbidden.");
  next();
}

// Step 2: PIN entered via form, stored in session for duration of browser session
function requirePin(req, res, next) {
  const pin = process.env.INTERNAL_PIN;
  // If no PIN configured, skip second factor
  if (!pin) return next();
  if (req.session?.console_authed === true) return next();

  // For POST/non-GET requests, redirect to GET with session-expired message
  // so the user re-authenticates cleanly (avoids PIN wall as a POST response)
  if (req.method !== "GET") {
    return res.redirect(`/internal/vendors${qs(req)}&session_expired=1`);
  }

  // Show PIN entry form
  return res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"/><title>Platform Console — Verify</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:40px 36px;
          max-width:360px;width:100%;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
    .lock{font-size:36px;margin-bottom:16px;}
    h1{font-size:18px;font-weight:800;color:#111827;margin-bottom:6px;}
    p{font-size:13px;color:#6b7280;margin-bottom:24px;line-height:1.5;}
    input{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:12px 16px;
          font-size:20px;letter-spacing:4px;text-align:center;outline:none;margin-bottom:12px;}
    input:focus{border-color:#2B2D35;box-shadow:0 0 0 3px rgba(43,45,53,0.1);}
    button{width:100%;background:#2B2D35;color:#fff;border:none;border-radius:10px;
           padding:12px;font-size:14px;font-weight:700;cursor:pointer;}
    button:hover{background:#1a1c22;}
    .error{font-size:13px;color:#dc2626;margin-bottom:12px;}
  </style>
</head>
<body>
  <div class="card">
    <div class="lock">🔐</div>
    <h1>Platform Console</h1>
    <p>Enter your access PIN to continue.</p>
    ${req.query.invalid ? `<p class="error">Incorrect PIN — try again.</p>` : ""}
    <form method="POST" action="/internal/vendors/verify-pin${qs(req)}">
      <input type="password" name="pin" autofocus autocomplete="off" placeholder="••••••" maxlength="20" />
      <button type="submit">Continue →</button>
    </form>
  </div>
</body></html>`);
}

function qs(req) {
  return `?secret=${encodeURIComponent(req.query.secret || "")}`;
}

// ── POST /verify-pin ───────────────────────────────────────────────────────────
router.post("/verify-pin", requireSecret, (req, res) => {
  const pin = process.env.INTERNAL_PIN;
  if (!pin) return res.redirect(`/internal/vendors${qs(req)}`);

  if (req.body.pin === pin) {
    req.session.console_authed = true;
    req.session.save(() => res.redirect(`/internal/vendors${qs(req)}`));
  } else {
    res.redirect(`/internal/vendors${qs(req)}&invalid=1`);
  }
});

// ── Simple CSV line parser ─────────────────────────────────────────────────────
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

// ── POST /set-plan — Override salon plan for testing ──────────────────────────
router.post("/set-plan", requireSecret, requirePin, (req, res) => {
  const { salon_slug, plan, plan_status } = req.body;
  if (!salon_slug || !plan) return res.redirect(`/internal/vendors${qs(req)}`);

  const validPlans   = ["trial", "starter", "growth", "pro"];
  const validStatus  = ["trialing", "active", "past_due", "canceled"];
  if (!validPlans.includes(plan)) return res.redirect(`/internal/vendors${qs(req)}`);

  // When setting to a paid plan, mark trial_used so no re-trial is offered later
  const effectiveStatus = validStatus.includes(plan_status) ? plan_status : "active";
  const markTrialUsed = plan !== "trial" ? 1 : 0;
  db.prepare(`
    UPDATE salons SET plan = ?, plan_status = ?, trial_used = ?, updated_at = datetime('now') WHERE slug = ?
  `).run(plan, effectiveStatus, markTrialUsed, salon_slug);

  console.log(`[vendorAdmin] Set ${salon_slug} → plan:${plan} status:${plan_status}`);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── GET / — Platform Console ───────────────────────────────────────────────────
router.get("/", requireSecret, requirePin, (req, res) => {
  const campaigns = db.prepare(`
    SELECT * FROM vendor_campaigns ORDER BY vendor_name ASC, campaign_name ASC
  `).all();

  // Salons with their primary manager email
  const salons = db.prepare(`
    SELECT s.slug, s.name, s.plan, s.plan_status, s.created_at,
           s.address, s.city, s.state,
           m.email, m.name AS manager_name
    FROM salons s
    LEFT JOIN managers m ON m.salon_id = s.slug AND m.role = 'owner'
    ORDER BY s.created_at DESC
  `).all();

  // Vendor approval requests
  const approvals = db.prepare(`
    SELECT a.*, s.name AS salon_name
    FROM salon_vendor_approvals a
    JOIN salons s ON s.slug = a.salon_id
    ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
             a.requested_at DESC
  `).all();
  const pendingCount = approvals.filter(a => a.status === "pending").length;

  // Platform issues flagged by stylists
  const issues = db.prepare(`
    SELECT i.*, s.name AS salon_name
    FROM platform_issues i
    LEFT JOIN salons s ON s.slug = i.salon_id
    ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
             i.created_at DESC
    LIMIT 100
  `).all();
  const openIssueCount = issues.filter(i => i.status === 'open').length;

  // Feature requests across all salons
  const featureRequests = (() => {
    try {
      return db.prepare(`
        SELECT fr.*, s.name AS salon_name
        FROM feature_requests fr
        LEFT JOIN salons s ON s.slug = fr.submitted_by
        ORDER BY CASE fr.status WHEN 'submitted' THEN 0 WHEN 'under_review' THEN 1 WHEN 'planned' THEN 2 WHEN 'live' THEN 3 ELSE 4 END,
                 fr.vote_count DESC, fr.created_at DESC
        LIMIT 200
      `).all();
    } catch { return []; }
  })();
  const openRequestCount = featureRequests.filter(r => r.status === 'submitted' || r.status === 'under_review').length;

  // All unique vendor names for the approval assignment dropdown
  const vendorNames = [...new Set(campaigns.map(c => c.vendor_name))].sort();

  // Per-salon approved vendors map
  const allApprovedFeeds = db.prepare(`
    SELECT salon_id, vendor_name FROM salon_vendor_approvals WHERE status = 'approved'
  `).all();
  const approvedBysalon = {};
  for (const row of allApprovedFeeds) {
    if (!approvedBysalon[row.salon_id]) approvedBysalon[row.salon_id] = [];
    approvedBysalon[row.salon_id].push(row.vendor_name);
  }

  // Stats
  const totalSalons   = salons.length;
  const active        = salons.filter(s => s.plan_status === "active").length;
  const trialing      = salons.filter(s => s.plan_status === "trialing").length;
  const canceled      = salons.filter(s => s.plan_status === "canceled").length;
  const totalCampaigns = campaigns.length;

  // Vendor brand config
  const brandConfigs = db.prepare(`SELECT * FROM vendor_brands`).all();
  const brandConfigMap = Object.fromEntries(brandConfigs.map(b => [b.vendor_name, b]));

  // Union of vendor names from campaigns + brand configs
  const allVendorNames = [...new Set([
    ...campaigns.map(c => c.vendor_name),
    ...brandConfigs.map(b => b.vendor_name),
  ])].sort();

  // Group campaigns by vendor
  const vendors = {};
  for (const name of allVendorNames) vendors[name] = [];
  for (const c of campaigns) vendors[c.vendor_name].push(c);

  const safe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const planColor = p => ({ pro: "bg-purple-100 text-purple-700", growth: "bg-blue-100 text-blue-700", starter: "bg-green-100 text-green-700", trial: "bg-gray-100 text-gray-600" }[p] || "bg-gray-100 text-gray-600");
  const statusColor = s => ({ active: "bg-green-100 text-green-700", trialing: "bg-blue-100 text-blue-700", past_due: "bg-yellow-100 text-yellow-700", canceled: "bg-red-100 text-red-600" }[s] || "bg-gray-100 text-gray-600");

  const flashBanner = req.query.saved
    ? `<div class="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 font-medium mb-6">Brand config saved.</div>`
    : req.query.added
    ? `<div class="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 font-medium mb-6">Campaign added.</div>`
    : req.query.renewed
    ? `<div class="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 font-medium mb-6">Campaign renewed +30 days.</div>`
    : req.query.error === "missing_fields"
    ? `<div class="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium mb-6">Vendor name, campaign name, category, and product name are required.</div>`
    : req.query.error === "promotion_needs_expiry"
    ? `<div class="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium mb-6">Promotion campaigns require an expiration date.</div>`
    : req.query.session_expired
    ? `<div class="rounded-xl bg-yellow-50 border border-yellow-200 px-4 py-3 text-sm text-yellow-800 font-medium mb-6">Your session expired (server restarted). Please re-enter your PIN above to continue.</div>`
    : "";

  const today = new Date().toISOString().slice(0, 10);

  const vendorBlocks = Object.entries(vendors).map(([vendor, items]) => {
    const cfg = brandConfigMap[vendor] || {};
    const brandHashtags = (() => { try { return JSON.parse(cfg.brand_hashtags || "[]"); } catch { return []; } })();
    const categories = (() => { try { return JSON.parse(cfg.categories || "[]"); } catch { return []; } })();
    const allowRenewal = cfg.allow_client_renewal !== 0;
    const vendorKey = safe(vendor.replace(/\s+/g, "_"));

    const catOptions = categories.length
      ? categories.map(cat => `<option value="${safe(cat)}">${safe(cat)}</option>`).join("")
      : `<option value="Standard">Standard</option><option value="Promotion">Promotion</option>`;

    const campaignRows = items.map(c => {
      const isExpired = c.expires_at && c.expires_at < today;
      const statusBadge = isExpired
        ? `<span class="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-600">Expired</span>`
        : `<span class="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">Active</span>`;
      const renewBtn = isExpired ? `
      <form method="POST" action="/internal/vendors/campaign/renew${qs(req)}" class="inline">
        <input type="hidden" name="campaign_id" value="${safe(c.id)}" />
        <button type="submit" class="text-xs text-blue-500 hover:text-blue-700 font-medium">Renew +30d</button>
      </form>` : "";
      return `
      <div class="border rounded-xl p-4 bg-white flex gap-4 items-start">
        ${c.photo_url
          ? `<img src="${safe(c.photo_url)}" class="w-14 h-14 object-cover rounded-lg border flex-shrink-0" onerror="this.style.display='none'" />`
          : `<div class="w-14 h-14 rounded-lg border bg-gray-50 flex-shrink-0 flex items-center justify-center text-xl">&#127991;</div>`}
        <div class="flex-1 min-w-0">
          <div class="flex items-start justify-between gap-2">
            <div>
              <p class="font-semibold text-sm">${safe(c.campaign_name)}</p>
              <p class="text-xs text-gray-500">${safe(c.product_name || "")}${c.category ? ` &middot; ${safe(c.category)}` : ""}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${statusBadge}
              ${renewBtn}
              <form method="POST" action="/internal/vendors/delete/${safe(c.id)}${qs(req)}"
                    onsubmit="return confirm('Delete campaign: ${safe(c.campaign_name)}?')" class="inline">
                <button type="submit" class="text-xs text-red-400 hover:text-red-600">Delete</button>
              </form>
            </div>
          </div>
          <p class="text-xs text-gray-500 mt-1 line-clamp-2">${safe(c.product_description || "")}</p>
          <div class="mt-1.5 flex flex-wrap gap-3 text-xs text-gray-400">
            <span>Expires: <strong class="text-gray-600">${safe(c.expires_at || "&#8212;")}</strong></span>
            <span>Cap: <strong class="text-gray-600">${safe(c.frequency_cap || 4)}/mo</strong></span>
            ${c.category ? `<span>Category: <strong class="text-gray-600">${safe(c.category)}</strong></span>` : ""}
            ${c.product_hashtag ? `<span>Tag: <strong class="text-gray-600">${safe(c.product_hashtag)}</strong></span>` : ""}
          </div>
          ${c.cta_instructions ? `<p class="text-xs text-blue-500 mt-1">CTA: ${safe(c.cta_instructions)}</p>` : ""}
        </div>
      </div>`;
    }).join("");

    return `
  <div class="mb-8">
    <div class="flex items-center justify-between mb-3">
      <h3 class="font-bold text-gray-900">${safe(vendor)}
        <span class="ml-2 text-xs font-normal text-gray-400">${items.length} campaign${items.length !== 1 ? "s" : ""}</span>
      </h3>
    </div>

    <!-- Brand Config Card -->
    <div class="border rounded-xl bg-white p-4 mb-4">
      <p class="text-xs font-bold text-gray-700 uppercase tracking-wide mb-3">Brand Config</p>
      <form method="POST" action="/internal/vendors/brand-config${qs(req)}" class="space-y-3">
        <input type="hidden" name="vendor_name" value="${safe(vendor)}" />
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-xs text-gray-500 block mb-1">Brand Hashtag 1</label>
            <input type="text" name="brand_hashtags[]" value="${safe(brandHashtags[0] || "")}"
                   placeholder="#BrandTag" maxlength="60"
                   class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm" />
          </div>
          <div>
            <label class="text-xs text-gray-500 block mb-1">Brand Hashtag 2</label>
            <input type="text" name="brand_hashtags[]" value="${safe(brandHashtags[1] || "")}"
                   placeholder="#BrandTag" maxlength="60"
                   class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm" />
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-500 block mb-1">Campaign Categories (comma-separated)</label>
          <input type="text" name="categories" value="${safe(categories.join(", "))}"
                 placeholder="Color, Standard, Promotion"
                 class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm" />
          ${categories.length
            ? `<div class="mt-1.5 flex flex-wrap gap-1">${categories.map(c => `<span class="text-[11px] bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">${safe(c)}</span>`).join("")}</div>`
            : ""}
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-gray-600 font-medium">Allow client-side renewal</span>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" name="allow_client_renewal" value="1" ${allowRenewal ? "checked" : ""}
                   class="sr-only peer" />
            <div class="w-9 h-5 bg-gray-200 peer-checked:bg-blue-600 rounded-full transition-colors"></div>
            <div class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-4"></div>
          </label>
        </div>
        <div class="flex justify-end">
          <button type="submit"
                  class="text-xs bg-gray-900 text-white rounded-lg px-4 py-1.5 font-semibold hover:bg-gray-700">
            Save Brand Config
          </button>
        </div>
      </form>
    </div>

    <!-- Campaign Rows -->
    <div class="space-y-2">
      ${campaignRows || `<p class="text-xs text-gray-400 py-2">No campaigns yet.</p>`}

      <!-- Add Campaign Toggle + Inline Form -->
      <button type="button"
              onclick="var f=document.getElementById('add-form-${vendorKey}'); f.style.display=f.style.display==='none'?'block':'none';"
              class="mt-2 text-xs border border-dashed border-gray-300 rounded-xl px-4 py-2.5 text-gray-500 hover:border-gray-500 hover:text-gray-700 w-full text-center">
        + Add Campaign
      </button>
      <div id="add-form-${vendorKey}" style="display:none;" class="mt-3 border rounded-xl bg-gray-50 p-4">
        <p class="text-xs font-bold text-gray-700 mb-3">New Campaign &mdash; ${safe(vendor)}</p>
        <form method="POST" action="/internal/vendors/campaign/add${qs(req)}" class="space-y-3">
          <input type="hidden" name="vendor_name" value="${safe(vendor)}" />
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Campaign Name *</label>
              <input type="text" name="campaign_name" required placeholder="Spring Color 2026"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Category *</label>
              <select name="category" required class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white">
                <option value="">-- Select --</option>
                ${catOptions}
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Product Name *</label>
              <input type="text" name="product_name" required placeholder="Full Spectrum Color"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Product Hashtag (max 1)</label>
              <input type="text" name="product_hashtag" placeholder="#FullSpectrum" maxlength="60"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div class="col-span-2">
              <label class="text-xs text-gray-500 block mb-1">Product Description</label>
              <textarea name="product_description" rows="2" placeholder="1-2 sentence description"
                        class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white"></textarea>
            </div>
            <div class="col-span-2">
              <label class="text-xs text-gray-500 block mb-1">Photo URL</label>
              <input type="text" name="photo_url" placeholder="https://..."
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Tone Direction</label>
              <input type="text" name="tone_direction" placeholder="professional and educational"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">CTA Instructions</label>
              <input type="text" name="cta_instructions" placeholder="Ask about our color menu"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Service Pairing Notes</label>
              <input type="text" name="service_pairing_notes" placeholder="Pairs with balayage"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Expires At (required for Promotion)</label>
              <input type="date" name="expires_at"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Frequency Cap (posts/month)</label>
              <input type="number" name="frequency_cap" value="4" min="1" max="30"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button"
                    onclick="document.getElementById('add-form-${vendorKey}').style.display='none';"
                    class="text-xs text-gray-500 px-3 py-1.5">Cancel</button>
            <button type="submit"
                    class="text-xs bg-gray-900 text-white rounded-lg px-4 py-1.5 font-semibold">
              Add Campaign
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8" /><title>Platform Console — MostlyPostly</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .stat-card { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px 20px; }
    .stat-val  { font-size:28px; font-weight:800; color:#111827; line-height:1; }
    .stat-lbl  { font-size:12px; color:#6b7280; margin-top:4px; }
  </style>
  <script>
    function toggleTopAddForm() {
      var f = document.getElementById('top-add-campaign-form');
      f.style.display = f.style.display === 'none' ? 'block' : 'none';
    }
    function hideTopAddForm() {
      document.getElementById('top-add-campaign-form').style.display = 'none';
    }
  </script>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">

  <!-- Header -->
  <div class="border-b bg-white px-8 py-4 flex items-center justify-between">
    <div>
      <h1 class="text-lg font-bold text-gray-900">MostlyPostly Platform Console</h1>
      <p class="text-xs text-gray-400 mt-0.5">Internal operations — not accessible to salon managers</p>
    </div>
    <a href="/internal/vendors/template${qs(req)}"
       class="text-xs border rounded-lg px-3 py-1.5 hover:bg-gray-50 text-gray-600">
      Download CSV Template
    </a>
  </div>

  <div class="max-w-5xl mx-auto px-8 py-8 space-y-8">

    ${flashBanner}

    <!-- Stats -->
    <div class="grid grid-cols-2 sm:grid-cols-6 gap-3">
      <div class="stat-card"><div class="stat-val">${totalSalons}</div><div class="stat-lbl">Total Accounts</div></div>
      <div class="stat-card"><div class="stat-val text-green-600">${active}</div><div class="stat-lbl">Active</div></div>
      <div class="stat-card"><div class="stat-val text-blue-600">${trialing}</div><div class="stat-lbl">Trialing</div></div>
      <div class="stat-card"><div class="stat-val text-red-500">${canceled}</div><div class="stat-lbl">Canceled</div></div>
      <div class="stat-card"><div class="stat-val text-purple-600">${totalCampaigns}</div><div class="stat-lbl">Vendor Campaigns</div></div>
      <div class="stat-card"><div class="stat-val ${pendingCount > 0 ? "text-yellow-500" : "text-gray-400"}">${pendingCount}</div><div class="stat-lbl">Pending Approvals</div></div>
      <div class="stat-card"><div class="stat-val ${openIssueCount > 0 ? "text-red-500" : "text-gray-400"}">${openIssueCount}</div><div class="stat-lbl">Open Issues</div></div>
      <div class="stat-card"><div class="stat-val ${openRequestCount > 0 ? "text-indigo-600" : "text-gray-400"}">${openRequestCount}</div><div class="stat-lbl">Feature Requests</div></div>
    </div>

    <!-- Platform Issues -->
    <div class="border rounded-2xl bg-white overflow-hidden">
      <div class="px-6 py-4 border-b">
        <h2 class="font-bold">Stylist Issues
          ${openIssueCount > 0 ? `<span class="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">${openIssueCount} open</span>` : ""}
        </h2>
        <p class="text-xs text-gray-500 mt-0.5">Flagged by stylists via SMS (e.g. "WRONG" reply to no-availability). Investigate and inform the salon manager.</p>
      </div>
      ${issues.length === 0 ? `<div class="px-6 py-8 text-center text-sm text-gray-400">No issues reported</div>` : `
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
          <tr>
            <th class="px-6 py-2 text-left">Salon</th>
            <th class="px-6 py-2 text-left">Stylist</th>
            <th class="px-6 py-2 text-left">Type</th>
            <th class="px-6 py-2 text-left">Description</th>
            <th class="px-6 py-2 text-left">Reported</th>
            <th class="px-6 py-2 text-left">Status</th>
            <th class="px-6 py-2 text-left">Action</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          ${issues.map(issue => `
            <tr class="hover:bg-gray-50">
              <td class="px-6 py-3 font-medium">${safe(issue.salon_name || issue.salon_id)}</td>
              <td class="px-6 py-3">${safe(issue.stylist_name || "—")}<br><span class="text-xs text-gray-400">${safe(issue.stylist_phone || "")}</span></td>
              <td class="px-6 py-3"><span class="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">${safe(issue.issue_type.replace(/_/g, " "))}</span></td>
              <td class="px-6 py-3 text-gray-600 max-w-xs text-xs">${safe(issue.description || "—")}</td>
              <td class="px-6 py-3 text-xs text-gray-400">${new Date(issue.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
              <td class="px-6 py-3">
                <span class="text-xs px-2 py-0.5 rounded-full ${issue.status === "open" ? "bg-red-100 text-red-700" : issue.status === "acknowledged" ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"}">${safe(issue.status)}</span>
              </td>
              <td class="px-6 py-3">
                <div class="flex gap-2">
                  ${issue.status === "open" ? `<form method="POST" action="/internal/vendors/issues/${safe(issue.id)}/acknowledge${qs(req)}"><button class="text-xs text-blue-500 hover:text-blue-700">Acknowledge</button></form>` : ""}
                  ${issue.status !== "resolved" ? `<form method="POST" action="/internal/vendors/issues/${safe(issue.id)}/resolve${qs(req)}"><button class="text-xs text-green-500 hover:text-green-700">Resolve</button></form>` : ""}
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>`}
    </div>

    <!-- Feature Requests -->
    <div class="border rounded-2xl bg-white overflow-hidden">
      <div class="px-6 py-4 border-b flex items-center justify-between">
        <div>
          <h2 class="font-bold">Feature Requests
            ${openRequestCount > 0 ? `<span class="ml-2 inline-flex items-center rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">${openRequestCount} needs review</span>` : ""}
          </h2>
          <p class="text-xs text-gray-500 mt-0.5">Ideas submitted by salons. Change status to move them through the pipeline. Set to Planned or Live + toggle Public to appear on the roadmap.</p>
        </div>
      </div>
      ${featureRequests.length === 0 ? `<div class="px-6 py-8 text-center text-sm text-gray-400">No feature requests yet</div>` : `
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
          <tr>
            <th class="px-4 py-2 text-left">Idea</th>
            <th class="px-4 py-2 text-left">From</th>
            <th class="px-4 py-2 text-center">Votes</th>
            <th class="px-4 py-2 text-left">Status</th>
            <th class="px-4 py-2 text-left">Public</th>
            <th class="px-4 py-2 text-left">Action</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          ${featureRequests.map(r => `
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-3 max-w-xs">
                <p class="font-medium text-gray-800 text-sm">${safe(r.title)}</p>
                ${r.description ? `<p class="text-xs text-gray-400 mt-0.5">${safe(r.description).slice(0, 100)}${r.description.length > 100 ? '…' : ''}</p>` : ''}
              </td>
              <td class="px-4 py-3 text-xs text-gray-500">${safe(r.salon_name || r.submitted_by)}</td>
              <td class="px-4 py-3 text-center font-bold text-gray-700">${r.vote_count}</td>
              <td class="px-4 py-3">
                <form method="POST" action="/internal/vendors/feature-requests/${safe(r.id)}/status${qs(req)}" class="flex gap-1 items-center">
                  <select name="status" onchange="this.form.submit()" class="text-xs border rounded px-1.5 py-1 bg-white">
                    ${['submitted','under_review','planned','live','declined'].map(s => `<option value="${s}" ${r.status === s ? 'selected' : ''}>${s.replace('_',' ')}</option>`).join('')}
                  </select>
                </form>
              </td>
              <td class="px-4 py-3">
                <form method="POST" action="/internal/vendors/feature-requests/${safe(r.id)}/toggle-public${qs(req)}">
                  <button type="submit" class="text-xs px-2 py-0.5 rounded-full ${r.public ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}">${r.public ? '✓ Public' : 'Private'}</button>
                </form>
              </td>
              <td class="px-4 py-3">
                <form method="POST" action="/internal/vendors/feature-requests/${safe(r.id)}/delete${qs(req)}" onsubmit="return confirm('Delete this feature request?')">
                  <button type="submit" class="text-xs text-red-400 hover:text-red-600">Delete</button>
                </form>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>`}
    </div>

    <!-- Vendor Approvals -->
    <div class="border rounded-2xl bg-white overflow-hidden">
      <div class="px-6 py-4 border-b flex items-center justify-between">
        <div>
          <h2 class="font-bold">Vendor Partner Approvals
            ${pendingCount > 0 ? `<span class="ml-2 inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-700">${pendingCount} pending</span>` : ""}
          </h2>
          <p class="text-xs text-gray-500 mt-0.5">Review salon requests and manually assign vendor access. Approved vendors unlock the toggle in the salon's Vendor Brands page.</p>
        </div>
      </div>

      <!-- Manual assignment: add vendor to any salon -->
      <div class="px-6 py-4 border-b bg-gray-50">
        <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Manually Assign Vendor Access</p>
        <form method="POST" action="/internal/vendors/approve-vendor${qs(req)}" class="flex flex-wrap gap-2 items-end">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Salon</label>
            <select name="salon_slug" class="text-xs border rounded-lg px-2 py-1.5 min-w-[160px]">
              ${salons.map(s => `<option value="${safe(s.slug)}">${safe(s.name)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Vendor</label>
            <select name="vendor_name" class="text-xs border rounded-lg px-2 py-1.5 min-w-[140px]">
              ${vendorNames.map(v => `<option value="${safe(v)}">${safe(v)}</option>`).join("")}
            </select>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Status</label>
            <select name="status" class="text-xs border rounded-lg px-2 py-1.5">
              <option value="approved">Approved</option>
              <option value="pending">Pending</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <button type="submit" class="text-xs bg-gray-900 text-white rounded-lg px-3 py-1.5 hover:bg-gray-700">Save</button>
        </form>
      </div>

      <!-- Approval requests list -->
      ${approvals.length === 0
        ? `<div class="px-6 py-10 text-center text-sm text-gray-400">No approval requests yet.</div>`
        : `<div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
                  <th class="px-4 py-3">Salon</th>
                  <th class="px-4 py-3">Vendor</th>
                  <th class="px-4 py-3">Status</th>
                  <th class="px-4 py-3">Requested</th>
                  <th class="px-4 py-3">Proof / Notes</th>
                  <th class="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${approvals.map(a => {
                  const statusBadge = { approved: "bg-green-100 text-green-700", pending: "bg-yellow-100 text-yellow-700", denied: "bg-red-100 text-red-600" }[a.status] || "bg-gray-100 text-gray-600";
                  return `
                  <tr class="border-b last:border-0 hover:bg-gray-50/50">
                    <td class="px-4 py-3">
                      <div class="font-medium text-gray-900">${safe(a.salon_name)}</div>
                      <div class="text-xs font-mono text-gray-400">${safe(a.salon_id)}</div>
                    </td>
                    <td class="px-4 py-3 font-medium">${safe(a.vendor_name)}</td>
                    <td class="px-4 py-3">
                      <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${statusBadge}">${safe(a.status)}</span>
                    </td>
                    <td class="px-4 py-3 text-xs text-gray-400">${safe((a.requested_at || "").slice(0, 10))}</td>
                    <td class="px-4 py-3">
                      ${a.proof_file
                        ? `<a href="/uploads/vendor-proofs/${safe(a.proof_file)}" target="_blank" class="text-xs text-blue-500 hover:underline">View file</a>`
                        : `<form method="POST" action="/internal/vendors/upload-proof${qs(req)}" enctype="multipart/form-data" class="flex gap-1 items-center">
                             <input type="hidden" name="approval_id" value="${safe(a.id)}" />
                             <input type="file" name="proof_file" accept=".pdf,.jpg,.jpeg,.png" class="text-xs w-32" />
                             <button type="submit" class="text-xs text-gray-600 border rounded px-2 py-0.5 hover:bg-gray-50">Upload</button>
                           </form>`}
                      ${a.notes ? `<div class="text-xs text-gray-400 mt-1">${safe(a.notes)}</div>` : ""}
                    </td>
                    <td class="px-4 py-3">
                      <div class="flex gap-2 flex-wrap">
                        ${a.status !== "approved" ? `
                        <form method="POST" action="/internal/vendors/approve-vendor${qs(req)}">
                          <input type="hidden" name="approval_id" value="${safe(a.id)}" />
                          <input type="hidden" name="status" value="approved" />
                          <button type="submit" class="text-xs bg-green-600 text-white rounded px-2.5 py-1 hover:bg-green-700">Approve</button>
                        </form>` : ""}
                        ${a.status !== "denied" ? `
                        <form method="POST" action="/internal/vendors/approve-vendor${qs(req)}">
                          <input type="hidden" name="approval_id" value="${safe(a.id)}" />
                          <input type="hidden" name="status" value="denied" />
                          <button type="submit" class="text-xs bg-red-500 text-white rounded px-2.5 py-1 hover:bg-red-600">Deny</button>
                        </form>` : ""}
                      </div>
                    </td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
           </div>`}
    </div>

    <!-- Account Management -->
    <div class="border rounded-2xl bg-white overflow-hidden">
      <div class="px-6 py-4 border-b flex items-center justify-between">
        <div>
          <h2 class="font-bold">Account Management</h2>
          <p class="text-xs text-gray-500 mt-0.5">Override plan/status and delete accounts. Changes take effect immediately.</p>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wide">
              <th class="px-4 py-3">Salon</th>
              <th class="px-4 py-3">Manager</th>
              <th class="px-4 py-3">Plan</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Created</th>
              <th class="px-4 py-3">Override</th>
              <th class="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            ${salons.map(s => `
            <tr class="border-b last:border-0 hover:bg-gray-50/50">
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">${safe(s.name)}</div>
                <div class="text-xs text-gray-400 font-mono">${safe(s.slug)}</div>
                ${s.city ? `<div class="text-xs text-gray-400">${safe(s.city)}${s.state ? ", " + safe(s.state) : ""}</div>` : ""}
              </td>
              <td class="px-4 py-3">
                <div class="text-xs text-gray-700">${safe(s.manager_name || "—")}</div>
                ${s.email ? `<div class="text-xs text-gray-400">${safe(s.email)}</div>` : ""}
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${planColor(s.plan)}">${safe(s.plan || "trial")}</span>
              </td>
              <td class="px-4 py-3">
                <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${statusColor(s.plan_status)}">${safe(s.plan_status || "trialing")}</span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-400">${safe((s.created_at || "").slice(0, 10))}</td>
              <td class="px-4 py-3">
                <form method="POST" action="/internal/vendors/set-plan${qs(req)}" class="flex items-center gap-1.5">
                  <input type="hidden" name="salon_slug" value="${safe(s.slug)}" />
                  <select name="plan" class="text-xs border rounded px-1.5 py-1">
                    ${["trial","starter","growth","pro"].map(p => `<option value="${p}" ${s.plan === p ? "selected" : ""}>${p}</option>`).join("")}
                  </select>
                  <select name="plan_status" class="text-xs border rounded px-1.5 py-1">
                    ${["trialing","active","past_due","canceled"].map(st => `<option value="${st}" ${s.plan_status === st ? "selected" : ""}>${st}</option>`).join("")}
                  </select>
                  <button type="submit" class="text-xs bg-gray-900 text-white rounded px-2.5 py-1 hover:bg-gray-700">Set</button>
                </form>
              </td>
              <td class="px-4 py-3">
                <form method="POST" action="/internal/vendors/delete-salon${qs(req)}"
                      onsubmit="return confirm('Permanently delete ${safe(s.name)} and all associated data? This cannot be undone.')">
                  <input type="hidden" name="salon_slug" value="${safe(s.slug)}" />
                  <button type="submit" class="text-xs text-red-400 hover:text-red-600">Delete</button>
                </form>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Vendor CSV Upload -->
    <div class="border rounded-2xl bg-white p-6">
      <h2 class="font-bold mb-1">Upload Vendor CSV</h2>
      <p class="text-sm text-gray-500 mb-4">New campaigns are added. Existing campaigns (matched by vendor_name + campaign_name) are skipped to avoid duplicates.</p>
      <form method="POST" action="/internal/vendors/upload${qs(req)}" enctype="multipart/form-data" class="flex gap-3 items-end">
        <div>
          <label class="block text-xs font-semibold text-gray-500 mb-1">CSV File</label>
          <input type="file" name="csv" accept=".csv" required
                 class="text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold" />
        </div>
        <button type="submit" class="rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white hover:bg-gray-700">Upload</button>
      </form>
    </div>

    <!-- Vendor Campaigns -->
    <div class="border rounded-2xl bg-white p-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="font-bold">Vendor Campaigns
          <span class="ml-2 text-sm font-normal text-gray-400">${totalCampaigns} total</span>
        </h2>
        <button type="button"
                onclick="toggleTopAddForm()"
                class="text-xs bg-gray-900 text-white rounded-lg px-4 py-2 font-semibold hover:bg-gray-700">
          + Add Campaign
        </button>
      </div>

      <!-- Top-level Add Campaign form (always visible, works without existing vendors) -->
      <div id="top-add-campaign-form" style="display:none;" class="mb-6 border rounded-xl bg-gray-50 p-4">
        <p class="text-xs font-bold text-gray-700 mb-3">New Campaign</p>
        <form method="POST" action="/internal/vendors/campaign/add${qs(req)}" class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-500 block mb-1">Brand / Vendor Name *</label>
              <input type="text" name="vendor_name" required placeholder="Aveda"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
              <p class="text-[11px] text-gray-400 mt-0.5">Creates the brand automatically if it doesn't exist yet.</p>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Campaign Name *</label>
              <input type="text" name="campaign_name" required placeholder="Spring Color 2026"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Category *</label>
              <select name="category" required class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white">
                <option value="">-- Select --</option>
                <option value="Standard">Standard</option>
                <option value="Promotion">Promotion</option>
                <option value="Color">Color</option>
                <option value="Treatment">Treatment</option>
                <option value="Styling">Styling</option>
                <option value="Care">Care</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Product Name *</label>
              <input type="text" name="product_name" required placeholder="Full Spectrum Color"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Product Hashtag (max 1)</label>
              <input type="text" name="product_hashtag" placeholder="#FullSpectrum" maxlength="60"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Expires At (required for Promotion)</label>
              <input type="date" name="expires_at"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div class="col-span-2">
              <label class="text-xs text-gray-500 block mb-1">Product Description</label>
              <textarea name="product_description" rows="2" placeholder="1-2 sentence description"
                        class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white"></textarea>
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Photo URL</label>
              <input type="text" name="photo_url" placeholder="https://..."
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Tone Direction</label>
              <input type="text" name="tone_direction" placeholder="professional and educational"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">CTA Instructions</label>
              <input type="text" name="cta_instructions" placeholder="Ask about our color menu"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Service Pairing Notes</label>
              <input type="text" name="service_pairing_notes" placeholder="Pairs with balayage"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
            <div>
              <label class="text-xs text-gray-500 block mb-1">Frequency Cap (posts/month)</label>
              <input type="number" name="frequency_cap" value="4" min="1" max="30"
                     class="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white" />
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button"
                    onclick="hideTopAddForm()"
                    class="text-xs text-gray-500 px-3 py-1.5">Cancel</button>
            <button type="submit"
                    class="text-xs bg-gray-900 text-white rounded-lg px-4 py-1.5 font-semibold hover:bg-gray-700">
              Add Campaign
            </button>
          </div>
        </form>
      </div>

      ${campaigns.length === 0
        ? `<div class="text-center py-8 text-gray-400 text-sm">No campaigns yet. Use the button above or upload a CSV.</div>`
        : vendorBlocks}
    </div>

  </div>
</body></html>`;

  res.send(html);
});

// ── POST /feature-requests/:id/status — Change request status ─────────────────
router.post("/feature-requests/:id/status", requireSecret, requirePin, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['submitted', 'under_review', 'planned', 'live', 'declined'];
  if (!validStatuses.includes(status)) return res.redirect(`/internal/vendors${qs(req)}`);
  db.prepare(`UPDATE feature_requests SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /feature-requests/:id/toggle-public — Toggle public roadmap visibility ─
router.post("/feature-requests/:id/toggle-public", requireSecret, requirePin, (req, res) => {
  const row = db.prepare(`SELECT public FROM feature_requests WHERE id = ?`).get(req.params.id);
  if (row) {
    db.prepare(`UPDATE feature_requests SET public = ?, updated_at = ? WHERE id = ?`)
      .run(row.public ? 0 : 1, new Date().toISOString(), req.params.id);
  }
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /feature-requests/:id/delete — Delete a feature request ──────────────
router.post("/feature-requests/:id/delete", requireSecret, requirePin, (req, res) => {
  db.prepare(`DELETE FROM feature_request_votes WHERE feature_request_id = ?`).run(req.params.id);
  db.prepare(`DELETE FROM feature_requests WHERE id = ?`).run(req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /issues/:id/acknowledge — Mark issue as acknowledged ─────────────────
router.post("/issues/:id/acknowledge", requireSecret, requirePin, (req, res) => {
  db.prepare(`UPDATE platform_issues SET status = 'acknowledged' WHERE id = ?`).run(req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /issues/:id/resolve — Mark issue as resolved ─────────────────────────
router.post("/issues/:id/resolve", requireSecret, requirePin, (req, res) => {
  db.prepare(`UPDATE platform_issues SET status = 'resolved', resolved_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /delete-salon ─────────────────────────────────────────────────────────
router.post("/delete-salon", requireSecret, requirePin, (req, res) => {
  const { salon_slug } = req.body;
  if (!salon_slug) return res.redirect(`/internal/vendors${qs(req)}`);

  // Grab group_id before we delete the salon row
  const salonRow = db.prepare("SELECT group_id FROM salons WHERE slug = ?").get(salon_slug);

  // Delete in dependency order
  db.prepare("DELETE FROM stylist_portal_tokens WHERE post_id IN (SELECT id FROM posts WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM post_insights WHERE post_id IN (SELECT id FROM posts WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM posts WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM stylists WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM manager_mfa WHERE manager_id IN (SELECT id FROM managers WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM manager_tokens WHERE manager_id IN (SELECT id FROM managers WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM password_reset_tokens WHERE manager_id IN (SELECT id FROM managers WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM security_events WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM managers WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salon_integrations WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM gamification_settings WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM platform_issues WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salon_vendor_feeds WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salon_vendor_approvals WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM stock_photos WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salons WHERE slug = ?").run(salon_slug);

  // Delete the salon_group if this was the only location in the group
  if (salonRow?.group_id) {
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM salons WHERE group_id = ?").get(salonRow.group_id);
    if (!remaining || remaining.n === 0) {
      db.prepare("DELETE FROM salon_groups WHERE id = ?").run(salonRow.group_id);
    }
  }

  console.log(`[platformConsole] Deleted salon: ${salon_slug}`);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /approve-vendor — Approve/deny/manually assign vendor to salon ────────
router.post("/approve-vendor", requireSecret, requirePin, (req, res) => {
  const { approval_id, salon_slug, vendor_name, status } = req.body;
  const validStatuses = ["approved", "pending", "denied"];
  if (!validStatuses.includes(status)) return res.redirect(`/internal/vendors${qs(req)}`);

  if (approval_id) {
    // Update existing approval record
    db.prepare(`
      UPDATE salon_vendor_approvals
      SET status = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(status, approval_id);
  } else if (salon_slug && vendor_name) {
    // Manual assignment — upsert
    db.prepare(`
      INSERT INTO salon_vendor_approvals (id, salon_id, vendor_name, status, requested_at, reviewed_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(salon_id, vendor_name) DO UPDATE SET status = excluded.status, reviewed_at = excluded.reviewed_at
    `).run(crypto.randomUUID(), salon_slug, vendor_name, status);
  }

  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /upload-proof — Upload partnership proof file ─────────────────────────
router.post("/upload-proof", requireSecret, requirePin, proofUpload, (req, res) => {
  const { approval_id } = req.body;
  if (!approval_id || !req.file) return res.redirect(`/internal/vendors${qs(req)}`);

  db.prepare("UPDATE salon_vendor_approvals SET proof_file = ? WHERE id = ?")
    .run(req.file.filename, approval_id);

  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── GET /template — CSV download ──────────────────────────────────────────────
router.get("/template", requireSecret, requirePin, (_req, res) => {
  const lines = [
    CSV_HEADERS.join(","),
    CSV_EXAMPLE.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"vendor-campaigns-template.csv\"");
  res.send(lines.join("\n"));
});

// ── POST /upload — CSV import ─────────────────────────────────────────────────
router.post("/upload", requireSecret, requirePin, csvUpload.single("csv"), (req, res) => {
  if (!req.file) return res.redirect(`/internal/vendors${qs(req)}`);

  const text  = req.file.buffer.toString("utf8");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return res.redirect(`/internal/vendors${qs(req)}`);

  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const getCol = (row, key) => {
    const idx = header.indexOf(key);
    return idx >= 0 ? (row[idx] || "").trim() : "";
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO vendor_campaigns
      (id, vendor_name, campaign_name, product_name, product_description,
       photo_url, hashtags, tone_direction, cta_instructions,
       service_pairing_notes, expires_at, frequency_cap, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
  `);

  let imported = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVLine(lines[i]);
    if (row.length < 2) continue;

    const vendor   = getCol(row, "vendor_name");
    const campaign = getCol(row, "campaign_name");
    if (!vendor || !campaign) continue;

    // Normalize hashtags to JSON array
    const rawTags = getCol(row, "hashtags");
    const hashtags = rawTags
      ? JSON.stringify(rawTags.split(",").map(t => t.trim().startsWith("#") ? t.trim() : `#${t.trim()}`).filter(Boolean))
      : null;

    const freqCap = parseInt(getCol(row, "frequency_cap"), 10);

    try {
      insert.run(
        crypto.randomUUID(),
        vendor,
        campaign,
        getCol(row, "product_name") || null,
        getCol(row, "product_description") || null,
        getCol(row, "photo_url") || null,
        hashtags,
        getCol(row, "tone_direction") || null,
        getCol(row, "cta_instructions") || null,
        getCol(row, "service_pairing_notes") || null,
        getCol(row, "expires_at") || null,
        isNaN(freqCap) ? 4 : freqCap,
      );
      imported++;
    } catch (err) {
      console.warn("[vendorAdmin] CSV row skip:", err.message);
    }
  }

  console.log(`[vendorAdmin] Imported ${imported} campaigns`);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /delete/:id ──────────────────────────────────────────────────────────
router.post("/delete/:id", requireSecret, requirePin, (req, res) => {
  db.prepare("DELETE FROM vendor_campaigns WHERE id = ?").run(req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

// ── POST /brand-config — Upsert vendor brand config ───────────────────────────
router.post("/brand-config", requireSecret, requirePin, (req, res) => {
  const { vendor_name, categories } = req.body;
  if (!vendor_name) return res.redirect(`/internal/vendors${qs(req)}`);

  const rawTags = Array.isArray(req.body["brand_hashtags[]"])
    ? req.body["brand_hashtags[]"]
    : [req.body["brand_hashtags[]"] || ""];
  const brandHashtags = rawTags
    .map(t => (t || "").trim())
    .filter(Boolean)
    .map(t => t.startsWith("#") ? t : `#${t}`)
    .slice(0, 2);

  const cats = (categories || "").split(",").map(c => c.trim()).filter(Boolean);
  const dedupedCats = [...new Set(cats)];
  const allowRenewal = req.body.allow_client_renewal === "1" ? 1 : 0;

  db.prepare(`
    INSERT INTO vendor_brands (vendor_name, brand_hashtags, categories, allow_client_renewal)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(vendor_name) DO UPDATE SET
      brand_hashtags       = excluded.brand_hashtags,
      categories           = excluded.categories,
      allow_client_renewal = excluded.allow_client_renewal
  `).run(vendor_name, JSON.stringify(brandHashtags), JSON.stringify(dedupedCats), allowRenewal);

  res.redirect(`/internal/vendors${qs(req)}&saved=1`);
});

// ── POST /campaign/add — Manually add a campaign ─────────────────────────────
router.post("/campaign/add", requireSecret, requirePin, (req, res) => {
  const {
    vendor_name, campaign_name, category, product_name,
    product_description, photo_url, tone_direction,
    cta_instructions, service_pairing_notes, expires_at,
  } = req.body;
  const frequency_cap = parseInt(req.body.frequency_cap, 10) || 4;

  if (!vendor_name || !campaign_name || !category || !product_name) {
    return res.redirect(`/internal/vendors${qs(req)}&error=missing_fields`);
  }
  if (category === "Promotion" && !expires_at) {
    return res.redirect(`/internal/vendors${qs(req)}&error=promotion_needs_expiry`);
  }

  const rawTag = (req.body.product_hashtag || "").trim();
  const product_hashtag = rawTag ? (rawTag.startsWith("#") ? rawTag : `#${rawTag}`) : null;

  db.prepare(`INSERT OR IGNORE INTO vendor_brands (vendor_name) VALUES (?)`).run(vendor_name);

  db.prepare(`
    INSERT INTO vendor_campaigns
      (id, vendor_name, campaign_name, category, product_name, product_description,
       photo_url, product_hashtag, tone_direction, cta_instructions,
       service_pairing_notes, expires_at, frequency_cap, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `).run(
    crypto.randomUUID(), vendor_name, campaign_name, category, product_name,
    product_description || null, photo_url || null, product_hashtag,
    tone_direction || null, cta_instructions || null,
    service_pairing_notes || null, expires_at || null, frequency_cap,
  );

  res.redirect(`/internal/vendors${qs(req)}&added=1`);
});

// ── POST /campaign/renew — Extend expired campaign +30 days ──────────────────
router.post("/campaign/renew", requireSecret, requirePin, (req, res) => {
  const { campaign_id } = req.body;
  if (!campaign_id) return res.redirect(`/internal/vendors${qs(req)}`);

  const campaign = db.prepare(`SELECT id, expires_at FROM vendor_campaigns WHERE id = ?`).get(campaign_id);
  if (!campaign) return res.redirect(`/internal/vendors${qs(req)}`);

  const newExpiry = campaign.expires_at
    ? db.prepare(`SELECT date(?, '+30 days') AS d`).get(campaign.expires_at).d
    : db.prepare(`SELECT date('now', '+30 days') AS d`).get().d;

  db.prepare(`UPDATE vendor_campaigns SET expires_at = ? WHERE id = ?`).run(newExpiry, campaign_id);

  const thisMonth = new Date().toISOString().slice(0, 7);
  db.prepare(`DELETE FROM vendor_post_log WHERE campaign_id = ? AND posted_month = ?`).run(campaign_id, thisMonth);

  res.redirect(`/internal/vendors${qs(req)}&renewed=1`);
});

export default router;
