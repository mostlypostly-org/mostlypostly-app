// src/core/analyticsDb.js — MostlyPostly v1.1 (self-healing, no startup crashes)
import { db } from "../../db.js";
import { webcrypto as _wc } from "crypto";
const crypto = _wc;

// ─────────────────────────────────────────────────────────────
// SAFETY: Create tables BEFORE preparing statements
// Also ensures missing columns (such as salon_id) get added.
// ─────────────────────────────────────────────────────────────

// 1. Create tables if they don't exist
db.exec(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id         TEXT PRIMARY KEY,
  salon_id   TEXT,
  post_id    TEXT,
  event      TEXT NOT NULL,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moderation_flags (
  id          TEXT PRIMARY KEY,
  salon_id    TEXT,
  post_id     TEXT NOT NULL,
  level       TEXT,
  reasons     TEXT,
  status      TEXT DEFAULT 'open',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
`);

// 2. Guarantee missing columns are added (handles old DB files gracefully)
function ensureColumn(table, col, type = "TEXT") {
  try {
    const exists = db
      .prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(col);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type};`);
      console.log(`🛠 Added missing column: ${table}.${col}`);
    }
  } catch (err) {
    console.warn(`⚠️ Failed to ensure column ${table}.${col}:`, err.message);
  }
}

ensureColumn("analytics_events", "salon_id", "TEXT");
ensureColumn("analytics_events", "post_id", "TEXT");
ensureColumn("analytics_events", "event", "TEXT");
ensureColumn("analytics_events", "data", "TEXT");

ensureColumn("moderation_flags", "salon_id", "TEXT");
ensureColumn("moderation_flags", "post_id", "TEXT");
ensureColumn("moderation_flags", "level", "TEXT");
ensureColumn("moderation_flags", "reasons", "TEXT");
ensureColumn("moderation_flags", "status", "TEXT");

// 3. Rebuild indexes
db.exec(`
CREATE INDEX IF NOT EXISTS idx_ae_created ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_post ON analytics_events(post_id);
CREATE INDEX IF NOT EXISTS idx_ae_salon ON analytics_events(salon_id);

CREATE INDEX IF NOT EXISTS idx_mod_post ON moderation_flags(post_id);
CREATE INDEX IF NOT EXISTS idx_mod_salon ON moderation_flags(salon_id);
`);

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function rid() {
  return [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const insertEvent = db.prepare(`
  INSERT INTO analytics_events (id, salon_id, post_id, event, data, created_at)
  VALUES (@id, @salon_id, @post_id, @event, @data, COALESCE(@created_at, datetime('now')))
`);

const insertModeration = db.prepare(`
  INSERT INTO moderation_flags (id, salon_id, post_id, level, reasons, status, created_at)
  VALUES (@id, @salon_id, @post_id, @level, @reasons, COALESCE(@status,'open'), COALESCE(@created_at, datetime('now')))
`);

function resolveSalonId(payload) {
  if (payload?.salon_id) return payload.salon_id;

  if (payload?.post_id) {
    try {
      const row = db.prepare(`SELECT salon_id FROM posts WHERE id=?`).get(payload.post_id);
      return row?.salon_id || null;
    } catch {
      return null;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────

export function logEvent(p = {}) {
  try {
    const salonId = resolveSalonId(p);
    const payload = {
      id: rid(),
      salon_id: salonId,
      post_id: p.post_id ? String(p.post_id) : null,
      event: String(p.event || "unknown"),
      data: typeof p.data === "string" ? p.data : JSON.stringify(p.data || null),
      created_at: p.created_at || null,
    };
    insertEvent.run(payload);
  } catch (err) {
    console.warn("⚠️ [logEvent] Failed:", err.message);
  }
}

export function logModeration(p = {}) {
  if (!p.post_id) return; // post_id required by FK — skip pre-save moderation checks
  try {
    const salonId = resolveSalonId(p);
    const payload = {
      id: rid(),
      salon_id: salonId,
      post_id: String(p.post_id),
      level: p.level || "info",
      reasons: Array.isArray(p.reasons)
        ? JSON.stringify(p.reasons)
        : JSON.stringify([p.reasons].filter(Boolean)),
      status: p.status || "open",
      created_at: p.created_at || null,
    };
    insertModeration.run(payload);
  } catch (err) {
    console.warn("⚠️ [logModeration] Failed:", err.message);
  }
}

export function getEventsBySalon(salon_id, limit = 100) {
  try {
    return db
      .prepare(
        `SELECT * FROM analytics_events
         WHERE salon_id = ?
         ORDER BY datetime(created_at) DESC
         LIMIT ?`
      )
      .all(salon_id, limit);
  } catch (err) {
    console.warn("⚠️ [getEventsBySalon] Failed:", err.message);
    return [];
  }
}
