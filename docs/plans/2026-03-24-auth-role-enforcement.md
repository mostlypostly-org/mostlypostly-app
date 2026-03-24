# Auth & Role Enforcement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

**Goal:** Close three security gaps: unauthenticated `/dashboard`, role-blind `requireAuth`, and cosmetic-only admin role checks.

**Architecture:** Create a shared `src/middleware/auth.js` exporting `requireAuth` and `requireRole`. Replace all per-router copies of `requireAuth` with the shared import. Add `requireRole` at the router level (via `router.use`) for fully-restricted routers, and per-route for mixed-access routers like `manager.js`. Mount `requireAuth + requireRole("owner","manager")` on `/dashboard` and `/posts` in `server.js`.

**Tech Stack:** Node.js, Express.js, ESM (`import`/`export`), vitest (tests), better-sqlite3 (sync DB)

---

### Task 1: Create shared auth middleware

**Files:**
- Create: `src/middleware/auth.js`

**Step 1: Create the file**

```js
// src/middleware/auth.js
// Shared auth middleware — imported by all route files and server.js.
// Replaces the per-router copies of requireAuth scattered across route files.

export function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.manager) {
    return res.redirect("/manager/login");
  }
  next();
}

/**
 * requireRole(...roles) — returns Express middleware that allows only the listed roles.
 * Must be used after requireAuth (relies on req.manager.role set by restoreManagerSession).
 *
 * Usage: router.get("/path", requireAuth, requireRole("owner", "manager"), handler)
 * Usage: router.use(requireRole("owner", "manager"))   // blocks entire router
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.manager?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).send("Access denied");
    }
    next();
  };
}
```

**Step 2: Write a unit test**

Create `tests/auth.middleware.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { requireAuth, requireRole } from "../src/middleware/auth.js";

function makeReq(overrides = {}) {
  return {
    session: { manager_id: "mgr-1" },
    manager: { role: "manager" },
    ...overrides,
  };
}

function makeRes() {
  const res = { redirectUrl: null, statusCode: null, body: null };
  res.redirect = (url) => { res.redirectUrl = url; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; };
  return res;
}

describe("requireAuth", () => {
  it("calls next() when session + manager present", () => {
    const next = vi.fn();
    requireAuth(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("redirects to /manager/login when no session", () => {
    const res = makeRes();
    requireAuth(makeReq({ session: {} }), res, vi.fn());
    expect(res.redirectUrl).toBe("/manager/login");
  });

  it("redirects to /manager/login when no req.manager", () => {
    const res = makeRes();
    requireAuth(makeReq({ manager: undefined }), res, vi.fn());
    expect(res.redirectUrl).toBe("/manager/login");
  });
});

describe("requireRole", () => {
  it("calls next() when role matches", () => {
    const next = vi.fn();
    requireRole("owner", "manager")(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when role not in list", () => {
    const res = makeRes();
    requireRole("owner", "manager")(makeReq({ manager: { role: "coordinator" } }), res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 when manager is undefined", () => {
    const res = makeRes();
    requireRole("owner")(makeReq({ manager: undefined }), res, vi.fn());
    expect(res.statusCode).toBe(403);
  });

  it("allows owner through owner-only gate", () => {
    const next = vi.fn();
    requireRole("owner")(makeReq({ manager: { role: "owner" } }), res, next);
    expect(next).toHaveBeenCalled();
  });
});
```

**Step 3: Run tests — expect PASS**

```bash
npx vitest run tests/auth.middleware.test.js
```

Expected: All 7 tests pass.

**Step 4: Commit**

```bash
git add src/middleware/auth.js tests/auth.middleware.test.js
git commit -m "feat(auth): add shared requireAuth and requireRole middleware"
```

---

### Task 2: Gate `/dashboard` and `/posts` in server.js

**Files:**
- Modify: `server.js` (around line 563)

**Step 1: Add import at top of server.js**

Find the import block near the top of `server.js` and add:

```js
import { requireAuth, requireRole } from "./src/middleware/auth.js";
```

**Step 2: Replace the unprotected mounts**

Find (around line 563):
```js
app.use("/dashboard", dashboardRoute);
app.use("/posts", postsRoute);
```

Replace with:
```js
app.use("/dashboard", requireAuth, requireRole("owner", "manager"), dashboardRoute);
app.use("/posts",     requireAuth, requireRole("owner", "manager"), postsRoute);
```

**Step 3: Manual verification**

Start the server locally (`node server.js`). In an incognito window:
- `GET /dashboard?salon=any-slug` → should redirect to `/manager/login` (not render the database view)
- Log in as an owner → `/dashboard` should load normally
- Log in as a coordinator → `/dashboard` should return 403

**Step 4: Commit**

```bash
git add server.js
git commit -m "fix(auth): require owner/manager role for /dashboard and /posts routes"
```

---

### Task 3: Update manager.js — restrict sensitive routes, allow coordinator/staff on queue

**Files:**
- Modify: `src/routes/manager.js`

**Context:** The existing `requireAuth` in `manager.js` (line 126) stays but is replaced with the shared import. `requireRole` is added to routes that coordinator/staff must not access.

**Step 1: Replace the local requireAuth with the shared import**

At the top of `manager.js`, find the imports and add:
```js
import { requireAuth, requireRole } from "../middleware/auth.js";
```

Then delete the local `requireAuth` function (lines 126–148).

**Step 2: Add requireRole to restricted routes**

For each of the following routes, add `requireRole("owner", "manager")` after `requireAuth`:

