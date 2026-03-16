// src/core/celebrationScheduler.js
// Daily birthday/anniversary detection. Called from scheduler tick.
// At 6am salon-local time: finds today's milestones, generates images + captions,
// inserts 2 manager_approved posts (feed + story), sends manager SMS.

import { DateTime } from "luxon";
import { db } from "../../db.js";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { generateCelebrationImage } from "./celebrationImageGen.js";
import { generateCelebrationCaption } from "./celebrationCaption.js";

// Track which salons have already run today (in-memory, resets on restart)
// Key: "salonSlug-YYYY-MM-DD", Value: true
const ranToday = new Map();

function isIn6amWindow(timezone) {
  try {
    const now = DateTime.now().setZone(timezone);
    return now.hour === 6;
  } catch {
    return false;
  }
}

function getSalonLocalDate(timezone) {
  return DateTime.now().setZone(timezone).toFormat("yyyy-LL-dd");
}

function getTodayMmDd(timezone) {
  return DateTime.now().setZone(timezone).toFormat("MM-dd");
}

function yearsAgo(hireDateStr, timezone) {
  try {
    const hire = DateTime.fromISO(hireDateStr, { zone: timezone });
    const now  = DateTime.now().setZone(timezone);
    return Math.floor(now.diff(hire, "years").years);
  } catch {
    return 0;
  }
}

function resolveLogoPath(logoUrl) {
  if (!logoUrl) return null;
  if (logoUrl.startsWith("/uploads/")) {
    const abs = path.resolve("public" + logoUrl);
    return fs.existsSync(abs) ? abs : null;
  }
  return null;
}

function randomDelay(min = 20, max = 45) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nextPostNumber(salonId) {
  const row = db.prepare(`SELECT MAX(salon_post_number) AS m FROM posts WHERE salon_id = ?`).get(salonId);
  return (row?.m || 0) + 1;
}

function insertPost({ salonId, stylistName, stylistId, imageUrl, caption, postType, delayMinutes }) {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const scheduledFor = DateTime.utc()
    .plus({ minutes: delayMinutes })
    .toFormat("yyyy-LL-dd HH:mm:ss");
  const postNum = nextPostNumber(salonId);
  db.prepare(`
    INSERT INTO posts (
      id, salon_id, stylist_name, stylist_id,
      image_url, base_caption, final_caption,
      post_type, status, scheduled_for, salon_post_number, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manager_approved', ?, ?, ?)
  `).run(id, salonId, stylistName, stylistId, imageUrl, caption, caption, postType, scheduledFor, postNum, now);
  return id;
}

