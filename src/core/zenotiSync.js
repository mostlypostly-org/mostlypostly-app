// src/core/zenotiSync.js
// Shared Zenoti availability generation logic used by both the manual sync route
// (integrations.js) and the SMS-triggered availability flow (messageRouter.js).
//
// Pool cache:
//   SMS requests trigger a full sync for ALL mapped stylists in the salon, cached
//   for 30 minutes. Subsequent requests within that window skip the Zenoti API and
//   read from the pool. After 30 minutes the next request triggers a fresh pull.

import { v4 as uuidv4 } from 'uuid';
import db from '../../db.js';
import { decrypt } from './encryption.js';
import { createZenotiClient, inferCategory } from './zenoti.js';
import {
  calculateOpenBlocks,
  categoriesForBlock,
  formatBlockWithCategory,
} from './zenotiAvailability.js';
import { buildAvailabilityImage } from './buildAvailabilityImage.js';
import { resolveDisplayName } from './salonLookup.js';
import { getDefaultPlacement } from './contentType.js';

// ─── 30-minute availability pool ─────────────────────────────────────────────
// Shape: Map<salonId, {
//   syncedAt:  number,                        // Date.now()
//   byStylist: Map<stylistId, RawBlock[]>,    // all open blocks per stylist
// }>
// RawBlock: { label: string, dateStr: string, blockStart: Date }
const availabilityPool = new Map();
const POOL_TTL_MS = 30 * 60 * 1000; // 30 minutes

function isPoolFresh(salonId) {
  const pool = availabilityPool.get(salonId);
  return !!(pool && Date.now() - pool.syncedAt < POOL_TTL_MS);
}

/**
 * Load Zenoti credentials for a salon and return a ready client + centerId.
 * Returns null if the salon has no Zenoti integration or no center configured.
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
 * Internal: fetch all open blocks for one stylist and return raw block objects.
 * Used by both the pool sync and the direct per-stylist fetch.
 *
 * @returns {Promise<{ label: string, dateStr: string, blockStart: Date }[]>}
 */
async function fetchRawBlocks({ client, centerId, stylist, salon, dateRange }) {
  const empId = stylist.integration_employee_id;
  if (!empId) return [];

  const { startDate, endDate } = dateRange;

  const [workingHours, appointments, blockouts] = await Promise.all([
    client.getWorkingHours(centerId, empId, startDate, endDate),
    client.getAppointments(centerId, empId, startDate, endDate),
    client.getEmployeeBlockouts(empId, startDate, endDate, centerId),
  ]);

  // Merge blockouts into appointments so calculateOpenBlocks treats them as booked time
  const allBookedTime = [...appointments, ...blockouts];

  const { categories: serviceCatalog, serviceNameToCategory } =
    await client.getServiceCatalog(centerId);

  // Build stylist category profile from appointments only (not blockouts).
  // Use inferCategory() directly on appointment service names so partial/variant
  // name matches (e.g. "Partial Highlights" ≠ catalog "Full Highlights") still register.
  const stylistCats = new Set();
  for (const appt of appointments) {
    const names = [appt.service?.name, appt.parent_service_name, appt.service_name]
      .filter(Boolean);
    for (const n of names) {
      const cat = serviceNameToCategory[n.toLowerCase()] || inferCategory(n);
      if (cat) stylistCats.add(cat);
    }
  }
  // Fallback: if no categories inferred (null service fields), assume all catalog categories
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
  for (const appt of allBookedTime) {
    const d = (
      appt.start_time || appt.start_date_time || appt.StartDateTime ||
      appt.scheduled_start_time || appt.actual_start_time ||
      appt.start || appt.from ||
      appt.start_time_utc || ''
    ).slice(0, 10);
    if (!d) {
      console.warn('[ZenotiSync] Appointment has no parseable date — keys:', Object.keys(appt).join(', '));
      console.warn('[ZenotiSync] Raw appointment:', JSON.stringify(appt).slice(0, 300));
      continue;
    }
    (apptsByDate[d] = apptsByDate[d] || []).push(appt);
  }
  console.log(`[ZenotiSync] ${stylist.name} appointment date buckets:`,
    Object.entries(apptsByDate).sort().map(([d, a]) => `${d}:${a.length}`).join(', ') || '(none)');

  const hasWorkingHours = Object.keys(hoursByDate).length > 0;
  const dates = hasWorkingHours
    ? Object.keys(hoursByDate).sort()
    : [...new Set(Object.keys(apptsByDate))].sort();

  const rawBlocks = [];
  for (const dateStr of dates) {
    const wh         = hoursByDate[dateStr];
    const shiftStart = wh?.start || fallbackStart;
    const shiftEnd   = wh?.end   || fallbackEnd;
    const dayAppts   = apptsByDate[dateStr] || [];
    const blocks     = calculateOpenBlocks(shiftStart, shiftEnd, dayAppts, dateStr, salon?.timezone);

    for (const block of blocks) {
      const cats     = serviceCatalog.length ? categoriesForBlock(block, serviceCatalog, effectiveCats) : [];
      const category = cats[0] || null;
      rawBlocks.push({
        label:      formatBlockWithCategory(block, dateStr, category),
        dateStr,
        blockStart: block.start, // Date object — used for chronological sort
      });
    }
  }

  // Return in chronological order (date then time within day)
  return rawBlocks.sort((a, b) => a.blockStart - b.blockStart);
}

