// src/routes/manager.js — MostlyPostly Manager Portal (styled + actions)
// ESM module

import express from "express";
import cookieParser from "cookie-parser";
import { db } from "../../db.js";
import { enqueuePost } from "../scheduler.js";
import { DateTime } from "luxon";
import { getSalonPolicy } from "../scheduler.js";
import { rehostTwilioMedia } from "../utils/rehostTwilioMedia.js";
import { getSalonName, getSalonById } from "../core/salonLookup.js";

const router = express.Router();

// Ensure cookies + body parsing on this sub-app (in case not added globally)
router.use(cookieParser());
router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────
function nowISO() {
  return new Date().toISOString();
}

function appHost() {
  return process.env.BASE_URL || "http://localhost:3000";
}

function navBar(current = "manager", salon_id = "", manager_phone = "") {
  const qsSalon = salon_id ? `?salon=${encodeURIComponent(salon_id)}` : "";

  const link = (href, label, key) =>
    `<a href="${href}" 
        class="hover:text-white ${
          current === key ? "text-white" : "text-slate-300"
        } transition">
        ${label}
     </a>`;

  return `
<header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur">
  <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
    <div class="flex items-center justify-between py-4">
      <!-- Logo (match marketing index.html) -->
      <a href="${appHost()}/manager${qsSalon}" class="flex items-center gap-2" aria-label="MostlyPostly manager home">
        <div class="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-tr from-mpPrimary to-mpAccent text-xs font-semibold text-white shadow-md shadow-mpPrimary/40">
          MP
        </div>
        <span class="text-lg font-semibold tracking-tight text-white">MostlyPostly</span>
      </a>

      <!-- Desktop Nav -->
      <nav class="hidden items-center gap-8 text-sm font-medium text-slate-200 md:flex" aria-label="Primary navigation">
        ${link(`/manager${qsSalon}`, "Manager", "manager")}
        ${link(`/dashboard${qsSalon}`, "Database", "database")}
        ${link(`/analytics${qsSalon}`, "Scheduler Analytics", "scheduler")}
        ${link(`/manager/admin${qsSalon}`, "Admin", "admin")}
        ${link(`/manager/logout${qsSalon}`, "Logout", "logout")}
      </nav>
    </div>
  </div>
</header>
`;
}


function pageShell({ title, body, salon_id = "", manager_phone = "", current = "manager" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <!-- Tailwind CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Brand Tailwind config (same as marketing index.html) -->
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            mpPrimary: "#6366F1",
            mpPrimaryDark: "#4F46E5",
            mpAccent: "#F97316",
            mpBg: "#020617"
          }
        }
      }
    };
  </script>
</head>
<body class="bg-slate-950 text-slate-50 antialiased">
  ${navBar(current, salon_id, manager_phone)}
  <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    ${body}
  </main>
    <script>
      document.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll(".edit-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
          const details = btn.closest("details");
          const form = details.querySelector("[id^='edit-fields-']");
          const cancelPostBtn = details.querySelector("form[action='/manager/cancel']");

          if (form) form.classList.remove("hidden");
          if (cancelPostBtn) cancelPostBtn.classList.add("hidden");
          btn.classList.add("hidden");
        });
      });

      document.querySelectorAll(".cancel-edit").forEach(btn => {
        btn.addEventListener("click", () => {
          const details = btn.closest("details");
          const target = document.getElementById(btn.dataset.target);
          const editBtn = details.querySelector(".edit-toggle");
          const cancelPostBtn = details.querySelector("form[action='/manager/cancel']");

          if (target) target.classList.add("hidden");
          if (editBtn) editBtn.classList.remove("hidden");
          if (cancelPostBtn) cancelPostBtn.classList.remove("hidden");
        });
      });
    });
    </script>
