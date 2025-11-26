// src/routes/analytics.js — Scheduler Analytics (multi-tenant auto-detect, site-aligned layout)
import express from "express";
import { db } from "../../db.js";
import { DateTime } from "luxon";
import { getSalonPolicy } from "../scheduler.js";
import { getAllSalons } from "../core/salonLookup.js";
import { getSalonName } from "../core/salonLookup.js";


const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function appHost() {
  return process.env.BASE_URL || "http://localhost:3000";
}

function navBar(current = "scheduler", salon_id = "") {
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

      <!-- Updated MP Logo -->
      <a href="/manager${qsSalon}" class="flex items-center gap-2" aria-label="MostlyPostly manager home">
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
        ${link(`/index.html${qsSalon}`, "Policies", "policies")}
        ${link(`/manager/logout${qsSalon}`, "Logout", "logout")}
      </nav>
    </div>
  </div>
</header>
`;
}

function pageShell({ title, body, salon_id = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Basic Meta -->
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <meta name="description" content="MostlyPostly scheduler analytics for salon posts." />

  <!-- TailwindCSS CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <!-- Tailwind config to match marketing site -->
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
  ${navBar("scheduler", salon_id)}
  <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    ${body}
  </main>
</body>
</html>`;
}

function salonNameFromId(salonId) {
  const policy = getSalonPolicy(salonId) || {};
  return (
    policy?.salon_info?.salon_name ||
    policy?.salon_info?.name ||
    policy?.name ||
    salonId ||
    "Salon"
  );
}

function formatLocalTime(utcString, salonId) {
  if (!utcString) return "—";
  try {
    const salonPolicy = getSalonPolicy(salonId) || {};
    const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";
    const parsedISO = DateTime.fromISO(utcString, { zone: "utc" });
    const dt = parsedISO.isValid
      ? parsedISO
      : DateTime.fromSQL(utcString, { zone: "utc" });
    if (!dt.isValid) return utcString;
    return dt.setZone(tz).toFormat("MMM d, yyyy • h:mm a");
  } catch {
    return utcString;
  }
}

function nextAvailableSlotUtcISO() {
  const row = db
    .prepare(
      `
      SELECT scheduled_for
      FROM posts
      WHERE status IN ('approved','queued')
      ORDER BY datetime(scheduled_for) DESC
      LIMIT 1
    `
    )
    .get();

  let dt;
  if (row?.scheduled_for) {
    dt = DateTime.fromISO(row.scheduled_for, { zone: "utc" });
    if (!dt.isValid) {
      dt = DateTime.fromSQL(row.scheduled_for, { zone: "utc" });
    }
  }
  if (!dt || !dt.isValid) dt = DateTime.utc();
  return dt.plus({ minutes: 30 }).toUTC().toISO({ suppressMilliseconds: true });
}

function resolveSalonId(req) {
  const fromToken = req.manager?.salon_id || req.salon_id || null;
  const fromQuery = req.query.salon || req.query.salon_id || null;
  if (fromToken) return fromToken;
  if (fromQuery) return fromQuery;
  try {
    const all = getAllSalons();
    const ids = Object.keys(all || {});
    if (ids.length === 1) return ids[0];
  } catch {}
  return null;
}

// ─────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────

