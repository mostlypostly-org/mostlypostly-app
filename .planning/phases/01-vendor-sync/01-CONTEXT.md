# Phase 1: Vendor Sync - Context

**Gathered:** 2026-03-19 (updated — fully automated portal+PDF pipeline)
**Status:** Ready for planning

<domain>
## Phase Boundary

Fully automated pipeline triggered by Platform Console "Sync Now" button (or nightly cron):

1. **Puppeteer logs into** avedapurepro.com/ResourceLibrary using stored credentials
2. **Puppeteer searches** for the current month's social assets PDF (e.g. "March 2026 Salon Social Assets") using filter "Most Relevant"
3. **Puppeteer downloads** the PDF (clicks the card → clicks Download button)
4. **PDF parser extracts** campaigns from each page (page 1 = cover/skip; page 2+ = one campaign each)
5. **Per-page extraction**: release date, campaign name, image download URL, caption (with `[SALON NAME]` placeholder), hashtags
6. **Image downloader**: follows the URL from PDF → opens the asset page → clicks Download → saves image to public/uploads/vendor/aveda/
7. **Dedup check**: skips any campaign already in vendor_campaigns (by name + release date)
8. **DB insert**: vendor_campaigns rows created, ready for existing vendorScheduler.js pickup

Nightly cron fires this automatically. Platform Console Sync Now button triggers on-demand.
Platform Console shows last sync timestamp + campaign count per vendor brand.

Vendor factory pattern: adding Wella or Redken = config block (portal URL, search keyword pattern,
login selectors, PDF download trigger) + env vars — no new code.

**In future milestones:** Brands provide data via API — this pipeline is the bridge.

</domain>

<decisions>
## Implementation Decisions

### Automation Approach (LOCKED — user confirmed)
- Puppeteer handles: portal login, PDF search, PDF download
- PDF parser handles: page extraction (text + embedded URLs)
- Node fetch/Puppeteer handles: image asset download (PDF links may require a page visit + click)
- Reuse existing `puppeteerRenderer.js` singleton — same shared browser pool, no second Chrome launch

### Aveda Portal Navigation (LOCKED)
- URL: https://avedapurepro.com/ResourceLibrary
- Flow: login form → filter "Most Relevant" → search keyword (e.g. "March 2026 Salon Social Assets") → open card → click Download → PDF saved locally
- Credentials: stored as env vars AVEDA_PORTAL_USER + AVEDA_PORTAL_PASS (never in DB)
- Search keyword pattern is config-driven per vendor: e.g. `"{MONTH} {YEAR} Salon Social Assets"`

### PDF Structure (LOCKED — user-confirmed)
- Page 1: Cover / header — skip
- Page 2+: One campaign per page, containing:
  - Release date
  - Campaign name
  - Clickable link → asset page → Download button → image file
  - Caption body with `[SALON NAME]` placeholder
  - Hashtags block at bottom of caption

### [SALON NAME] Replacement (LOCKED)
- Store captions verbatim with `[SALON NAME]` in vendor_campaigns DB
- Replace `[SALON NAME]` with actual salon.name at publish time in vendorScheduler.js
- One imported campaign serves all approved salons automatically

### Caption Handling (LOCKED)
- Captions come verbatim from PDF — AI generation NOT used during import
- Hashtags from PDF stored in vendor_campaigns.product_hashtag
- Existing buildVendorHashtagBlock() appends brand + salon hashtags at post time as before

### Image Acquisition
- PDF page contains URL → navigate to URL → find Download button → save file
- Store under public/uploads/vendor/aveda/ using uploadPath.js UPLOADS_DIR pattern
- If direct fetch works (URL is a direct file link), prefer fetch() over Puppeteer for images
- If URL requires page interaction to download, Puppeteer handles it

### Deduplication (LOCKED)
- Match on: vendor_name + campaign_name + release date
- Skip insert if already exists — idempotent, safe to run multiple times per month
- Log skipped count for Console display

