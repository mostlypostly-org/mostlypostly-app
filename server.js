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

// Load salons BEFORE routes
import {
  loadSalons,
  startSalonWatcher,
  getAllSalons,
  lookupStylist
} from "./src/core/salonLookup.js";

await loadSalons();
startSalonWatcher();
console.log("💇 Salons loaded and file watcher active.");

// =====================================================
// Schema + Analytics must load before routes
// =====================================================
import { initSchemaHealth } from "./src/core/initSchemaHealth.js";
initSchemaHealth();

// Load analytics DB triggers
import "./src/core/analyticsDb.js";

// =====================================================
// Middleware imports (used later)
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
// ROUTE imports (but DO NOT mount yet)
// =====================================================
import dashboardRoute from "./src/routes/dashboard.js";
import postsRoute from "./src/routes/posts.js";
import analyticsRoute from "./src/routes/analytics.js";
import analyticsSchedulerRoute from "./src/routes/analyticsScheduler.js";
import telegramRoute from "./src/routes/telegram.js";
import twilioRoute from "./src/routes/twilio.js";
import managerRoute from "./src/routes/manager.js";
import managerAuth from "./src/routes/managerAuth.js";
import stylistPortal from "./src/routes/stylistPortal.js";
import facebookAuthRoutes from "./src/routes/facebookAuth.js";

// Scheduler
import { enqueuePost, runSchedulerOnce, startScheduler } from "./src/scheduler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================================================
// 🚀 Initialize Express app — MUST happen BEFORE app.use()
// =====================================================
const app = express();

// Static files for login, logos, etc.
app.use("/public", express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // set to true on production with HTTPS
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

// =====================================================
// 🧩 Global Middleware (order matters)
// =====================================================
app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Tenant resolution before any multi-salon route
app.use(tenantFromLink());

// =====================================================
// Public static assets
// =====================================================
app.use("/uploads",
  express.static(path.join(process.cwd(), "public/uploads"), {
    setHeaders(res, filePath) {
      if (/\.(jpg|jpeg|png|gif|webp)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400");
      }
    },
}));

// Main public folder
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(process.cwd(), "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
const okPath = path.join(PUBLIC_DIR, "ok.txt");
if (!fs.existsSync(okPath)) fs.writeFileSync(okPath, "ok\n");

app.use("/public", express.static(PUBLIC_DIR));

// =====================================================
// MOUNT AUTH ROUTES (managers login FIRST)
// =====================================================
app.use("/manager", managerAuth);

app.use("/manager", require("./src/routes/managerAuth"));

// =====================================================
// Stylist Portal (token-based, no login)
// =====================================================
app.use("/stylist", stylistPortal);

// =====================================================
// Analytics API
// =====================================================
app.use("/api", analyticsRoute);

// =====================================================
// Inbound routes (Telegram/Twilio)
// =====================================================
const drafts = new Map();

app.use("/inbound/telegram",
  telegramRoute(drafts, lookupStylist, ({ imageUrl, notes, stylist, salon }) =>
    generateCaption({
      imageDataUrl: imageUrl,
      notes,
      salon,
      stylist,
      city: stylist?.city || "",
    })
  )
);

app.use("/inbound/twilio",
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
// Manager UI Routes (dashboard, admin, posts, etc.)
// =====================================================
app.use("/dashboard", dashboardRoute);
app.use("/posts", postsRoute);
app.use("/analytics", analyticsRoute);
app.use("/analytics/scheduler", analyticsSchedulerRoute);
app.use("/auth/facebook", facebookAuthRoutes);
app.use("/manager", managerRoute);

// =====================================================
// JOIN Onboarding endpoints
// =====================================================
app.post("/inbound/join", async (req, res) => {
  const from = req.body.From || req.body.chat_id;
  const text = (req.body.Body || req.body.text || "").trim();
  const sendMessage = async (to, msg) => console.log(`📩 JOIN MSG → ${to}: ${msg}`);

  if (/^JOIN\b/i.test(text)) {
    await handleJoinCommand(from, lookupStylist, text, sendMessage);
    return res.json({ ok: true, action: "start" });
  }

  if (joinSessions.has(from)) {
    const result = await continueJoinConversation(from, text, sendMessage);
    return res.json({ ok: true, action: result.done ? "complete" : "continue" });
  }

  res.json({ ok: false, message: "No active join session." });
});

// =====================================================
// Basic Health Routes
// =====================================================
app.get("/", (_req, res) =>
  res.send("✅ MostlyPostly is running! Use /dashboard or /status to check health.")
);

app.get("/status", (_req, res) => res.json({ ok: true, version: "3.4.3" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// =====================================================
// Scheduler Bootstrapping
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
  socket.on("disconnect", () => console.log("🔴 Dashboard disconnected:", socket.id));
});

// =====================================================
// Start server
// =====================================================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 MostlyPostly ready at http://localhost:${PORT}`);
  console.log(`💡 Health check: http://localhost:${PORT}/healthz`);
});