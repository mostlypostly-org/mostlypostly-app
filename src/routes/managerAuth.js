// src/routes/managerAuth.js

import express from "express";
import bcrypt from "bcryptjs";
import { db } from "../../db.js";
import crypto from "crypto";
import { sendViaTwilio } from "../routes/twilio.js";

// Generate lowercase hex string for IDs
const lowerHex = () =>
  crypto.randomUUID().replace(/-/g, "").toLowerCase();

const router = express.Router();

/* -------------------------------
   Helper: find token row (valid)
---------------------------------*/
function findValidTokenRow(token) {
  if (!token) return null;

  // Only allow non-expired tokens (expires_at in the future)
  const row = db
    .prepare(
      `
      SELECT mt.*, m.email, m.salon_id
      FROM manager_tokens mt
      JOIN managers m ON m.id = mt.manager_id
      WHERE mt.token = ?
        AND (mt.expires_at IS NULL OR datetime(mt.expires_at) > datetime('now'))
      LIMIT 1
    `
    )
    .get(token);

  return row || null;
}

/* -------------------------------
   GET /manager/login
   - If token: validate token & log them in
   - Otherwise show login form
---------------------------------*/
router.get("/login", (req, res) => {
  const { token } = req.query || {};

  // 🔑 Magic-link path: /manager/login?token=...
  if (token) {
    const row = findValidTokenRow(token);

    if (!row) {
      return res
        .status(401)
        .type("html")
        .send(
          `<h2>Invalid or expired login link</h2><p>Please request a new login link from your MostlyPostly manager.</p>`
        );
    }

    // Mark token as used
    db.prepare(
      `
      UPDATE manager_tokens
      SET used_at = datetime('now')
      WHERE token = ?
    `
    ).run(token);

    // Basic session payload (using row from token lookup)
    req.session.manager_id = row.manager_id;
    req.session.salon_id = row.salon_id;
    req.session.manager_email = row.email;

    return res.redirect("/manager");
  }

  // 🧑‍💻 Normal email/password login form
  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Manager Login — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">

  <style>
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0F172A;
      color: #F8FAFC;
    }

    /* Split screen */
    .split-wrapper {
      display: flex;
      min-height: 100vh;
    }

    .left-panel {
      flex: 1;
      background: linear-gradient(180deg, #1E293B 0%, #0F172A 100%);
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
    }

    /* Abstract glowing shapes */
    .glow {
      position: absolute;
      border-radius: 999px;
      filter: blur(80px);
      opacity: 0.35;
    }
    .glow-1 { width: 300px; height: 300px; top: -40px; left: -40px; background: #3B82F6; }
    .glow-2 { width: 260px; height: 260px; bottom: -40px; right: -20px; background: #4F46E5; }

    /* Floating fake UI card */
    .fake-card {
      background: #1E293B;
      padding: 24px;
      width: 320px;
      border-radius: 14px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.06);
    }

    .fake-title {
      height: 16px;
      width: 80%;
      background: rgba(255,255,255,0.08);
      border-radius: 4px;
      margin-bottom: 14px;
    }

    .fake-img {
      width: 100%;
      height: 180px;
      background: rgba(255,255,255,0.12);
      border-radius: 8px;
      margin-bottom: 14px;
    }

    .fake-lines div {
      height: 10px;
      width: 100%;
      background: rgba(255,255,255,0.08);
      border-radius: 4px;
      margin-bottom: 8px;
    }

    /* Right panel (login) */
    .right-panel {
      flex: 1;
      background: #FFFFFF;
      color: #1E293B;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }

    .login-card {
      width: 100%;
      max-width: 400px;
      background: #FFFFFF;
      padding: 42px;
      border-radius: 16px;
      border: 1px solid rgba(15,23,42,0.12);
      box-shadow: 0 10px 40px rgba(0,0,0,0.08);
    }

    .login-btn {
      background: #3B82F6;
      color: #FFFFFF;
      font-weight: 600;
      border-radius: 999px;
      padding: 12px 0;
      width: 100%;
      margin-top: 10px;
      transition: 0.2s;
      box-shadow: 0 4px 14px rgba(59,130,246,0.35);
    }
    .login-btn:hover {
      background: #2563EB;
    }

    .input-box {
      width: 100%;
      border-radius: 8px;
      padding: 12px;
      border: 1px solid #CBD5E1;
      margin-top: 4px;
      font-size: 14px;
    }
    .input-box:focus {
      border-color: #3B82F6;
      outline: none;
      box-shadow: 0 0 0 2px rgba(59,130,246,0.25);
    }

    /* Mobile stack */
    @media(max-width: 900px) {
      .split-wrapper {
        flex-direction: column;
      }
      .left-panel {
        min-height: 220px;
      }
    }
  </style>
</head>

<body>

<div class="split-wrapper">

  <!-- LEFT SPLIT PANEL -->
  <div class="left-panel">
    <div class="glow glow-1"></div>
    <div class="glow glow-2"></div>

    <div class="fake-card">
      <div class="fake-title"></div>
      <div class="fake-img"></div>
      <div class="fake-lines">
        <div></div>
        <div style="width: 90%;"></div>
        <div style="width: 70%;"></div>
      </div>
    </div>
  </div>

  <!-- RIGHT LOGIN PANEL -->
  <div class="right-panel">
    <div class="login-card">

      <h1 class="text-xl font-semibold mb-1 text-center">Welcome</h1>
      <p class="text-sm text-center text-slate-500 mb-6">Sign in to your account.</p>

      <form method="POST" action="/manager/login" class="space-y-5">

        <div>
          <label class="text-xs font-medium text-slate-600">Email address</label>
          <input type="email" name="email" class="input-box" placeholder="Enter your email" required>
        </div>

        <div>
          <label class="text-xs font-medium text-slate-600">Password</label>
          <input type="password" name="password" class="input-box" placeholder="Enter your password" required>
        </div>

        <button type="submit" class="login-btn">Log in</button>
      </form>

      <div class="mt-4 text-center">
        <a href="/manager/forgot-password" class="text-xs text-blue-600 hover:underline">
          Forgot your password?
        </a>
      </div>

      <div class="my-6 border-t border-slate-200"></div>

      <div class="text-center text-sm">
        <span class="text-slate-600">Not using MostlyPostly?</span>
        <a href="/manager/signup" class="font-semibold text-blue-600 underline hover:text-blue-800">
          Sign Up
        </a>
      </div>

    </div>
  </div>

</div>

</body>
</html>
  `);
});

/* -------------------------------
   GET: /manager/signup
   Split layout signup page
---------------------------------*/
router.get("/signup", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create Account — MostlyPostly</title>

  <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet" />

  <style>
    body {
      margin: 0;
      background: #0F172A;
      color: #F8FAFC;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    .split-wrapper {
      display: flex;
      min-height: 100vh;
    }

    .left-panel {
      flex: 1;
      padding: 4rem 3rem;
      background: linear-gradient(180deg, #1E293B 0%, #0F172A 100%);
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 2.5rem;
    }

    .mp-logo {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .mp-logo-icon {
      height: 44px;
      width: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #f59e0b, #6366F1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.95rem;
      font-weight: 600;
      color: white;
    }
    .mp-logo-text {
      font-size: 1.5rem;
      font-weight: 600;
      color: #FFFFFF;
    }

    .feat {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.06);
      padding: 1.2rem;
      border-radius: 0.9rem;
      backdrop-filter: blur(4px);
    }

    .feat h3 {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
    }

    .feat p {
      font-size: 0.85rem;
      color: #CBD5E1;
      line-height: 1.35;
    }

    .right-panel {
      flex: 1;
      background: white;
      color: #1E293B;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    .signup-card {
      width: 100%;
      max-width: 430px;
      padding: 2.75rem;
      background: #FFFFFF;
      border-radius: 1.25rem;
      border: 1px solid rgba(15,23,42,0.12);
      box-shadow: 0 10px 40px rgba(0,0,0,0.08);
    }

    .input-box {
      width: 100%;
      border-radius: 0.5rem;
      padding: 12px;
      border: 1px solid #CBD5E1;
      margin-top: 4px;
      font-size: 14px;
    }

    .input-box:focus {
      border-color: #3B82F6;
      outline: none;
      box-shadow: 0 0 0 2px rgba(59,130,246,0.25);
    }

    .signup-btn {
      width: 100%;
      background: #6366F1;
      border-radius: 999px;
      padding: 12px;
      font-weight: 600;
      color: #FFFFFF;
      margin-top: 0.75rem;
    }

    .signup-btn:hover {
      background: #4F46E5;
    }

    @media(max-width: 900px) {
      .split-wrapper {
        flex-direction: column;
      }
    }
  </style>
</head>

<body>

<div class="split-wrapper">

  <!-- LEFT PANEL: LOGO + FEATURE CALLOUTS -->
  <div class="left-panel">
    <div class="mp-logo">
      <div class="mp-logo-icon">MP</div>
      <div class="mp-logo-text">MostlyPostly</div>
    </div>

    <div class="feat">
      <h3>AI That Writes for Stylists</h3>
      <p>Turn any photo into a ready-to-post caption with hashtags & a “Book Now” CTA — all automatically.</p>
    </div>

    <div class="feat">
      <h3>Zero Learning Curve</h3>
      <p>Stylists simply text a photo. You approve. MostlyPostly handles the rest.</p>
    </div>

    <div class="feat">
      <h3>Stress-Free Posting</h3>
      <p>Auto-publishing to Facebook & Instagram keeps your salon active every week — hands free.</p>
    </div>
  </div>

  <!-- RIGHT PANEL: SIGNUP FORM -->
  <div class="right-panel">
    <div class="signup-card">

      <h2 class="text-xl font-semibold text-center mb-1">Create your account</h2>
      <p class="text-sm text-center text-gray-500 mb-6">Start your MostlyPostly setup.</p>

      <form action="/manager/signup" method="POST" class="space-y-5">

        <!-- Manager Full Name (required by backend) -->
        <div>
          <label class="text-xs font-semibold text-gray-700">Your Name</label>
          <input
            type="text"
            name="name"
            required
            class="input-box"
            placeholder="Your full name"
          />
        </div>

        <!-- Business Name -->
        <div>
          <label class="text-xs font-semibold text-gray-700">Business Name</label>
          <input
            type="text"
            name="businessName"
            required
            class="input-box"
            placeholder="Your salon or business name"
          />
        </div>

        <!-- Email -->
        <div>
          <label class="text-xs font-semibold text-gray-700">Email</label>
          <input
            type="email"
            name="email"
            required
            class="input-box"
            placeholder="you@business.com"
          />
        </div>

        <!-- Password -->
        <div>
          <label class="text-xs font-semibold text-gray-700">Password</label>
          <input
            type="password"
            name="password"
            required minlength="8"
            class="input-box"
            placeholder="Create a password"
          />
        </div>

        <!-- Phone Number -->
        <div>
          <label class="text-xs font-semibold text-gray-700">Phone Number</label>
          <input
            type="tel"
            name="phone"
            required
            class="input-box"
            placeholder="Mobile number"
          />
        </div>

        <!-- Anti-spam honeypot -->
        <input type="text" name="company" style="display:none" />

        <!-- AGREEMENTS -->
        <div class="space-y-3 mt-3">
          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" required class="mt-1" />
            <span>I agree to MostlyPostly’s <a href="/legal/terms.html" class="text-blue-600 underline">Terms</a> and <a href="/legal/privacy.html" class="text-blue-600 underline">Privacy Policy</a>.</span>
          </label>

          <label class="flex items-start gap-2 text-sm">
            <input type="checkbox" name="marketing_opt_in" value="yes" class="mt-1" />
            <span>Send me occasional product updates, best practices, and salon marketing tips.</span>
          </label>
        </div>

        <button type="submit" class="signup-btn">Get Started</button>

      </form>

      <div class="mt-6 text-center text-sm">
        Already have an account?
        <a href="/manager/login" class="text-blue-600 font-semibold underline">Sign In</a>
      </div>

    </div>
  </div>

</div>

</body>
</html>
  `);
});


// ============================================
// POST /manager/signup  (Create manager + salon)
// ============================================
router.post("/signup", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("🔎 Signup body payload:", body);

    // Normalize possible field names (defensive against old HTML / typos)
    const name =
      body.name || body.manager_name || body.fullName || body.owner_name || null;

    const businessName =
      body.businessName || body.business_name || body.salon_name || null;

    const email = body.email || null;
    const password = body.password || null;

    const phone =
      body.phone || body.phone_number || body.mobile || body.mobile_number || null;

    // Basic required check
    if (!email || !password || !phone || !businessName) {
      console.warn("⚠️ Signup missing fields:", {
        hasName: !!name,
        hasBusinessName: !!businessName,
        hasEmail: !!email,
        hasPassword: !!password,
        hasPhone: !!phone,
      });

      return res
        .status(400)
        .type("html")
        .send("Missing required fields.");
    }

    // Prevent duplicate email signup
    const existing = db
      .prepare("SELECT id FROM managers WHERE email = ?")
      .get(email);

    if (existing) {
      console.log("Signup error: email exists");
      return res.redirect("/manager/login?exists=1");
    }

    // Create salon slug from businessName
    const salonSlug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const salonId = lowerHex();

    // Insert SALON (setup_incomplete, status_step = 'salon')
    db.prepare(`
      INSERT INTO salons (
        id, slug, name,
        phone, status, status_step,
        timezone
      )
      VALUES (
        @id, @slug, @name,
        @phone, 'setup_incomplete', 'salon',
        'America/New_York'
      )
    `).run({
      id: salonId,
      slug: salonSlug,
      name: businessName,
      phone,
    });

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);
    const managerId = lowerHex();

    // Insert MANAGER
    db.prepare(`
      INSERT INTO managers (
        id, salon_id, name, email, phone, password_hash, role
      )
      VALUES (@id, @salon_id, @name, @email, @phone, @password_hash, 'manager')
    `).run({
      id: managerId,
      salon_id: salonId,
      name: name || businessName, // fallback to businessName if name missing
      email,
      phone,
      password_hash,
    });

    req.session.manager_id = managerId;
    req.session.salon_id = salonSlug;
    req.session.manager_email = email;

    console.log("✅ Signup OK → redirecting to onboarding step 1:", salonSlug);

    // Ensure session is persisted before redirect
    req.session.save((err) => {
      if (err) {
        console.error("❌ Error saving session after signup:", err);
        // fall back to login if session can't be saved
        return res.redirect("/manager/login");
      }

      return res.redirect(`/onboarding/salon?salon=${encodeURIComponent(salonSlug)}`);
    });

  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).type("html").send("Signup failed.");
  }
});

