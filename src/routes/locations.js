// src/routes/locations.js
// Multi-location management: list locations, switch active location, add new location.

import express from "express";
import db from "../../db.js";
import { PLAN_LIMITS } from "./billing.js";
import pageShell from "../ui/pageShell.js";

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) {
    return res.redirect("/manager/login");
  }
  next();
}

// ─── GET /manager/locations ────────────────────────────────────────────────────
router.get("/", requireAuth, (req, res) => {
  const { salon_id, group_id } = req.session;

  if (!group_id) {
    return res.redirect("/manager");
  }

  const locations = db
    .prepare("SELECT slug, name, status, plan FROM salons WHERE group_id = ? ORDER BY name")
    .all(group_id);

  const currentSalon = db.prepare("SELECT plan FROM salons WHERE slug = ?").get(salon_id);
  const planKey = currentSalon?.plan || "trial";
  const planLimits = PLAN_LIMITS[planKey] || PLAN_LIMITS.trial;
  const atLimit = locations.length >= planLimits.locations;

  const planNames = { starter: "Starter", growth: "Growth", pro: "Pro", trial: "Trial" };
  const errorMsg = req.query.error === "limit"
    ? `<div class="p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 mb-2">
         Plan limit reached. <a href="/manager/billing" class="font-semibold underline">Upgrade your plan</a> to add more locations.
       </div>`
    : "";

  const locationCards = locations.map(loc => {
    const isActive = loc.slug === salon_id;
    return `
      <div class="flex items-center justify-between p-4 rounded-xl border ${isActive ? "border-mpAccent bg-mpAccentLight" : "border-mpBorder bg-white"}">
        <div>
          <div class="font-semibold text-mpCharcoal">${loc.name}</div>
          <div class="text-xs text-mpMuted mt-0.5">${planNames[loc.plan] || loc.plan} · ${loc.status}</div>
        </div>
        <div class="flex items-center gap-2">
          ${isActive
            ? `<span class="text-xs font-semibold text-mpAccent px-3 py-1 rounded-full bg-white border border-mpAccent">Active</span>`
            : `<form method="POST" action="/manager/locations/switch">
                 <input type="hidden" name="slug" value="${loc.slug}" />
                 <button type="submit"
                   class="text-sm font-medium text-mpCharcoal px-3 py-1.5 rounded-lg border border-mpBorder bg-white hover:bg-mpBg transition-colors">
                   Switch
                 </button>
               </form>`
          }
        </div>
      </div>`;
  }).join("\n");

  const addSection = atLimit
    ? `<p class="text-sm text-mpMuted">
         Your ${planNames[planKey]} plan allows up to <strong>${planLimits.locations}</strong> location${planLimits.locations === 1 ? "" : "s"}.
         <a href="/manager/billing" class="text-mpAccent font-medium hover:underline">Upgrade to add more.</a>
       </p>`
    : `<form method="POST" action="/manager/locations/add">
         <div class="flex gap-3">
           <input type="text" name="name" required placeholder="New location name (e.g. Uptown Studio)"
             class="flex-1 px-4 py-2.5 rounded-xl border border-mpBorder text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent/30" />
           <button type="submit"
             class="px-4 py-2.5 rounded-xl bg-mpCharcoal text-white text-sm font-semibold hover:bg-mpCharcoalDark transition-colors whitespace-nowrap">
             Add Location
           </button>
         </div>
         <p class="text-xs text-mpMuted mt-2">You have ${locations.length} of ${planLimits.locations} location${planLimits.locations === 1 ? "" : "s"} used.</p>
       </form>`;

  const body = `
    <div class="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 class="text-2xl font-bold text-mpCharcoal">Locations</h1>
        <p class="text-sm text-mpMuted mt-1">Switch between locations or add a new one. Each location has its own stylists, schedule, and social accounts.</p>
      </div>

      ${errorMsg}

      <div class="space-y-3">
        ${locationCards}
      </div>

      <div class="border-t border-mpBorder pt-6 space-y-3">
        <h2 class="text-sm font-semibold text-mpCharcoal">Add a New Location</h2>
        ${addSection}
      </div>
    </div>`;

  res.send(pageShell({ title: "Locations", body, current: "locations", salon_id }));
});

// ─── POST /manager/locations/switch ───────────────────────────────────────────
router.post("/switch", requireAuth, (req, res) => {
  const { slug } = req.body;
  const { group_id } = req.session;

  if (!slug || !group_id) return res.redirect("/manager/locations");

  // Verify salon belongs to same group (security check)
  const salon = db
    .prepare("SELECT slug FROM salons WHERE slug = ? AND group_id = ?")
    .get(slug, group_id);

  if (!salon) return res.redirect("/manager/locations");

  req.session.salon_id = slug;
  req.session.save(() => res.redirect("/manager"));
});

// ─── POST /manager/locations/add ──────────────────────────────────────────────
router.post("/add", requireAuth, (req, res) => {
  const { name } = req.body;
  const { group_id, salon_id } = req.session;

  if (!name?.trim() || !group_id) return res.redirect("/manager/locations");

  // Enforce plan limit
  const currentSalon = db.prepare("SELECT plan FROM salons WHERE slug = ?").get(salon_id);
  const planLimits = PLAN_LIMITS[currentSalon?.plan] || PLAN_LIMITS.trial;
  const { cnt } = db
    .prepare("SELECT COUNT(*) as cnt FROM salons WHERE group_id = ?")
    .get(group_id);

  if (cnt >= planLimits.locations) {
    return res.redirect("/manager/locations?error=limit");
  }

  // Generate unique slug
  let baseSlug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = baseSlug;
  let attempt = 2;
  while (db.prepare("SELECT slug FROM salons WHERE slug = ?").get(slug)) {
    slug = `${baseSlug}-${attempt++}`;
  }

  // Create new salon record (minimal — onboarding fills the rest)
  db.prepare(`
    INSERT INTO salons (slug, name, group_id, status, status_step, plan, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'salon', ?, datetime('now'), datetime('now'))
  `).run(slug, name.trim(), group_id, currentSalon?.plan || "trial");

  // Switch to new location and send to onboarding
  req.session.salon_id = slug;
  req.session.save(() => res.redirect("/onboarding/salon"));
});

export default router;
