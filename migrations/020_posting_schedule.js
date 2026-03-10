// migrations/020_posting_schedule.js
// Add posting_schedule JSON column to salons for per-day posting availability windows

export function run(db) {
  try {
    db.exec(`ALTER TABLE salons ADD COLUMN posting_schedule TEXT`);
    console.log("[020] Added salons.posting_schedule");
  } catch (e) {
    if (!e.message.includes("duplicate column")) throw e;
  }
}
