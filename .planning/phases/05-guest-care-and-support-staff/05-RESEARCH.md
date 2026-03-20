# Phase 5: Guest Care and Support Staff - Research

**Researched:** 2026-03-20
**Domain:** Coordinator SMS posting, stylist attribution, leaderboard extension
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**How Coordinators Submit Posts**
- Both SMS and portal — coordinator can text photos from their phone OR upload via the portal
- SMS flow (name present): Coordinator texts a photo with caption mentioning a stylist name → GPT extracts the stylist name → system fuzzy-matches against salon's stylists → coordinator receives a portal link to confirm the match → post enters the standard approval queue under the matched stylist's name
- SMS flow (no name found): Single SMS reply: "Who is this for?" — coordinator replies with the stylist name, then the flow continues as above. One SMS only — not a back-and-forth.
- Portal upload: Coordinator can also upload a photo directly in the portal with a stylist dropdown to select attribution up front
- Minimize SMS round-trips: The name-in-text approach is the primary path; the "Who is this for?" fallback fires only when no stylist name can be extracted

**Stylist Attribution in Portal**
- Portal approval card: Stylist dropdown at the TOP of the card (before the caption), pre-filled with the GPT-extracted match
- Coordinator confirms or changes the attributed stylist before the post is submitted
- Manager approval view: Small badge on post cards: "Submitted by [Coordinator Name] on behalf of [Stylist]" — visible in both the approval queue and the Database view
- Manager can still change the attributed stylist from the manager approval view

**Data Model**
- New column on `posts` table: `submitted_by` (FK → managers.id) — set when a coordinator submits via SMS or portal; NULL for stylist-submitted posts
- `stylist_name` on the post remains the attributed stylist (the one featured) — no change to how the existing leaderboard query works
- Coordinator's phone number stored in `managers.phone` — used for Twilio routing; phone is REQUIRED when creating a coordinator

**Points Scoring — 50/50 Split**
- Stylist leaderboard (existing): Unchanged — points computed from `posts.stylist_name` as today; coordinator-submitted posts still appear under the stylist's name for full credit
- Coordinator leaderboard (new): Coordinators earn 50% of the base post point value for every post they submit (`submitted_by = coordinator.id`). Computed in a new `getCoordinatorLeaderboard()` function in `gamification.js`
- Example: standard_post = 10 pts; stylist gets 10 pts in stylist leaderboard, coordinator gets 5 pts in coordinator leaderboard

**Flood Protection**
- Visual warning only — no hard block
- When a coordinator selects a stylist in the portal approval flow, if more than 3 coordinator-submitted posts for that stylist exist in the last 7 days, show an inline warning
- Threshold: 3 posts per stylist per 7-day rolling window

**Leaderboard UI**
- Tab toggle on the existing Performance page (`/manager/performance`) — "Stylists" tab (existing) and "Coordinators" tab (new)
- Coordinator leaderboard shows: rank, name, posts submitted, points earned
- Coordinators see this page (verify it is visible in their nav)

**Welcome SMS for Coordinators**
- Phone number is required when adding a coordinator (validation in the add form)
- Welcome SMS text: "You've been added as a coordinator at [Salon]. To post for a stylist, text a photo and include their name (e.g. 'Taylor did this color'). Reply HELP for guidance."
- New exported function `sendCoordinatorWelcomeSms(coordinator, salonName)` in `src/core/stylistWelcome.js`
- Called after coordinator row is inserted in `stylistManager.js`

### Claude's Discretion
- GPT model for stylist name extraction (GPT-4o-mini is sufficient — same pattern as Reputation Manager review name extraction)
- Fuzzy matching threshold for stylist name — exact implementation
- Flood protection threshold (default: 3 posts per 7 days)
- Whether to create a new migration or add `submitted_by` to the existing posts migration

### Deferred Ideas (OUT OF SCOPE)
- Coordinator "who to photograph next" recommendations — coordinator sees a suggestion in their portal: "Mia hasn't had a post this week — consider capturing her work." New capability, worth building in a follow-up phase or quick task.
</user_constraints>

---

## Summary

Phase 5 adds a coordinator SMS posting path on top of the existing manager infrastructure. The coordinator role already exists in the `managers` table; what is missing is: (1) the SMS routing branch to detect an incoming message from a coordinator's phone and trigger a coordinator-specific flow, (2) GPT-based stylist name extraction from message text, (3) a `submitted_by` FK column on `posts`, (4) a coordinator leaderboard tab on the Performance page, (5) a flood-protection warning in the portal attribution UI, and (6) a coordinator welcome SMS.

