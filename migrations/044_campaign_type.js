// migrations/044_campaign_type.js
// Adds campaign_type to vendor_campaigns to separate post type (Standard/Promotion/etc.)
// from product category (Color/Treatment/Makeup/etc.).

export function run(db) {
  const cols = db.prepare(`PRAGMA table_info(vendor_campaigns)`).all().map(c => c.name);
  if (!cols.includes("campaign_type")) {
    db.prepare(`ALTER TABLE vendor_campaigns ADD COLUMN campaign_type TEXT DEFAULT 'Standard'`).run();
    console.log("[Migration 044] Added campaign_type to vendor_campaigns");
  } else {
    console.log("[Migration 044] campaign_type already exists, skipping");
  }
}
