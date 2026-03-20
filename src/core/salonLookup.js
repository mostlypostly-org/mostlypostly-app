// src/core/salonLookup.js — DB-first, JSON only in local dev
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import chokidar from "chokidar";
import { db } from "../../db.js";

const APP_ENV = process.env.APP_ENV || process.env.NODE_ENV || "local";
const USING_JSON = APP_ENV === "local";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedSalons = [];
let lastLoadedAt = null;
let reloadTimer = null;
let watcherStarted = false;

/**
 * getSalonById(salonSlug)
 * DB → salons.slug
 * Falls back to JSON file-based lookup (local only).
 */
export function getSalonById(salonSlug) {
  if (!salonSlug) return null;
  const slug = String(salonSlug).trim().toLowerCase();

  // DB lookup
  const row = db
    .prepare("SELECT * FROM salons WHERE slug = ?")
    .get(slug);

  if (row) return row;

  if (!USING_JSON) return null;

  // Fallback → JSON salons loader (legacy support, local only)
  return (
    cachedSalons.find(
      (s) =>
        String(s.salon_id || "").trim().toLowerCase() === slug ||
        String(s.salon_info?.slug || "").trim().toLowerCase() === slug
    ) || null
  );
}

/**
 * getSalonName(salonSlugOrSalonObj)
 * Always prefer: DB.name
 * Falls back to JSON salon_info.name in local.
 */
export function getSalonName(salon) {
  if (!salon) return "Salon";

  // If salon object passed with name
  if (typeof salon === "object" && salon.name) {
    return salon.name;
  }

  const slug = typeof salon === "string" ? salon : salon.salon_id;

  // DB name
  const row = db
    .prepare("SELECT name FROM salons WHERE slug = ?")
    .get(slug);

  if (row?.name) return row.name;

  if (!USING_JSON) return slug;

  // JSON fallback (local only)
  const jsonSalon = getSalonById(slug);
  return (
    jsonSalon?.salon_info?.name ||
    jsonSalon?.salon_info?.salon_name ||
    slug
  );
}

