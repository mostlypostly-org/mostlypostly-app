import { describe, it, expect } from "vitest";
import { PLAN_LIMITS } from "../../src/routes/billing.js";

describe("PLAN_LIMITS solo", () => {
  it("exists", () => expect(PLAN_LIMITS.solo).toBeDefined());
  it("posts is 20", () => expect(PLAN_LIMITS.solo.posts).toBe(20));
  it("stylists is 1", () => expect(PLAN_LIMITS.solo.stylists).toBe(1));
  it("locations is 1", () => expect(PLAN_LIMITS.solo.locations).toBe(1));
  it("managers is 0", () => expect(PLAN_LIMITS.solo.managers).toBe(0));
});
