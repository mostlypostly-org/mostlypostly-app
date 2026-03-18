// Migration 042 — add active column to stylists and managers
// active = 1 (default): active, can post/login
// active = 0: deactivated (plan downgrade exceeded seat limit, or manual)
// All existing rows get active = 1 (backward-compatible default)

export function run(db) {
  const stylistCols = db.prepare(`PRAGMA table_info(stylists)`).all().map(c => c.name);
  if (!stylistCols.includes("active")) {
    db.prepare(`ALTER TABLE stylists ADD COLUMN active INTEGER DEFAULT 1`).run();
    console.log("[Migration 042] active column added to stylists");
  }

  const managerCols = db.prepare(`PRAGMA table_info(managers)`).all().map(c => c.name);
  if (!managerCols.includes("active")) {
    db.prepare(`ALTER TABLE managers ADD COLUMN active INTEGER DEFAULT 1`).run();
    console.log("[Migration 042] active column added to managers");
  }
}
