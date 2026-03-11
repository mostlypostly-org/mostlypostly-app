// src/routes/facebookAuth.js
import express from "express";
import fetch from "node-fetch";
import { db } from "../../db.js";

const router = express.Router();

const FB_OAUTH_URL = "https://www.facebook.com/v21.0/dialog/oauth";
const FB_TOKEN_URL = "https://graph.facebook.com/v21.0/oauth/access_token";
const FB_API_URL = "https://graph.facebook.com/v21.0";

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
      "pages_read_user_content",
      "read_insights",
      "instagram_basic",
      "instagram_content_publish",
      "instagram_manage_insights",
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

  // Exchange short-lived user token for long-lived user token (60-day)
  // Page tokens derived from long-lived user tokens never expire
  const llParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: tokenJson.access_token,
  });
  const llResp = await fetch(`${FB_TOKEN_URL}?${llParams}`);
  const llJson = await llResp.json();
  const userAccessToken = llJson.access_token || tokenJson.access_token;

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
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Facebook Connected — MostlyPostly</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: ‘Plus Jakarta Sans’, ui-sans-serif, system-ui, sans-serif; background: #FDF8F6; color: #2B2D35; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  </style>
</head>
<body>
  <div style="width:100%;max-width:440px;background:#fff;border-radius:20px;padding:40px 36px;box-shadow:0 4px 32px rgba(43,45,53,0.08);border:1px solid #EDE7E4;text-align:center;">
    <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" style="width:240px;height:auto;margin-bottom:28px;" />

    <div style="width:60px;height:60px;border-radius:50%;background:#EBF3FF;display:flex;align-items:center;justify-content:center;margin:0 auto 18px;font-size:28px;">✓</div>

    <h1 style="font-size:22px;font-weight:800;color:#2B2D35;margin-bottom:8px;">Facebook Connected!</h1>
    <p style="font-size:13px;color:#7A7C85;margin-bottom:24px;line-height:1.6;">Your Facebook page and Instagram account have been linked to your salon.</p>

    <div style="background:#FDF8F6;border:1px solid #EDE7E4;border-radius:12px;padding:16px 20px;margin-bottom:28px;text-align:left;">
      <div style="font-size:12px;font-weight:700;color:#7A7C85;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:10px;">Connected accounts</div>
      <div style="font-size:13px;color:#2B2D35;margin-bottom:6px;">
        <span style="color:#7A7C85;">Facebook page:</span> ${page.name}
      </div>
      <div style="font-size:13px;color:#2B2D35;">
        <span style="color:#7A7C85;">Instagram:</span> ${instagramUsername ? "@" + instagramUsername : "Not detected"}
      </div>
    </div>

    <a href="/manager/admin?salon=${salon_id}"
      style="display:inline-block;background:#2B2D35;color:#fff;font-weight:700;border-radius:999px;padding:13px 32px;font-size:14px;text-decoration:none;">
      Return to Admin →
    </a>
  </div>
</body>
</html>
  `);
});

export default router;
