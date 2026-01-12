// src/routes/manager.js — Restored MostlyPostly “Old Blue UI” Manager Dashboard
import express from "express";
import { db } from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { DateTime } from "luxon";
import { getSalonName } from "../core/salonLookup.js";
import { handleManagerApproval } from "../core/messageRouter.js";

const router = express.Router();

/* -------------------------------------------------------------
   AUTH MIDDLEWARE (SESSION ONLY)
------------------------------------------------------------- */
function requireAuth(req, res, next) {
  if (!req.session?.manager_id) {
    return res.redirect("/manager/login");
  }

  const row = db
    .prepare(`SELECT * FROM managers WHERE id = ?`)
    .get(req.session.manager_id);

  if (!row) {
    req.session.manager_id = null;
    return res.redirect("/manager/login");
  }

  req.manager = {
    id: row.id,
    salon_id: row.salon_id,
    phone: row.phone,
    name: row.name || "Manager",
  };

  next();
}

/* -------------------------------------------------------------
   GET /manager — OLD UI restored
------------------------------------------------------------- */
router.get("/", requireAuth, (req, res) => {
  const salon_id = req.manager.salon_id;
  const managerPhone = req.manager.phone || "";
  const mgrName = req.manager.name || "Manager";

  const salonName = getSalonName(salon_id) || "Your Salon";

  // Fetch pending
  const pending = db
    .prepare(
      `SELECT *
       FROM posts
       WHERE salon_id = ? AND status = 'manager_pending'
       ORDER BY created_at DESC`
    )
    .all(salon_id);

  // Fetch recent (all except manager_pending)
  const recent = db
    .prepare(
      `SELECT *
        FROM posts
        WHERE salon_id = ?
          AND status NOT IN ('manager_pending')
        ORDER BY created_at DESC
       LIMIT 25`
    )
    .all(salon_id);

  const fmt = (iso) => {
    try {
      if (!iso) return "—";
      return DateTime.fromISO(iso, { zone: "utc" }).toFormat(
        "MMM d, yyyy • h:mm a"
      );
    } catch {
      return iso;
    }
  };

  /* -------------------------------------------------------------
     PENDING CARDS — exact original blue MostlyPostly UI
  ------------------------------------------------------------- */
  const pendingCards =
    pending.length === 0
      ? `<p class="text-slate-300 text-sm">No pending posts.</p>`
      : pending
          .map((p) => {
            const caption = (p.final_caption || p.caption || "")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/\n/g, "<br/>");

            return `
          <div class="rounded-xl bg-slate-900 border border-slate-800 p-5 mb-5">
            <div class="flex gap-4">
              <img 
                src="${p.image_url}" 
                class="w-32 h-32 rounded-lg object-cover border border-slate-700" 
              />

              <div class="flex-1">
                <p class="text-xs text-slate-400 mb-1">
                  Pending • Post #${p.salon_post_number || "—"}
                </p>

                <p class="text-sm whitespace-pre-line text-slate-100 leading-relaxed">
                  ${caption}
                </p>

                <div class="flex flex-wrap gap-3 mt-4">

                  <a href="/manager/approve?post=${p.id}"
                     class="px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded text-xs text-white">
                    Approve
                  </a>

                  <a href="/manager/post-now?post=${p.id}"
                     class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-xs text-white">
                    Post Now
                  </a>

                  <a href="/manager/edit/${p.id}"
                     class="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 rounded text-xs text-white">
                    Edit
                  </a>

                  <a href="/manager/deny?post=${p.id}"
                     class="px-3 py-1.5 bg-red-600 hover:bg-red-700 rounded text-xs text-white">
                    Deny
                  </a>

                </div>
              </div>
            </div>
          </div>
        `;
          })
          .join("");

  /* -------------------------------------------------------------
     RECENT CARDS — exact old simple list
  ------------------------------------------------------------- */
  const recentCards =
  recent.length === 0
    ? `<div class="text-slate-500 text-sm italic">No recent posts.</div>`
    : recent.map((p) => {
        const caption = (p.final_caption || p.caption || "")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br/>");

          return `
          <div class="recent-card rounded-xl bg-slate-900 border border-slate-800 p-4 mb-4">

            <div class="flex gap-4">
              <img
                src="${p.image_url}"
                class="w-24 h-24 rounded-lg object-cover border border-slate-700"
              />

              <div class="flex-1">

                <p class="text-xs text-slate-400">
                  Status: <span class="font-semibold">${p.status}</span> • Post #${p.salon_post_number || "—"}
                </p>
                <p class="text-xs text-slate-500 mb-2">${fmt(p.created_at)}</p>

                <!-- Collapsed Caption -->
                <p class="text-sm text-slate-300 leading-relaxed line-clamp-2">
                  ${caption.replace(/<br\/>/g, " ")}
                </p>

                <a href="#" class="text-xs text-blue-400 hover:underline"
                  onclick="this.closest('.recent-card').querySelector('.full-caption').classList.toggle('hidden'); return false;">
                  Show more
                </a>

                <!-- Expanded Caption -->
                <div class="full-caption hidden mt-2 text-sm text-slate-200 whitespace-pre-line leading-relaxed">
                  ${caption}
                </div>

              </div>
            </div>
          </div>
                `;
              }).join("");

  /* -------------------------------------------------------------
     PAGE BODY (old layout)
  ------------------------------------------------------------- */
  const body = `
      <h1 class="text-2xl font-bold mb-2 text-white">
        Manager Dashboard — <span class="text-mpPrimary">${salonName}</span>
      </h1>
      <p class="text-sm text-slate-400 mb-8">
        Logged in as ${mgrName} (${managerPhone})
      </p>

      <h2 class="text-xl font-semibold mb-3 text-white">Pending Approval</h2>
      ${pendingCards}

      <h2 class="text-xl font-semibold mt-10 mb-3 text-white">Recent Activity</h2>
      ${recentCards}
  `;

  return res.send(
    pageShell({
      title: "Manager Dashboard",
      current: "manager",
      salon_id,
      body,
    })
  );
});