The implementation is additive, not destructive. The existing stylist leaderboard, manager approval flow, and stylist portal are unchanged except for small targeted additions (badge, dropdown, tab toggle). The highest-risk piece is the SMS routing change in `messageRouter.js` — the coordinator branch must fire before the standard stylist path and must not break any existing stylist flows.

**Primary recommendation:** Build in four discrete waves: (1) DB migration + `submitted_by` wiring in `savePost`, (2) SMS coordinator routing and GPT name extraction, (3) coordinator portal approval UI (dropdown + flood warning), (4) coordinator leaderboard tab + welcome SMS.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | existing | `submitted_by` column migration + all DB queries | Already the project DB layer — synchronous, no await |
| openai (GPT-4o-mini) | existing | Stylist name extraction from message text | Same model used for other extraction tasks in this codebase |
| express | existing | Portal route additions in `stylistPortal.js` and `stylistManager.js` | Already the web framework |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| crypto (Node built-in) | built-in | Portal token generation | Used in messageRouter.js today for same purpose |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| GPT-4o-mini for name extraction | Regex / Levenshtein only | GPT handles informal phrasing ("Taylor did this beautiful...") far better; regex is brittle for natural language |
| New migration file | In-place schema change | New migration file is the established project pattern — always add a numbered file |

**Installation:** No new packages needed. All dependencies are already installed.

---

## Architecture Patterns

### Recommended Project Structure

No new files needed beyond adding exports to existing modules. New logic goes in:

```
src/
├── core/
│   ├── gamification.js     # + getCoordinatorLeaderboard()
│   ├── messageRouter.js    # + coordinator SMS branch
│   ├── stylistWelcome.js   # + sendCoordinatorWelcomeSms()
│   └── storage.js          # submitted_by threaded through savePost()
├── routes/
│   ├── stylistManager.js   # + phone required for coordinator, welcome SMS call
│   ├── stylistPortal.js    # + stylist dropdown + flood warning for coordinator portals
│   ├── teamPerformance.js  # + ?view=coordinators tab
│   └── manager.js          # + "submitted by" badge on post cards
migrations/
└── 049_coordinator_submitted_by.js   # submitted_by column on posts
```

### Pattern 1: Coordinator Branch in messageRouter.js

The existing video branch (`isVideo` detection, `pendingVideoDescriptions` Map, early-return branching) shows the exact pattern to follow. Coordinator routing uses the same structure:

1. After `lookupStylist(chatId)` resolves, check if the returned record is a coordinator (`stylist.role === 'manager'` AND a DB lookup confirms `managers.role = 'coordinator'`).
2. If coordinator: enter coordinator branch, skip all standard stylist logic.
3. Coordinator branch: attempt GPT name extraction → fuzzy match → if match found, build portal link. If no match, send "Who is this for?" SMS and store pending in a `pendingCoordinatorPosts` Map (same TTL pattern as `pendingVideoDescriptions`).
4. "Who is this for?" reply: detect coordinator + no-image text + pending entry → use text as stylist name, continue with match flow.

**Key insight from existing code:** `lookupStylist()` already checks `managers` table (line 242–275 in `salonLookup.js`) and sets `isManager = true` when found there. It returns `role: "manager"` generically. The coordinator branch must additionally query `managers.role` to distinguish coordinator from manager/owner/staff.

```javascript
// Pattern: detect coordinator after lookupStylist()
// Source: salonLookup.js lookupStylist() + pageShell.js isCoordinator pattern
const result = lookupStylist(chatId);
if (result?.stylist?.manager_id) {
  const mgrRow = db.prepare("SELECT role FROM managers WHERE id = ?")
    .get(result.stylist.manager_id || result.stylist.id);
  if (mgrRow?.role === 'coordinator') {
    // → coordinator branch
  }
}
```

### Pattern 2: GPT Stylist Name Extraction

The CONTEXT.md references Reputation Manager (Phase 4) as the canonical pattern, but Phase 4 code is not yet implemented. Use the existing `openai.js` / `generateCaption` call pattern as a model. For name extraction, call GPT-4o-mini with a simple system prompt and return JSON.

