// tests/rcs.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the twilio client before importing the module
vi.mock("twilio", () => {
  const create = vi.fn().mockResolvedValue({ sid: "SM123" });
  const MessagingResponse = vi.fn(() => ({ toString: () => "<Response/>", message: vi.fn() }));
  const twilioConstructor = vi.fn(() => ({ messages: { create } }));
  twilioConstructor.twiml = { MessagingResponse };
  twilioConstructor.validateRequest = vi.fn(() => true);
  return {
    default: twilioConstructor,
    twiml: { MessagingResponse },
    validateRequest: vi.fn(() => true),
  };
});

// Must set env vars before importing the module under test
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "authtest";
process.env.TWILIO_MESSAGING_SERVICE_SID = "MGtest";

describe("sendViaRcs", () => {
  let sendViaRcs;
  let mockCreate;

  beforeEach(async () => {
    vi.resetModules();
    process.env.RCS_ENABLED = "true";
    const twilio = await import("twilio");
    mockCreate = twilio.default().messages.create;
    const mod = await import("../src/routes/twilio.js");
    sendViaRcs = mod.sendViaRcs;
  });

  it("sends with persistentAction when RCS_ENABLED=true", async () => {
    await sendViaRcs("+15550001111", "Hello!", ["reply:Approve", "reply:Cancel"]);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        persistentAction: ["reply:Approve", "reply:Cancel"],
        body: "Hello!",
        to: "+15550001111",
      })
    );
  });

  it("falls back to plain SMS when RCS_ENABLED is unset", async () => {
    vi.resetModules();
    delete process.env.RCS_ENABLED;
    const twilio = await import("twilio");
    const freshCreate = twilio.default().messages.create;
    const mod = await import("../src/routes/twilio.js");
    const sendViaRcsFallback = mod.sendViaRcs;
    await sendViaRcsFallback("+15550001111", "Hello!", ["reply:Approve"]);
    // Should still call create but without persistentAction
    expect(freshCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ persistentAction: expect.anything() })
    );
  });

  it("does not send persistentAction when buttons is empty even if RCS_ENABLED=true", async () => {
    await sendViaRcs("+15550001111", "Hello!", []);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ persistentAction: expect.anything() })
    );
  });
});
