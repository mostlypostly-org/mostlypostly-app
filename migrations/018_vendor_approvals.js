// migrations/018_vendor_approvals.js
// Vendor partner approval system.
// Salons request access to specific vendor brands; MostlyPostly team approves manually.
// Approved vendors unlock the toggle in /manager/vendors.

export function run(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS salon_vendor_approvals (
      id            TEXT PRIMARY KEY,
      salon_id      TEXT NOT NULL,
      vendor_name   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied
      proof_file    TEXT,          -- uploaded filename/path for proof of partnership
      notes         TEXT,          -- internal notes from MostlyPostly team
      requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at   TEXT,
      UNIQUE(salon_id, vendor_name)
    )
  `);

  console.log("✅ [Migration 018] salon_vendor_approvals created");
}
