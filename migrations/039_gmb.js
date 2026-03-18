export function run(db) {
  const salonCols = db.prepare(`PRAGMA table_info(salons)`).all().map(c => c.name);
  const add = (col, def) => {
    if (!salonCols.includes(col))
      db.prepare(`ALTER TABLE salons ADD COLUMN ${col} ${def}`).run();
  };
  add("google_location_id",   "TEXT");
  add("google_access_token",  "TEXT");
  add("google_refresh_token", "TEXT");
  add("google_business_name", "TEXT");
  add("google_token_expiry",  "TEXT");
  add("gmb_enabled",          "INTEGER DEFAULT 0");

  const postCols = db.prepare(`PRAGMA table_info(posts)`).all().map(c => c.name);
  if (!postCols.includes("google_post_id"))
    db.prepare(`ALTER TABLE posts ADD COLUMN google_post_id TEXT`).run();
}
