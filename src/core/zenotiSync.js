// src/core/zenotiSync.js
// Shared Zenoti availability generation logic used by both the manual sync route
// (integrations.js) and the SMS-triggered availability flow (messageRouter.js).

import { v4 as uuidv4 } from 'uuid';
import db from '../../db.js';
import { decrypt } from './encryption.js';
import { createZenotiClient } from './zenoti.js';
import {
  calculateOpenBlocks,
  categoriesForBlock,
  formatBlockWithCategory,
} from './zenotiAvailability.js';
import { buildAvailabilityImage } from './buildAvailabilityImage.js';

/**
 * Load Zenoti credentials for a salon and return a ready client + centerId.
 * Returns null if the salon has no Zenoti integration or no center configured.
 *
 * @param {string} salonId
 * @returns {{ client, centerId } | null}
 */
export async function getZenotiClientForSalon(salonId) {
  const row = db
    .prepare(`SELECT * FROM salon_integrations WHERE salon_id = ? AND platform = 'zenoti'`)
    .get(salonId);
  if (!row || !row.api_key) return null;

  let secret;
  try {
    secret = decrypt(row.api_key);
  } catch {
    secret = row.api_key; // legacy plain-text fallback
  }

  const client = createZenotiClient(row.app_id, secret);

  let centerId = row.center_id;
  if (!centerId) {
    try {
      const centers = await client.getCenters();
      centerId = centers[0]?.id || null;
    } catch {
      return null;
    }
  }

  if (!centerId) return null;
  return { client, centerId };
}

/**
 * Fetch open availability slots for one stylist from Zenoti.
 * Returns an array of formatted slot strings (max 5), e.g. "Saturday: 9:00am · Color".
 * Returns an empty array if the stylist has no mapped employee ID, no working hours, or no open blocks.
 *
 * @param {{ client, centerId, stylist, salon, dateRange: { startDate, endDate } }}
 * @returns {Promise<string[]>}
 */
export async function fetchStylistSlots({ client, centerId, stylist, salon, dateRange }) {
  const empId = stylist.integration_employee_id;
  if (!empId) return [];

  const { startDate, endDate } = dateRange;

  const [workingHours, appointments] = await Promise.all([
    client.getWorkingHours(centerId, empId, startDate, endDate),
    client.getAppointments(centerId, empId, startDate, endDate),
  ]);

  const { categories: serviceCatalog, serviceNameToCategory } =
    await client.getServiceCatalog(centerId);

  // Build stylist category profile from appointment history.
  // Check both service.name and parent_service_name — some Zenoti records only populate one.
  const stylistCats = new Set();
  for (const appt of appointments) {
    const names = [
      appt.service?.name,
      appt.parent_service_name,
      appt.service_name,
    ].filter(Boolean).map(n => n.toLowerCase());
    for (const n of names) {
      if (serviceNameToCategory[n]) stylistCats.add(serviceNameToCategory[n]);
    }
  }
  // If we still couldn't infer any categories, assume the stylist does everything in the catalog.
  // This happens when Zenoti returns appointments with null service fields.
  const effectiveCats = stylistCats.size > 0
    ? stylistCats
    : new Set(serviceCatalog.map(c => c.categoryName));

  const fallbackStart = salon?.posting_start_time || '09:00';
  const fallbackEnd   = salon?.posting_end_time   || '18:00';

  const hoursByDate = {};
  for (const wh of workingHours) {
    if (wh.date) hoursByDate[wh.date.slice(0, 10)] = wh;
  }

  const apptsByDate = {};
  for (const appt of appointments) {
    const d = (appt.start_time || appt.start_date_time || appt.StartDateTime || '').slice(0, 10);
    if (!d) continue;
    (apptsByDate[d] = apptsByDate[d] || []).push(appt);
  }

  const hasWorkingHours = Object.keys(hoursByDate).length > 0;
  const dates = hasWorkingHours
    ? Object.keys(hoursByDate).sort()
    : [...new Set(Object.keys(apptsByDate))].sort();

  // Collect all open blocks with their duration so we can sort before slicing
  const allSlots = []; // { label: string, durationMin: number }
  for (const dateStr of dates) {
    const wh = hoursByDate[dateStr];
    const shiftStart = wh?.start || fallbackStart;
    const shiftEnd   = wh?.end   || fallbackEnd;
    const dayAppts   = apptsByDate[dateStr] || [];
    const blocks     = calculateOpenBlocks(shiftStart, shiftEnd, dayAppts, dateStr);

    for (const block of blocks) {
      const cats     = serviceCatalog.length ? categoriesForBlock(block, serviceCatalog, effectiveCats) : [];
      const category = cats[0] || null;
      allSlots.push({ label: formatBlockWithCategory(block, dateStr, category), durationMin: block.durationMin });
    }
  }

  // Sort longest blocks first so the most premium slots survive the 5-slot cap
  allSlots.sort((a, b) => b.durationMin - a.durationMin);
  return allSlots.slice(0, 5).map(s => s.label);
}

/**
 * Build the availability image and save a post row to the DB.
 *
 * @param {{ salon, stylist, slots: string[], status?: string }}
 *   status defaults to 'manager_pending'
 * @returns {Promise<{ postId: string, imageUrl: string, slots: string[] } | null>}
 */
export async function generateAndSaveAvailabilityPost({
  salon,
  stylist,
  slots,
  status = 'manager_pending',
}) {
  if (!slots || !slots.length) return null;

  const salonId   = salon.slug || salon.id;
  const bookingCta = salon.booking_url ? 'Book via link in bio' : 'DM to book';

  const imageUrl = await buildAvailabilityImage({
    slots,
    text: slots.join('\n'),
    stylistName: stylist.name,
    salonName:   salon.name || salonId,
    salonId,
    stylistId:        stylist.id,
    instagramHandle:  stylist.instagram_handle,
    bookingCta,
  });

  const postId = uuidv4();
  const now    = new Date().toISOString();
  const salonPostNum = (() => {
    const row = db.prepare(`SELECT MAX(salon_post_number) AS m FROM posts WHERE salon_id = ?`).get(salonId);
    return (row?.m || 0) + 1;
  })();

  db.prepare(`
    INSERT INTO posts
      (id, salon_id, stylist_name, stylist_id, image_url, base_caption, final_caption,
       post_type, status, salon_post_number, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'availability', ?, ?, ?, ?)
  `).run(
    postId, salonId, stylist.name, stylist.id,
    imageUrl, slots.join('\n'), slots.join('\n'),
    status, salonPostNum, now, now
  );

  console.log(`[ZenotiSync] Created availability post #${salonPostNum} for ${stylist.name} (${status})`);
  return { postId, imageUrl, slots };
}
