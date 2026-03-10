// src/ui/pageShell.js — Left sidebar navigation

import { db } from "../../db.js";

export default function pageShell({
  title = "MostlyPostly",
  body  = "",
  current = "",
  salon_id = "",
  manager_phone = "",
}) {
  const qs = salon_id ? `?salon=${encodeURIComponent(salon_id)}` : "";

  // Active location name + plan for sidebar
  let activeSalonName = "";
  let salonPlan = "";
  if (salon_id) {
    try {
      const row = db.prepare("SELECT name, plan FROM salons WHERE slug = ?").get(salon_id);
      if (row) { activeSalonName = row.name; salonPlan = row.plan || ""; }
    } catch (_) {}
  }
  const isPro = salonPlan === "pro";
  const locationInitials = activeSalonName
    ? activeSalonName.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase()
    : "";

  function isActive(key) {
    return current === key;
  }

  function navItem(href, icon, label, key) {
    const active = isActive(key);
    const linkClasses = active
      ? "bg-mpAccentLight text-mpAccent"
      : "text-mpMuted hover:bg-mpBg hover:text-mpCharcoal";
    return `
      <div class="group relative w-full flex justify-center px-3">
        <a href="${href}${qs}" aria-label="${label}"
           class="flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${linkClasses}">
          ${icon}
        </a>
        <div class="pointer-events-none absolute left-[calc(100%-4px)] top-1/2 -translate-y-1/2 z-50
                    whitespace-nowrap rounded-lg bg-mpCharcoal px-2.5 py-1.5 text-xs font-semibold text-white
                    opacity-0 group-hover:opacity-100 transition-opacity shadow-lg ml-3">
          ${label}
          <div class="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-mpCharcoal"></div>
        </div>
      </div>`;
  }


  // Mobile nav link (full-width with label)
  function mobileNavLink(href, label, key) {
    const active = isActive(key);
    return `<a href="${href}${qs}"
      class="block py-2.5 border-b border-mpBorder text-sm font-medium transition-colors
             ${active ? "text-mpAccent font-semibold" : "text-mpMuted hover:text-mpCharcoal"}">
      ${label}
    </a>`;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title ? title + " • MostlyPostly" : "MostlyPostly"}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
          },
          colors: {
            mpCharcoal:     "#2B2D35",
            mpCharcoalDark: "#1a1c22",
            mpAccent:       "#D4897A",
            mpAccentLight:  "#F2DDD9",
            mpBg:           "#FDF8F6",
            mpCard:         "#FFFFFF",
            mpBorder:       "#EDE7E4",
            mpMuted:        "#7A7C85",
          }
        }
      }
    };
  </script>
  <style>
    body { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; }
    /* Ensure sidebar flyout tooltips/menus escape sidebar bounds */
    #app-sidebar { overflow: visible; }
    .group:hover .group-hover\\:opacity-100 { opacity: 1; }
  </style>
</head>

