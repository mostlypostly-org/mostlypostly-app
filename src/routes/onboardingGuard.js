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

  // Allow login/signup and password reset
  if (
    url.startsWith("/manager/login") ||
    url.startsWith("/manager/signup") ||
    url.startsWith("/manager/forgot-password") ||
    url.startsWith("/manager/reset-password")
  ) {
    return next();
  }

  // Allow Twilio webhooks (PUBLIC)
  if (url.startsWith("/inbound/twilio")) {
    return next();
  }

  // Allow Telegram webhooks (PUBLIC)
if (url.startsWith("/inbound/telegram")) {
  return next();
}

  // Allow logout
  if (url.startsWith("/manager/logout")) return next();

  // Allow onboarding routes
  if (url.startsWith("/onboarding")) return next();

  // Allow billing routes (checkout, success — webhook already exempt before guard)
  if (url.startsWith("/billing")) return next();

  // Allow billing management page for new accounts choosing a plan
  if (url.startsWith("/manager/billing")) return next();

  // Allow internal vendor admin (protected by its own INTERNAL_SECRET check)
  if (url.startsWith("/internal/vendors")) return next();

  // Allow stylist portal (token-authenticated, no session needed)
  if (url.startsWith("/stylist")) return next();

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
    salon:    "/onboarding/salon",
    brand:    "/onboarding/brand",
    rules:    "/onboarding/rules",
    manager:  "/onboarding/manager",
    stylists: "/onboarding/stylists",
    review:   "/onboarding/review",
  }[status_step];

  if (stepRedirect) {
    if (!url.startsWith(stepRedirect)) return res.redirect(stepRedirect);
    return next();
  }

  // Unknown status_step — fall back to start of onboarding
  return res.redirect("/onboarding/salon");
}
