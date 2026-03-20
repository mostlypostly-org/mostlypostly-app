// migrations/050_tiktok.js
// Adds TikTok integration columns to salons and posts.
//
// salons:
//   - tiktok_account_id:    TEXT — TikTok open_id (unique account identifier)
//   - tiktok_username:      TEXT — Display username shown in integrations UI
//   - tiktok_access_token:  TEXT — Short-lived (24h); refreshed before each publish
//   - tiktok_refresh_token: TEXT — Long-lived (365 days); stored permanently
//   - tiktok_token_expiry:  TEXT — ISO datetime; used to decide if refresh needed
//   - tiktok_enabled:       INTEGER DEFAULT 0 — salon-level toggle (0=paused, 1=active)
//
// posts:
//   - tiktok_post_id: TEXT — set after successful TikTok publish

export function run(db) {
  const salonCols = db.prepare(`PRAGMA table_info(salons)`).all().map(c => c.name);
  const postCols  = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);

  if (!salonCols.includes('tiktok_account_id')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_account_id TEXT`).run();
  }
  if (!salonCols.includes('tiktok_username')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_username TEXT`).run();
  }
  if (!salonCols.includes('tiktok_access_token')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_access_token TEXT`).run();
  }
  if (!salonCols.includes('tiktok_refresh_token')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_refresh_token TEXT`).run();
  }
  if (!salonCols.includes('tiktok_token_expiry')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_token_expiry TEXT`).run();
  }
  if (!salonCols.includes('tiktok_enabled')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN tiktok_enabled INTEGER DEFAULT 0`).run();
  }

  if (!postCols.includes('tiktok_post_id')) {
    db.prepare(`ALTER TABLE posts ADD COLUMN tiktok_post_id TEXT`).run();
  }

  console.log('[Migration 050] tiktok: added tiktok_* columns to salons + tiktok_post_id to posts');
}