<body class="bg-mpBg text-mpCharcoal antialiased">

  <!-- ══════════════════════════════════════════════════
       LEFT SIDEBAR (desktop)
  ══════════════════════════════════════════════════ -->
  <aside id="app-sidebar"
    class="fixed inset-y-0 left-0 z-30 hidden md:flex w-16 flex-col border-r border-mpBorder bg-white">

    <!-- Logo mark -->
    <a href="/manager${qs}"
       class="flex h-16 w-16 shrink-0 items-center justify-center border-b border-mpBorder">
      <img src="/public/logo/logo-mark.png" alt="MostlyPostly" class="h-5 w-auto" />
    </a>

    <!-- Active location indicator -->
    ${locationInitials ? `
    <div class="group relative w-full flex justify-center pt-3 pb-1">
      <a href="/manager/locations"
         class="flex h-7 w-7 items-center justify-center rounded-lg bg-mpAccentLight text-mpAccent text-xs font-bold leading-none">
        ${locationInitials}
      </a>
      <div class="pointer-events-none absolute left-[calc(100%-4px)] top-1/2 -translate-y-1/2 z-50
                  whitespace-nowrap rounded-lg bg-mpCharcoal px-2.5 py-1.5 text-xs font-semibold text-white
                  opacity-0 group-hover:opacity-100 transition-opacity shadow-lg ml-3">
        ${activeSalonName}
        <div class="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-mpCharcoal"></div>
      </div>
    </div>` : ""}

    <!-- Primary nav -->
    <nav class="flex flex-1 flex-col items-center py-3 gap-0.5">
      ${navItem("/manager",            ICONS.home,      "Dashboard",    "manager")}
      ${navItem("/manager/queue",      ICONS.queue,     "Post Queue",   "queue")}
      ${navItem("/analytics",          ICONS.chart,     "Analytics",    "analytics")}
      ${navItem("/manager/stylists",   ICONS.team,      "Team",         "team")}
      ${navItem("/manager/scheduler",  ICONS.clock,     "Scheduler",    "scheduler")}
      ${navItem("/dashboard",          ICONS.database,  "Database",     "database")}
      ${navItem("/manager/vendors",       ICONS.tag,          "Vendors",       "vendors")}
      ${isPro ? navItem("/manager/integrations", ICONS.integration,  "Integrations",  "integrations") : ""}
      ${navItem("/manager/locations",    ICONS.building,     "Locations",     "locations")}
      ${navItem("/manager/billing",      ICONS.card,         "Billing",       "billing")}
      ${navItem("/manager/admin",        ICONS.cog,          "Admin",         "admin")}
    </nav>

    <!-- Logout at bottom -->
    <div class="border-t border-mpBorder py-3">
      ${navItem("/manager/logout", ICONS.logout, "Logout", "logout")}
    </div>
  </aside>

  <!-- ══════════════════════════════════════════════════
       MOBILE TOP BAR
  ══════════════════════════════════════════════════ -->
  <header class="md:hidden fixed top-0 inset-x-0 z-30 flex h-14 items-center justify-between
                 px-4 bg-white border-b border-mpBorder">
    <a href="/manager${qs}">
      <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" class="h-7 w-auto" />
    </a>
    <button id="mobileNavBtn" class="text-mpMuted text-2xl leading-none" aria-label="Open menu">&#9776;</button>
  </header>

  <!-- ══════════════════════════════════════════════════
       MOBILE OVERLAY NAV
  ══════════════════════════════════════════════════ -->
  <div id="mobileNav" class="hidden fixed inset-0 z-40 flex-col bg-white md:hidden">
    <div class="flex items-center justify-between px-5 py-4 border-b border-mpBorder">
      <img src="/public/logo/logo-mark.png" alt="MostlyPostly" class="h-10 w-auto" />
      <button id="mobileNavClose" class="text-mpMuted text-3xl leading-none">&times;</button>
    </div>
    <nav class="flex-1 px-5 py-4 space-y-0.5 overflow-y-auto">
      ${mobileNavLink("/manager",            "Dashboard",  "manager")}
      ${mobileNavLink("/manager/queue",      "Post Queue", "queue")}
      ${mobileNavLink("/analytics",          "Analytics",  "analytics")}
      ${mobileNavLink("/manager/stylists",   "Team",       "team")}
      ${mobileNavLink("/manager/scheduler",  "Scheduler",  "scheduler")}
      ${mobileNavLink("/dashboard",          "Database",   "database")}
      ${mobileNavLink("/manager/vendors",       "Vendors",       "vendors")}
      ${isPro ? mobileNavLink("/manager/integrations", "Integrations",  "integrations") : ""}
      ${mobileNavLink("/manager/locations",    "Locations",     "locations")}
      ${mobileNavLink("/manager/billing",      "Billing",       "billing")}
      ${mobileNavLink("/manager/admin",        "Admin",         "admin")}
      <a href="/manager/logout"
         class="block py-2.5 text-sm font-medium text-mpMuted hover:text-mpCharcoal transition-colors">
        Logout
      </a>
    </nav>
  </div>

  <!-- ══════════════════════════════════════════════════
       MAIN CONTENT
  ══════════════════════════════════════════════════ -->
  <div class="md:pl-16 pt-14 md:pt-0 min-h-screen">
    <main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      ${body}
    </main>
  </div>

  <script src="/public/admin.js"></script>
  <script>
    const mobileNavBtn   = document.getElementById("mobileNavBtn");
    const mobileNavClose = document.getElementById("mobileNavClose");
    const mobileNav      = document.getElementById("mobileNav");
    if (mobileNavBtn)   mobileNavBtn.onclick   = () => { mobileNav.classList.remove("hidden"); mobileNav.classList.add("flex"); };
    if (mobileNavClose) mobileNavClose.onclick = () => { mobileNav.classList.add("hidden"); mobileNav.classList.remove("flex"); };
  </script>

</body>
</html>
`;
}

// ══════════════════════════════════════════════════
// SVG Icons (Heroicons outline, 20px)
// ══════════════════════════════════════════════════
const ICONS = {
  home: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
  </svg>`,

  database: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125m0 4.5c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
  </svg>`,

  chart: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
  </svg>`,

  clock: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
  </svg>`,

  card: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 21Z" />
  </svg>`,

  cog: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>`,

  logout: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15M12 9l3 3m0 0-3 3m3-3H2.25" />
  </svg>`,

  team: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
  </svg>`,

  tag: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 0 0 3 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 0 0 5.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 0 0 9.568 3Z" />
    <path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6Z" />
  </svg>`,

  building: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z" />
  </svg>`,

  queue: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
  </svg>`,

  integration: `<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75">
    <path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
  </svg>`,
};
