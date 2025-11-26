// src/routes/dashboard.js — MostlyPostly Database Dashboard (multi-tenant auto-detect, site-aligned layout)
import express from "express";
import { db } from "../../db.js";
import { Parser } from "json2csv";
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

function navBar(current = "database", salon_id = "") {
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

function pageShell({
  title,
  body,
  current = "database",
  salon_id = "",
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Basic Meta -->
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />

  <title>${title}</title>
  <meta name="description" content="MostlyPostly manager database view for salon posts." />

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
  ${navBar(current, salon_id)}
  <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
    ${body}
  </main>
</body>
</html>`;
}

function formatLocalTime(ts, salonId) {
  if (!ts) return "—";
  try {
    const salonPolicy = getSalonPolicy(salonId) || {};
    const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";
    let dt;
    if (typeof ts === "string" && ts.includes("T")) {
      dt = DateTime.fromISO(ts, { zone: "utc" });
    } else {
      dt = DateTime.fromSQL(ts, { zone: "utc" });
    }
    if (!dt.isValid) return ts;
    return dt.setZone(tz).toFormat("MMM d, yyyy • h:mm a");
  } catch {
    return ts;
  }
}

function rangeToUtc(range, tz, customStart, customEnd) {
  const now = DateTime.now().setZone(tz);
  let from = DateTime.fromMillis(0).setZone(tz); // "All" = epoch
  let to = now;

  switch ((range || "all").toLowerCase()) {
    case "today":
      from = now.startOf("day");
      to = now.endOf("day");
      break;
    case "yesterday":
      from = now.minus({ days: 1 }).startOf("day");
      to = now.minus({ days: 1 }).endOf("day");
      break;
    case "this week":
      from = now.startOf("week");
      to = now.endOf("week");
      break;
    case "last week":
      from = now.minus({ weeks: 1 }).startOf("week");
      to = now.minus({ weeks: 1 }).endOf("week");
      break;
    case "this month":
      from = now.startOf("month");
      to = now.endOf("month");
      break;
    case "last month":
      from = now.minus({ months: 1 }).startOf("month");
      to = now.minus({ months: 1 }).endOf("month");
      break;
    case "this year":
      from = now.startOf("year");
      to = now.endOf("year");
      break;
    case "last year":
      from = now.minus({ years: 1 }).startOf("year");
      to = now.minus({ years: 1 }).endOf("year");
      break;
    case "custom":
      if (customStart) from = DateTime.fromISO(customStart, { zone: tz });
      if (customEnd) to = DateTime.fromISO(customEnd, { zone: tz });
      break;
    case "all":
    default:
      break;
  }

  return {
    fromUtc: from.toUTC().toISO({ suppressMilliseconds: true }),
    toUtc: to.toUTC().toISO({ suppressMilliseconds: true }),
  };
}

// NEW: resolve salon automatically (token/cookie → query → single-tenant fallback)
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
          current: "database",
          salon_id: "",
          body: `
          <section class="mt-4 rounded-2xl border border-red-500/40 bg-red-950/40 px-4 py-4">
            <p class="text-sm text-red-100">
              ⚠️ No salon context detected. Access this page using your manager link, or add
              <code class="rounded bg-slate-900 px-1 py-0.5 text-[11px] text-slate-200">?salon=&lt;your-salon-id&gt;</code> to the URL.
            </p>
          </section>
        `,
        })
      );
  }

  const salonName = salonNameFromId(salon_id);
  const salonPolicy = getSalonPolicy(salon_id) || {};
  const tz = salonPolicy?.timezone || "America/Indiana/Indianapolis";

  const range = (req.query.range || "all").toLowerCase();
  const statusParam = (req.query.status || "all").toLowerCase();
  const stylist = (req.query.stylist || "").trim().toLowerCase();
  const search = (req.query.search || "").trim().toLowerCase();
  const start = req.query.start || "";
  const end = req.query.end || "";
  const download = req.query.download === "csv";

  const { fromUtc, toUtc } = rangeToUtc(range, tz, start, end);

  let sql = `
    SELECT id, stylist_name, salon_id, status, created_at, scheduled_for, salon_post_number, final_caption, image_url
    FROM posts
    WHERE salon_id = ?
      AND datetime(created_at) BETWEEN datetime(?) AND datetime(?)
  `;

  const params = [salon_id, fromUtc, toUtc];

  if (statusParam !== "all") {
    sql += ` AND LOWER(status) = ?`;
    params.push(statusParam);
  }
  if (stylist) {
    sql += ` AND LOWER(stylist_name) LIKE ?`;
    params.push(`%${stylist}%`);
  }
  if (search) {
    sql += ` AND (LOWER(final_caption) LIKE ?)`;
    params.push(`%${search}%`);
  }

  sql += ` ORDER BY datetime(created_at) DESC LIMIT 1000`;
  const posts = db.prepare(sql).all(...params);

  if (download && posts.length) {
    const parser = new Parser();
    const csv = parser.parse(posts);
    res.header("Content-Type", "text/csv");
    res.attachment(`mostlypostly_${salon_id}_posts.csv`);
    return res.send(csv);
  }

  const rows = posts
    .map(
      (p) => `
      <tr class="border-b border-slate-800/70 hover:bg-slate-900/80">
        <td class="px-3 py-2 text-xs text-slate-300">#${p.salon_post_number ?? "—"}</td>
        <td class="px-3 py-2 text-sm text-slate-100">${p.stylist_name || "—"}</td>
        <td class="px-3 py-2 text-xs uppercase tracking-wide text-mpPrimary">${p.status}</td>
        <td class="px-3 py-2 text-xs text-slate-300">${formatLocalTime(p.created_at, salon_id)}</td>
        <td class="px-3 py-2 text-xs text-slate-300">${formatLocalTime(p.scheduled_for, salon_id)}</td>
      </tr>`
    )
    .join("\n");

  const body = `
    <section class="mb-8">
      <h1 class="text-2xl font-semibold text-white">
        Database — <span class="text-mpPrimary">${getSalonName(salon_id)}</span>
      </h1>
      <p class="mt-1 text-sm text-slate-400">
        Filter and export your posts for this salon.
      </p>
    </section>

    <section class="mb-6 rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-4">
      <form class="grid gap-3 text-xs text-slate-200 sm:grid-cols-2 lg:grid-cols-4" method="GET">
        <input type="hidden" name="salon" value="${salon_id}" />
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">Range</label>
          <select name="range" class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary">
            ${["all","today","yesterday","this week","last week","this month","last month","this year","last year","custom"]
              .map(
                (r) =>
                  `<option value="${r}" ${
                    range === r ? "selected" : ""
                  }>${r.replace(/\b\w/g, (m) => m.toUpperCase())}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">Status</label>
          <select name="status" class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary">
            ${["all","manager_pending","approved","queued","published","denied"]
              .map(
                (s) =>
                  `<option value="${s}" ${
                    statusParam === s ? "selected" : ""
                  }>${s === "all" ? "All statuses" : s}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">Stylist</label>
          <input
            type="text"
            name="stylist"
            value="${stylist || ""}"
            placeholder="Name"
            class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">Search caption</label>
          <input
            type="text"
            name="search"
            value="${search || ""}"
            placeholder="Keyword"
            class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">Start (custom)</label>
          <input
            type="date"
            name="start"
            value="${start}"
            class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-slate-400">End (custom)</label>
          <input
            type="date"
            name="end"
            value="${end}"
            class="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-mpPrimary focus:outline-none focus:ring-1 focus:ring-mpPrimary"
          />
        </div>
        <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-2">
          <button
            type="submit"
            class="inline-flex items-center justify-center rounded-full bg-mpPrimary px-4 py-1.5 text-xs font-semibold text-white shadow-md shadow-mpPrimary/40 hover:bg-mpPrimaryDark"
          >
            Apply Filters
          </button>
          <a
            href="/dashboard?salon=${encodeURIComponent(
              salon_id
            )}"
            class="text-[11px] text-slate-400 hover:text-slate-200"
          >
            Reset
          </a>
          <a
            href="/dashboard?salon=${encodeURIComponent(
              salon_id
            )}&download=csv&range=${encodeURIComponent(
    range
  )}&status=${encodeURIComponent(
    statusParam
  )}&stylist=${encodeURIComponent(
    stylist
  )}&search=${encodeURIComponent(search)}&start=${encodeURIComponent(
    start
  )}&end=${encodeURIComponent(end)}"
            class="ml-auto inline-flex items-center justify-center rounded-full border border-slate-600 px-4 py-1.5 text-[11px] font-medium text-slate-200 hover:border-mpPrimary hover:text-white"
          >
            Download CSV
          </a>
        </div>
      </form>
    </section>

    <section class="rounded-2xl border border-slate-800 bg-slate-900/70">
      <div class="overflow-x-auto rounded-2xl">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-slate-900/90 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th class="px-3 py-2 text-left">ID</th>
              <th class="px-3 py-2 text-left">Stylist</th>
              <th class="px-3 py-2 text-left">Status</th>
              <th class="px-3 py-2 text-left">Created</th>
              <th class="px-3 py-2 text-left">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              "<tr><td colspan='5' class='px-3 py-4 text-center text-sm text-slate-400'>No posts in this range.</td></tr>"
            }
          </tbody>
        </table>
      </div>
    </section>
  `;

  res.send(
    pageShell({
      title: `Database — ${salonName}`,
      body,
      current: "database",
      salon_id,
    })
  );
});

export default router;
