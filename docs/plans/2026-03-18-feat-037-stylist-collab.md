# FEAT-037: Stylist Instagram Collaborator Opt-In Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Allow stylists to opt in (via SMS keyword or admin toggle) to be tagged as Instagram collaborators on posts, and fix two caption bugs in `composeFinalCaption.js`.

**Architecture:** Adds `ig_collab` column to `stylists` table. COLLAB/NOCOLLAB SMS keywords set the flag, same dispatch pattern as APPROVE/CANCEL. The Instagram publisher appends `collaborators: [handle]` to the media creation payload only when the flag is set — non-blocking if the API rejects it. Caption bugs are isolated to `composeFinalCaption.js`: "Book in bio" must be IG-only, and blank "Book now" must be suppressed.

**Tech Stack:** better-sqlite3 (sync, no await), Express, Node.js ESM, Vitest

---

## Context You Need

- **DB is synchronous**: `better-sqlite3` — never use `await` on `db.prepare().get()/.run()/.all()`. This is a common mistake that causes silent failures.
- **ESM throughout**: always `import`/`export`, never `require()`.
- **`req.manager.salon_id`**: use this for auth context, never `req.body.salon_id` (IDOR risk).
- **Keyword dispatch pattern** in `messageRouter.js`: early-return keyword blocks before the photo/message routing logic at the bottom. See how `CANCEL`, `WRONG`, and `LEADERBOARD` are handled — each is a simple `if` block that reads `command` or `cleanText`, does a DB write, sends a reply, then `return`s.
- **`composeFinalCaption.js`**: `platform` param is `"instagram"`, `"facebook"`, or `"generic"`. The IG block at line 123 strips URLs and always appends "Book via link in bio." — this must become conditional on whether `booking_url` exists.
- **Test runner**: `npm test` runs vitest. Tests live in `tests/`. Pattern: import the function, write plain assertions. See `tests/vendorHashtags.test.js` for reference.

---

### Task 1: Migration 041 — `ig_collab` column on `stylists`

**Files:**
- Create: `migrations/041_ig_collab.js`
- Modify: `migrations/index.js`

**Step 1: Write the migration file**

```js
// migrations/041_ig_collab.js
export function run(db) {
  const cols = db.prepare(`PRAGMA table_info(stylists)`).all().map(c => c.name);
  if (!cols.includes("ig_collab")) {
    db.prepare(`ALTER TABLE stylists ADD COLUMN ig_collab INTEGER DEFAULT 0`).run();
  }
  console.log("[Migration 041] ig_collab column added to stylists");
}
```

**Step 2: Register in migrations/index.js**

Add at the bottom of the imports:
```js
import { run as run041 } from "./041_ig_collab.js";
```

Add at the bottom of the `migrations` array:
```js
{ name: "041_ig_collab", run: run041 },
```

**Step 3: Verify migration runs without error**

```bash
node -e "import('./db.js').then(m => console.log('DB loaded, migrations ran'))"
```

Expected: No error, `[Migration 041] ig_collab column added to stylists` in output.

**Step 4: Commit**

```bash
git add migrations/041_ig_collab.js migrations/index.js
git commit -m "feat: migration 041 — add ig_collab column to stylists"
```

---

### Task 2: SMS Keyword Handlers — COLLAB / NOCOLLAB

**Files:**
- Modify: `src/core/messageRouter.js`

**Background:** The keyword dispatch section runs from roughly line 775 onward. Keywords are checked against `command` (uppercased first word) or `cleanText` (full message, trimmed+uppercased). These handlers must:
1. Look up the stylist by `chatId` (already in scope as `stylist`)
2. Update `stylists.ig_collab` by stylist phone (since `chatId` is the phone number for SMS)
3. Reply with a confirmation
4. Return early

**Step 1: Find the right insertion point**

Open `src/core/messageRouter.js`. Find the `// CANCEL` block around line 775. The new COLLAB/NOCOLLAB blocks go **before** the `// JOIN` block (around line 855) and **after** `// WRONG`. Place them in alphabetical order doesn't matter — just keep them before the APPROVE block.

**Step 2: Add COLLAB / NOCOLLAB handlers**

