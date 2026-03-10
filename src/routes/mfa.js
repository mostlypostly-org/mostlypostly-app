// src/routes/mfa.js
// TOTP-based Multi-Factor Authentication for manager accounts.
//
// Flow:
//   1. Manager opts in from Admin → Account Security
//   2. GET /manager/mfa/setup  → show QR code + secret
//   3. POST /manager/mfa/setup → verify first code, save encrypted secret + backup codes
//   4. On future logins: after password check, redirect to /manager/mfa/verify
//   5. POST /manager/mfa/verify → TOTP code or backup code → complete login
//   6. POST /manager/mfa/disable → turn off MFA (requires password confirmation)

import express from "express";
import { generateSecret, verifySync, generateURI } from "otplib";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import db from "../../db.js";
import { encrypt, decrypt } from "../core/encrypt.js";
import { logSecurityEvent } from "../core/auditLog.js";

const router = express.Router();

const APP_NAME = "MostlyPostly";
const BACKUP_CODE_COUNT = 8;

// ─── Helpers ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.manager?.manager_phone && !req.manager?.id) {
    return res.redirect("/manager/login");
  }
  next();
}

function generateBackupCodes() {
  // 8 codes, each 10 hex characters grouped as XXXXX-XXXXX
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

function mfaShell(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title} — MostlyPostly</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Plus Jakarta Sans', sans-serif; background: #FDF8F6; color: #2B2D35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { width: 100%; max-width: 440px; background: #fff; border-radius: 20px; padding: 40px 36px; box-shadow: 0 4px 32px rgba(43,45,53,0.08); border: 1px solid #EDE7E4; }
    .logo { text-align: center; margin-bottom: 28px; }
    .logo img { width: 200px; height: auto; }
    h1 { font-size: 20px; font-weight: 800; color: #2B2D35; margin-bottom: 6px; }
    p { font-size: 13px; color: #7A7C85; line-height: 1.6; margin-bottom: 16px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #2B2D35; margin-bottom: 5px; }
    input[type=text], input[type=password] { width: 100%; border-radius: 10px; padding: 11px 14px; border: 1px solid #EDE7E4; background: #FDF8F6; font-size: 14px; color: #2B2D35; margin-bottom: 16px; font-family: inherit; }
    input[type=text]:focus, input[type=password]:focus { outline: none; border-color: #D4897A; }
    .btn { background: #2B2D35; color: #fff; font-weight: 700; border-radius: 999px; padding: 13px 0; width: 100%; font-size: 14px; border: none; cursor: pointer; font-family: inherit; }
    .btn:hover { background: #1a1c22; }
    .btn-ghost { background: transparent; color: #7A7C85; border: 1px solid #EDE7E4; margin-top: 10px; }
    .btn-ghost:hover { color: #2B2D35; background: #FDF8F6; }
    .error { background: #FEE2E2; border: 1px solid #FECACA; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #B91C1C; margin-bottom: 14px; }
    .success { background: #D1FAE5; border: 1px solid #A7F3D0; border-radius: 10px; padding: 10px 14px; font-size: 13px; color: #065F46; margin-bottom: 14px; }
    .back { text-align: center; margin-top: 14px; font-size: 12px; }
    .back a { color: #7A7C85; text-decoration: none; }
    .back a:hover { color: #2B2D35; }
    .backup-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
    .backup-code { font-family: monospace; font-size: 13px; font-weight: 700; background: #F3F4F6; border-radius: 6px; padding: 6px 10px; text-align: center; letter-spacing: 1px; }
    .qr-wrap { text-align: center; margin: 16px 0; }
    .secret-box { font-family: monospace; font-size: 12px; background: #F3F4F6; border-radius: 8px; padding: 10px 14px; word-break: break-all; margin: 8px 0 16px; color: #2B2D35; }
    .otp-input { font-size: 22px; font-weight: 700; letter-spacing: 8px; text-align: center; font-family: monospace; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" /></div>
    ${content}
  </div>
</body>
</html>`;
}

// ─── GET /manager/mfa/setup ─────────────────────────────────────
router.get("/setup", requireAuth, async (req, res) => {
  const managerId = req.manager.id;

  // Already enrolled?
  const existing = db.prepare("SELECT manager_id FROM manager_mfa WHERE manager_id = ?").get(managerId);
  if (existing) {
    return res.redirect("/manager/admin?mfa=already_enabled");
  }

  // Generate a fresh secret for this setup session
  if (!req.session.mfaPendingSecret) {
    req.session.mfaPendingSecret = generateSecret();
  }
  const secret = req.session.mfaPendingSecret;

  const managerEmail = req.manager.email || req.manager.name || "manager";
  const otpAuthUrl = generateURI({ strategy: "totp", label: managerEmail, issuer: APP_NAME, secret });

  // Generate QR code as base64 data URI (no external service needed)
  const qrDataUrl = await QRCode.toDataURL(otpAuthUrl, { width: 200, margin: 1 });

  const error = req.query.error === "1" ? `<div class="error">Incorrect code — please try again.</div>` : "";

  res.send(mfaShell("Set Up Two-Factor Auth", `
    <h1>Set up two-factor auth</h1>
    <p>Scan this QR code with your authenticator app (Google Authenticator, Authy, or 1Password), then enter the 6-digit code to confirm.</p>
    ${error}
    <div class="qr-wrap">
      <img src="${qrDataUrl}" width="200" height="200" alt="QR Code" style="border-radius:12px;border:1px solid #EDE7E4;" />
    </div>
    <p style="margin-bottom:4px">Can't scan? Enter this secret manually:</p>
    <div class="secret-box">${secret}</div>
    <form method="POST" action="/manager/mfa/setup">
      <label>Enter the 6-digit code from your app</label>
      <input type="text" name="code" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required autofocus />
      <button type="submit" class="btn">Verify & Enable →</button>
    </form>
    <div class="back"><a href="/manager/admin">← Cancel</a></div>
  `));
});

// ─── POST /manager/mfa/setup ────────────────────────────────────
router.post("/setup", requireAuth, (req, res) => {
  const managerId = req.manager.id;
  const code = (req.body.code || "").trim().replace(/\s/g, "");
  const secret = req.session.mfaPendingSecret;

  if (!secret) return res.redirect("/manager/mfa/setup");

  const verifyResult = verifySync({ token: code, secret });
  const valid = verifyResult && verifyResult.valid;
  if (!valid) {
    logSecurityEvent({ eventType: "mfa_enrolled", managerId, req, metadata: { result: "failed_verify" } });
    return res.redirect("/manager/mfa/setup?error=1");
  }

  // Generate backup codes
  const plainCodes = generateBackupCodes();
  const hashedCodes = plainCodes.map(c => bcrypt.hashSync(c, 10));

  // Store encrypted secret + hashed backup codes
  db.prepare(
    `INSERT INTO manager_mfa (manager_id, totp_secret, backup_codes)
     VALUES (?, ?, ?)
     ON CONFLICT(manager_id) DO UPDATE SET
       totp_secret  = excluded.totp_secret,
       backup_codes = excluded.backup_codes,
       enabled_at   = datetime('now')`
  ).run(managerId, encrypt(secret), JSON.stringify(hashedCodes));

  // Clear pending secret from session
  delete req.session.mfaPendingSecret;

  logSecurityEvent({ eventType: "mfa_enrolled", managerId, salonId: req.manager.salon_id, req, metadata: { result: "success" } });

  // Show backup codes — displayed once, never again
  const codesHtml = plainCodes.map(c => `<div class="backup-code">${c}</div>`).join("");

  req.session.save(() => {
    res.send(mfaShell("MFA Enabled — Save Your Backup Codes", `
      <h1>MFA enabled! ✅</h1>
      <p>Two-factor authentication is now active on your account. Save these backup codes somewhere safe — each can only be used once if you lose access to your authenticator app.</p>
      <div class="backup-grid">${codesHtml}</div>
      <p style="font-size:11px;color:#D4897A;font-weight:600;">These codes won't be shown again. Screenshot or write them down now.</p>
      <a href="/manager/admin" class="btn" style="display:block;text-align:center;text-decoration:none;margin-top:16px;">Done — Go to Admin →</a>
    `));
  });
});

// ─── GET /manager/mfa/verify ────────────────────────────────────
// Shown after password login when MFA is enabled.
// Session has req.session.pendingMfaManagerId set by login handler.
router.get("/verify", (req, res) => {
  if (!req.session.pendingMfaManagerId) {
    return res.redirect("/manager/login");
  }
  const error = req.query.error === "1" ? `<div class="error">Incorrect code — please try again. Or enter a backup code.</div>` : "";

  res.send(mfaShell("Two-Factor Verification", `
    <h1>Two-factor verification</h1>
    <p>Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
    ${error}
    <form method="POST" action="/manager/mfa/verify">
      <label>Authentication code</label>
      <input type="text" name="code" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="000000" required autofocus />
      <button type="submit" class="btn">Verify →</button>
    </form>
    <div class="back"><a href="/manager/login">← Back to login</a></div>
  `));
});

// ─── POST /manager/mfa/verify ───────────────────────────────────
router.post("/verify", async (req, res) => {
  const pendingId = req.session.pendingMfaManagerId;
  if (!pendingId) return res.redirect("/manager/login");

  const code = (req.body.code || "").trim().replace(/\s/g, "").toUpperCase();

  const mfaRow = db.prepare("SELECT * FROM manager_mfa WHERE manager_id = ?").get(pendingId);
  if (!mfaRow) {
    // MFA row gone — skip (shouldn't happen)
    return completeMfaLogin(req, res, pendingId);
  }

  const secret = decrypt(mfaRow.totp_secret);

  // Try TOTP first
  if (/^\d{6}$/.test(code)) {
    const verifyResult = verifySync({ token: code, secret });
    if (verifyResult && verifyResult.valid) {
      logSecurityEvent({ eventType: "login_success", managerId: pendingId, req, metadata: { method: "mfa_totp" } });
      return completeMfaLogin(req, res, pendingId);
    }
  }

  // Try backup codes
  let backupCodes = [];
  try { backupCodes = JSON.parse(mfaRow.backup_codes || "[]"); } catch {}

  // Format: XXXXX-XXXXX — normalize input to match
  const normalizedCode = code.replace(/[^A-Z0-9]/g, "");
  const formattedCode = `${normalizedCode.slice(0,5)}-${normalizedCode.slice(5)}`;

  const matchIndex = backupCodes.findIndex(hash => bcrypt.compareSync(formattedCode, hash));
  if (matchIndex !== -1) {
    // Consume the backup code (replace with spent marker)
    backupCodes[matchIndex] = "USED";
    db.prepare("UPDATE manager_mfa SET backup_codes = ? WHERE manager_id = ?")
      .run(JSON.stringify(backupCodes), pendingId);
    logSecurityEvent({ eventType: "mfa_bypass_used", managerId: pendingId, req });
    return completeMfaLogin(req, res, pendingId);
  }

  // Failed
  logSecurityEvent({ eventType: "login_mfa_failure", managerId: pendingId, req });
  return res.redirect("/manager/mfa/verify?error=1");
});

async function completeMfaLogin(req, res, managerId) {
  const manager = db.prepare("SELECT * FROM managers WHERE id = ?").get(managerId);
  if (!manager) return res.redirect("/manager/login");

  const groupRow = db.prepare("SELECT group_id FROM salons WHERE slug = ?").get(manager.salon_id);

  req.session.regenerate((err) => {
    if (err) return res.redirect("/manager/login");
    req.session.manager_id    = manager.id;
    req.session.salon_id      = manager.salon_id;
    req.session.group_id      = groupRow?.group_id || null;
    req.session.manager_email = manager.email;
    req.session.save(() => res.redirect("/manager"));
  });
}

// ─── POST /manager/mfa/disable ──────────────────────────────────
router.post("/disable", requireAuth, async (req, res) => {
  const managerId = req.manager.id;
  const { password } = req.body;

  const manager = db.prepare("SELECT password_hash FROM managers WHERE id = ?").get(managerId);
  if (!manager?.password_hash || !bcrypt.compareSync(password, manager.password_hash)) {
    return res.redirect("/manager/admin?mfa_error=wrong_password");
  }

  db.prepare("DELETE FROM manager_mfa WHERE manager_id = ?").run(managerId);
  logSecurityEvent({ eventType: "mfa_disabled", managerId, salonId: req.manager.salon_id, req });
  res.redirect("/manager/admin?mfa=disabled");
});

export default router;
