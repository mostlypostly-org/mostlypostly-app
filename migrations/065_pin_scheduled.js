export function run(db) {
  db.prepare(`ALTER TABLE posts ADD COLUMN pin_scheduled INTEGER DEFAULT 0`).run();
  console.log("  + posts.pin_scheduled");
}
