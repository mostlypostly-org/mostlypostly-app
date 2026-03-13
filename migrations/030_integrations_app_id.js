// migrations/030_integrations_app_id.js
export function run(db) {
  try {
    db.exec(`ALTER TABLE salon_integrations ADD COLUMN app_id TEXT`);
    console.log("[030] Added app_id column to salon_integrations");
  } catch (e) {
    if (!e.message.includes("duplicate column")) throw e;
  }

  try {
    db.exec(`ALTER TABLE salon_integrations ADD COLUMN settings TEXT`);
    console.log("[030] Added settings column to salon_integrations");
  } catch (e) {
    if (!e.message.includes("duplicate column")) throw e;
  }
}
