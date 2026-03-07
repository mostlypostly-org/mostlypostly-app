// src/ui/pageShell.js

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
        ? "text-mpCharcoal border-b-2 border-mpAccent font-semibold"
        : "text-mpMuted hover:text-mpCharcoal";
    return `<a href="${base}" class="${active} transition px-1 pb-1">${label}</a>`;
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
  </style>
</head>

<body class="bg-mpBg text-mpCharcoal antialiased">

  <header class="border-b border-mpBorder bg-white/90 backdrop-blur sticky top-0 z-30">
    <div class="mx-auto max-w-6xl pl-0 pr-4 sm:pr-6 lg:pr-8">
      <div class="flex items-center justify-between py-3">

        <a href="/manager${qsSalon}" class="flex items-center" aria-label="MostlyPostly">
          <img src="/public/logo/logo-trimmed.png" alt="MostlyPostly" class="w-64 h-auto" />
        </a>

        <nav class="hidden md:flex items-center gap-8 text-sm font-medium">
          ${link("/manager", "Dashboard", "manager")}
          ${link("/dashboard", "Database", "database")}
          ${link("/analytics", "Analytics", "scheduler")}
          ${link("/manager/admin", "Admin", "admin")}
          ${link("/manager/logout", "Logout", "logout")}
        </nav>

        <!-- Mobile nav placeholder -->
        <button id="mobileNavBtn" class="md:hidden text-mpMuted text-2xl">☰</button>
      </div>
    </div>
  </header>

  <!-- Mobile menu -->
  <div id="mobileNav" class="hidden fixed inset-0 z-40 bg-white flex-col md:hidden">
    <div class="flex items-center justify-between px-6 py-4 border-b border-mpBorder">
      <img src="/public/logo/logo-mark.png" alt="MostlyPostly" class="h-9 w-auto" />
      <button id="mobileNavClose" class="text-mpMuted text-3xl leading-none">×</button>
    </div>
    <nav class="flex-1 px-6 py-6 space-y-4 text-base font-medium">
      <a href="/manager${qsSalon}"   class="block py-2 border-b border-mpBorder text-mpCharcoal">Dashboard</a>
      <a href="/dashboard${qsSalon}" class="block py-2 border-b border-mpBorder text-mpMuted">Database</a>
      <a href="/analytics${qsSalon}" class="block py-2 border-b border-mpBorder text-mpMuted">Analytics</a>
      <a href="/manager/admin${qsSalon}" class="block py-2 border-b border-mpBorder text-mpMuted">Admin</a>
      <a href="/manager/logout" class="block py-2 text-mpMuted">Logout</a>
    </nav>
  </div>

  <main class="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
    ${body}
  </main>

<script src="/public/admin.js"></script>
<script>
  const mobileNavBtn   = document.getElementById("mobileNavBtn");
  const mobileNavClose = document.getElementById("mobileNavClose");
  const mobileNav      = document.getElementById("mobileNav");
  if (mobileNavBtn)   mobileNavBtn.onclick   = () => mobileNav.classList.remove("hidden");
  if (mobileNavClose) mobileNavClose.onclick = () => mobileNav.classList.add("hidden");
</script>

</body>
</html>
`;
}
