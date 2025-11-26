// ======================================================
// 📦 storage.js — MostlyPostly v1 (DB-first with JSON mirror)
// - Writes to SQLite (primary) and mirrors to data/posts.json (backup)
// - Keeps legacy salon/consent helpers intact
// ======================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { db } from "../../db.js"; // NOTE: storage.js is in src/core, db.js is project root

// -----------------------------
// Paths (JSON mirror)
// -----------------------------
const DATA_DIR = path.resolve("./data");
const POSTS_FILE = path.join(DATA_DIR, "posts.json");
const SALONS_DIR = process.env.SALONS_DIR || path.resolve("./salons");

// Ensure data + salons exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(POSTS_FILE)) fs.writeFileSync(POSTS_FILE, "[]", "utf8");
if (!fs.existsSync(SALONS_DIR)) fs.mkdirSync(SALONS_DIR, { recursive: true });

// ======================================================
// 🔄 JSON mirror helpers
// ======================================================
function loadAllPosts() {
  try {
    return JSON.parse(fs.readFileSync(POSTS_FILE, "utf8"));
  } catch (err) {
    console.error("⚠️ Failed to load posts.json:", err);
    return [];
  }
}

function saveAllPosts(posts) {
  try {
    fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), "utf8");
  } catch (err) {
    console.error("⚠️ Failed to write posts.json:", err);
  }
}

// ======================================================
// 🧱 DB helpers — updated for v1.3 schema
// ======================================================

const insertPostStmt = db.prepare(`
  INSERT INTO posts (
    id,
    salon_id,
    stylist_id,
    manager_id,

    stylist_name,
    stylist_phone,

    image_url,

    base_caption,
    final_caption,
    manual_caption,
    hashtags,
    ai_hashtags,
    service_type,
    cta,

    is_vision_generated,
    vision_tags,
    raw_ai_payload,

    status,
    platform,
    scheduled_for,
    published_at,

    error_message,
    salon_post_number,
    created_at,
    updated_at
  )
  VALUES (
    @id,
    @salon_id,
    @stylist_id,
    @manager_id,

    @stylist_name,
    @stylist_phone,

    @image_url,

    @base_caption,
    @final_caption,
    @manual_caption,
    @hashtags,
    @ai_hashtags,
    @service_type,
    @cta,

    @is_vision_generated,
    @vision_tags,
    @raw_ai_payload,

    @status,
    @platform,
    @scheduled_for,
    @published_at,

    @error_message,
    @salon_post_number,
    @created_at,
    @updated_at
  )
`);


// ======================================================
// 💾 Save a new post (DB + JSON mirror) — v1.3 schema
// ======================================================
export function savePost(
  chatId,
  stylist,
  caption,
  hashtags = [],
  status = "draft",
  io = null,
  salon = null
) {
  const posts = loadAllPosts();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  // assign salon post number
  let salon_post_number = 1;
  try {
    const row = db
      .prepare(`SELECT MAX(salon_post_number) AS maxnum FROM posts WHERE salon_id = ?`)
      .get(salon?.salon_id || null);

    if (row?.maxnum) salon_post_number = row.maxnum + 1;
  } catch (err) {
    console.warn("⚠️ Could not compute salon_post_number:", err.message);
  }

  const tagsArr = Array.isArray(hashtags) ? hashtags : [];
  const tagsJson = JSON.stringify(tagsArr);

  const aiHashtags = stylist.ai_hashtags || null;
  const aiHashtagsJson = aiHashtags ? JSON.stringify(aiHashtags) : null;

  const payload = {
    id,
    salon_id: salon?.salon_id || salon?.salon_info?.id || null,
    stylist_id: stylist?.stylist_id || null,
    manager_id: stylist?.manager_id || null,

    stylist_name: stylist.stylist_name || stylist.name || "Unknown Stylist",
    stylist_phone: String(chatId),

    image_url: stylist.image_url || null,

    base_caption: caption || "",
    final_caption: stylist.final_caption || caption || "",
    manual_caption: stylist.manual_caption || null,
    hashtags: tagsJson,
    ai_hashtags: aiHashtagsJson,
    service_type: stylist.service_type || null,
    cta: stylist.cta || "Book via link in bio.",

    is_vision_generated: 1,
    vision_tags: stylist.vision_tags ? JSON.stringify(stylist.vision_tags) : null,
    raw_ai_payload: stylist.raw_ai_payload ? JSON.stringify(stylist.raw_ai_payload) : null,

    status,
    platform: "instagram",    // until multi-platform UI is added
    scheduled_for: null,
    published_at: null,

    error_message: null,
    salon_post_number,

    created_at: now,
    updated_at: now
  };

  // 1) Insert into DB
  try {
    insertPostStmt.run(payload);
  } catch (err) {
    console.error("❌ DB insert failed (posts):", err.message);
  }

  // 2) JSON mirror (simplified)
  posts.push({
    id,
    salon: salon?.salon_info?.name || "Unknown Salon",
    stylist_name: payload.stylist_name,
    stylist_phone: payload.stylist_phone,
    service_type: payload.service_type,
    base_caption: payload.base_caption,
    final_caption: payload.final_caption,
    hashtags: tagsArr,
    cta: payload.cta,
    image_url: payload.image_url,
    status: payload.status,
    created_at: payload.created_at,
    updated_at: payload.updated_at
  });
  saveAllPosts(posts);

  if (io) io.emit("post:new", payload);
  console.log(`✅ Post saved to DB & JSON for ${payload.stylist_name} (${payload.status})`);
  return payload;
}

