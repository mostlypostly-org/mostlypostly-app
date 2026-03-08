// migrations/015_salon_groups.js
// Adds salon_groups table and group_id to salons.
// Enables multi-location support — each location is its own salon record,
// linked to a group. One manager login can access all locations in a group.

import crypto from "crypto";

export function run(db) {
  // Create salon_groups table
  db.exec(`
    CREATE TABLE IF NOT EXISTS salon_groups (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      owner_manager_id TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Add group_id to salons
  try {
    db.exec(`ALTER TABLE salons ADD COLUMN group_id TEXT REFERENCES salon_groups(id)`);
  } catch (err) {
    if (!err.message.includes("duplicate column")) throw err;
  }

  // Backfill: create one group per existing salon that doesn't have one yet
  const salons = db.prepare("SELECT slug, name FROM salons WHERE group_id IS NULL").all();
  const insertGroup = db.prepare("INSERT OR IGNORE INTO salon_groups (id, name, owner_manager_id) VALUES (?,?,?)");
  const linkSalon   = db.prepare("UPDATE salons SET group_id = ? WHERE slug = ?");
  const findMgr     = db.prepare("SELECT id FROM managers WHERE salon_id = ? LIMIT 1");

  for (const salon of salons) {
    const groupId = crypto.randomUUID();
    const mgr = findMgr.get(salon.slug);
    insertGroup.run(groupId, salon.name, mgr?.id || null);
    linkSalon.run(groupId, salon.slug);
  }

  console.log(`✅ [Migration 015] salon_groups created, ${salons.length} group(s) backfilled`);
}