```javascript
// Source: existing openai.js pattern (generateCaption)
// Adapted for name extraction — single focused prompt, gpt-4o-mini
async function extractStylistName(messageText, salonId) {
  const stylists = db.prepare(
    "SELECT name, first_name, last_name FROM stylists WHERE salon_id = ?"
  ).all(salonId);
  const names = stylists.map(s => s.first_name || s.name.split(" ")[0]);

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Extract a stylist first name from the message. Known stylists: ${names.join(", ")}. Return JSON: {"name": "Taylor" | null}`
      },
      { role: "user", content: messageText }
    ],
    response_format: { type: "json_object" },
    max_tokens: 50,
  });
  const parsed = JSON.parse(response.choices[0].message.content);
  return parsed.name || null;
}
```

### Pattern 3: Fuzzy Matching

Use case-insensitive first-name comparison as primary match. Fall back to `includes()` / Levenshtein distance for partial matches. Keep it simple — this is not a high-ambiguity domain. Salon stylists typically have distinct first names.

```javascript
// Source: established project pattern — no external library needed
function fuzzyMatchStylist(extractedName, stylists) {
  if (!extractedName) return null;
  const lower = extractedName.toLowerCase().trim();

  // Exact first-name match
  const exact = stylists.find(s => {
    const first = (s.first_name || s.name.split(" ")[0]).toLowerCase();
    return first === lower;
  });
  if (exact) return exact;

  // Prefix match (handles "Tay" for "Taylor")
  const prefix = stylists.find(s => {
    const first = (s.first_name || s.name.split(" ")[0]).toLowerCase();
    return first.startsWith(lower) || lower.startsWith(first);
  });
  return prefix || null;
}
```

### Pattern 4: Coordinator Leaderboard

`getCoordinatorLeaderboard(salonId, period)` in `gamification.js` mirrors `getLeaderboard()` but groups by `submitted_by` (FK to managers) rather than `stylist_name`. Points are `getPointValue(salonId, post_type) * 0.5`.

```javascript
// Source: gamification.js getLeaderboard() — adapted for coordinators
export function getCoordinatorLeaderboard(salonId, period = "month") {
  const pf = periodFilter(period);  // reuse existing helper

  const posts = db.prepare(`
    SELECT m.name AS coordinator_name, p.post_type, COUNT(*) AS cnt
    FROM posts p
    JOIN managers m ON m.id = p.submitted_by
    WHERE p.salon_id = ?
      AND p.status = 'published'
      AND p.submitted_by IS NOT NULL
      ${pf}
    GROUP BY p.submitted_by, p.post_type
    ORDER BY m.name
  `).all(salonId);

  const map = new Map();
  for (const row of posts) {
    const name = row.coordinator_name;
    if (!map.has(name)) map.set(name, { name, points: 0, post_count: 0 });
    const entry = map.get(name);
    const pts = Math.round(getPointValue(salonId, row.post_type) * 0.5) * row.cnt;
    entry.points += pts;
    entry.post_count += row.cnt;
  }

  const coordinators = [...map.values()];
  coordinators.sort((a, b) => b.points - a.points);
  let rank = 1;
  for (let i = 0; i < coordinators.length; i++) {
    if (i > 0 && coordinators[i].points < coordinators[i - 1].points) rank = i + 1;
    coordinators[i].rank = rank;
  }
  return coordinators;
}
```

### Pattern 5: Flood Warning Query

The flood check is a single synchronous DB query — no async needed (better-sqlite3 convention).

```javascript
// Source: better-sqlite3 synchronous pattern (all DB calls in this project)
function getCoordinatorPostCountForStylist(salonId, submittedBy, stylistName) {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM posts
    WHERE salon_id = ?
      AND submitted_by = ?
      AND stylist_name = ?
      AND created_at >= datetime('now', '-7 days')
  `).get(salonId, submittedBy, stylistName);
  return row?.cnt || 0;
}
```

### Pattern 6: Tab Toggle UI

The Performance page tab toggle uses a query param (`?view=coordinators`). The existing period tabs (`?period=week`) demonstrate the exact rendering pattern to replicate.

```html
<!-- Mirrors the period tab rendering pattern in teamPerformance.js -->
<div class="mb-5 flex gap-2">
  <a href="?view=stylists&period=..." class="px-4 py-1.5 rounded-full text-xs font-semibold ...">
    Stylists
  </a>
  <a href="?view=coordinators&period=..." class="...">
    Coordinators
  </a>
</div>
```

### Anti-Patterns to Avoid

- **await on DB calls:** `better-sqlite3` is synchronous. Never `await db.prepare(...).get(...)`.
- **Trusting user-supplied salon_id:** Always use `req.session.salon_id` or the coordinator's DB-resolved `salon_id`, never a request body value.
- **Breaking the stylist portal token flow:** The coordinator portal confirmation link uses the same `stylist_portal_tokens` table and same `validateToken` middleware as the stylist flow — do not create a separate token system.
- **Modifying `getLeaderboard()`:** The stylist leaderboard must remain unchanged. The coordinator leaderboard is a new parallel function, not a modification.
- **Hard-blocking coordinator post volume:** The decision is a visual warning only — no DB-enforced cap.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Phone number normalization | Custom normalize fn | `normalizePhone()` already in `stylistManager.js` and `salonLookup.js` | Already handles all edge cases (+1, 10-digit, 11-digit) |
| Portal token creation | Custom token logic | Existing `crypto.randomBytes(32).toString("hex")` + `stylist_portal_tokens` table insert in `messageRouter.js` | Same pattern used in 3 places; consistent |
| Period filtering in leaderboard | New SQL helper | `periodFilter(period)` already exported from `gamification.js` | Already handles week/month/quarter/year/all |
| SMS sending | Direct Twilio API | `sendViaTwilio()` from `twilio.js` | Rate limiting, error handling, RCS fallback already managed |
| Welcome SMS structure | New SMS builder | Follow `sendWelcomeSms()` pattern in `stylistWelcome.js` | Consistent format; RCS chip support |

**Key insight:** Nearly every primitive needed for this phase already exists. The work is wiring, not inventing.

---

## Common Pitfalls

### Pitfall 1: Coordinator Detection Order in messageRouter

**What goes wrong:** If coordinator detection happens after the standard stylist path, coordinator phones are treated as managers (existing behavior: manager phone → `isManager = true` in `lookupStylist`) and the coordinator branch never fires.

**Why it happens:** `lookupStylist()` already handles manager phone lookups and sets `isManager: true`. Without checking `managers.role`, coordinators are indistinguishable from regular managers at the router level.

**How to avoid:** After `lookupStylist()` resolves a manager record (`stylist.manager_id` is set), immediately query `managers.role`. If `role === 'coordinator'`, route to coordinator branch before any manager-path logic.

**Warning signs:** Coordinator texts photo → gets no response (falls into manager path which doesn't handle SMS posting).

### Pitfall 2: pending coordinator state lost on server restart

**What goes wrong:** The "Who is this for?" pending state (waiting for coordinator to reply with a stylist name) is in-memory (Map). Server restart clears it. Coordinator replied with name but server restarted — reply goes unmatched.

**Why it happens:** Same as `pendingVideoDescriptions` — in-memory Maps don't survive restarts.

**How to avoid:** Follow the same pattern already used for `pendingVideoDescriptions` (Map with TTL). Accept this limitation — it is consistent with existing behavior and acceptable per the existing pattern in this codebase.

**Warning signs:** Coordinator texts "Who is this for?" reply but nothing happens. Coach coordinators that if response times out, just text the photo again with the name included.

### Pitfall 3: stylist_name vs coordinator attribution confusion

**What goes wrong:** Post's `stylist_name` is overwritten with the coordinator's name instead of the attributed stylist's name.

**Why it happens:** `savePost()` takes `stylist.stylist_name` as the name to store. If the coordinator's identity object is passed directly, the coordinator's name ends up in `stylist_name`.

**How to avoid:** When saving a coordinator-submitted post, construct the payload with `stylist_name` set to the **matched stylist's name** (not the coordinator's name), and pass `submitted_by: coordinator.manager_id` as an additional field. The coordinator identity is only stored in `submitted_by`.

**Warning signs:** Stylist leaderboard shows coordinator name; posts appear under wrong person.

### Pitfall 4: savePost() does not accept submitted_by yet

**What goes wrong:** `savePost()` in `storage.js` does not currently include `submitted_by` in its INSERT statement. If passed in the payload, it is silently dropped.

**Why it happens:** `insertPostStmt` in `storage.js` was written before coordinator support existed. The column does not exist yet (migration 049 adds it).

**How to avoid:** Two-part fix: (1) migration 049 adds `submitted_by TEXT REFERENCES managers(id)` to posts table, (2) update `insertPostStmt` in `storage.js` to include the column. Or use a separate direct DB insert in the coordinator flow rather than `savePost()` — but modifying `savePost()` to accept `submitted_by` is cleaner.

**Warning signs:** `submitted_by` is always NULL in posts table; coordinator leaderboard shows nothing.

### Pitfall 5: Coordinator visible in Performance page nav check

**What goes wrong:** Coordinator can't see the Performance page because `isCoordinator` gate in `pageShell.js` blocks it.

**Why it happens:** `pageShell.js` hides nav items with `!isCoordinator` guard. The Performance nav item currently uses `navItem("/manager/performance", ...)` WITHOUT the `!isCoordinator` guard — meaning coordinators CAN see it today (line 157). But this must be verified because the CONTEXT.md flags it as "verify."

**How to avoid:** Read `pageShell.js` line 157 before building — confirmed it does NOT have `!isCoordinator` guard. Performance is already visible to coordinators. No change needed.

**Warning signs:** Coordinator logs in, Performance not in sidebar.

### Pitfall 6: Flood check using wrong stylist identifier

**What goes wrong:** Flood check queries `stylist_name` (a text field), which can have inconsistent casing or formatting.

**Why it happens:** `posts.stylist_name` is a denormalized text field. If the coordinator selects "Taylor" from a dropdown but the DB has "Taylor Johnson", the count query finds 0 matches.

**How to avoid:** In the flood check query, use `stylist_name = ?` with the exact value that will be saved to the post — i.e., use the full name from the matched stylist record, not just the extracted first name.

---

## Code Examples

### Migration 049: Add submitted_by to posts

```javascript
// migrations/049_coordinator_submitted_by.js
export default function up(db) {
  // submitted_by = NULL for stylist-submitted posts; set to managers.id for coordinator-submitted
  db.prepare(`
    ALTER TABLE posts ADD COLUMN submitted_by TEXT REFERENCES managers(id)
  `).run();
}
```

### sendCoordinatorWelcomeSms in stylistWelcome.js

```javascript
// Source: existing sendWelcomeSms() pattern in stylistWelcome.js
export async function sendCoordinatorWelcomeSms(coordinator, salonName) {
  const { name, phone } = coordinator;
  if (!phone) return;

  await sendViaTwilio(
    phone,
    `You've been added as a coordinator at ${salonName}. ` +
    `To post for a stylist, text a photo and include their name ` +
    `(e.g. "Taylor did this color"). Reply HELP for guidance.`
  );
}
```

### Flood warning HTML (coordinator portal)

```html
<!-- Shown above stylist dropdown when count >= 3 -->
<div class="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
  You've posted <strong>{count}</strong> times for {stylist_name} in the last 7 days
  — consider capturing content for other team members too.
