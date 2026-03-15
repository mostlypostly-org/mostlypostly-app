// =====================================================
// Core imports
// =====================================================
import "./src/env.js";

import fs from "fs";
import bodyParser from "body-parser";
import twilio from "twilio";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import fetch from "node-fetch";
import http from "http";
import { Server } from "socket.io";
import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import csrfProtection from "./src/middleware/csrf.js";
// teamsRoute disabled until botbuilder dependency is added to package.json
// import teamsRoute from "./src/routes/teams.js";


// =====================================================
// Load salons BEFORE routes (legacy JSON loader only)
// =====================================================
if (process.env.APP_ENV === "local") {
  await loadSalons();
  startSalonWatcher();
  console.log("💇 Local: salons.json loader active.");
} else {
  console.log("💇 Staging/Prod: DISABLED salons.json loader.");
}

// =====================================================
// Analytics bootstrap
// =====================================================
import "./src/core/analyticsDb.js";

// =====================================================
// DB
// =====================================================
import { db } from "./db.js";
import { UPLOADS_DIR } from "./src/core/uploadPath.js";

// =====================================================
// Middleware imports
// =====================================================
import tenantFromLink from "./src/middleware/tenantFromLink.js";

// =====================================================
// Core Logic
// =====================================================
import { composeFinalCaption } from "./src/core/composeFinalCaption.js";
import { generateCaption } from "./src/openai.js";
import {
  handleJoinCommand,
  continueJoinConversation,
} from "./src/core/joinManager.js";
import { joinSessions } from "./src/core/joinSessionStore.js";

// =====================================================
// Route imports
// =====================================================
import dashboardRoute from "./src/routes/dashboard.js";
import postsRoute from "./src/routes/posts.js";
import analyticsRoute from "./src/routes/analytics.js";
import analyticsSchedulerRoute from "./src/routes/analyticsScheduler.js";
import telegramRoute from "./src/routes/telegram.js";
import twilioRoute from "./src/routes/twilio.js";
import facebookAuthRoutes from "./src/routes/facebookAuth.js";
import stylistPortal from "./src/routes/stylistPortal.js";

import managerAuthRoutes from "./src/routes/managerAuth.js";
import managerRoutes from "./src/routes/manager.js";
import onboardingRoutes from "./src/routes/onboarding.js";
import onboardingGuard from "./src/routes/onboardingGuard.js";
import adminRouter from "./src/routes/admin.js";
import schedulerConfigRoute from "./src/routes/schedulerConfig.js";
import stylistManagerRoute from "./src/routes/stylistManager.js";
import vendorFeedsRoute from "./src/routes/vendorFeeds.js";
import vendorAdminRoute from "./src/routes/vendorAdmin.js";
import billingRoutes, { stripeWebhookHandler } from "./src/routes/billing.js";
import locationsRoute from "./src/routes/locations.js";
import postQueueRoute from "./src/routes/postQueue.js";
import integrationsRoute from "./src/routes/integrations.js";
import mfaRoute from "./src/routes/mfa.js";
import managerProfileRoute from "./src/routes/managerProfile.js";
import helpRoute from "./src/routes/help.js";
import teamPerformanceRoute from "./src/routes/teamPerformance.js";
import leaderboardRoute from "./src/routes/leaderboard.js";
import internalRouter from "./src/routes/internal.js";
import { lookupStylist } from "./src/core/salonLookup.js";

// Scheduler
import { enqueuePost, runSchedulerOnce, startScheduler } from "./src/scheduler.js";
import { runVendorScheduler } from "./src/core/vendorScheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================
// Express App Init
// =====================================================
const APP_ENV = process.env.APP_ENV || "local";
const app = express();

// Trust Render's reverse proxy so secure cookies work over HTTPS
app.set("trust proxy", 1);