// ======================================================
// 🧩 Update post status + merge extra (DB first, then JSON)
// ======================================================
export function updatePostStatus(id, status, reasonOrExtra = null) {
  // Prepare patch for DB
  const patch = { status };

  if (typeof reasonOrExtra === "string") {
    patch.denied_reason = reasonOrExtra;
  } else if (reasonOrExtra && typeof reasonOrExtra === "object") {
    // Normalize arrays/objects for DB
    if (Array.isArray(reasonOrExtra.hashtags)) {
      patch.hashtags = JSON.stringify(reasonOrExtra.hashtags);
    }

    // Only allow columns that actually exist in the new posts schema
    const allowedExtraKeys = [
      "final_caption",
      "image_url",
      "published_at",
      "platform",
      "scheduled_for",
      "error_message",
      "base_caption",
      "manual_caption",
      "ai_hashtags",
      "service_type",
      "cta",
      "vision_tags",
      "raw_ai_payload"
    ];

    for (const k of allowedExtraKeys) {
      if (reasonOrExtra[k] !== undefined) {
        const v = reasonOrExtra[k];
        patch[k] =
          typeof v === "object" && v !== null ? JSON.stringify(v) : v;
      }
    }
  }

  // Always bump updated_at in DB
  patch.updated_at = new Date().toISOString();

  // 1) DB update (inline dynamic UPDATE instead of buildDynamicUpdate)
  try {
    const allowedCols = new Set([
      "status",
      "denied_reason",
      "final_caption",
      "image_url",
      "published_at",
      "platform",
      "scheduled_for",
      "error_message",
      "hashtags",
      "base_caption",
      "manual_caption",
      "ai_hashtags",
      "service_type",
      "cta",
      "vision_tags",
      "raw_ai_payload",
      "updated_at"
    ]);

    const keys = Object.keys(patch).filter((k) => allowedCols.has(k));

    if (keys.length > 0) {
      const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
      const stmt = db.prepare(`UPDATE posts SET ${setClause} WHERE id = @id`);
      stmt.run({ id, ...patch });
    }
  } catch (err) {
    console.error("❌ DB update failed (posts):", err.message);
  }

  // 2) JSON mirror update (keeps legacy structure, including caption)
  const posts = loadAllPosts();
  const idx = posts.findIndex((p) => p.id === id);
  if (idx !== -1) {
    posts[idx].status = status;
    posts[idx].updated_at = new Date().toISOString();

    if (typeof reasonOrExtra === "string") {
      posts[idx].denied_reason = reasonOrExtra;
    } else if (reasonOrExtra && typeof reasonOrExtra === "object") {
      posts[idx] = {
        ...posts[idx],
        ...reasonOrExtra,
        ...(Array.isArray(reasonOrExtra.hashtags)
          ? { hashtags: reasonOrExtra.hashtags }
          : {}),
      };
    }

    saveAllPosts(posts);
  } else {
    console.warn(
      `⚠️ updatePostStatus: Post ${id} not found in JSON mirror (DB was updated).`
    );
  }

  // 3) Return a merged view from DB (best-effort)
  try {
    const row = db
      .prepare(
        `
      SELECT
        id,
        stylist_name,
        stylist_phone,
        status,
        final_caption,
        denied_reason,
        created_at,
        updated_at
      FROM posts
      WHERE id = ?
    `
      )
      .get(id);
    return row || null;
  } catch {
    return null;
  }
}

