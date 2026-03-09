// migrations/017_email_verification.js
// Adds email verification fields and marketing opt-in to managers table.

import db from "../db.js";

export function run() {
  const cols = db.prepare("PRAGMA table_info(managers)").all().map(c => c.name);

  if (!cols.includes("email_verified")) {
    db.prepare("ALTER TABLE managers ADD COLUMN email_verified INTEGER DEFAULT 0").run();
  }
  if (!cols.includes("email_verify_token")) {
    db.prepare("ALTER TABLE managers ADD COLUMN email_verify_token TEXT").run();
  }
  if (!cols.includes("email_verify_expires_at")) {
    db.prepare("ALTER TABLE managers ADD COLUMN email_verify_expires_at TEXT").run();
  }
  if (!cols.includes("marketing_opt_in")) {
    db.prepare("ALTER TABLE managers ADD COLUMN marketing_opt_in INTEGER DEFAULT 1").run();
  }
  if (!cols.includes("terms_accepted_at")) {
    db.prepare("ALTER TABLE managers ADD COLUMN terms_accepted_at TEXT").run();
  }

  // Add subscription_ends_at to salons if not present
  const salonCols = db.prepare("PRAGMA table_info(salons)").all().map(c => c.name);
  if (!salonCols.includes("subscription_ends_at")) {
    db.prepare("ALTER TABLE salons ADD COLUMN subscription_ends_at TEXT").run();
  }

  // Back-fill existing managers as already verified (they signed up before this feature)
  db.prepare("UPDATE managers SET email_verified = 1 WHERE email_verified = 0 AND password_hash IS NOT NULL").run();

  console.log("✅ Migration 017: email verification fields added");
}
