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

const router = express.Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const PROOF_DIR = path.resolve("public/uploads/vendor-proofs");
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

  // Group campaigns by vendor
  const vendors = {};
  for (const c of campaigns) {
    if (!vendors[c.vendor_name]) vendors[c.vendor_name] = [];
    vendors[c.vendor_name].push(c);
  }

  const safe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const planColor = p => ({ pro: "bg-purple-100 text-purple-700", growth: "bg-blue-100 text-blue-700", starter: "bg-green-100 text-green-700", trial: "bg-gray-100 text-gray-600" }[p] || "bg-gray-100 text-gray-600");
  const statusColor = s => ({ active: "bg-green-100 text-green-700", trialing: "bg-blue-100 text-blue-700", past_due: "bg-yellow-100 text-yellow-700", canceled: "bg-red-100 text-red-600" }[s] || "bg-gray-100 text-gray-600");

  const vendorBlocks = Object.entries(vendors).map(([vendor, items]) => `
    <div class="mb-6">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-bold text-gray-900">${safe(vendor)}
          <span class="ml-2 text-xs font-normal text-gray-400">${items.length} campaign${items.length !== 1 ? "s" : ""}</span>
        </h3>
      </div>
      <div class="space-y-2">
        ${items.map(c => `
          <div class="border rounded-xl p-4 bg-white flex gap-4 items-start">
            ${c.photo_url ? `<img src="${safe(c.photo_url)}" class="w-14 h-14 object-cover rounded-lg border flex-shrink-0" onerror="this.style.display='none'" />` : `<div class="w-14 h-14 rounded-lg border bg-gray-50 flex-shrink-0 flex items-center justify-center text-xl">🏷️</div>`}
            <div class="flex-1 min-w-0">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-semibold text-sm">${safe(c.campaign_name)}</p>
                  <p class="text-xs text-gray-500">${safe(c.product_name || "")}</p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-xs px-2 py-0.5 rounded-full ${c.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}">${c.active ? "Active" : "Paused"}</span>
                  <form method="POST" action="/internal/vendors/delete/${safe(c.id)}${qs(req)}"
                        onsubmit="return confirm('Delete campaign: ${safe(c.campaign_name)}?')" class="inline">
                    <button type="submit" class="text-xs text-red-400 hover:text-red-600">Delete</button>
                  </form>
                </div>
              </div>
              <p class="text-xs text-gray-500 mt-1 line-clamp-2">${safe(c.product_description || "")}</p>
              <div class="mt-1.5 flex flex-wrap gap-3 text-xs text-gray-400">
                <span>Expires: <strong class="text-gray-600">${safe(c.expires_at || "—")}</strong></span>
                <span>Cap: <strong class="text-gray-600">${safe(c.frequency_cap || 4)}/mo</strong></span>
                <span>Tone: <strong class="text-gray-600">${safe(c.tone_direction || "—")}</strong></span>
              </div>
              ${c.cta_instructions ? `<p class="text-xs text-blue-500 mt-1">CTA: ${safe(c.cta_instructions)}</p>` : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>
  `).join("");

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

    <!-- Stats -->
    <div class="grid grid-cols-2 sm:grid-cols-6 gap-3">
      <div class="stat-card"><div class="stat-val">${totalSalons}</div><div class="stat-lbl">Total Accounts</div></div>
      <div class="stat-card"><div class="stat-val text-green-600">${active}</div><div class="stat-lbl">Active</div></div>
      <div class="stat-card"><div class="stat-val text-blue-600">${trialing}</div><div class="stat-lbl">Trialing</div></div>
      <div class="stat-card"><div class="stat-val text-red-500">${canceled}</div><div class="stat-lbl">Canceled</div></div>
      <div class="stat-card"><div class="stat-val text-purple-600">${totalCampaigns}</div><div class="stat-lbl">Vendor Campaigns</div></div>
      <div class="stat-card"><div class="stat-val ${pendingCount > 0 ? "text-yellow-500" : "text-gray-400"}">${pendingCount}</div><div class="stat-lbl">Pending Approvals</div></div>
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
      <h2 class="font-bold mb-4">Vendor Campaigns
        <span class="ml-2 text-sm font-normal text-gray-400">${totalCampaigns} total</span>
      </h2>
      ${campaigns.length === 0
        ? `<div class="text-center py-12 text-gray-400 text-sm">No campaigns loaded yet. Upload a CSV to get started.</div>`
        : vendorBlocks}
    </div>

  </div>
</body></html>`;

  res.send(html);
});

// ── POST /delete-salon ─────────────────────────────────────────────────────────
router.post("/delete-salon", requireSecret, requirePin, (req, res) => {
  const { salon_slug } = req.body;
  if (!salon_slug) return res.redirect(`/internal/vendors${qs(req)}`);

  // Delete in dependency order
  db.prepare("DELETE FROM post_insights WHERE post_id IN (SELECT id FROM posts WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM posts WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM stylists WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM manager_tokens WHERE manager_id IN (SELECT id FROM managers WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM password_reset_tokens WHERE manager_id IN (SELECT id FROM managers WHERE salon_id = ?)").run(salon_slug);
  db.prepare("DELETE FROM managers WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salon_vendor_feeds WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salon_vendor_approvals WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM stock_photos WHERE salon_id = ?").run(salon_slug);
  db.prepare("DELETE FROM salons WHERE slug = ?").run(salon_slug);

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

export default router;
