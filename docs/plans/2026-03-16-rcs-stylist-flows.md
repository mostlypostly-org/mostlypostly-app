# RCS Stylist Flows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the three stylist-facing SMS flows (Consent, Join, Post Preview) to Twilio RCS with tappable action chips, falling back to plain SMS automatically when RCS is unavailable.

**Architecture:** Add `sendViaRcs(to, body, buttons)` to `twilio.js` using the existing `TWILIO_MESSAGING_SERVICE_SID`. Gate the feature with `RCS_ENABLED=true` env var. Upgrade the three stylist touch-points to call `sendViaRcs` — when tapped, buttons send back the exact same keyword text ("APPROVE", "REDO" etc.) that the existing inbound handlers already process, so `messageRouter.js` needs no changes.

**Tech Stack:** Node.js ESM, Twilio Node SDK (`twilio` package already installed), `vitest` (already in devDependencies)

---

### Task 1: Add `sendViaRcs` to twilio.js

**Context:** `src/routes/twilio.js` exports `sendViaTwilio(to, body)` which uses either `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_PHONE_NUMBER`. We need a parallel export `sendViaRcs(to, body, buttons)` that adds `persistentAction` chips when `RCS_ENABLED=true`, else falls back to plain SMS.

**Files:**
- Modify: `src/routes/twilio.js` (around line 23 — after the existing `sendViaTwilio` function)
- Create: `tests/rcs.test.js`

**Step 1: Create the test file**

```js
// tests/rcs.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the twilio client before importing the module
vi.mock("twilio", () => {
  const create = vi.fn().mockResolvedValue({ sid: "SM123" });
  return {
    default: vi.fn(() => ({
      messages: { create },
    })),
    twiml: { MessagingResponse: vi.fn(() => ({ toString: () => "<Response/>", message: vi.fn() })) },
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
    const mod = await import("../src/routes/twilio.js");
    const sendViaRcsFallback = mod.sendViaRcs;
    await sendViaRcsFallback("+15550001111", "Hello!", ["reply:Approve"]);
    // Should still call create but without persistentAction
    expect(mockCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ persistentAction: expect.anything() })
    );
  });
});
```

**Step 2: Run test to confirm it fails**

```bash
cd /Users/troyhardister/chairlyos/mostlypostly/mostlypostly-app
npx vitest run tests/rcs.test.js
```

Expected: FAIL — `sendViaRcs is not a function`

**Step 3: Add `sendViaRcs` to twilio.js**

Add immediately after the closing `}` of `sendViaTwilio` (around line 34):

```js
export async function sendViaRcs(to, body, buttons = []) {
  try {
    const rcsEnabled = process.env.RCS_ENABLED === "true";
    const base = process.env.TWILIO_MESSAGING_SERVICE_SID
      ? { messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, to, body }
      : { from: process.env.TWILIO_PHONE_NUMBER, to, body };

    const opts = rcsEnabled && buttons.length
      ? { ...base, persistentAction: buttons }
      : base;

    const resp = await client.messages.create(opts);
    console.log(`[Twilio RCS → ${to}] id=${resp.sid} :: ${body.slice(0, 140)}`);
  } catch (err) {
    console.error("⚠️ [Twilio RCS Send Error]:", err.message);
  }
}
```

**Step 4: Run test to confirm it passes**

```bash
npx vitest run tests/rcs.test.js
```

Expected: PASS — 2 tests passing

**Step 5: Commit**

```bash
git add src/routes/twilio.js tests/rcs.test.js
git commit -m "feat: add sendViaRcs with persistentAction chips and RCS_ENABLED gate"
```

---

### Task 2: Upgrade consent welcome message (stylistWelcome.js)

**Context:** `src/core/stylistWelcome.js` exports `sendWelcomeSms(stylist, salonName)`. When the stylist has no consent on file, it sends a plain SMS asking them to reply AGREE. We upgrade that one message to use `sendViaRcs` with an `[ Agree ]` chip.

**Files:**
- Modify: `src/core/stylistWelcome.js`

**Step 1: Update the import at the top of stylistWelcome.js**

Find:
```js
import { sendViaTwilio } from "../routes/twilio.js";
```

Replace with:
```js
import { sendViaTwilio, sendViaRcs } from "../routes/twilio.js";
```

**Step 2: Replace the no-consent send call**

Find (lines 23–29):
```js
if (!hasConsent) {
    await sendViaTwilio(
      phone,
      `Hi ${name}! ${salonName} has added you to MostlyPostly — your AI social media assistant.\n\n` +
      `Text a camera photo to this number and we'll create a professional Instagram & Facebook caption for you automatically.\n\n` +
      `Reply AGREE to get started. Reply STOP to opt out. Msg & data rates may apply.`
    );
