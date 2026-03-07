// migrations/008_billing.js — Stripe billing fields on salons table

export function run(db) {
  const cols = [
    "ALTER TABLE salons ADD COLUMN stripe_customer_id     TEXT",
    "ALTER TABLE salons ADD COLUMN stripe_subscription_id TEXT",
    "ALTER TABLE salons ADD COLUMN plan                   TEXT DEFAULT 'trial'",
    "ALTER TABLE salons ADD COLUMN plan_status            TEXT DEFAULT 'trialing'",
    "ALTER TABLE salons ADD COLUMN trial_ends_at          TEXT",
    "ALTER TABLE salons ADD COLUMN billing_cycle          TEXT DEFAULT 'monthly'",
  ];

  for (const sql of cols) {
    try {
      db.exec(sql);
    } catch (err) {
      // Column already exists — safe to ignore
      if (!err.message.includes("duplicate column")) throw err;
    }
  }
}
