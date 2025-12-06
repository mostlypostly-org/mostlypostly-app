// src/core/salonLookup.js — Fully patched for consistent lookup and consent updates
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import chokidar from "chokidar";
import { db } from "../../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedSalons = [];
let lastLoadedAt = null;
let reloadTimer = null;
let watcherStarted = false;

/**
 * getSalonById(salonSlug)
 * DB → salons.slug
 * Falls back to JSON file-based lookup.
 */
export function getSalonById(salonSlug) {
  if (!salonSlug) return null;
  const slug = String(salonSlug).trim().toLowerCase();

  // 1️⃣ DB lookup (correct source of truth)
  const row = db
    .prepare("SELECT * FROM salons WHERE slug = ?")
    .get(slug);

  if (row) return row;

  // 2️⃣ Fallback → JSON salons loader (legacy support)
  return cachedSalons.find(
    (s) =>
      String(s.salon_id).trim().toLowerCase() === slug ||
      String(s.salon_info?.slug).trim().toLowerCase() === slug
  ) || null;
}

/**
 * getSalonName(salonSlugOrSalonObj)
 * Always prefer: DB.name
 * Falls back to JSON salon_info.name
 */
export function getSalonName(salon) {
  if (!salon) return "Salon";

  // If salon object passed
  if (typeof salon === "object" && salon.name) {
    return salon.name;
  }

  const slug = typeof salon === "string" ? salon : salon.salon_id;

  // 1️⃣ DB name (correct)
  const row = db
    .prepare("SELECT name FROM salons WHERE slug = ?")
    .get(slug);

  if (row?.name) return row.name;

  // 2️⃣ fallback to JSON loaders (old)
  const jsonSalon = getSalonById(slug);
  return (
    jsonSalon?.salon_info?.name ||
    jsonSalon?.salon_info?.salon_name ||
    slug
  );
}

function resolveSalonsDir() {
  const candidates = [];
  if (process.env.SALONS_DIR) candidates.push(path.resolve(process.env.SALONS_DIR));
  candidates.push(path.resolve(process.cwd(), "salons"));
  candidates.push(path.resolve(__dirname, "../../salons"));
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  }
  return path.resolve(process.cwd(), "salons");
}

async function loadOne(filePath) {
  if (filePath.endsWith(".json")) {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    data.__file = filePath;
    return data;
  } else {
    const mod = await import(pathToFileURL(filePath) + `?t=${Date.now()}`);
    const data = mod.default || mod;
    data.__file = filePath;
    return data;
  }
}

export async function loadSalons() {
  try {
    const dir = resolveSalonsDir();
    if (!fs.existsSync(dir)) {
      console.warn(`⚠️ Salon directory not found: ${dir}`);
      cachedSalons = [];
      lastLoadedAt = new Date();
      return cachedSalons;
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") || f.endsWith(".js"))
      .map(f => path.join(dir, f));

    const salons = [];
    for (const filePath of files) {
      try {
        const data = await loadOne(filePath);
        if (data?.salon_info?.name || data?.salon_info?.salon_name) {
          salons.push(data);
        }
      } catch (e) {
        console.error(`⚠️ Failed to load ${filePath}: ${e.message}`);
      }
    }

    cachedSalons = salons;
    lastLoadedAt = new Date();
    console.log(`✅ Loaded ${salons.length} salon(s)`);
    return cachedSalons;
  } catch (err) {
    console.error("🚫 Failed to load salons:", err);
    cachedSalons = [];
    lastLoadedAt = new Date();
    return cachedSalons;
  }
}

export function startSalonWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;

  const dir = resolveSalonsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  loadSalons();

  const pattern = path.join(dir, "**/*.{json,js}");
  const watcher = chokidar.watch(pattern, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });

  const scheduleReload = (reason, file) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      console.log(`🔁 Reloading salons — ${reason}: ${path.relative(dir, file)}`);
      await loadSalons();
    }, 300);
  };

  watcher
    .on("add", (f) => scheduleReload("added", f))
    .on("change", (f) => scheduleReload("changed", f))
    .on("unlink", (f) => scheduleReload("removed", f));

  console.log(`👀 Watching ${pattern} for salon changes…`);
}

export function getAllSalons() {
  return cachedSalons;
}

export function getSalonByStylist(identifier) {
  if (!cachedSalons.length) return null;
  const idStr = String(identifier).trim();

  for (const salon of cachedSalons) {
    const stylists = salon.stylists || [];
    const managers = salon.managers || [];
    if (
      stylists.some(
        (s) =>
          String(s.chat_id).trim() === idStr ||
          normalizePhone(s.phone) === normalizePhone(idStr) ||
          s.id === idStr
      ) ||
      managers.some(
        (m) =>
          String(m.chat_id).trim() === idStr ||
          normalizePhone(m.phone) === normalizePhone(idStr) ||
          m.id === idStr
      )
    ) {
      return salon;
    }
  }
  return null;
}