</div>
```

### "Submitted by" badge in manager approval view

```html
<!-- Small muted line below post thumbnail — no structural change -->
<p class="text-[11px] text-mpMuted mt-1">
  via {coordinator_name} on behalf of {stylist_name}
</p>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Coordinators had portal access only | Coordinators can post via SMS | Phase 5 | Coordinator phone in managers.phone enables Twilio routing |
| Single leaderboard (stylists) | Two-tab leaderboard (stylists + coordinators) | Phase 5 | New tab; existing tab unchanged |

**Nothing deprecated by this phase.** All changes are additive.

---

## Open Questions

1. **Portal upload flow for coordinators**
   - What we know: CONTEXT.md says "Coordinator can also upload a photo directly in the portal with a stylist dropdown to select attribution up front"
   - What's unclear: Which route handles this? The coordinator portal is the standard manager portal (`/manager`) — there is no separate coordinator upload UI today. This likely means the "Create Post" or new-post form in `manager.js` needs a stylist dropdown that is visible when the logged-in user is a coordinator.
   - Recommendation: Scope this carefully. The planner should clarify whether this is a new "Upload Photo" form in the coordinator's portal view or reuse of an existing route with a selector added.

2. **"Who is this for?" reply disambiguation**
   - What we know: Coordinator replies with a stylist name (plain text, no photo). The pending state is in memory.
   - What's unclear: What if the plain-text reply matches a command (APPROVE, MENU, HELP) or comes in while no pending state exists?
   - Recommendation: The pending coordinator Map check should happen before command processing but only when a pending entry exists. Commands must still be processed normally when no pending entry is present.