// ---------- JSON loader (local dev only) ----------

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
  if (!USING_JSON) {
    cachedSalons = [];
    lastLoadedAt = new Date();
    return cachedSalons;
  }

  try {
    const dir = resolveSalonsDir();
    if (!fs.existsSync(dir)) {
      console.warn(`⚠️ Salon directory not found: ${dir}`);
      cachedSalons = [];
      lastLoadedAt = new Date();
      return cachedSalons;
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") || f.endsWith(".js"))
      .map((f) => path.join(dir, f));

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
  if (!USING_JSON) return;
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
  if (!USING_JSON) return [];
  return cachedSalons;
}

// ---------- DB-first stylist / salon lookup ----------

// Normalize phone numbers consistently
function normalizePhone(v = "") {
  const digits = (v + "").replace(/\D+/g, "");
  if (digits.startsWith("1") && digits.length === 11) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (v.startsWith("+")) return v;
  return "+" + digits;
}

// Core stylist lookup — DB first
export function lookupStylist(identifier) {
  const idStr = String(identifier || "").trim();
  if (!idStr) return null;

  const phoneNorm = normalizePhone(idStr);

  // Try stylist by phone
  // Try stylist by phone OR chat_id
  let row = db
    .prepare(
      `
      SELECT
        s.id                   AS stylist_id,
        s.name                 AS stylist_name,
        s.phone                AS stylist_phone,
        s.chat_id              AS stylist_chat_id,
        s.instagram_handle,
        s.compliance_opt_in,
        s.compliance_timestamp,
        s.consent              AS consent_json,
        sl.slug                AS salon_slug,
        sl.name                AS salon_name,
        sl.booking_link,
        sl.facebook_page_id,
        sl.instagram_handle    AS salon_instagram_handle,
        sl.default_cta,
        sl.booking_url
      FROM stylists s
      JOIN salons sl ON sl.slug = s.salon_id
      WHERE (s.phone = ? OR s.chat_id = ?)
        AND (s.active IS NULL OR s.active = 1)
      LIMIT 1
    `
    )
    .get(phoneNorm, idStr);



  let isManager = false;

  // If not found, try manager by phone
  if (!row) {
    const mgr = db
      .prepare(
        `
      SELECT
        m.id                   AS manager_id,
        m.name                 AS stylist_name,
        m.phone                AS stylist_phone,
        m.instagram_handle,
        m.photo_url,
        m.specialties,
        m.preferred_music_genre,
        m.compliance_opt_in,
        m.compliance_timestamp,
        m.consent              AS consent_json,
        sl.slug                AS salon_slug,
        sl.name                AS salon_name,
        sl.booking_link,
        sl.facebook_page_id,
        sl.instagram_handle    AS salon_instagram_handle,
        sl.default_cta,
        sl.booking_url
      FROM managers m
      JOIN salons sl ON sl.slug = m.salon_id
      WHERE (m.phone = ? OR CAST(m.chat_id AS TEXT) = ?)
        AND (m.active IS NULL OR m.active = 1)
      LIMIT 1
    `
      ).get(phoneNorm, idStr);

    if (mgr) {
      row = mgr;
      isManager = true;
      // Check if this manager is a coordinator
      const roleRow = db.prepare("SELECT role FROM managers WHERE id = ?").get(mgr.manager_id);
      row._isCoordinator = (roleRow?.role === 'coordinator');
    }
  }

  if (!row) {
    console.warn(`⚠️ No stylist or manager found in DB for ${idStr}`);
    return null;
  }

  const salon_info = {
    id: row.salon_slug,
    slug: row.salon_slug,
    name: row.salon_name,
    salon_name: row.salon_name,
    booking_url: row.booking_url || row.booking_link || null,
    facebook_page_id: row.facebook_page_id || null,
    instagram_handle: row.salon_instagram_handle || null,
    default_cta: row.default_cta || "Book via link in bio.",
  };

  let consentObj = null;
  try { consentObj = row.consent_json ? JSON.parse(row.consent_json) : null; } catch { }

  const stylist = {
    id: row.stylist_id || row.manager_id,
    stylist_id: row.stylist_id || null,
    manager_id: row.manager_id || null,
    stylist_name: row.stylist_name,
    name: row.stylist_name,
    phone: row.stylist_phone,
    instagram_handle: row.instagram_handle || null,
    photo_url: row.photo_url || null,
    specialties: row.specialties || null,
    preferred_music_genre: row.preferred_music_genre || null,
    salon_id: row.salon_slug,
    salon_name: row.salon_name,
    salon_info,
    role: isManager ? "manager" : "stylist",
    isCoordinator: isManager && !!row._isCoordinator,
    compliance_opt_in: !!row.compliance_opt_in,
    compliance_timestamp: row.compliance_timestamp || null,
    consent: consentObj,
  };

  return {
    stylist,
    salon: { salon_id: row.salon_slug, salon_info },
  };
}

export function lookupStylistByChatId(chatId) {
  const row = db
    .prepare(
      `
      SELECT 
        s.id          AS stylist_id,
        s.name        AS stylist_name,
        s.phone       AS stylist_phone,
        s.instagram_handle,
        sl.slug       AS salon_slug,
        sl.name       AS salon_name,
        sl.booking_link,
        sl.facebook_page_id,
        sl.instagram_handle AS salon_instagram_handle,
        sl.default_cta,
        sl.booking_url
      FROM stylists s
      JOIN salons sl ON sl.slug = s.salon_id
      WHERE CAST(s.chat_id AS TEXT) = ?
      LIMIT 1
      `
    )
    .get(String(chatId));

  if (!row) {
    console.warn(`⚠️ No stylist found by chat_id ${chatId}`);
    return null;
  }

  const salon_info = {
    id: row.salon_slug,
    slug: row.salon_slug,
    name: row.salon_name,
    salon_name: row.salon_name,
    booking_url: row.booking_url || row.booking_link || null,
    facebook_page_id: row.facebook_page_id || null,
    instagram_handle: row.salon_instagram_handle || null,
    default_cta: row.default_cta || "Book via link in bio.",
  };

  const stylist = {
    id: row.stylist_id,
    stylist_name: row.stylist_name,
    name: row.stylist_name,
    phone: row.stylist_phone,
    instagram_handle: row.instagram_handle || null,
    salon_id: row.salon_slug,
    salon_name: row.salon_name,
    salon_info,
    role: "stylist",
  };

  return {
    stylist,
    salon: { salon_id: row.salon_slug, salon_info },
  };
}


// Used by messageRouter for consent path
export function getSalonByStylist(identifier) {
  const res = lookupStylist(identifier);
  return res?.salon || null;
}

/**
 * Guaranteed direct lookup — loads salon files on demand.
 * Local-only JSON helper (returns null in staging/prod).
 */
export function findStylistDirect(phone) {
  if (!USING_JSON) return null;
  if (!phone) return null;

  const normalized = normalizePhone(phone);
  const salonsDir = resolveSalonsDir();
  if (!fs.existsSync(salonsDir)) return null;

  const files = fs.readdirSync(salonsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const salonPath = path.join(salonsDir, file);
      const salon = JSON.parse(fs.readFileSync(salonPath, "utf8"));
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

/**
 * updateStylistConsent(phoneOrChatId)
 * -----------------------------------
 * Local: updates JSON salons.
 * Staging/Prod: no-op success (consent handled elsewhere).
 */
export function updateStylistConsent(phoneOrChatId) {
  if (!phoneOrChatId) return { ok: false, error: "No identifier provided" };
  const idStr = String(phoneOrChatId).trim();
  const clean = normalizePhone(idStr);

  if (!USING_JSON) {
    return { ok: true, note: "Consent tracked server-side (DB/other)." };
  }

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
        console.log(
          `✅ Updated SMS consent for ${match.name || match.stylist_name} (${clean})`
        );
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

/**
 * saveConsentToDb(identifier, payload)
 * Persists compliance consent to the DB (stylists or managers table).
 * Works in all environments. Safe to call on every AGREE.
 */
export function saveConsentToDb(identifier, payload = {}) {
  if (!identifier) return { ok: false, error: "No identifier" };
  const idStr = String(identifier).trim();
  const phoneNorm = normalizePhone(idStr);
  const now = payload.compliance_timestamp || new Date().toISOString();
  const consentJson = JSON.stringify(payload.consent || { sms_opt_in: true, timestamp: now });

  // Try stylists first
  const stylistResult = db.prepare(`
    UPDATE stylists
    SET compliance_opt_in = 1,
        compliance_timestamp = ?,
        consent = ?,
        updated_at = ?
    WHERE phone = ? OR chat_id = ?
  `).run(now, consentJson, now, phoneNorm, idStr);

  if (stylistResult.changes > 0) {
    console.log(`✅ Consent saved to DB (stylist) for ${idStr}`);
    return { ok: true, table: "stylists" };
  }

  // Try managers
  const mgrResult = db.prepare(`
    UPDATE managers
    SET compliance_opt_in = 1,
        compliance_timestamp = ?,
        consent = ?,
        updated_at = ?
    WHERE phone = ? OR CAST(chat_id AS TEXT) = ?
  `).run(now, consentJson, now, phoneNorm, idStr);

  if (mgrResult.changes > 0) {
    console.log(`✅ Consent saved to DB (manager) for ${idStr}`);
    return { ok: true, table: "managers" };
  }

  console.warn(`⚠️ saveConsentToDb: no record found for ${idStr} (tried ${phoneNorm} and ${idStr})`);
  return { ok: false, error: "Not found in stylists or managers" };
}

/**
 * Returns the display name for a stylist in branded post images.
 * Uses first name only. Appends "L." last initial only when another
 * active stylist at the same salon shares the same first name.
 *
 * @param {{ first_name?: string, last_name?: string, name?: string, id?: string, stylist_id?: string }} stylist
 * @param {string} salonId
 * @returns {string}
 */
export function resolveDisplayName(stylist, salonId) {
  const id = stylist.id || stylist.stylist_id || "";
  const first = (stylist.first_name || (stylist.name || "").split(" ")[0] || "").trim();
  if (!first) return stylist.name || "Team Member";

  const others = db.prepare(
    `SELECT name, first_name FROM stylists WHERE salon_id = ? AND id != ?`
  ).all(salonId, id);

  const hasDuplicate = others.some(s => {
    const otherFirst = (s.first_name || (s.name || "").split(" ")[0] || "").trim();
    return otherFirst.toLowerCase() === first.toLowerCase();
  });

  if (hasDuplicate) {
    const last = (stylist.last_name || (stylist.name || "").split(" ").slice(1).join(" ") || "").trim();
    if (last) return `${first} ${last[0].toUpperCase()}.`;
  }

  return first;
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
