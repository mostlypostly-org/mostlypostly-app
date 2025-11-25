// src/routes/managerAuth.js

import express from "express";
import bcrypt from "bcryptjs";
import { db } from "../../db.js";

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
      SELECT *
      FROM manager_tokens
      WHERE token = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `
    )
    .get(token);

  return row || null;
}

/* -------------------------------
   GET: /manager/login
   - If ?token is present, treat as magic link:
     - validate token
     - set session
     - redirect to /manager
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
          `<h2>Invalid or expired login link</h2><p>Please request a new manager approval link.</p>`
        );
    }

    // Mark token as used (optional, but safer)
    db.prepare(
      `UPDATE manager_tokens SET used_at = datetime('now') WHERE token = ?`
    ).run(token);

    // Create session and redirect to manager dashboard
    req.session.manager_id = row.manager_id;
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

  <!-- Tailwind CDN -->
  <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">

  <style>
    body {
      background: #F6F7FB;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      color: #202330;
    }

    .login-card {
      background: #FFFFFF;
      border-radius: 20px;
      padding: 40px;
      border: 1px solid rgba(116,134,195,0.18);
      box-shadow: 0 20px 50px rgba(32, 35, 48, 0.08);
      transition: all 0.2s ease;
    }

    .login-card:hover {
      box-shadow: 0 26px 60px rgba(32, 35, 48, 0.12);
    }

    .mp-logo {
      height: 54px;
      width: 54px;
      border-radius: 16px;
      background: linear-gradient(135deg, #7486C3, #5C6FA8);
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 14px;
      font-weight: 600;
      margin: 0 auto 12px auto;
    }
  </style>
</head>

<body>
  <div class="min-h-screen flex flex-col justify-center items-center px-6">

    <!-- Logo + Title -->
    <div class="text-center mb-6">
      <div class="mp-logo">MP</div>
      <h1 class="text-xl font-semibold tracking-tight text-[#202330]">MostlyPostly</h1>
      <p class="text-xs mt-1 text-[#656B80]">Salon Manager Login</p>
    </div>

    <!-- LOGIN CARD -->
    <div class="login-card w-full max-w-md">

      <h2 class="text-lg font-semibold text-center mb-5">Welcome back</h2>

      <form method="POST" action="/manager/login" class="space-y-4">

        <!-- Email -->
        <label class="block">
          <span class="text-xs text-[#656B80]">Email address</span>
          <input
            type="email"
            name="email"
            required
            class="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-[#202330] focus:outline-none focus:ring-2 focus:ring-[#7486C3]/70"
          />
        </label>

        <!-- Password -->
        <label class="block">
          <span class="text-xs text-[#656B80]">Password</span>
          <input
            type="password"
            name="password"
            required
            class="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-[#202330] focus:outline-none focus:ring-2 focus:ring-[#7486C3]/70"
          />
        </label>

        <!-- Login Button -->
        <button
          type="submit"
          class="w-full mt-2 rounded-full bg-[#7486C3] py-3 text-sm font-semibold text-white hover:bg-[#5C6FA8] shadow-md shadow-[#7486C3]/30">
          Log in
        </button>

      </form>

      <!-- Forgot Password -->
      <div class="mt-4 text-center">
        <a href="/manager/forgot-password" class="text-xs text-[#7486C3] hover:underline">
          Forgot your password?
        </a>
      </div>

      <!-- Divider -->
      <div class="my-6 border-t border-slate-200"></div>

      <!-- Sign Up -->
      <div class="text-center text-sm">
        <span class="text-[#656B80]">Not registered yet?</span>
        <a href="/manager/signup" class="text-[#7486C3] font-medium hover:underline">
          Create an account
        </a>
      </div>

    </div>

    <!-- Legal -->
    <div class="text-center mt-6 text-xs text-[#656B80]">
      By continuing, you agree to our
      <a href="/legal/terms.html" class="text-[#7486C3] hover:underline">Terms</a> and
      <a href="/legal/privacy.html" class="text-[#7486C3] hover:underline">Privacy Policy</a>.
    </div>

  </div>
</body>
</html>
  `);
});

/* -------------------------------
   POST: /manager/login
   - Standard email/password login
---------------------------------*/
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  // Make sure schema has email + password_hash
  const cols = db.prepare("PRAGMA table_info(managers)").all();
  const hasEmail = cols.some((c) => c.name === "email");
  const hasHash = cols.some((c) => c.name === "password_hash");

  if (!hasEmail || !hasHash) {
    return res
      .status(500)
      .type("html")
      .send(
        `<h2>Email login not available yet</h2><p>Your account has not been upgraded for password login.</p>`
      );
  }

  const mgr = db.prepare(`SELECT * FROM managers WHERE email = ?`).get(email);
  if (!mgr) {
    return res.status(401).type("html").send("Invalid login");
  }

  const ok = bcrypt.compareSync(password, mgr.password_hash || "");
  if (!ok) {
    return res.status(401).type("html").send("Invalid password");
  }

  req.session.manager_id = mgr.id;
  return res.redirect("/manager");
});

/* -------------------------------
   GET: /manager/signup (placeholder)
---------------------------------*/
router.get("/signup", (req, res) => {
  res
    .status(200)
    .type("html")
    .send(
      `<h2>Signup coming soon</h2><p>You will be able to create accounts here.</p><a href="/manager/login">Back to login</a>`
    );
});

router.post("/signup", (req, res) => {
  return res.type("html").send("Signup disabled for now.");
});

/* -------------------------------
   GET: /manager/forgot-password (placeholder)
---------------------------------*/
router.get("/forgot-password", (req, res) => {
  res
    .status(200)
    .type("html")
    .send(
      `<h2>Password reset coming soon</h2><p>Reset emails will be available once mail service is active.</p><a href="/manager/login">Back to login</a>`
    );
});

/* -------------------------------
   GET: /manager/login-with-token
   - Backwards-compatible: just redirect into /manager/login?token=...
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

export default router;
