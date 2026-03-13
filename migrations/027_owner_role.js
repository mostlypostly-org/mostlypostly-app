// migrations/027_owner_role.js
// Introduces 'owner' role for the primary account holder.
// - Existing salons: first-created manager per salon becomes 'owner'
// - All others stay 'manager'

export function run(db) {
  // Find the first manager per salon (by created_at) and promote to owner
  const salons = db.prepare("SELECT DISTINCT salon_id FROM managers").all();
  for (const { salon_id } of salons) {
    const first = db.prepare(
      "SELECT id FROM managers WHERE salon_id = ? ORDER BY created_at ASC LIMIT 1"
    ).get(salon_id);
    if (first) {
      db.prepare("UPDATE managers SET role = 'owner' WHERE id = ?").run(first.id);
    }
  }

  console.log("✅ [Migration 027] owner role assigned to first manager per salon");
}
