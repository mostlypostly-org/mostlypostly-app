// db.js — unified synchronous database (Better-SQLite3, ESM-safe)
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname } from "path";

// Determine file paths safely in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Decide environment
const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || "local";

// Default DB path if DB_PATH is not explicitly set
let defaultDbPath;

if (APP_ENV === "production") {
  // PRODUCTION → persistent disk on Render
  defaultDbPath = "/data/postly.db";
} else if (APP_ENV === "staging") {
  // STAGING → ephemeral writable filesystem on Render
  defaultDbPath = "/tmp/postly.db";
} else {
  // LOCAL DEV / other envs: keep DB in project root
  defaultDbPath = path.join(process.cwd(), "postly.db");
}

// Final DB path: env wins, then env-based default
const DB_PATH = process.env.DB_PATH || defaultDbPath;
console.log("🗂 Using database at:", DB_PATH);

// Open SQLite connection
export const db = new Database(DB_PATH, {
  timeout: 10000,
  verbose: null,
});

// =====================================================
// 1) Apply schema.sql so base tables exist
// =====================================================
const schemaPath = path.join(__dirname, "schema.sql");
console.log("🔍 Looking for schema.sql at:", schemaPath);

try {
  if (fs.existsSync(schemaPath)) {
    const raw = fs.readFileSync(schemaPath, "utf8");
    db.exec(raw); // apply schema
    console.log("✅ schema.sql applied successfully");
  } else {
    console.error("❌ schema.sql NOT FOUND at:", schemaPath);
  }
} catch (e) {
  console.error("❌ Failed applying schema.sql:", e.message);
}

// =====================================================
// 2) Hotfix migrations – run AFTER schema.sql
//    (safe + idempotent, ignore duplicate-column errors)
// =====================================================

try {
  db.prepare('ALTER TABLE posts ADD COLUMN updated_at TEXT').run();
  console.log("🧱 (db.js) ensured posts.updated_at exists");
} catch (e) {
  console.warn("⚠️ posts.updated_at migration error:", e.message);
}

try {
  db.prepare('ALTER TABLE managers ADD COLUMN password_hash TEXT').run();
  console.log("🧱 (db.js) ensured managers.password_hash exists");
} catch (e) {
  console.warn("⚠️ managers.password_hash migration error:", e.message);
}

// managers.email
try {
  db.prepare('ALTER TABLE managers ADD COLUMN email TEXT').run();
  console.log("🧱 (db.js) ensured managers.email exists");
} catch (e) {
  console.warn("⚠️ managers.email migration error:", e.message);
}

// =====================================================
// Ensure salons.website exists
// =====================================================
try {
  db.prepare("SELECT website FROM salons LIMIT 1").get();
} catch (e) {
  console.log("🧱 (db.js) added salons.website");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN website TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.website:", err.message);
  }
}

// =====================================================
// Ensure salons.business_type exists
// =====================================================
try {
  db.prepare("SELECT business_type FROM salons LIMIT 1").get();
} catch (e) {
  console.log("🧱 (db.js) added salons.business_type");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN business_type TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.business_type:", err.message);
  }
}

// =====================================================
// Ensure salons.status_step exists
// =====================================================
try {
  db.prepare("SELECT status_step FROM salons LIMIT 1").get();
} catch (e) {
  console.log("🧱 (db.js) added salons.status_step");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN status_step TEXT DEFAULT 'salon'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.status_step:", err.message);
  }
}

// Ensure posts.denial_reason exists
try { 
  db.prepare("SELECT denial_reason FROM posts LIMIT 1").get(); 
} catch (e) {
  console.log("🧱 (db.js) added posts.denial_reason");
  try {
    db.prepare("ALTER TABLE posts ADD COLUMN denial_reason TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add posts.denial_reason:", err.message);
  }
}

// =====================================================
// Ensure vision pipeline columns exist on posts
// =====================================================
const visionPostColumns = [
  ["is_vision_generated", "INTEGER DEFAULT 1"],
  ["vision_tags", "TEXT"],
  ["raw_ai_payload", "TEXT"]
];

for (const [col, ddl] of visionPostColumns) {
  try {
    db.prepare(`ALTER TABLE posts ADD COLUMN ${col} ${ddl}`).run();
    console.log(`🧱 (db.js) added posts.${col}`);
  } catch (e) {
    if (!e.message.includes("duplicate column name")) {
      console.warn(`⚠️ posts.${col} migration error:`, e.message);
    }
  }
}

// =====================================================
// Ensure error logging column exists on posts
// =====================================================
try {
  db.prepare(`
    ALTER TABLE posts
    ADD COLUMN error_message TEXT
  `).run();
  console.log("🧱 (db.js) added posts.error_message");
} catch (e) {
  if (!e.message.includes("duplicate column name")) {
    console.warn(
      "⚠️ posts.error_message migration error:",
      e.message
    );
  }
}

