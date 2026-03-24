# Auth & Role Enforcement Design
_Date: 2026-03-24_

## Problem

Three security gaps were identified:

1. `/dashboard` (database view) has **no authentication** — anyone with a salon slug can view all posts without credentials.
2. `requireAuth` middleware does **not enforce roles** — a coordinator logging in can access all manager routes (admin, billing, promotions, etc.).
3. Admin/billing write routes have **no server-side role check** — UI greying is cosmetic only.

## Role System

Two access tiers (stylist portal is separate and token-based):

| Role | Access |
|---|---|
| `owner` | Full access including billing |
| `manager` | Full access excluding billing |
| `coordinator` / `staff` | Approval queue, post queue, analytics, performance, coordinator upload |

Coordinators and staff are treated identically at the middleware level.

## Approach: Shared `requireRole()` middleware (Approach B)

A shared `src/middleware/auth.js` exports two reusable functions applied per-route or per-router.

## Design

### 1. Shared auth middleware — `src/middleware/auth.js` (new file)

```js
export function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.manager) {
    return res.redirect("/manager/login");
  }
  next();
}

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

`restoreManagerSession` in `server.js` already sets `req.manager.role` — no session changes needed.

The existing per-router `requireAuth` copies in `manager.js` and `admin.js` are replaced with imports from this shared file.

### 2. Fix `/dashboard` — `server.js`

```js
import { requireAuth, requireRole } from "./src/middleware/auth.js";

// Before:
app.use("/dashboard", dashboardRoute);

// After:
app.use("/dashboard", requireAuth, requireRole("owner", "manager"), dashboardRoute);
app.use("/posts",     requireAuth, requireRole("owner", "manager"), postsRoute);
```

One-line change per route. No changes inside `dashboard.js`.

### 3. Route-level role enforcement — `manager.js`

Add `requireRole("owner", "manager")` to restricted routes:

- `GET/POST /promotion/new`, `/promotion/create`
- `GET/POST /edit/:id`
- `GET /approve`, `POST /approve`
- `GET /deny`, `POST /deny`
- `POST /retry-post`
- `POST /cancel-post`

Leave unrestricted (all authenticated):
- `GET /` (approval queue — rename page title to "Dashboard")
- `GET/POST /coordinator/upload`

### 4. Router-level role enforcement — restricted routers

Add `router.use(requireRole(...))` near the top of each router that is entirely owner/manager or owner-only:

| Router file | Allowed roles |
|---|---|
| `admin.js` | `owner`, `manager` |
| `schedulerConfig.js` | `owner`, `manager` |
| `stylistManager.js` | `owner`, `manager` |
| `locations.js` | `owner`, `manager` |
| `vendors.js` (manager-facing) | `owner`, `manager` |
| `integrations.js` | `owner`, `manager` |
| `billing.js` | `owner` only |

### 5. Rename "Manager Dashboard" → "Dashboard"

Update page title in `manager.js` `GET /` handler to say "Dashboard" rather than "Manager Dashboard" since coordinators now access it too.

## What Does NOT Change

- Stylist portal (`/stylist`) — token-based, entirely separate auth
- Internal admin (`/internal/vendors`) — `INTERNAL_SECRET` + PIN, unchanged
- Tracking redirects (`/t/`) — intentionally public
- Session shape — no changes
- DB schema — no changes

## Files Changed

1. `src/middleware/auth.js` — new file
2. `server.js` — dashboard/posts mount + import
3. `src/routes/manager.js` — per-route `requireRole` + title rename
4. `src/routes/admin.js` — `router.use(requireRole)` + remove local `requireAuth`
5. `src/routes/schedulerConfig.js` — `router.use(requireRole)`
6. `src/routes/stylistManager.js` — `router.use(requireRole)`
7. `src/routes/locations.js` — `router.use(requireRole)`
8. `src/routes/billing.js` — `router.use(requireRole("owner"))`
9. `src/routes/integrations.js` — `router.use(requireRole)`
10. `src/routes/postQueue.js` — `router.use(requireRole)` (drag-drop reorder is manager-only)