router.get("/", (req, res) => {
  const salon_id = resolveSalonId(req);
  if (!salon_id) {
    return res
      .status(400)
      .send(
        pageShell({
          title: "Missing salon ID",
          salon_id: "",
          body: `
          <section class="mt-4 rounded-2xl border border-red-500/40 bg-red-950/40 px-4 py-4">
            <p class="text-sm text-red-100">
              ⚠️ No salon context detected. Access via a manager link (token) or add
              <code class="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-200">?salon=&lt;your-salon-id&gt;</code>.
            </p>
          </section>
        `,
        })
      );
  }

  const salonName = salonNameFromId(salon_id);

  const total = db
    .prepare(`SELECT COUNT(*) as count FROM posts WHERE salon_id = ?`)
    .get(salon_id).count;

  const counts = {};
  for (const s of ["manager_pending", "approved", "queued", "published", "denied"]) {
    counts[s] = db
      .prepare(
        `SELECT COUNT(*) as c FROM posts WHERE salon_id = ? AND status=?`
      )
      .get(salon_id, s).c;
  }

  const lastTen = db
    .prepare(
      `SELECT stylist_name, status, datetime(created_at) as created
       FROM posts
       WHERE salon_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT 10`
    )
    .all(salon_id);

  const salonPolicy = getSalonPolicy(salon_id) || {};
  const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";
  const nextUtcSlot = nextAvailableSlotUtcISO();
  const parsed = DateTime.fromISO(nextUtcSlot, { zone: "utc" });
  const nextSlot = parsed.isValid
    ? parsed.setZone(tz).toFormat("MMM d, yyyy • h:mm a")
    : "—";

  const cards = Object.entries({
    Total: total,
    Pending: counts.manager_pending,
    Approved: counts.approved,
    Queued: counts.queued,
    Published: counts.published,
    Denied: counts.denied,
  })
    .map(
      ([label, val]) => `
      <div class="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 text-center shadow-md shadow-black/40">
        <div class="text-2xl font-semibold text-mpPrimary">${val}</div>
        <div class="mt-1 text-xs uppercase tracking-wide text-slate-400">${label}</div>
      </div>`
    )
    .join("\n");

  const recentRows = lastTen
    .map(
      (p) => `
      <tr class="border-b border-slate-800/70 hover:bg-slate-900/80">
        <td class="px-3 py-2 text-sm text-slate-100">${
          p.stylist_name || "?"
        }</td>
        <td class="px-3 py-2 text-xs uppercase tracking-wide text-mpPrimary">${
          p.status
        }</td>
        <td class="px-3 py-2 text-xs text-slate-300">${formatLocalTime(
          p.created,
          salon_id
        )}</td>
      </tr>`
    )
    .join("\n");

  const body = `
    <section class="mb-8">
      <h1 class="text-2xl font-semibold text-white">
          Scheduler Analytics — <span class="text-mpPrimary">${getSalonName(salon_id)}</span>
      </h1>
      <p class="mt-1 text-sm text-slate-400">
        Overview of post statuses and the next scheduling window for this salon.
      </p>
    </section>

    <section class="mb-6 grid gap-4 md:grid-cols-[1.1fr,0.9fr]">
      <div class="space-y-4">
        <div class="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4 text-sm text-slate-200">
          <div class="flex items-center justify-between gap-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Next Scheduler Slot</p>
            <span class="inline-flex items-center rounded-full bg-slate-800 px-3 py-1 text-[11px] text-slate-200">
              ${tz}
            </span>
          </div>
          <p class="mt-2 text-base font-medium text-white">${nextSlot}</p>
          <p class="mt-1 text-xs text-slate-400">
            Based on your salon’s configured posting window.
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
          ${cards}
        </div>
      </div>

      <div class="rounded-2xl border border-slate-800 bg-slate-900/80 px-4 py-4">
        <h2 class="text-sm font-semibold text-white">At a Glance</h2>
        <p class="mt-2 text-xs text-slate-300">
          Use this page to quickly check:
        </p>
        <ul class="mt-2 space-y-1 text-xs text-slate-200">
          <li>• How many posts are pending, approved, queued, or published</li>
          <li>• When the scheduler will run next</li>
          <li>• Recent posting activity by your team</li>
        </ul>
      </div>
    </section>

    <section class="rounded-2xl border border-slate-800 bg-slate-900/80">
      <div class="border-b border-slate-800 px-4 py-3">
        <h2 class="text-sm font-semibold text-white">Recent Activity</h2>
        <p class="mt-1 text-xs text-slate-400">
          Last 10 posts created for this salon.
        </p>
      </div>
      <div class="overflow-x-auto px-4 py-3">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-slate-900/90 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-3 py-2 text-left">Stylist</th>
              <th class="px-3 py-2 text-left">Status</th>
              <th class="px-3 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            ${
              recentRows ||
              "<tr><td colspan='3' class='px-3 py-4 text-center text-sm text-slate-400'>No recent posts.</td></tr>"
            }
          </tbody>
        </table>
      </div>
    </section>
  `;

  res.send(pageShell({ title: `Analytics — ${salonName}`, body, salon_id }));
});

export default router;
