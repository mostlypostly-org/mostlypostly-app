// src/ui/pageShell.js
// Unified UI using your original MostlyPostly blue header (from old manager UI)

export default function pageShell({
  title = "MostlyPostly",
  body = "",
  current = "",
  salon_id = "",
  manager_phone = ""
}) {
  const qsSalon = salon_id ? `?salon=${encodeURIComponent(salon_id)}` : "";

  function link(href, label, key) {
    const base = `${href}${qsSalon}`;
    const active =
      current === key
        ? "text-white border-b-2 border-mpPrimary"
        : "text-slate-300 hover:text-white";
    return `<a href="${base}" class="${active} transition px-1 pb-1">${label}</a>`;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title ? title + " • MostlyPostly" : "MostlyPostly"}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            mpPrimary: "#6366F1",
            mpAccent: "#F97316",
          }
        }
      }
    };
  </script>
</head>

<body class="bg-slate-950 text-slate-50 antialiased">

  <!-- HEADER (your old MostlyPostly header) -->
  <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur">
    <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between py-4">

        <!-- Logo -->
        <a href="/manager${qsSalon}" class="flex items-center gap-2" aria-label="MostlyPostly">
          <div class="flex h-8 w-8 items-center justify-center rounded-xl 
                      bg-gradient-to-tr from-mpPrimary to-mpAccent 
                      text-xs font-semibold text-white shadow-md shadow-mpPrimary/40">
            MP
          </div>
          <span class="text-lg font-semibold tracking-tight text-white">MostlyPostly</span>
        </a>

        <!-- NAV -->
        <nav class="hidden md:flex items-center gap-8 text-sm font-medium">
          ${link("/manager", "Manager", "manager")}
          ${link("/dashboard", "Database", "database")}
          ${link("/analytics", "Scheduler Analytics", "scheduler")}
          ${link("/manager/admin", "Admin", "admin")}
          ${link("/manager/logout", "Logout", "logout")}
        </nav>
      </div>
    </div>
  </header>

  <!-- PAGE CONTENT -->
  <main class="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
    ${body}
  </main>

<script src="/public/admin.js"></script>

</body>
</html>
`;
}