### Platform Console UI
- New section per vendor brand: "Upload / Sync" card in vendorAdmin.js
- Shows: last sync date, campaigns imported, [Sync Now] button
- Sync Now → POST /internal/vendors/sync/:vendorName → kicks off async pipeline
- Operator sees sync progress feedback (in-progress indicator, success/error result)
- No manual PDF upload UI needed — fully automated

### Multi-Vendor Factory (LOCKED)
- Each vendor = one config object:
  - portalUrl, loginSelectors (user/pass/submit), searchKeywordTemplate, pdfDownloadSelectors
  - pdfPageParser config: field detection hints (date pattern, hashtag marker, image link indicator)
  - imageDownloadStrategy: 'direct' | 'page-click'
- Adding Wella = one config block + three env vars — zero new code

### PDF Parsing Library
- Research needed: `pdf-parse` vs `pdfjs-dist` for text + hyperlink extraction
- Critical: must extract embedded hyperlinks (image download URLs) from PDF pages
- Constraint: no new npm packages without justification; must justify chosen library

### Claude's Discretion
- Exact PDF parsing library (after research)
- Field extraction heuristics (how to detect campaign name vs caption vs hashtags boundaries)
- Retry logic for portal login failures
- Error reporting to Console (last_sync_error column)
- Nightly cron timing

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing vendor infrastructure
- `src/core/vendorScheduler.js` — Campaign-to-post pipeline; add [SALON NAME] → salon.name replacement here; sync feeds into this unchanged
- `src/routes/vendorAdmin.js` — Platform Console routes; Sync Now button + status display go here; uses requireSecret + requirePin auth
- `src/core/puppeteerRenderer.js` — Existing Puppeteer singleton (launchPromise mutex); vendor sync MUST use getBrowser() from this, not launch its own
- `src/core/uploadPath.js` — UPLOADS_DIR env var pattern and toUploadUrl() helper; use for vendor image storage

### DB schema
- `migrations/040_vendor_brands.js` — Current vendor_brands and vendor_campaigns schema; new migration needed for last_sync_at, last_sync_count, last_sync_error on vendor_brands

### New files to create
- `src/core/vendorSync.js` — New: Puppeteer portal login + PDF download + PDF parse + image download + dedup + DB insert
- `src/core/vendorConfigs.js` — New: factory config objects per vendor brand (Aveda config, extensible)
- Route additions in `src/routes/vendorAdmin.js` — POST /internal/vendors/sync/:vendorName trigger, GET status

### Project constraints
- `.planning/PROJECT.md` §Constraints — ESM, no new npm packages without justification, no cloud storage, security rules
- DB is synchronous (better-sqlite3) — no await on DB calls
- ESM throughout: import/export only
- Render Starter: 512MB RAM — Puppeteer already present; second browser launch NOT allowed

</canonical_refs>

<specifics>
## Specific Ideas

- **[SALON NAME] replacement**: In vendorScheduler.js, before publishing, replace `[SALON NAME]` with salon.name in the caption. This is a simple string replace, not AI generation.
- **Search keyword template**: Config string like `"{MONTH_YEAR} Salon Social Assets"` where `{MONTH_YEAR}` is filled dynamically (e.g. "March 2026"). Fallback: search previous month if current month yields no results.
- **Draft staging**: Consider whether parsed campaigns should go into a staging state (e.g. `status: 'synced_pending_review'` on vendor_campaigns) before becoming active — gives operator a chance to review before campaigns go live in salon feeds.
- **Sync lock**: In-memory flag (or DB flag) to prevent concurrent sync runs on the same vendor — Puppeteer can't handle two simultaneous sessions against the same portal credentials.

</specifics>

<deferred>
## Deferred Ideas

- Manual PDF upload by operator — not needed; pipeline is fully automated
- AI caption generation from product descriptions — captions come from PDF verbatim

</deferred>

---

*Phase: 01-vendor-sync*
*Context updated: 2026-03-19 — fully automated: Puppeteer portal → PDF download → parse → campaigns*
