// src/routes/vendorAdmin.js
// Internal MostlyPostly admin route for managing vendor campaign content.
// Protected by INTERNAL_SECRET env var — NOT accessible to salon managers.
// Mount at: /internal/vendors
//
// Usage:
//   GET  /internal/vendors?secret=<INTERNAL_SECRET>  — dashboard
//   POST /internal/vendors/upload?secret=<...>        — upload CSV
//   POST /internal/vendors/delete/:id?secret=<...>    — delete campaign
//   GET  /internal/vendors/template?secret=<...>      — download CSV template

import express from "express";
import multer from "multer";
import crypto from "crypto";
import db from "../../db.js";

const router = express.Router();

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
function requireSecret(req, res, next) {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret) {
    return res.status(503).send("INTERNAL_SECRET env var not set.");
  }
  if (req.query.secret !== secret) {
    return res.status(403).send("Forbidden.");
  }
  next();
}

function qs(req) {
  return `?secret=${encodeURIComponent(req.query.secret || "")}`;
}

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

// ── GET / — Dashboard ─────────────────────────────────────────────────────────
router.get("/", requireSecret, (req, res) => {
  const campaigns = db.prepare(`
    SELECT * FROM vendor_campaigns ORDER BY vendor_name ASC, campaign_name ASC
  `).all();

  // Group by vendor
  const vendors = {};
  for (const c of campaigns) {
    if (!vendors[c.vendor_name]) vendors[c.vendor_name] = [];
    vendors[c.vendor_name].push(c);
  }

  const safe = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const vendorBlocks = Object.entries(vendors).map(([vendor, items]) => `
    <div class="mb-8">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-bold">${safe(vendor)}</h2>
        <span class="text-sm text-gray-500">${items.length} campaign${items.length !== 1 ? "s" : ""}</span>
      </div>
      <div class="space-y-3">
        ${items.map(c => `
          <div class="border rounded-xl p-4 bg-white flex gap-4 items-start">
            ${c.photo_url ? `<img src="${safe(c.photo_url)}" class="w-16 h-16 object-cover rounded-lg border flex-shrink-0" onerror="this.style.display='none'" />` : ""}
            <div class="flex-1 min-w-0">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <p class="font-semibold text-sm">${safe(c.campaign_name)}</p>
                  <p class="text-xs text-gray-500">${safe(c.product_name || "")}</p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span class="text-xs px-2 py-0.5 rounded-full ${c.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}">
                    ${c.active ? "Active" : "Paused"}
                  </span>
                  <form method="POST" action="/internal/vendors/delete/${safe(c.id)}${qs(req)}"
                        onsubmit="return confirm('Delete this campaign?')" class="inline">
                    <button type="submit" class="text-xs text-red-500 hover:text-red-700">Delete</button>
                  </form>
                </div>
              </div>
              <p class="text-xs text-gray-600 mt-1">${safe(c.product_description || "")}</p>
              <div class="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
                <span>Expires: <strong>${safe(c.expires_at || "—")}</strong></span>
                <span>Cap: <strong>${safe(c.frequency_cap || 4)}/month</strong></span>
                <span>Tone: <strong>${safe(c.tone_direction || "—")}</strong></span>
                ${c.hashtags ? `<span>Tags: ${safe(c.hashtags)}</span>` : ""}
              </div>
              ${c.cta_instructions ? `<p class="text-xs text-blue-600 mt-1">CTA: ${safe(c.cta_instructions)}</p>` : ""}
            </div>
          </div>`).join("")}
      </div>
    </div>
  `).join("");

  const html = `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8" /><title>Vendor Admin — MostlyPostly</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-gray-50 text-gray-900 p-8 font-sans">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-2xl font-bold">Vendor Campaign Admin</h1>
        <p class="text-sm text-gray-500 mt-0.5">Internal MostlyPostly tool — not visible to salon managers.</p>
      </div>
      <div class="flex gap-3">
        <a href="/internal/vendors/template${qs(req)}"
           class="text-sm border rounded-lg px-4 py-2 hover:bg-gray-100">Download Template</a>
      </div>
    </div>

    <!-- Upload form -->
    <div class="border rounded-2xl bg-white p-6 mb-8">
      <h2 class="font-bold mb-1">Upload Vendor CSV</h2>
      <p class="text-sm text-gray-500 mb-4">
        New campaigns are added. Existing campaigns (matched by vendor_name + campaign_name) are skipped to avoid duplicates.
      </p>
      <form method="POST" action="/internal/vendors/upload${qs(req)}" enctype="multipart/form-data" class="flex gap-3 items-end">
        <div>
          <label class="block text-xs font-semibold text-gray-500 mb-1">CSV File</label>
          <input type="file" name="csv" accept=".csv" required
                 class="text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold" />
        </div>
        <button type="submit"
                class="rounded-lg bg-gray-900 px-5 py-2 text-sm font-semibold text-white hover:bg-gray-700">
          Upload
        </button>
      </form>
    </div>

    <!-- Campaign list -->
    ${campaigns.length === 0
      ? `<div class="text-center py-16 text-gray-400 text-sm">No campaigns loaded yet. Upload a CSV to get started.</div>`
      : vendorBlocks
    }
  </div>
</body></html>`;

  res.send(html);
});

// ── GET /template — CSV download ──────────────────────────────────────────────
router.get("/template", requireSecret, (_req, res) => {
  const lines = [
    CSV_HEADERS.join(","),
    CSV_EXAMPLE.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","),
  ];
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"vendor-campaigns-template.csv\"");
  res.send(lines.join("\n"));
});

// ── POST /upload — CSV import ─────────────────────────────────────────────────
router.post("/upload", requireSecret, csvUpload.single("csv"), (req, res) => {
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
router.post("/delete/:id", requireSecret, (req, res) => {
  db.prepare("DELETE FROM vendor_campaigns WHERE id = ?").run(req.params.id);
  res.redirect(`/internal/vendors${qs(req)}`);
});

export default router;