// ======================================================
// 🔍 Find pending post awaiting manager approval (DB first)
// ======================================================
export function findPendingPostByManager(managerIdentifier) {
  const idStr = String(managerIdentifier).trim();

  try {
    const row = db.prepare(`
      SELECT *
      FROM posts
      WHERE status='manager_pending'
        AND (manager_phone = ? OR manager_chat_id = ?)
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
      LIMIT 1
    `).get(idStr, idStr);

    if (row) return row;
  } catch (err) {
    console.warn("⚠️ DB lookup (manager_pending) failed:", err.message);
  }

  // Fallback to JSON
  const posts = loadAllPosts();
  const matches = posts.filter(
    (p) =>
      p.status === "manager_pending" &&
      (String(p.manager_phone).trim() === idStr ||
        String(p.manager_chat_id).trim() === idStr)
  );
  if (!matches.length) {
    console.log("⚠️ No pending post found for manager:", idStr);
    return null;
  }
  return matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
}

// ======================================================
// 📝 Find post awaiting denial reason (DB first)
// ======================================================
export function findPostAwaitingReason(managerIdentifier) {
  const idStr = String(managerIdentifier).trim();

  try {
    const row = db.prepare(`
      SELECT *
      FROM posts
      WHERE status='awaiting_reason'
        AND (manager_phone = ? OR manager_chat_id = ?)
      ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
      LIMIT 1
    `).get(idStr, idStr);

    if (row) return row;
  } catch (err) {
    console.warn("⚠️ DB lookup (awaiting_reason) failed:", err.message);
  }

  // Fallback to JSON
  const posts = loadAllPosts();
  const match = posts.find(
    (p) =>
      p.status === "awaiting_reason" &&
      (String(p.manager_phone).trim() === idStr ||
        String(p.manager_chat_id).trim() === idStr)
  );
  if (match) console.log("📝 Found post awaiting denial reason for:", idStr);
  return match || null;
}

// ======================================================
// 🧾 Find latest draft by stylist (DB first)
// ======================================================
export function findLatestDraft(stylistIdentifier) {
  const idStr = String(stylistIdentifier).trim();

  try {
    const row = db.prepare(`
      SELECT *
      FROM posts
      WHERE status='draft' AND stylist_phone = ?
      ORDER BY datetime(COALESCE(created_at, updated_at)) DESC
      LIMIT 1
    `).get(idStr);

    if (row) return row;
  } catch (err) {
    console.warn("⚠️ DB lookup (latest draft) failed:", err.message);
  }

  // Fallback to JSON mirror
  const posts = loadAllPosts()
    .filter(
      (p) => String(p.stylist_phone).trim() === idStr && p.status === "draft"
    )
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return posts[0] || null;
}

// ======================================================
// 🏢 Salon + Stylist lookup utilities (file-based; unchanged)
// ======================================================
function readSalonJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function listSalonFiles() {
  return fs.readdirSync(SALONS_DIR).filter((f) => f.endsWith(".json"));
}

/**
 * Find stylist in salon JSON (supports map or array forms)
 * Returns { stylist, stylistKeyOrIndex, form } or null.
 */
function findStylistInJson(json, chatKey) {
  const s = json.stylists;
  if (!s) return null;

  // Map form
  if (!Array.isArray(s)) {
    if (Object.prototype.hasOwnProperty.call(s, chatKey)) {
      return { stylist: s[chatKey], stylistKeyOrIndex: chatKey, form: "map" };
    }
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (
        String(v?.chat_id || "").trim() === chatKey ||
        String(v?.phone || "").trim() === chatKey
      ) {
        return { stylist: v, stylistKeyOrIndex: k, form: "map" };
      }
    }
    return null;
  }

  // Array form
  const idx = s.findIndex(
    (v) =>
      String(v?.chat_id || "").trim() === chatKey ||
      String(v?.phone || "").trim() === chatKey
  );
  if (idx !== -1) {
    return { stylist: s[idx], stylistKeyOrIndex: idx, form: "array" };
  }
  return null;
}

