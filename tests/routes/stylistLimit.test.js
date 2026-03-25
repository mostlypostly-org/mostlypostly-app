// tests/routes/stylistLimit.test.js
import { describe, it, expect } from "vitest";
import { PLAN_LIMITS } from "../../src/routes/billing.js";

function canAddStylist({ plan, currentStylistCount }) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
  if (limits.stylists === null) return { ok: true }; // unlimited (Pro)
  if (currentStylistCount >= limits.stylists) {
    const upgradeMap = { solo: "Starter", starter: "Growth", growth: "Pro" };
    const upgradeTo = upgradeMap[plan] || "a higher tier";
    return {
      ok: false,
      message: plan === "solo"
        ? `The Solo plan supports 1 stylist. Upgrade to ${upgradeTo} to add your team.`
        : `You've reached your ${limits.stylists}-stylist limit on the ${plan} plan. Upgrade to ${upgradeTo} to add more.`,
    };
  }
  return { ok: true };
}

describe("canAddStylist", () => {
  it("solo with 0 stylists → ok", () => {
    expect(canAddStylist({ plan: "solo", currentStylistCount: 0 }).ok).toBe(true);
  });
  it("solo with 1 stylist → blocked with solo message", () => {
    const result = canAddStylist({ plan: "solo", currentStylistCount: 1 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Solo plan supports 1 stylist");
    expect(result.message).toContain("Upgrade to Starter");
  });
  it("starter with 4 stylists → blocked with starter message", () => {
    const result = canAddStylist({ plan: "starter", currentStylistCount: 4 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("4-stylist limit");
  });
  it("starter with 3 stylists → ok", () => {
    expect(canAddStylist({ plan: "starter", currentStylistCount: 3 }).ok).toBe(true);
  });
  it("pro → always ok (unlimited)", () => {
    expect(canAddStylist({ plan: "pro", currentStylistCount: 999 }).ok).toBe(true);
  });
});