// =====================================================
// Security Headers (Helmet)
// Must come before any route handlers.
// =====================================================
app.use(
  helmet({
    // Allow Tailwind CDN and Google Fonts (used throughout the app)
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'", "https://cdn.tailwindcss.com", "https://cdn.socket.io", "'unsafe-inline'"],
        styleSrc:       ["'self'", "https://fonts.googleapis.com", "https://cdn.tailwindcss.com", "'unsafe-inline'"],
        fontSrc:        ["'self'", "https://fonts.gstatic.com"],
        imgSrc:         ["'self'", "data:", "blob:", "https:", "http:"],
        connectSrc:     ["'self'", "wss:", "ws:"],
        frameSrc:       ["'none'"],
        objectSrc:      ["'none'"],
        upgradeInsecureRequests: APP_ENV === "production" ? [] : null,
      },
    },
    hsts: APP_ENV === "production"
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    crossOriginEmbedderPolicy: false, // Allow proxied Twilio images to load
  })
);

// =====================================================
// Rate Limiters
// =====================================================

// Auth routes — strict limit to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  skip: (req) => APP_ENV === "local",
});

// Password reset / forgot — stricter
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many password reset attempts. Please try again in an hour." },
  skip: (req) => APP_ENV === "local",
});

// Webhook endpoint — allow bursts but cap sustained abuse
// Signature verification (Twilio/Stripe/Telegram) is the primary protection here;
// rate limit by IP as a secondary backstop.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => APP_ENV === "local",
});

// General API — broad protection
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => APP_ENV === "local",
});

// Apply auth limiters to specific paths (before session/middleware)
app.use("/manager/login",           authLimiter);
app.use("/manager/signup",          authLimiter);
app.use("/manager/forgot-password", resetLimiter);
app.use("/manager/reset-password",  resetLimiter);
app.use("/integrations/webhook",    webhookLimiter);
app.use("/api",                     apiLimiter);



// Static assets
app.use("/public", express.static(path.join(__dirname, "public")));

// =====================================================
// Persistent Session Store (SQLite via better-sqlite3)
// =====================================================
import createBetterSqlite3SessionStore from "better-sqlite3-session-store";
import Database from "better-sqlite3";
const SqliteStore = createBetterSqlite3SessionStore(session);

const sessionDbPath =
  APP_ENV === "production" ? "/data/sessions.db"
  : APP_ENV === "staging"  ? "/tmp/sessions.db"
  : "./sessions.db";

const sessionDb = new Database(sessionDbPath);

