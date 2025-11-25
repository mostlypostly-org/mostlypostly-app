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
  <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">
  <style>
    body { background: #0B1223; }
    .card {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 32px;
    }
    .mp-logo {
      width: 52px;
      margin: 0 auto 12px;
      display: block;
    }
    .footer-text {
      font-size: 12px;
      color: #8892a6;
    }
  </style>
</head>

<body class="text-gray-200">
  <div class="min-h-screen flex flex-col justify-center items-center px-4">
    <div class="card w-full max-w-md mt-4">
      <h2 class="text-center text-3xl font-bold mb-6">Sign In</h2>

      <form method="POST" action="/manager/login">
        <label class="block mb-3">
          <span class="text-gray-300 text-sm">Email Address</span>
          <input type="email" name="email" required
            class="mt-1 w-full p-3 rounded bg-gray-800 border border-gray-700 text-gray-200 focus:ring focus:ring-blue-500" />
        </label>

        <label class="block mb-4">
          <span class="text-gray-300 text-sm">Password</span>
          <input type="password" name="password" required
            class="mt-1 w-full p-3 rounded bg-gray-800 border border-gray-700 text-gray-200 focus:ring focus:ring-blue-500" />
        </label>

        <button type="submit"
          class="w-full py-3 bg-blue-600 hover:bg-blue-700 rounded text-white font-semibold transition">
          Sign In
        </button>

        <div class="flex justify-between text-sm mt-3">
          <a href="/manager/forgot-password" class="text-blue-400 hover:underline">Forgot password?</a>
          <a href="/manager/signup" class="text-blue-400 hover:underline">Create Account</a>
        </div>
      </form>

      <div class="mt-6 text-center footer-text">
        By continuing, you agree to our
        <a href="/legal/terms" class="text-blue-400 hover:underline">Terms of Service</a>
        and
        <a href="/legal/privacy" class="text-blue-400 hover:underline">Privacy Policy</a>.
      </div>
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
