# Phase 1: Vendor Sync - Context

**Gathered:** 2026-03-19 (updated after workflow clarification)
**Status:** Ready for planning

<domain>
## Phase Boundary

Monthly operator workflow: Aveda publishes a PDF of campaign assets to their resource library
(avedapurepro.com/ResourceLibrary). An MostlyPostly operator logs in, downloads the monthly
PDF (e.g. "March 2026 Salon Social Assets"), and uploads it to Platform Console. The system
parses each page (page 2+ = one campaign per page), downloads campaign images, and creates
draft vendor campaigns for review. Operator reviews and imports. Imported campaigns flow into
the existing vendorScheduler.js pipeline for scheduled posting to salons.

**In future milestones:** Brands will provide data via API — this PDF-upload workflow is the
bridge until that's possible.

**Excluded from Phase 1:** Automated portal scraping (no Puppeteer portal login), nightly
auto-sync (operator triggers monthly upload), caption AI generation during import (captions
come verbatim from PDF with [SALON NAME] placeholder replaced at publish time).

</domain>

<decisions>
## Implementation Decisions

### PDF Import Workflow (LOCKED)
Operator workflow (monthly):
1. Logs into avedapurepro.com/ResourceLibrary
2. Filters by "Most Relevant", searches for month (e.g. "March 2026 Salon Social Assets")
3. Opens card → clicks Download → gets PDF
4. Uploads PDF to Platform Console → Vendors → Aveda → [Upload Monthly PDF]

### PDF Structure Per Page (LOCKED — user-confirmed)
- Page 1: Cover/header — SKIP
- Page 2+: One campaign each, containing:
  - Release date
  - Campaign name
  - Asset link (URL to downloadable image — may require fetching/following redirect)
  - Caption body with `[SALON NAME]` placeholder
  - Hashtags block at bottom of caption

### [SALON NAME] Replacement (LOCKED)
- Store captions verbatim with `[SALON NAME]` in vendor_campaigns DB
- Replace `[SALON NAME]` with actual salon name at publish time (in vendorScheduler.js)
- This allows one imported campaign to serve all approved salons automatically

### Caption Handling (LOCKED)
- Captions come from the PDF — AI generation is NOT used during import
- Caption = PDF caption text with [SALON NAME] intact
- Hashtags from PDF are stored in vendor_campaigns.product_hashtag (or appended to caption)
- Existing buildVendorHashtagBlock() appends brand + salon hashtags at post time as before

### Image Acquisition (LOCKED)
- PDF pages contain download URLs for campaign images
- System attempts to fetch image directly from the URL found in PDF
- If direct fetch fails (redirect chain, auth wall), operator uploads image manually
- Images stored under public/uploads/vendor/aveda/ following uploadPath.js pattern

### Platform Console UI (LOCKED)
- New section in vendorAdmin.js: "Upload Monthly PDF" for each approved vendor brand
- Shows parsed draft campaigns in a review table before import:
  - Campaign name, release date, image preview thumbnail, caption preview (truncated)
  - Status: ✓ parsed / ⚠ image fetch failed (needs manual upload)
- Operator reviews, can edit individual campaigns, then clicks [Import All] or [Import Selected]
- After import: campaigns appear in vendor_campaigns, available to salons via existing flow
- Sync history: shows last import date, count of campaigns imported

### Multi-Vendor Extensibility (LOCKED)
- Vendor config object per brand: PDF page parser config (field detection hints), image fetch strategy
- Adding Wella/Redken = one config block, no new parsing code
- Config-driven field extraction (campaign name position, hashtag section marker, etc.)

### PDF Parsing Library
- Must not add Puppeteer for this workflow — PDF is already downloaded locally
- Research needed: `pdf-parse` (text extraction) vs `pdfjs-dist` (structured extraction with links)
- Key requirement: must extract embedded hyperlinks (image download URLs) from PDF pages
- If links are not extractable programmatically, fallback: operator pastes asset URLs into form

### Claude's Discretion
- Exact PDF parsing library (after research)
- Field extraction heuristics (how to detect campaign name vs caption vs hashtags in PDF text)
- Error handling for failed image fetches
- Schema additions beyond core columns
- Nightly job deprecation (no automated sync in Phase 1 — monthly manual upload only)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing vendor infrastructure
- `src/core/vendorScheduler.js` — Campaign-to-post pipeline; generateVendorCaption(), buildVendorHashtagBlock(), runVendorScheduler(); imported campaigns flow into this unchanged. Add [SALON NAME] replacement here.
- `src/routes/vendorAdmin.js` — Platform Console routes; PDF upload UI and import flow go here; uses requireSecret + requirePin auth
- `src/core/uploadPath.js` — UPLOADS_DIR env var pattern and toUploadUrl() helper; use this for vendor image storage

### DB schema
- `migrations/040_vendor_brands.js` — Current vendor_brands and vendor_campaigns schema; new migration needed for last_import_at, last_import_count, last_import_error on vendor_brands

### New files to create
- `src/core/vendorPdfImport.js` — New: PDF parsing, page extraction, image downloading, draft campaign creation
- Route additions in `src/routes/vendorAdmin.js` — POST /internal/vendors/pdf-upload/:vendorName, GET /internal/vendors/pdf-review/:jobId, POST /internal/vendors/pdf-confirm/:jobId

### Project constraints
- `.planning/PROJECT.md` §Constraints — ESM, no new npm packages without justification, no cloud storage, security rules
- DB is synchronous (better-sqlite3) — no await on DB calls
- ESM throughout: import/export only
- Render Starter: 512MB RAM — avoid heavy dependencies

</canonical_refs>

<specifics>
## Specific Ideas

- **[SALON NAME] at publish time**: `vendorScheduler.js generateVendorCaption()` currently uses GPT-4o. For PDF-imported campaigns, captions are pre-written — the function should detect that `final_caption` is already set (or a new `caption_source: 'pdf'` field) and skip AI generation, only replacing `[SALON NAME]` with salon.name
- **Hashtag storage**: PDF hashtags block → store in `vendor_campaigns.product_hashtag` column (existing). At post time, buildVendorHashtagBlock() appends brand hashtags + product hashtag as usual.
- **Draft/staging table**: Consider a `vendor_import_drafts` staging table to hold parsed-but-not-confirmed campaigns so operator can review before they enter vendor_campaigns. Prevents polluting the live feed with bad parses.
- **PDF page detection heuristics**: Each vendor will have different PDF layouts. Config-driven approach: each vendor config specifies regex or keyword patterns to identify field boundaries (e.g., "CAPTION:" prefix, hashtag line starts with #).

</specifics>

<deferred>
## Deferred Ideas

- Automated portal login/scraping (Puppeteer) — deferred until brands provide APIs
- AI caption generation from scraped product descriptions — not needed; captions come from PDF
- Nightly auto-sync — not applicable for PDF workflow; operator triggers monthly

</deferred>

---

*Phase: 01-vendor-sync*
*Context updated: 2026-03-19 — workflow clarified: PDF upload + parse (not portal scraping)*
