// src/core/availabilityRequest.js
// Detects availability push requests from stylist SMS messages and parses date ranges.

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/**
 * Returns true if the message contains a specific date hint.
 * When false, callers should use the full upcoming window rather than defaulting to "this week".
 */
export function hasDateHint(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('today') || t.includes('tomorrow') ||
    t.includes('this week') || t.includes("week's") || t.includes('weeks') ||
    t.includes('next week') ||
    DAY_NAMES.some(d => t.includes(d)) ||
    /\b\d{1,2}[\/\-]\d{1,2}\b/.test(t) ||
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(t) ||
    /\bthe\s+\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}(?:st|nd|rd|th)\b/.test(t)
  );
}

/**
 * Detect if a message is an availability push request.
 * Returns true if the message contains availability intent with no photo.
 */
export function isAvailabilityRequest(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (t.includes('availab') || t.includes('open slot') || t.includes('openings'))
      && (t.includes('push') || t.includes('post') || t.includes('share') || t.includes('send')
          || t.includes('my') || t.includes('this') || t.includes('next') || t.includes('for'));
}

/**
 * Parse a date range from a natural language availability message.
 * Returns { startDate, endDate } as "YYYY-MM-DD" strings.
 *
 * Handles:
 *   "this week" / "this week's availability"
 *   "next week"
 *   "tomorrow"
 *   "today"
 *   "this Tuesday" / "this Saturday"
 *   "next Wednesday" / "next Friday"
 *   "Tuesday" alone → upcoming Tuesday
 *   Specific dates: "March 20", "the 20th", "3/20"
 *
 * @param {string} text
 * @param {Date}   now   - reference date (defaults to new Date())
 * @returns {{ startDate: string, endDate: string }}
 */
export function parseDateRange(text, now = new Date()) {
  const t = text.toLowerCase();

  // today → just today
  if (t.includes('today')) {
    const d = dateStr(now);
    return { startDate: d, endDate: d };
  }

  // tomorrow
  if (t.includes('tomorrow')) {
    const d = addDays(now, 1);
    return { startDate: dateStr(d), endDate: dateStr(d) };
  }

  // next week → Monday–Sunday of next calendar week
  if (t.includes('next week')) {
    const monday = nextWeekday(now, 1, true); // force next week's Monday
    const sunday = addDays(monday, 6);
    return { startDate: dateStr(monday), endDate: dateStr(sunday) };
  }

  // this week → today through this Sunday
  if (t.includes('this week') || t.includes("week's") || t.includes('weeks')) {
    const sunday = nextWeekday(now, 0, false); // this week's Sunday
    return { startDate: dateStr(now), endDate: dateStr(sunday) };
  }

  // "next <dayname>" — day in next 7-14 days
  for (const [i, day] of DAY_NAMES.entries()) {
    if (t.includes(`next ${day}`)) {
      const target = nextWeekday(now, i, true); // force next occurrence
      return { startDate: dateStr(target), endDate: dateStr(target) };
    }
  }

  // "this <dayname>" — day within the current week
  for (const [i, day] of DAY_NAMES.entries()) {
    if (t.includes(`this ${day}`)) {
      const target = nextWeekday(now, i, false);
      return { startDate: dateStr(target), endDate: dateStr(target) };
    }
  }

  // Bare day name "saturday", "tuesday", etc. → next upcoming occurrence
  for (const [i, day] of DAY_NAMES.entries()) {
    if (t.includes(day)) {
      const target = nextWeekday(now, i, false);
      return { startDate: dateStr(target), endDate: dateStr(target) };
    }
  }

  // Specific date: "March 20", "march 20th", "3/20", "3-20"
  const specific = parseSpecificDate(t, now);
  if (specific) {
    return { startDate: dateStr(specific), endDate: dateStr(specific) };
  }

  // Default: this week (today → Sunday)
  const sunday = nextWeekday(now, 0, false);
  return { startDate: dateStr(now), endDate: dateStr(sunday) };
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Find the next occurrence of a weekday (0=Sun, 1=Mon … 6=Sat).
 * If forceNext=true, always returns a future week's occurrence (never today).
 * If forceNext=false, returns this week's day even if it's today or earlier in the week,
 * but if it's already past returns the next occurrence.
 */
function nextWeekday(from, targetDow, forceNext) {
  const fromDow = from.getDay();
  let diff = targetDow - fromDow;
  if (forceNext) {
    // Always at least 7 days ahead if diff ≤ 0, otherwise within next 7 days
    if (diff <= 0) diff += 7;
    // For "next week" semantics we might want exactly next week's Monday
    if (targetDow === 1 && diff < 7) diff += 7; // next week's Monday specifically
  } else {
    // "this" or bare day: find the upcoming occurrence (today counts if targetDow === fromDow)
    if (diff < 0) diff += 7;
    // If it's already past today and same week, still go to next occurrence
    if (diff === 0 && forceNext === false) diff = 0; // today is fine
  }
  return addDays(from, diff);
}

const MONTH_MAP = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function parseSpecificDate(t, now) {
  // "3/20" or "3-20"
  const slashMatch = t.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1], 10);
    const day   = parseInt(slashMatch[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = now.getFullYear();
      return new Date(year, month - 1, day);
    }
  }

  // "March 20" or "march 20th"
  for (const [abbr, month] of Object.entries(MONTH_MAP)) {
    const re = new RegExp(`${abbr}[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?`, 'i');
    const m = t.match(re);
    if (m) {
      const day = parseInt(m[1], 10);
      const year = now.getFullYear();
      return new Date(year, month - 1, day);
    }
  }

  // "the 20th" / "20th"
  const ordinalMatch = t.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b|\b(\d{1,2})(?:st|nd|rd|th)\b/);
  if (ordinalMatch) {
    const day = parseInt(ordinalMatch[1] || ordinalMatch[2], 10);
    if (day >= 1 && day <= 31) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      // If this day is already past this month, try next month
      if (d < now) d.setMonth(d.getMonth() + 1);
      return d;
    }
  }

  return null;
}