/* -------------------------------
   POST /manager/login
   - Email/password login
---------------------------------*/
router.post("/login", (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res
      .status(400)
      .type("html")
      .send("Email and password are required.");
  }

  const manager = db
    .prepare(
      `
      SELECT *
      FROM managers
      WHERE email = ?
      LIMIT 1
    `
    )
    .get(email);

  if (!manager || !manager.password_hash) {
    return res
      .status(401)
      .type("html")
      .send("Invalid credentials.");
  }

  const ok = bcrypt.compareSync(password, manager.password_hash);
  if (!ok) {
    return res
      .status(401)
      .type("html")
      .send("Invalid credentials.");
  }

  // Use consistent session keys throughout the app
  req.session.manager_id = manager.id;
  req.session.salon_id = manager.salon_id;
  req.session.manager_email = manager.email;

  // Redirect to dashboard
  return res.redirect("/manager");

});

/* ============================================================
   PASSWORD RESET FLOW (Manager Accounts)
   ============================================================ */

/* -------------------------------
   GET /manager/forgot-password
   - Show password reset request form
---------------------------------*/
router.get("/forgot-password", (req, res) => {
  res.type("html").send(`
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Reset Password — MostlyPostly</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <!-- Tailwind CDN -->
    <script src="https://cdn.tailwindcss.com"></script>

    <style>
      /* HARD RESET — overrides inherited app styles */
      html, body {
        margin: 0;
        padding: 0;
        height: 100%;
        background-color: #020617 !important;
        color: #E5E7EB !important;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      }

      /* Force readable inputs */
      input {
        background-color: #FFFFFF !important;
        color: #020617 !important;
        caret-color: #020617 !important;
      }

      input::placeholder {
        color: #64748B !important;
      }
    </style>
  </head>

  <body>
    <div class="min-h-screen flex items-center justify-center px-4">

      <div class="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8 shadow-xl">

        <!-- Logo -->
        <div class="flex justify-center mb-6">
          <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white">
            MP
          </div>
        </div>

        <h1 class="text-2xl font-bold text-center text-white mb-2">
          Reset your password
        </h1>

        <p class="text-sm text-center text-slate-400 mb-6">
          Enter your email and we’ll text you a secure reset link.
        </p>

        <form method="POST" action="/manager/forgot-password" class="space-y-4">

          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">
              Email address
            </label>
            <input
              type="email"
              name="email"
              required
              placeholder="you@business.com"
              class="w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <button
            type="submit"
            class="mt-2 w-full rounded-full bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition"
          >
            Send reset link
          </button>
        </form>

        <div class="mt-6 text-center">
          <a href="/manager/login" class="text-xs text-slate-400 hover:text-white">
            ← Back to login
          </a>
        </div>

      </div>
    </div>
  </body>
  </html>
    `);
  });