</body>
</html>`;
}

// Try to show a usable image. If you want to actually rehost for display,
// wire in your existing rehoster; here we fall back gracefully.
async function getDisplayImage(url, salon_id = "unknown") {
  if (!url) return "/uploads/sample.jpg";

  try {
    // Already public (uploads/ngrok)
    if (/^https?:\/\/.+(uploads|public)/i.test(url)) return url;

    // Twilio-hosted → rehost it now
    if (/^https:\/\/api\.twilio\.com\//i.test(url)) {
      console.log(`🌐 [Manager] Rehosting Twilio media for dashboard: ${url} [${salon_id}]`);
      const publicUrl = await rehostTwilioMedia(url, salon_id);
      return publicUrl;
    }

    return url;
  } catch (err) {
    console.error("⚠️ getDisplayImage failed:", err.message);
    return "/uploads/sample.jpg";
  }
}



function managerFromRow(row) {
  if (!row) return null;
  return {
    salon_id: row.salon_id || "unknown",
    manager_phone: row.manager_phone || "",
    token: row.token,
  };
}

// ───────────────────────────────────────────────────────────
// Auth middleware (session-aware + token fallback)
// ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    // 1️⃣ SESSION-BASED LOGIN (email/password or magic link via managerAuth.js)
    if (req.session?.manager_id) {
      const mgr = db
        .prepare(`SELECT * FROM managers WHERE id = ?`)
        .get(req.session.manager_id);

      if (mgr) {
        req.manager = {
          salon_id: mgr.salon_id || "unknown",
          manager_phone: mgr.phone || "",
          manager_name: mgr.name || "Manager",
          manager_role: mgr.role || "Manager",
          token: null,
        };

        return next(); // ✅ we’re authenticated via session
      } else {
        // Stale session: clear it and fall through to token logic
        req.session.manager_id = null;
      }
    }

    // 2️⃣ TOKEN-BASED LOGIN (old flow via SMS magic link)
    const token = req.cookies?.mgr_token || req.query?.token;
    if (!token) {
      return res
        .status(401)
        .send(
          pageShell({
            title: "Manager — Not Authenticated",
            body: `<div class="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                     <h1 class="text-xl font-semibold text-blue-400 mb-2">Invalid Session</h1>
                     <p class="text-zinc-300">Missing token or session. Use the SMS link, log in with your email and password, or ask your system admin to issue a new manager link.</p>
                   </div>`,
          })
        );
    }

    const row = db
      .prepare(
        `SELECT token, salon_id, manager_phone, expires_at
         FROM manager_tokens
         WHERE token = ?`
      )
      .get(token);

    if (!row) {
      return res
        .status(401)
        .send(
          pageShell({
            title: "Manager — Invalid Token",
            body: `<div class="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                     <h1 class="text-xl font-semibold text-red-400 mb-2">Invalid or expired token</h1>
                     <p class="text-zinc-300">That link is no longer valid. Request a fresh link from MostlyPostly.</p>
                   </div>`,
          })
        );
    }

    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res
        .status(401)
        .send(
          pageShell({
            title: "Manager — Token Expired",
            body: `<div class="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
                     <h1 class="text-xl font-semibold text-yellow-400 mb-2">Token expired</h1>
                     <p class="text-zinc-300">Please request a new approval link.</p>
                   </div>`,
          })
        );
    }

    // 🔍 Pull manager info from salon file (for name/role display)
    const salonPolicy = getSalonPolicy(row.salon_id);
    const foundManager =
      salonPolicy?.managers?.find((m) => m.phone === row.manager_phone) || {};

    // Attach to req
    req.manager = {
      salon_id: row.salon_id,
      manager_phone: row.manager_phone,
      manager_name: foundManager.name || foundManager.manager_name || "Manager",
      manager_role: foundManager.role || "Manager",
      token: row.token,
    };

    // Optional: keep cookies fresh for token-based flow
    res.cookie("mgr_token", row.token, {
      httpOnly: false,
      sameSite: "Lax",
      path: "/",
    });
    res.cookie(
      "mgr_info",
      JSON.stringify({
        salon_id: row.salon_id,
        manager_phone: row.manager_phone,
        manager_name: req.manager.manager_name,
      }),
      { httpOnly: false, sameSite: "Lax", path: "/" }
    );

    console.log(
      `✅ [Auth] Logged in manager: ${req.manager.manager_name} (${req.manager.manager_phone})`
    );

    next();
  } catch (err) {
    console.error("❌ manager auth error:", err);
    res.status(500).send("Internal Server Error");
  }
}


// ==========================================================
// 🧹 Manager Logout — clears cookies & redirects
// ==========================================================
router.get("/logout", (req, res) => {
  try {
    // Destroy session if it exists
    if (req.session) {
      req.session.destroy((err) => {
        if (err) {
          console.warn("⚠️ Session destroy error:", err.message);
        }
      });
    }

    // Remove all authentication and tenant cookies
    res.clearCookie("mgr_token", { path: "/" });
    res.clearCookie("mt", { path: "/" });
    res.clearCookie("mgr_info", { path: "/" });

    console.log("👋 Manager logged out successfully.");

    // Redirect to explicit login page
    res.redirect("/manager/login");
  } catch (err) {
    console.error("❌ Logout error:", err);
    res.status(500).send("Logout failed. Please close your browser window.");
  }
});


// ───────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────

// Accept ?mt=... or ?token=... → set cookies, then redirect to /manager
router.get("/login", (req, res) => {
  const raw = (req.query?.mt || req.query?.token || "").trim();
  if (!raw) return res.redirect("/manager?err=missing_token");

  try {
    const row = db
      .prepare(`SELECT token, salon_id, manager_phone, expires_at FROM manager_tokens WHERE token = ?`)
      .get(raw);

    if (!row) return res.redirect("/manager?err=invalid_token");
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.redirect("/manager?err=expired");
    }

    const isProd = process.env.NODE_ENV === "production";

    // ✅ Set both cookies so:
    // - manager route uses mgr_token
    // - dashboard/analytics (and optional tenantFromLink) can use mt
    res.cookie("mgr_token", row.token, {
      httpOnly: false,           // your manager UI reads it client-side
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie("mt", row.token, {
      httpOnly: true,            // not needed in JS, only server-side
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie(
      "mgr_info",
      JSON.stringify({ salon_id: row.salon_id, manager_phone: row.manager_phone }),
      { httpOnly: false, sameSite: "lax", secure: isProd, path: "/", maxAge: 7 * 24 * 60 * 60 * 1000 }
    );

    // Redirect to the manager home (tenant will be inferred automatically)
    return res.redirect("/manager");
  } catch (err) {
    console.error("❌ /manager/login error:", err);
    return res.redirect("/manager?err=server");
  }
});


// Manager dashboard (condensed + editable + local times)
router.get("/", requireAuth, async (req, res) => {
  const salon_id = req.manager?.salon_id || "unknown";
  const manager_phone = req.manager?.manager_phone || "";

  const { DateTime } = await import("luxon");
  const salonPolicy = getSalonPolicy(salon_id);
  const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";

  function fmtLocal(iso) {
    if (!iso) return "";
    try {
      return DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat("MMM d, yyyy • h:mm a");
    } catch {
      return iso;
    }
  }

  try {
      const pending = db
      .prepare(
        `SELECT id, stylist_name, salon_id, image_url, final_caption, status, created_at, scheduled_for, salon_post_number
        FROM posts
        WHERE salon_id = ? AND status = 'manager_pending'
        ORDER BY datetime(created_at) DESC
        LIMIT 50`
      )
      .all(salon_id);


    const recent = db.prepare(`
      SELECT *
      FROM posts
      WHERE salon_id = ?
        AND status NOT IN ('published')
        AND datetime(created_at) >= datetime('now', '-7 days')
      ORDER BY datetime(created_at) DESC
      LIMIT 100
    `).all(salon_id);


    // Renderer
    async function card(post, pendingMode = false) {
      const img = await getDisplayImage(
        post.image_url,
        req.manager?.salon_id || req.salon_id || post.salon_id || "unknown"
      );

      const safeCap = (post.final_caption || "")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br/>");

      if (pendingMode) {
      // FULL CARD for pending
      return `
        <article class="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-md w-full">
          <div class="grid grid-cols-[140px_1fr] gap-6 p-6 items-start">

            <!-- LEFT: IMAGE -->
            <div class="flex">
              <img src="${img}" 
                  <img src="${img}"
                    class="w-[180px] h-[180px] md:w-[220px] md:h-[220px] object-cover rounded-lg shadow-lg" />
            </div>

            <!-- RIGHT: DETAILS -->
            <div>
              <h3 class="font-semibold text-white text-lg mb-1">Post #${post.salon_post_number ?? 1}</h3>
              <p class="text-xs text-slate-400 mb-4">
                Created ${post.created_at_formatted}
              </p>

              <div class="prose prose-invert text-sm mb-4">
                ${post.final_caption.replace(/\n/g, "<br/>")}
              </div>

              <!-- BUTTONS -->
              <div class="flex flex-wrap gap-3 mt-4">
                <a href="/manager/approve?id=${post.id}"
                  class="rounded-full bg-blue-600 hover:bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white">
                  Approve (schedule)
                </a>

                <a href="/manager/post-now?id=${post.id}"
                  class="rounded-full bg-green-600 hover:bg-green-700 px-4 py-1.5 text-xs font-semibold text-white">
                  Post now
                </a>

                <form method="POST" action="/manager/deny?id=${post.id}">
                  <div class="flex items-center gap-2">
                    <input name="reason" placeholder="Reason for denial…" 
                          class="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white placeholder:text-zinc-400 w-48"/>
                    <button class="bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-full px-4 py-1.5">
                      Deny
                    </button>
                  </div>
                </form>
              </div>
            </div>

          </div>
        </article>
      `;
      }

      // CONDENSED CARD for recent (with Edit toggle)
      const isEditable = !["published", "denied"].includes(post.status);
      return `
        <details class="bg-zinc-900/60 border border-zinc-800 rounded-xl w-full">
          <summary class="cursor-pointer px-4 py-3 flex justify-between items-center">
            <div>
              <span class="text-blue-400 font-semibold">#${post.salon_post_number || "—"} — ${
        post.stylist_name || "Unknown Stylist"
      }</span>
              <span class="text-zinc-400 text-sm ml-2">${post.status.toUpperCase()}</span>
            </div>
            <span class="text-xs text-zinc-500">${fmtLocal(post.scheduled_for) || "—"}</span>
          </summary>

          <div class="border-t border-zinc-800">
            <div class="grid grid-cols-[140px_1fr] gap-6 p-6 items-start">
              
              <!-- LEFT: IMAGE -->
              <div class="flex">
                <img src="${img}" 
                  class="w-[180px] h-[180px] md:w-[220px] md:h-[220px] object-cover rounded-lg shadow-lg" />
              </div>

              <!-- RIGHT: DETAILS + EDIT CONTROLS -->
              <div>
                <div class="prose prose-invert text-sm mb-3">${safeCap}</div>

                ${
                  isEditable
                    ? `
                <div class="flex gap-2 mb-3">
                  <button type="button" class="edit-toggle px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm">
                    Edit
                  </button>
                  <form method="POST" action="/manager/cancel">
                    <input type="hidden" name="post_id" value="${post.id}"/>
                    <button class="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-white text-sm">
                      Cancel
                    </button>
                  </form>
                </div>

                <div id="edit-fields-${post.id}" class="hidden mt-3 space-y-2">
                  <form method="POST" action="/manager/edit" class="space-y-2">
                    <input type="hidden" name="post_id" value="${post.id}"/>
                    <label class="text-xs text-zinc-400 block">Caption:</label>
                    <textarea name="final_caption" class="w-full p-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200" rows="3">${post.final_caption || ""}</textarea>
                    <label class="text-xs text-zinc-400 block">Update scheduled time:</label>
                    <input type="datetime-local" name="scheduled_for" class="bg-zinc-800 border border-zinc-700 rounded text-zinc-200 p-1 w-64" />
                    <div class="flex gap-2">
                      <button class="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm">Save</button>
                      <button type="button" class="cancel-edit px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white text-sm" data-target="edit-fields-${post.id}">Cancel</button>
                    </div>
                  </form>
                </div>`
                    : `<p class="text-xs text-zinc-500 italic">Locked (already published or denied)</p>`
                }
              </div>

            </div>
          </div>
        </details>`;
    }

    const pendingCards = await Promise.all(pending.map((row) => card(row, true)));
    const recentCards = await Promise.all(recent.map((row) => card(row, false)));

            const body = `
      <section class="mb-8">
        <div class="flex flex-col gap-2">
          <h1 class="text-2xl font-semibold text-white">
            Manager Dashboard — <span class="text-mpPrimary">${getSalonName(salon_id)}</span>
          </h1>
          <p class="text-sm text-slate-400">
            Logged in as ${req.manager.manager_name || req.manager.name || "Manager"} (${req.manager.manager_phone || "unknown"}).
          </p>
          <p class="text-xs text-slate-500">
            Use the navigation above to open Database, Scheduler Analytics, or Admin settings.
          </p>
        </div>
      </section>

      <section class="space-y-4 mb-10">
        <h2 class="text-xl font-semibold text-white">Pending Approval</h2>
        ${
          pendingCards.length
            ? `<div class="flex flex-col gap-6">${pendingCards.join("")}</div>`
            : `<div class="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-zinc-300">No pending posts.</div>`
        }

      </section>

      <section class="space-y-4">
        <h2 class="text-xl font-semibold text-white">Recent (Approved / Queued / Published / Failed / Denied)</h2>
        ${
          recentCards.length
            ? `<div class="flex flex-col gap-4">${recentCards.join("")}</div>`
            : `<div class="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-zinc-300">No recent posts yet.</div>`
        }
      </section>
    `;

    res.send(pageShell({ title: "Manager Dashboard", body, salon_id, manager_phone, current: "manager" }));
  } catch (err) {
    console.error("❌ /manager error:", err);
    res.status(500).send("Internal Server Error");
  }
});


// Approve (schedule) or Post Now
router.post("/approve", requireAuth, async (req, res) => {
  const { post_id, action } = req.body || {};
  if (!post_id) return res.redirect("/manager?err=missing_post");

  try {
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post_id);
    if (!post) return res.redirect("/manager?err=not_found");
    if (post.salon_id !== req.manager.salon_id) return res.redirect("/manager?err=forbidden");

        if (action === "post_now") {
      // Publish immediately
      db.prepare(`UPDATE posts SET status='queued', scheduled_for=?, approved_at=datetime('now','utc') WHERE id=?`)
        .run(DateTime.utc().toISO(), post_id);

      try {
        await enqueuePost({
          id: post.id,
          image_url: post.image_url,
          final_caption: post.final_caption,
          salon_id: post.salon_id,
          stylist_name: post.stylist_name,
        });
        console.log(`🚀 [Manager] Post ${post_id} queued immediately.`);
      } catch (err) {
        console.error("⚠️ enqueuePost error:", err.message);
      }

    } else if (action === "schedule") {
      // Approve + queue with randomized UTC delay (salon-aware)
      const salonPolicy = getSalonPolicy(post.salon_id);
      const delay = salonPolicy?.random_delay_minutes || { min: 20, max: 45 };
      const randDelay = Math.floor(Math.random() * (delay.max - delay.min + 1)) + delay.min;
      const scheduledUtc = DateTime.utc().plus({ minutes: randDelay }).toISO({ suppressMilliseconds: true });

      db.prepare(`
        UPDATE posts
        SET status='queued',
            approved_by=?,
            approved_at=datetime('now','utc'),
            scheduled_for=?
        WHERE id=?
      `).run(req.manager.manager_phone, scheduledUtc, post_id);

      console.log(`🕓 [Manager] Post ${post_id} approved & queued for ${scheduledUtc} UTC (${randDelay}min delay)`);

    } else {
      // fallback for other future actions
      db.prepare(`UPDATE posts SET status='approved', approved_at=datetime('now','utc') WHERE id=?`).run(post_id);
    }

    return res.redirect("/manager?ok=approved");
  } catch (err) {
    console.error("❌ /manager/approve error:", err);
    return res.redirect("/manager?err=server");
  }
});

// Deny (with reason + notify stylist)
router.post("/deny", requireAuth, async (req, res) => {
  const { post_id, reason } = req.body || {};
  if (!post_id) return res.redirect("/manager?err=missing_post");

  try {
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post_id);
    if (!post) return res.redirect("/manager?err=not_found");
    if (post.salon_id !== req.manager.salon_id) return res.redirect("/manager?err=forbidden");

    db.prepare(
      `UPDATE posts
         SET status='denied',
             approved_by=?,
             approved_at=datetime('now')
       WHERE id=?`
    ).run(req.manager.manager_phone, post_id);

    console.log(`❌ Post ${post_id} denied by ${req.manager.manager_phone}. Reason: ${reason || "none"}`);

    // Notify stylist by SMS (using your Twilio helper if available)
    try {
      const sendMessageMod = await import("../utils/sendMessage.js").catch(() => null);
      const sender = sendMessageMod?.default || sendMessageMod; // handle default export vs named
      const body = `❌ Your post was denied by management.${
        reason ? `\nReason: ${reason}` : ""
      }\n\nPlease edit and resubmit when ready.`;
      if (sender?.sendText && post.phone) await sender.sendText(post.phone, body);
    } catch (err) {
      console.warn("⚠️ Could not send denial SMS:", err.message);
    }

    return res.redirect("/manager?ok=denied");
  } catch (err) {
    console.error("❌ /manager/deny error:", err);
    return res.redirect("/manager?err=server");
  }
});

// Edit (update caption or scheduled time)
router.post("/edit", requireAuth, async (req, res) => {
  try {
    console.log("🧾 [Manager/Edit] Raw body:", req.body);

    const { post_id, final_caption, scheduled_for } = req.body || {};
    if (!post_id) return res.redirect("/manager?err=missing_post");

    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post_id);
    if (!post) return res.redirect("/manager?err=not_found");
    if (post.salon_id !== req.manager.salon_id)
      return res.redirect("/manager?err=forbidden");

    const updatedCaption =
      typeof final_caption === "string" && final_caption.trim().length
        ? final_caption.trim()
        : post.final_caption;

    // Normalize scheduled time → UTC
    let updatedTime = post.scheduled_for;
    if (scheduled_for && scheduled_for.trim()) {
      const { DateTime } = await import("luxon");
      const salonPolicy = getSalonPolicy(post.salon_id);
      const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";
      updatedTime = DateTime.fromISO(scheduled_for, { zone: tz })
        .toUTC()
        .toISO({ suppressMilliseconds: true });
    }

    // Determine correct next status
    let newStatus = post.status;
    if (post.status === "approved") newStatus = "queued"; // enqueue old posts
    if (!newStatus) newStatus = "queued";

    console.log("🕓 [Manager/Edit] Final values:", {
      updatedCaption,
      updatedTime,
      newStatus,
    });

    // Perform update
    const result = db
      .prepare(
        `UPDATE posts
         SET final_caption = ?,
             scheduled_for = ?,
             status = ?,
             updated_at = datetime('now','utc')
         WHERE id = ?`
      )
      .run(updatedCaption, updatedTime, newStatus, post_id);

    console.log("💾 [Manager/Edit] DB result:", result);

    const verify = db
      .prepare(
        `SELECT id, final_caption, scheduled_for, status
         FROM posts WHERE id = ?`
      )
      .get(post_id);
    console.log("🔍 [Manager/Edit] Post after update:", verify);

    return res.redirect("/manager?ok=edited");
  } catch (err) {
    console.error("❌ [Manager/Edit] Error:", err);
    return res.redirect("/manager?err=server");
  }
});


// Cancel (remove from queue)
router.post("/cancel", requireAuth, async (req, res) => {
  const { post_id } = req.body || {};
  if (!post_id) return res.redirect("/manager?err=missing_post");

  try {
    const post = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(post_id);
    if (!post) return res.redirect("/manager?err=not_found");
    if (post.salon_id !== req.manager.salon_id) return res.redirect("/manager?err=forbidden");

    db.prepare(
      `UPDATE posts
       SET status='cancelled', updated_at=datetime('now','utc')
       WHERE id=?`
    ).run(post_id);

    console.log(`🛑 Post ${post_id} cancelled by ${req.manager.manager_phone}.`);
    return res.redirect("/manager?ok=cancelled");
  } catch (err) {
    console.error("❌ /manager/cancel error:", err);
    return res.redirect("/manager?err=server");
  }
});

// ───────────────────────────────────────────────────────────
// Admin page — salon configuration & social connections
// ───────────────────────────────────────────────────────────
router.get("/admin", requireAuth, (req, res) => {
    const salon_id = req.manager?.salon_id || "unknown";
  const manager_phone = req.manager?.manager_phone || "";

  // Use the full salon config from salons/<id>.json
  const salon = getSalonById(salon_id) || {};
  const info = salon.salon_info || {};
  const settings = salon.settings || {};
  const managers = salon.managers || [];
  const stylists = salon.stylists || [];
  const compliance = info.compliance || {};
  const postingWindow = settings.posting_window || {};
  const randomDelay = settings.random_delay_minutes || {};

  const bookingUrl = info.booking_url || "";
  const timezone = info.timezone || "America/Indiana/Indianapolis";

  // Managers table
  const managersRows = managers
    .map((m) => {
      const spec = (m.specialties || []).join(", ");
      const ig = m.instagram_handle || "—";
      const sms = m.consent?.sms_opt_in ? "Yes" : "No";
      return `
        <tr class="border-b border-zinc-800/80">
          <td class="px-3 py-2 text-sm text-zinc-100">${m.name || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${m.phone || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${ig}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${spec || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${sms}</td>
        </tr>
      `;
    })
    .join("");

  // Stylists table
  const stylistsRows = stylists
    .map((s) => {
      const spec = (s.specialties || []).join(", ");
      const ig = s.instagram_handle || "—";
      const sms = s.consent?.sms_opt_in ? "Yes" : "No";
      return `
        <tr class="border-b border-zinc-800/80">
          <td class="px-3 py-2 text-sm text-zinc-100">${s.name || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${s.phone || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${ig}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${spec || "—"}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${sms}</td>
        </tr>
      `;
    })
    .join("");

  const fbPageId = info.facebook_page_id || "Not configured";
  const igBizId = info.instagram_business_id || "Not configured";
  const igHandle = info.instagram_handle || "Not configured";
  const xHandle = info.x_handle || "Not configured";
  const tiktokHandle = info.tiktok_handle || "Not configured";

  const body = `
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-2">
        Admin — <span class="text-mpPrimary">${getSalonName(salon_id)}</span>
      </h1>
      <p class="text-sm text-zinc-400">
        Manage social connections, posting rules, and stylist configuration for this salon.
      </p>
    </section>

    <!-- Social Connections -->
    <section class="mb-6 grid gap-4 md:grid-cols-[1.2fr,0.8fr]">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Social Connections</h2>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Facebook Page ID</dt>
            <dd class="font-mono text-[11px]">${fbPageId}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Instagram Business ID</dt>
            <dd class="font-mono text-[11px]">${igBizId}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Instagram Handle</dt>
            <dd class="font-mono text-[11px]">@${igHandle}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">X (Twitter)</dt>
            <dd class="font-mono text-[11px]">@${xHandle}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">TikTok</dt>
            <dd class="font-mono text-[11px]">@${tiktokHandle}</dd>
          </div>
        </dl>

        <div class="mt-4">
          <a
            href="/auth/facebook/login?salon=${encodeURIComponent(salon_id)}"
            class="inline-flex items-center px-3 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
          >
            Connect / Refresh Facebook & Instagram
          </a>
          <p class="mt-2 text-[11px] text-zinc-500">
            Uses your MostlyPostly Facebook App to grant or refresh Page & Instagram permissions.
          </p>
        </div>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Salon Info</h2>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Name</dt>
            <dd>${info.name || "—"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">City</dt>
            <dd>${info.city || "—"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Timezone</dt>
            <dd>${timezone}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Booking URL</dt>
            <dd class="truncate max-w-[12rem]">
              ${
                bookingUrl
                  ? `<a href="${bookingUrl}" target="_blank" class="underline text-blue-400">Open booking page</a>`
                  : "Not set"
              }
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Tone Profile</dt>
            <dd>${info.tone_profile || "default"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Auto Publish</dt>
            <dd>${info.auto_publish ? "Enabled" : "Disabled"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Stylist SMS Consent Required</dt>
            <dd>${compliance.stylist_sms_consent_required ? "Yes" : "No"}</dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- Posting Rules -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Posting Window</h2>
        <p class="text-xs text-zinc-300">
          MostlyPostly only posts inside your configured window (salon local time).
        </p>
        <dl class="mt-3 space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Start</dt>
            <dd>${postingWindow.start || "00:00"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">End</dt>
            <dd>${postingWindow.end || "23:59"}</dd>
          </div>
        </dl>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Manager Rules</h2>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Require Manager Approval</dt>
            <dd>${settings.require_manager_approval ? "Yes" : "No"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Auto-post if no response</dt>
            <dd>${
              settings.auto_post_if_no_response_hours != null
                ? settings.auto_post_if_no_response_hours + " hours"
                : "Disabled"
            }</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Random Delay</dt>
            <dd>
              ${
                randomDelay.min != null && randomDelay.max != null
                  ? `${randomDelay.min}–${randomDelay.max} min`
                  : "Not configured"
              }
            </dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Notify stylist on approval</dt>
            <dd>${settings.notify_stylist_on_approval ? "Yes" : "No"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Notify stylist on denial</dt>
            <dd>${settings.notify_stylist_on_denial ? "Yes" : "No"}</dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- Managers & Stylists -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-3">Managers</h2>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="bg-zinc-950/80 text-zinc-400">
              <tr>
                <th class="px-3 py-2 text-left">Name</th>
                <th class="px-3 py-2 text-left">Phone</th>
                <th class="px-3 py-2 text-left">IG Handle</th>
                <th class="px-3 py-2 text-left">Specialties</th>
                <th class="px-3 py-2 text-left">SMS Opt-in</th>
              </tr>
            </thead>
            <tbody>
              ${
                managersRows ||
                `<tr><td colspan="5" class="px-3 py-3 text-center text-zinc-500 text-xs">No managers configured in salon file.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-3">Stylists</h2>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="bg-zinc-950/80 text-zinc-400">
              <tr>
                <th class="px-3 py-2 text-left">Name</th>
                <th class="px-3 py-2 text-left">Phone</th>
                <th class="px-3 py-2 text-left">IG Handle</th>
                <th class="px-3 py-2 text-left">Specialties</th>
                <th class="px-3 py-2 text-left">SMS Opt-in</th>
              </tr>
            </thead>
            <tbody>
              ${
                stylistsRows ||
                `<tr><td colspan="5" class="px-3 py-3 text-center text-zinc-500 text-xs">No stylists configured in salon file.</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;

  res.send(
  pageShell({
    title: `Admin — ${info.name || salon_id}`,
    body,
    salon_id,
    manager_phone,
    current: "admin",
  })
);
});

export default router;