/**
 * Sync ALL mapped stylists for a salon and store results in the 30-minute pool.
 * Uses a 14-day window so pool data is useful for any near-term date request.
 * Adds any newly mapped stylists that weren't in the previous pool.
 *
 * @param {string} salonId
 * @returns {Promise<Map<stylistId, RawBlock[]> | null>}
 */
export async function syncAvailabilityPool(salonId) {
  const zenotiInfo = await getZenotiClientForSalon(salonId);
  if (!zenotiInfo) return null;

  const { client, centerId } = zenotiInfo;
  const salon = db.prepare(`SELECT * FROM salons WHERE slug = ?`).get(salonId);

  const mappedStylists = db
    .prepare(`SELECT id, name, instagram_handle, integration_employee_id FROM stylists WHERE salon_id = ? AND integration_employee_id IS NOT NULL`)
    .all(salonId);

  if (!mappedStylists.length) return null;

  const today     = new Date();
  const startDate = today.toISOString().slice(0, 10);
  const endDate   = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateRange = { startDate, endDate };

  // Preserve existing pool data for stylists that error out — just update fresh ones
  const existingPool = availabilityPool.get(salonId);
  const byStylist   = new Map(existingPool?.byStylist || []);

  for (const stylist of mappedStylists) {
    try {
      const blocks = await fetchRawBlocks({ client, centerId, stylist, salon, dateRange });
      byStylist.set(stylist.id, blocks);
      console.log(`[ZenotiPool] ${stylist.name}: ${blocks.length} open block(s) in pool`);
    } catch (err) {
      console.warn(`[ZenotiPool] Failed to fetch blocks for ${stylist.name}:`, err.message);
      // Keep stale data for this stylist rather than clearing it
      if (!byStylist.has(stylist.id)) byStylist.set(stylist.id, []);
    }
  }

  availabilityPool.set(salonId, { syncedAt: Date.now(), byStylist });

  // Persist last sync time to DB so the integrations page reflects both manual and auto syncs
  db.prepare(
    `UPDATE salon_integrations SET last_event_at = ? WHERE salon_id = ? AND platform = 'zenoti'`
  ).run(new Date().toISOString(), salonId);

  console.log(`[ZenotiPool] Pool refreshed for salon=${salonId} — ${mappedStylists.length} stylist(s), window: ${startDate} → ${endDate}`);
  return byStylist;
}

/**
 * Get slots for one stylist from the pool, filtered to a date range.
 * Returns null if the pool is stale or missing (caller should syncAvailabilityPool first).
 * Slots are returned chronologically, capped at 5.
 *
 * @param {string} salonId
 * @param {string} stylistId
 * @param {{ startDate: string, endDate: string }} dateRange
 * @returns {string[] | null}
 */
export function getPooledStylistSlots(salonId, stylistId, dateRange) {
  if (!isPoolFresh(salonId)) return null;

  const pool    = availabilityPool.get(salonId);
  const blocks  = pool?.byStylist?.get(stylistId) || [];
  const { startDate, endDate } = dateRange;

  return blocks
    .filter(b => b.dateStr >= startDate && b.dateStr <= endDate)
    // already chronologically sorted from fetchRawBlocks
    .slice(0, 5)
    .map(b => b.label);
}

/**
 * Fetch open availability slots for one stylist directly (no pool — used by manual sync route).
 * Returns formatted slot strings in chronological order, capped at 5.
 *
 * @param {{ client, centerId, stylist, salon, dateRange }}
 * @returns {Promise<string[]>}
 */
export async function fetchStylistSlots({ client, centerId, stylist, salon, dateRange }) {
  const rawBlocks = await fetchRawBlocks({ client, centerId, stylist, salon, dateRange });
  return rawBlocks.slice(0, 5).map(b => b.label);
}

/**
 * Build the availability image and save a post row to the DB.
 *
 * @param {{ salon, stylist, slots: string[], status?: string }}
 * @returns {Promise<{ postId: string, imageUrl: string, slots: string[] } | null>}
 */
export async function generateAndSaveAvailabilityPost({
  salon,
  stylist,
  slots,
  status = 'manager_pending',
}) {
  if (!slots || !slots.length) return null;

  const salonId    = salon.slug || salon.id;
  const bookingCta = salon.booking_url ? 'Book via link in bio' : 'DM to book';

  const imageUrl = await buildAvailabilityImage({
    slots,
    text: slots.join('\n'),
    stylistName:     resolveDisplayName(stylist, salonId),
    salonName:       salon.name || salonId,
    salonId,
    stylistId:       stylist.id,
    instagramHandle: stylist.instagram_handle,
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
       post_type, status, salon_post_number, created_at, updated_at,
       content_type, placement)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'availability', ?, ?, ?, ?, 'stylist_availability', 'story')
  `).run(
    postId, salonId, stylist.name, stylist.id,
    imageUrl, slots.join('\n'), slots.join('\n'),
    status, salonPostNum, now, now
  );

  console.log(`[ZenotiSync] Created availability post #${salonPostNum} for ${stylist.name} (${status})`);
  return { postId, imageUrl, slots };
}
