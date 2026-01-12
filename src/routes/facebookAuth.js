// src/routes/facebookAuth.js
import express from "express";
import fetch from "node-fetch";
import { db } from "../../db.js";

const router = express.Router();

const FB_OAUTH_URL = "https://www.facebook.com/v19.0/dialog/oauth";
const FB_TOKEN_URL = "https://graph.facebook.com/v19.0/oauth/access_token";
const FB_API_URL = "https://graph.facebook.com/v19.0";

function getRedirectUri() {
  const uri = process.env.FB_REDIRECT_URI;
  if (!uri) throw new Error("FB_REDIRECT_URI missing in .env");
  return uri;
}

/* -------------------------------------------------------
 * STEP 1 — START FACEBOOK LOGIN
 * -----------------------------------------------------*/
router.get("/login", (req, res) => {
  const salonFromQuery = req.query.salon;
  const salonFromManager = req.manager?.salon_id;
  const salon_id = salonFromQuery || salonFromManager || "unknown";

  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_metadata",
      "instagram_basic",
      "instagram_content_publish",
      "business_management",
    ].join(","),
    state: JSON.stringify({ salon_id }),
  });

  return res.redirect(`${FB_OAUTH_URL}?${params.toString()}`);
});

/* -------------------------------------------------------
 * STEP 2 — FACEBOOK CALLBACK 
 * SAVE PAGE + INSTAGRAM DATA INTO salons TABLE
 * -----------------------------------------------------*/
router.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  let salon_id = "unknown";
  try {
    salon_id = JSON.parse(state)?.salon_id || "unknown";
  } catch {}

  const clientId = process.env.FACEBOOK_APP_ID;
  const clientSecret = process.env.FACEBOOK_APP_SECRET;
  const redirectUri = getRedirectUri();

  // Exchange "code" for USER ACCESS TOKEN
  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code
  });

  const tokenResp = await fetch(`${FB_TOKEN_URL}?${tokenParams}`);
  const tokenJson = await tokenResp.json();

  if (!tokenJson.access_token) {
    return res.status(400).send("<h2>Facebook Error: No access token returned.</h2>");
  }

  const userAccessToken = tokenJson.access_token;

  // Fetch Facebook Pages this user manages
  const pagesResp = await fetch(
    `${FB_API_URL}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userAccessToken}`
  );
  const pagesJson = await pagesResp.json();
  const pages = pagesJson.data || [];

  if (!pages.length) {
    return res.send("<h2>No Facebook Pages associated with this account.</h2>");
  }

  // --- OPTION: pick the first page automatically ---
  const page = pages[0];

  // Fetch Instagram business account details (if available)
  let instagramBusinessId = null;
  let instagramUsername = null;

  if (page.instagram_business_account?.id) {
    instagramBusinessId = page.instagram_business_account.id;

    const igResp = await fetch(
      `${FB_API_URL}/${instagramBusinessId}?fields=username&access_token=${page.access_token}`
    );
    const igJson = await igResp.json();

    instagramUsername = igJson.username || null;
  }

  // ---------------------------------------------------
  // SAVE ALL FACEBOOK + INSTAGRAM DATA INTO DATABASE
  // ---------------------------------------------------
  db.prepare(
    `
    UPDATE salons
    SET
      facebook_page_id        = ?,
      facebook_page_token     = ?,
      instagram_business_id   = ?,
      instagram_handle        = ?,
      updated_at              = datetime('now')
    WHERE slug = ?
    `
  ).run(
    page.id,
    page.access_token,
    instagramBusinessId,
    instagramUsername,
    salon_id
  );

  // Redirect back to Admin UI
  return res.send(`
    <h1>🎉 Facebook Connected!</h1>
    <p>Page: ${page.name} (ID: ${page.id})</p>
    <p>Instagram: ${instagramUsername || "None detected"}</p>
    <p>Data saved to your salon’s database record.</p>
    <p><a href="/manager/admin?salon=${salon_id}">Return to Admin</a></p>
  `);
});

export default router;
