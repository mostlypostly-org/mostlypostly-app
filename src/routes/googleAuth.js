// src/routes/googleAuth.js
import express from "express";
import db from "../../db.js";

const router = express.Router();

const SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
].join(" ");

// ── GET /auth/google/login?salon=<slug> ──────────────────────────────────────
router.get("/login", (req, res) => {
  const salon_id = req.query.salon || req.session?.salon_id;
  if (!salon_id) return res.redirect("/manager/login");

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",
    prompt:        "consent",
    state:         JSON.stringify({ salon_id }),
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── GET /auth/google/callback ─────────────────────────────────────────────────
router.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error("[Google OAuth] Error from Google:", error);
    return res.redirect("/manager/integrations?gmb=error");
  }

  let salon_id;
  try {
    ({ salon_id } = JSON.parse(state));
  } catch {
    return res.redirect("/manager/integrations?gmb=error");
  }

  try {
    // 1. Exchange code for tokens
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    "authorization_code",
      }).toString(),
    });
    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.access_token) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }

    const accessToken  = tokens.access_token;
    const refreshToken = tokens.refresh_token;
    const expiry       = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // 2. Fetch GMB accounts
    const accountsResp = await fetch(
      "https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const accountsData = await accountsResp.json();
    const account = accountsData.accounts?.[0];
    if (!account) throw new Error("No Google Business accounts found.");

    // 3. Fetch locations
    const locResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const locData = await locResp.json();
    const locations = locData.locations || [];

    if (locations.length === 0) {
      throw new Error("No Google Business locations found on this account.");
    }

    // 4. If multiple locations, show picker
    if (locations.length > 1) {
      req.session.gmb_pending = { accessToken, refreshToken, expiry, salon_id };
      const opts = locations.map(l =>
        `<option value="${l.name}">${l.title}</option>`
      ).join("");
      return res.send(`
        <!DOCTYPE html><html><head><title>Choose Location</title>
        <link rel="stylesheet" href="https://cdn.tailwindcss.com">
        </head><body class="bg-gray-50 flex items-center justify-center min-h-screen">
        <div class="bg-white rounded-2xl border border-gray-200 p-8 max-w-md w-full shadow">
          <h1 class="text-lg font-bold mb-2">Choose Your Business Location</h1>
          <p class="text-sm text-gray-500 mb-4">Select the location to connect to this salon.</p>
          <form method="POST" action="/auth/google/select-location">
            <select name="location_name" class="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm mb-4">
              ${opts}
            </select>
            <button type="submit" class="w-full bg-blue-600 text-white rounded-xl py-2 text-sm font-semibold">Connect</button>
          </form>
        </div></body></html>
      `);
    }

    // 5. Single location — save directly
    const location = locations[0];
    await saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location });

    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=connected`);
  } catch (err) {
    console.error("[Google OAuth] Callback error:", err.message);
    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=error`);
  }
});

// ── POST /auth/google/select-location (multi-location picker) ────────────────
router.post("/select-location", async (req, res) => {
  const pending = req.session.gmb_pending;
  if (!pending) return res.redirect("/manager/integrations?gmb=error");

  const { accessToken, refreshToken, expiry, salon_id } = pending;
  const locationName = req.body.location_name;

  try {
    const locResp = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=name,title`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const location = await locResp.json();

    await saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location });
    delete req.session.gmb_pending;

    res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=connected`);
  } catch (err) {
    console.error("[Google OAuth] Select location error:", err.message);
    res.redirect("/manager/integrations?gmb=error");
  }
});

// ── POST /auth/google/disconnect ─────────────────────────────────────────────
router.post("/disconnect", (req, res) => {
  const salon_id = req.session?.salon_id || req.body?.salon_id;
  if (!salon_id) return res.redirect("/manager/integrations");

  db.prepare(`
    UPDATE salons SET
      google_location_id   = NULL,
      google_access_token  = NULL,
      google_refresh_token = NULL,
      google_business_name = NULL,
      google_token_expiry  = NULL,
      gmb_enabled          = 0
    WHERE slug = ?
  `).run(salon_id);

  res.redirect(`/manager/integrations?salon=${encodeURIComponent(salon_id)}&gmb=disconnected`);
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function saveGmbCredentials({ salon_id, accessToken, refreshToken, expiry, location }) {
  db.prepare(`
    UPDATE salons SET
      google_location_id   = ?,
      google_access_token  = ?,
      google_refresh_token = ?,
      google_business_name = ?,
      google_token_expiry  = ?
    WHERE slug = ?
  `).run(location.name, accessToken, refreshToken, location.title, expiry, salon_id);

  console.log(`[GMB] Connected salon ${salon_id} → ${location.title} (${location.name})`);
}

export default router;
