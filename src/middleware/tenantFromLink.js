// src/middleware/tenantFromLink.js — SQLite-safe tenant resolution

import { db } from "../../db.js";

export default function tenantFromLink() {
  return function tenantFromLinkMiddleware(req, res, next) {
    try {
      let provided = null;

      // 1️⃣ Manager session always wins
      if (req.manager?.salon_id) {
        provided = req.manager.salon_id;
      }

      // 2️⃣ Query parameter override: ?salon=slug
      else if (req.query?.salon) {
        provided = String(req.query.salon).trim();
      }

      if (!provided) {
        return next();
      }

      // -----------------------------------
      // SQLite lookup helpers
      // -----------------------------------

      function findBySlug(slug) {
        try {
          return db
            .prepare("SELECT * FROM salons WHERE slug = ?")
            .get(slug);
        } catch (err) {
          console.error("[tenantFromLink] DB slug lookup failed:", err);
          return null;
        }
      }

      function findById(id) {
        try {
          return db
            .prepare("SELECT * FROM salons WHERE salon_id = ?")
            .get(id);
        } catch (err) {
          console.error("[tenantFromLink] DB id lookup failed:", err);
          return null;
        }
      }

      // Lookup in DB
      let salon =
        findBySlug(provided) ||
        findById(provided);

      if (!salon) {
        console.warn(`[tenantFromLink] Unknown salon identifier "${provided}"`);
        req.salon_id = undefined;
        req.salon_slug = undefined;
        return next();
      }

      // -----------------------------------
      // Success — set normalized context
      // -----------------------------------
      req.salon_id = salon.slug;       // always the DB slug
      req.salon_slug = salon.slug;     // normalized for filesystem
      req.salon_name = salon.name;

      return next();
    } catch (err) {
      console.error("[tenantFromLink] ERROR:", err);
      return next();
    }
  };
}
