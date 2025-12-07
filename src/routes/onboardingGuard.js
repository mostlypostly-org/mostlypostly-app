// src/routes/onboardingGuard.js
import db from "../../db.js";   // <-- REQUIRED

export default function onboardingGuard(req, res, next) {
  const url = req.originalUrl || req.url;

  // Always allow health checks
  if (url.startsWith("/healthz")) return next();

  // Allow static/marketing/legal
  if (
    url.startsWith("/legal") ||
    url.startsWith("/assets") ||
    url.startsWith("/public")
  ) {
    return next();
  }

  // Allow login/signup and token login
  if (
    url.startsWith("/manager/login") ||
    url.startsWith("/manager/signup") ||
    url.startsWith("/manager/login-with-token")
  ) {
    return next();
  }
  
  // Allow Twilio webhooks (PUBLIC)
  if (url.startsWith("/inbound/twilio")) {
    return next();
  }


  // Allow logout
  if (url.startsWith("/manager/logout")) return next();

  // Allow onboarding routes
  if (url.startsWith("/onboarding")) return next();

  const manager_id = req.session?.manager_id;
  const salon_id = req.session?.salon_id;

  // Not logged in → force login
  if (!manager_id || !salon_id) {
    return res.redirect("/manager/login");
  }

  // Look up current onboarding step using DB IMPORT, not req.db
  const row = db
    .prepare("SELECT status, status_step FROM salons WHERE slug = ?")
    .get(salon_id);

  if (!row) {
    return res.redirect("/manager/login");
  }

  const { status, status_step } = row;

  // Onboarding complete → let them in
  if (status === "active" && status_step === "complete") {
    return next();
  }

  const stepRedirect = {
    salon: "/onboarding/salon",
    rules: "/onboarding/rules",
    manager: "/onboarding/manager",
    stylists: "/onboarding/stylists",
    review: "/onboarding/review",
  }[status_step];

  if (stepRedirect && !url.startsWith(stepRedirect)) {
    return res.redirect(stepRedirect);
  }

  return next();
}
