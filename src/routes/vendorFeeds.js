// src/routes/vendorFeeds.js
// Pro-plan salon vendor management page.
// Salon managers toggle which vendor brands they want to pull content from.
// Mount at: /manager/vendors

import express from "express";
import crypto from "crypto";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.manager?.manager_phone) return res.redirect("/manager/login");
  next();
}

function safe(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseHashtags(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch {}
  return raw.split(",").map(t => t.trim()).filter(Boolean);
}

// ── GET / — Vendor list ───────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon    = db.prepare("SELECT * FROM salons WHERE slug = ?").get(salon_id);
  if (!salon) return res.redirect("/manager/login");

  const isPro = (salon.plan || "trial") === "pro";

  // All active vendors in our system (grouped by vendor name)
  const campaigns = db.prepare(`
    SELECT * FROM vendor_campaigns WHERE active = 1 ORDER BY vendor_name ASC, campaign_name ASC
  `).all();

  // Which vendors this salon has enabled
  const feeds = db.prepare(`
    SELECT vendor_name, enabled FROM salon_vendor_feeds WHERE salon_id = ?
  `).all(salon_id);
  const feedMap = Object.fromEntries(feeds.map(f => [f.vendor_name, f.enabled]));

  // Which vendors this salon is approved for
  const approvals = db.prepare(`
    SELECT vendor_name, status FROM salon_vendor_approvals WHERE salon_id = ?
  `).all(salon_id);
  const approvalMap = Object.fromEntries(approvals.map(a => [a.vendor_name, a.status]));

  // Brand configs and vendor settings (Task 3)
  const brandConfigs = db.prepare(`SELECT * FROM vendor_brands`).all();
  const brandConfigMap = Object.fromEntries(brandConfigs.map(b => [b.vendor_name, b]));

  const vendorSettings = db.prepare(`
    SELECT vendor_name, affiliate_url, category_filters FROM salon_vendor_feeds WHERE salon_id = ?
  `).all(salon_id);
  const vendorSettingsMap = Object.fromEntries(vendorSettings.map(s => [s.vendor_name, s]));

  // Month count per campaign for this salon
  const thisMonth = new Date().toISOString().slice(0, 7);

  // Group campaigns by vendor
  const vendorMap = {};
  for (const c of campaigns) {
    const { count: monthCount } = db.prepare(`
      SELECT COUNT(*) AS count FROM vendor_post_log
      WHERE salon_id = ? AND campaign_id = ? AND posted_month = ?
    `).get(salon_id, c.id, thisMonth);
    c.monthCount = monthCount;
    if (!vendorMap[c.vendor_name]) vendorMap[c.vendor_name] = [];
    vendorMap[c.vendor_name].push(c);
  }
  const vendors = Object.entries(vendorMap);

  const upgradeGate = `
    <div class="rounded-2xl border border-mpBorder bg-white px-6 py-10 text-center max-w-xl mx-auto mt-8">
      <div class="text-4xl mb-4">🏷️</div>
      <h2 class="text-lg font-bold text-mpCharcoal mb-2">Vendor Brand Integrations</h2>
      <p class="text-sm text-mpMuted mb-6">
        Connect your salon to brand campaigns from professional beauty companies like Aveda, Redken, Wella, and more.
        The AI adapts each campaign to your salon's tone of voice and queues posts within your existing schedule.
      </p>
      <div class="rounded-xl bg-mpBg border border-mpBorder px-5 py-4 text-left text-sm text-mpMuted mb-6 space-y-2">
        <p class="font-semibold text-mpCharcoal text-xs uppercase tracking-wide mb-2">What you get on Pro</p>
        <p>✓ Access to curated brand campaigns</p>
        <p>✓ Toggle specific vendors and campaigns on/off</p>
        <p>✓ AI adapts brand copy to your salon's voice</p>
        <p>✓ Posts respect your existing schedule and spacing</p>
        <p>✓ Campaign analytics for both you and the brand</p>
      </div>
      <a href="/manager/billing?salon=${salon_id}"
         class="inline-flex items-center gap-2 rounded-full bg-mpCharcoal px-6 py-2.5 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
        Upgrade to Pro &rarr;
      </a>
    </div>`;

  // Flash banners (Task 3)
  const flashBanners = [
    req.query.settings_saved
      ? `<div class="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800 font-medium mb-4">Vendor settings saved.</div>`
      : "",
    req.query.renewed
      ? `<div class="rounded-xl bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800 font-medium mb-4">"${safe(decodeURIComponent(req.query.renewed || ""))}" renewed &#8212; campaign is active again.</div>`
      : "",
    req.query.requested
      ? `<div class="rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium mb-4">Access requested. We&#8217;ll review shortly.</div>`
      : "",
  ].join("");

  let vendorCards = "";
  if (vendors.length === 0) {
    vendorCards = `<div class="text-center py-12 text-mpMuted text-sm">No vendor campaigns are available yet. Check back soon.</div>`;
  } else {
    vendorCards = vendors.map(([vendorName, items]) => {
      const enabled        = !!feedMap[vendorName];
      const approvalStatus = approvalMap[vendorName] || null; // null = never requested
      const isApproved     = approvalStatus === "approved";
      const isPending      = approvalStatus === "pending";
      const isDenied       = approvalStatus === "denied";
      const canToggle      = isPro; // Pro plan is the gate — no separate approval required

      // Task 3: brand config and vendor settings per vendor
      const brandCfg      = brandConfigMap[vendorName] || {};
      const vendorSetting = vendorSettingsMap[vendorName] || {};
      // Canonical category set merged with any DB-specific categories for this vendor
      // Product categories: brand-configured list takes priority.
      // Fall back to any categories found on existing campaigns (backward compat).
      // Exclude campaign type values (Standard, Promotion, etc.) — those are not product categories.
      const CAMPAIGN_TYPE_NAMES = new Set(['Standard', 'Promotion', 'Educational', 'Product Launch', 'Seasonal', 'Brand Awareness']);
      const brandConfigCats = (() => { try { return JSON.parse(brandCfg.categories || "[]"); } catch { return []; } })()
        .filter(c => !CAMPAIGN_TYPE_NAMES.has(c));
      const dbCategoryRows = db.prepare(`
        SELECT DISTINCT category FROM vendor_campaigns
        WHERE vendor_name = ? AND category IS NOT NULL AND category != ''
        ORDER BY category
      `).all(vendorName);
      const dbCategories = dbCategoryRows.map(r => r.category).filter(c => !CAMPAIGN_TYPE_NAMES.has(c));
      const brandCategories = brandConfigCats.length > 0
        ? brandConfigCats
        : [...new Set(dbCategories)];
      const activeFilters   = (() => { try { return JSON.parse(vendorSetting.category_filters || "[]"); } catch { return []; } })();
      const canRenew        = brandCfg.allow_client_renewal !== 0;
      const vKey            = safe(vendorName.replace(/\s+/g, "_"));

      const today      = new Date().toISOString().slice(0, 10);
      const nonExpired = items.filter(c => !c.expires_at || c.expires_at >= today);
      const expired    = items.filter(c => c.expires_at && c.expires_at < today);

      const campaignPreviews = nonExpired.slice(0, 5).map(c => {
        const tags = parseHashtags(c.hashtags).slice(0, 4);
        const cap = c.frequency_cap || 4;
        const atCap = c.monthCount >= cap;
        return `
          <div class="rounded-xl border border-mpBorder bg-mpBg p-3 flex gap-3 items-start" data-campaign-wrapper>
            ${c.photo_url
              ? `<img src="${safe(c.photo_url)}" class="w-14 h-14 object-cover rounded-lg border border-mpBorder flex-shrink-0" onerror="this.style.display='none'" />`
              : `<div class="w-14 h-14 rounded-lg border border-mpBorder bg-white flex items-center justify-center text-mpMuted text-xl flex-shrink-0">🏷️</div>`}
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold text-mpCharcoal">${safe(c.campaign_name)}</p>
              <p class="text-[11px] text-mpMuted mt-0.5 line-clamp-2">${safe(c.product_description || c.product_name || "")}</p>
              ${tags.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${tags.map(t => `<span class="text-[10px] bg-white border border-mpBorder rounded-full px-2 py-0.5 text-mpMuted">${safe(t)}</span>`).join("")}</div>` : ""}
              <p class="text-[10px] text-mpMuted mt-1">
                ${c.cta_instructions ? `CTA: ${safe(c.cta_instructions.slice(0, 60))}` : ""}
              </p>
              <div class="text-xs text-gray-500 mt-2 flex gap-4 flex-wrap">
                ${c.product_hashtag ? `<span>${safe(c.product_hashtag)}</span>` : ""}
                ${c.expires_at ? `<span>Expires: ${safe(c.expires_at)}</span>` : ""}
              </div>
              <div class="flex gap-2 mt-3" data-campaign-id="${safe(c.id)}">
                <button
                  class="add-to-queue-btn px-4 py-2 text-sm rounded-lg font-medium ${atCap ? "bg-gray-200 text-gray-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"}"
                  data-campaign-id="${safe(c.id)}"
                  data-cap="${cap}"
                  ${atCap ? "disabled" : ""}>
                  ${atCap ? "Monthly cap reached" : "Add to Queue"}
                </button>
                ${canRenew ? `
                <button class="reset-campaign-btn px-4 py-2 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50"
                  data-campaign-id="${safe(c.id)}">Reset</button>` : ""}
              </div>
            </div>
          </div>`;
      }).join("");

      const moreCount = nonExpired.length - 5;

      // Right-side action: Pro = toggle available
      const actionArea = !isPro
        ? `<span class="text-xs text-mpMuted">Pro required</span>`
        : `<form method="POST" action="/manager/vendors/toggle?salon=${salon_id}" class="flex items-center gap-3">
             <input type="hidden" name="vendor_name" value="${safe(vendorName)}" />
             <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}" />
             <span class="text-xs font-medium ${enabled ? "text-mpAccent" : "text-mpMuted"}">${enabled ? "Active" : "Off"}</span>
             <button type="submit"
               class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none
                      ${enabled ? "bg-mpAccent" : "bg-mpBorder"} cursor-pointer">
               <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
                            ${enabled ? "translate-x-6" : "translate-x-1"}"></span>
             </button>
           </form>`;

      // Approval status badge (shown below vendor name)
      const approvalBadge = isApproved
        ? `<span class="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">✓ Partner Verified</span>`
        : "";

      return `
        <div class="rounded-2xl border ${enabled ? "border-mpAccent bg-mpAccentLight/20" : "border-mpBorder bg-white"} transition-colors">
          <div class="px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <p class="font-bold text-mpCharcoal">${safe(vendorName)}</p>
              <div class="flex items-center gap-2 mt-0.5 flex-wrap">
                <span class="text-xs text-mpMuted">${nonExpired.length} active campaign${nonExpired.length !== 1 ? "s" : ""}${expired.length ? ` · ${expired.length} expired` : ""}</span>
                ${approvalBadge}
              </div>
            </div>
            <div class="flex-shrink-0">${actionArea}</div>
          </div>

          <!-- Campaign previews — Pro only -->
          ${isPro && nonExpired.length > 0 ? `
          <div class="border-t border-mpBorder px-5 py-4">
            <details class="vendor-accordion">
              <summary class="text-xs font-semibold text-mpMuted hover:text-mpCharcoal cursor-pointer select-none mb-3">
                ▶ Preview content <span class="count-pill ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">${nonExpired.reduce((s, c) => s + (c.monthCount || 0), 0)}/${nonExpired.reduce((s, c) => s + (c.frequency_cap || 4), 0)} this month</span>
              </summary>
              <div class="space-y-2">
                ${campaignPreviews}
                ${moreCount > 0 ? `<p class="text-xs text-mpMuted pl-1">+ ${moreCount} more campaign${moreCount !== 1 ? "s" : ""}</p>` : ""}
              </div>
            </details>
          </div>` : ""}

          <!-- Expired campaigns (Pro only) -->
          ${isPro && expired.length > 0 ? `
          <div class="border-t border-mpBorder px-5 py-4">
            <p class="text-[11px] text-mpMuted font-semibold uppercase tracking-wide mb-2">Expired Campaigns</p>
            <div class="space-y-2">
              ${expired.map(c => `
                <div class="rounded-xl border border-mpBorder bg-mpBg p-3 flex gap-3 items-start opacity-60">
                  ${c.photo_url
                    ? `<img src="${safe(c.photo_url)}" class="w-14 h-14 object-cover rounded-lg border border-mpBorder flex-shrink-0" style="filter:grayscale(1)" onerror="this.style.display='none'" />`
                    : `<div class="w-14 h-14 rounded-lg border border-mpBorder bg-white flex items-center justify-center text-mpMuted text-xl flex-shrink-0">&#127991;</div>`}
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <div>
                        <p class="text-xs font-semibold text-mpCharcoal">${safe(c.campaign_name)}</p>
                        <p class="text-[11px] text-mpMuted">Expired ${safe(c.expires_at)}</p>
                      </div>
                      ${canRenew ? `
                      <form method="POST" action="/manager/vendors/renew-campaign" class="shrink-0">
                        <input type="hidden" name="campaign_id" value="${safe(c.id)}" />
                        <button type="submit"
                                class="text-[11px] rounded-full bg-mpCharcoal text-white px-3 py-1 font-semibold hover:bg-mpCharcoalDark">
                          Renew
                        </button>
                      </form>` : ""}
                    </div>
                  </div>
                </div>`).join("")}
            </div>
          </div>` : ""}

          <!-- Settings section (Pro only, collapsed by default) -->
          ${isPro ? `
          <div class="border-t border-mpBorder px-5 py-4">
            <details class="vendor-accordion">
              <summary class="text-xs font-semibold text-mpMuted hover:text-mpCharcoal cursor-pointer select-none">
                ▶ Settings
              </summary>
              <div class="mt-3">
              <form method="POST" action="/manager/vendors/settings" class="space-y-4">
                <input type="hidden" name="vendor_name" value="${safe(vendorName)}" />
                <div>
                  <label class="block text-xs font-semibold text-mpCharcoal mb-1">Affiliate URL</label>
                  <input type="url" name="affiliate_url"
                         value="${safe(vendorSetting.affiliate_url || "")}"
                         placeholder="https://aveda.com/ref/your-salon"
                         class="w-full border border-mpBorder rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-mpAccent" />
                  <p class="text-[11px] text-mpMuted mt-1">
                    Your unique partner link &#8212; added to all ${safe(vendorName)} posts automatically.
                    Also serves as proof of partnership when requesting access.
                  </p>
                </div>
                ${brandCategories.length > 0 ? `
                <div>
                  <label class="block text-xs font-semibold text-mpCharcoal mb-2">Product Categories to Sync</label>
                  <div class="flex flex-wrap gap-3">
                    ${brandCategories.map(cat => `
                      <label class="flex items-center gap-2 text-sm text-mpMuted cursor-pointer">
                        <input type="checkbox" name="category_filters[]" value="${safe(cat)}"
                               ${activeFilters.includes(cat) ? "checked" : ""}
                               class="rounded border-mpBorder" />
                        ${safe(cat)}
                      </label>`).join("")}
                  </div>
                  <p class="text-[11px] text-mpMuted mt-1">Leave all unchecked to sync all categories.</p>
                </div>` : ""}
                <button type="submit"
                        class="rounded-xl bg-mpCharcoal text-white px-5 py-2 text-sm font-semibold hover:bg-mpCharcoalDark transition-colors">
                  Save Settings
                </button>
              </form>
            </div>
            </details>
          </div>` : ""}
        </div>`;
    }).join("");
  }

  const body = `
    <style>
      .vendor-accordion summary { list-style: none; }
      .vendor-accordion summary::-webkit-details-marker { display: none; }
      .vendor-accordion[open] > summary { color: #2B2D35; }
    </style>
    ${flashBanners}
    <section class="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <h1 class="text-2xl font-bold">Vendor Brands</h1>
        <p class="text-sm text-mpMuted mt-0.5">Toggle brand partner campaigns into your posting schedule.</p>
      </div>
      ${isPro
        ? `<span class="inline-flex items-center gap-2 rounded-full border border-mpBorder bg-white px-4 py-1.5 text-xs font-semibold text-mpMuted shadow-sm">
             <span class="h-2 w-2 rounded-full bg-mpAccent"></span>Pro Plan
           </span>`
        : `<span class="inline-flex items-center gap-2 rounded-full border border-mpBorder bg-white px-4 py-1.5 text-xs font-semibold text-mpMuted shadow-sm">
             Pro feature
           </span>`}
    </section>

    ${!isPro ? upgradeGate : `<div class="space-y-4">${vendorCards}</div>`}

    ${isPro ? `
    <div class="mt-8 rounded-2xl border border-mpBorder bg-white px-5 py-4">
      <h3 class="text-xs font-bold text-mpCharcoal mb-1">How vendor campaigns work</h3>
      <ul class="text-xs text-mpMuted space-y-1 ml-3 list-disc">
        <li>When enabled, campaigns queue within your existing posting schedule and spacing rules.</li>
        <li>The AI rewrites each brand post in your salon's tone of voice — not generic copy.</li>
        <li>Campaigns respect their frequency cap (e.g. 4 posts/month) so your feed stays balanced.</li>
        <li>Expired campaigns are automatically skipped — nothing goes live after the end date.</li>
        <li>Manager approval rules apply to vendor posts just like stylist posts.</li>
      </ul>
    </div>` : ""}

    <script>
(function() {
  var csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

  document.addEventListener('click', async function(e) {
    // Add to Queue
    var addBtn = e.target.closest('.add-to-queue-btn');
    if (addBtn) {
      if (addBtn.disabled) return;
      var campaignId = addBtn.dataset.campaignId;
      addBtn.textContent = 'Adding\u2026';
      addBtn.disabled = true;
      try {
        var res = await fetch('/manager/vendors/add-to-queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ campaign_id: campaignId })
        });
        var data = await res.json();
        if (data.success) {
          addBtn.textContent = 'Added \u2713';
          var accordion = addBtn.closest('details.vendor-accordion');
          if (accordion) {
            var pill = accordion.querySelector('.count-pill');
            if (pill) pill.textContent = data.count + '/' + data.cap + ' this month';
          }
          if (data.count >= data.cap) {
            addBtn.textContent = 'Monthly cap reached';
            addBtn.disabled = true;
            addBtn.className = addBtn.className.replace('bg-blue-600 text-white hover:bg-blue-700', 'bg-gray-200 text-gray-400 cursor-not-allowed');
          }
        } else {
          addBtn.textContent = data.error ? data.error.slice(0, 40) : 'Error \u2014 try again';
          setTimeout(function() { addBtn.textContent = 'Add to Queue'; addBtn.disabled = false; }, 3000);
        }
      } catch (err) {
        addBtn.textContent = 'Error \u2014 try again';
        setTimeout(function() { addBtn.textContent = 'Add to Queue'; addBtn.disabled = false; }, 3000);
      }
      return;
    }

    // Reset
    var resetBtn = e.target.closest('.reset-campaign-btn');
    if (resetBtn) {
      if (!confirm("Reset this month's post count for this campaign?")) return;
      try {
        var r = await fetch('/manager/vendors/reset-campaign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ campaign_id: resetBtn.dataset.campaignId })
        });
        var d = await r.json();
        if (d.success) location.reload();
      } catch (err) {}
    }
  });
})();
</script>

  `;

  res.send(pageShell({ title: "Vendor Brands", body, salon_id, current: "vendors" }));
});

// ── POST /toggle ──────────────────────────────────────────────────────────────
router.post("/toggle", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const salon    = db.prepare("SELECT plan FROM salons WHERE slug = ?").get(salon_id);
  const isPro    = (salon?.plan || "trial") === "pro";
  if (!isPro) return res.redirect(`/manager/vendors`);

  const { vendor_name, enabled } = req.body;
  if (!vendor_name) return res.redirect(`/manager/vendors`);

  // Pro plan is the only requirement — no separate approval gate

  const enabledInt = enabled === "1" ? 1 : 0;
  db.prepare(`
    INSERT INTO salon_vendor_feeds (id, salon_id, vendor_name, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(salon_id, vendor_name) DO UPDATE SET enabled = excluded.enabled
  `).run(crypto.randomUUID(), salon_id, vendor_name, enabledInt);

  res.redirect(`/manager/vendors`);
});

// ── POST /request-access ──────────────────────────────────────────────────────
router.post("/request-access", requireAuth, (req, res) => {
  const salon_id    = req.manager.salon_id;
  const { vendor_name } = req.body;
  if (!vendor_name) return res.redirect(`/manager/vendors`);

  // Only insert if no existing request
  db.prepare(`
    INSERT OR IGNORE INTO salon_vendor_approvals (id, salon_id, vendor_name, status, requested_at)
    VALUES (?, ?, ?, 'pending', datetime('now'))
  `).run(crypto.randomUUID(), salon_id, vendor_name);

  res.redirect(`/manager/vendors?requested=1`);
});

// ── POST /settings ────────────────────────────────────────────────────────────
router.post("/settings", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const { vendor_name, affiliate_url } = req.body;
  if (!vendor_name) return res.redirect("/manager/vendors");

  // qs strips [] from key names: category_filters[] → category_filters
  const rawFilters = req.body["category_filters[]"] ?? req.body.category_filters;
  const categoryFilters = Array.isArray(rawFilters)
    ? rawFilters
    : rawFilters
    ? [rawFilters]
    : [];

  // Upsert so settings are saved even if no feed row exists yet
  db.prepare(`
    INSERT INTO salon_vendor_feeds (id, salon_id, vendor_name, enabled, affiliate_url, category_filters)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(salon_id, vendor_name) DO UPDATE
      SET affiliate_url = excluded.affiliate_url,
          category_filters = excluded.category_filters
  `).run(crypto.randomUUID(), salon_id, vendor_name, affiliate_url || null, JSON.stringify(categoryFilters));

  res.redirect("/manager/vendors?settings_saved=1");
});

// ── POST /renew-campaign ──────────────────────────────────────────────────────
router.post("/renew-campaign", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const { campaign_id } = req.body;
  if (!campaign_id) return res.redirect("/manager/vendors");

  const campaign = db.prepare(`
    SELECT id, campaign_name, vendor_name, expires_at FROM vendor_campaigns WHERE id = ?
  `).get(campaign_id);
  if (!campaign) return res.redirect("/manager/vendors");

  // IDOR guard: salon must have an enabled feed for this vendor
  const feed = db.prepare(`
    SELECT salon_id FROM salon_vendor_feeds
    WHERE salon_id = ? AND vendor_name = ?
  `).get(salon_id, campaign.vendor_name);
  if (!feed) return res.redirect("/manager/vendors");

  // Gate: only if brand allows client renewal
  const brand = db.prepare(`SELECT allow_client_renewal FROM vendor_brands WHERE vendor_name = ?`)
    .get(campaign.vendor_name);
  if (!brand || brand.allow_client_renewal === 0) return res.redirect("/manager/vendors");

  const newExpiry = campaign.expires_at
    ? db.prepare(`SELECT date(?, '+30 days') AS d`).get(campaign.expires_at).d
    : db.prepare(`SELECT date('now', '+30 days') AS d`).get().d;

  db.prepare(`UPDATE vendor_campaigns SET expires_at = ? WHERE id = ?`).run(newExpiry, campaign_id);

  const thisMonth = new Date().toISOString().slice(0, 7);
  db.prepare(`DELETE FROM vendor_post_log WHERE campaign_id = ? AND posted_month = ?`).run(campaign_id, thisMonth);

  res.redirect(`/manager/vendors?renewed=${encodeURIComponent(campaign.campaign_name)}`);
});

// ── POST /add-to-queue ────────────────────────────────────────────────────────
router.post("/add-to-queue", requireAuth, async (req, res) => {
  const salonId = req.manager.salon_id;
  const { campaign_id } = req.body;
  if (!campaign_id) return res.json({ success: false, error: "Missing campaign_id" });

  const campaign = db.prepare(`SELECT * FROM vendor_campaigns WHERE id = ?`).get(campaign_id);
  if (!campaign) return res.json({ success: false, error: "Campaign not found" });

  const thisMonth = new Date().toISOString().slice(0, 7);
  const cap = campaign.frequency_cap || 4;
  const { count: monthCount } = db.prepare(`
    SELECT COUNT(*) AS count FROM vendor_post_log
    WHERE salon_id = ? AND campaign_id = ? AND posted_month = ?
  `).get(salonId, campaign_id, thisMonth);

  if (monthCount >= cap) return res.json({ success: false, error: "Monthly cap reached" });

  const salon = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salonId);
  const isPro = ['pro'].includes(salon?.plan);
  if (!isPro) return res.json({ success: false, error: 'Pro plan required' });

  // Get affiliate URL if the feed is configured, otherwise proceed without one
  const feed = db.prepare(`SELECT affiliate_url FROM salon_vendor_feeds WHERE salon_id = ? AND vendor_name = ?`).get(salonId, campaign.vendor_name);
  const affiliateUrl = feed?.affiliate_url || null;

  const { generateVendorCaption, buildVendorHashtagBlock } = await import("../core/vendorScheduler.js");

  const caption = await generateVendorCaption({ campaign, salon, affiliateUrl });
  if (!caption) return res.json({ success: false, error: "Caption generation failed — check OpenAI API key" });

  const brandCfg = db.prepare(`SELECT brand_hashtags FROM vendor_brands WHERE vendor_name = ?`).get(campaign.vendor_name);
  const brandHashtags = (() => { try { return JSON.parse(brandCfg?.brand_hashtags || "[]"); } catch { return []; } })();
  const salonTags = (() => { try { return JSON.parse(salon.default_hashtags || "[]"); } catch { return []; } })();
  const lockedBlock = buildVendorHashtagBlock({ salonHashtags: salonTags, brandHashtags, productHashtag: campaign.product_hashtag || null });
  const finalCaption = caption + (lockedBlock ? `\n\n${lockedBlock}` : "");

  const postId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { maxnum } = db.prepare(`SELECT MAX(salon_post_number) AS maxnum FROM posts WHERE salon_id = ?`).get(salonId) || {};

  db.prepare(`
    INSERT INTO posts (id, salon_id, stylist_name, image_url, base_caption, final_caption, post_type, status, vendor_campaign_id, salon_post_number, created_at, updated_at)
    VALUES (@id, @salon_id, @stylist_name, @image_url, @base_caption, @final_caption, @post_type, @status, @vendor_campaign_id, @salon_post_number, @created_at, @updated_at)
  `).run({
    id: postId, salon_id: salonId,
    stylist_name: `${campaign.vendor_name} (Campaign)`,
    image_url: campaign.photo_url || null,
    base_caption: caption, final_caption: finalCaption,
    post_type: "standard_post", status: "manager_approved",
    vendor_campaign_id: campaign_id,
    salon_post_number: (maxnum || 0) + 1,
    created_at: now, updated_at: now,
  });

  db.prepare(`
    INSERT INTO vendor_post_log (id, salon_id, campaign_id, post_id, posted_month, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), salonId, campaign_id, postId, thisMonth, now);

  try {
    const { enqueuePost } = await import("../scheduler.js");
    const postRow = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(postId);
    if (postRow) enqueuePost(postRow);
  } catch (err) {
    console.warn("[VendorFeeds] enqueuePost failed:", err.message);
  }

  return res.json({ success: true, count: monthCount + 1, cap });
});

// ── POST /reset-campaign ──────────────────────────────────────────────────────
router.post("/reset-campaign", requireAuth, (req, res) => {
  const salonId = req.manager.salon_id;
  const { campaign_id } = req.body;
  if (!campaign_id) return res.json({ success: false, error: "Missing campaign_id" });
  const thisMonth = new Date().toISOString().slice(0, 7);
  db.prepare(`DELETE FROM vendor_post_log WHERE salon_id = ? AND campaign_id = ? AND posted_month = ?`)
    .run(salonId, campaign_id, thisMonth);
  return res.json({ success: true });
});

export default router;
