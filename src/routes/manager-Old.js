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
        class="hover:text-white ${current === key ? "text-white" : "text-slate-300"
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

function pageShell({
  title,
  body,
  salon_id = "",
  manager_phone = "",
  current = "manager",
}) {
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
      console.log(
        `🌐 [Manager] Rehosting Twilio media for dashboard: ${url} [${salon_id}]`
      );
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
      return res.status(401).send(
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
      return res.status(401).send(
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
      return res.status(401).send(
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
      .prepare(
        `SELECT token, salon_id, manager_phone, expires_at FROM manager_tokens WHERE token = ?`
      )
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
      httpOnly: false, // your manager UI reads it client-side
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie("mt", row.token, {
      httpOnly: true, // not needed in JS, only server-side
      sameSite: "lax",
      secure: isProd,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie(
      "mgr_info",
      JSON.stringify({
        salon_id: row.salon_id,
        manager_phone: row.manager_phone,
      }),
      {
        httpOnly: false,
        sameSite: "lax",
        secure: isProd,
        path: "/",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      }
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
      return DateTime.fromISO(iso, { zone: "utc" })
        .setZone(tz)
        .toFormat("MMM d, yyyy • h:mm a");
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

    const recent = db
      .prepare(
        `
      SELECT *
      FROM posts
      WHERE salon_id = ?
        AND status NOT IN ('published')
        AND datetime(created_at) >= datetime('now', '-7 days')
      ORDER BY datetime(created_at) DESC
      LIMIT 100
    `
      )
      .all(salon_id);

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
                    class="w-[180px] h-[180px] md:w-[220px] md:h-[220px] object-cover rounded-lg shadow-lg" />
            </div>

            <!-- RIGHT: DETAILS -->
            <div>
              <h3 class="font-semibold text-white text-lg mb-1">Post #${post.salon_post_number ?? 1
          }</h3>
              <p class="text-xs text-slate-400 mb-4">
                Created ${post.created_at_formatted}
              </p>

              <div class="prose prose-invert text-sm mb-4">
                ${post.final_caption.replace(/\n/g, "<br/>")}
              </div>

              <!-- BUTTONS -->
              <div class="flex flex-wrap gap-3 mt-4">
                <form method="POST" action="/manager/approve">
                  <input type="hidden" name="post_id" value="${post.id}" />
                  <input type="hidden" name="action" value="schedule" />
                  <button
                    class="rounded-full bg-blue-600 hover:bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    Approve (schedule)
                  </button>
                </form>

                <form method="POST" action="/manager/approve">
                  <input type="hidden" name="post_id" value="${post.id}" />
                  <input type="hidden" name="action" value="post_now" />
                  <button
                    class="rounded-full bg-green-600 hover:bg-green-700 px-4 py-1.5 text-xs font-semibold text-white"
                  >
                    Post now
                  </button>
                </form>

                <form method="POST" action="/manager/deny">
                  <input type="hidden" name="post_id" value="${post.id}" />
                  <div class="flex flex-wrap items-center gap-2 mt-2">
                    <input
                      name="reason"
                      placeholder="Reason for denial…"
                      class="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white placeholder:text-zinc-400 w-48"
                    />
                    <button
                      class="bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-full px-4 py-1.5"
                    >
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
              <span class="text-blue-400 font-semibold">#${post.salon_post_number || "—"
        } — ${post.stylist_name || "Unknown Stylist"}</span>
              <span class="text-zinc-400 text-sm ml-2">${post.status.toUpperCase() || ""
        }</span>
            </div>
            <span class="text-xs text-zinc-500">${fmtLocal(post.scheduled_for) || "—"
        }</span>
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

                ${isEditable
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
                    <textarea name="final_caption" class="w-full p-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200" rows="3">${post.final_caption ||
          ""}</textarea>
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

    const pendingCards = await Promise.all(
      pending.map((row) => card(row, true))
    );
    const recentCards = await Promise.all(
      recent.map((row) => card(row, false))
    );

    const body = `
      <section class="mb-8">
        <div class="flex flex-col gap-2">
          <h1 class="text-2xl font-semibold text-white">
            Manager Dashboard — <span class="text-mpPrimary">${getSalonName(
      salon_id
    )}</span>
          </h1>
          <p class="text-sm text-slate-400">
            Logged in as ${req.manager.manager_name || req.manager.name || "Manager"
      } (${req.manager.manager_phone || "unknown"}).
          </p>
          <p class="text-xs text-slate-500">
            Use the navigation above to open Database, Scheduler Analytics, or Admin settings.
          </p>
        </div>
      </section>

      <section class="space-y-4 mb-10">
        <h2 class="text-xl font-semibold text-white">Pending Approval</h2>
        ${pendingCards.length
        ? `<div class="flex flex-col gap-6">${pendingCards.join("")}</div>`
        : `<div class="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-zinc-300">No pending posts.</div>`
      }

      </section>

      <section class="space-y-4">
        <h2 class="text-xl font-semibold text-white">Recent (Approved / Queued / Published / Failed / Denied)</h2>
        ${recentCards.length
        ? `<div class="flex flex-col gap-4">${recentCards.join("")}</div>`
        : `<div class="bg-zinc-900/60 border border-zinc-800 rounded-xl p-6 text-zinc-300">No recent posts yet.</div>`
      }
      </section>
    `;

    res.send(
      pageShell({
        title: "Manager Dashboard",
        body,
        salon_id,
        manager_phone,
        current: "manager",
      })
    );
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
    if (post.salon_id !== req.manager.salon_id)
      return res.redirect("/manager?err=forbidden");

    if (action === "post_now") {
      // Publish immediately
      db.prepare(
        `UPDATE posts SET status='queued', scheduled_for=?, approved_at=datetime('now','utc') WHERE id=?`
      ).run(DateTime.utc().toISO(), post_id);

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
      const randDelay =
        Math.floor(Math.random() * (delay.max - delay.min + 1)) + delay.min;
      const scheduledUtc = DateTime.utc()
        .plus({ minutes: randDelay })
        .toISO({ suppressMilliseconds: true });

      db.prepare(
        `
        UPDATE posts
        SET status='queued',
            approved_by=?,
            approved_at=datetime('now','utc'),
            scheduled_for=?
        WHERE id=?
      `
      ).run(req.manager.manager_phone, scheduledUtc, post_id);

      console.log(
        `🕓 [Manager] Post ${post_id} approved & queued for ${scheduledUtc} UTC (${randDelay}min delay)`
      );
    } else {
      // fallback for other future actions
      db.prepare(
        `UPDATE posts SET status='approved', approved_at=datetime('now','utc') WHERE id=?`
      ).run(post_id);
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
    if (post.salon_id !== req.manager.salon_id)
      return res.redirect("/manager?err=forbidden");

    db.prepare(
      `UPDATE posts
         SET status='denied',
             approved_by=?,
             approved_at=datetime('now')
       WHERE id=?`
    ).run(req.manager.manager_phone, post_id);

    console.log(
      `❌ Post ${post_id} denied by ${req.manager.manager_phone
      }. Reason: ${reason || "none"}`
    );

    // Notify stylist by SMS (using your Twilio helper if available)
    try {
      const sendMessageMod = await import("../utils/sendMessage.js").catch(
        () => null
      );
      const sender = sendMessageMod?.default || sendMessageMod; // handle default export vs named
      const body = `❌ Your post was denied by management.${reason ? `\nReason: ${reason}` : ""
        }\n\nPlease edit and resubmit when ready.`;
      if (sender?.sendText && post.phone)
        await sender.sendText(post.phone, body);
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
    if (post.salon_id !== req.manager.salon_id)
      return res.redirect("/manager?err=forbidden");

    db.prepare(
      `UPDATE posts
       SET status='cancelled', updated_at=datetime('now','utc')
       WHERE id=?`
    ).run(post_id);

    console.log(
      `🛑 Post ${post_id} cancelled by ${req.manager.manager_phone}.`
    );
    return res.redirect("/manager?ok=cancelled");
  } catch (err) {
    console.error("❌ /manager/cancel error:", err);
    return res.redirect("/manager?err=server");
  }
});

// ───────────────────────────────────────────────────────────
// Admin page — salon configuration & social connections (DB-backed)
// ───────────────────────────────────────────────────────────
router.get("/admin", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id || "unknown";
  const manager_phone = req.manager?.manager_phone || "";

  // Load salon directly from DB
  const salonRow = db
    .prepare(
      `
      SELECT *
      FROM salons
      WHERE slug = ?
    `
    )
    .get(salon_id);

  if (!salonRow) {
    return res.send(
      pageShell({
        title: "Admin — Not Found",
        body: `<div class="text-red-400 font-semibold">Salon not found in database.</div>`,
        salon_id,
        manager_phone,
        current: "admin",
      })
    );
  }

  // Managers from DB
  const dbManagers = db
    .prepare(
      `
      SELECT id, name, phone, role
      FROM managers
      WHERE salon_id = ?
      ORDER BY name ASC
    `
    )
    .all(salon_id);

  // Stylists from DB
  const dbStylists = db
    .prepare(
      `
      SELECT id, name, phone, instagram_handle, specialties
      FROM stylists
      WHERE salon_id = ?
      ORDER BY name ASC
    `
    )
    .all(salon_id);

  // Helper: format roles nicely
  const formatRole = (role) => {
    if (!role) return "Service Provider";
    const normalized = String(role).toLowerCase();
    if (normalized === "owner") return "Owner";
    if (normalized === "manager") return "Manager";
    if (normalized === "service_provider" || normalized === "stylist")
      return "Service Provider";
    if (normalized === "support" || normalized === "support_team")
      return "Support Team";
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  };

  // Helper: compute a default salon hashtag from name/slug
  const makeSalonHashtag = () => {
    const base =
      (salonRow.name || salon_id || "")
        .replace(/[^A-Za-z0-9]+/g, "")
        .trim() || "MySalon";
    return `#${base}`;
  };

  // Normalize / trim default hashtags (limit 5, ensure leading "#")
  let defaultHashtags = [];
  if (
    typeof salonRow.default_hashtags === "string" &&
    salonRow.default_hashtags.trim().length
  ) {
    const raw = salonRow.default_hashtags.trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        defaultHashtags = parsed;
      } else {
        defaultHashtags = raw.split(",");
      }
    } catch {
      defaultHashtags = raw.split(",");
    }
  }

  defaultHashtags = defaultHashtags
    .map((t) => (t == null ? "" : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      // Strip any leading # and re-add exactly one
      const cleaned = t.replace(/^#+/, "");
      return `#${cleaned}`;
    });

  // Ensure we always include a salon hashtag
  const salonTag = makeSalonHashtag();
  if (!defaultHashtags.length) {
    defaultHashtags = [salonTag];
  } else if (
    !defaultHashtags.some(
      (t) => t.toLowerCase() === salonTag.toLowerCase()
    )
  ) {
    defaultHashtags.unshift(salonTag);
  }

  // Enforce max of 5 total (including salon tag)
  defaultHashtags = defaultHashtags.slice(0, 5);

  // Custom hashtags (for editing): all tags except salonTag
  const customHashtags = defaultHashtags.filter(
    (t) => t.toLowerCase() !== salonTag.toLowerCase()
  );
  const customHashtagsJson = JSON.stringify(customHashtags);

  // Map DB fields to what the admin page expects
  const info = {
    name: salonRow.name,
    city: salonRow.city,
    state: salonRow.state,
    website: salonRow.website,
    booking_url: salonRow.booking_link,
    timezone: salonRow.timezone || "America/Indiana/Indianapolis",
    industry: salonRow.industry
      ? salonRow.industry.charAt(0).toUpperCase() + salonRow.industry.slice(1)
      : "Salon",
    tone_profile: salonRow.tone || "default",
    auto_publish: !!salonRow.auto_publish,
    default_hashtags: defaultHashtags,
  };

  const settings = {
    posting_window: {
      start: salonRow.posting_start_time || "09:00",
      end: salonRow.posting_end_time || "21:00",
    },
    require_manager_approval: salonRow.auto_approval ? false : true,
    random_delay_minutes: {
      min: salonRow.spacing_min,
      max: salonRow.spacing_max,
    },
    notify_stylist_on_approval: false, // future enhancement
    notify_stylist_on_denial: false, // future enhancement
  };

  const compliance = {
    // Future: once we track SMS consent in DB, wire this up.
    stylist_sms_consent_required: false,
  };

  const bookingUrl = info.booking_url || "";
  const timezone = info.timezone;

    // Registered team members (Managers + Stylists, with roles & SMS stub)
  const teamRows = []
    .concat(
      dbManagers.map((m) => {
        return {
          id: m.id,
          type: "manager",
          name: m.name || "—",
          role: formatRole(m.role || "manager"),
          phone: m.phone || "—",
          instagram_handle: "—", // managers don’t have IG handle in DB schema yet
          specialties: [],
          sms_opt_in: "—", // wired later when consent is tracked
        };
      }),
      dbStylists.map((s) => {
        let specialties = [];
        if (typeof s.specialties === "string" && s.specialties.trim().length) {
          try {
            const parsed = JSON.parse(s.specialties);
            if (Array.isArray(parsed)) {
              specialties = parsed;
            } else {
              specialties = String(s.specialties)
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            }
          } catch {
            specialties = String(s.specialties)
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
          }
        }

        return {
          id: s.id,
          type: "stylist",
          name: s.name || "—",
          role: "Service Provider",
          phone: s.phone || "—",
          instagram_handle: s.instagram_handle || "—",
          specialties,
          sms_opt_in: "—", // wired later when consent is tracked
        };
      })
    )
    .map((row) => {
      const spec =
        row.specialties && row.specialties.length
          ? row.specialties.join(", ")
          : "—";

      const esc = (val) =>
        String(val || "")
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'");

      const actionsHtml =
        row.type === "stylist"
          ? `<button
               type="button"
               class="edit-stylist-btn text-xs text-indigo-400 hover:text-indigo-300 underline"
               data-id="${esc(row.id)}"
               data-name="${esc(row.name)}"
               data-phone="${esc(row.phone)}"
               data-ig="${esc(row.instagram_handle === "—" ? "" : row.instagram_handle)}"
               data-specialties='${esc(JSON.stringify(row.specialties || []))}'
             >
               Edit
             </button>`
          : "";

      return `
        <tr
          class="border-b border-zinc-800/80"
          data-member-id="${row.id || ""}"
          data-member-type="${row.type}"
        >
          <td class="px-3 py-2 text-sm text-zinc-100">${row.name}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${row.role}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${row.phone}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${row.instagram_handle}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${spec}</td>
          <td class="px-3 py-2 text-xs text-zinc-300">${row.sms_opt_in}</td>
          <td class="px-3 py-2 text-xs text-zinc-300 text-right">
            ${actionsHtml}
          </td>
        </tr>
      `;
    })
    .join("");

  const fbPageId = salonRow.facebook_page_id || "Not configured";
  const igHandle = salonRow.instagram_handle || "Not configured";

  // Build 12-hour posting window display
  const fmtTime = (val) => {
    if (!val) return "—";
    const [h, m] = val.split(":").map((x) => parseInt(x, 10));
    const dt = DateTime.fromObject({
      hour: h,
      minute: m || 0,
    });
    return dt.toFormat("h:mm a");
  };

  const body = `
    <section class="mb-6">
      <h1 class="text-2xl font-bold mb-2">
        Admin — <span class="text-mpPrimary">${getSalonName(
    salon_id
  )}</span>
      </h1>
      <p class="text-sm text-zinc-400">
        Manage social connections, posting rules, and team configuration for this salon.
      </p>
    </section>

    <!-- Social Connections -->
    <section class="mb-6 grid gap-4 md:grid-cols-[1.2fr,0.8fr]">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <h2 class="text-sm font-semibold text-zinc-50 mb-2">Facebook & Instagram</h2>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Facebook Page ID</dt>
            <dd class="font-mono text-[11px]">${fbPageId}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Instagram Handle</dt>
            <dd class="font-mono text-[11px]">
              ${igHandle === "Not configured"
      ? "Not configured"
      : "@" + igHandle
    }
            </dd>
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

      <!-- Salon Info -->
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Salon Info</h2>
          <button onclick="editSalonInfo()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>
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
            <dt class="text-zinc-400">State</dt>
            <dd>${info.state || "—"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Industry</dt>
            <dd>${info.industry || "Salon"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Timezone</dt>
            <dd>${timezone}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Booking URL</dt>
            <dd class="truncate max-w-[12rem]">
              ${bookingUrl
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
          <div class="flex flex-col gap-1 mt-2">
            <div class="flex items-center justify-between mb-1">
              <dt class="text-zinc-400">Default Hashtags</dt>
              <button onclick="editHashtags()" class="text-slate-400 hover:text-white text-xs">✏️</button>
            </div>
            <dd class="flex flex-wrap gap-1">
              ${info.default_hashtags && info.default_hashtags.length
      ? info.default_hashtags
        .map(
          (tag) =>
            `<span class="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[11px]">${tag}</span>`
        )
        .join("")
      : "—"
    }
            </dd>
          </div>
        </dl>
      </div>
    </section>

    <!-- Posting Rules -->
    <section class="mb-6 grid gap-4 md:grid-cols-2">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Posting Window</h2>
          <button onclick="editPostingRules()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>
        <p class="text-xs text-zinc-300">
          MostlyPostly only posts inside your configured window (salon local time).
        </p>
        <dl class="mt-3 space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Start</dt>
            <dd>${fmtTime(settings.posting_window.start)}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">End</dt>
            <dd>${fmtTime(settings.posting_window.end)}</dd>
          </div>
        </dl>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-sm font-semibold text-zinc-50">Manager Rules</h2>
          <button onclick="editManagerRules()" class="text-slate-400 hover:text-white text-xs">✏️</button>
        </div>
        <dl class="space-y-1 text-xs text-zinc-300">
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Require Manager Approval</dt>
            <dd>${settings.require_manager_approval ? "Yes" : "No"}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-zinc-400">Random Delay</dt>
            <dd>
              ${settings.random_delay_minutes.min != null &&
      settings.random_delay_minutes.max != null
      ? `${settings.random_delay_minutes.min}–${settings.random_delay_minutes.max} min`
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

    <!-- Registered Team Members -->
    <section class="mb-6">
      <div class="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
        <div class="mb-3">
          <div class="flex items-center justify-between mb-1">
            <h2 class="text-sm font-semibold text-zinc-50">Registered Team Members</h2>
            <button
              onclick="addTeamMember()"
              class="ml-3 text-xs font-semibold text-mpAccent hover:text-mpAccentDark"
            >
              + Add
            </button>
          </div>
          <p class="text-[11px] text-zinc-400">
            Managers and stylists who can receive SMS and post through MostlyPostly.
          </p>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full border-collapse text-xs">
            <thead class="bg-zinc-950/80 text-zinc-400">
              <tr>
                <th class="px-3 py-2 text-left">Name</th>
                <th class="px-3 py-2 text-left">Role</th>
                <th class="px-3 py-2 text-left">Phone</th>
                <th class="px-3 py-2 text-left">IG Handle</th>
                <th class="px-3 py-2 text-left">Specialties</th>
                <th class="px-3 py-2 text-left">SMS Opt-in</th>
                <th class="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>

                <tbody>
                  ${teamRows ||
    `
                    <tr>
                      <td colspan="7" class="px-3 py-4 text-center text-xs text-zinc-500">
                        No team members registered yet.
                      </td>
                    </tr>
                    `
    }
                </tbody>
          </table>
        </div>
      </div>
    </section>

        <!-- Hidden modal templates -->
          <!-- Edit Stylist Modal -->
          <div id="modal-edit-stylist-template" class="hidden">
            <h3 class="text-lg font-semibold mb-4">Edit Stylist</h3>

            <form method="POST" action="/manager/admin/update-stylist" class="space-y-4">

              <input type="hidden" name="id" id="edit-stylist-id" />
              <input type="hidden" name="specialties_json" id="edit-specialties-json" />

              <div>
                <label class="text-xs text-slate-400">Full Name</label>
                <input
                  id="edit-stylist-name"
                  name="name"
                  class="w-full mt-1 p-2 bg-slate-800 rounded text-sm"
                  required
                />
              </div>

              <div>
                <label class="text-xs text-slate-400">Mobile Number</label>
                <input
                  id="edit-stylist-phone"
                  name="phone"
                  class="w-full mt-1 p-2 bg-slate-800 rounded text-sm"
                  required
                />
              </div>

              <div>
                <label class="text-xs text-slate-400">Instagram Handle (optional)</label>
                <div class="flex items-center gap-1 mt-1">
                  <span class="text-sm text-slate-500">@</span>
                  <input
                    id="edit-stylist-ig"
                    name="instagram_handle"
                    class="w-full p-2 bg-slate-800 rounded text-sm"
                  />
                </div>
              </div>

              <div>
                <label class="text-xs text-slate-400">Specialties</label>
                <div id="edit-specialties-rows" class="space-y-2 mt-1 mb-2"></div>
                <p class="text-[11px] text-slate-500 mt-1">
                  Up to 5 specialties.
                </p>
              </div>

              <button class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-2 mt-4">
                Save Changes
              </button>
            </form>
          </div>

            <div id="modal-salon-info-template" class="hidden">
            <h3 class="text-lg font-semibold mb-4">Edit Salon Info</h3>
            <form method="POST" action="/manager/admin/update-salon-info" class="space-y-4">
              <input type="hidden" name="salon_id" value="${salon_id}" />

              <div>
                <label class="text-xs text-slate-400">Salon Name</label>
                <input name="name" class="w-full mt-1 p-2 bg-slate-800 rounded" value="${info.name || ""}" />
              </div>

              <div>
                <label class="text-xs text-slate-400">City</label>
                <input name="city" class="w-full mt-1 p-2 bg-slate-800 rounded" value="${info.city || ""}" />
              </div>

              <div>
                <label class="text-xs text-slate-400">State</label>
                <input maxlength="2" name="state"
                      class="w-full mt-1 p-2 bg-slate-800 rounded uppercase"
                      value="${info.state || ""}" />
              </div>

              <div>
                <label class="text-xs text-slate-400">Website</label>
                <input name="website" class="w-full mt-1 p-2 bg-slate-800 rounded" value="${info.website || ""}" />
              </div>

              <div>
                <label class="text-xs text-slate-400">Booking URL</label>
                <input name="booking_url" class="w-full mt-1 p-2 bg-slate-800 rounded" value="${info.booking_url || ""}" />
              </div>

              <div>
                <label class="text-xs text-slate-400">Timezone</label>
                <select name="timezone" class="w-full mt-1 p-2 bg-slate-800 rounded">
                  ${[
      ["Eastern (US)", "America/New_York"],
      ["Central (US)", "America/Chicago"],
      ["Mountain (US)", "America/Denver"],
      ["Mountain (No DST)", "America/Phoenix"],
      ["Pacific (US)", "America/Los_Angeles"],
    ]
      .map(
        ([lbl, val]) =>
          `<option value="${val}" ${val === info.timezone ? "selected" : ""
          }>${lbl}</option>`
      )
      .join("") || ""
    }
                </select>
              </div>

              <button class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-2 mt-4">
                Save Changes
              </button>
            </form>
            </div>

            <div id="modal-posting-rules-template" class="hidden">
            <h3 class="text-lg font-semibold mb-4">Edit Posting Rules</h3>
            <form method="POST" action="/manager/admin/update-posting-rules" class="space-y-4">
              <input type="hidden" name="salon_id" value="${salon_id}" />

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="text-xs text-slate-400">Posting Window Start</label>
                  <select name="posting_start_time" class="w-full mt-1 p-2 bg-slate-800 rounded">
                    ${[
      ["7:00 AM", "07:00"],
      ["8:00 AM", "08:00"],
      ["9:00 AM", "09:00"],
      ["10:00 AM", "10:00"],
      ["11:00 AM", "11:00"],
      ["12:00 PM", "12:00"],
      ["1:00 PM", "13:00"],
      ["2:00 PM", "14:00"],
      ["3:00 PM", "15:00"],
      ["4:00 PM", "16:00"],
      ["5:00 PM", "17:00"],
      ["6:00 PM", "18:00"],
      ["7:00 PM", "19:00"],
      ["8:00 PM", "20:00"],
      ["9:00 PM", "21:00"],
      ["10:00 PM", "22:00"],
    ]
      .map(
        ([lbl, val]) =>
          `<option value="${val}" ${val === settings.posting_window.start ? "selected" : ""
          }>${lbl}</option>`
      )
      .join("") || ""
    }
                  </select>
                </div>
                <div>
                  <label class="text-xs text-slate-400">Posting Window End</label>
                  <select name="posting_end_time" class="w-full mt-1 p-2 bg-slate-800 rounded">
                    ${[
      ["7:00 AM", "07:00"],
      ["8:00 AM", "08:00"],
      ["9:00 AM", "09:00"],
      ["10:00 AM", "10:00"],
      ["11:00 AM", "11:00"],
      ["12:00 PM", "12:00"],
      ["1:00 PM", "13:00"],
      ["2:00 PM", "14:00"],
      ["3:00 PM", "15:00"],
      ["4:00 PM", "16:00"],
      ["5:00 PM", "17:00"],
      ["6:00 PM", "18:00"],
      ["7:00 PM", "19:00"],
      ["8:00 PM", "20:00"],
      ["9:00 PM", "21:00"],
      ["10:00 PM", "22:00"],
    ]
      .map(
        ([lbl, val]) =>
          `<option value="${val}" ${val === settings.posting_window.end ? "selected" : ""
          }>${lbl}</option>`
      )
      .join("") || ""
    }
                  </select>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="text-xs text-slate-400">Spacing Min (minutes)</label>
                  <input type="number" name="spacing_min"
                    class="w-full mt-1 p-2 bg-slate-800 rounded"
                    value="${settings.random_delay_minutes.min || 20}" />
                </div>
                <div>
                  <label class="text-xs text-slate-400">Spacing Max (minutes)</label>
                  <input type="number" name="spacing_max"
                    class="w-full mt-1 p-2 bg-slate-800 rounded"
                    value="${settings.random_delay_minutes.max || 45}" />
                </div>
              </div>

              <div>
                <label class="text-xs text-slate-400">Auto-Approval</label>
                <select name="auto_approval" class="w-full mt-1 p-2 bg-slate-800 rounded">
                  <option value="0" ${settings.require_manager_approval ? "selected" : ""
    }>Disabled</option>
                  <option value="1" ${!settings.require_manager_approval ? "selected" : ""
    }>Enabled</option>
                </select>
              </div>

              <div>
                <label class="text-xs text-slate-400">Auto-Publish</label>
                <select name="auto_publish" class="w-full mt-1 p-2 bg-slate-800 rounded">
                  <option value="0" ${info.auto_publish ? "" : "selected"}>Disabled</option>
                  <option value="1" ${info.auto_publish ? "selected" : ""}>Enabled</option>
                </select>
              </div>

              <button class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-2 mt-4">
                Save Changes
              </button>
            </form>
            </div>

            <div id="modal-hashtags-template" class="hidden">
              <h3 class="text-lg font-semibold mb-4">Edit Default Hashtags</h3>
              <form method="POST" action="/manager/admin/update-hashtags" class="space-y-4">
                <input type="hidden" name="salon_id" value="${salon_id}" />
                <p class="text-xs text-slate-400 mb-1">
                  Your salon hashtag is always included and cannot be removed.
                </p>
                <div class="mb-2">
                  <span class="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-[11px] mr-2">
                    ${salonTag}
                  </span>
                </div>

                <div>
                  <label class="text-xs text-slate-400">Custom Hashtags (up to 4 more; salon hashtag makes 5 total)</label>
                  <div id="hashtags-rows" class="space-y-2 mt-1 mb-2"></div>
                  <input
                    type="hidden"
                    name="hashtags_json"
                    id="hashtags-json"
                    value='${customHashtagsJson.replace(/'/g, "&#39;")}'
                  />
                  <p class="text-[11px] text-slate-500 mt-1">
                    One hashtag per line. Do not include spaces. We will automatically add the # if missing. Case is preserved.
                  </p>
                </div>

                <button type="button" class="w-full bg-indigo-600 hover:bg-indigo-700 rounded p-2 mt-4" onclick="submitHashtagsForm()">
                  Save Hashtags
                </button>
              </form>
            </div>

            <!-- Shared modal container -->
            <div id="admin-modal-backdrop"
                class="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] hidden"></div>

              <div id="admin-modal"
                  class="fixed inset-0 flex items-center justify-center z-[9999] hidden">
                <div id="admin-modal-panel"
                  class="bg-slate-900 border border-slate-700 rounded-2xl shadow-xl w-[420px] max-h-[85vh] overflow-y-auto p-6 relative">
                <button id="admin-modal-close"
                  class="absolute top-3 right-3 text-slate-400 hover:text-white text-xl">
                  ×
                </button>
                <div id="admin-modal-content"></div>
              </div>
            </div>

            <script>
              // Modal control JS
                const modal = document.getElementById("admin-modal");
                const modalBackdrop = document.getElementById("admin-modal-backdrop");
                const modalContent = document.getElementById("admin-modal-content");
                const modalClose = document.getElementById("admin-modal-close");

                function openAdminModalFromTemplate(templateId) {
                  const tpl = document.getElementById(templateId);
                  if (!tpl) return;
                  modalContent.innerHTML = tpl.innerHTML;
                  modal.classList.remove("hidden");
                  modalBackdrop.classList.remove("hidden");

                  // Initialize any template-specific UI
                  if (templateId === "modal-hashtags-template") {
                    initHashtagsModal();
                  } else if (templateId === "modal-team-member-template") {
                    initSpecialtiesModal();
                  } else if (templateId === "modal-edit-stylist-template") {
                    // Edit stylist modal is wired by openEditStylist()
                  }
                }

                function closeAdminModal() {
                  modal.classList.add("hidden");
                  modalBackdrop.classList.add("hidden");
                  modalContent.innerHTML = "";
                }

                modalClose.addEventListener("click", closeAdminModal);
                modalBackdrop.addEventListener("click", closeAdminModal);
                document.addEventListener("keydown", (e) => {
                  if (e.key === "Escape") closeAdminModal();
                });

                function editSalonInfo() {
                  openAdminModalFromTemplate("modal-salon-info-template");
                }

                function editPostingRules() {
                  openAdminModalFromTemplate("modal-posting-rules-template");
                }

                function editManagerRules() {
                  // For now, reuse posting rules modal
                  openAdminModalFromTemplate("modal-posting-rules-template");
                }

                function editHashtags() {
                  openAdminModalFromTemplate("modal-hashtags-template");
                }

                function addTeamMember() {
                  openAdminModalFromTemplate("modal-team-member-template");
                }

                // Explicit submit for hashtag form
                function submitHashtagsForm() {
                  const form = modalContent.querySelector(
                    "form[action='/manager/admin/update-hashtags']"
                  );
                  if (form) form.submit();
                }

                // Hashtag UI (row-based) for Default Hashtags modal
                function initHashtagsModal() {
                  const modalRoot = modalContent;
                  const rowsContainer = modalRoot.querySelector("#hashtags-rows");
                  const hidden = modalRoot.querySelector("#hashtags-json");
                  if (!rowsContainer || !hidden) return;

                  let tags = [];
                  try {
                    const parsed = JSON.parse(hidden.value || "[]");
                    if (Array.isArray(parsed)) {
                      tags = parsed
                        .map((t) => (t == null ? "" : String(t)))
                        .map((t) => t.replace(/^#+/, "").trim())
                        .filter((t) => t.length > 0);
                    }
                  } catch {
                    tags = [];
                  }

                  function sync(reRender) {
                    const cleaned = tags
                      .map((t) => (t == null ? "" : String(t).trim()))
                      .filter((t) => t.length > 0)
                      .map((t) => {
                        const v = t.replace(/^#+/, "");
                        return v ? "#" + v : "";
                      })
                      .filter((t) => t.length > 0)
                      .slice(0, 4);

                    hidden.value = JSON.stringify(cleaned);
                    if (reRender) render();
                  }

                  function render() {
                    rowsContainer.innerHTML = "";
                    if (!tags.length) {
                      tags = [""];
                    }
                    if (tags.length > 4) tags = tags.slice(0, 4);

                    tags.forEach((value, index) => {
                      const row = document.createElement("div");
                      row.className = "flex items-center gap-2";

                      const input = document.createElement("input");
                      input.type = "text";
                      input.className =
                        "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
                      input.value = value || "";
                      input.placeholder = "hashtag";
                      input.addEventListener("input", () => {
                        tags[index] = input.value;
                        sync(false);
                      });

                      const addBtn = document.createElement("button");
                      addBtn.type = "button";
                      addBtn.textContent = "+";
                      addBtn.className =
                        "px-2 py-1 rounded bg-slate-800 text-xs text-slate-100 hover:bg-slate-700";
                      addBtn.addEventListener("click", () => {
                        if (tags.length >= 4) return;
                        tags.push("");
                        sync(true);
                      });

                      const removeBtn = document.createElement("button");
                      removeBtn.type = "button";
                      removeBtn.textContent = "×";
                      removeBtn.className =
                        "px-2 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:bg-red-500";
                      removeBtn.addEventListener("click", () => {
                        tags.splice(index, 1);
                        sync(true);
                      });

                      row.appendChild(input);
                      row.appendChild(addBtn);
                      row.appendChild(removeBtn);
                      rowsContainer.appendChild(row);
                    });
                  }

                  render();
                  sync(false);
                }

                // Specialties UI for Add Stylist modal (row-based)
                function initSpecialtiesModal() {
                  const modalRoot = modalContent;

                  const rowsContainer = modalRoot.querySelector("#specialties-rows");
                  const hidden = modalRoot.querySelector("#specialties-json");
                  if (!rowsContainer || !hidden) return;

                  let tags = [];
                  try {
                    const parsed = JSON.parse(hidden.value || "[]");
                    if (Array.isArray(parsed)) {
                      tags = parsed
                        .map((t) => (t == null ? "" : String(t).trim()))
                        .filter((t) => t.length > 0);
                    }
                  } catch {
                    tags = [];
                  }

                  function sync(reRender) {
                    const cleaned = tags
                      .map((t) => (t == null ? "" : String(t).trim()))
                      .filter((t) => t.length > 0)
                      .slice(0, 5);

                    hidden.value = JSON.stringify(cleaned);
                    if (reRender) render();
                  }

                  function render() {
                    rowsContainer.innerHTML = "";
                    if (!tags.length) {
                      tags = [""];
                    }
                    if (tags.length > 5) tags = tags.slice(0, 5);

                    tags.forEach((value, index) => {
                      const row = document.createElement("div");
                      row.className = "flex items-center gap-2";

                      const input = document.createElement("input");
                      input.type = "text";
                      input.className =
                        "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
                      input.value = value || "";
                      input.placeholder = "specialty";
                      input.addEventListener("input", () => {
                        tags[index] = input.value;
                        sync(false);
                      });

                      const addBtn = document.createElement("button");
                      addBtn.type = "button";
                      addBtn.textContent = "+";
                      addBtn.className =
                        "px-2 py-1 rounded bg-slate-800 text-xs text-slate-100 hover:bg-slate-700";
                      addBtn.addEventListener("click", () => {
                        if (tags.length >= 5) return;
                        tags.push("");
                        sync(true);
                      });

                      const removeBtn = document.createElement("button");
                      removeBtn.type = "button";
                      removeBtn.textContent = "×";
                      removeBtn.className =
                        "px-2 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:bg-red-500";
                      removeBtn.addEventListener("click", () => {
                        tags.splice(index, 1);
                        sync(true);
                      });

                      row.appendChild(input);
                      row.appendChild(addBtn);
                      row.appendChild(removeBtn);
                      rowsContainer.appendChild(row);
                    });
                  }

                  render();
                  sync(false);
                }

                // Open Edit Stylist modal with existing data
                function openEditStylist(id, name, phone, instagram, specialtiesJson) {
                  openAdminModalFromTemplate("modal-edit-stylist-template");

                  const idInput = modalContent.querySelector("#edit-stylist-id");
                  const nameInput = modalContent.querySelector("#edit-stylist-name");
                  const phoneInput = modalContent.querySelector("#edit-stylist-phone");
                  const igInput = modalContent.querySelector("#edit-stylist-ig");
                  const hiddenSpecsInput = modalContent.querySelector("#edit-specialties-json");
                  const rowsContainer = modalContent.querySelector("#edit-specialties-rows");

                  if (!idInput || !nameInput || !phoneInput || !igInput || !hiddenSpecsInput || !rowsContainer) {
                    console.error("Edit stylist modal elements missing");
                    return;
                  }

                  idInput.value = id || "";
                  nameInput.value = name || "";
                  phoneInput.value = phone || "";
                  igInput.value = instagram || "";

                  let specs = [];
                  try {
                    const parsed = JSON.parse(specialtiesJson || "[]");
                    if (Array.isArray(parsed)) {
                      specs = parsed
                        .map((t) => (t == null ? "" : String(t).trim()))
                        .filter((t) => t.length > 0)
                        .slice(0, 5);
                    }
                  } catch {
                    specs = [];
                  }

                  function syncFromDom() {
                    const values = Array.from(rowsContainer.querySelectorAll("input"))
                      .map((inp) => (inp.value || "").trim())
                      .filter((v) => v.length > 0)
                      .slice(0, 5);
                    hiddenSpecsInput.value = JSON.stringify(values);
                  }

                  function addRow(initialValue) {
                    const currentInputs = rowsContainer.querySelectorAll("input");
                    if (currentInputs.length >= 5) return;

                    const row = document.createElement("div");
                    row.className = "flex items-center gap-2";

                    const input = document.createElement("input");
                    input.type = "text";
                    input.className =
                      "flex-1 bg-slate-800 rounded p-2 text-sm text-slate-100";
                    input.value = initialValue || "";
                    input.placeholder = "specialty";
                    input.addEventListener("input", syncFromDom);

                    const addBtn = document.createElement("button");
                    addBtn.type = "button";
                    addBtn.textContent = "+";
                    addBtn.className =
                      "px-2 py-1 rounded bg-slate-800 text-xs text-slate-100 hover:bg-slate-700";
                    addBtn.addEventListener("click", () => {
                      addRow("");
                      syncFromDom();
                    });

                    const removeBtn = document.createElement("button");
                    removeBtn.type = "button";
                    removeBtn.textContent = "×";
                    removeBtn.className =
                      "px-2 py-1 rounded bg-slate-800 text-xs text-slate-300 hover:bg-red-500";
                    removeBtn.addEventListener("click", () => {
                      row.remove();
                      syncFromDom();
                    });

                    row.appendChild(input);
                    row.appendChild(addBtn);
                    row.appendChild(removeBtn);
                    rowsContainer.appendChild(row);

                    syncFromDom();
                  }

                  rowsContainer.innerHTML = "";
                  if (specs.length === 0) {
                    addRow("");
                  } else {
                    specs.forEach((s) => addRow(s));
                  }
                  syncFromDom();
                }

                // Global handler for Edit Stylist buttons
                document.addEventListener("click", (e) => {
                  const btn = e.target.closest(".edit-stylist-btn");
                  if (!btn) return;

                  const id = btn.dataset.id || "";
                  const name = btn.dataset.name || "";
                  const phone = btn.dataset.phone || "";
                  const ig = btn.dataset.ig || "";
                  let specs = [];
                  try {
                    specs = JSON.parse(btn.dataset.specialties || "[]");
                  } catch {
                    specs = [];
                  }
                  openEditStylist(id, name, phone, ig, JSON.stringify(specs));
                });
            </script>
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

// ───────────────────────────────────────────────────────────
// Admin update routes
// ───────────────────────────────────────────────────────────

// Update Salon Info
router.post("/admin/update-salon-info", requireAuth, (req, res) => {
  const { salon_id, name, city, state, website, booking_url, timezone } =
    req.body;

  db.prepare(
    `UPDATE salons
     SET name = ?, city = ?, state = ?, website = ?, booking_link = ?, timezone = ?, updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    (name || "").trim(),
    (city || "").trim(),
    (state || "").trim(),
    (website || "").trim(),
    (booking_url || "").trim(),
    timezone || "America/Indiana/Indianapolis",
    salon_id
  );

  res.redirect("/manager/admin");
});

// Add a new stylist from Admin
// Update Stylist
router.post("/admin/update-stylist", requireAuth, (req, res) => {
  const salon_id = req.manager?.salon_id || "unknown";
  const { id, name, phone, instagram_handle, specialties_json } = req.body;

  if (!id || !name || !phone) {
    return res.redirect("/manager/admin?err=stylist_update_missing_fields");
  }

  let specialties = [];
  if (specialties_json && specialties_json.trim().length) {
    try {
      const parsed = JSON.parse(specialties_json);
      if (Array.isArray(parsed)) {
        specialties = parsed
          .map((t) => (t == null ? "" : String(t).trim()))
          .filter((t) => t.length > 0);
      }
    } catch {
      // ignore parse error → treat as empty
    }
  }

  db.prepare(
    `UPDATE stylists
     SET name = ?,
         phone = ?,
         instagram_handle = ?,
         specialties = ?,
         updated_at = datetime('now')
     WHERE id = ?
       AND salon_id = ?`
  ).run(
    (name || "").trim(),
    (phone || "").trim(),
    (instagram_handle || "").trim(),
    specialties.length ? JSON.stringify(specialties) : null,
    id,
    salon_id
  );

  return res.redirect("/manager/admin");
});

// Update Posting Rules
router.post("/admin/update-posting-rules", requireAuth, (req, res) => {
  const {
    salon_id,
    posting_start_time,
    posting_end_time,
    spacing_min,
    spacing_max,
    auto_approval,
    auto_publish,
  } = req.body;

  db.prepare(
    `UPDATE salons
     SET posting_start_time = ?,
         posting_end_time = ?,
         spacing_min = ?,
         spacing_max = ?,
         auto_approval = ?,
         auto_publish = ?,
         updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    posting_start_time || "09:00",
    posting_end_time || "21:00",
    spacing_min || 20,
    spacing_max || 45,
    auto_approval ? 1 : 0,
    auto_publish ? 1 : 0,
    salon_id
  );

  res.redirect("/manager/admin");
});

// Update default hashtags
router.post("/admin/update-hashtags", requireAuth, (req, res) => {
  const { salon_id, hashtags_json } = req.body;

  const salonRow = db
    .prepare(`SELECT name, default_hashtags FROM salons WHERE slug = ?`)
    .get(salon_id);

  const makeSalonHashtag = () => {
    const base =
      (salonRow?.name || salon_id || "")
        .replace(/[^A-Za-z0-9]+/g, "")
        .trim() || "MySalon";
    return `#${base}`;
  };

  const salonTag = makeSalonHashtag();

  let tags = [];
  if (hashtags_json && hashtags_json.trim().length) {
    try {
      const parsed = JSON.parse(hashtags_json);
      if (Array.isArray(parsed)) {
        tags = parsed;
      }
    } catch {
      // ignore parse error → keep empty
    }
  }

  // normalize, trim, enforce leading #
  tags = tags
    .map((t) => (t == null ? "" : String(t)))
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const cleaned = t.replace(/^#+/, "");
      return `#${cleaned}`;
    });

  // enforce max 4 custom tags (salonTag + up to 4 = 5 total)
  if (tags.length > 4) tags = tags.slice(0, 4);

  // final list always includes salonTag at front
  const finalTags = [salonTag, ...tags];

  db.prepare(
    `UPDATE salons
     SET default_hashtags = ?,
         updated_at = datetime('now')
     WHERE slug = ?`
  ).run(JSON.stringify(finalTags), salon_id);

  res.redirect("/manager/admin");
});

export default router;