3. **Coordinator photo in portal confirmation**
   - What we know: Coordinator receives a portal link to "confirm the match"
   - What's unclear: The stylist portal (`/stylist/:id`) currently uses `validateToken` middleware tied to `stylist_portal_tokens`. When a coordinator receives this link, do they use the same portal as stylists, or is there a distinct coordinator confirmation portal URL?
   - Recommendation: Reuse `stylistPortal.js` with an added `is_coordinator_flow` flag (or detect via `submitted_by` on the post). The existing portal renders the caption and approval UI — adding a stylist dropdown at the top is the only change needed.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | None detected — project has no test infrastructure |
| Config file | none |
| Quick run command | Manual smoke test only |
| Full suite command | Manual smoke test only |

### Phase Requirements → Test Map

Phase 5 requirements are not mapped to REQUIREMENTS.md (per CONTEXT.md: "No external specs — requirements for this phase are fully captured in decisions above"). Manual verification plan below:

| Behavior | Test Type | How to Verify |
|----------|-----------|---------------|
| Coordinator SMS photo → portal link sent | Manual smoke | Text photo from coordinator phone; confirm portal link received |
| GPT extracts stylist name from message text | Manual smoke | Include "Taylor did this" in message; confirm Taylor pre-selected in portal |
| "Who is this for?" fires when no name found | Manual smoke | Text photo with no stylist name; confirm single reply SMS |
| Flood warning appears after 3 posts | Manual smoke | Submit 3+ posts for same stylist in 7 days; confirm amber banner |
| submitted_by set correctly on post row | Manual DB check | SELECT submitted_by FROM posts WHERE ... |
| Coordinator leaderboard tab shows points | Manual | Log in, visit Performance, click Coordinators tab |
| Stylist leaderboard unchanged | Manual | Verify coordinator-submitted posts still credit stylist |
| Welcome SMS sent on coordinator creation | Manual smoke | Add coordinator; confirm SMS received |
| Phone required for coordinator creation | Manual | Submit coordinator form without phone; confirm validation error |