/* -------------------------------------------------------------
   APPROVE
------------------------------------------------------------- */
router.get("/approve", requireAuth, async (req, res) => {
  const id = req.query.post;
  if (!id) return res.redirect("/manager");

  const pendingPost = db.prepare(`
    SELECT *
    FROM posts
    WHERE id = ?
      AND status = 'manager_pending'
  `).get(id);

  if (!pendingPost) {
    console.warn("⚠️ Dashboard approve: post not found or not pending", id);
    return res.redirect("/manager");
  }

  // 🔑 This does EVERYTHING:s
  // - status = manager_approved
  // - scheduled_for = now
  // - stylist notification
  // - scheduler eligibility
  await handleManagerApproval(
    req.manager.phone || "dashboard",
    pendingPost,
    (to, msg) => {
      console.log("📤 Dashboard approval notify:", to);
    }
  );

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   POST NOW
------------------------------------------------------------- */
router.get("/post-now", requireAuth, (req, res) => {
  const id = req.query.post;

  if (id) {
    db.prepare(`
      UPDATE posts
      SET
        status = 'manager_approved',
        scheduled_for = datetime('now'),
        approved_at = datetime('now','utc')
      WHERE id = ?
    `).run(id);
  }

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   CANCEL
------------------------------------------------------------- */
router.get("/cancel", requireAuth, (req, res) => {
  const id = req.query.post;
  if (id) {
    db.prepare(
      `UPDATE posts
       SET status='cancelled',
           updated_at=datetime('now')
       WHERE id=?`
    ).run(id);
  }
  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   DENY — FORM
------------------------------------------------------------- */
router.get("/deny", requireAuth, (req, res) => {
  const id = req.query.post;

  const body = `
    <div class="max-w-md mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-white mb-4">Deny Post</h1>

      <form method="POST" action="/manager/deny" class="space-y-4">
        <input type="hidden" name="post_id" value="${id}" />

        <div>
          <label class="text-xs text-slate-400">Reason</label>
          <textarea
            name="reason"
            class="w-full p-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 h-32"
            required
          ></textarea>
        </div>

        <button class="w-full bg-red-600 hover:bg-red-700 p-3 rounded-lg text-sm font-semibold">
          Submit Denial
        </button>
      </form>
    </div>
  `;

  res.send(
    pageShell({
      title: "Deny Post",
      body,
      current: "manager",
      salon_id: req.manager.salon_id,
    })
  );
});

/* -------------------------------------------------------------
   DENY — SAVE
------------------------------------------------------------- */
router.post("/deny", requireAuth, (req, res) => {
  const { post_id, reason } = req.body;

  db.prepare(
    `UPDATE posts
     SET status='denied',
         denial_reason=?,
         updated_at=datetime('now')
     WHERE id=?`
  ).run(reason.trim(), post_id);

  return res.redirect("/manager");
});

/* -------------------------------------------------------------
   EDIT — FORM
------------------------------------------------------------- */
router.get("/edit/:id", requireAuth, (req, res) => {
  const id = req.params.id;

  const post = db.prepare(`SELECT * FROM posts WHERE id=?`).get(id);
  if (!post) return res.redirect("/manager");

  const body = `
    <div class="max-w-lg mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6 mt-12">
      <h1 class="text-lg font-bold text-white mb-4">Edit Caption</h1>

      <form method="POST" action="/manager/edit/${id}" class="space-y-4">
        <textarea
          name="caption"
          class="w-full p-3 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 h-48"
        >${post.final_caption || post.caption || ""}</textarea>

        <button class="w-full bg-blue-600 hover:bg-blue-700 p-3 rounded-lg text-sm font-semibold">
          Save Changes
        </button>
      </form>
        <a href="/manager?salon=${req.manager.salon_id}"
          class="w-full block text-center bg-slate-700 hover:bg-slate-600 p-3 rounded-lg text-sm font-semibold text-white">
          Cancel
        </a>
    </div>
  `;

  return res.send(
    pageShell({
      title: "Edit Post",
      current: "manager",
      salon_id: req.manager.salon_id,
      body,
    })
  );
});

/* -------------------------------------------------------------
   EDIT — SAVE
------------------------------------------------------------- */
router.post("/edit/:id", requireAuth, (req, res) => {
  const id = req.params.id;
  const { caption } = req.body;

  // Normalize caption to prevent spacing expansion issues
  const cleaned = (caption || "")
    .replace(/\r\n/g, "\n")     // Normalize Windows-style newlines
    .replace(/\n{3,}/g, "\n\n") // Collapse 3+ blank lines into 1 blank line
    .trim();

  // Save cleaned caption
  db.prepare(
    `UPDATE posts
     SET final_caption = ?, updated_at=datetime('now')
     WHERE id = ?`
  ).run(cleaned, id);

  // Redirect back to manager for the appropriate salon
  const salonSlug = req.manager?.salon_id || "";
  return res.redirect(`/manager?salon=${salonSlug}`);
});

export default router;
