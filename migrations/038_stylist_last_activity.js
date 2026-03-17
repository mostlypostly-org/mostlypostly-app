export function run(db) {
  const cols = db.prepare(`PRAGMA table_info(stylists)`).all();
  if (cols.some(c => c.name === "last_activity_at")) return;
  db.prepare(`ALTER TABLE stylists ADD COLUMN last_activity_at TEXT`).run();
}