// 🔍 Core stylist lookup (cached, safe)
export function lookupStylist(identifier) {
  const idStr = String(identifier || "").trim();
  if (!idStr) return null;

  // Auto-load cache if empty
  if (!cachedSalons.length) {
    console.warn("⚠️ Salon cache empty — loading salons now…");
    try {
      loadSalons();
    } catch (e) {
      console.error("🚫 Failed to auto-load salons:", e);
      return null;
    }
  }

  const normalizedId = normalizePhone(idStr);

  for (const salon of cachedSalons) {
    const salonInfo = salon.salon_info || {};
    const stylists = salon.stylists || [];
    const managers = salon.managers || [];

    // Match stylist
    const stylist = stylists.find(
      (s) =>
        normalizePhone(s.phone) === normalizedId ||
        String(s.chat_id).trim() === idStr ||
        s.id === idStr
    );
    if (stylist) {
      stylist.salon_info = salonInfo;
      stylist.salon_name = salonInfo.name || salonInfo.salon_name || "Unknown Salon";
      stylist.display_name = stylist.name || stylist.stylist_name;
      return { stylist, salon };
    }

    // Match manager
    const manager = managers.find(
      (m) =>
        normalizePhone(m.phone) === normalizedId ||
        String(m.chat_id).trim() === idStr ||
        m.id === idStr
    );
    if (manager) {
      manager.salon_info = salonInfo;
      manager.salon_name = salonInfo.name || salonInfo.salon_name || "Unknown Salon";
      manager.display_name = manager.name || manager.stylist_name;
      manager.role = "manager";
      return { stylist: manager, salon };
    }
  }

  console.warn(`⚠️ No stylist or manager found for ${idStr}`);
  return null;
}

/**
 * 🔍 Guaranteed direct lookup — loads salon files on demand (bypasses cache)
 */
export function findStylistDirect(phone) {
  if (!phone) return null;
  const normalized = normalizePhone(phone);
  const salonsDir = resolveSalonsDir();
  const files = fs.readdirSync(salonsDir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    try {
      const salonPath = path.join(salonsDir, file);
      const salon = JSON.parse(fs.readFileSync(salonPath, "utf8"));
      const salonInfo = salon.salon_info || {};
      const allPeople = [...(salon.managers || []), ...(salon.stylists || [])];

      for (const person of allPeople) {
        if (normalizePhone(person.phone) === normalized) {
          return { stylist: person, salon };
        }
      }
    } catch (err) {
      console.warn(`⚠️ Failed to read salon file ${file}:`, err.message);
    }
  }
  return null;
}

// 🧩 Normalize phone numbers consistently
function normalizePhone(v = "") {
  const digits = (v + "").replace(/\D+/g, "");
  if (digits.startsWith("1") && digits.length === 11) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (v.startsWith("+")) return v;
  return "+" + digits;
}

/**
 * updateStylistConsent(phoneOrChatId)
 * -----------------------------------
 * Finds the stylist by phone/chat ID and updates SMS consent.
 */
export function updateStylistConsent(phoneOrChatId) {
  if (!phoneOrChatId) return { ok: false, error: "No identifier provided" };
  const idStr = String(phoneOrChatId).trim();
  const clean = normalizePhone(idStr);

  const salons = getAllSalons();
  if (!salons.length) return { ok: false, error: "No salons loaded" };

  for (const salon of salons) {
    const salonFile = salon.__file || "";
    const allPeople = [...(salon.stylists || []), ...(salon.managers || [])];

    const match = allPeople.find(
      (p) =>
        normalizePhone(p.phone) === clean || String(p.chat_id).trim() === idStr
    );

    if (match) {
      const now = new Date().toISOString();
      match.consent = match.consent || {};
      match.consent.sms_opt_in = true;
      match.consent.timestamp = now;
      match.compliance_opt_in = true;
      match.compliance_timestamp = now;

      try {
        fs.writeFileSync(salonFile, JSON.stringify(salon, null, 2));
        console.log(`✅ Updated SMS consent for ${match.name || match.stylist_name} (${clean})`);
        return {
          ok: true,
          stylist_name: match.name || match.stylist_name,
          salon_name: salon.salon_info?.name || "Unknown",
        };
      } catch (err) {
        console.error("⚠️ Failed to save consent:", err);
        return { ok: false, error: err.message };
      }
    }
  }

  return { ok: false, error: "Stylist not found" };
}

export function reloadSalonsNow() {
  return loadSalons().then(() => ({
    lastLoadedAt,
    salons: cachedSalons.map((s) => ({
      salon_name: s.salon_info?.name,
      require_manager_approval: !!s.settings?.require_manager_approval,
      file_hint: s.__file,
    })),
  }));
}
