// src/routes/onboardingGuard.js

import db from "../../db.js";

/**
 * Blocks access to manager pages if onboarding is not complete.
 * Applies only when:
 *  - manager is logged in
 *  - manager has a salon assigned
 *  - salon.status !== 'active'
 *
 * Allows:
 *  - onboarding routes
 *  - login routes
 *  - existing salons (status === 'active')
 */

export function onboardingGuard(req, res, next) {
  try {
    // No session → skip guard
    if (!req.session.manager) return next();

    const manager = req.session.manager;
    const salon_id = manager.salon_id;

    // If no salon_id → skip guard
    if (!salon_id) return next();

    // Read salon info
    const salon = db
      .prepare("SELECT status, status_step FROM salons WHERE salon_id = ?")
      .get(salon_id);

    if (!salon) return next();

    const { status, status_step } = salon;

    // If already active → allow
    if (status === "active") return next();

    // Always allow onboarding routes
    if (req.path.startsWith("/onboarding")) return next();

    // Always allow login routes
    if (req.path.startsWith("/manager/login")) return next();
    if (req.path.startsWith("/manager/signup")) return next();

    // Redirect to correct onboarding step
    return res.redirect(`/onboarding/${status_step || "salon"}`);

  } catch (err) {
    console.error("[onboardingGuard] ERROR:", err);
    return next(); // fail-open
  }
}
