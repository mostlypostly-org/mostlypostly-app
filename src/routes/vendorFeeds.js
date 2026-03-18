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

  // Group campaigns by vendor
  const vendorMap = {};
  for (const c of campaigns) {
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
      const brandCategories = (() => { try { return JSON.parse(brandCfg.categories || "[]"); } catch { return []; } })();
      const activeFilters   = (() => { try { return JSON.parse(vendorSetting.category_filters || "[]"); } catch { return []; } })();
      const canRenew        = brandCfg.allow_client_renewal !== 0;
      const vKey            = safe(vendorName.replace(/\s+/g, "_"));

      const today      = new Date().toISOString().slice(0, 10);
      const nonExpired = items.filter(c => !c.expires_at || c.expires_at >= today);
      const expired    = items.filter(c => c.expires_at && c.expires_at < today);

      const campaignPreviews = nonExpired.slice(0, 5).map(c => {
        const tags = parseHashtags(c.hashtags).slice(0, 4);
        return `
          <div class="rounded-xl border border-mpBorder bg-mpBg p-3 flex gap-3 items-start">
            ${c.photo_url
              ? `<img src="${safe(c.photo_url)}" class="w-14 h-14 object-cover rounded-lg border border-mpBorder flex-shrink-0" onerror="this.style.display='none'" />`
              : `<div class="w-14 h-14 rounded-lg border border-mpBorder bg-white flex items-center justify-center text-mpMuted text-xl flex-shrink-0">🏷️</div>`}
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold text-mpCharcoal">${safe(c.campaign_name)}</p>
              <p class="text-[11px] text-mpMuted mt-0.5 line-clamp-2">${safe(c.product_description || c.product_name || "")}</p>
              ${tags.length ? `<div class="mt-1.5 flex flex-wrap gap-1">${tags.map(t => `<span class="text-[10px] bg-white border border-mpBorder rounded-full px-2 py-0.5 text-mpMuted">${safe(t)}</span>`).join("")}</div>` : ""}
              <p class="text-[10px] text-mpMuted mt-1">
                ${c.cta_instructions ? `CTA: ${safe(c.cta_instructions.slice(0, 60))}` : ""}
                ${c.expires_at ? ` · Expires ${safe(c.expires_at)}` : ""}
              </p>
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
        <div class="rounded-2xl border ${enabled ? "border-mpAccent bg-mpAccentLight/20" : "border-mpBorder bg-white"} overflow-hidden transition-colors">
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
            <button type="button"
                    data-vkey="${safe(vendorName.replace(/\s+/g, "_"))}"
                    onclick="togglePreview(this.dataset.vkey)"
                    class="text-xs font-semibold text-mpMuted hover:text-mpCharcoal flex items-center gap-1 mb-3">
              <span id="arrow_${safe(vendorName.replace(/\s+/g, "_"))}">▶</span>
              Preview content
            </button>
            <div id="preview_${safe(vendorName.replace(/\s+/g, "_"))}" style="display:none;" class="space-y-2">
              ${campaignPreviews}
              ${moreCount > 0 ? `<p class="text-xs text-mpMuted pl-1">+ ${moreCount} more campaign${moreCount !== 1 ? "s" : ""}</p>` : ""}
            </div>
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
            <button type="button"
                    data-vkey="${vKey}"
                    onclick="toggleSettings(this.dataset.vkey)"
                    class="text-xs font-semibold text-mpMuted hover:text-mpCharcoal flex items-center gap-1.5 mb-0">
              <span id="sa-${vKey}">&#9658;</span> Settings
            </button>
            <div id="sp-${vKey}" style="display:none;" class="mt-3">
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
          </div>` : ""}
        </div>`;
    }).join("");
  }

  const body = `
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
      function togglePreview(key) {
        var el    = document.getElementById('preview_' + key);
        var arrow = document.getElementById('arrow_' + key);
        if (!el) return;
        var isHidden = el.style.display === 'none' || el.style.display === '';
        el.style.display = isHidden ? 'block' : 'none';
        if (arrow) arrow.textContent = isHidden ? '▼' : '▶';
      }
      function toggleSettings(vKey) {
        var p = document.getElementById('sp-' + vKey);
        var a = document.getElementById('sa-' + vKey);
        if (!p || !a) return;
        var open = p.style.display !== 'none';
        p.style.display = open ? 'none' : 'block';
        a.textContent = open ? '\u25B6' : '\u25BC';
      }
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

  // Must be approved or pending for this vendor to save settings
  const approval = db.prepare(
    "SELECT id, status FROM salon_vendor_approvals WHERE salon_id = ? AND vendor_name = ?"
  ).get(salon_id, vendor_name);
  if (!approval || (approval.status !== "approved" && approval.status !== "pending")) {
    return res.redirect("/manager/vendors");
  }

  const categoryFilters = Array.isArray(req.body["category_filters[]"])
    ? req.body["category_filters[]"]
    : req.body["category_filters[]"]
    ? [req.body["category_filters[]"]]
    : [];

  // Upsert so settings are saved even if no feed row exists yet
  db.prepare(`
    INSERT INTO salon_vendor_feeds (id, salon_id, vendor_name, enabled, affiliate_url, category_filters)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(salon_id, vendor_name) DO UPDATE
      SET affiliate_url = excluded.affiliate_url,
          category_filters = excluded.category_filters
  `).run(crypto.randomUUID(), salon_id, vendor_name, affiliate_url || null, JSON.stringify(categoryFilters));

  // If affiliate_url provided and approval is still pending: update proof_file
  if (affiliate_url && approval.status === "pending") {
    db.prepare(`UPDATE salon_vendor_approvals SET proof_file = ? WHERE id = ?`)
      .run(affiliate_url, approval.id);
  }

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

  // IDOR guard: salon must have approved access to this vendor
  const feed = db.prepare(`
    SELECT f.salon_id FROM salon_vendor_feeds f
    JOIN salon_vendor_approvals a ON a.salon_id = f.salon_id AND a.vendor_name = f.vendor_name
    WHERE f.salon_id = ? AND f.vendor_name = ? AND a.status = 'approved'
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

export default router;
