export function run(db) {
  db.prepare(`ALTER TABLE posts ADD COLUMN manual_caption TEXT`).run();
  console.log("  + posts.manual_caption");
}
