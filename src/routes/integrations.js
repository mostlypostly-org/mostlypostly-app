// src/routes/integrations.js
// Zenoti (and future Vagaro) webhook receiver + Admin integrations UI

import express from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { encrypt, decrypt } from "../core/encryption.js";
import { createZenotiClient } from "../core/zenoti.js";
import { handleZenotiEvent, handleVagaroEvent } from "../core/integrationHandlers.js";
import { calculateOpenBlocks, formatBlocksAsSlots, categoriesForBlock, formatBlockWithCategory } from "../core/zenotiAvailability.js";
import { buildAvailabilityImage } from "../core/buildAvailabilityImage.js";
import { getZenotiClientForSalon, fetchStylistSlots, generateAndSaveAvailabilityPost } from "../core/zenotiSync.js";
import { DEFAULT_ROUTING, mergeRoutingDefaults } from "../core/platformRouting.js";
import { getSystemPlacementRouting, mergePlacementRouting } from "../core/placementRouting.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// Public webhook — must be registered BEFORE router.use auth guard
// so Zenoti can POST without a session cookie.
// ─────────────────────────────────────────────────────────────────
router.post("/webhook/zenoti/:salon_id", express.json(), async (req, res) => {
  const { salon_id } = req.params;

  // Look up the integration row to get webhook_secret (optional)
  const integration = db
    .prepare(`SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`)
    .get(salon_id);

  if (!integration) {
    console.warn(`[Zenoti Webhook] No integration found for salon=${salon_id}`);
    return res.status(404).json({ error: "Integration not configured" });
  }

  if (!integration.sync_enabled) {
    return res.status(200).json({ ok: true, skipped: "sync disabled" });
  }

  // Optional HMAC verification using stored webhook_secret
  if (integration.webhook_secret) {
    const signature = req.headers["x-zenoti-signature"] || req.headers["x-hub-signature-256"] || "";
    const rawBody = JSON.stringify(req.body);
    const expected = "sha256=" + crypto
      .createHmac("sha256", integration.webhook_secret)
      .update(rawBody)
      .digest("hex");
    if (signature !== expected) {
      console.warn(`[Zenoti Webhook] Signature mismatch for salon=${salon_id}`);
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  // Determine event type from payload or header
  const eventType =
    req.headers["x-zenoti-event"] ||
    req.body?.event_type ||
    req.body?.event ||
    req.body?.type ||
    "unknown";

  // Respond immediately — process async
  res.status(200).json({ received: true });

  try {
    await handleZenotiEvent(salon_id, eventType, req.body);
  } catch (err) {
    console.error(`[Zenoti Webhook] Handler error salon=${salon_id}:`, err.message);
  }
});

router.use(requireAuth, requireRole("owner", "manager"));

// ─────────────────────────────────────────────────────────────────
// GET /manager/integrations — collapsible card layout
// ─────────────────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const salon_id = req.manager?.salon_id;
  const manager_phone = req.manager?.manager_phone;

  const salon = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salon_id);
  if (!salon) return res.redirect("/manager/login");

  // Load existing integration rows
  const integrations = db
    .prepare(`SELECT * FROM salon_integrations WHERE salon_id = ?`)
    .all(salon_id);

  const byPlatform = {};
  for (const row of integrations) byPlatform[row.platform] = row;

  const zenoti = byPlatform["zenoti"] || null;

  // Plan check for GMB gate
  const salonPlan = salon.plan || "starter";
  const isGmbPlanAllowed = salonPlan === "growth" || salonPlan === "pro";

  // Connection status flags
  const fbConnected = !!(salon.facebook_page_id && salon.facebook_page_token);
  const gmbConnected = !!(salon.google_location_id && salon.google_access_token);
  const zenotiConnected = !!zenoti;
  const tiktokConnected = !!(salon.tiktok_account_id && salon.tiktok_refresh_token);
  const tiktokEnabled   = !!salon.tiktok_enabled;
  const tiktokUsername  = salon.tiktok_username || "";

  // Content Routing card data
  const routing = mergeRoutingDefaults(salon.platform_routing ?? null);
  const routingSaved = req.query.routing === 'saved';

  // Content Placement card data
  const VALID_PLACEMENTS = new Set(["reel", "story", "post"]);
  const systemPlacement = getSystemPlacementRouting();
  const salonPlacementJson = salon.placement_routing ?? null;
  const resolvedPlacement = mergePlacementRouting(systemPlacement, salonPlacementJson);
  const salonPlacementOverrides = salonPlacementJson ? (() => {
    try { return JSON.parse(salonPlacementJson); } catch { return {}; }
  })() : {};
  const placementSaved = req.query.placement === 'saved';

  // Webhook URL that Zenoti should POST to
  const BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  const zenotiWebhookUrl = `${BASE_URL}/integrations/webhook/zenoti/${salon_id}`;

  // Alert banners
  const testedOk     = req.query.tested === 'ok';
  const testedFail   = req.query.tested === 'fail';
  const testError    = req.query.error ? decodeURIComponent(req.query.error) : '';
  const centersCount = req.query.centers ? parseInt(req.query.centers, 10) : 0;
  const synced       = req.query.synced === '1';
  const syncFound    = req.query.found  ? parseInt(req.query.found, 10) : 0;
  const savedMap     = req.query.saved === 'mappings';
  const staffSynced  = req.query.staff_synced === '1';
  const staffMatched = req.query.staff_matched ? parseInt(req.query.staff_matched, 10) : 0;
  const staffTotal   = req.query.staff_total   ? parseInt(req.query.staff_total,   10) : 0;
  const staffNew     = req.query.staff_new     ? parseInt(req.query.staff_new,     10) : 0;
  const gmbStatus    = req.query.gmb || '';
  const tiktokFlash  = req.query.tiktok || '';

  let alertHtml = '';
  if (tiktokFlash === 'connected') {
    alertHtml = `<div class="mb-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">TikTok connected successfully.</div>`;
  } else if (tiktokFlash === 'disconnected') {
    alertHtml = `<div class="mb-4 rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">TikTok disconnected.</div>`;
  } else if (tiktokFlash === 'error') {
    alertHtml = `<div class="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">Could not connect TikTok — please try again.</div>`;
  } else if (gmbStatus === 'connected') {
    alertHtml = `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
      Google Business Profile connected successfully.
    </div>`;
  } else if (gmbStatus === 'disconnected') {
    alertHtml = `<div class="mb-6 rounded-xl bg-mpBg border border-mpBorder px-4 py-3 text-sm text-mpMuted font-medium">
      Google Business Profile disconnected.
    </div>`;
  } else if (gmbStatus === 'error') {
    alertHtml = `<div class="mb-6 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium">
      Google Business Profile connection failed. Please try again.
    </div>`;
  } else if (savedMap) {
    alertHtml = `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
      Stylist mappings saved successfully.
    </div>`;
  } else if (staffSynced) {
    const unmatchedCount = staffTotal - staffMatched;
    alertHtml = `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
      Staff sync complete — ${staffMatched} of ${staffTotal} Zenoti employee${staffTotal !== 1 ? 's' : ''} matched to stylists${staffNew > 0 ? ` (${staffNew} newly linked)` : ''}.${unmatchedCount > 0 ? ` <span class="font-normal text-green-600">${unmatchedCount} unmatched — enter their IDs manually below.</span>` : ''}
    </div>`;
  } else if (testedOk) {
    alertHtml = `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
      Connection successful — found ${centersCount} center${centersCount !== 1 ? 's' : ''}.
    </div>`;
  } else if (testedFail) {
    alertHtml = `<div class="mb-6 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium">
      Connection test failed: ${testError || 'Unknown error'}
    </div>`;
  } else if (synced) {
    alertHtml = `<div class="mb-6 rounded-xl bg-mpAccentLight border border-mpBorder px-4 py-3 text-sm text-mpAccent font-medium">
      Availability sync complete — ${syncFound} post${syncFound !== 1 ? 's' : ''} created and sent to Post Queue for approval.
    </div>`;
  } else if (routingSaved) {
    alertHtml = `<div class="mb-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">Content routing updated.</div>`;
  } else if (placementSaved) {
    alertHtml = `<div class="mb-4 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">Content placement updated.</div>`;
  }

  // ── Helper: card dot + status label ──────────────────────────
  function statusDot(connected) {
    return connected
      ? `<span class="w-2.5 h-2.5 rounded-full inline-block bg-green-500 flex-shrink-0"></span>`
      : `<span class="w-2.5 h-2.5 rounded-full inline-block bg-gray-300 flex-shrink-0"></span>`;
  }
  function statusLabel(connected) {
    return connected
      ? `<span class="text-sm text-green-600 font-medium">&#10003; Connected</span>`
      : `<span class="text-sm text-gray-400">Not set</span>`;
  }
  function chevron(id) {
    return `<svg id="chevron-${id}" xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
      <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
    </svg>`;
  }

  // ── Content Routing card helper ───────────────────────────────
  function buildRoutingRows(routingMap, hasFb, hasGmb, hasTiktok) {
    const POST_TYPE_LABELS = {
      availability:        "Availability",
      before_after:        "Before & After",
      celebration:         "Celebration",
      celebration_story:   "Celebration Story",
      standard_post:       "Standard Post",
      reel:                "Reel / Video",
      promotions:          "Promotions",
      product_education:   "Product Education",
    };

    // TikTok column greyed for these post types (skipped by scheduler anyway)
    const TIKTOK_INELIGIBLE = new Set(["availability", "promotions", "celebration_story"]);

    // GMB column only available for growth/pro plan salons
    const gmbColumnEnabled = hasGmb && isGmbPlanAllowed;

    // IG requires FB connection
    const igEnabled = hasFb;

    function toggleCell(postType, platform, enabled, disabled) {
      const name  = `routing_${postType}_${platform}`;
      const inner = `
        <label class="relative inline-flex items-center cursor-pointer${disabled ? ' opacity-40 pointer-events-none cursor-not-allowed' : ''}">
          <input type="checkbox" name="${name}" value="1"${enabled ? ' checked' : ''}
            class="sr-only peer col-${platform}">
          <div class="w-11 h-6 rounded-full transition-colors peer-checked:bg-mpAccent bg-gray-200 relative
            after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-all
            peer-checked:after:translate-x-5"></div>
        </label>`;
      if (disabled) {
        return `<td class="text-center py-2 px-3"><span class="inline-flex justify-center opacity-40 cursor-not-allowed pointer-events-none">${inner}</span></td>`;
      }
      return `<td class="text-center py-2 px-3">${inner}</td>`;
    }

    return Object.entries(POST_TYPE_LABELS).map(([pt, label]) => {
      const r = routingMap[pt] || {};
      const tiktokDisabled = !hasTiktok || TIKTOK_INELIGIBLE.has(pt);
      return `
        <tr>
          <td class="text-sm text-mpCharcoal py-2 pr-4 font-medium">${label}</td>
          ${toggleCell(pt, "facebook",  r.facebook  !== false, !hasFb)}
          ${toggleCell(pt, "instagram", r.instagram !== false, !igEnabled)}
          ${toggleCell(pt, "gmb",       r.gmb       !== false, !gmbColumnEnabled)}
          ${toggleCell(pt, "tiktok",    r.tiktok    !== false, tiktokDisabled)}
        </tr>`;
    }).join("");
  }

  // ── Zenoti card body ──────────────────────────────────────────
  const zenotiCardBody = zenoti ? `
    <!-- Connected state -->
    <div class="mb-4 rounded-xl bg-mpBg border border-mpBorder p-3 text-xs space-y-1.5">
      <div class="flex justify-between">
        <span class="text-mpMuted">Center ID</span>
        <span class="font-mono text-mpCharcoal">${zenoti.center_id || "—"}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-mpMuted">API Key</span>
        <span class="font-mono text-mpCharcoal">${zenoti.api_key ? "••••••••" + zenoti.api_key.slice(-4) : "—"}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-mpMuted">Nudges enabled</span>
        <span class="text-mpCharcoal font-semibold">${zenoti.sync_enabled ? "Yes" : "No"}</span>
      </div>
      ${zenoti.last_event_at ? `
      <div class="flex justify-between">
        <span class="text-mpMuted">Last synced</span>
        <span class="text-mpCharcoal">${new Date(zenoti.last_event_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
      </div>` : ""}
    </div>

    <!-- Webhook URL -->
    <div class="mb-4">
      <p class="text-xs text-mpMuted mb-1 font-medium">Webhook URL (paste into Zenoti → Settings → Webhooks)</p>
      <div class="flex items-center gap-2">
        <code class="flex-1 text-[11px] font-mono bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-mpCharcoal overflow-x-auto">${zenotiWebhookUrl}</code>
        <button onclick="navigator.clipboard.writeText('${zenotiWebhookUrl}').then(()=>this.textContent='Copied!')"
          class="text-xs px-3 py-2 rounded-lg border border-mpBorder bg-white hover:bg-mpBg text-mpCharcoal whitespace-nowrap">Copy</button>
      </div>
      <p class="text-[11px] text-mpMuted mt-1">Subscribe to: <strong>appointment.completed</strong> (and optionally employee.created)</p>
    </div>

    <!-- Stylist ID Mapping -->
    <div class="mb-4">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs font-semibold text-mpCharcoal">Stylist → Zenoti Employee ID Mapping</p>
        ${(() => {
          const counts = db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN integration_employee_id IS NOT NULL THEN 1 ELSE 0 END) AS mapped
             FROM stylists WHERE salon_id = ?`
          ).get(salon_id);
          const { total, mapped } = counts || { total: 0, mapped: 0 };
          return mapped > 0
            ? `<span class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">
                <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
                ${mapped} of ${total} matched
               </span>`
            : `<span class="text-[11px] text-mpMuted">${total} stylist${total !== 1 ? 's' : ''}, none matched yet</span>`;
        })()}
      </div>
      <p class="text-xs text-mpMuted mb-3">Enter each stylist's Zenoti employee ID. Matched stylists will have availability posts generated on sync.</p>
      ${(() => {
        const stylists = db.prepare(
          `SELECT id, name, integration_employee_id FROM stylists WHERE salon_id = ? ORDER BY name ASC`
        ).all(salon_id);
        if (!stylists.length) return `<p class="text-xs text-mpMuted italic">No stylists added yet. <a href="/manager/stylists" class="underline text-mpAccent">Add stylists →</a></p>`;
        return `<form method="POST" action="/manager/integrations/zenoti/map-employees" class="space-y-2">
          ${stylists.map(s => {
            const matched = !!s.integration_employee_id;
            return `
            <div class="flex items-center gap-2">
              <div class="w-5 flex-shrink-0 flex items-center justify-center">
                ${matched
                  ? `<svg class="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`
                  : `<div class="w-3 h-3 rounded-full border border-gray-300"></div>`}
              </div>
              <span class="text-xs text-mpCharcoal w-32 font-medium truncate">${s.name}</span>
              <input type="hidden" name="stylist_id[]" value="${s.id}" />
              <input type="text" name="employee_id[]"
                value="${s.integration_employee_id || ""}"
                placeholder="Zenoti employee UUID"
                class="flex-1 text-xs font-mono rounded-lg border ${matched ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'} px-3 py-1.5 text-mpCharcoal placeholder:text-gray-400 focus:outline-none focus:border-mpAccent" />
            </div>`;
          }).join("")}
          <button type="submit" class="mt-2 rounded-full bg-mpCharcoal px-4 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">Save Mappings</button>
        </form>`;
      })()}
    </div>

    <!-- Test + Sync actions -->
    <div class="mb-4 flex flex-wrap gap-2">
      <form method="POST" action="/manager/integrations/zenoti/test">
        <button type="submit"
          class="px-4 py-2 rounded-lg border border-mpBorder text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors">
          Test Connection
        </button>
      </form>
      <form method="POST" action="/manager/integrations/zenoti/sync-staff">
        <button type="submit"
          class="px-4 py-2 rounded-lg border border-mpBorder text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors">
          Sync Staff
        </button>
      </form>
      <form method="POST" action="/manager/integrations/zenoti/sync">
        <button type="submit"
          class="px-4 py-2 rounded-lg bg-mpAccent text-white text-xs font-semibold hover:opacity-90 transition-opacity">
          Sync Availability
        </button>
      </form>
      <a href="/manager/integrations/zenoti"
         class="px-4 py-2 rounded-lg border border-mpBorder text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors inline-flex items-center">
        Update Credentials
      </a>
    </div>

    <!-- Disconnect -->
    <form method="POST" action="/manager/integrations/zenoti/disconnect" onsubmit="return confirm('Disconnect Zenoti integration?')">
      <button class="text-xs text-red-400 hover:text-red-600 underline">Disconnect Zenoti</button>
    </form>
  ` : `
    <!-- Not connected -->
    <p class="text-sm text-mpMuted mb-4">Enterprise salon &amp; spa booking platform. When an appointment completes, MostlyPostly automatically texts your stylist to snap a photo.</p>
    <a href="/manager/integrations/zenoti"
       class="inline-flex items-center rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
      Connect Zenoti
    </a>
  `;

  // ── GMB card body ─────────────────────────────────────────────
  const gmbCardBody = !isGmbPlanAllowed ? `
    <!-- Plan gate -->
    <div class="rounded-xl bg-mpAccentLight border border-mpBorder px-4 py-4 text-sm">
      <p class="font-semibold text-mpCharcoal mb-1">Available on Growth &amp; Pro plans</p>
      <p class="text-mpMuted text-xs mb-3">Upgrade your plan to connect Google Business Profile and automatically publish posts to Google.</p>
      <a href="/manager/billing" class="inline-flex items-center rounded-full bg-mpAccent px-4 py-2 text-xs font-semibold text-white hover:opacity-90 transition-opacity">
        Upgrade Plan
      </a>
    </div>
  ` : gmbConnected ? `
    <!-- Connected state -->
    <div class="mb-4 rounded-xl bg-mpBg border border-mpBorder p-3 text-xs space-y-1.5">
      <div class="flex justify-between">
        <span class="text-mpMuted">Business Name</span>
        <span class="font-medium text-mpCharcoal">${salon.google_business_name || "—"}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-mpMuted">Location ID</span>
        <span class="font-mono text-mpCharcoal">${salon.google_location_id || "—"}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-mpMuted">Auto-publish enabled</span>
        <span class="text-mpCharcoal font-semibold">${salon.gmb_enabled ? "Yes" : "No"}</span>
      </div>
    </div>

    <!-- GMB enabled toggle -->
    <div class="mb-4 flex items-center justify-between">
      <div>
        <p class="text-sm font-medium text-mpCharcoal">Auto-publish to Google</p>
        <p class="text-xs text-mpMuted">When enabled, approved posts will also be published to your Google Business Profile.</p>
      </div>
      <form method="POST" action="/manager/integrations/gmb-toggle" class="ml-4">
        <button type="submit"
          class="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${salon.gmb_enabled ? 'bg-mpAccent' : 'bg-gray-200'}"
          role="switch" aria-checked="${salon.gmb_enabled ? 'true' : 'false'}"
          title="${salon.gmb_enabled ? 'Disable GMB publishing' : 'Enable GMB publishing'}">
          <span class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${salon.gmb_enabled ? 'translate-x-5' : 'translate-x-0'}"></span>
        </button>
      </form>
    </div>

    <!-- Reconnect + Disconnect -->
    <div class="flex flex-wrap gap-2">
      <a href="/auth/google/login?salon=${salon_id}"
         class="px-4 py-2 rounded-lg border border-mpBorder text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors inline-flex items-center">
        Reconnect
      </a>
      <form method="POST" action="/auth/google/disconnect" onsubmit="return confirm('Disconnect Google Business Profile?')">
        <button class="text-xs text-red-400 hover:text-red-600 underline">Disconnect</button>
      </form>
    </div>
  ` : `
    <!-- Not connected -->
    <p class="text-sm text-mpMuted mb-4">Connect your Google Business Profile to automatically publish posts to Google Search and Maps.</p>
    <a href="/auth/google/login?salon=${salon_id}"
       class="inline-flex items-center rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
      Connect Google Business Profile
    </a>
  `;

  const body = `
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-1">Integrations</h1>
      <p class="text-sm text-mpMuted">Connect your social and booking platforms to unlock automatic publishing and richer AI captions.</p>
    </section>

    ${alertHtml}

    <!-- ── Facebook & Instagram ─────────────────────────────── -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4">
      <button id="toggle-btn-fb" type="button" class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div class="flex items-center gap-3">
          ${statusDot(fbConnected)}
          <span class="font-semibold text-mpCharcoal">Facebook &amp; Instagram</span>
        </div>
        <div class="flex items-center gap-3">
          ${statusLabel(fbConnected)}
          ${chevron('fb')}
        </div>
      </button>
      <div id="card-fb" data-open="${fbConnected}" class="border-t border-gray-100 px-6 py-5">
        ${fbConnected ? `
        <div class="mb-4 rounded-xl bg-mpBg border border-mpBorder p-3 text-xs space-y-1.5">
          <div class="flex justify-between">
            <span class="text-mpMuted">Facebook Page ID</span>
            <span class="font-mono text-mpCharcoal">${salon.facebook_page_id || "—"}</span>
          </div>
          ${salon.instagram_handle ? `
          <div class="flex justify-between">
            <span class="text-mpMuted">Instagram Handle</span>
            <span class="text-mpCharcoal">@${salon.instagram_handle}</span>
          </div>` : ""}
          ${salon.instagram_business_id ? `
          <div class="flex justify-between">
            <span class="text-mpMuted">Instagram Business ID</span>
            <span class="font-mono text-mpCharcoal">${salon.instagram_business_id}</span>
          </div>` : ""}
          <div class="flex justify-between">
            <span class="text-mpMuted">Page Token</span>
            <span class="text-green-600 font-medium">Stored &#10003;</span>
          </div>
        </div>
        <div class="flex items-center gap-3 text-xs text-green-600 mb-4">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          <span>Page connected</span>
          ${salon.instagram_handle ? `
          <svg class="w-4 h-4 ml-2" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          <span>Instagram connected</span>` : ""}
        </div>
        <a href="/auth/facebook/login?salon=${salon_id}"
           class="px-4 py-2 rounded-lg border border-mpBorder text-xs font-semibold text-mpCharcoal hover:bg-mpBg transition-colors inline-flex items-center">
          Reconnect / Refresh
        </a>
        ` : `
        <p class="text-sm text-mpMuted mb-4">Connect your Facebook Page and Instagram Business account to enable automatic post publishing.</p>
        <a href="/auth/facebook/login?salon=${salon_id}"
           class="inline-flex items-center rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Connect Facebook &amp; Instagram
        </a>
        `}
      </div>
    </div>

    <!-- ── Google Business Profile ──────────────────────────── -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4">
      <button id="toggle-btn-gmb" type="button" class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div class="flex items-center gap-3">
          ${statusDot(gmbConnected)}
          <span class="font-semibold text-mpCharcoal">Google Business Profile</span>
        </div>
        <div class="flex items-center gap-3">
          ${statusLabel(gmbConnected)}
          ${chevron('gmb')}
        </div>
      </button>
      <div id="card-gmb" data-open="${gmbConnected}" class="border-t border-gray-100 px-6 py-5">
        ${gmbCardBody}
      </div>
    </div>

    <!-- ── Zenoti ───────────────────────────────────────────── -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4">
      <button id="toggle-btn-zenoti" type="button" class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div class="flex items-center gap-3">
          ${statusDot(zenotiConnected)}
          <span class="font-semibold text-mpCharcoal">Zenoti</span>
        </div>
        <div class="flex items-center gap-3">
          ${statusLabel(zenotiConnected)}
          ${chevron('zenoti')}
        </div>
      </button>
      <div id="card-zenoti" data-open="${zenotiConnected}" class="border-t border-gray-100 px-6 py-5">
        ${zenotiCardBody}
      </div>
    </div>

    <!-- TikTok -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4">
      <button id="toggle-btn-tiktok" type="button" class="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div class="flex items-center gap-3">
          ${statusDot(tiktokConnected)}
          <span class="font-semibold text-mpCharcoal">TikTok</span>
        </div>
        <div class="flex items-center gap-3">
          ${statusLabel(tiktokConnected)}
          ${chevron('tiktok')}
        </div>
      </button>
      <div id="card-tiktok" data-open="${tiktokConnected}" class="border-t border-gray-100 px-6 py-5">
        ${tiktokConnected ? `
          <div class="flex items-center justify-between mb-4">
            <div>
              <p class="text-sm font-medium text-mpCharcoal">@${tiktokUsername}</p>
              <p class="text-xs text-mpMuted mt-0.5">Auto-publishing to TikTok alongside Facebook &amp; Instagram</p>
            </div>
            <form method="POST" action="/auth/tiktok/toggle">
              <button type="submit" class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border transition-colors ${tiktokEnabled
                ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'}">
                ${tiktokEnabled ? 'Enabled' : 'Paused'}
              </button>
            </form>
          </div>
          <form method="POST" action="/auth/tiktok/disconnect">
            <button type="submit" class="text-xs text-red-500 hover:text-red-700 underline">Disconnect TikTok</button>
          </form>
        ` : `
          <p class="text-sm text-mpMuted mb-4">Auto-publish to TikTok alongside Facebook &amp; Instagram.</p>
          <a href="/auth/tiktok/login"
             class="inline-flex items-center gap-2 rounded-xl bg-mpCharcoal hover:bg-mpCharcoalDark text-white text-sm font-semibold px-4 py-2 transition-colors">
            <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.96a8.27 8.27 0 004.85 1.56V7.09a4.84 4.84 0 01-1.09-.4z"/>
            </svg>
            Connect TikTok
          </a>
        `}
      </div>
    </div>

    <!-- ── Content Routing ─────────────────────────────────── -->
    <div class="rounded-2xl border border-mpBorder bg-mpCard shadow-sm overflow-hidden mb-4">
      <button type="button"
        id="toggle-btn-routing"
        class="w-full flex justify-between items-center p-6 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div>
          <h2 class="text-base font-semibold text-mpCharcoal">Content Routing</h2>
          <p class="text-sm text-mpMuted mt-0.5">Control which post types publish to each platform.</p>
        </div>
        ${chevron('routing')}
      </button>

      <div id="card-routing" data-open="false" class="border-t border-mpBorder px-6 pb-6">
        <p class="text-xs text-mpMuted pt-4 pb-3">Greyed toggles indicate platforms not yet connected for this salon. Connect the platform above to enable routing.</p>

        <form method="POST" action="/manager/integrations/routing-update">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr>
                  <th class="text-left py-2 pr-4 font-medium text-mpMuted w-40">Post Type</th>
                  <th class="text-center py-2 px-3 font-medium text-mpMuted w-24">Facebook</th>
                  <th class="text-center py-2 px-3 font-medium text-mpMuted w-24">Instagram</th>
                  <th class="text-center py-2 px-3 font-medium text-mpMuted w-24">Google</th>
                  <th class="text-center py-2 px-3 font-medium text-mpMuted w-24">TikTok</th>
                </tr>
              </thead>
              <tbody>
                <tr class="bg-mpAccentLight border border-mpBorder rounded-lg">
                  <td class="py-2 pr-4 pl-2 text-xs font-bold text-mpAccent uppercase tracking-wide rounded-l-lg">Apply All</td>
                  ${["facebook","instagram","gmb","tiktok"].map(plat => {
                    const allOn = Object.values(routing).every(r => (r || {})[plat] !== false);
                    return `
                      <td class="text-center py-2 px-3">
                        <label class="relative inline-flex items-center cursor-pointer" title="Toggle all ${plat}">
                          <input type="checkbox"${allOn ? ' checked' : ''}
                            class="sr-only peer"
                            data-apply-all="${plat}">
                          <div class="w-11 h-6 rounded-full transition-colors peer-checked:bg-mpAccent bg-gray-300 relative
                            after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-5 after:h-5 after:rounded-full after:bg-white after:shadow after:transition-all
                            peer-checked:after:translate-x-5"></div>
                        </label>
                      </td>`;
                  }).join("")}
                </tr>
              </tbody>
              <tbody class="divide-y divide-mpBorder">
                ${buildRoutingRows(routing, fbConnected, gmbConnected, tiktokConnected)}
              </tbody>
            </table>
          </div>
          <div class="mt-4 flex justify-end">
            <button type="submit"
              class="rounded-full bg-mpAccent px-5 py-2 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
              Save Routing
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── Content Placement ────────────────────────────────── -->
    <div class="rounded-2xl border border-mpBorder bg-mpCard shadow-sm overflow-hidden mb-4">
      <button type="button"
        id="toggle-btn-placement"
        class="w-full flex justify-between items-center p-6 text-left hover:bg-mpBg transition-colors cursor-pointer">
        <div>
          <h2 class="text-base font-semibold text-mpCharcoal">Content Placement</h2>
          <p class="text-sm text-mpMuted mt-0.5">Set which format each content type defaults to — Reel, Story, or Post/Grid.</p>
        </div>
        ${chevron('placement')}
      </button>

      <div id="card-placement" data-open="false" class="border-t border-mpBorder px-6 pb-6">
        <p class="text-xs text-mpMuted pt-4 pb-3">These settings control the recommended placement for each content type. Changes apply to future posts. The manager can still override placement on individual posts at approval time.</p>

        <form method="POST" action="/manager/integrations/placement-routing">
          <table class="w-full text-sm mb-4">
            <thead>
              <tr>
                <th class="text-left py-2 pr-4 font-medium text-mpMuted">Content Type</th>
                <th class="text-left py-2 px-4 font-medium text-mpMuted">Placement</th>
                <th class="py-2 px-4 font-medium text-mpMuted text-right"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-mpBorder">
              ${[
                ["standard_post",        "Standard Post"],
                ["before_after",         "Before &amp; After"],
                ["education",            "Education / Tutorial"],
                ["vendor_product",       "Vendor Product"],
                ["vendor_promotion",     "Vendor Promotion"],
                ["reviews",              "Review / Testimonial"],
                ["celebration",          "Celebration"],
                ["stylist_availability", "Stylist Availability"],
              ].map(([ct, label]) => {
                const current = resolvedPlacement[ct] || "post";
                const isCustom = ct in salonPlacementOverrides && VALID_PLACEMENTS.has(salonPlacementOverrides[ct]);
                return `
                  <tr>
                    <td class="py-2 pr-4 font-medium text-mpCharcoal">${label}</td>
                    <td class="py-2 px-4">
                      <select name="placement_${ct}"
                        class="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white">
                        <option value="post"${current === "post" ? " selected" : ""}>Post / Grid</option>
                        <option value="reel"${current === "reel" ? " selected" : ""}>Reel</option>
                        <option value="story"${current === "story" ? " selected" : ""}>Story</option>
                      </select>
                    </td>
                    <td class="py-2 px-4 text-xs text-right">
                      ${isCustom
                        ? `<span class="inline-flex items-center rounded-full bg-mpAccentLight px-2 py-0.5 text-mpAccent font-semibold">Custom</span>`
                        : `<span class="text-mpMuted">System default</span>`
                      }
                    </td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
          <div class="flex items-center justify-between pt-2 border-t border-mpBorder">
            <button type="button" onclick="document.getElementById('placement-reset-form').submit()"
              class="text-sm text-mpMuted hover:text-red-600 transition-colors">
              Reset to system defaults
            </button>
            <button type="submit"
              class="rounded-full bg-mpAccent px-5 py-2 text-sm font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
              Save Placement
            </button>
          </div>
        </form>
        <form id="placement-reset-form" method="POST" action="/manager/integrations/placement-routing/reset" class="hidden"></form>
      </div>
    </div>

    <!-- ── Coming Soon ──────────────────────────────────────── -->
    <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden mb-4 opacity-60">
      <div class="flex items-center justify-between px-6 py-4">
        <div class="flex items-center gap-3">
          <span class="w-2.5 h-2.5 rounded-full inline-block bg-gray-300"></span>
          <span class="font-semibold text-mpCharcoal">Vagaro</span>
        </div>
        <span class="inline-flex items-center rounded-full bg-mpAccentLight px-2 py-0.5 text-[11px] font-semibold text-mpAccent">Coming Soon</span>
      </div>
    </div>

    <div class="grid gap-4 md:grid-cols-2 mb-4">
      ${["Boulevard", "Mindbody"].map(name => `
      <div class="border border-mpBorder rounded-2xl bg-white overflow-hidden opacity-50">
        <div class="flex items-center justify-between px-6 py-4">
          <div class="flex items-center gap-3">
            <span class="w-2.5 h-2.5 rounded-full inline-block bg-gray-300"></span>
            <span class="font-semibold text-mpCharcoal">${name}</span>
          </div>
          <span class="inline-flex items-center rounded-full bg-mpAccentLight px-2 py-0.5 text-[11px] font-semibold text-mpAccent">Coming Soon</span>
        </div>
      </div>`).join("")}
    </div>

    <script>
      document.addEventListener('DOMContentLoaded', function() {
        ['fb', 'gmb', 'zenoti', 'tiktok', 'routing', 'placement'].forEach(function(id) {
          var btn    = document.getElementById('toggle-btn-' + id);
          var card   = document.getElementById('card-' + id);
          var chevron = document.getElementById('chevron-' + id);
          if (!btn || !card) return;

          // Set initial state: open cards get rotated chevron; closed cards hidden
          var isOpen = card.dataset.open === 'true';
          card.style.display = isOpen ? 'block' : 'none';
          if (chevron) chevron.style.transform = isOpen ? 'rotate(180deg)' : '';

          btn.addEventListener('click', function() {
            var open = card.style.display !== 'none';
            card.style.display = open ? 'none' : 'block';
            if (chevron) chevron.style.transform = open ? '' : 'rotate(180deg)';
          });
        });
      });

      // Apply All toggle — sets all col-{platform} checkboxes, then submits form once
      document.addEventListener('change', function(e) {
        var input = e.target;
        if (!input.hasAttribute || !input.hasAttribute('data-apply-all')) return;
        var plat = input.getAttribute('data-apply-all');
        var checked = input.checked;
        document.querySelectorAll('input.col-' + plat).forEach(function(cb) {
          if (cb.checked !== checked) {
            cb.checked = checked;
          }
        });
      });
    </script>
  `;

  res.send(
    pageShell({
      title: "Integrations",
      body,
      salon_id,
      manager_phone,
      manager_id: req.manager?.id,
      current: "integrations",
    })
  );
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/routing-update — save per-salon platform routing
// ─────────────────────────────────────────────────────────────────
router.post("/routing-update", (req, res) => {
  const salon_id = req.manager?.salon_id;

  // Post types and platforms (must match platformRouting.js constants)
  const POST_TYPES = [
    "availability", "before_after", "celebration", "celebration_story",
    "standard_post", "reel", "promotions", "product_education",
  ];
  const PLATFORMS = ["facebook", "instagram", "gmb", "tiktok"];

  // Build routing object from form body
  // Form sends: routing_{postType}_{platform} = "1" (enabled) or "0" (from hidden fallback, disabled)
  const routing = {};
  for (const pt of POST_TYPES) {
    routing[pt] = {};
    for (const plat of PLATFORMS) {
      const key = `routing_${pt}_${plat}`;
      // "1" = checked checkbox value = enabled; "0" = hidden fallback = disabled
      routing[pt][plat] = [].concat(req.body[key] ?? []).includes("1");
    }
  }

  db.prepare(
    `UPDATE salons SET platform_routing = ? WHERE slug = ?`
  ).run(JSON.stringify(routing), salon_id);

  res.redirect("/manager/integrations?routing=saved");
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/placement-routing — save per-salon placement routing
// ─────────────────────────────────────────────────────────────────
router.post("/placement-routing", (req, res) => {
  const salon_id = req.manager?.salon_id;

  const CONTENT_TYPES = [
    "standard_post", "before_after", "education",
    "vendor_product", "vendor_promotion", "reviews",
    "celebration", "stylist_availability",
  ];
  const VALID = ["reel", "story", "post"];

  const routing = {};
  for (const ct of CONTENT_TYPES) {
    const val = req.body[`placement_${ct}`];
    if (VALID.includes(val)) routing[ct] = val;
  }

  db.prepare(
    `UPDATE salons SET placement_routing = ? WHERE slug = ?`
  ).run(JSON.stringify(routing), salon_id);

  res.redirect("/manager/integrations?placement=saved");
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/placement-routing/reset — clear salon placement override
// ─────────────────────────────────────────────────────────────────
router.post("/placement-routing/reset", (req, res) => {
  const salon_id = req.manager?.salon_id;
  db.prepare(`UPDATE salons SET placement_routing = NULL WHERE slug = ?`).run(salon_id);
  res.redirect("/manager/integrations?placement=saved");
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/gmb-toggle — toggle gmb_enabled on/off
// ─────────────────────────────────────────────────────────────────
router.post("/gmb-toggle", (req, res) => {
  const salon_id = req.manager?.salon_id;
  const salon = db.prepare("SELECT gmb_enabled FROM salons WHERE slug = ?").get(salon_id);
  const newVal = salon && salon.gmb_enabled ? 0 : 1;
  db.prepare("UPDATE salons SET gmb_enabled = ? WHERE slug = ?").run(newVal, salon_id);
  res.redirect("/manager/integrations");
});

// ─────────────────────────────────────────────────────────────────
// GET /manager/integrations/zenoti — Zenoti setup / update form
// ─────────────────────────────────────────────────────────────────
router.get("/zenoti", (req, res) => {
  const salon_id      = req.manager?.salon_id;
  const manager_phone = req.manager?.manager_phone;
  const manager_id    = req.manager?.id;

  const existing = db.prepare(
    `SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`
  ).get(salon_id);
  const isUpdate = !!(existing && existing.api_key);
  const saved    = req.query.saved === '1';

  const savedAlert = saved
    ? `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
        Zenoti credentials saved successfully.
       </div>`
    : '';

  const heading = isUpdate ? 'Update Zenoti Credentials' : 'Connect Zenoti';

  const body = `
    <div class="mb-8 flex items-center gap-3">
      <a href="/manager/integrations" class="text-mpMuted hover:text-mpCharcoal transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
      </a>
      <h1 class="text-2xl font-bold text-mpCharcoal">${heading}</h1>
    </div>

    ${savedAlert}

    <div class="max-w-lg">
      <div class="bg-white rounded-2xl border border-mpBorder p-6">
        <p class="text-sm text-mpMuted mb-6">
          Enter your Zenoti API credentials. You can find these in your Zenoti account under
          <strong>Settings &rarr; API Access</strong>. Your application secret is encrypted before storage and never displayed again.
        </p>

        <form method="POST" action="/manager/integrations/zenoti/connect" class="space-y-5">
          <div>
            <label class="block text-sm font-medium text-mpCharcoal mb-1.5">Application ID</label>
            <input
              type="text"
              name="app_id"
              value="${existing?.app_id ? String(existing.app_id).replace(/"/g, '&quot;') : ''}"
              placeholder="e.g. your-app-id"
              required
              class="w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-mpCharcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-transparent"
            />
            <p class="mt-1 text-xs text-mpMuted">Your Zenoti application identifier.</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-mpCharcoal mb-1.5">
              API Key — "Latest Api"
              ${isUpdate ? '<span class="text-mpMuted font-normal">(leave blank to keep existing)</span>' : ''}
            </label>
            <input
              type="password"
              name="app_secret"
              placeholder="${isUpdate ? '••••••••••••••••' : 'Paste the Latest Api value from Zenoti'}"
              ${isUpdate ? '' : 'required'}
              autocomplete="new-password"
              class="w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-mpCharcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-transparent"
            />
            <p class="mt-1 text-xs text-mpMuted">Use the <strong>Latest Api</strong> value (not the Application Secret). Encrypted before storage.</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-mpCharcoal mb-1.5">
              Center ID <span class="text-mpMuted font-normal">(optional)</span>
            </label>
            <input
              type="text"
              name="center_id"
              value="${existing?.center_id ? String(existing.center_id).replace(/"/g, '&quot;') : ''}"
              placeholder="e.g. center-uuid-here"
              class="w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 text-sm text-mpCharcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-mpAccent focus:border-transparent"
            />
            <p class="mt-1 text-xs text-mpMuted">
              Your Zenoti center UUID. You can retrieve this after connecting — the Test Connection
              button will list all available centers for your account.
            </p>
          </div>

          <div class="flex items-center gap-3 pt-2">
            <button type="submit"
              class="px-5 py-2.5 rounded-lg bg-mpAccent text-white text-sm font-semibold hover:opacity-90 transition-opacity">
              ${isUpdate ? 'Update Credentials' : 'Save &amp; Connect'}
            </button>
            <a href="/manager/integrations"
               class="px-5 py-2.5 rounded-lg border border-mpBorder text-sm font-medium text-mpCharcoal hover:bg-mpBg transition-colors">
              Cancel
            </a>
          </div>
        </form>
      </div>
    </div>
  `;

  res.send(pageShell({
    title: 'Zenoti Setup',
    body,
    salon_id,
    manager_phone,
    manager_id,
    current: 'integrations',
  }));
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/connect
// Saves app_id + encrypted secret + center_id
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/connect", (req, res) => {
  const salon_id = req.manager?.salon_id;
  const { app_id, app_secret, api_key, center_id } = req.body;

  // Support legacy plain api_key field from the existing connect form on the main page
  const isLegacyForm = !app_id && !!api_key;

  if (isLegacyForm) {
    // Legacy path — plain api_key from the inline form, no encryption
    if (!api_key) return res.redirect("/manager/integrations?error=missing_key");
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO salon_integrations (id, salon_id, platform, api_key, center_id, sync_enabled, connected_at)
       VALUES (?, ?, 'zenoti', ?, ?, 1, datetime('now'))
       ON CONFLICT(salon_id, platform) DO UPDATE SET
         api_key = excluded.api_key,
         center_id = excluded.center_id,
         sync_enabled = 1,
         connected_at = excluded.connected_at`
    ).run(id, salon_id, api_key.trim(), (center_id || "").trim());
    console.log(`[Integrations] Zenoti connected (legacy) for salon=${salon_id}`);
    return res.redirect("/manager/integrations?connected=zenoti");
  }

  // New path — app_id + encrypted secret
  if (!app_id || !app_id.trim()) {
    return res.redirect('/manager/integrations/zenoti?error=missing_app_id');
  }

  const existing = db.prepare(
    `SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`
  ).get(salon_id);

  let encryptedSecret;
  if (app_secret && app_secret.trim()) {
    try {
      encryptedSecret = encrypt(app_secret.trim());
    } catch (e) {
      console.error('[Integrations] encrypt error:', e.message);
      return res.redirect('/manager/integrations/zenoti?error=encrypt_failed');
    }
  } else if (existing && existing.api_key) {
    encryptedSecret = existing.api_key;
  } else {
    return res.redirect('/manager/integrations/zenoti?error=missing_secret');
  }

  const now = new Date().toISOString();
  const id  = existing ? existing.id : uuidv4();

  db.prepare(`
    INSERT INTO salon_integrations (id, salon_id, platform, api_key, app_id, center_id, sync_enabled, connected_at)
    VALUES (?, ?, 'zenoti', ?, ?, ?, 1, ?)
    ON CONFLICT(salon_id, platform) DO UPDATE SET
      api_key      = excluded.api_key,
      app_id       = excluded.app_id,
      center_id    = excluded.center_id,
      sync_enabled = 1,
      connected_at = excluded.connected_at
  `).run(id, salon_id, encryptedSecret, app_id.trim(), center_id?.trim() || null, now);

  console.log(`[Integrations] Zenoti connected (encrypted) for salon=${salon_id}`);
  res.redirect('/manager/integrations/zenoti?saved=1');
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/test — test API connectivity
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/test", async (req, res) => {
  const salon_id = req.manager?.salon_id;
  const row = db.prepare(
    `SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`
  ).get(salon_id);

  if (!row || !row.api_key) {
    return res.redirect('/manager/integrations?error=not_connected');
  }

  let secret;
  try {
    secret = decrypt(row.api_key);
  } catch {
    // Legacy rows stored plain text before encryption was added — use as-is
    secret = row.api_key;
  }

  try {
    const client = createZenotiClient(row.app_id, secret);
    const result = await client.testConnection();
    const count  = Array.isArray(result.centers) ? result.centers.length : 0;
    res.redirect(`/manager/integrations?tested=ok&centers=${count}`);
  } catch (e) {
    console.error('[Integrations] Zenoti test failed:', e.message);
    res.redirect(`/manager/integrations?tested=fail&error=${encodeURIComponent(e.message || 'Connection failed')}`);
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/sync-staff
// Fetches Zenoti employees, auto-matches to stylists by name.
// Updates integration_employee_id — NO availability posts created.
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/sync-staff", async (req, res) => {
  const salon_id = req.manager?.salon_id;

  try {
    const zenotiInfo = await getZenotiClientForSalon(salon_id);
    if (!zenotiInfo) {
      return res.redirect('/manager/integrations?tested=fail&error=' + encodeURIComponent('No Zenoti credentials or center ID configured'));
    }

    const { client, centerId } = zenotiInfo;
    const employees = await client.getEmployees(centerId);
    console.log(`[Integrations] Staff sync: ${employees.length} Zenoti employees found`);

    const stylists = db.prepare(
      `SELECT id, name, integration_employee_id FROM stylists WHERE salon_id = ? ORDER BY name ASC`
    ).all(salon_id);

    // Build normalized name → stylist lookup
    const normalize = str => (str || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const stylistByName = new Map();
    for (const s of stylists) {
      stylistByName.set(normalize(s.name), s);
    }

    const updateStmt = db.prepare(
      `UPDATE stylists SET integration_employee_id = ? WHERE id = ? AND salon_id = ?`
    );

    let matched = 0;
    let newlyLinked = 0;

    for (const emp of employees) {
      const empNameNorm = normalize(emp.name);
      const stylist = stylistByName.get(empNameNorm);
      if (!stylist) {
        // Try first-name-only match as fallback
        const firstName = empNameNorm.split(' ')[0];
        for (const [sName, s] of stylistByName) {
          if (sName.startsWith(firstName + ' ') || sName === firstName) {
            // Only auto-match on first name if it's unique — skip if ambiguous
            const firstNameMatches = [...stylistByName.keys()].filter(k => k.startsWith(firstName));
            if (firstNameMatches.length === 1) {
              const wasEmpty = !s.integration_employee_id;
              updateStmt.run(emp.id, s.id, salon_id);
              matched++;
              if (wasEmpty) newlyLinked++;
              console.log(`[Integrations] Staff sync: matched "${emp.name}" → "${s.name}" (first-name) employee_id=${emp.id}`);
            }
            break;
          }
        }
        continue;
      }
      const wasEmpty = !stylist.integration_employee_id;
      updateStmt.run(emp.id, stylist.id, salon_id);
      matched++;
      if (wasEmpty) newlyLinked++;
      console.log(`[Integrations] Staff sync: matched "${emp.name}" employee_id=${emp.id}`);
    }

    console.log(`[Integrations] Staff sync complete: ${matched}/${employees.length} matched, ${newlyLinked} newly linked`);
    res.redirect(`/manager/integrations?staff_synced=1&staff_matched=${matched}&staff_total=${employees.length}&staff_new=${newlyLinked}`);
  } catch (e) {
    console.error('[Integrations] Staff sync error:', e.message);
    res.redirect('/manager/integrations?tested=fail&error=' + encodeURIComponent(e.message || 'Staff sync failed'));
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/sync — manual availability sync
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/sync", async (req, res) => {
  const salon_id = req.manager?.salon_id;
  const row = db.prepare(
    `SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`
  ).get(salon_id);

  if (!row || !row.api_key) {
    return res.redirect('/manager/integrations?error=not_connected');
  }

  let secret;
  try {
    secret = decrypt(row.api_key);
  } catch {
    secret = row.api_key; // legacy plain-text fallback
  }

  try {
    const zenotiInfo = await getZenotiClientForSalon(salon_id);
    if (!zenotiInfo) {
      console.warn('[Integrations] Zenoti sync: no center ID configured or found');
      return res.redirect('/manager/integrations?synced=1&found=0');
    }

    const { client, centerId } = zenotiInfo;
    console.log(`[Integrations] Zenoti sync: using center_id=${centerId}`);

    // Update last sync timestamp
    db.prepare(
      `UPDATE salon_integrations SET last_event_at = ? WHERE salon_id = ? AND platform = 'zenoti'`
    ).run(new Date().toISOString(), salon_id);

    // Load salon info for post generation
    const salon = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salon_id);

    // Get mapped stylists (only those with a Zenoti employee ID)
    const mappedStylists = db.prepare(
      `SELECT id, name, instagram_handle, integration_employee_id
       FROM stylists WHERE salon_id = ? AND integration_employee_id IS NOT NULL`
    ).all(salon_id);
    console.log(`[Integrations] Zenoti sync: ${mappedStylists.length} mapped stylist(s)`);

    // Date range: today through next 7 days
    const today = new Date();
    const startDate = today.toISOString().slice(0, 10);
    const endDate = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() + 7);
      return d.toISOString().slice(0, 10);
    })();

    let postsCreated = 0;

    for (const stylist of mappedStylists) {
      console.log(`[Integrations] Processing ${stylist.name} (employee ${stylist.integration_employee_id})`);
      try {
        const slots = await fetchStylistSlots({ client, centerId, stylist, salon, dateRange: { startDate, endDate } });
        if (!slots.length) {
          console.log(`[Integrations] ${stylist.name}: no open blocks found in next 7 days`);
          continue;
        }
        const result = await generateAndSaveAvailabilityPost({ salon, stylist, slots });
        if (result) postsCreated++;
      } catch (e) {
        console.error(`[Integrations] Failed to create post for ${stylist.name}:`, e.message);
      }
    }

    res.redirect(`/manager/integrations?synced=1&found=${postsCreated}`);
  } catch (e) {
    console.error('[Integrations] Zenoti sync error:', e.message);
    res.redirect('/manager/integrations?synced=1&found=0');
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/disconnect
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/disconnect", (req, res) => {
  const salon_id = req.manager?.salon_id;
  db.prepare(`DELETE FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`).run(salon_id);
  console.log(`[Integrations] Zenoti disconnected for salon=${salon_id}`);
  res.redirect("/manager/integrations");
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/map-employees
// Saves Zenoti employee UUIDs onto each stylist row
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/map-employees", (req, res) => {
  const salon_id = req.manager?.salon_id;
  // qs (extended:true) strips [] from field names; querystring keeps them — handle both
  const stylistIds  = [].concat(req.body.stylist_id  || req.body["stylist_id[]"]  || []);
  const employeeIds = [].concat(req.body.employee_id || req.body["employee_id[]"] || []);

  const stmt = db.prepare(
    `UPDATE stylists SET integration_employee_id = ? WHERE id = ? AND salon_id = ?`
  );
  const update = db.transaction(() => {
    for (let i = 0; i < stylistIds.length; i++) {
      stmt.run((employeeIds[i] || "").trim() || null, stylistIds[i], salon_id);
    }
  });
  update();

  res.redirect("/manager/integrations?saved=mappings");
});

export default router;