// Ensure salons.facebook_page_token exists
try { db.prepare("SELECT facebook_page_token FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.facebook_page_token");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN facebook_page_token TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.facebook_page_token:", err.message);
  }
}

// Ensure salons.instagram_business_id exists
try { db.prepare("SELECT instagram_business_id FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.instagram_business_id");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN instagram_business_id TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.instagram_business_id:", err.message);
  }
}

// =====================================================
// Ensure remaining onboarding columns for salons
// =====================================================
try { db.prepare("SELECT status FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.status");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN status TEXT DEFAULT 'setup_incomplete'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.status:", err.message);
  }
}

try { db.prepare("SELECT booking_link FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.booking_link");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN booking_link TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.booking_link:", err.message);
  }
}

try { db.prepare("SELECT timezone FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.timezone");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN timezone TEXT DEFAULT 'America/Chicago'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.timezone:", err.message);
  }
}

// Ensure timezone has a default even if column existed before migration
try {
  db.prepare(`
    UPDATE salons
    SET timezone = COALESCE(timezone, 'America/Chicago')
  `).run();
  console.log("🧱 (db.js) backfilled salons.timezone where NULL");
} catch (err) {
  console.warn("⚠️ Could not backfill salons.timezone:", err.message);
}

try { db.prepare("SELECT instagram_handle FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.instagram_handle");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN instagram_handle TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.instagram_handle:", err.message);
  }
}

try { db.prepare("SELECT facebook_page_id FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.facebook_page_id");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN facebook_page_id TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.facebook_page_id:", err.message);
  }
}

try { db.prepare("SELECT default_cta FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.default_cta");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN default_cta TEXT DEFAULT 'Book via link in bio.'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.default_cta:", err.message);
  }
}

try { db.prepare("SELECT posting_start_time FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.posting_start_time");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN posting_start_time TEXT DEFAULT '09:00'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.posting_start_time:", err.message);
  }
}

try { db.prepare("SELECT posting_end_time FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.posting_end_time");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN posting_end_time TEXT DEFAULT '19:00'").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.posting_end_time:", err.message);
  }
}

try {
  db.prepare(`
    ALTER TABLE posts
    ADD COLUMN manual_caption TEXT
  `).run();
  console.log("🧱 (db.js) added posts.manual_caption");
} catch (e) {
  if (!e.message.includes("duplicate column name")) {
    console.warn("⚠️ posts.manual_caption migration error:", e.message);
  }
}

// =====================================================
// Ensure AI + workflow columns for posts
// =====================================================
const postColumns = [
  ["ai_caption", "TEXT"],
  ["ai_hashtags", "TEXT"],
  ["ai_cta", "TEXT"],
  ["platform", "TEXT"],
  ["status", "TEXT"]
];

for (const [col, type] of postColumns) {
  try {
    db.prepare(`ALTER TABLE posts ADD COLUMN ${col} ${type}`).run();
    console.log(`🧱 (db.js) added posts.${col}`);
  } catch (e) {
    if (!e.message.includes("duplicate column name")) {
      console.warn(`⚠️ posts.${col} migration error:`, e.message);
    }
  }
}

// =====================================================
// Ensure vision metadata for posts
// =====================================================
try {
  db.prepare(`
    ALTER TABLE posts
    ADD COLUMN is_vision_generated INTEGER DEFAULT 0
  `).run();
  console.log("🧱 (db.js) added posts.is_vision_generated");
} catch (e) {
  if (!e.message.includes("duplicate column name")) {
    console.warn(
      "⚠️ posts.is_vision_generated migration error:",
      e.message
    );
  }
}



try { db.prepare("SELECT auto_approval FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.auto_approval");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN auto_approval INTEGER DEFAULT 0").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.auto_approval:", err.message);
  }
}

try { db.prepare("SELECT spacing_min FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.spacing_min");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN spacing_min INTEGER DEFAULT 20").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.spacing_min:", err.message);
  }
}

try { db.prepare("SELECT spacing_max FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.spacing_max");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN spacing_max INTEGER DEFAULT 45").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.spacing_max:", err.message);
  }
}

// Ensure salons.require_manager_approval exists
try { db.prepare("SELECT require_manager_approval FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.require_manager_approval");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN require_manager_approval INTEGER DEFAULT 0").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.require_manager_approval:", err.message);
  }
}

// Ensure salons.notify_on_approval exists
try { db.prepare("SELECT notify_on_approval FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.notify_on_approval");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN notify_on_approval INTEGER DEFAULT 0").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.notify_on_approval:", err.message);
  }
}

// Ensure salons.notify_on_denial exists
try { db.prepare("SELECT notify_on_denial FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.notify_on_denial");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN notify_on_denial INTEGER DEFAULT 0").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.notify_on_denial:", err.message);
  }
}

