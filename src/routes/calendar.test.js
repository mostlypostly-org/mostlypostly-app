/**
 * calendar.test.js
 * Unit tests for calendar business logic.
 *
 * Requires calendarPillClass to be exported from calendar.js.
 *
 * RED phase: these tests will fail until Plan 01 creates src/routes/calendar.js
 * and exports calendarPillClass. Plans 01 and 02 implement the production code
 * that makes these tests pass (GREEN).
 *
 * Run: npx vitest run src/routes/calendar.test.js
 */

import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { calendarPillClass } from "./calendar.js";

// ---------------------------------------------------------------------------
// Helper: inline reschedule date math (mirrors the POST /reschedule handler)
// Tested here as a pure function since the POST handler is not easily exported.
// ---------------------------------------------------------------------------
function rescheduleDateOnly(scheduledFor, newDate) {
  const original = DateTime.fromSQL(scheduledFor, { zone: "utc" });
  const [y, mo, d] = newDate.split("-").map(Number);
  const updated = original.set({ year: y, month: mo, day: d });
  return updated.toFormat("yyyy-LL-dd HH:mm:ss");
}

// ---------------------------------------------------------------------------
// describe 1: calendarPillClass
// ---------------------------------------------------------------------------
describe("calendarPillClass", () => {
  it("vendor override: vendor_campaign_id truthy returns bg-purple-100", () => {
    const result = calendarPillClass({ vendor_campaign_id: "vc-1", post_type: "standard_post" });
    expect(result).toContain("bg-purple-100");
    expect(result).toContain("text-purple-700");
  });

  it("vendor override: vendor_campaign_id takes precedence even for before_after", () => {
    const result = calendarPillClass({ vendor_campaign_id: "vc-2", post_type: "before_after" });
    expect(result).toContain("bg-purple-100");
  });

  it("standard_post returns bg-blue-100", () => {
    const result = calendarPillClass({ post_type: "standard_post" });
    expect(result).toContain("bg-blue-100");
    expect(result).toContain("text-blue-700");
  });

  it("before_after returns bg-teal-100", () => {
    const result = calendarPillClass({ post_type: "before_after" });
    expect(result).toContain("bg-teal-100");
    expect(result).toContain("text-teal-700");
  });

  it("before_after_post (underscore variant) returns bg-teal-100", () => {
    const result = calendarPillClass({ post_type: "before_after_post" });
    expect(result).toContain("bg-teal-100");
  });

  it("availability returns bg-green-100", () => {
    const result = calendarPillClass({ post_type: "availability" });
    expect(result).toContain("bg-green-100");
    expect(result).toContain("text-green-700");
  });

  it("promotion returns bg-amber-100", () => {
    const result = calendarPillClass({ post_type: "promotion" });
    expect(result).toContain("bg-amber-100");
    expect(result).toContain("text-amber-700");
  });

  it("promotions (plural variant) returns bg-amber-100", () => {
    const result = calendarPillClass({ post_type: "promotions" });
    expect(result).toContain("bg-amber-100");
  });

  it("celebration returns bg-pink-100", () => {
    const result = calendarPillClass({ post_type: "celebration" });
    expect(result).toContain("bg-pink-100");
    expect(result).toContain("text-pink-700");
  });

  it("celebration_story returns bg-pink-100", () => {
    const result = calendarPillClass({ post_type: "celebration_story" });
    expect(result).toContain("bg-pink-100");
  });

  it("reel returns bg-indigo-100", () => {
    const result = calendarPillClass({ post_type: "reel" });
    expect(result).toContain("bg-indigo-100");
    expect(result).toContain("text-indigo-700");
  });

  it("failed status overrides type and returns bg-red-100", () => {
    const result = calendarPillClass({ post_type: "standard_post", status: "failed" });
    expect(result).toContain("bg-red-100");
    expect(result).toContain("text-red-700");
  });

  it("unknown post_type returns fallback bg-gray-100", () => {
    const result = calendarPillClass({ post_type: "unknown_type" });
    expect(result).toContain("bg-gray-100");
  });

  it("missing post_type returns fallback bg-gray-100", () => {
    const result = calendarPillClass({});
    expect(result).toContain("bg-gray-100");
  });
});

