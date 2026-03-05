// db.js — SQLite database bootstrap
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || "local";

let defaultDbPath;
if (APP_ENV === "production") {
  defaultDbPath = "/data/postly.db";
} else if (APP_ENV === "staging") {
  defaultDbPath = "/tmp/postly.db";
} else {
  defaultDbPath = path.join(process.cwd(), "postly.db");
}

const DB_PATH = process.env.DB_PATH || defaultDbPath;
console.log("Using database at:", DB_PATH);

// Open connection
export const db = new Database(DB_PATH, { timeout: 10000 });

// Recommended PRAGMAs
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");

// Apply base schema (idempotent — all CREATE TABLE IF NOT EXISTS)
const schemaPath = path.join(__dirname, "schema.sql");
if (fs.existsSync(schemaPath)) {
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  console.log("schema.sql applied");
} else {
  console.error("schema.sql not found at:", schemaPath);
}

// Run numbered migrations (tracks applied state in schema_migrations table)
import { runMigrations } from "./src/core/migrationRunner.js";
import { migrations } from "./migrations/index.js";
runMigrations(db, migrations);

// Seed staging data
import { seedStaging } from "./src/db/seedStaging.js";
if (APP_ENV === "staging") {
  seedStaging();
}

// -------------------------------------------------------
// Helper: verify a manager login token
// -------------------------------------------------------
export function verifyTokenRow(token) {
  try {
    return db
      .prepare("SELECT token, salon_id, manager_phone, expires_at FROM manager_tokens WHERE token = ?")
      .get(token);
  } catch (err) {
    console.error("Token verification failed:", err.message);
    return null;
  }
}

export default db;
