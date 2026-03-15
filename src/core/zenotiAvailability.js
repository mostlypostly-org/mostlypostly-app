// src/core/zenotiAvailability.js
// Calculates consecutive open booking blocks from Zenoti working hours + appointments.
//
// A stylist's true availability = gaps between booked appointments within their shift.
// Blocks must be consecutive — a 30min gap at 9am and 1hr gap at 1pm are TWO separate
// opportunities, not 1.5 cumulative hours. A service must fit in a single block.

const MIN_BLOCK_MINUTES = 30; // gaps shorter than this aren't worth showing

/**
 * Calculate consecutive open blocks for one stylist on one day.
 *
 * @param {string} workingStart  - "09:00" shift start
 * @param {string} workingEnd    - "17:00" shift end
 * @param {Array}  appointments  - array of appointment objects from Zenoti
 * @param {string} dateStr       - "YYYY-MM-DD"
 * @returns {Array} blocks — [{ start: Date, end: Date, durationMin: number }]
 */
export function calculateOpenBlocks(workingStart, workingEnd, appointments, dateStr) {
  if (!workingStart || !workingEnd) return [];

  const dayStart = parseLocalTime(dateStr, workingStart);
  const dayEnd   = parseLocalTime(dateStr, workingEnd);
  if (dayEnd <= dayStart) return [];

  // Normalize appointments — handle multiple Zenoti date field patterns
  const rawMapped = (appointments || []).map(a => {
    const s = a.start_time || a.start_date_time || a.StartDateTime
           || a.scheduled_start_time || a.start || a.from;
    const e = a.end_time   || a.end_date_time   || a.EndDateTime
           || a.scheduled_end_time   || a.end   || a.to;
    return { start: new Date(s), end: new Date(e), _raw: a };
  });
  const dropped = rawMapped.filter(a => isNaN(a.start) || isNaN(a.end) || a.end <= a.start);
  if (dropped.length) {
    console.warn(`[Availability] ${dateStr}: ${dropped.length} appointment(s) dropped — unrecognized field names. Keys seen:`, dropped.map(a => Object.keys(a._raw).join(',')).join(' | '));
  }
  const appts = rawMapped
    .filter(a => !isNaN(a.start) && !isNaN(a.end) && a.end > a.start)
    .filter(a => a.start < dayEnd && a.end > dayStart) // overlaps the working day
    .sort((a, b) => a.start - b.start);
  console.log(`[Availability] ${dateStr}: shift ${workingStart}–${workingEnd}, ${appts.length} appointment(s) parsed`);

  const blocks = [];
  let cursor = dayStart;

  for (const appt of appts) {
    // Clamp appointment to working hours
    const apptStart = appt.start < dayStart ? dayStart : appt.start;
    const apptEnd   = appt.end   > dayEnd   ? dayEnd   : appt.end;

    if (apptStart > cursor) {
      addBlock(blocks, cursor, apptStart);
    }
    if (apptEnd > cursor) cursor = apptEnd;
  }

  // Gap after the last appointment (or entire day if no appointments)
  if (dayEnd > cursor) {
    addBlock(blocks, cursor, dayEnd);
  }

  return blocks;
}

function addBlock(blocks, start, end) {
  const durationMin = Math.round((end - start) / 60000);
  if (durationMin >= MIN_BLOCK_MINUTES) {
    blocks.push({ start, end, durationMin });
  }
}

function parseLocalTime(dateStr, timeStr) {
  const [h, m] = (timeStr || '09:00').split(':').map(Number);
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day, h, m, 0, 0);
}

/**
 * Format open blocks as slot strings for the availability post generator.
 * Output matches the format parseAvailabilitySlots expects:
 * "Friday: 9:00am–9:30am (30min)"
 *
 * @param {Array}  blocks   - from calculateOpenBlocks
 * @param {string} dateStr  - "YYYY-MM-DD"
 * @returns {string[]}
 */
export function formatBlocksAsSlots(blocks, dateStr) {
  const dayName = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
  return blocks.map(b => {
    const start = fmt12h(b.start);
    const end   = fmt12h(b.end);
    const dur   = fmtDuration(b.durationMin);
    return `${dayName}: ${start}–${end} (${dur})`;
  });
}

/**
 * Format a single block as "Saturday: 9:00am · Category".
 * Used by Zenoti sync where category context replaces the duration/end time.
 * If no category provided, falls back to just "Saturday: 9:00am".
 */
export function formatBlockWithCategory(block, dateStr, category) {
  const dayName = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const start = fmt12h(block.start);
  return category ? `${dayName}: ${start} · ${category}` : `${dayName}: ${start}`;
}

function fmt12h(date) {
  return date
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .toLowerCase()
    .replace(' ', '');
}

function fmtDuration(min) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}hr ${m}min` : `${h}hr`;
}

/**
 * Given an open block and the service category thresholds, return which
 * service categories can realistically fit in that block.
 *
 * Uses minimum duration of any service in the category as the threshold —
 * if the shortest color service is 90min we say "color" for any 90min+ block.
 * Does NOT get granular about short/long variants — category-level only.
 *
 * @param {Object} block       - { durationMin: number }
 * @param {Array}  categories  - [{ categoryName, minDurationMin }] from getServiceCatalog
 * @param {Set}    stylistCats - Set of category names this stylist performs (from appointment history)
 * @returns {string[]} category names that fit, sorted shortest-threshold first
 */
export function categoriesForBlock(block, categories, stylistCats) {
  const fitting = categories
    .filter(c => stylistCats.has(c.categoryName))
    .filter(c => c.minDurationMin > 0 && c.minDurationMin <= block.durationMin)
    .sort((a, b) => b.minDurationMin - a.minDurationMin); // longest threshold first

  const has = name => fitting.some(c => c.categoryName === name);

  // Combined services for long blocks — Color + Highlight together needs ~150min
  if (block.durationMin >= 150 && has('Color') && has('Highlights')) {
    return ['Color + Highlight'];
  }

  return fitting.length ? [fitting[0].categoryName] : [];
}

/**
 * Summarize blocks into a human-readable availability statement for the post caption.
 * e.g. "3 open slots Tuesday — 30min at 9am, 1hr at 1pm, 1hr at 4pm"
 */
export function summarizeBlocks(blocks, dateStr) {
  if (!blocks.length) return null;
  const dayName = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
  const parts = blocks.map(b => `${fmtDuration(b.durationMin)} at ${fmt12h(b.start)}`);
  return `${blocks.length} open slot${blocks.length > 1 ? 's' : ''} ${dayName} — ${parts.join(', ')}`;
}
