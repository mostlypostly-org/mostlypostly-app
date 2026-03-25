// Migration 059: Back-fill email_verified=1 for manager/staff/coordinator accounts
// created via the Team page (they were added by owners, not self-registered,
// so email verification doesn't apply to them).
// Targets rows with a password_hash (portal accounts) that are still unverified.

export function run(db) {
  db.prepare(`
    UPDATE managers
    SET email_verified = 1
    WHERE email_verified = 0
      AND password_hash IS NOT NULL
  `).run();
}
