// migrations/051_platform_routing.js
// Adds platform_routing column to salons table.
//
// salons:
//   - platform_routing: TEXT (JSON) — per-post-type, per-platform routing rules
//     Shape: { "standard_post": { "facebook": true, "instagram": true, "gmb": true, "tiktok": true }, ... }
//     NULL = use defaults (all platforms enabled for all post types)
//     Partial overrides are merged with DEFAULT_ROUTING at read time.

export function run(db) {
  const salonCols = db.prepare(`PRAGMA table_info(salons)`).all().map(c => c.name);

  if (!salonCols.includes('platform_routing')) {
    db.prepare(`ALTER TABLE salons ADD COLUMN platform_routing TEXT`).run();
  }

  console.log('[Migration 051] platform_routing: added platform_routing TEXT to salons');
}