Insert this block after the `// WRONG` block and before `// LEADERBOARD`:

```js
// COLLAB — opt in to IG collaborator tagging
if (command === "COLLAB") {
  try {
    db.prepare(`UPDATE stylists SET ig_collab = 1 WHERE phone = ?`).run(chatId);
    await sendMessage.sendText(chatId,
      "You're in! You'll be tagged as a collaborator on your posts going forward. " +
      "You'll get an Instagram notification each time — just tap Accept and it'll show up on your profile too. " +
      "Text NOCOLLAB anytime to turn it off."
    );
  } catch (err) {
    console.error("[Router] COLLAB update failed:", err.message);
    await sendMessage.sendText(chatId, "Sorry, couldn't update your settings. Try again in a moment.");
  }
  endTimer(start);
  return;
}

// NOCOLLAB — opt out of IG collaborator tagging
if (command === "NOCOLLAB") {
  try {
    db.prepare(`UPDATE stylists SET ig_collab = 0 WHERE phone = ?`).run(chatId);
    await sendMessage.sendText(chatId,
      "Got it — collaborator tagging is off. Text COLLAB anytime to turn it back on."
    );
  } catch (err) {
    console.error("[Router] NOCOLLAB update failed:", err.message);
    await sendMessage.sendText(chatId, "Sorry, couldn't update your settings. Try again in a moment.");
  }
  endTimer(start);
  return;
}
```

**Step 3: Verify the file loads**

```bash
node --input-type=module <<'EOF'
import "./src/core/messageRouter.js";
console.log("messageRouter loaded OK");
EOF
```

Expected: `messageRouter loaded OK` (or the usual startup logs — no `SyntaxError`).

**Step 4: Commit**

```bash
git add src/core/messageRouter.js
git commit -m "feat: COLLAB/NOCOLLAB SMS keywords for IG collaborator opt-in"
```

---

### Task 3: Welcome SMS — mention COLLAB keyword

**Files:**
- Modify: `src/core/stylistWelcome.js`

**Background:** Two message paths in `sendWelcomeSms`:
- No consent yet (`!hasConsent`): RCS consent message
- Already consented: quick-start message

Both should mention COLLAB. The design says to add it as a tip line.

**Step 1: Update the no-consent message**

The current no-consent RCS message ends with `"Tap Agree below or reply AGREE to get started..."`. Add COLLAB tip after the watch URL line:

```js
// Before:
`🎬 See how it works: ${WATCH_URL}\n\n` +
`Tap Agree below or reply AGREE to get started. Reply STOP to opt out. Msg & data rates may apply.`,

// After:
`🎬 See how it works: ${WATCH_URL}\n\n` +
`💡 Tip: Text COLLAB to have your work show up on your personal Instagram too.\n\n` +
`Tap Agree below or reply AGREE to get started. Reply STOP to opt out. Msg & data rates may apply.`,
```

**Step 2: Update the already-consented message**

The current message ends with `📸 Tip: Always send camera photos...`. Add COLLAB tip after the MENU line:

```js
// Before:
`Text MENU anytime to see everything you can do.\n\n` +
`📸 Tip: Always send camera photos, not screenshots — they process fastest!`

// After:
`Text MENU anytime to see everything you can do.\n\n` +
`💡 Text COLLAB to have your work show up on your personal Instagram too.\n\n` +
`📸 Tip: Always send camera photos, not screenshots — they process fastest!`
```

**Step 3: Verify file loads**

```bash
node --input-type=module <<'EOF'
import { sendWelcomeSms } from "./src/core/stylistWelcome.js";
console.log("stylistWelcome loaded OK");
EOF
```

**Step 4: Commit**

```bash
git add src/core/stylistWelcome.js
git commit -m "feat: mention COLLAB keyword in welcome SMS"
```

---

### Task 4: Admin Toggle — `ig_collab` checkbox on stylist edit form

**Files:**
- Modify: `src/routes/stylistManager.js`

**Background:** The `buildStylistForm` function renders the edit form HTML. The `POST /edit/:id` handler saves changes. Both need updating.

**Step 1: Add the checkbox to the edit form**

