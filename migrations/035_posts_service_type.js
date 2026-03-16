// migrations/035_posts_service_type.js
export function run(db) {
  // Check if column already exists (idempotent — production DB may have it from a failed run)
  const cols = db.prepare(`PRAGMA table_info(posts)`).all();
  if (cols.some(c => c.name === "service_type")) {
    console.log("[035] service_type column already exists, skipping");
    return;
  }
  db.prepare(`ALTER TABLE posts ADD COLUMN service_type TEXT`).run();
  console.log("[035] Added service_type to posts");
}
