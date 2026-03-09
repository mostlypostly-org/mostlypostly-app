// src/db/seedStaging.js
// Seeds a known test account (Studio 500) on staging startup.
// Uses INSERT OR IGNORE + UPDATE so it's safe to run repeatedly —
// the test account is always restored to a clean, fully-configured state.

import { db } from "../../db.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const SALON_SLUG     = "studio-500-salon";
const MANAGER_EMAIL  = "troy@studio500salon.com";
const MANAGER_PASS   = "Test1234!"; // staging only — never used in prod
const SALON_GROUP_ID = "00000000-0000-0000-0000-000000000001"; // fixed UUID for test group

export function seedStaging() {
  console.log("🌱 [Seed] Running staging seed...");

  // ── Salon Group ────────────────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO salon_groups (id, name, created_at)
    VALUES (?, 'Studio 500 Group', datetime('now'))
  `).run(SALON_GROUP_ID);

  // ── Salon ──────────────────────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO salons (
      slug, name, city, state, timezone,
      booking_url, tone, default_hashtags,
      require_manager_approval, posting_start_time, posting_end_time,
      spacing_min, spacing_max, status, status_step,
      plan, plan_status, trial_used, group_id,
      created_at, updated_at
    ) VALUES (
      ?, 'Studio 500 Salon', 'Carmel', 'IN', 'America/Indiana/Indianapolis',
      'https://www.vagaro.com/studio500salon/book-now',
      'Bold and trendy', '["#Studio500Salon","#CarmelIN","#HairGoals"]',
      1, '09:00', '19:00', 20, 45,
      'active', 'complete',
      'pro', 'active', 1, ?,
      datetime('now'), datetime('now')
    )
  `).run(SALON_SLUG, SALON_GROUP_ID);

  // Always force correct plan + status even if record already existed
  db.prepare(`
    UPDATE salons SET
      plan        = 'pro',
      plan_status = 'active',
      trial_used  = 1,
      status      = 'active',
      status_step = 'complete',
      group_id    = ?
    WHERE slug = ?
  `).run(SALON_GROUP_ID, SALON_SLUG);

  // ── Manager (Troy) ─────────────────────────────────────────────────────────
  const passwordHash = bcrypt.hashSync(MANAGER_PASS, 10);

  db.prepare(`
    INSERT OR IGNORE INTO managers (id, salon_id, name, phone, role, email, password_hash)
    VALUES (?, ?, 'Troy Hardister', '+13179385492', 'owner', ?, ?)
  `).run(crypto.randomUUID(), SALON_SLUG, MANAGER_EMAIL, passwordHash);

  // Always ensure email verified, password current, role correct
  db.prepare(`
    UPDATE managers SET
      email_verified     = 1,
      email_verify_token = NULL,
      password_hash      = ?,
      role               = 'owner'
    WHERE salon_id = ? AND email = ?
  `).run(passwordHash, SALON_SLUG, MANAGER_EMAIL);

  // ── Stylist (Nicole) ───────────────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO stylists (id, salon_id, name, phone, instagram_handle, specialties)
    VALUES (?, ?, 'Nicole Hardister', '3176401450', 'nicolehardister',
            '["Lived-In Color","Balayage","Haircut"]')
  `).run(crypto.randomUUID(), SALON_SLUG);

  // ── Vendor approval (Aveda pre-approved) ──────────────────────────────────
  try {
    db.prepare(`
      INSERT OR IGNORE INTO salon_vendor_approvals
        (id, salon_id, vendor_name, status, requested_at, reviewed_at)
      VALUES (?, ?, 'Aveda', 'approved', datetime('now'), datetime('now'))
    `).run(crypto.randomUUID(), SALON_SLUG);
  } catch {
    // Table may not exist yet on older DBs — migration 018 will create it
  }

  console.log(`✅ [Seed] Studio 500 ready`);
  console.log(`   URL:   https://mostlypostly-staging.onrender.com/manager/login`);
  console.log(`   Email: ${MANAGER_EMAIL}`);
  console.log(`   Pass:  ${MANAGER_PASS}`);
  console.log(`   Plan:  Pro / Active`);
}