export function getSalonByStylist(chatId) {
  try {
    const chatKey = String(chatId).trim();
    const files = listSalonFiles();

    for (const file of files) {
      const json = readSalonJson(path.join(SALONS_DIR, file));
      const found = findStylistInJson(json, chatKey);
      if (found) {
        console.log(
          `🏢 Salon match found for ${chatKey}:`,
          json.salon_info?.salon_name || json.salon_info?.name
        );
        return json;
      }
    }
    console.warn("⚠️ No salon match found for chatId:", chatId);
    return null;
  } catch (err) {
    console.error("⚠️ Error loading salon by stylist:", err);
    return null;
  }
}

export function lookupStylist(chatId) {
  try {
    const chatKey = String(chatId).trim();
    const files = listSalonFiles();

    for (const file of files) {
      const json = readSalonJson(path.join(SALONS_DIR, file));
      const found = findStylistInJson(json, chatKey);
      if (found) {
        const stylist = found.stylist || {};
        return {
          ...stylist,
          salon_name:
            stylist.salon_name || json.salon_info?.salon_name || json.salon_info?.name || "Unknown Salon",
          city: json.salon_info?.city || "Unknown City",
          salon_info: json.salon_info,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("⚠️ lookupStylist() error:", err);
    return null;
  }
}

// ======================================================
// ✅ Persist stylist consent into salons/<file>.json (unchanged)
// ======================================================
export function saveStylistConsent(chatIdOrPhone, payload = {}) {
  const key = String(chatIdOrPhone).trim();
  const files = listSalonFiles();

  for (const file of files) {
    const filePath = path.join(SALONS_DIR, file);
    let json;
    try {
      json = readSalonJson(filePath);
    } catch (e) {
      console.warn(`⚠️ Could not parse ${filePath}: ${e.message}`);
      continue;
    }

    // 1) Try stylist match
    const found = findStylistInJson(json, key);
    if (found) {
      const { stylist, stylistKeyOrIndex, form } = found;
      const merged = {
        ...stylist,
        compliance_opt_in:
          typeof payload.compliance_opt_in === "boolean"
            ? payload.compliance_opt_in
            : stylist.compliance_opt_in || false,
        compliance_timestamp:
          payload.compliance_timestamp || stylist.compliance_timestamp || "",
        consent: {
          ...(stylist.consent || {}),
          ...(payload.consent || {}),
        },
      };

      if (form === "map") {
        json.stylists[stylistKeyOrIndex] = merged;
      } else {
        json.stylists[stylistKeyOrIndex] = merged;
      }

      try {
        fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");
        console.log(
          `💾 Consent saved for stylist "${merged.stylist_name || merged.name || merged.id || "Unknown"}" in ${path.basename(filePath)}`
        );
        return {
          ok: true,
          file: filePath,
          stylist_name: merged.stylist_name || merged.name || "",
          updated: {
            compliance_opt_in: merged.compliance_opt_in,
            compliance_timestamp: merged.compliance_timestamp,
            consent: merged.consent,
          },
        };
      } catch (e) {
        return { ok: false, error: `Failed to write ${filePath}: ${e.message}` };
      }
    }

    // 2) Try manager match
    const managers = json.managers || [];
    const manager = managers.find(
      (m) =>
        String(m.chat_id || "").trim() === key ||
        String(m.phone || "").trim() === key
    );
    if (manager) {
      manager.compliance_opt_in =
        typeof payload.compliance_opt_in === "boolean"
          ? payload.compliance_opt_in
          : manager.compliance_opt_in || false;
      manager.compliance_timestamp =
        payload.compliance_timestamp || manager.compliance_timestamp || "";
      manager.consent = {
        ...(manager.consent || {}),
        ...(payload.consent || {}),
      };

      try {
        fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");
        console.log(
          `💾 Consent saved for manager "${manager.name || manager.id || "Unknown"}" in ${path.basename(filePath)}`
        );
        return {
          ok: true,
          file: filePath,
          stylist_name: manager.name || "",
          updated: {
            compliance_opt_in: manager.compliance_opt_in,
            compliance_timestamp: manager.compliance_timestamp,
            consent: manager.consent,
          },
        };
      } catch (e) {
        return { ok: false, error: `Failed to write ${filePath}: ${e.message}` };
      }
    }
  }

  // No match
  return { ok: false, error: "Stylist not found in salons/*.json" };
}