export async function runCelebrationCheck() {
  const salons = db.prepare(`
    SELECT slug, name, timezone, tone,
           brand_palette, celebration_font_styles, celebration_font_index,
           logo_url
    FROM salons
  `).all();

  for (const salon of salons) {
    try {
      const tz = salon.timezone || "America/New_York";
      if (!isIn6amWindow(tz)) continue;

      const todayKey = `${salon.slug}-${getSalonLocalDate(tz)}`;
      if (ranToday.has(todayKey)) continue;

      const todayMmDd = getTodayMmDd(tz);

      // Also check DB for any celebration posts created today (handles restarts)
      const alreadyExists = db.prepare(`
        SELECT id FROM posts
        WHERE salon_id = ? AND post_type IN ('celebration','celebration_story')
          AND date(created_at) = ?
        LIMIT 1
      `).get(salon.slug, getSalonLocalDate(tz));
      if (alreadyExists) {
        ranToday.set(todayKey, true);
        continue;
      }

      const styles = (() => {
        try { return JSON.parse(salon.celebration_font_styles || '["script"]'); }
        catch { return ["script"]; }
      })();
      const fontStyle = styles[(salon.celebration_font_index || 0) % styles.length];

      const palette = (() => {
        try { return JSON.parse(salon.brand_palette || "{}"); }
        catch { return {}; }
      })();
      const accentColor = palette.cta || palette.accent || "#3B72B9";
      const logoPath = resolveLogoPath(salon.logo_url);

      // Birthday stylists today
      const birthdayStylists = db.prepare(`
        SELECT id, name, first_name, last_name, photo_url
        FROM stylists
        WHERE salon_id = ? AND celebrations_enabled = 1 AND birthday_mmdd = ?
      `).all(salon.slug, todayMmDd);

      // Anniversary stylists today
      const anniversaryStylists = db.prepare(`
        SELECT id, name, first_name, last_name, photo_url, hire_date
        FROM stylists
        WHERE salon_id = ? AND celebrations_enabled = 1
          AND hire_date IS NOT NULL
          AND strftime('%m-%d', hire_date) = ?
      `).all(salon.slug, todayMmDd);

      const allCelebrations = [
        ...birthdayStylists.map(s => ({ ...s, celebrationType: "birthday" })),
        ...anniversaryStylists.map(s => ({
          ...s,
          celebrationType: "anniversary",
          anniversaryYears: yearsAgo(s.hire_date, tz),
        })),
      ];

      if (allCelebrations.length === 0) {
        ranToday.set(todayKey, true);
        continue;
      }

      let fontIndexBump = 0;

      for (const stylist of allCelebrations) {
        const firstName = stylist.first_name || stylist.name?.split(" ")[0] || stylist.name || "Team Member";

        console.log(`[CelebrationScheduler] ${salon.slug}: ${stylist.celebrationType} for ${firstName}`);

        try {
          const { feedUrl, storyUrl } = await generateCelebrationImage({
            profilePhotoUrl: stylist.photo_url,
            salonLogoPath:   logoPath,
            firstName,
            celebrationType: stylist.celebrationType,
            anniversaryYears: stylist.anniversaryYears,
            salonName: salon.name,
            accentColor,
            fontStyle,
          });

          const caption = await generateCelebrationCaption({
            firstName,
            salonName:    salon.name,
            tone:         salon.tone || "warm and professional",
            celebrationType: stylist.celebrationType,
            anniversaryYears: stylist.anniversaryYears,
          });

          const delay = randomDelay(5, 20);
          insertPost({
            salonId:      salon.slug,
            stylistName:  stylist.name,
            stylistId:    stylist.id,
            imageUrl:     feedUrl,
            caption,
            postType:     "celebration",
            delayMinutes: delay,
          });

          insertPost({
            salonId:      salon.slug,
            stylistName:  stylist.name,
            stylistId:    stylist.id,
            imageUrl:     storyUrl,
            caption,
            postType:     "celebration_story",
            delayMinutes: delay + randomDelay(1, 5),
          });

          fontIndexBump++;
          console.log(`[CelebrationScheduler] ${salon.slug}: Queued ${stylist.celebrationType} posts for ${firstName}`);

          // Manager SMS
          const manager = db.prepare(`
            SELECT phone FROM managers WHERE salon_id = ? AND role IN ('owner','manager') LIMIT 1
          `).get(salon.slug);

          if (manager?.phone) {
            const emoji    = stylist.celebrationType === "birthday" ? "🎂" : "🎉";
            const typeWord = stylist.celebrationType === "birthday" ? "Birthday" : "Anniversary";
            const baseUrl  = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "";
            const link     = `${baseUrl}/manager?salon=${salon.slug}`;
            try {
              // Dynamic import to avoid circular dep
              const { sendViaTwilio } = await import("../routes/twilio.js");
              await sendViaTwilio(manager.phone,
                `${emoji} ${typeWord} post for ${firstName} has been queued for today! Tap to review: ${link}`
              );
            } catch (smsErr) {
              console.warn("[CelebrationScheduler] SMS failed:", smsErr.message);
            }
          }
        } catch (err) {
          console.error(`[CelebrationScheduler] Failed for ${firstName}:`, err.message);
        }
      }

      if (fontIndexBump > 0) {
        db.prepare(`UPDATE salons SET celebration_font_index = celebration_font_index + ? WHERE slug = ?`)
          .run(fontIndexBump, salon.slug);
      }

      ranToday.set(todayKey, true);
    } catch (err) {
      console.error(`[CelebrationScheduler] Salon ${salon.slug} error:`, err.message);
    }
  }
}