In `buildStylistForm`, find the `<!-- Auto-approve -->` checkbox block (around line 1038). Add the new `ig_collab` checkbox immediately after it, before the `<!-- Submit -->` block:

```js
// After the auto_approve checkbox div, before <!-- Submit -->:
        <!-- IG Collaborator -->
        <div class="flex items-start gap-2">
          <input type="checkbox" name="ig_collab" value="1" id="ig_collab_check"
                 ${s.ig_collab ? "checked" : ""}
                 ${!s.instagram_handle ? "disabled" : ""}
                 class="mt-0.5 h-4 w-4 rounded border-mpBorder text-mpAccent ${!s.instagram_handle ? "opacity-40 cursor-not-allowed" : ""}" />
          <div>
            <label for="ig_collab_check" class="text-xs ${!s.instagram_handle ? "text-mpBorder cursor-not-allowed" : "text-mpMuted"}">
              Tag as Instagram Collaborator
            </label>
            <p class="text-[11px] text-mpMuted mt-0.5">
              ${!s.instagram_handle
                ? "Set an Instagram handle first to enable collaborator tagging."
                : "Posts published to Instagram will invite this stylist as a collaborator. They'll receive an in-app notification to accept."}
            </p>
          </div>
        </div>
```

**Step 2: Update POST /edit/:id to read and save ig_collab**

In the destructure at the top of `router.post("/edit/:id", ...)` (around line 544), add `ig_collab`:

```js
const { first_name, last_name, phone, instagram_handle, tone_variant,
        birthday_mmdd, hire_date, bio, profile_url, celebrations_enabled,
        auto_approve, ig_collab } = req.body;
```

In the `UPDATE stylists SET` query (around line 560), add the column:

```js
db.prepare(`
  UPDATE stylists SET
    name = ?, first_name = ?, last_name = ?, phone = ?,
    instagram_handle = ?, tone_variant = ?,
    birthday_mmdd = ?, hire_date = ?,
    specialties = ?, bio = ?, profile_url = ?,
    photo_url = ?, celebrations_enabled = ?, auto_approve = ?,
    ig_collab = ?
  WHERE id = ? AND salon_id = ?
`).run(
  name, first_name || null, last_name || null, normalizePhone(phone),
  instagram_handle || null, tone_variant || null,
  normalizeBirthday(birthday_mmdd), hire_date || null,
  specialties, bio || null, profile_url || null,
  photo_url, celebrations_enabled === "1" ? 1 : 0,
  auto_approve === "1" ? 1 : 0,
  ig_collab === "1" ? 1 : 0,
  req.params.id, salon_id,
);
```

Note: `ig_collab` is the last value before the WHERE params (`req.params.id`, `salon_id`).

**Step 3: Verify the file loads**

```bash
node --input-type=module <<'EOF'
import "./src/routes/stylistManager.js";
console.log("stylistManager loaded OK");
EOF
```

**Step 4: Manual smoke test**

Navigate to Team → Edit Stylist for a stylist without an `instagram_handle`. The checkbox should appear disabled with helper text "Set an Instagram handle first...". Set a handle, save, re-open — checkbox should be enabled and unchecked.

**Step 5: Commit**

```bash
git add src/routes/stylistManager.js
git commit -m "feat: ig_collab admin toggle on stylist edit form"
```

---

### Task 5: Instagram Publisher — `collaborators` field

**Files:**
- Modify: `src/publishers/instagram.js`
- Create: `tests/igCollaborator.test.js`

**Background:** `createIgMedia()` currently sends `image_url`, `caption`, and `access_token` as URLSearchParams. We need to add `collaborators` when the stylist has opted in. However, `collaborators` is an array and `URLSearchParams` can't represent arrays natively — the Instagram Graph API accepts repeated keys: `collaborators=handle1&collaborators=handle2`. Use `.append()` for array values.

The publish flow: `publishToInstagram()` calls `createIgMedia()`. The stylist lookup needs a `stylist_id` on the post. Look at what `publishToInstagram` receives in the `input` object — the `post` row is NOT currently passed, but `salon_id` is. We need to also pass `stylist_id` (already on the `posts` row).

Check how `publishToInstagram` is called — search the scheduler for the call site.

