// src/core/migrationRunner.js
// Tracks and applies numbered migrations. Accepts db as a parameter to avoid
// circular imports with db.js.

function ensureSchemaTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}

function isApplied(db, name) {
  return !!db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name);
}

function markApplied(db, name) {
  db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
}

/**
 * Run an array of migrations in order.
 * Each migration: { name: string, run: (db) => void }
 * Already-applied migrations are skipped.
 * Errors in a migration are thrown (fail loud).
 */
export function runMigrations(db, migrations) {
  ensureSchemaTable(db);

  for (const { name, run } of migrations) {
    if (isApplied(db, name)) continue;

    console.log(`[migrations] Applying: ${name}`);
    run(db);
    markApplied(db, name);
    console.log(`[migrations] Applied:  ${name}`);
  }
}
