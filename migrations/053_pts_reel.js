// migrations/053_pts_reel.js
// Adds the missing pts_reel column to gamification_settings.
// migration 025 created the table but omitted pts_reel even though
// DEFAULT_POINTS in gamification.js includes reel: 20, causing a
// SqliteError on the Performance settings save route.

export function run(db) {
  try {
    db.exec(`ALTER TABLE gamification_settings ADD COLUMN pts_reel INTEGER`);
  } catch { /* column already exists */ }

  console.log("✅ [Migration 053] gamification_settings.pts_reel column added");
}
