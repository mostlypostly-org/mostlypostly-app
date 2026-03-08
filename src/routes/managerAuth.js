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
   GET /manager/login
   - Email/password login form
---------------------------------*/
router.get("/login", (req, res) => {
  // Email/password login form
  const { exists, reset } = req.query || {};
  const banner = exists === "1"
    ? `<div style="background:#FFF0EE;border:1px solid #F2C4BB;border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#A0443A;">
        An account with that email already exists. <a href="/manager/login" style="color:#D4897A;font-weight:700;">Log in instead</a>
       </div>`
    : reset === "success"
    ? `<div style="background:#EFF9F5;border:1px solid #B2DFC8;border-radius:10px;padding:12px 16px;margin-bottom:20px;font-size:13px;color:#1E6645;">
        Password reset successfully! Log in with your new password.
       </div>`
    : "";

  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Manager Login — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif;
      background: #FDF8F6;
      color: #2B2D35;
      min-height: 100vh;
    }
    .split-wrapper { display: flex; min-height: 100vh; }

    /* ── LEFT PANEL ── */
    .left-panel {
      flex: 1;
      background: #2B2D35;
      position: relative;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 44px;
      gap: 28px;
    }

    /* subtle dot grid background */
    .left-panel::before {
      content: '';
      position: absolute;
      inset: 0;
      background-image: radial-gradient(circle, rgba(212,137,122,0.18) 1px, transparent 1px);
      background-size: 28px 28px;
      pointer-events: none;
    }

    /* warm glow blob */
    .left-panel::after {
      content: '';
      position: absolute;
      width: 400px; height: 400px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(212,137,122,0.22) 0%, transparent 70%);
      bottom: -100px; right: -100px;
      pointer-events: none;
    }

    .left-logo { width: 320px; height: auto; filter: brightness(0) invert(1); position: relative; z-index: 1; }

    .left-tagline {
      font-size: 14px;
      color: rgba(255,255,255,0.55);
      text-align: center;
      max-width: 280px;
      line-height: 1.7;
      position: relative; z-index: 1;
    }

    /* Stat pills row */
    .stat-row {
      display: flex;
      gap: 10px;
      position: relative; z-index: 1;
    }
    .stat-pill {
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 999px;
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 600;
      color: rgba(255,255,255,0.8);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .stat-dot { width: 6px; height: 6px; border-radius: 50%; background: #D4897A; }

    /* Activity chart card */
    .chart-card {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 18px;
      padding: 20px 22px;
      width: 100%;
      max-width: 320px;
      position: relative; z-index: 1;
    }
    .chart-label {
      font-size: 10px;
      font-weight: 700;
      color: rgba(255,255,255,0.4);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 16px;
    }
    .chart-bars {
      display: flex;
      align-items: flex-end;
      gap: 7px;
      height: 80px;
    }
    .bar-wrap {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      height: 100%;
      justify-content: flex-end;
    }
    .bar {
      width: 100%;
      border-radius: 5px 5px 0 0;
      background: rgba(212,137,122,0.35);
      transition: background 0.2s;
    }
    .bar.active { background: #D4897A; }
    .bar-day {
      font-size: 9px;
      font-weight: 600;
      color: rgba(255,255,255,0.3);
    }
    .chart-summary {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(255,255,255,0.08);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .chart-summary-num { font-size: 20px; font-weight: 800; color: #fff; }
    .chart-summary-label { font-size: 10px; color: rgba(255,255,255,0.4); margin-top: 1px; }
    .chart-badge {
      font-size: 10px;
      font-weight: 700;
      background: rgba(212,137,122,0.2);
      color: #D4897A;
      border-radius: 999px;
      padding: 4px 10px;
    }

    /* ── RIGHT PANEL ── */
    .right-panel {
      flex: 1;
      background: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
    }
    .login-card { width: 100%; max-width: 400px; }
    .login-card h1 { font-size: 24px; font-weight: 800; color: #2B2D35; margin-bottom: 6px; }
    .login-card .sub { font-size: 13px; color: #7A7C85; margin-bottom: 28px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #2B2D35; margin-bottom: 5px; }
    .input-box {
      width: 100%; border-radius: 10px; padding: 11px 14px;
      border: 1px solid #EDE7E4; background: #FDF8F6;
      font-size: 14px; color: #2B2D35; margin-bottom: 16px; font-family: inherit;
    }
    .input-box:focus { border-color: #D4897A; outline: none; box-shadow: 0 0 0 3px rgba(212,137,122,0.15); }
    .login-btn {
      background: #2B2D35; color: #fff; font-weight: 700; border-radius: 999px;
      padding: 13px 0; width: 100%; font-size: 14px; border: none;
      cursor: pointer; transition: background 0.2s; font-family: inherit;
    }
    .login-btn:hover { background: #1a1c22; }
    .divider { border: none; border-top: 1px solid #EDE7E4; margin: 22px 0; }
    .footer-links { text-align: center; font-size: 13px; color: #7A7C85; }
    .footer-links a { color: #D4897A; font-weight: 600; text-decoration: none; }
    .footer-links a:hover { text-decoration: underline; }
    .forgot { display: block; text-align: center; font-size: 12px; color: #7A7C85; margin-top: 12px; }
    .forgot:hover { color: #2B2D35; }

    @media(max-width: 768px) {
      .split-wrapper { flex-direction: column; }
      .left-panel { min-height: 240px; padding: 32px 24px; gap: 20px; }
      .chart-card, .stat-row { display: none; }
    }
  </style>
</head>
<body>
<div class="split-wrapper">

  <!-- LEFT PANEL -->
  <div class="left-panel">
    <a href="https://mostlypostly.com" style="display:block;position:relative;z-index:1;">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" class="left-logo" />
    </a>
    <p class="left-tagline">AI social media for salons. Text a photo, get a polished post on Facebook &amp; Instagram.</p>

    <!-- Stat pills -->
    <div class="stat-row">
      <div class="stat-pill"><span class="stat-dot"></span> Auto-posting live</div>
      <div class="stat-pill"><span class="stat-dot"></span> FB &amp; Instagram</div>
    </div>

    <!-- Activity chart -->
    <div class="chart-card">
      <div class="chart-label">Posts published — this week</div>
      <div class="chart-bars">
        <div class="bar-wrap"><div class="bar" style="height:35%"></div><span class="bar-day">M</span></div>
        <div class="bar-wrap"><div class="bar" style="height:60%"></div><span class="bar-day">T</span></div>
        <div class="bar-wrap"><div class="bar" style="height:45%"></div><span class="bar-day">W</span></div>
        <div class="bar-wrap"><div class="bar" style="height:80%"></div><span class="bar-day">T</span></div>
        <div class="bar-wrap"><div class="bar active" style="height:100%"></div><span class="bar-day">F</span></div>
        <div class="bar-wrap"><div class="bar" style="height:55%"></div><span class="bar-day">S</span></div>
        <div class="bar-wrap"><div class="bar" style="height:25%"></div><span class="bar-day">S</span></div>
      </div>
      <div class="chart-summary">
        <div>
          <div class="chart-summary-num">24</div>
          <div class="chart-summary-label">posts this week</div>
        </div>
        <div class="chart-badge">↑ 18% vs last week</div>
      </div>
    </div>
  </div>

  <!-- RIGHT PANEL -->
  <div class="right-panel">
    <div class="login-card">
      <h1>Welcome back</h1>
      <p class="sub">Sign in to your MostlyPostly account.</p>

      ${banner}

      <form method="POST" action="/manager/login">
        <label>Email address</label>
        <input type="email" name="email" class="input-box" placeholder="you@yoursalon.com" required />
        <label>Password</label>
        <input type="password" name="password" class="input-box" placeholder="••••••••" required />
        <button type="submit" class="login-btn">Log in →</button>
      </form>

      <a href="/manager/forgot-password" class="forgot">Forgot your password?</a>
      <hr class="divider" />
      <div class="footer-links">
        New to MostlyPostly? <a href="/manager/signup">Sign up</a>
      </div>
      <div style="text-align:center;margin-top:16px;">
        <a href="https://mostlypostly.com" style="font-size:12px;color:#7A7C85;text-decoration:none;">← Back to MostlyPostly</a>
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
  const planHint = ["starter","growth","pro"].includes(req.query.plan) ? req.query.plan : "";
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Create Account — MostlyPostly</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; min-height: 100vh; }
    .split-wrapper { display: flex; min-height: 100vh; }

    /* Left panel — matches login */
    .left-panel {
      flex: 1; background: #2B2D35; position: relative; overflow: hidden;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding: 48px 44px; gap: 24px;
    }
    .left-panel::before {
      content: ''; position: absolute; inset: 0;
      background-image: radial-gradient(circle, rgba(212,137,122,0.18) 1px, transparent 1px);
      background-size: 28px 28px; pointer-events: none;
    }
    .left-panel::after {
      content: ''; position: absolute; width: 400px; height: 400px; border-radius: 50%;
      background: radial-gradient(circle, rgba(212,137,122,0.22) 0%, transparent 70%);
      bottom: -100px; right: -100px; pointer-events: none;
    }
    .left-logo { width: 320px; height: auto; filter: brightness(0) invert(1); position: relative; z-index: 1; }
    .left-tagline { font-size: 14px; color: rgba(255,255,255,0.55); text-align: center; max-width: 280px; line-height: 1.7; position: relative; z-index: 1; }

    .feat-list { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 12px; position: relative; z-index: 1; }
    .feat-item {
      display: flex; align-items: flex-start; gap: 12px;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 14px 16px;
    }
    .feat-icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
    .feat-title { font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 2px; }
    .feat-desc { font-size: 11px; color: rgba(255,255,255,0.5); line-height: 1.5; }

    /* Right panel */
    .right-panel { flex: 1; background: #fff; display: flex; align-items: center; justify-content: center; padding: 32px; overflow-y: auto; }
    .signup-card { width: 100%; max-width: 420px; }
    .signup-card h1 { font-size: 24px; font-weight: 800; color: #2B2D35; margin-bottom: 6px; }
    .signup-card .sub { font-size: 13px; color: #7A7C85; margin-bottom: 28px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #2B2D35; margin-bottom: 5px; }
    .input-box {
      width: 100%; border-radius: 10px; padding: 11px 14px;
      border: 1px solid #EDE7E4; background: #FDF8F6;
      font-size: 14px; color: #2B2D35; margin-bottom: 16px; font-family: inherit;
    }
    .input-box:focus { border-color: #D4897A; outline: none; box-shadow: 0 0 0 3px rgba(212,137,122,0.15); }
    .check-row { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: #7A7C85; margin-bottom: 12px; }
    .check-row input { margin-top: 2px; accent-color: #D4897A; }
    .check-row a { color: #D4897A; font-weight: 600; text-decoration: none; }
    .check-row a:hover { text-decoration: underline; }
    .signup-btn {
      background: #2B2D35; color: #fff; font-weight: 700; border-radius: 999px;
      padding: 13px 0; width: 100%; font-size: 14px; border: none;
      cursor: pointer; transition: background 0.2s; font-family: inherit; margin-top: 4px;
    }
    .signup-btn:hover { background: #1a1c22; }
    .divider { border: none; border-top: 1px solid #EDE7E4; margin: 20px 0; }
    .footer-links { text-align: center; font-size: 13px; color: #7A7C85; }
    .footer-links a { color: #D4897A; font-weight: 600; text-decoration: none; }
    .footer-links a:hover { text-decoration: underline; }

    @media(max-width: 768px) {
      .split-wrapper { flex-direction: column; }
      .left-panel { min-height: 200px; padding: 32px 24px; gap: 16px; }
      .feat-list { display: none; }
    }
  </style>
</head>
<body>
<div class="split-wrapper">

  <div class="left-panel">
    <a href="https://mostlypostly.com" style="display:block;position:relative;z-index:1;">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" class="left-logo" />
    </a>
    <p class="left-tagline">Everything your salon needs to stay consistent and visible online — on autopilot.</p>
    <div class="feat-list">
      <div class="feat-item">
        <span class="feat-icon">📸</span>
        <div><div class="feat-title">Text a photo, get a post</div><div class="feat-desc">AI writes captions, hashtags &amp; CTAs tailored to salon work.</div></div>
      </div>
      <div class="feat-item">
        <span class="feat-icon">✅</span>
        <div><div class="feat-title">Manager approval built in</div><div class="feat-desc">Nothing goes live without your sign-off — from any device.</div></div>
      </div>
      <div class="feat-item">
        <span class="feat-icon">🎨</span>
        <div><div class="feat-title">Your brand, every post</div><div class="feat-desc">Tone, palette, hashtags — configured once, applied everywhere.</div></div>
      </div>
    </div>
  </div>

  <div class="right-panel">
    <div class="signup-card">
      <h1>Create your account</h1>
      <p class="sub">Get your salon set up in minutes.</p>

      <form action="/manager/signup" method="POST">
        <label>Your Name</label>
        <input type="text" name="name" class="input-box" placeholder="Your full name" required />
        <label>Business Name</label>
        <input type="text" name="businessName" class="input-box" placeholder="Your salon name" required />
        <label>Email</label>
        <input type="email" name="email" class="input-box" placeholder="you@yoursalon.com" required />
        <label>Password</label>
        <input type="password" name="password" class="input-box" placeholder="At least 8 characters" required minlength="8" />
        <label>Phone Number</label>
        <input type="tel" name="phone" class="input-box" placeholder="Mobile number" required />

        <input type="text" name="company" style="display:none" />
        <input type="hidden" name="plan" value="${planHint}" />

        <div class="check-row">
          <input type="checkbox" required />
          <span>I agree to MostlyPostly's <a href="/legal/terms.html">Terms</a> and <a href="/legal/privacy.html">Privacy Policy</a>.</span>
        </div>
        <div class="check-row">
          <input type="checkbox" name="marketing_opt_in" value="yes" />
          <span>Send me product updates and salon marketing tips.</span>
        </div>

        <button type="submit" class="signup-btn">Get Started →</button>
      </form>

      <hr class="divider" />
      <div class="footer-links">Already have an account? <a href="/manager/login">Sign in</a></div>
      <div style="text-align:center;margin-top:16px;">
        <a href="https://mostlypostly.com" style="font-size:12px;color:#7A7C85;text-decoration:none;">← Back to MostlyPostly</a>
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
    const planHint = ["starter","growth","pro"].includes(body.plan) ? body.plan : null;
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

    // Create salon slug from businessName (deduplicate if taken)
    const baseSlug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    let salonSlug = baseSlug;
    let slugSuffix = 2;
    while (db.prepare("SELECT id FROM salons WHERE slug = ?").get(salonSlug)) {
      salonSlug = `${baseSlug}-${slugSuffix++}`;
    }

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

      // Send founder promo code via SMS if configured
      const promoCode = process.env.FOUNDER_PROMO_CODE;
      if (promoCode && phone) {
        try {
          await sendViaTwilio(phone, `Welcome to MostlyPostly! 🎉 Your 14-day free trial starts when you select a plan. As a founding member, use promo code ${promoCode} at checkout to lock in your founder rate. Questions? Reply here anytime.`);
        } catch (smsErr) {
          console.warn("[signup] Promo SMS failed:", smsErr.message);
        }
      }

      const billingUrl = `/manager/billing?new=1&salon=${encodeURIComponent(salonSlug)}${planHint ? `&plan=${planHint}` : ""}`;
      return res.redirect(billingUrl);
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
  const sent = req.query.sent === "1";

  const cardContent = sent ? `
    <div style="text-align:center;padding:8px 0 24px;">
      <div style="width:56px;height:56px;border-radius:50%;background:#F2DDD9;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:26px;">📱</div>
      <h1 style="font-size:22px;font-weight:800;color:#2B2D35;margin-bottom:8px;">Check your texts</h1>
      <p style="font-size:13px;color:#7A7C85;line-height:1.6;margin-bottom:24px;">If an account exists for that email, we texted a secure reset link to the phone number on file. It expires in 45 minutes.</p>
      <a href="/manager/login" style="display:inline-block;background:#2B2D35;color:#fff;font-weight:700;border-radius:999px;padding:12px 28px;font-size:14px;text-decoration:none;">Back to Login</a>
    </div>
  ` : `
    <h1 style="font-size:22px;font-weight:800;color:#2B2D35;margin-bottom:6px;">Reset your password</h1>
    <p style="font-size:13px;color:#7A7C85;margin-bottom:24px;">Enter your email and we'll text you a secure reset link.</p>

    <form method="POST" action="/manager/forgot-password">
      <label style="display:block;font-size:12px;font-weight:600;color:#2B2D35;margin-bottom:5px;">Email address</label>
      <input type="email" name="email" required placeholder="you@yoursalon.com"
        style="width:100%;border-radius:10px;padding:11px 14px;border:1px solid #EDE7E4;background:#FDF8F6;font-size:14px;color:#2B2D35;margin-bottom:20px;font-family:inherit;box-sizing:border-box;" />
      <button type="submit"
        style="background:#2B2D35;color:#fff;font-weight:700;border-radius:999px;padding:13px 0;width:100%;font-size:14px;border:none;cursor:pointer;font-family:inherit;">
        Send reset link →
      </button>
    </form>
    <div style="text-align:center;margin-top:16px;">
      <a href="/manager/login" style="font-size:12px;color:#7A7C85;text-decoration:none;">← Back to login</a>
    </div>
  `;

  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Reset Password — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  </style>
</head>
<body>
  <div style="width:100%;max-width:420px;background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 32px rgba(43,45,53,0.08);border:1px solid #EDE7E4;">
    <div style="text-align:center;margin-bottom:28px;">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="width:240px;height:auto;" />
    </div>
    ${cardContent}
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
    return res.redirect("/manager/forgot-password?sent=1");
  }

  const manager = db
  .prepare(`SELECT id, phone FROM managers WHERE email = ?`)
  .get(email);

  if (!manager?.phone) {
    console.warn("⚠️ Password reset requested but manager has no phone:", email);
    return res.redirect("/manager/forgot-password?sent=1");
  }


  // Always respond success (prevents email enumeration)
  if (!manager) {
    return res.redirect("/manager/forgot-password?sent=1");
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


  return res.redirect("/manager/forgot-password?sent=1");
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
  <title>Set New Password — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  </style>
</head>
<body>
  <div style="width:100%;max-width:420px;background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 32px rgba(43,45,53,0.08);border:1px solid #EDE7E4;">

    <div style="text-align:center;margin-bottom:28px;">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="width:240px;height:auto;" />
    </div>

    <h1 style="font-size:22px;font-weight:800;color:#2B2D35;margin-bottom:6px;">Set a new password</h1>
    <p style="font-size:13px;color:#7A7C85;margin-bottom:24px;">Choose a secure password for your MostlyPostly account.</p>

    <form method="POST" action="/manager/reset-password">
      <input type="hidden" name="token" value="${safeToken}" />

      <label style="display:block;font-size:12px;font-weight:600;color:#2B2D35;margin-bottom:5px;">New password</label>
      <input type="password" name="password" required minlength="8" placeholder="At least 8 characters"
        style="width:100%;border-radius:10px;padding:11px 14px;border:1px solid #EDE7E4;background:#FDF8F6;font-size:14px;color:#2B2D35;margin-bottom:16px;font-family:inherit;" />

      <label style="display:block;font-size:12px;font-weight:600;color:#2B2D35;margin-bottom:5px;">Confirm new password</label>
      <input type="password" name="password_confirm" required minlength="8" placeholder="Re-enter password"
        style="width:100%;border-radius:10px;padding:11px 14px;border:1px solid #EDE7E4;background:#FDF8F6;font-size:14px;color:#2B2D35;margin-bottom:20px;font-family:inherit;" />

      <button type="submit"
        style="background:#2B2D35;color:#fff;font-weight:700;border-radius:999px;padding:13px 0;width:100%;font-size:14px;border:none;cursor:pointer;font-family:inherit;">
        Update password →
      </button>
    </form>

    <div style="text-align:center;margin-top:16px;">
      <a href="/manager/login" style="font-size:12px;color:#7A7C85;text-decoration:none;">← Back to login</a>
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
   GET /manager/logout
---------------------------------*/
router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/manager/login");
  });
});

export default router;