/* -------------------------------
   POST /manager/forgot-password
   - Generate reset token (non-enumerating)
---------------------------------*/
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body || {};

  if (!email) {
    return res.send("If the email exists, a reset link was sent.");
  }

  const manager = db
  .prepare(`SELECT id, phone FROM managers WHERE email = ?`)
  .get(email);

  if (!manager?.phone) {
    console.warn("⚠️ Password reset requested but manager has no phone:", email);
    return res.send("If the email exists, a reset link was sent.");
  }


  // Always respond success (prevents email enumeration)
  if (!manager) {
    return res.send("If the email exists, a reset link was sent.");
  }

  const token = lowerHex();
  const expiresAt = new Date(
    Date.now() + 1000 * 60 * 45 // 45 minutes
  ).toISOString();

  db.prepare(`
    INSERT INTO password_reset_tokens (
      token, manager_id, expires_at
    )
    VALUES (?, ?, ?)
  `).run(token, manager.id, expiresAt);

  // TODO: replace with email or SMS delivery
  console.log(`
🔐 PASSWORD RESET LINK
https://yourdomain.com/manager/reset-password?token=${token}
  `);

  const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
  const resetLink = `${BASE_URL}/manager/reset-password?token=${token}`;

  const smsBody = `🔐 MostlyPostly Password Reset

  Tap to reset your password:
  ${resetLink}

  This link expires in 45 minutes.`;

  console.log("📤 Sending password reset SMS to:", manager.phone);
  await sendViaTwilio(manager.phone, smsBody);


  return res.send("If the email exists, a reset link was sent.");
});

