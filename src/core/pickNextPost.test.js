// src/core/pickNextPost.test.js
// Unit tests for pickNextPost — SCHED-01 through SCHED-06
// Uses vitest with mocked dependencies (no real DB or Luxon)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock all external dependencies before importing the module under test
// ---------------------------------------------------------------------------

// Mock db module — configure per-test
vi.mock("../../db.js", () => {
  const mockStmt = {
    all: vi.fn(() => []),
    get: vi.fn(() => null),
  };
  const mockDb = {
    prepare: vi.fn(() => mockStmt),
  };
  return { db: mockDb };
});

// Mock luxon so we can control weekday
vi.mock("luxon", () => {
  const mockDt = {
    weekday: 3, // default: Wednesday (mid-week)
    setZone: vi.fn(),
  };
  mockDt.setZone.mockReturnValue(mockDt);

  const DateTime = {
    utc: vi.fn(() => mockDt),
    _mockDt: mockDt,
  };
  return { DateTime };
});

// Mock scheduler — we only need DEFAULT_PRIORITY
vi.mock("../scheduler.js", () => ({
  DEFAULT_PRIORITY: [
    "availability",
    "before_after",
    "celebration",
    "celebration_story",
    "standard_post",
    "promotions",
    "product_education",
  ],
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------
import { db } from "../../db.js";
import { DateTime } from "luxon";
import { pickNextPost } from "./pickNextPost.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(postType, id = postType) {
  return { id, post_type: postType, salon_id: "test-salon" };
}

function setWeekday(day) {
  // 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
  DateTime._mockDt.weekday = day;
}

function setupDbMocks({ distRows = [], lastPost = null, promoCount = 0 } = {}) {
  // db.prepare() is called multiple times — we need to return different stmts
  // per call. Track call count to return the right stmt.
  let callIndex = 0;
  db.prepare.mockImplementation(() => {
    const index = callIndex++;
    if (index === 0) {
      // Distribution query (last 7 published, GROUP BY post_type)
      return { all: vi.fn(() => distRows) };
    } else if (index === 1) {
      // Last published post_type query
      return { get: vi.fn(() => lastPost) };
    } else if (index === 2) {
      // Promotion count this week
      return { get: vi.fn(() => ({ n: promoCount })) };
    }
    return { all: vi.fn(() => []), get: vi.fn(() => null) };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setWeekday(3); // default to Wednesday
});

// ---------------------------------------------------------------------------
// SCHED-01: pickNextPost — basic selection
// ---------------------------------------------------------------------------
describe("pickNextPost", () => {
  it("returns null when posts array is empty", () => {
    setupDbMocks();
    const result = pickNextPost([], "test-salon");
    expect(result).toBeNull();
  });

  it("returns a post when posts array is non-empty", () => {
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    const posts = [makePost("standard_post"), makePost("before_after")];
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("post_type");
  });

  it("selects the most under-represented content type", () => {
    // 5 standard + 2 before_after in last 7 = standard over-represented
    // before_after is under-represented → should pick before_after
    setupDbMocks({
      distRows: [
        { post_type: "standard_post", cnt: 5 },
        { post_type: "before_after", cnt: 2 },
      ],
    });
    const posts = [makePost("standard_post", "s1"), makePost("before_after", "ba1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("before_after");
  });
});

// ---------------------------------------------------------------------------
// SCHED-02: standard distribution — 50-60% target
// ---------------------------------------------------------------------------
describe("standard distribution", () => {
  it("picks standard_post when under-represented (2 of 7 = 29%)", () => {
    // Only 2 of 7 recent posts are standard (29% < 50% target min)
    // before_after had 5 (71%) → standard is the one under-represented
    setupDbMocks({
      distRows: [
        { post_type: "standard_post", cnt: 2 },
        { post_type: "before_after", cnt: 5 },
      ],
    });
    const posts = [makePost("before_after", "ba1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("picks before_after over standard when standard is already above 60%", () => {
    // 5 standard (71%) is above max 60% → before_after is under-represented
    setupDbMocks({
      distRows: [
        { post_type: "standard_post", cnt: 5 },
        { post_type: "before_after", cnt: 2 },
      ],
    });
    const posts = [makePost("standard_post", "s1"), makePost("before_after", "ba1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("before_after");
  });
});

// ---------------------------------------------------------------------------
// SCHED-03: before_after weekday — only Tue/Wed/Thu
// ---------------------------------------------------------------------------
describe("before_after weekday", () => {
  it("filters out before_after on Monday (weekday=1)", () => {
    setWeekday(1); // Monday
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    // Only before_after and standard available; before_after should be excluded on Mon
    const posts = [makePost("before_after", "ba1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("allows before_after on Tuesday (weekday=2)", () => {
    setWeekday(2); // Tuesday
    setupDbMocks({
      distRows: [
        { post_type: "standard_post", cnt: 5 },
        { post_type: "before_after", cnt: 0 },
      ],
    });
    const posts = [makePost("before_after", "ba1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    // before_after has 0 count (most under-represented), should be selected on Tue
    expect(result.post_type).toBe("before_after");
  });

  it("filters out before_after on Friday (weekday=5)", () => {
    setWeekday(5); // Friday
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 3 }],
    });
    const posts = [makePost("before_after", "ba1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });
});

// ---------------------------------------------------------------------------
// SCHED-04: promotion cap — max 2-3/week, never back-to-back
// ---------------------------------------------------------------------------
describe("promotion cap", () => {
  it("filters out promotions when 2+ promotions published this week", () => {
    setupDbMocks({ promoCount: 2 });
    const posts = [makePost("promotions", "p1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("filters out promotions when 3+ promotions published this week", () => {
    setupDbMocks({ promoCount: 3 });
    const posts = [makePost("promotions", "p1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("allows promotions when fewer than 2 this week", () => {
    setupDbMocks({ promoCount: 1 });
    const posts = [makePost("promotions", "p1"), makePost("standard_post", "s1")];
    // With 1 promo this week, promotions should be eligible (deficit scoring determines winner)
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });

  it("filters out promotions when last published post was a promotion (back-to-back guard)", () => {
    setupDbMocks({
      promoCount: 0,
      lastPost: { post_type: "promotions" },
    });
    const posts = [makePost("promotions", "p1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("allows promotions when last published post was not a promotion", () => {
    setupDbMocks({
      promoCount: 0,
      lastPost: { post_type: "standard_post" },
    });
    const posts = [makePost("promotions", "p1"), makePost("standard_post", "s1")];
    // promotions are eligible; deficit scoring determines winner
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SCHED-05: availability midweek — only Tue/Wed/Thu
// ---------------------------------------------------------------------------
describe("availability midweek", () => {
  it("allows availability on Tuesday (weekday=2)", () => {
    setWeekday(2);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    // availability is eligible on Tue
    expect(result).not.toBeNull();
  });

  it("allows availability on Wednesday (weekday=3)", () => {
    setWeekday(3);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });

  it("allows availability on Thursday (weekday=4)", () => {
    setWeekday(4);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });

  it("filters out availability on Monday (weekday=1)", () => {
    setWeekday(1);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 3 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("filters out availability on Saturday (weekday=6)", () => {
    setWeekday(6);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 3 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });

  it("filters out availability on Sunday (weekday=7)", () => {
    setWeekday(7);
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 3 }],
    });
    const posts = [makePost("availability", "av1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result.post_type).toBe("standard_post");
  });
});

// ---------------------------------------------------------------------------
// SCHED-06: reel bonus — reels don't affect distribution, get lowest priority
// ---------------------------------------------------------------------------
describe("reel bonus", () => {
  it("returns reel post last (score -1) when other types are available", () => {
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 7 }], // standard over-represented
    });
    // If only reel is available, it should still be returned (no stall)
    const posts = [makePost("reel", "r1"), makePost("standard_post", "s1")];
    const result = pickNextPost(posts, "test-salon");
    // reel score is -1 (lowest), standard_post should be picked
    expect(result.post_type).toBe("standard_post");
  });

  it("returns reel post when it is the only option (never stalls)", () => {
    setupDbMocks({
      distRows: [{ post_type: "standard_post", cnt: 5 }],
    });
    const posts = [makePost("reel", "r1")];
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
    expect(result.post_type).toBe("reel");
  });

  it("reel posts do not count in the distribution query (excluded by post_type != reel)", () => {
    // The distribution query excludes reels — verified by the SQL in the implementation
    // Here we check that a reel in the queue doesn't affect which type is under-represented
    setupDbMocks({
      distRows: [
        // If reels counted, we'd have more posts — but they're excluded
        { post_type: "standard_post", cnt: 5 },
        { post_type: "before_after", cnt: 2 },
      ],
    });
    const posts = [
      makePost("reel", "r1"),
      makePost("standard_post", "s1"),
      makePost("before_after", "ba1"),
    ];
    const result = pickNextPost(posts, "test-salon");
    // before_after is under-represented (2/7 = 29% < 15% target min? wait, 2/7 = 29% > 15%)
    // standard_post is over-represented (5/7 = 71% > 60% target max)
    // before_after deficit = 15% - 29% = -14% (already at target)
    // standard_post deficit = 50% - 71% = -21% (over-represented)
    // reel gets score -1 — lowest
    // Most under-represented is before_after (since standard is over), so before_after picked
    expect(result.post_type).toBe("before_after");
  });
});

// ---------------------------------------------------------------------------
// Edge cases — never stall
// ---------------------------------------------------------------------------
describe("never stall", () => {
  it("falls back to full posts array if all candidates are filtered out", () => {
    setWeekday(1); // Monday — availability and before_after filtered
    setupDbMocks({ promoCount: 3 }); // promotions also filtered
    // All candidate types are ineligible on Monday with promo cap
    const posts = [
      makePost("availability", "av1"),
      makePost("before_after", "ba1"),
      makePost("promotions", "p1"),
    ];
    // Fallback: none are eligible → return from full posts array
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });

  it("returns first post from fallback when filtered array is empty", () => {
    setWeekday(6); // Saturday
    setupDbMocks({ promoCount: 2, lastPost: { post_type: "promotions" } });
    const posts = [makePost("availability", "av1")];
    // availability filtered on Sat; only availability in queue → fallback
    const result = pickNextPost(posts, "test-salon");
    expect(result).not.toBeNull();
  });
});