try { db.prepare("SELECT manager_display_name FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.manager_display_name");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN manager_display_name TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.manager_display_name:", err.message);
  }
}

try { db.prepare("SELECT manager_title FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.manager_title");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN manager_title TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.manager_title:", err.message);
  }
}

try { db.prepare("SELECT manager_phone FROM salons LIMIT 1").get(); }
catch (e) {
  console.log("🧱 (db.js) added salons.manager_phone");
  try {
    db.prepare("ALTER TABLE salons ADD COLUMN manager_phone TEXT").run();
  } catch (err) {
    console.warn("⚠️ Could not add salons.manager_phone:", err.message);
  }
}

// =====================================================
// 3) Recommended PRAGMAs
// =====================================================
try {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
} catch (e) {
  console.warn("⚠️ Failed to set PRAGMAs:", e.message);
}

// =====================================================
// 4) manager_tokens table — unify legacy + new schema
//    Goal: table has at least columns:
//      id, manager_id, token, salon_id, manager_phone,
//      expires_at, used_at, created_at
// =====================================================
try {
  // Does manager_tokens exist at all?
  const hasManagerTokens = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='manager_tokens'`
    )
    .get();

  if (!hasManagerTokens) {
    // Fresh create with superset schema (covers both old + new code paths)
    db.prepare(`
      CREATE TABLE manager_tokens (
        id            TEXT PRIMARY KEY,
        manager_id    TEXT,
        token         TEXT NOT NULL UNIQUE,
        salon_id      TEXT,
        manager_phone TEXT,
        expires_at    TEXT NOT NULL,
        used_at       TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `).run();
    console.log("🧱 (db.js) created manager_tokens with unified schema");
  } else {
    // Table exists — inspect columns and patch any missing ones
    const cols = db.prepare("PRAGMA table_info(manager_tokens)").all() || [];
    const names = new Set(cols.map((c) => c.name));

    const ensureColumn = (name, ddl) => {
      if (!names.has(name)) {
        try {
          db.prepare(`ALTER TABLE manager_tokens ADD COLUMN ${ddl};`).run();
          console.log(`🧱 (db.js) added manager_tokens.${name}`);
        } catch (err) {
          console.warn(
            `⚠️ (db.js) could not add manager_tokens.${name}:`,
            err.message
          );
        }
      }
    };

    // Ensure all needed columns exist
    ensureColumn("id", "id TEXT");
    ensureColumn("manager_id", "manager_id TEXT");
    ensureColumn("salon_id", "salon_id TEXT");
    ensureColumn("manager_phone", "manager_phone TEXT");
    ensureColumn("used_at", "used_at TEXT");
    ensureColumn(
      "created_at",
      "created_at TEXT NOT NULL DEFAULT (datetime('now'))"
    );

    // Backfill id for any existing rows missing it
    try {
      db.prepare(`
        UPDATE manager_tokens
        SET id = lower(hex(randomblob(16)))
        WHERE id IS NULL OR id = ''
      `).run();
      console.log("🔑 (db.js) backfilled manager_tokens.id where missing");
    } catch (err) {
      console.warn(
        "⚠️ (db.js) failed to backfill manager_tokens.id:",
        err.message
      );
    }

    // Backfill created_at where null
    try {
      db.prepare(`
        UPDATE manager_tokens
        SET created_at = COALESCE(created_at, datetime('now'))
      `).run();
      console.log(
        "⏱️ (db.js) ensured manager_tokens.created_at has default values"
      );
    } catch (err) {
      console.warn(
        "⚠️ (db.js) failed to backfill manager_tokens.created_at:",
        err.message
      );
    }

    // Backfill manager_id from managers table when possible
    try {
      db.prepare(`
        UPDATE manager_tokens
        SET manager_id = (
          SELECT m.id
          FROM managers m
          WHERE m.phone = manager_tokens.manager_phone
          AND (m.salon_id = manager_tokens.salon_id OR manager_tokens.salon_id IS NULL)
          LIMIT 1
        )
        WHERE (manager_id IS NULL OR manager_id = '')
          AND manager_phone IS NOT NULL;
      `).run();
      console.log(
        "🧬 (db.js) linked manager_tokens.manager_id from managers where possible"
      );
    } catch (err) {
      console.warn(
        "⚠️ (db.js) failed to backfill manager_tokens.manager_id:",
        err.message
      );
    }
  }
} catch (e) {
  console.error("⚠️ Failed ensuring manager_tokens schema:", e.message);
}

// =====================================================
// Helper: verify token
// =====================================================
export function verifyTokenRow(token) {
  try {
    const row = db
      .prepare(
        "SELECT token, salon_id, manager_phone, expires_at FROM manager_tokens WHERE token = ?"
      )
      .get(token);
    console.log("🔍 Verified token readback:", row || "❌ Not found");
    return row;
  } catch (err) {
    console.error("❌ Token verification failed:", err.message);
    return null;
  }
}

export default db;
