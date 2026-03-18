// migrations/041_ig_collab.js
export function run(db) {
  const cols = db.prepare(`PRAGMA table_info(stylists)`).all().map(c => c.name);
  if (!cols.includes("ig_collab")) {
    db.prepare(`ALTER TABLE stylists ADD COLUMN ig_collab INTEGER DEFAULT 0`).run();
  }
  console.log("[Migration 041] ig_collab column added to stylists");
}
