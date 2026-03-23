export function run(db) {
  db.prepare(`ALTER TABLE salons ADD COLUMN vendor_monthly_cap INTEGER DEFAULT 8`).run();
  console.log("[055] vendor_monthly_cap column added to salons");
}