**Step 1: Check how publishToInstagram is called**

```bash
grep -n "publishToInstagram" src/scheduler.js
```

Note what params are passed. The scheduler passes the `post` row fields. Check if `stylist_id` is in there.

**Step 2: Write the failing test first**

Create `tests/igCollaborator.test.js`:

```js
// tests/igCollaborator.test.js
import { describe, it, expect, vi } from "vitest";

// We test the collaborator lookup logic in isolation — not the full publish flow
// (which requires real FB credentials).

describe("IG collaborator field logic", () => {
  it("includes handle when ig_collab=1 and handle exists", () => {
    const stylist = { ig_collab: 1, instagram_handle: "@janedoe" };
    const collaborators = buildCollaborators(stylist);
    expect(collaborators).toEqual(["janedoe"]);
  });

  it("strips leading @ from handle", () => {
    const stylist = { ig_collab: 1, instagram_handle: "@janedoe" };
    const collaborators = buildCollaborators(stylist);
    expect(collaborators[0]).toBe("janedoe");
  });

  it("returns undefined when ig_collab=0", () => {
    const stylist = { ig_collab: 0, instagram_handle: "janedoe" };
    expect(buildCollaborators(stylist)).toBeUndefined();
  });

  it("returns undefined when handle is empty", () => {
    const stylist = { ig_collab: 1, instagram_handle: "" };
    expect(buildCollaborators(stylist)).toBeUndefined();
  });

  it("returns undefined when stylist is null", () => {
    expect(buildCollaborators(null)).toBeUndefined();
  });
});

// ── Helper (mirrors what we'll export from instagram.js) ──────────────────
function buildCollaborators(stylist) {
  if (!stylist?.ig_collab || !stylist?.instagram_handle) return undefined;
  const handle = stylist.instagram_handle.replace(/^@/, "").trim();
  if (!handle) return undefined;
  return [handle];
}
```