app.use(
  session({
    store: new SqliteStore({ client: sessionDb }),
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: APP_ENV === "production",
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// =====================================================
// Stripe Webhook — MUST be before bodyParser (needs raw body)
// =====================================================
app.post("/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

// =====================================================
// Global Middleware
// =====================================================
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CSRF Protection
// Must come after session + bodyParser so req.session
// and req.body are both available.
// =====================================================
app.use(csrfProtection());

// =====================================================
// INBOUND TELEGRAM / TWILIO / MICROSOFT TEAMS
// =====================================================
const drafts = new Map();

app.use(
  "/inbound/telegram",
  telegramRoute(
    drafts,
    lookupStylist,  // MUST be passed explicitly
    ({ imageUrl, notes, stylist, salon }) =>
      generateCaption({
        imageDataUrl: imageUrl,
        notes,
        salon,
        stylist,
        city: stylist?.city || "",
      })
  )
);

app.use(
  "/inbound/twilio",
  twilioRoute(drafts, lookupStylist, ({ imageUrl, notes, stylist, salon }) =>
    generateCaption({
      imageDataUrl: imageUrl,
      notes,
      salon,
      stylist,
      city: stylist?.city || "",
    })
  )
);

// Teams route disabled until botbuilder dependency is added to package.json
// app.use("/inbound/teams", teamsRoute(...));

// Public uploads
app.use(
  "/uploads",
  express.static(UPLOADS_DIR, {
    setHeaders(res, filePath) {
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  })
);

// Media proxy — streams Twilio media server-side (no file storage needed)
app.get("/api/media-proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || !/^https:\/\/api\.twilio\.com/i.test(rawUrl)) {
    return res.status(400).send("Invalid proxy URL");
  }
  try {
    const authHeader =
      "Basic " +
      Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString("base64");

    const upstream = await fetch(rawUrl, {
      headers: { Authorization: authHeader },
      redirect: "follow",
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send("Upstream error");
    }

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "image/jpeg"
    );
    res.setHeader("Cache-Control", "public, max-age=86400");
    upstream.body.pipe(res);
  } catch (err) {
    console.error("[media-proxy] Error:", err.message);
    res.status(500).send("Proxy error");
  }
});

// Ensure public dir exists
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
const okPath = path.join(PUBLIC_DIR, "ok.txt");
if (!fs.existsSync(okPath)) fs.writeFileSync(okPath, "ok\n");

app.use("/public", express.static(PUBLIC_DIR));

// =====================================================
// RESTORE MANAGER FROM SESSION (inline middleware)
// =====================================================
function restoreManagerSession(req, res, next) {
  try {
    if (!req.session?.manager_id) return next();

    const mgr = db.prepare(
      `SELECT id, name, phone AS manager_phone, salon_id, role
       FROM managers WHERE id = ?`
    ).get(req.session.manager_id);

    if (mgr) {
      req.manager = mgr;
      // If the manager has switched locations, session.salon_id overrides the DB value
      if (req.session.salon_id) req.manager.salon_id = req.session.salon_id;
      // Make CSRF token available on req.manager for easy pageShell injection
      req.manager.csrfToken = req.session.csrfToken || "";
    }
  } catch (err) {
    console.error("restoreManagerSession failed:", err);
  }

  next();
}


// -------------------------------------------------------
// 1. MANAGER AUTH (login/signup) — MUST COME FIRST
// -------------------------------------------------------
app.use("/manager", managerAuthRoutes);

// -------------------------------------------------------
// 2. MANAGER DASHBOARD (approval page)
// -------------------------------------------------------
app.use("/manager", managerRoutes);

// -------------------------------------------------------
// 3. STYLIST PORTAL (token-auth, no session — must be before onboarding guard)
// -------------------------------------------------------
app.use("/stylist", stylistPortal);

// -------------------------------------------------------
// 4. ONBOARDING ROUTES (allowed BEFORE guard)
// -------------------------------------------------------
app.use("/onboarding", onboardingRoutes);

// -------------------------------------------------------
// 4b. BILLING ROUTES (checkout, success, manager/billing)
// -------------------------------------------------------
app.use("/billing", billingRoutes);
app.use(billingRoutes); // also handles /manager/billing

// -------------------------------------------------------
// 4. ONBOARDING GUARD (must run AFTER onboarding)
// -------------------------------------------------------
app.use(onboardingGuard);

// -------------------------------------------------------
// 5. TENANT RESOLUTION
// -------------------------------------------------------
app.use(tenantFromLink()); // FIX: remove "()"

// -------------------------------------------------------
// 6. RESTORE MANAGER BEFORE ADMIN ROUTES
// -------------------------------------------------------
app.use(restoreManagerSession);

// -------------------------------------------------------
// 7. ADMIN ROUTES
// -------------------------------------------------------
app.use("/manager/admin", adminRouter);

// -------------------------------------------------------
// 8. SCHEDULER CONFIG ROUTES
// -------------------------------------------------------
app.use("/manager/scheduler", schedulerConfigRoute);

// -------------------------------------------------------
// 9. STYLIST MANAGEMENT ROUTES
// -------------------------------------------------------
app.use("/manager/stylists", stylistManagerRoute);

// -------------------------------------------------------
// 10. LOCATIONS (multi-location switcher)
// -------------------------------------------------------
app.use("/manager/locations", locationsRoute);

// -------------------------------------------------------
// 11. VENDOR FEEDS (salon-facing, Pro plan)
// -------------------------------------------------------
app.use("/manager/vendors", vendorFeedsRoute);

// -------------------------------------------------------
// 12. POST QUEUE (drag-and-drop scheduler)
// -------------------------------------------------------
app.use("/manager/queue", postQueueRoute);

// -------------------------------------------------------
// 12. VENDOR ADMIN (internal MostlyPostly tool)
// -------------------------------------------------------
app.use("/internal/vendors", vendorAdminRoute);

// -------------------------------------------------------
// PUBLIC ROADMAP — /roadmap (no auth)
// Shows feature_requests with public=1 and status in (planned, live)
// -------------------------------------------------------
app.get("/roadmap", (req, res) => {
  let planned = [], live = [];
  try {
    const rows = db.prepare(`
      SELECT title, description, vote_count, status, updated_at
      FROM feature_requests
      WHERE public = 1 AND status IN ('planned', 'live')
      ORDER BY status DESC, vote_count DESC, updated_at DESC
    `).all();
    planned = rows.filter(r => r.status === 'planned');
    live    = rows.filter(r => r.status === 'live');
  } catch {}

  const safe = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const card = r => `
    <div class="border border-mpBorder rounded-2xl bg-white px-5 py-4">
      <div class="flex items-start justify-between gap-3">
        <p class="font-semibold text-mpCharcoal">${safe(r.title)}</p>
        <span class="shrink-0 text-xs px-2 py-0.5 rounded-full ${r.status === 'live' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'}">${r.status === 'live' ? '✅ Live' : '📅 Planned'}</span>
      </div>
      ${r.description ? `<p class="text-sm text-mpMuted mt-1">${safe(r.description)}</p>` : ''}
      <p class="text-xs text-mpMuted mt-2">${r.vote_count} salon${r.vote_count !== 1 ? 's' : ''} requested this</p>
    </div>`;

  const body = `
    <div class="max-w-2xl mx-auto px-4 py-12">
      <div class="mb-10 text-center">
        <img src="/logo/logo-trimmed.png" alt="MostlyPostly" class="h-10 mx-auto mb-6">
        <h1 class="text-3xl font-bold text-mpCharcoal">Product Roadmap</h1>
        <p class="text-mpMuted mt-2">Features planned and shipped, shaped by our salon community.</p>
      </div>

      ${live.length ? `
      <section class="mb-10">
        <h2 class="text-lg font-bold text-mpCharcoal mb-4 flex items-center gap-2">✅ Recently Shipped</h2>
        <div class="space-y-3">${live.map(card).join('')}</div>
      </section>` : ''}

      ${planned.length ? `
      <section class="mb-10">
        <h2 class="text-lg font-bold text-mpCharcoal mb-4 flex items-center gap-2">📅 Coming Soon</h2>
        <div class="space-y-3">${planned.map(card).join('')}</div>
      </section>` : ''}

      ${!live.length && !planned.length ? `
      <div class="text-center py-16 text-mpMuted">
        <p class="text-lg mb-2">Roadmap coming soon</p>
        <p class="text-sm">Sign in to your account to submit feature requests and vote on ideas.</p>
      </div>` : ''}

      <div class="text-center mt-12 pt-8 border-t border-mpBorder">
        <p class="text-sm text-mpMuted mb-3">Want to influence what we build next?</p>
        <a href="/manager/login" class="inline-block px-5 py-2.5 bg-mpAccent text-white text-sm font-medium rounded-xl hover:bg-mpAccentDark transition-colors">Sign in to vote →</a>
      </div>
    </div>`;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Roadmap — MostlyPostly</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { theme: { extend: { colors: {
    mpCharcoal: '#2B2D35', mpAccent: '#3B72B9', mpAccentDark: '#1a1c22',
    mpBg: '#F8FAFC', mpMuted: '#7A7C85', mpBorder: '#E2E8F0'
  }}}}</script>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>body { font-family: 'Plus Jakarta Sans', sans-serif; background: #F8FAFC; }</style>
</head>
<body>${body}</body>
</html>`);
});

// -------------------------------------------------------
// 13. MFA (TOTP setup, verify, disable)
// -------------------------------------------------------
app.use("/manager/mfa", mfaRoute);
app.use("/manager/profile", managerProfileRoute);
app.use("/help", helpRoute);
app.use("/manager/performance", teamPerformanceRoute);
app.use("/leaderboard", leaderboardRoute);

// -------------------------------------------------------
// 14. INTEGRATIONS (Zenoti, Vagaro, etc.)
// -------------------------------------------------------
app.use("/manager/integrations", integrationsRoute);
// Public webhook endpoint (no session auth — uses secret verification)
app.use("/integrations", integrationsRoute);

// =====================================================
// Internal API (used by ChairlyOS to sync stylist data)
// =====================================================
app.use('/api/internal', internalRouter);

// =====================================================
// Analytics API (public JSON endpoints for dashboard)
// =====================================================
app.use("/api", analyticsRoute);

// =====================================================
// DASHBOARD / POSTS / ANALYTICS UI ROUTES
// =====================================================
app.use("/dashboard", dashboardRoute);
app.use("/posts", postsRoute);
app.use("/analytics", analyticsRoute);
app.use("/analytics/scheduler", analyticsSchedulerRoute);
app.use("/auth/facebook", facebookAuthRoutes);

// =====================================================
// AUTO-INJECT SALON QUERY PARAM IF MISSING
// =====================================================
app.use((req, res, next) => {
  const path = req.path;

  const needsSalon = [
    "/dashboard",
    "/posts",
    "/analytics",
    "/analytics/scheduler",
    "/manager/admin",
    "/manager/settings",
  ];

  const hit = needsSalon.some((p) => path.startsWith(p));

  if (hit && !req.query.salon) {
    const salonId = req.session.salon_id;
    if (salonId) {
      return res.redirect(`${req.originalUrl}?salon=${salonId}`);
    }
  }

  next();
});

// =====================================================
// JOIN FLOW (SMS-based onboarding)
// =====================================================
app.post("/inbound/join", async (req, res) => {
  const from = req.body.From || req.body.chat_id;
  const text = (req.body.Body || req.body.text || "").trim();
  const sendMessage = async (to, msg) =>
    console.log(`📩 JOIN MSG → ${to}: ${msg}`);

  if (/^JOIN\b/i.test(text)) {
    await handleJoinCommand(from, lookupStylist, text, sendMessage);
    return res.json({ ok: true, action: "start" });
  }

  if (joinSessions.has(from)) {
    const result = await continueJoinConversation(from, text, sendMessage);
    return res.json({
      ok: true,
      action: result.done ? "complete" : "continue",
    });
  }

  res.json({ ok: false, message: "No active join session." });
});

// =====================================================
// BASIC HEALTH ENDPOINTS
// =====================================================
app.get("/", (_req, res) =>
  res.send("✅ MostlyPostly is running! Use /dashboard or /status.")
);

app.get("/status", (_req, res) =>
  res.json({ ok: true, version: "3.4.3" })
);

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.get("/health/scheduler", (_req, res) => {
  try {
    const queued = db.prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE status='manager_approved' AND scheduled_for IS NOT NULL`
    ).get().n;

    const stalled = db.prepare(
      `SELECT COUNT(*) AS n FROM posts
       WHERE status='manager_approved'
         AND scheduled_for IS NOT NULL
         AND datetime(scheduled_for) < datetime('now','-2 hours')`
    ).get().n;

    const failed = db.prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE status='failed'`
    ).get().n;

    const recentlyPublished = db.prepare(
      `SELECT COUNT(*) AS n FROM posts
       WHERE status='published'
         AND datetime(published_at) > datetime('now','-24 hours')`
    ).get().n;

    res.json({ ok: true, queued, stalled, failed, published_last_24h: recentlyPublished });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// SCHEDULER INIT
// =====================================================
console.log("WEB MODE: Scheduler enabled.");
startScheduler();

// Vendor scheduler — runs once at startup then every 24 hours
(async () => {
  try { await runVendorScheduler(); } catch (e) { console.error("❌ Vendor scheduler startup run failed:", e.message); }
})();
setInterval(async () => {
  try { await runVendorScheduler(); } catch (e) { console.error("❌ Vendor scheduler interval run failed:", e.message); }
}, 24 * 60 * 60 * 1000);

// =====================================================
// Socket.IO
// =====================================================
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.set("io", io);

io.on("connection", (socket) => {
  console.log("🟢 Dashboard connected:", socket.id);
  socket.on("disconnect", () =>
    console.log("🔴 Dashboard disconnected:", socket.id)
  );
});

// =====================================================
// Start server
// =====================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 MostlyPostly ready at http://localhost:${PORT}`);
  console.log(`💡 Health check: http://localhost:${PORT}/healthz`);
});
