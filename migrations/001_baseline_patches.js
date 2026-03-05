// migrations/001_baseline_patches.js
// Consolidates every ALTER TABLE patch that was previously scattered across
// db.js, dbMigrations.js, and initSchemaHealth.js.
// Safe to run on any DB state — addColumn() checks PRAGMA before altering.

function addColumn(db, table, col, ddl) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (exists) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`).run();
  console.log(`  + ${table}.${col}`);
}

export function run(db) {
  // ------------------------------------------------------------------
  // salons
  // ------------------------------------------------------------------
  addColumn(db, "salons", "facebook_page_token",      "TEXT");
  addColumn(db, "salons", "instagram_business_id",    "TEXT");
  addColumn(db, "salons", "instagram_handle",         "TEXT");
  addColumn(db, "salons", "facebook_page_id",         "TEXT");
  addColumn(db, "salons", "business_type",            "TEXT");
  addColumn(db, "salons", "website",                  "TEXT");
  addColumn(db, "salons", "booking_link",             "TEXT");
  addColumn(db, "salons", "booking_url",              "TEXT");
  addColumn(db, "salons", "status",                   "TEXT DEFAULT 'setup_incomplete'");
  addColumn(db, "salons", "status_step",              "TEXT DEFAULT 'salon'");
  addColumn(db, "salons", "state",                    "TEXT");
  addColumn(db, "salons", "industry",                 "TEXT");
  addColumn(db, "salons", "timezone",                 "TEXT DEFAULT 'America/Chicago'");
  addColumn(db, "salons", "auto_approval",            "INTEGER DEFAULT 0");
  addColumn(db, "salons", "auto_publish",             "INTEGER DEFAULT 0");
  addColumn(db, "salons", "spacing_min",              "INTEGER DEFAULT 20");
  addColumn(db, "salons", "spacing_max",              "INTEGER DEFAULT 45");
  addColumn(db, "salons", "require_manager_approval", "INTEGER DEFAULT 0");
  addColumn(db, "salons", "notify_on_approval",       "INTEGER DEFAULT 0");
  addColumn(db, "salons", "notify_on_denial",         "INTEGER DEFAULT 0");
  addColumn(db, "salons", "manager_display_name",     "TEXT");
  addColumn(db, "salons", "manager_title",            "TEXT");
  addColumn(db, "salons", "manager_phone",            "TEXT");
  addColumn(db, "salons", "default_hashtags",         "TEXT");
  addColumn(db, "salons", "default_cta",              "TEXT DEFAULT 'Book via link in bio.'");
  addColumn(db, "salons", "tone",                     "TEXT");
  addColumn(db, "salons", "posting_start_time",       "TEXT DEFAULT '09:00'");
  addColumn(db, "salons", "posting_end_time",         "TEXT DEFAULT '19:00'");

  // Backfill timezone NULL rows
  db.prepare(`UPDATE salons SET timezone = COALESCE(timezone, 'America/Chicago') WHERE timezone IS NULL`).run();

  // ------------------------------------------------------------------
  // posts
  // ------------------------------------------------------------------
  addColumn(db, "posts", "updated_at",           "TEXT");
  addColumn(db, "posts", "caption",              "TEXT");   // legacy fallback column
  addColumn(db, "posts", "original_notes",       "TEXT");
  addColumn(db, "posts", "image_mime",           "TEXT");
  addColumn(db, "posts", "rehosted_image_url",   "TEXT");
  addColumn(db, "posts", "instagram_handle",     "TEXT");
  addColumn(db, "posts", "manager_phone",        "TEXT");
  addColumn(db, "posts", "manager_chat_id",      "TEXT");
  addColumn(db, "posts", "booking_url",          "TEXT");
  addColumn(db, "posts", "denied_reason",        "TEXT");   // note: schema.sql also has denial_reason
  addColumn(db, "posts", "denial_reason",        "TEXT");
  addColumn(db, "posts", "platform_targets",     "TEXT");
  addColumn(db, "posts", "fb_post_id",           "TEXT");
  addColumn(db, "posts", "fb_response_id",       "TEXT");
  addColumn(db, "posts", "ig_container_id",      "TEXT");
  addColumn(db, "posts", "ig_media_id",          "TEXT");
  addColumn(db, "posts", "retry_count",          "INTEGER DEFAULT 0");
  addColumn(db, "posts", "retry_log",            "TEXT");
  addColumn(db, "posts", "approved_by",          "TEXT");
  addColumn(db, "posts", "approved_at",          "TEXT");
  addColumn(db, "posts", "is_vision_generated",  "INTEGER DEFAULT 1");
  addColumn(db, "posts", "vision_tags",          "TEXT");
  addColumn(db, "posts", "raw_ai_payload",       "TEXT");
  addColumn(db, "posts", "_meta",                "TEXT");

  // ------------------------------------------------------------------
  // managers
  // ------------------------------------------------------------------
  addColumn(db, "managers", "chat_id",               "TEXT");
  addColumn(db, "managers", "password_hash",         "TEXT");
  addColumn(db, "managers", "email",                 "TEXT");   // UNIQUE not addable via ALTER TABLE
  addColumn(db, "managers", "compliance_opt_in",     "INTEGER DEFAULT 0");
  addColumn(db, "managers", "compliance_timestamp",  "TEXT");
  addColumn(db, "managers", "consent",               "TEXT");

  // ------------------------------------------------------------------
  // stylists
  // ------------------------------------------------------------------
  addColumn(db, "stylists", "chat_id",               "TEXT");
  addColumn(db, "stylists", "specialties",           "TEXT");
  addColumn(db, "stylists", "compliance_opt_in",     "INTEGER DEFAULT 0");
  addColumn(db, "stylists", "compliance_timestamp",  "TEXT");
  addColumn(db, "stylists", "consent",               "TEXT");

  // ------------------------------------------------------------------
  // moderation_flags
  // ------------------------------------------------------------------
  addColumn(db, "moderation_flags", "status", "TEXT DEFAULT 'clean'");

  // ------------------------------------------------------------------
  // manager_tokens — ensure all columns exist on pre-schema.sql DBs
  // ------------------------------------------------------------------
  addColumn(db, "manager_tokens", "id",            "TEXT");
  addColumn(db, "manager_tokens", "manager_id",    "TEXT");
  addColumn(db, "manager_tokens", "salon_id",      "TEXT");
  addColumn(db, "manager_tokens", "manager_phone", "TEXT");
  addColumn(db, "manager_tokens", "used_at",       "TEXT");
  addColumn(db, "manager_tokens", "created_at",    "TEXT");

  // Backfill manager_tokens.id where missing
  db.prepare(`
    UPDATE manager_tokens
    SET id = lower(hex(randomblob(16)))
    WHERE id IS NULL OR id = ''
  `).run();
}
