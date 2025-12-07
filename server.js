// =====================================================
// Core imports
// =====================================================
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
import dotenv from "dotenv";
dotenv.config();

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
// Schema + analytics bootstrap
// =====================================================
import { initSchemaHealth } from "./src/core/initSchemaHealth.js";
initSchemaHealth();
import "./src/core/analyticsDb.js";

// =====================================================
// DB
// =====================================================
import { db } from "./db.js";

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
import { lookupStylist } from "./src/core/salonLookup.js";

// Scheduler
import { enqueuePost, runSchedulerOnce, startScheduler } from "./src/scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================
// Express App Init
// =====================================================
const app = express();

// Correct Admin modal template loader (must come BEFORE ANY /manager routes)
app.get("/manager/admin/templates", (req, res) => {
  const templatePath = path.join(__dirname, "public", "admin-templates.html");
  console.log("🔥 HIT /manager/admin/templates", templatePath);
  res.sendFile(templatePath);
});


// Static assets
app.use("/public", express.static(path.join(__dirname, "public")));

// =====================================================
// Persistent Session Store (SQLite)
// =====================================================
import SQLiteStoreFactory from "connect-sqlite3";
const SQLiteStore = SQLiteStoreFactory(session);

app.use(
  session({
    store: new SQLiteStore({
      db: "sessions.db",
      dir: "./",
    }),
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

// =====================================================
// Global Middleware
// =====================================================
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public uploads
app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "public/uploads"), {
    setHeaders(res, filePath) {
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
  })
);

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

    if (mgr) req.manager = mgr;
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
// 3. ONBOARDING ROUTES (allowed BEFORE guard)
// -------------------------------------------------------
app.use("/onboarding", onboardingRoutes);

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

// =====================================================
// Stylist Portal (no auth)
// =====================================================
app.use("/stylist", stylistPortal);

// =====================================================
// Analytics API (public JSON endpoints for dashboard)
// =====================================================
app.use("/api", analyticsRoute);

// =====================================================
// INBOUND TELEGRAM / TWILIO
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

// =====================================================
// SCHEDULER INIT
// =====================================================
console.log("WEB MODE: Scheduler enabled.");
startScheduler();

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