```js
// Approve / deny
router.get("/approve",  requireAuth, requireRole("owner", "manager"), async (req, res) => {
router.post("/approve", requireAuth, requireRole("owner", "manager"), async (req, res) => {
router.get("/deny",     requireAuth, requireRole("owner", "manager"), (req, res) => {
router.post("/deny",    requireAuth, requireRole("owner", "manager"), async (req, res) => {

// Edit post
router.get("/edit/:id",  requireAuth, requireRole("owner", "manager"), (req, res) => {
router.post("/edit/:id", requireAuth, requireRole("owner", "manager"), (req, res) => {

// Promotions
router.get("/promotion/new",    requireAuth, requireRole("owner", "manager"), (req, res) => {
router.post("/promotion/create",requireAuth, requireRole("owner", "manager"), async (req, res) => {

// Other post actions
router.get("/post-now",    requireAuth, requireRole("owner", "manager"), (req, res) => {
router.get("/cancel",      requireAuth, requireRole("owner", "manager"), (req, res) => {
router.get("/cancel-post", requireAuth, requireRole("owner", "manager"), (req, res) => {
router.post("/retry-post", requireAuth, requireRole("owner", "manager"), (req, res) => {
```

Leave these routes with `requireAuth` only (coordinator/staff allowed):
```js
router.get("/",                          requireAuth, ...)  // approval queue / dashboard
router.get("/coordinator/upload",        requireAuth, ...)
router.post("/coordinator/upload",       requireAuth, ...)
```

**Step 3: Rename page title**

In `router.get("/", requireAuth, ...)`, find the title passed to `pageShell`:
```js
// Before:
title: "Manager Dashboard",
// After:
title: "Dashboard",
```

**Step 4: Manual verification**

Log in as coordinator → navigate to `/manager` (should load). Try navigating directly to `/manager/promotion/new` → should get 403.

**Step 5: Commit**

```bash
git add src/routes/manager.js
git commit -m "fix(auth): restrict manager-only routes from coordinator/staff; rename Dashboard"
```

---

### Task 4: Update fully-restricted routers (router.use pattern)

**Files:**
- Modify: `src/routes/admin.js`
- Modify: `src/routes/schedulerConfig.js`
- Modify: `src/routes/stylistManager.js`
- Modify: `src/routes/locations.js`
- Modify: `src/routes/integrations.js`
- Modify: `src/routes/postQueue.js`

Each file has a local `requireAuth` function and mounts it per-route. The pattern for each file is identical:

1. Add import at top:
   ```js
   import { requireAuth, requireRole } from "../middleware/auth.js";
   ```
   (For `admin.js` the path is the same since it's also in `src/routes/`)

2. Delete the local `requireAuth` function.

3. Add `router.use` after the router is created:
   ```js
   const router = express.Router();
   router.use(requireAuth, requireRole("owner", "manager"));
   ```

4. Remove `requireAuth` from every individual route declaration in the file (since `router.use` handles it globally). Leave other middleware (multer uploads, etc.) in place.

**For `admin.js` specifically:** The local `requireAuth` checks `req.manager?.manager_phone` instead of `req.session?.manager_id`. The shared version uses the session. Verify `restoreManagerSession` in server.js runs before admin routes (it does — it's a global middleware registered early). The `isOwner()` helper inside `admin.js` stays as-is (it's a display helper, not an access gate).

**For `billing.js`:**

`billing.js` already has a `requireOwner` function. Add the import and `router.use` with owner/manager for non-billing-page routes. The billing page itself (`/manager/billing`) already has `requireOwner` — replace it with `requireRole("owner")` from shared middleware.

```js
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth, requireRole("owner", "manager")); // blocks coordinator/staff from checkout too

// Then on the billing page route, add owner-only gate:
router.get("/manager/billing", requireRole("owner"), async (req, res) => { ...
```

Delete the local `requireAuth` and `requireOwner` functions from `billing.js`.

**Step 1: Apply the pattern to each file (one at a time)**

Do them in this order to minimize risk:
1. `postQueue.js` (simplest — 2 routes)
2. `locations.js` (4 routes)
3. `schedulerConfig.js` (2 routes)
4. `integrations.js` (many routes — scan carefully)
5. `stylistManager.js` (many routes)
6. `admin.js` (many routes — check for `manager_phone` usage)
7. `billing.js` (replace `requireOwner` too)

**Step 2: Manual verification for each router**

For each router, log in as a coordinator and try to navigate to the root of that section. All should return 403 or redirect.

**Step 3: Commit all together**

```bash
git add src/routes/admin.js src/routes/schedulerConfig.js src/routes/stylistManager.js \
        src/routes/locations.js src/routes/integrations.js src/routes/postQueue.js \
        src/routes/billing.js
git commit -m "fix(auth): add router-level requireRole to all restricted route groups"
```

---

### Task 5: Smoke test end-to-end

**Manual test matrix (no automated test needed — manual verification is the gate):**

| Role | `/manager` | `/manager/promotion/new` | `/manager/admin` | `/dashboard` | `/manager/billing` |
|---|---|---|---|---|---|
| Owner | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 |
| Manager | ✅ 200 | ✅ 200 | ✅ 200 | ✅ 200 | ❌ 403 |
| Coordinator | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| Staff | ✅ 200 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |
| Unauthenticated | ↩ login | ↩ login | ↩ login | ↩ login | ↩ login |

Test coordinator upload still works:
- Log in as coordinator → `GET /manager/coordinator/upload` → ✅ 200
- Submit a photo → verify post is created with `submitted_by` attribution

**Step 1: Run existing test suite to catch regressions**

```bash
npx vitest run
```

Expected: All existing tests pass (middleware changes don't touch business logic).

**Step 2: Commit smoke test confirmation note (optional — skip if clean)**

If any test broke, fix it before proceeding. Do not move on with failing tests.

---

### Task 6: Push to dev (staging)

```bash
git push origin main
```

Verify Render staging deploys cleanly. Check logs for any auth-related errors on startup.
