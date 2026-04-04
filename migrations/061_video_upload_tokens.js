// migrations/061_video_upload_tokens.js
export function run(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS video_upload_tokens (
      id         TEXT PRIMARY KEY,
      stylist_id TEXT NOT NULL,
      salon_id   TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  console.log("  + video_upload_tokens table");
}
