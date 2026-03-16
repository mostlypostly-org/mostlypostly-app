# RCS Stylist Flows Design

**Date:** 2026-03-16

## Goal

Upgrade the three stylist-facing SMS flows — Consent, Join, and Post Preview — to Twilio RCS with tappable action chips. Stylists on RCS-capable devices get one-tap buttons instead of typing keywords. Devices without RCS fall back to plain SMS automatically.

## Approach

Hybrid: ship RCS suggested reply chips now (Approach C). Rich Content Template cards (inline image carousel) are a future follow-on once the foundation is stable.

## Architecture

### RCS Send Layer (`twilio.js`)

Add `sendViaRcs(to, body, buttons, mediaUrl?)` alongside the existing `sendViaTwilio`. It sends via the Twilio Messaging Service with a `persistentAction` array. Twilio detects RCS capability per recipient and falls back to plain SMS silently when unavailable (chips are dropped, text goes through).

```js
sendViaRcs(to, body, buttons)
  if RCS_ENABLED=true → client.messages.create({ ..., persistentAction: buttons })
  else               → sendViaTwilio(to, body)  // plain SMS fallback
```

**`persistentAction` button format:**
```js
["reply:Approve", "reply:Redo", "reply:Cancel"]
```

When tapped, the button label is sent back to the webhook as a plain text message — identical to the stylist typing it. No changes needed to `messageRouter.js` or the inbound webhook handler.

**New env var:** `RCS_ENABLED=true` — gates the feature. Off by default. Enable on staging first, then production.

**Requirements:**
- `TWILIO_MESSAGING_SERVICE_SID` must be set (already in env)
- Messaging Service must have RCS enabled in Twilio Console

---

## The Three Flows

### Flow 1: Consent (Welcome / AGREE)

**File:** wherever the stylist welcome SMS is sent (stylistWelcome.js)

**Current:** Plain text SMS — "Welcome to [Salon]! Reply AGREE to activate..."

**With RCS:**
```
Welcome to [Salon]! Tap Agree below to activate your account and start posting.

  [ Agree ]
```

Tapping **Agree** sends "AGREE" to the webhook → existing consent handler processes it unchanged.

---

### Flow 2: Join (Onboarding conversation)

**File:** `src/core/joinManager.js`

Only steps with a known short answer set get chips. Free-text steps (name, phone) are unchanged.

| Step | Chips added |
|---|---|
| Step 1 — Name | None (free text) |
| Step 2 — Phone | None (free text) |
| Step 3 — Instagram handle | `[ None ]` |
| Step 4 — Specialties | `[ None ]` |

The `sendMessage` callback passed into `joinManager.js` is upgraded to call `sendViaRcs` with chips where applicable. Steps without chips use `sendViaTwilio` as before.

---

### Flow 3: Post Preview

**File:** `src/core/messageRouter.js` (the preview send block around line 586)

**Current:** Plain SMS with portal URL — "Your caption preview is ready! Review here: https://..."

**With RCS:**
```
[Salon Name] — your post is ready!

[caption preview text]

Review or edit here:
https://app.mostlypostly.com/stylist/...

  [ Approve ]  [ Redo ]  [ Cancel ]
```

- **No MMS image attachment** — keeps message size and cost down; the portal URL covers image review
- Tapping **Approve** → sends "APPROVE" → existing handler submits post
- Tapping **Redo** → sends "REDO" → existing handler regenerates caption
- Tapping **Cancel** → sends "CANCEL" → existing handler discards draft
- Clicking the URL → stylist portal → approve button there also submits (no duplicate, same post row)

The portal URL fallback remains for stylists who want to see the image or edit the caption before approving.

---

## Fallback Behavior

Twilio handles RCS capability detection per recipient automatically. When a number doesn't support RCS (older iPhone, non-RCS Android, carrier gap):

- Message body sends as plain SMS
- `persistentAction` chips are silently dropped
- Stylist receives the same text as today and can still type APPROVE / REDO / CANCEL

No user-facing error. No code change needed for the fallback path.

---

## Files Changed

| File | Change |
|---|---|
| `src/routes/twilio.js` | Add `sendViaRcs(to, body, buttons)` export |
| `src/core/stylistWelcome.js` | Upgrade welcome message to `sendViaRcs` with `[ Agree ]` |
| `src/core/joinManager.js` | Add chips on Instagram + specialties steps |
| `src/core/messageRouter.js` | Upgrade preview send block to `sendViaRcs` with `[ Approve ]` `[ Redo ]` `[ Cancel ]` |

## New Env Vars

| Var | Value | Notes |
|---|---|---|
| `RCS_ENABLED` | `true` / unset | Gates all RCS sends. Off by default. |

## Out of Scope (Future)

- RCS Content Template rich cards (inline image in message bubble)
- Before/After carousel card
- Manager approval via RCS
- RCS delivery receipts / read receipts analytics
