// migrations/005_manager_profile.js
// Adds stylist-equivalent profile fields to the managers table so
// managers can also post content through the platform.

import { db } from "../db.js";

export function run() {
  for (const [col, def] of [
    ["instagram_handle",     "TEXT"],
    ["photo_url",            "TEXT"],
    ["specialties",          "TEXT"],
    ["preferred_music_genre","TEXT"],
  ]) {
    const exists = db.prepare(
      `SELECT 1 FROM pragma_table_info('managers') WHERE name = ?`
    ).get(col);
    if (!exists) {
      db.exec(`ALTER TABLE managers ADD COLUMN ${col} ${def};`);
      console.log(`[005] Added managers.${col}`);
    }
  }
}
