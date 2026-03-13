// migrations/029_rename_staff_to_coordinator.js
// Renames the 'staff' role to 'coordinator' — clearer terminology for salon context.

export function run(db) {
  db.prepare(`UPDATE managers SET role = 'coordinator' WHERE role = 'staff'`).run();
  console.log("✅ [Migration 029] Renamed 'staff' role to 'coordinator'");
}
