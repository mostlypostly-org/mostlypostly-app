// migrations/034_stylist_auto_approve.js
export function run(db) {
  db.exec(`ALTER TABLE stylists ADD COLUMN auto_approve INTEGER DEFAULT 0;`);
  console.log("[034] Added auto_approve to stylists");
}