// ---------------------------------------------------------------------------
// describe 2: reschedule date math
// ---------------------------------------------------------------------------
describe("reschedule date math", () => {
  it("changes date while preserving time: 14:30:00 on April 1 => April 5", () => {
    const result = rescheduleDateOnly("2026-04-01 14:30:00", "2026-04-05");
    expect(result).toBe("2026-04-05 14:30:00");
  });

  it("changes date while preserving time: 08:00:00 on March 15 => March 20", () => {
    const result = rescheduleDateOnly("2026-03-15 08:00:00", "2026-03-20");
    expect(result).toBe("2026-03-20 08:00:00");
  });

  it("preserves minutes and seconds exactly: 23:59:59", () => {
    const result = rescheduleDateOnly("2026-01-10 23:59:59", "2026-02-28");
    expect(result).toBe("2026-02-28 23:59:59");
  });

  it("preserves midnight time: 00:00:00", () => {
    const result = rescheduleDateOnly("2026-06-01 00:00:00", "2026-06-15");
    expect(result).toBe("2026-06-15 00:00:00");
  });

  it("changes year, month, and day correctly", () => {
    const result = rescheduleDateOnly("2026-12-31 09:15:30", "2027-01-01");
    expect(result).toBe("2027-01-01 09:15:30");
  });

  it("does not shift time when moving across DST-relevant dates", () => {
    // America/Indiana/Indianapolis uses UTC-5 (EST) and UTC-4 (EDT)
    // The scheduled_for is always UTC, so DST on the salon side does not affect UTC storage
    const result = rescheduleDateOnly("2026-03-08 03:30:00", "2026-03-09");
    expect(result).toBe("2026-03-09 03:30:00");
  });
});

// ---------------------------------------------------------------------------
// describe 3: UTC date range for calendar grid
// ---------------------------------------------------------------------------
describe("UTC date range for calendar grid", () => {
  it("a local date range in America/Indiana/Indianapolis spans correct UTC hours", () => {
    // April 1, 2026 in EST (UTC-5): local midnight = 05:00 UTC, local 23:59 = 04:59 next day UTC
    const tz = "America/Indiana/Indianapolis";
    const localDate = "2026-04-01";
    const startUTC = DateTime.fromISO(localDate, { zone: tz }).startOf("day").toUTC();
    const endUTC = DateTime.fromISO(localDate, { zone: tz }).endOf("day").toUTC();

    // UTC offset for EST is -5, so local midnight = 05:00 UTC
    expect(startUTC.hour).toBe(5);
    expect(startUTC.minute).toBe(0);
    expect(startUTC.day).toBe(1); // still April 1 UTC (05:00 UTC)
    // end of day (23:59:59.999 local) = 04:59:59 UTC next day
    expect(endUTC.hour).toBe(4);
    expect(endUTC.day).toBe(2); // April 2 in UTC
  });

  it("a post scheduled at 11pm salon time is stored as next day UTC and mapped to correct local day", () => {
    const tz = "America/Indiana/Indianapolis";
    // Post scheduled at 11pm local April 1 => 04:00 UTC April 2
    const localPost = DateTime.fromISO("2026-04-01T23:00:00", { zone: tz });
    const storedUTC = localPost.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
    expect(storedUTC).toBe("2026-04-02 04:00:00");

    // When grouping, convert stored UTC back to local to find the local day
    const localDay = DateTime.fromSQL(storedUTC, { zone: "utc" })
      .setZone(tz)
      .toFormat("yyyy-LL-dd");
    expect(localDay).toBe("2026-04-01"); // post belongs to April 1 locally
  });

  it("4-week window starting today covers exactly 28 local days", () => {
    const tz = "America/Indiana/Indianapolis";
    const today = DateTime.now().setZone(tz).startOf("day");
    const windowEnd = today.plus({ days: 27 }).endOf("day");
    const daysDiff = windowEnd.startOf("day").diff(today, "days").days;
    expect(daysDiff).toBe(27); // 0..27 = 28 days total
  });

  it("UTC start and end boundaries form a complete day with no gap", () => {
    const tz = "America/Indiana/Indianapolis";
    const localDate = "2026-06-15";
    const startUTC = DateTime.fromISO(localDate, { zone: tz }).startOf("day").toUTC();
    const endUTC = DateTime.fromISO(localDate, { zone: tz }).endOf("day").toUTC();
    // The range should be exactly 86400 seconds (1 full day, ignoring milliseconds)
    const diffMs = endUTC.toMillis() - startUTC.toMillis();
    // 24h in ms = 86_400_000; endOf adds 999ms so total = 86_399_999
    expect(diffMs).toBeGreaterThanOrEqual(86_399_000);
    expect(diffMs).toBeLessThanOrEqual(86_400_000);
  });
});
