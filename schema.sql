/* ============================================================
   SCHEMA.SQL — FULL DATABASE SCHEMA FOR MOSTLYPOSTLY v1.3+
   ============================================================ */

/* ------------------------------------------------------------
   SALONS — multi-tenant config (now DB-backed)
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS salons (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT UNIQUE NOT NULL,
  name                 TEXT NOT NULL,

  phone                TEXT,
  city                 TEXT,
  state                TEXT,
  industry             TEXT,
  business_type        TEXT,

  status               TEXT DEFAULT 'setup_incomplete',
  status_step          TEXT DEFAULT 'salon',

  website              TEXT,
  booking_link         TEXT,
  booking_url          TEXT,
  timezone             TEXT DEFAULT 'America/Chicago',

  instagram_handle     TEXT,
  instagram_business_id TEXT,
  facebook_page_id     TEXT,
  facebook_page_token  TEXT,
  default_cta          TEXT DEFAULT 'Book via link in bio.',

  posting_start_time   TEXT DEFAULT '09:00',
  posting_end_time     TEXT DEFAULT '19:00',

  auto_approval        INTEGER DEFAULT 0,
  auto_publish         INTEGER DEFAULT 0,

  spacing_min          INTEGER DEFAULT 20,
  spacing_max          INTEGER DEFAULT 45,

  require_manager_approval INTEGER DEFAULT 0,
  notify_on_approval       INTEGER DEFAULT 0,
  notify_on_denial         INTEGER DEFAULT 0,

  manager_display_name TEXT,
  manager_title        TEXT,
  manager_phone        TEXT,

  default_hashtags     TEXT,
  tone                 TEXT,

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

/* ------------------------------------------------------------
   MICROSOFT TEAMS
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS channel_identities (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,            -- 'teams' (later: 'slack', etc.)
  tenant_id       TEXT,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  salon_id        TEXT,
  stylist_id      TEXT,
  manager_id      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (salon_id) REFERENCES salons(slug),
  FOREIGN KEY (stylist_id) REFERENCES stylists(id),
  FOREIGN KEY (manager_id) REFERENCES managers(id),
  UNIQUE (provider, tenant_id, user_id)
);


/* ------------------------------------------------------------
   MANAGERS — login + ownership
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS managers (
  id             TEXT PRIMARY KEY,
  salon_id       TEXT NOT NULL,
  name           TEXT,
  phone          TEXT UNIQUE,
  chat_id        TEXT,
  role           TEXT DEFAULT 'manager',
  pin            TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  password_hash  TEXT,
  email          TEXT UNIQUE,
  compliance_opt_in      INTEGER DEFAULT 0,
  compliance_timestamp   TEXT,
  consent               TEXT,
  FOREIGN KEY (salon_id) REFERENCES salons(slug)

);

/* ------------------------------------------------------------
   MANAGER TOKENS — magic login links + approval tokens
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS manager_tokens (
  id             TEXT PRIMARY KEY,
  manager_id     TEXT,
  token          TEXT,
  expires_at     TEXT,
  used_at        TEXT,
  salon_id       TEXT,
  manager_phone  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (manager_id) REFERENCES managers(id)
);

/* ------------------------------------------------------------
   User Login TOKENS — magic login links for password reset
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);


/* ------------------------------------------------------------
   STYLISTS — optional, but supported
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS stylists (
  id                 TEXT PRIMARY KEY,
  salon_id           TEXT NOT NULL,
  name               TEXT,
  phone              TEXT,
  instagram_handle   TEXT,
  specialties        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  chat_id                TEXT,
  compliance_opt_in      INTEGER DEFAULT 0,
  compliance_timestamp   TEXT,
  consent                TEXT,
  FOREIGN KEY (salon_id) REFERENCES salons(slug)
);

/* ------------------------------------------------------------
   POSTS — full schema
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS posts (
  id                 TEXT PRIMARY KEY,
  salon_id           TEXT NOT NULL,
  stylist_id         TEXT,
  manager_id         TEXT,

  stylist_name       TEXT,
  stylist_phone      TEXT,
  instagram_handle   TEXT,
  manager_phone      TEXT,
  manager_chat_id    TEXT,

  image_url          TEXT,
  image_mime         TEXT,
  rehosted_image_url TEXT,

  -- captions
  caption            TEXT,          -- legacy fallback
  base_caption       TEXT,
  final_caption      TEXT,
  manual_caption     TEXT,
  hashtags           TEXT,
  ai_hashtags        TEXT,
  service_type       TEXT,
  cta                TEXT,
  booking_url        TEXT,
  original_notes     TEXT,

  -- AI pipeline
  is_vision_generated INTEGER DEFAULT 1,
  vision_tags         TEXT,
  raw_ai_payload      TEXT,
  _meta               TEXT,

  -- workflow
  status             TEXT,          -- draft | manager_pending | manager_approved | published | failed | cancelled
  platform           TEXT,
  platform_targets   TEXT,
  scheduled_for      TEXT,
  published_at       TEXT,
  approved_by        TEXT,
  approved_at        TEXT,

  -- publish results
  fb_post_id         TEXT,
  fb_response_id     TEXT,
  ig_container_id    TEXT,
  ig_media_id        TEXT,

  -- error tracking
  error_message      TEXT,
  denial_reason      TEXT,
  denied_reason      TEXT,          -- legacy alias
  retry_count        INTEGER DEFAULT 0,
  retry_log          TEXT,

  salon_post_number  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT,

  FOREIGN KEY (salon_id) REFERENCES salons(slug),
  FOREIGN KEY (stylist_id) REFERENCES stylists(id),
  FOREIGN KEY (manager_id) REFERENCES managers(id)
);

/* ------------------------------------------------------------
   MODERATION — AI and manual safety checks
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS moderation_flags (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL,
  status     TEXT DEFAULT 'clean',
  level      TEXT,
  reasons    TEXT,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id)
);

/* ------------------------------------------------------------
   ANALYTICS — lightweight event tracking
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS analytics (
  id           TEXT PRIMARY KEY,
  salon_id     TEXT NOT NULL,
  event_type   TEXT,
  post_id      TEXT,
  stylist_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (salon_id) REFERENCES salons(slug)
);
