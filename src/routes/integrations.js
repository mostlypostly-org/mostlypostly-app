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

const router = express.Router();

// ─────────────────────────────────────────────────────────────────
// Auth guard (same pattern used across all manager routes)
// ─────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.manager) return res.redirect("/manager/login");
  next();
}

// ─────────────────────────────────────────────────────────────────
// GET /manager/integrations — admin UI card
// ─────────────────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
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
  const vagaro = byPlatform["vagaro"] || null;

  // Webhook URL that Zenoti should POST to
  const BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
  const zenotiWebhookUrl = `${BASE_URL}/integrations/webhook/zenoti/${salon_id}`;

  // Alert banners for test/sync results
  const testedOk   = req.query.tested === 'ok';
  const testedFail = req.query.tested === 'fail';
  const testError  = req.query.error ? decodeURIComponent(req.query.error) : '';
  const centersCount = req.query.centers ? parseInt(req.query.centers, 10) : 0;
  const synced     = req.query.synced === '1';
  const syncFound  = req.query.found  ? parseInt(req.query.found, 10) : 0;

  let alertHtml = '';
  if (testedOk) {
    alertHtml = `<div class="mb-6 rounded-xl bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700 font-medium">
      Connection successful — found ${centersCount} center${centersCount !== 1 ? 's' : ''}.
    </div>`;
  } else if (testedFail) {
    alertHtml = `<div class="mb-6 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 font-medium">
      Connection test failed: ${testError || 'Unknown error'}
    </div>`;
  } else if (synced) {
    alertHtml = `<div class="mb-6 rounded-xl bg-mpAccentLight border border-mpBorder px-4 py-3 text-sm text-mpAccent font-medium">
      Sync complete — found ${syncFound} employee${syncFound !== 1 ? 's' : ''} with open availability.
    </div>`;
  }

  const body = `
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-1">Integrations</h1>
      <p class="text-sm text-mpMuted">Connect your salon booking software to unlock automatic content nudges, richer AI captions, and utilization-aware posting.</p>
    </section>

    ${alertHtml}

    <!-- ZENOTI -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5">
        <div class="flex items-start justify-between mb-4">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <h2 class="text-sm font-semibold text-mpCharcoal">Zenoti</h2>
              ${zenoti
                ? `<span class="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">● Connected</span>`
                : `<span class="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-mpMuted">Not connected</span>`}
            </div>
            <p class="text-xs text-mpMuted">Enterprise salon & spa booking platform. When an appointment completes, MostlyPostly automatically texts your stylist to snap a photo.</p>
          </div>
        </div>

        ${zenoti ? `
        <!-- Connected state — show info + actions only, no inline connect form -->
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
            <span class="text-mpMuted">Last event</span>
            <span class="text-mpCharcoal">${zenoti.last_event_at}</span>
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
          <p class="text-xs font-semibold text-mpCharcoal mb-2">Stylist → Zenoti Employee ID Mapping</p>
          <p class="text-xs text-mpMuted mb-2">Enter each stylist's Zenoti employee ID so MostlyPostly can match webhook events to the right stylist.</p>
          ${(() => {
            const stylists = db.prepare(
              `SELECT id, name, integration_employee_id FROM stylists WHERE salon_id = ? ORDER BY name ASC`
            ).all(salon_id);
            if (!stylists.length) return `<p class="text-xs text-mpMuted italic">No stylists added yet. <a href="/manager/stylists" class="underline text-mpAccent">Add stylists →</a></p>`;
            return `<form method="POST" action="/manager/integrations/zenoti/map-employees" class="space-y-2">
              ${stylists.map(s => `
                <div class="flex items-center gap-3">
                  <span class="text-xs text-mpCharcoal w-36 font-medium truncate">${s.name}</span>
                  <input type="hidden" name="stylist_id[]" value="${s.id}" />
                  <input type="text" name="employee_id[]"
                    value="${s.integration_employee_id || ""}"
                    placeholder="Zenoti employee UUID"
                    class="flex-1 text-xs font-mono rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-mpCharcoal placeholder:text-gray-400 focus:outline-none focus:border-mpAccent" />
                </div>`).join("")}
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
          <form method="POST" action="/manager/integrations/zenoti/sync">
            <button type="submit"
              class="px-4 py-2 rounded-lg bg-mpAccent text-white text-xs font-semibold hover:opacity-90 transition-opacity">
              Sync Now
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
        <!-- Not connected — link to setup form -->
        <a href="/manager/integrations/zenoti"
           class="inline-flex items-center rounded-full bg-mpCharcoal px-5 py-2 text-xs font-semibold text-white hover:bg-mpCharcoalDark transition-colors">
          Connect Zenoti
        </a>
        `}
      </div>
    </section>

    <!-- VAGARO — Coming Soon -->
    <section class="mb-6">
      <div class="rounded-2xl border border-mpBorder bg-white px-5 py-5 opacity-75">
        <div class="flex items-start justify-between mb-2">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <h2 class="text-sm font-semibold text-mpCharcoal">Vagaro</h2>
              <span class="inline-flex items-center rounded-full bg-mpAccentLight px-2 py-0.5 text-[11px] font-semibold text-mpAccent">Coming Soon</span>
            </div>
            <p class="text-xs text-mpMuted">Independent salon booking platform. Appointment-completed nudges, stylist sync, and utilization data — same workflow as Zenoti.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Boulevard & Mindbody — Coming Soon -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      ${["Boulevard", "Mindbody"].map(name => `
      <div class="rounded-2xl border border-mpBorder bg-white px-4 py-4 opacity-60">
        <div class="flex items-center gap-2 mb-1">
          <h2 class="text-sm font-semibold text-mpCharcoal">${name}</h2>
          <span class="inline-flex items-center rounded-full bg-mpAccentLight px-2 py-0.5 text-[11px] font-semibold text-mpAccent">Coming Soon</span>
        </div>
        <p class="text-xs text-mpMuted">Booking system integration — photo nudges and utilization awareness on the roadmap.</p>
      </div>`).join("")}
    </section>
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
// GET /manager/integrations/zenoti — Zenoti setup / update form
// ─────────────────────────────────────────────────────────────────
router.get("/zenoti", requireAuth, (req, res) => {
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
router.post("/zenoti/connect", requireAuth, (req, res) => {
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
router.post("/zenoti/test", requireAuth, async (req, res) => {
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
// POST /manager/integrations/zenoti/sync — manual availability sync
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/sync", requireAuth, async (req, res) => {
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
    const client = createZenotiClient(row.app_id, secret);

    // Resolve center ID
    let centerId = row.center_id;
    if (!centerId) {
      const centers = await client.getCenters();
      centerId = centers[0]?.id || null;
    }

    if (!centerId) {
      console.warn('[Integrations] Zenoti sync: no center ID configured or found');
      return res.redirect('/manager/integrations?synced=1&found=0');
    }

    // Update last_event_at
    db.prepare(
      `UPDATE salon_integrations SET last_event_at = ? WHERE salon_id = ? AND platform = 'zenoti'`
    ).run(new Date().toISOString(), salon_id);

    const employees = await client.getEmployees(centerId);
    console.log(`[Integrations] Zenoti sync: found ${employees.length} employees for center ${centerId}`);

    // Next 7 days as YYYY-MM-DD strings
    const today = new Date();
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    let employeesWithSlots = 0;

    for (const emp of employees) {
      let hasSlots = false;
      for (const dateStr of dates) {
        try {
          const slots = await client.getAvailableSlots(centerId, emp.id, dateStr);
          if (slots.length > 0) {
            hasSlots = true;
            console.log(`[Integrations] ${emp.name} has ${slots.length} slot(s) on ${dateStr}`);
          }
        } catch (e) {
          console.warn(`[Integrations] getAvailableSlots failed for ${emp.name} on ${dateStr}:`, e.message);
        }
      }

      if (hasSlots) {
        employeesWithSlots++;
        try {
          const stylist = db.prepare(
            `SELECT id, name FROM stylists WHERE salon_id = ? AND integration_employee_id = ? LIMIT 1`
          ).get(salon_id, emp.id);
          if (stylist) {
            console.log(`[Integrations] Matched employee ${emp.name} → stylist: ${stylist.name}`);
          } else {
            console.log(`[Integrations] No stylist match for employee ${emp.name} (id=${emp.id})`);
          }
        } catch (e) {
          console.warn('[Integrations] stylist lookup skipped:', e.message);
        }
      }
    }

    res.redirect(`/manager/integrations?synced=1&found=${employeesWithSlots}`);
  } catch (e) {
    console.error('[Integrations] Zenoti sync error:', e.message);
    res.redirect('/manager/integrations?synced=1&found=0');
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/disconnect
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/disconnect", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id;
  db.prepare(`DELETE FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`).run(salon_id);
  console.log(`[Integrations] Zenoti disconnected for salon=${salon_id}`);
  res.redirect("/manager/integrations");
});

// ─────────────────────────────────────────────────────────────────
// POST /manager/integrations/zenoti/map-employees
// Saves Zenoti employee UUIDs onto each stylist row
// ─────────────────────────────────────────────────────────────────
router.post("/zenoti/map-employees", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id;
  const stylistIds = [].concat(req.body["stylist_id[]"] || []);
  const employeeIds = [].concat(req.body["employee_id[]"] || []);

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

// ─────────────────────────────────────────────────────────────────
// POST /integrations/webhook/zenoti/:salon_id
// Public webhook endpoint — Zenoti calls this when events fire.
// No session auth — uses webhook secret for verification.
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

export default router;