/* -------------------------------
   GET /manager/reset-password
   - Validate token & show reset form (centered card)
---------------------------------*/
router.get("/reset-password", (req, res) => {
  const token = String(req.query?.token || "").trim();

  if (!token) {
    return res.status(400).type("html").send("Missing reset token.");
  }

  const row = db.prepare(`
    SELECT token
    FROM password_reset_tokens
    WHERE token = ?
      AND used_at IS NULL
      AND datetime(expires_at) > datetime('now')
    LIMIT 1
  `).get(token);

  if (!row) {
    return res.status(400).type("html").send("Invalid or expired reset link.");
  }

  const safeToken = token
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");

  return res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Reset Password — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />

  <!-- Tailwind CDN -->
  <script src="https://cdn.tailwindcss.com"></script>

  <style>
    /* HARD RESET — overrides all inherited styles */
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      background-color: #020617 !important;
      color: #E5E7EB !important;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }

    /* Force readable inputs */
    input {
      background-color: #FFFFFF !important;
      color: #020617 !important;
      caret-color: #020617 !important;
    }

    input::placeholder {
      color: #64748B !important;
    }
  </style>
</head>

<body>
  <div class="min-h-screen flex items-center justify-center px-4">

    <div class="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-8 shadow-xl">

      <div class="flex justify-center mb-6">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-semibold text-white">
          MP
        </div>
      </div>

      <h1 class="text-2xl font-bold text-center text-white mb-2">
        Set a new password
      </h1>

      <p class="text-sm text-center text-slate-400 mb-6">
        Choose a secure password for your MostlyPostly account.
      </p>

      <form method="POST" action="/manager/reset-password" class="space-y-4">
        <input type="hidden" name="token" value="${safeToken}" />

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">
            New password
          </label>
          <input
            type="password"
            name="password"
            required
            minlength="8"
            placeholder="At least 8 characters"
            class="w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">
            Confirm new password
          </label>
          <input
            type="password"
            name="password_confirm"
            required
            minlength="8"
            placeholder="Re-enter password"
            class="w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <button
          type="submit"
          class="mt-2 w-full rounded-full bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 transition"
        >
          Update password
        </button>
      </form>

      <div class="mt-6 text-center">
        <a href="/manager/login" class="text-xs text-slate-400 hover:text-white">
          ← Back to login
        </a>
      </div>

    </div>
  </div>
</body>
</html>
  `);
});

/* -------------------------------
   POST /manager/reset-password
   - Finalize password reset
---------------------------------*/
router.post("/reset-password", async (req, res) => {
  const { token, password, password_confirm } = req.body || {};

  if (!token || !password) {
    return res.status(400).send("Invalid request.");
  }

  if (password !== password_confirm) {
    return res
      .status(400)
      .type("html")
      .send("Passwords do not match.");
  }

  const row = db.prepare(`
    SELECT *
    FROM password_reset_tokens
    WHERE token = ?
      AND used_at IS NULL
      AND datetime(expires_at) > datetime('now')
    LIMIT 1
  `).get(token);

  if (!row) {
    return res.status(400).send("Invalid or expired reset link.");
  }

  const password_hash = await bcrypt.hash(password, 10);

  db.prepare(`
    UPDATE managers
    SET password_hash = ?
    WHERE id = ?
  `).run(password_hash, row.manager_id);

  db.prepare(`
    UPDATE password_reset_tokens
    SET used_at = datetime('now')
    WHERE token = ?
  `).run(token);

  return res.redirect("/manager/login?reset=success");
});


/* -------------------------------
   Magic link helper:
   GET /manager/login-with-token?token=...
---------------------------------*/
router.get("/login-with-token", (req, res) => {
  const { token } = req.query || {};
  if (!token) {
    return res
      .status(400)
      .type("html")
      .send("Missing token. Please use the link from your SMS.");
  }

  // Re-use the same flow as /manager/login?token=...
  const redirectUrl = `/manager/login?token=${encodeURIComponent(token)}`;
  return res.redirect(redirectUrl);
});

/* -------------------------------
   GET /manager/logout
---------------------------------*/
router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/manager/login");
  });
});

export default router;
