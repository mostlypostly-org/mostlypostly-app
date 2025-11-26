import express from "express";
import { db } from "../../db.js";

const router = express.Router();

/* -------------------------------------------
   GET /onboarding/salon
   Renders the unified salon + manager setup form
------------------------------------------- */
router.get("/salon", (req, res) => {
  const managerId = req.session.manager_id;

  if (!managerId) {
    return res.redirect("/manager/login");
  }

  // Load manager + salon
  const manager = db
    .prepare("SELECT id, email, salon_id FROM managers WHERE id = ?")
    .get(managerId);

  if (!manager) {
    return res.redirect("/manager/login");
  }

  const salon = db
    .prepare("SELECT id, slug, name FROM salons WHERE slug = ?")
    .get(manager.salon_id);

  const businessName = salon?.name || "";

  // Serve onboarding HTML
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Finish Setup — MostlyPostly</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet" />

<style>
body { background: #0F172A; color: #F8FAFC; font-family: system-ui; }
.card {
  max-width: 720px;
  margin: 3rem auto;
  background: white;
  color: #1E293B;
  padding: 2rem 2.5rem;
  border-radius: 1.25rem;
  border: 1px solid rgba(15,23,42,0.12);
  box-shadow: 0 10px 40px rgba(0,0,0,0.12);
}
.input-box {
  width: 100%; border-radius: 0.5rem; padding: 12px;
  border: 1px solid #CBD5E1; margin-top: 4px; font-size: 14px;
}
.input-box:focus {
  border-color: #6366F1; outline: none;
  box-shadow: 0 0 0 2px rgba(99,102,241,0.25);
}
.section-title {
  font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem;
}
.finish-btn {
  width: 100%; background: #6366F1; padding: 12px;
  border-radius: 999px; color: white; font-weight: 600;
  margin-top: 1.25rem;
}
.finish-btn:hover { background: #4F46E5; }
</style>
</head>

<body>

<div class="card">
  <h1 class="text-2xl font-semibold text-center mb-6">Finish Setting Up Your Business</h1>

  <form action="/onboarding/salon" method="POST">

    <!-- ------------------------------
         SECTION 1: BUSINESS SETUP
    -------------------------------- -->
    <div class="mb-10">
      <div class="section-title">Business Information</div>

      <label class="text-sm font-semibold">Business Name</label>
      <input type="text" name="business_name" required class="input-box" value="${businessName}" />

      <label class="text-sm font-semibold mt-4 block">Business Website</label>
      <input type="url" name="website" placeholder="https://yourbusiness.com" class="input-box" />

      <label class="text-sm font-semibold mt-4 block">Booking Link</label>
      <input type="url" name="booking_link" placeholder="https://booking.com/you" class="input-box" />

      <label class="text-sm font-semibold mt-4 block">Timezone</label>
      <select name="timezone" class="input-box">
        <option value="America/New_York">Eastern (EST)</option>
        <option value="America/Chicago">Central (CST)</option>
        <option value="America/Denver">Mountain (MST)</option>
        <option value="America/Los_Angeles">Pacific (PST)</option>
      </select>

      <label class="text-sm font-semibold mt-4 block">Business Type</label>
      <select name="business_type" class="input-box">
        <option value="hair">Hair Salon</option>
        <option value="spa">Spa</option>
        <option value="medspa">Med Spa</option>
        <option value="nails">Nail Salon</option>
        <option value="barbershop">Barbershop</option>
      </select>
    </div>

    <!-- ------------------------------
         SECTION 2: MANAGER PROFILE
    -------------------------------- -->
    <div class="mb-10">
      <div class="section-title">Your Manager Profile</div>

      <label class="text-sm font-semibold">Full Name</label>
      <input type="text" name="manager_name" required class="input-box" placeholder="Your name" />

      <label class="text-sm font-semibold mt-4 block">Title</label>
      <select name="manager_title" class="input-box">
        <option value="owner">Owner</option>
        <option value="manager">Manager</option>
      </select>

      <label class="text-sm font-semibold mt-4 block">Display Name</label>
      <input type="text" name="display_name" class="input-box" placeholder="Your public-facing name" />

    </div>

    <button type="submit" class="finish-btn">Finish Setup →</button>

  </form>
</div>

</body>
</html>
  `);
});

/* -------------------------------------------
   POST /onboarding/salon
   Saves Business + Manager profile
------------------------------------------- */
router.post("/salon", (req, res) => {
  const managerId = req.session.manager_id;
  if (!managerId) return res.redirect("/manager/login");

  const {
    business_name,
    website,
    booking_link,
    timezone,
    business_type,
    manager_name,
    manager_title,
    display_name
  } = req.body;

  // Load manager + salon
  const manager = db
    .prepare("SELECT id, salon_id FROM managers WHERE id = ?")
    .get(managerId);

  const salonSlug = manager.salon_id;

  // Update salon
  db.prepare(
    `
    UPDATE salons
    SET name = @name,
        website = @website,
        booking_url = @booking,
        timezone = @timezone,
        business_type = @type,
        updated_at = datetime('now')
    WHERE slug = @slug
  `
  ).run({
    name: business_name,
    website,
    booking: booking_link,
    timezone,
    type: business_type,
    slug: salonSlug
  });

  // Update manager
  db.prepare(
    `
    UPDATE managers
    SET name = @name,
        role = @role,
        updated_at = datetime('now')
    WHERE id = @id
  `
  ).run({
    id: managerId,
    name: manager_name,
    role: manager_title
  });

  req.session.salon_id = salonSlug;
  req.session.manager_id = managerId;

  return res.redirect("/dashboard");
});

export default router;
