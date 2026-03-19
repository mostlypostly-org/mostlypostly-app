# Phase 1: Vendor Sync - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Automated backend pipeline that scrapes Aveda brand assets from the brand portal (nightly + on-demand), deduplicates against vendor_campaigns, downloads images, extracts and normalizes product names, fetches product descriptions, generates AI captions in Aveda brand voice, and stores completed campaigns in vendor_campaigns ready for the scheduler. Includes Platform Console Sync Now button + last_synced_at display. Vendor sync factory pattern abstracted so adding a second vendor requires only a config block and three env vars. Caption refresh, recycler, scheduler cadence, and all other post features are Phase 2+.

</domain>

<decisions>
## Implementation Decisions

### Browser Automation Library
- Use **Puppeteer** (already installed — not Playwright)
- Playwright was spec'd but would add a second ~200MB browser dependency to the Render build; Puppeteer is already present and used in production for image rendering
- **Reuse the existing `puppeteerRenderer.js` singleton** — vendor sync acquires the browser from the same shared pool rather than launching its own Chrome instance (lower RAM on Render Starter)
- **Login fresh on each run** — no session persistence between nightly runs; simpler, more reliable, portal sessions typically expire anyway; login overhead (~3-5 seconds) is acceptable for a nightly job

### Claude's Discretion
- Failure handling (portal login failures, scrape errors, download errors) — retry logic, error logging, and admin alerting approach
- Console sync UX (sync button response behavior, status display)
- Schema additions for last_synced_at and any error tracking columns
- Factory pattern config object schema for multi-vendor support
- Nightly sync timing (what hour scheduler fires the vendor sync)
- Image download directory structure under public/uploads/vendor/

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing vendor infrastructure
- `src/core/vendorScheduler.js` — Existing campaign-to-post pipeline; generateVendorCaption(), buildVendorHashtagBlock(), runVendorScheduler(); vendor sync feeds INTO this existing flow
- `src/routes/vendorAdmin.js` — Platform Console routes; Sync Now button goes here; uses requireSecret + requirePin auth
- `src/core/puppeteerRenderer.js` — Existing Puppeteer singleton (launchPromise mutex); vendor sync MUST use this same singleton, not launch its own browser
- `src/core/uploadPath.js` — UPLOADS_DIR env var pattern and toUploadUrl() helper; use this for vendor image storage path

### DB schema
- `migrations/040_vendor_brands.js` — Current vendor_brands and vendor_campaigns schema; a new migration is needed to add last_synced_at (and any error tracking columns) to vendor_brands

### New files to create
- `src/core/vendorSync.js` — New: Puppeteer scraper + dedup + download + caption generation (referenced in FEAT-031 spec)
- `src/routes/vendorSync.js` — New: POST /internal/vendors/sync/:vendorName trigger endpoint (referenced in FEAT-031 spec)

### Project constraints
- `.planning/PROJECT.md` §Constraints — ESM, no new npm packages without justification, no cloud storage, security/multi-tenancy rules

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `puppeteerRenderer.js` getBrowser() export: acquires the shared Puppeteer instance — vendorSync.js should import and use this
- `uploadPath.js` UPLOADS_DIR + toUploadUrl(): established pattern for file paths and public URLs — use for vendor image downloads
- `encrypt.js` / `encryption.js`: existing credential encryption helpers — Aveda credentials could be encrypted at rest if stored in DB in future; env vars bypass this for now
- `vendorScheduler.js` generateVendorCaption(): existing GPT-4o caption generator for vendor posts — vendorSync.js should reuse or extend this pattern for generating captions from scraped descriptions

### Established Patterns
- All Platform Console routes use `requireSecret(req, res, next)` + `requirePin(req, res, next)` middleware — sync trigger endpoint must follow this pattern
- DB is synchronous (better-sqlite3) — no await on DB calls; all Puppeteer/fetch work is async but DB reads/writes are sync
- ESM throughout: `import`/`export` only
- New vendor image directory follows pattern of `path.join(UPLOADS_DIR, "vendor-photos")` in vendorAdmin.js — use `path.join(UPLOADS_DIR, "vendor", vendorSlug)`

### Integration Points
- `runVendorScheduler()` is called from `server.js` on startup and on interval — nightly vendorSync trigger likely slots in alongside or before this call
- Platform Console Sync Now button is a new form/button inside the vendor management section of `vendorAdmin.js` HTML, posting to the new `/internal/vendors/sync/:vendorName` route
- New migration needed (044+) to add `last_synced_at TEXT`, `last_sync_count INTEGER`, `last_sync_error TEXT` columns to `vendor_brands`

</code_context>

<specifics>
## Specific Ideas

- Vendor sync is **blocked** on Aveda portal URL + login type confirmation from Tasha — planning should account for building the non-portal pieces (caption gen, dedup, schema, Console UI) first, then wiring the Playwright/Puppeteer scraper once unblocked
- The factory pattern abstraction is explicit: each vendor = one config object (portal URL, CSS selectors, login form selectors, brand tone prompt) + three env vars (VENDOR_{NAME}_PORTAL_URL, VENDOR_{NAME}_USER, VENDOR_{NAME}_PASS). Adding Wella or Redken = one config block, no new code.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 01-vendor-sync*
*Context gathered: 2026-03-19*