**Step 3: Run the test (expect it to pass since it's pure logic)**

```bash
npm test -- tests/igCollaborator.test.js
```

Expected: 5 passing.

**Step 4: Export `buildCollaborators` from instagram.js**

In `src/publishers/instagram.js`, add the exported helper after the imports:

```js
/**
 * Build the collaborators array for IG media creation.
 * Returns an array with the handle (without @) if the stylist is opted in,
 * or undefined if not (undefined fields are omitted from the payload).
 */
export function buildCollaborators(stylist) {
  if (!stylist?.ig_collab || !stylist?.instagram_handle) return undefined;
  const handle = stylist.instagram_handle.replace(/^@/, "").trim();
  if (!handle) return undefined;
  return [handle];
}
```

**Step 5: Update `createIgMedia` to accept and send `collaborators`**

Change the function signature and body:

```js
async function createIgMedia({ userId, imageUrl, caption, token, graphVer, collaborators }) {
  const url = `https://graph.facebook.com/${graphVer}/${userId}/media`;
  const params = new URLSearchParams({
    image_url: imageUrl,
    caption: caption || "",
    access_token: token,
  });
  if (collaborators?.length) {
    for (const handle of collaborators) {
      params.append("collaborators", handle);
    }
  }
  const resp = await fetch(url, { method: "POST", body: params });
  const data = await resp.json();
  if (!resp.ok || !data?.id) {
    throw new Error(
      `IG media create failed: ${resp.status} ${JSON.stringify(data)}`
    );
  }
  return data.id;
}
```

**Step 6: Update `publishToInstagram` to look up stylist and pass collaborators**

In `publishToInstagram(input)`, add `stylist_id` to the destructure and add a stylist lookup + non-blocking collaborator logic:

```js
export async function publishToInstagram(input) {
  const { salon_id, caption, imageUrl, imageUrls, stylist_id } = input;

  // Route to carousel if multiple images provided
  const allUrls = imageUrls?.length ? imageUrls : (imageUrl ? [imageUrl] : []);
  if (allUrls.length > 1) {
    return publishToInstagramCarousel({ salon_id, caption, imageUrls: allUrls });
  }

  if (!salon_id || salon_id === "global") {
    throw new Error("Instagram publish called without a valid salon_id");
  }

  console.log(`📷 [Instagram] Start publish for salon_id=${salon_id}`);

  // ── Collaborator lookup ──────────────────────────────────────────────
  let collaborators;
  if (stylist_id) {
    try {
      const stylist = db.prepare(
        `SELECT instagram_handle, ig_collab FROM stylists WHERE id = ?`
      ).get(stylist_id);
      collaborators = buildCollaborators(stylist);
    } catch (err) {
      console.warn("[Instagram] Collaborator lookup failed, continuing without:", err.message);
    }
  }

  // ... rest of existing caption normalization and credential resolution ...
```

Then update the `createIgMedia` call inside the try block to pass `collaborators`:

```js
  try {
    let creationId;
    try {
      creationId = await retryIg(
        () =>
          createIgMedia({
            userId,
            imageUrl: publicImageUrl,
            caption: igCaption,
            token,
            graphVer,
            collaborators,
          }),
        "media create"
      );
    } catch (err) {
      // If error mentions collaborators, retry without them (non-blocking)
      if (collaborators && /collaborator/i.test(err.message)) {
        console.warn("[Instagram] Collaborator tag rejected, retrying without:", err.message);
        creationId = await retryIg(
          () =>
            createIgMedia({
              userId,
              imageUrl: publicImageUrl,
              caption: igCaption,
              token,
              graphVer,
            }),
          "media create (no collab)"
        );
      } else {
        throw err;
      }
    }

    await waitForContainer(creationId, token, graphVer);
    // ... rest unchanged ...
```

**Step 7: Update the test to import from the real file**

Update `tests/igCollaborator.test.js` to import `buildCollaborators` from the publisher instead of defining it locally:

```js
import { buildCollaborators } from "../src/publishers/instagram.js";

// Remove the local buildCollaborators function at the bottom
```

**Step 8: Run the tests**

```bash
npm test -- tests/igCollaborator.test.js
```

Expected: 5 passing.

**Step 9: Check the scheduler call site**

```bash
grep -n "publishToInstagram\|stylist_id" src/scheduler.js | head -20
```

If `stylist_id` is not being passed to `publishToInstagram`, find where the call is made and add it to the object spread. The `posts` row already has `stylist_id` — it just needs to be forwarded.

**Step 10: Commit**

```bash
git add src/publishers/instagram.js tests/igCollaborator.test.js
git commit -m "feat: add collaborators field to IG media creation (non-blocking)"
```

---

### Task 6: Caption Bug Fix — `composeFinalCaption.js`

**Files:**
- Modify: `src/core/composeFinalCaption.js`
- Create: `tests/composeFinalCaption.test.js`

**Background — two bugs:**

**Bug 1** — "Book via link in bio" on Facebook posts:
The IG block (line 123) always appends `"\n\nBook via link in bio."`. But `composeFinalCaption` is also called for Facebook. Wait — look more carefully. The IG block is only entered when `platform === "instagram"`. So "Book via link in bio" should not appear on Facebook. Check if the issue is that `composeFinalCaption` is called with `platform = "generic"` for Facebook. If so, the bug is at line 116: `if (booking) parts.push(`Book: ${booking}`);` — this shows the booking URL for all platforms including IG (before the IG block strips it). The "Book in bio" text that shows on Facebook may be coming from the existing `booking_url` being rendered as `Book: https://...` on Facebook, combined with a "Book in bio" being written into the AI caption or CTA.

More likely: the `platform` param is not being set to `"facebook"` when composing FB captions — it defaults to `"generic"` and the `parts` array already contains a raw booking URL line. The fix is to ensure the **calling code** passes `platform: "facebook"` for FB captions and that `composeFinalCaption` does NOT append "Book via link in bio" on any non-IG platform.

**Bug 2** — Blank "Book now" on IG:
The IG block at line 130–132 unconditionally appends `"\n\nBook via link in bio."` even when there's no booking URL. When `booking_url` is null/empty, the salon has no booking link so we should NOT show the CTA at all. Fix: only append if `booking` (the `bookingUrl` param) is truthy.

**Step 1: Write failing tests first**

Create `tests/composeFinalCaption.test.js`:

```js
// tests/composeFinalCaption.test.js
import { describe, it, expect } from "vitest";
import { composeFinalCaption } from "../src/core/composeFinalCaption.js";

const base = {
  caption: "Beautiful balayage",
  stylistName: "Jane",
  hashtags: [],
  salon: {},
};

describe("composeFinalCaption — Book in bio IG-only", () => {
  it("IG with booking_url includes Book via link in bio", () => {
    const result = composeFinalCaption({
      ...base,
      platform: "instagram",
      bookingUrl: "https://example.com/book",
    });
    expect(result).toContain("Book via link in bio.");
  });

  it("IG without booking_url does NOT include Book via link in bio", () => {
    const result = composeFinalCaption({
      ...base,
      platform: "instagram",
      bookingUrl: "",
    });
    expect(result).not.toContain("Book via link in bio.");
    expect(result).not.toContain("Book now");
  });

  it("Facebook does NOT include Book via link in bio", () => {
    const result = composeFinalCaption({
      ...base,
      platform: "facebook",
      bookingUrl: "https://example.com/book",
    });
    expect(result).not.toContain("Book via link in bio.");
    expect(result).toContain("https://example.com/book");
  });

  it("Facebook without booking_url has no booking section", () => {
    const result = composeFinalCaption({
      ...base,
      platform: "facebook",
      bookingUrl: "",
    });
    expect(result).not.toContain("Book");
  });
});
```

**Step 2: Run the tests (expect failures)**

```bash
npm test -- tests/composeFinalCaption.test.js
```

Expected: some failures confirming the bugs exist.

**Step 3: Fix composeFinalCaption.js**

The current IG block (lines 123–136):

```js
if (platform === "instagram") {
  let captionOut = parts.join("\n\n");
  captionOut = captionOut.replace(/https?:\/\/\S+/gi, "").trim();
  if (!captionOut.includes("Book via link in bio.")) {
    captionOut += `\n\nBook via link in bio.`;
  }
  return captionOut;
}
```

Replace with:

```js
if (platform === "instagram") {
  let captionOut = parts.join("\n\n");
  // Remove all URLs (IG doesn't render clickable links)
  captionOut = captionOut.replace(/https?:\/\/\S+/gi, "").trim();
  // Only add "Book via link in bio" when a booking URL is actually configured
  if (booking && !captionOut.includes("Book via link in bio.")) {
    captionOut += `\n\nBook via link in bio.`;
  }
  return captionOut;
}
```

Note: `booking` is already in scope from line 74: `const booking = (bookingUrl || "").trim();`

**Step 4: Run the tests (expect all to pass)**

```bash
npm test -- tests/composeFinalCaption.test.js
```

Expected: 4 passing.

**Step 5: Run all tests to check for regressions**

```bash
npm test
```

Expected: all passing.

**Step 6: Commit**

```bash
git add src/core/composeFinalCaption.js tests/composeFinalCaption.test.js
git commit -m "fix: Book in bio IG-only, suppress blank Book CTA when no booking URL"
```

---

### Task 7: Push to dev and main, update docs

**Step 1: Ensure all tests pass**

```bash
npm test
```

Expected: all tests passing.

**Step 2: Push to main (auto-deploys to production)**

```bash
git push origin main
```

**Step 3: Push to dev**

```bash
git push origin main:dev
```

**Step 4: Update FEATURES.md**

Open `/Users/troyhardister/chairlyos/mostlypostly/FEATURES.md`. Find the FEAT-037 row and update status from `in_progress` to `done`.

**Step 5: Update CLAUDE.md schema section**

Open `/Users/troyhardister/chairlyos/mostlypostly/CLAUDE.md`. In the `### stylists` table section, add:

```
| ig_collab | 0 = not opted in (default), 1 = opted in to IG collaborator tagging (migration 041) |
```

**Step 6: Commit docs**

```bash
cd /Users/troyhardister/chairlyos/mostlypostly
git add FEATURES.md CLAUDE.md
git commit -m "docs: mark FEAT-037 done, update CLAUDE.md schema"
```

**Step 7: Verify Render deploy succeeds**

Check `https://app.mostlypostly.com` loads. Render will auto-deploy from `main` within a few minutes.
