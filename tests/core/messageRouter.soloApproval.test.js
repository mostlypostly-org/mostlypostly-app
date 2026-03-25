// tests/core/messageRouter.soloApproval.test.js
import { describe, it, expect } from "vitest";

// Pure function mirroring the approval decision logic
function resolveRequiresManager({ plan, require_manager_approval, stylistAutoApprove }) {
  if (plan === "solo") return false; // Solo: always auto-approved
  return Number(require_manager_approval) === 1 && !stylistAutoApprove;
}

describe("resolveRequiresManager — solo bypass", () => {
  it("solo with require_manager_approval=1 → false (bypassed)", () => {
    expect(resolveRequiresManager({ plan: "solo", require_manager_approval: 1, stylistAutoApprove: false })).toBe(false);
  });
  it("solo with require_manager_approval=0 → false", () => {
    expect(resolveRequiresManager({ plan: "solo", require_manager_approval: 0, stylistAutoApprove: false })).toBe(false);
  });
  it("starter with require_manager_approval=1 → true", () => {
    expect(resolveRequiresManager({ plan: "starter", require_manager_approval: 1, stylistAutoApprove: false })).toBe(true);
  });
  it("starter with require_manager_approval=0 → false", () => {
    expect(resolveRequiresManager({ plan: "starter", require_manager_approval: 0, stylistAutoApprove: false })).toBe(false);
  });
  it("starter with require_manager_approval=1 + stylistAutoApprove → false", () => {
    expect(resolveRequiresManager({ plan: "starter", require_manager_approval: 1, stylistAutoApprove: true })).toBe(false);
  });
});
