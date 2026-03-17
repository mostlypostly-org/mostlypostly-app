// migrations/036_celebration_template.js
export function run(db) {
  const cols = db.prepare(`PRAGMA table_info(salons)`).all();
  if (cols.some(c => c.name === "celebration_template")) {
    console.log("[036] celebration_template column already exists, skipping");
    return;
  }
  db.prepare(`ALTER TABLE salons ADD COLUMN celebration_template TEXT DEFAULT 'script'`).run();
  console.log("[036] Added celebration_template to salons");
}
