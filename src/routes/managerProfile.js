// src/routes/managerProfile.js
// Manager profile self-service: update name, email, phone, password, MFA.

import express from "express";
import bcrypt from "bcrypt";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) {
    return res.redirect("/manager/login");
  }
  next();
}

function safe(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── GET /manager/profile ────────────────────────────────────────────────────

router.get("/", requireAuth, (req, res) => {
  const { manager_id, salon_id } = req.session;
  const mgr = db.prepare(
    "SELECT id, name, email, phone, role, email_verified FROM managers WHERE id = ? AND salon_id = ?"
  ).get(manager_id, salon_id);
  if (!mgr) return res.redirect("/manager/login");

  const hasMfa = !!db.prepare("SELECT manager_id FROM manager_mfa WHERE manager_id = ?").get(manager_id);
  const flash  = req.query.success || req.query.error;
  const isSuccess = !!req.query.success;

  const flashBanner = flash ? `
    <div class="rounded-xl border px-4 py-3 text-sm mb-6 ${isSuccess
      ? "bg-green-50 border-green-200 text-green-800"
      : "bg-red-50 border-red-200 text-red-700"}">
      ${safe(flash)}
    </div>` : "";

  const inputCls = "w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-mpAccent";
  const labelCls = "block text-xs font-semibold text-mpMuted mb-1";
  const card     = (title, sub, content) => `
    <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
      <div class="mb-5">
        <h2 class="text-sm font-bold text-mpCharcoal">${title}</h2>
        ${sub ? `<p class="text-xs text-mpMuted mt-0.5">${sub}</p>` : ""}
      </div>
      ${content}
    </div>`;

  const body = `
    <div class="mb-6">
      <h1 class="text-2xl font-extrabold text-mpCharcoal">My Profile</h1>
      <p class="text-sm text-mpMuted mt-0.5">Manage your account details and security settings.</p>
    </div>

    ${flashBanner}

    <div class="space-y-5 max-w-2xl">

      ${card("Personal Info", "Your name as shown to stylists and in notifications.",`
        <form method="POST" action="/manager/profile/name">
          <div class="mb-4">
            <label class="${labelCls}">Full Name</label>
            <input type="text" name="name" value="${safe(mgr.name || "")}" required
              class="${inputCls}" />
          </div>
          <button type="submit" class="rounded-full bg-mpCharcoal px-5 py-2 text-xs font-bold text-white hover:bg-mpCharcoalDark transition-colors">
            Save Name
          </button>
        </form>
      `)}

      ${card("Email Address", "Used for login and password resets." + (mgr.email_verified ? "" : " <span class='text-amber-600 font-semibold'>Not verified</span>"), `
        <form method="POST" action="/manager/profile/email">
          <div class="mb-4">
            <label class="${labelCls}">Email</label>
            <input type="email" name="email" value="${safe(mgr.email || "")}" required
              class="${inputCls}" />
          </div>
          <button type="submit" class="rounded-full bg-mpCharcoal px-5 py-2 text-xs font-bold text-white hover:bg-mpCharcoalDark transition-colors">
            Update Email
          </button>
        </form>
      `)}

      ${card("Phone Number", "Used for SMS login links and approval notifications.", `
        <form method="POST" action="/manager/profile/phone">
          <div class="mb-4">
            <label class="${labelCls}">Mobile Number</label>
            <input type="tel" name="phone" value="${safe(mgr.phone || "")}" required
              placeholder="+1 (555) 000-0000"
              class="${inputCls}" />
          </div>
          <button type="submit" class="rounded-full bg-mpCharcoal px-5 py-2 text-xs font-bold text-white hover:bg-mpCharcoalDark transition-colors">
            Update Phone
          </button>
        </form>
      `)}

      ${card("Change Password", "Leave blank to keep your current password. Must be at least 8 characters.", `
        <form method="POST" action="/manager/profile/password">
          <div class="space-y-3 mb-4">
            <div>
              <label class="${labelCls}">Current Password</label>
              <input type="password" name="current_password" required autocomplete="current-password"
                class="${inputCls}" />
            </div>
            <div>
              <label class="${labelCls}">New Password</label>
              <input type="password" name="new_password" required autocomplete="new-password" minlength="8"
                class="${inputCls}" />
            </div>
            <div>
              <label class="${labelCls}">Confirm New Password</label>
              <input type="password" name="confirm_password" required autocomplete="new-password" minlength="8"
                class="${inputCls}" />
            </div>
          </div>
          <button type="submit" class="rounded-full bg-mpCharcoal px-5 py-2 text-xs font-bold text-white hover:bg-mpCharcoalDark transition-colors">
            Change Password
          </button>
        </form>
      `)}

      ${card("Two-Factor Authentication",
        hasMfa
          ? "MFA is <strong class='text-green-700'>enabled</strong> on your account. Use the options below if you're switching authenticator apps or lost access."
          : "MFA is <strong class='text-amber-600'>not enabled</strong>. We strongly recommend enabling it to protect your account.",
        hasMfa ? `
          <div class="flex flex-wrap gap-3">
            <a href="/manager/mfa/setup"
              class="inline-flex items-center gap-1.5 rounded-full border border-mpBorder bg-mpBg px-5 py-2 text-xs font-semibold text-mpCharcoal hover:border-mpAccent transition-colors">
              Re-enroll Authenticator App
            </a>
            <form method="POST" action="/manager/profile/mfa-disable">
              <div class="flex items-center gap-2">
                <input type="password" name="password" required placeholder="Confirm password to disable"
                  class="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-400" />
                <button type="submit"
                  class="rounded-full border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                  onclick="return confirm('Disable MFA? Your account will only be protected by your password.')">
                  Disable MFA
                </button>
              </div>
            </form>
          </div>
        ` : `
          <a href="/manager/mfa/setup"
            class="inline-flex items-center gap-2 rounded-full bg-mpAccent px-5 py-2.5 text-xs font-bold text-white hover:bg-[#2E5E9E] transition-colors">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.955 11.955 0 003 10c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>
            Enable Two-Factor Authentication
          </a>
        `
      )}

    </div>
  `;

  res.send(pageShell({ title: "My Profile", current: "profile", salon_id, body }));
});

// ─── POST /manager/profile/name ──────────────────────────────────────────────

router.post("/name", requireAuth, (req, res) => {
  const { manager_id, salon_id } = req.session;
  const name = (req.body.name || "").trim();
  if (!name) return res.redirect("/manager/profile?error=Name+cannot+be+empty");
  db.prepare("UPDATE managers SET name = ?, updated_at = datetime('now') WHERE id = ? AND salon_id = ?")
    .run(name, manager_id, salon_id);
  res.redirect("/manager/profile?success=Name+updated");
});

// ─── POST /manager/profile/email ─────────────────────────────────────────────

router.post("/email", requireAuth, (req, res) => {
  const { manager_id, salon_id } = req.session;
  const email = (req.body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.redirect("/manager/profile?error=Invalid+email+address");

  const conflict = db.prepare("SELECT id FROM managers WHERE email = ? AND id != ?").get(email, manager_id);
  if (conflict) return res.redirect("/manager/profile?error=That+email+is+already+in+use");

  db.prepare("UPDATE managers SET email = ?, email_verified = 0, updated_at = datetime('now') WHERE id = ? AND salon_id = ?")
    .run(email, manager_id, salon_id);
  res.redirect("/manager/profile?success=Email+updated.+Please+verify+your+new+address.");
});

// ─── POST /manager/profile/phone ─────────────────────────────────────────────

router.post("/phone", requireAuth, (req, res) => {
  const { manager_id, salon_id } = req.session;
  const raw    = (req.body.phone || "").replace(/\D/g, "");
  const phone  = raw.length === 10 ? `+1${raw}` : raw.length === 11 && raw.startsWith("1") ? `+${raw}` : null;
  if (!phone) return res.redirect("/manager/profile?error=Invalid+phone+number");

  db.prepare("UPDATE managers SET phone = ?, updated_at = datetime('now') WHERE id = ? AND salon_id = ?")
    .run(phone, manager_id, salon_id);
  res.redirect("/manager/profile?success=Phone+number+updated");
});

// ─── POST /manager/profile/password ──────────────────────────────────────────

router.post("/password", requireAuth, async (req, res) => {
  const { manager_id, salon_id } = req.session;
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password)
    return res.redirect("/manager/profile?error=All+password+fields+are+required");
  if (new_password !== confirm_password)
    return res.redirect("/manager/profile?error=New+passwords+do+not+match");
  if (new_password.length < 8)
    return res.redirect("/manager/profile?error=Password+must+be+at+least+8+characters");

  const mgr = db.prepare("SELECT password_hash FROM managers WHERE id = ? AND salon_id = ?").get(manager_id, salon_id);
  if (!mgr?.password_hash) return res.redirect("/manager/profile?error=No+password+set+on+this+account");

  const valid = await bcrypt.compare(current_password, mgr.password_hash);
  if (!valid) return res.redirect("/manager/profile?error=Current+password+is+incorrect");

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE managers SET password_hash = ?, updated_at = datetime('now') WHERE id = ? AND salon_id = ?")
    .run(hash, manager_id, salon_id);
  res.redirect("/manager/profile?success=Password+changed+successfully");
});

// ─── POST /manager/profile/mfa-disable ───────────────────────────────────────

router.post("/mfa-disable", requireAuth, async (req, res) => {
  const { manager_id, salon_id } = req.session;
  const { password } = req.body;

  const mgr = db.prepare("SELECT password_hash FROM managers WHERE id = ? AND salon_id = ?").get(manager_id, salon_id);
  if (!mgr?.password_hash) return res.redirect("/manager/profile?error=Cannot+verify+identity");

  const valid = await bcrypt.compare(password || "", mgr.password_hash);
  if (!valid) return res.redirect("/manager/profile?error=Incorrect+password");

  db.prepare("DELETE FROM manager_mfa WHERE manager_id = ?").run(manager_id);
  res.redirect("/manager/profile?success=MFA+has+been+disabled.+You+can+re-enable+it+any+time.");
});

export default router;
