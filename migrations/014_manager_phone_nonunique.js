// migrations/014_manager_phone_nonunique.js
// Drops UNIQUE constraint on managers.phone so one person can manage
// multiple salons (e.g. owner running both Studio 500 and Rejuve).
// SQLite can't drop constraints directly — rebuild the table without it.

export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS managers_new (
      id             TEXT PRIMARY KEY,
      salon_id       TEXT NOT NULL,
      name           TEXT,
      phone          TEXT,
      chat_id        TEXT,
      role           TEXT DEFAULT 'manager',
      pin            TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      password_hash  TEXT,
      email          TEXT UNIQUE,
      compliance_opt_in      INTEGER DEFAULT 0,
      compliance_timestamp   TEXT,
      consent               TEXT,
      FOREIGN KEY (salon_id) REFERENCES salons(slug)
    );

    INSERT INTO managers_new SELECT * FROM managers;
    DROP TABLE managers;
    ALTER TABLE managers_new RENAME TO managers;
  `);

  console.log("✅ [Migration 014] managers.phone UNIQUE constraint removed");
}
