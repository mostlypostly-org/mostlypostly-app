import { db } from "../..db.js";
import crypto from "crypto";

export function seedStaging() {
  console.log("🌱 Seeding STAGING database...");

  // ---- SALON ----
  db.prepare(`
    INSERT OR IGNORE INTO salons (
      id, slug, name, city, state, industry,
      timezone, booking_url, tone, default_hashtags,
      require_manager_approval, notify_on_approval, notify_on_denial,
      posting_start_time, posting_end_time, spacing_min, spacing_max,
      status, status_step
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      1, 1, 1,
      '09:00', '19:00', 20, 45,
      'active', 'complete'
    )
  `).run(
    crypto.randomUUID(),
    "studio-500-salon",
    "Studio 500 Salon",
    "Speedway",
    "IN",
    "Hair Salon",
    "America/New_York",
    "https://www.vagaro.com/studio500salon/book-now",
    "Bold & Trendy",
    "#SpeedwaySalon #Studio500Salon"
  );

  // ---- MANAGER (Troy) ----
  db.prepare(`
    INSERT OR IGNORE INTO managers (
      id, salon_id, name, phone, role,
      email, password_hash, compliance_opt_in
    ) VALUES (
      ?, ?, ?, ?, 'manager',
      ?, ?, 1
    )
  `).run(
    crypto.randomUUID(),
    "studio-500-salon",
    "Troy Hardister",
    "+13179385492",
    "troy@studio500salon.com",
    "$2b$10$tJCBCQuMrII2pYEcwxXfjuI2sJg87mGY8WBxR.xgMrkTThvOk/UkS"
  );

  // ---- STYLIST (Nicole) ----
  db.prepare(`
    INSERT OR IGNORE INTO stylists (
      id, salon_id, name, phone, instagram_handle, specialties, compliance_opt_in
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 1
    )
  `).run(
    crypto.randomUUID(),
    "studio-500-salon",
    "Nicole Hardister",
    "3176401450",
    "nicolehardister",
    "haircut, Lived-In Color, Balayage"
  );

  console.log("✅ STAGING seed complete");
}