### Wave 0 Gaps
- [ ] `migrations/049_coordinator_submitted_by.js` — must exist before any other work
- [ ] No test framework — all validation is manual smoke tests

---

## Sources

### Primary (HIGH confidence)
- Direct code reading: `src/core/gamification.js` — leaderboard pattern, `getPointValue()`, `periodFilter()`
- Direct code reading: `src/core/salonLookup.js` — `lookupStylist()` already handles managers table lookup (lines 242–275)
- Direct code reading: `src/core/messageRouter.js` — coordinator detection approach, portal token pattern, pending video Map pattern
- Direct code reading: `src/routes/teamPerformance.js` — period tab rendering pattern, existing leaderboard table structure
- Direct code reading: `src/core/stylistWelcome.js` — `sendWelcomeSms()` function signature and pattern to replicate
- Direct code reading: `src/routes/stylistPortal.js` — `validateToken` middleware, portal page shell, token table usage
- Direct code reading: `src/core/storage.js` — `savePost()` signature and `insertPostStmt` — confirmed `submitted_by` is NOT currently included
- Direct code reading: `src/ui/pageShell.js` line 157 — Performance nav item does NOT have `!isCoordinator` guard (coordinators can see it today)
- Direct code reading: `src/routes/stylistManager.js` — coordinator role and seat limit handling, existing `buildTeamMemberForm()` structure
- Migration file listing — next migration is `049`

### Secondary (MEDIUM confidence)
- CONTEXT.md canonical refs — file paths and integration points verified against actual code

### Tertiary (LOW confidence)
- GPT-4o-mini JSON response format for name extraction — follows established OpenAI API pattern but not yet implemented in this codebase (Phase 4 not built yet)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use; confirmed from code
- Architecture: HIGH — patterns verified directly from existing implementation files
- Pitfalls: HIGH — identified from direct code inspection of integration points
- Coordinator leaderboard query: HIGH — mirrors existing `getLeaderboard()` directly
- GPT name extraction: MEDIUM — pattern established from openai.js; exact prompt needs tuning at implementation time

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (stable codebase — no external API dependencies for this phase)
