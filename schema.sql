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

  status               TEXT DEFAULT 'setup_incomplete',
  status_step          TEXT DEFAULT 'salon',

  website              TEXT,
  booking_link         TEXT,
  timezone             TEXT DEFAULT 'America/Chicago',

  instagram_handle     TEXT,
  facebook_page_id     TEXT,
  default_cta          TEXT DEFAULT 'Book via link in bio.',

  posting_start_time   TEXT DEFAULT '09:00',
  posting_end_time     TEXT DEFAULT '19:00',

  auto_approval        INTEGER DEFAULT 0,

  spacing_min          INTEGER DEFAULT 20,
  spacing_max          INTEGER DEFAULT 45,

  -- NEW MANAGER RULES FIELDS
  require_manager_approval INTEGER DEFAULT 0,
  notify_on_approval       INTEGER DEFAULT 0,
  notify_on_denial         INTEGER DEFAULT 0,

  manager_display_name TEXT,
  manager_title        TEXT,
  manager_phone        TEXT,

  default_hashtags     TEXT,
  tone                 TEXT,
  auto_publish         INTEGER DEFAULT 0,
  booking_url          TEXT,

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
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
  FOREIGN KEY (salon_id) REFERENCES salons(slug)
);

/* ------------------------------------------------------------
   POSTS — new v1.3+ schema (MATCHES storage.js EXACTLY)
   ------------------------------------------------------------ */
CREATE TABLE IF NOT EXISTS posts (
  id                 TEXT PRIMARY KEY,
  salon_id           TEXT NOT NULL,
  stylist_id         TEXT,                        -- NEW
  manager_id         TEXT,                        -- NEW

  stylist_name       TEXT,
  stylist_phone      TEXT,

  image_url          TEXT,

  -- AI captioning pipeline
  base_caption       TEXT,                        -- NEW (raw AI caption)
  final_caption      TEXT,                        -- NEW (after stylist edits)
  manual_caption     TEXT,                        -- NEW (if manually overridden)
  hashtags           TEXT,
  ai_hashtags        TEXT,                        -- NEW
  service_type       TEXT,
  cta                TEXT,

  is_vision_generated INTEGER DEFAULT 1,          -- NEW
  vision_tags         TEXT,                       -- NEW
  raw_ai_payload      TEXT,                       -- NEW (JSON from OpenAI)

  status             TEXT,                        -- draft | manager_pending | scheduled | published | failed
  platform           TEXT,                        -- facebook | instagram | both
  scheduled_for      TEXT,
  published_at       TEXT,

  error_message      TEXT,                        -- NEW failure logging

  salon_post_number  INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),

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
