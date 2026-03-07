// migrations/012_content_types.js
// Adds content_types_enabled JSON column to salons.
// Stores per-type on/off flags the manager controls via Scheduler page.

export function run(db) {
  try {
    db.exec(`ALTER TABLE salons ADD COLUMN content_types_enabled TEXT`);
    console.log("[012] Added salons.content_types_enabled");
  } catch (err) {
    if (!err.message.includes("duplicate column")) throw err;
  }

  console.log("✅ [Migration 012] content_types_enabled column applied");
}
