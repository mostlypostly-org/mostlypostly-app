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
    `<a href="${href}" class="${
      current === key
        ? "text-mpCharcoal border-b-2 border-mpAccent font-semibold"
        : "text-mpMuted hover:text-mpCharcoal"
    } transition px-1 pb-1">${label}</a>`;

  return `
<header class="border-b border-mpBorder bg-white/90 backdrop-blur sticky top-0 z-30">
  <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
    <div class="flex items-center justify-between py-3">
      <a href="/manager${qsSalon}" aria-label="MostlyPostly manager home">
        <img src="/public/logo/logo.png" alt="MostlyPostly" class="w-40 h-auto" />
      </a>
      <nav class="hidden items-center gap-8 text-sm font-medium md:flex">
        ${link(`/manager${qsSalon}`, "Dashboard", "manager")}
        ${link(`/dashboard${qsSalon}`, "Database", "database")}
        ${link(`/analytics${qsSalon}`, "Analytics", "scheduler")}
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
  current = "database",
  salon_id = "",
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: { sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
          colors: {
            mpCharcoal: "#2B2D35", mpCharcoalDark: "#1a1c22",
            mpAccent: "#D4897A", mpAccentLight: "#F2DDD9",
            mpBg: "#FDF8F6", mpCard: "#FFFFFF",
            mpBorder: "#EDE7E4", mpMuted: "#7A7C85",
          }
        }
      }
    };
  </script>
  <style>body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; }</style>
</head>
<body class="bg-mpBg text-mpCharcoal antialiased">
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
          <section class="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-4">
            <p class="text-sm text-red-700">
              ⚠️ No salon context detected. Access this page using your manager link, or add
              <code class="rounded bg-white px-1 py-0.5 text-[11px] text-mpCharcoal">?salon=&lt;your-salon-id&gt;</code> to the URL.
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
  const postTypeParam = (req.query.post_type || "all").toLowerCase();
  const stylist = (req.query.stylist || "").trim().toLowerCase();
  const search = (req.query.search || "").trim().toLowerCase();
  const start = req.query.start || "";
  const end = req.query.end || "";
  const download = req.query.download === "csv";

  const { fromUtc, toUtc } = rangeToUtc(range, tz, start, end);

  let sql = `
    SELECT id, stylist_name, salon_id, status, post_type, created_at, scheduled_for, salon_post_number, final_caption, image_url, image_urls
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
  if (postTypeParam !== "all") {
    sql += ` AND LOWER(post_type) = ?`;
    params.push(postTypeParam);
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

  const postTypeColors = {
    standard_post: "bg-mpMuted text-white",
    before_after:  "bg-purple-500 text-white",
    products:      "bg-green-600 text-white",
    promotions:    "bg-yellow-500 text-white",
    availability:  "bg-mpAccent text-white",
  };

  const rows = posts
    .map(
      (p) => {
        const pt = p.post_type || "standard_post";
        const ptLabel = pt.replace(/_/g, " ");
        const ptColor = postTypeColors[pt] || postTypeColors.standard_post;
        return `
      <tr class="border-b border-mpBorder hover:bg-mpBg">
        <td class="px-3 py-2 text-xs text-mpMuted">#${p.salon_post_number ?? "—"}</td>
        <td class="px-3 py-2 text-sm text-mpCharcoal">${p.stylist_name || "—"}</td>
        <td class="px-3 py-2 text-xs uppercase tracking-wide text-mpAccent">${p.status}</td>
        <td class="px-3 py-2 text-xs">
          <span class="inline-block rounded px-2 py-0.5 text-xs font-medium capitalize ${ptColor}">${ptLabel}</span>
        </td>
        <td class="px-3 py-2 text-xs text-mpMuted">${formatLocalTime(p.created_at, salon_id)}</td>
        <td class="px-3 py-2 text-xs text-mpMuted">${formatLocalTime(p.scheduled_for, salon_id)}</td>
      </tr>`;
      }
    )
    .join("\n");

  const body = `
    <section class="mb-8">
      <h1 class="text-2xl font-extrabold text-mpCharcoal">
        Database — <span class="text-mpAccent">${getSalonName(salon_id)}</span>
      </h1>
      <p class="mt-1 text-sm text-mpMuted">Filter and export your posts for this salon.</p>
    </section>

    <section class="mb-6 rounded-2xl border border-mpBorder bg-white px-4 py-4">
      <form class="grid gap-3 text-xs text-mpCharcoal sm:grid-cols-2 lg:grid-cols-4" method="GET">
        <input type="hidden" name="salon" value="${salon_id}" />
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Range</label>
          <select name="range" class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent">
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
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Status</label>
          <select name="status" class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent">
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
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Type</label>
          <select name="post_type" class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent">
            ${["all","standard_post","before_after","availability","promotions","products"]
              .map(
                (t) =>
                  `<option value="${t}" ${
                    postTypeParam === t ? "selected" : ""
                  }>${t === "all" ? "All types" : t.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Stylist</label>
          <input
            type="text"
            name="stylist"
            value="${stylist || ""}"
            placeholder="Name"
            class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs text-mpCharcoal placeholder:text-mpMuted focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Search caption</label>
          <input
            type="text"
            name="search"
            value="${search || ""}"
            placeholder="Keyword"
            class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs text-mpCharcoal placeholder:text-mpMuted focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">Start (custom)</label>
          <input
            type="date"
            name="start"
            value="${start}"
            class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs text-mpCharcoal placeholder:text-mpMuted focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-[11px] uppercase tracking-wide text-mpMuted">End (custom)</label>
          <input
            type="date"
            name="end"
            value="${end}"
            class="rounded-md border border-mpBorder bg-white px-2 py-1.5 text-xs text-mpCharcoal placeholder:text-mpMuted focus:border-mpAccent focus:outline-none focus:ring-1 focus:ring-mpAccent"
          />
        </div>
        <div class="flex items-end gap-2 sm:col-span-2 lg:col-span-2">
          <button
            type="submit"
            class="inline-flex items-center justify-center rounded-full bg-mpAccent px-4 py-1.5 text-xs font-semibold text-white shadow-md hover:bg-[#c47867]"
          >
            Apply Filters
          </button>
          <a
            href="/dashboard?salon=${encodeURIComponent(
              salon_id
            )}"
            class="text-[11px] text-mpMuted hover:text-mpCharcoal"
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
            class="ml-auto inline-flex items-center justify-center rounded-full border border-mpBorder px-4 py-1.5 text-[11px] font-medium text-mpCharcoal hover:border-mpAccent hover:text-mpCharcoal"
          >
            Download CSV
          </a>
        </div>
      </form>
    </section>

    <section class="rounded-2xl border border-mpBorder bg-white">
      <div class="overflow-x-auto rounded-2xl">
        <table class="w-full border-collapse text-sm">
          <thead class="bg-mpBg text-xs uppercase tracking-wide text-mpMuted">
            <tr>
              <th class="px-3 py-2 text-left">ID</th>
              <th class="px-3 py-2 text-left">Stylist</th>
              <th class="px-3 py-2 text-left">Status</th>
              <th class="px-3 py-2 text-left">Type</th>
              <th class="px-3 py-2 text-left">Created</th>
              <th class="px-3 py-2 text-left">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows ||
              "<tr><td colspan='5' class='px-3 py-4 text-center text-sm text-mpMuted'>No posts in this range.</td></tr>"
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
