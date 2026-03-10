// Legacy one-off script — column is now managed by migrations.
// Kept for reference. Uses better-sqlite3 (not sqlite3).
import Database from "better-sqlite3";
const db = new Database("./postly.db");

try {
  db.exec("ALTER TABLE posts ADD COLUMN stylist_phone TEXT");
  console.log("✅ Column 'stylist_phone' added.");
} catch (err) {
  if (err.message.includes("duplicate column name")) {
    console.log("ℹ️  Column 'stylist_phone' already exists.");
  } else {
    console.error("❌ Failed:", err.message);
  }
}
