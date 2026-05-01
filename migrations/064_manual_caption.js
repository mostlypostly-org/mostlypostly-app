export function run(db) {
  const cols = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name);
  if (!cols.includes("manual_caption")) {
    db.prepare(`ALTER TABLE posts ADD COLUMN manual_caption TEXT`).run();
    console.log("  + posts.manual_caption");
  } else {
    console.log("  ~ posts.manual_caption already exists, skipping");
  }
}
