// src/routes/tiktokAuth.js
import express from "express";
import crypto from "crypto";
import { db } from "../../db.js";

function requireAuth(req, res, next) {
  if (!req.session?.manager_id) return res.redirect("/manager/login");
  next();
}

const router = express.Router();

const TIKTOK_AUTH_URL  = "https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TIKTOK_USER_URL  = "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name";

// ── GET /auth/tiktok/login ────────────────────────────────────────────────────
router.get("/login", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/login");

  // PKCE
  const codeVerifier  = crypto.randomBytes(64).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  req.session.tiktok_pkce = { codeVerifier, salon_id };

  const params = new URLSearchParams({
    client_key:            process.env.TIKTOK_CLIENT_KEY,
    redirect_uri:          process.env.TIKTOK_REDIRECT_URI,
    response_type:         "code",
    scope:                 "user.info.basic,video.publish,video.upload",
    state:                 JSON.stringify({ salon_id }),
    code_challenge:        codeChallenge,
    code_challenge_method: "S256",
  });

  res.redirect(`${TIKTOK_AUTH_URL}?${params}`);
});

// ── GET /auth/tiktok/callback ─────────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("[TikTok OAuth] Error from TikTok:", error);
    return res.redirect("/manager/integrations?tiktok=error");
  }

  let salon_id;
  try {
    ({ salon_id } = JSON.parse(state));
  } catch {
    return res.redirect("/manager/integrations?tiktok=error");
  }

  const pkce = req.session.tiktok_pkce;
  if (!pkce || pkce.salon_id !== salon_id) {
    console.error("[TikTok OAuth] PKCE session mismatch");
    return res.redirect("/manager/integrations?tiktok=error");
  }
  delete req.session.tiktok_pkce;

  // Verify the salon_id from state belongs to the session manager (IDOR guard)
  const manager_id = req.session?.manager_id;
  if (!manager_id) {
    console.error("[TikTok OAuth] No session manager_id in callback");
    return res.redirect("/manager/login");
  }
  const salonOwned = db.prepare(
    `SELECT 1 FROM managers WHERE id = ? AND salon_id = ?`
  ).get(manager_id, salon_id);
  if (!salonOwned) {
    console.error(`[TikTok OAuth] Manager ${manager_id} does not own salon ${salon_id}`);
    return res.redirect("/manager/integrations?tiktok=error");
  }

  try {
    // 1. Exchange code for tokens
    const tokenResp = await fetch(TIKTOK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  process.env.TIKTOK_REDIRECT_URI,
        code_verifier: pkce.codeVerifier,
      }).toString(),
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const { access_token, refresh_token, expires_in, open_id } = tokens;
    const expiry = new Date(Date.now() + (expires_in || 86400) * 1000).toISOString();

    // 2. Fetch user display name
    const userResp = await fetch(TIKTOK_USER_URL, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const userData = await userResp.json();
    const username = userData.data?.user?.display_name || open_id;

    // 3. Save to DB
    db.prepare(`
      UPDATE salons SET
        tiktok_account_id    = ?,
        tiktok_username      = ?,
        tiktok_access_token  = ?,
        tiktok_refresh_token = ?,
        tiktok_token_expiry  = ?,
        tiktok_enabled       = 1
      WHERE slug = ?
    `).run(open_id, username, access_token, refresh_token, expiry, salon_id);

    console.log(`[TikTok] Connected salon ${salon_id} → @${username} (${open_id})`);
    res.redirect(`/manager/integrations?tiktok=connected`);

  } catch (err) {
    console.error("[TikTok OAuth] Callback error:", err.message);
    res.redirect("/manager/integrations?tiktok=error");
  }
});

// ── POST /auth/tiktok/disconnect ──────────────────────────────────────────────
router.post("/disconnect", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET
      tiktok_account_id    = NULL,
      tiktok_username      = NULL,
      tiktok_access_token  = NULL,
      tiktok_refresh_token = NULL,
      tiktok_token_expiry  = NULL,
      tiktok_enabled       = 0
    WHERE slug = ?
  `).run(salon_id);

  res.redirect("/manager/integrations?tiktok=disconnected");
});

// ── POST /auth/tiktok/toggle ──────────────────────────────────────────────────
router.post("/toggle", requireAuth, (req, res) => {
  const salon_id = req.session.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET tiktok_enabled = CASE WHEN tiktok_enabled = 1 THEN 0 ELSE 1 END
    WHERE slug = ?
  `).run(salon_id);

  res.redirect("/manager/integrations");
});

export default router;