```

Replace with:
```js
if (!hasConsent) {
    await sendViaRcs(
      phone,
      `Hi ${name}! ${salonName} has added you to MostlyPostly — your AI social media assistant.\n\n` +
      `Text a photo and we'll create a professional Instagram & Facebook caption automatically.\n\n` +
      `Tap Agree below to get started. Reply STOP to opt out. Msg & data rates may apply.`,
      ["reply:AGREE"]
    );
```

**Step 3: Verify manually**

Add a stylist via the Team page. Confirm the welcome SMS arrives. On an RCS-capable Android, an "Agree" chip appears. On iPhone (pre-RCS) or SMS fallback, plain text arrives with "Reply STOP to opt out" intact.

**Step 4: Commit**

```bash
git add src/core/stylistWelcome.js
git commit -m "feat: upgrade consent welcome SMS to RCS with Agree chip"
```

---

### Task 3: Upgrade Join conversation chips (joinManager.js)

**Context:** `src/core/joinManager.js` receives a `sendMessage` callback (a plain function wrapping `sendViaTwilio`). We need to pass `sendViaRcs` chips on steps 3 (Instagram) and 4 (Specialties) where "None" is the common answer.

The `sendMessage` callback is a plain `async (msg) => sendViaTwilio(from, msg)` passed in from `twilio.js`. We need to change it to a richer object so chips can optionally be included, OR we add a `sendRichMessage` second callback.

The simplest approach: change `sendMessage` to accept an options object `{ text, buttons }` and update the two callers.

**Files:**
- Modify: `src/core/joinManager.js`
- Modify: `src/routes/twilio.js` (the `handleJoinCommand` / `continueJoinConversation` call sites)

**Step 1: Update joinManager.js to accept optional buttons**

In `joinManager.js`, the `sendMessage` parameter is called as `await sendMessage("some text")`. Change the internal calls on steps 3 and 4 to pass a second `buttons` argument:

In `continueJoinConversation`, change step 3:
```js
case 3:
  data.instagram_handle = text.toLowerCase().replace("@", "") === "none" ? "" : text.replace("@", "");
  session.step = 4;
  await sendMessage(
    `🎨 Great! What are their specialties?\n(Type 1–2, separated by commas, or reply NONE if you're not sure yet)`,
    ["reply:NONE"]
  );
  return { done: false };
```

And step 2 (Instagram prompt — it asks for handle, user can reply "none"):
```js
case 2:
  data.contact = text.replace(/\D/g, "");
  session.step = 3;
  await sendMessage(
    `📱 Thanks! What is their Instagram handle (you can type none)?`,
    ["reply:NONE"]
  );
  return { done: false };
```

**Step 2: Update the sendMessage signature in joinManager.js**

The `sendMessage` parameter is currently `async (msg) => ...`. It needs to accept an optional `buttons` array. All other callers that don't need buttons still work because buttons defaults to `[]`.

No change needed inside `joinManager.js` for the function signature — the change is in how the *caller* constructs `sendMessage`.

**Step 3: Update the caller in twilio.js**

In `twilio.js`, the `handleJoinCommand` and `continueJoinConversation` calls pass:
```js
(msg) => sendViaTwilio(from, msg)
```

Change to:
```js
(msg, buttons = []) => sendViaRcs(from, msg, buttons)
```

Find in `twilio.js` (lines 133 and 137):
```js
await handleJoinCommand(from, lookupStylist, text, (msg) => sendViaTwilio(from, msg));
```
and
```js
await continueJoinConversation(from, text, (msg) => sendViaTwilio(from, msg));
```

Replace both with:
```js
await handleJoinCommand(from, lookupStylist, text, (msg, buttons = []) => sendViaRcs(from, msg, buttons));
```
and
```js
await continueJoinConversation(from, text, (msg, buttons = []) => sendViaRcs(from, msg, buttons));
```

**Step 4: Update the sendViaRcs import in twilio.js**

The `sendViaRcs` function is in the same file as the caller (`twilio.js`), so no import needed — it's already in scope.

**Step 5: Verify manually**

Trigger a JOIN flow from a registered manager's phone. On step 3 (Instagram) and step 4 (Specialties), confirm `[ NONE ]` chip appears on RCS devices. All other steps are plain text.

**Step 6: Commit**

```bash
git add src/core/joinManager.js src/routes/twilio.js
git commit -m "feat: add NONE chips on Instagram and specialties steps in Join flow"
```

---

### Task 4: Upgrade post preview to RCS with action chips (messageRouter.js)

**Context:** In `src/core/messageRouter.js`, after AI generates a caption, the code generates a portal token and calls:

```js
await sendMessage.sendText(chatId,
  `Your caption preview is ready! Review and edit it here:\n${portalUrl}\n\nOr reply APPROVE to submit now, or CANCEL to discard. (Link expires in 24 hours.)`
);
```

This is at ~line 586. We upgrade this to use RCS chips while keeping the portal URL. The `sendMessage` object is `{ sendText: async (target, msg) => sendViaTwilio(target || from, msg) }` — we add a `sendRcs` method to it.

**Files:**
- Modify: `src/core/messageRouter.js` (line ~586 — the portal URL send block)
- Modify: `src/routes/twilio.js` (where `handleIncomingMessage` is called — add `sendRcs` to the `sendMessage` object)

**Step 1: Add `sendRcs` to the sendMessage object in twilio.js**

Find (around line 158–160):
```js
sendMessage: {
  sendText: async (target, msg) => sendViaTwilio(target || from, msg),
},
```

Replace with:
```js
sendMessage: {
  sendText: async (target, msg) => sendViaTwilio(target || from, msg),
  sendRcs: async (target, msg, buttons) => sendViaRcs(target || from, msg, buttons),
},
```

**Step 2: Upgrade the preview send in messageRouter.js**

Find (lines 586–588):
```js
await sendMessage.sendText(chatId,
  `Your caption preview is ready! Review and edit it here:\n${portalUrl}\n\nOr reply APPROVE to submit now, or CANCEL to discard. (Link expires in 24 hours.)`
);
```

Replace with:
```js
const previewMsg =
  `Your caption preview is ready!\n\n` +
  `Review or edit here:\n${portalUrl}\n\n` +
  `Or tap a button below. (Link expires in 24 hours.)`;

if (sendMessage.sendRcs) {
  await sendMessage.sendRcs(chatId, previewMsg, ["reply:APPROVE", "reply:REDO", "reply:CANCEL"]);
} else {
  await sendMessage.sendText(chatId, previewMsg);
}
```

**Note:** The `sendMessage.sendRcs` guard ensures Telegram still works (Telegram's `sendMessage` object won't have `sendRcs`).

**Step 3: Verify manually**

Use the test celebration URL or text a photo from a stylist phone. The preview message should arrive. On an RCS device, three chips appear: Approve / Redo / Cancel. Tapping Approve should submit the post exactly as typing "APPROVE" does.

**Step 4: Commit**

```bash
git add src/core/messageRouter.js src/routes/twilio.js
git commit -m "feat: upgrade post preview SMS to RCS with Approve/Redo/Cancel chips"
```

---

### Task 5: Add RCS_ENABLED to Render environment + smoke test

**Context:** The feature is now fully implemented but gated behind `RCS_ENABLED=true`. This task enables it on staging and verifies end-to-end.

**Step 1: Add env var on Render staging**

In Render Dashboard → `mostlypostly-staging` → Environment:
- Add `RCS_ENABLED` = `true`

**Step 2: Verify Twilio Messaging Service has RCS enabled**

In Twilio Console → Messaging → Services → [your service] → Senders → confirm RCS sender is added. If not, go to Twilio Console → Messaging → Senders → RCS → Add Sender and attach to the Messaging Service.

**Step 3: Smoke test consent flow**

1. Add a test stylist with a real Android phone number (RCS-capable)
2. Confirm welcome SMS arrives with `[ Agree ]` chip
3. Tap chip → confirm "AGREE" is processed and stylist is activated

**Step 4: Smoke test preview flow**

1. Text a photo from a registered stylist phone
2. Confirm preview arrives with `[ Approve ]` `[ Redo ]` `[ Cancel ]` chips
3. Tap Approve → confirm post enters the queue

**Step 5: Enable on production**

Add `RCS_ENABLED=true` to `mostlypostly` (production) environment in Render.

**Step 6: Update CLAUDE.md**

Add `RCS_ENABLED` to the Environment Variables table in `CLAUDE.md`:

```
| RCS_ENABLED | `true` or unset | Enables Twilio RCS chips on consent, join, and preview messages. Falls back to plain SMS when unset or when recipient device doesn't support RCS. |
```

**Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add RCS_ENABLED env var to CLAUDE.md"
```

---

## Testing Checklist

- [ ] `npx vitest run tests/rcs.test.js` — 2 tests passing
- [ ] Welcome SMS on RCS device shows `[ Agree ]` chip
- [ ] Welcome SMS on non-RCS device shows plain text (no chip, no error)
- [ ] Join step 3 (Instagram) shows `[ NONE ]` chip
- [ ] Join step 4 (Specialties) shows `[ NONE ]` chip
- [ ] Post preview shows `[ Approve ]` `[ Redo ]` `[ Cancel ]` chips
- [ ] Tapping Approve submits post (same as typing APPROVE)
- [ ] Tapping Redo regenerates caption (same as typing REDO)
- [ ] Tapping Cancel discards draft (same as typing CANCEL)
- [ ] Telegram preview flow still works (no `sendRcs` on Telegram's sendMessage object)
