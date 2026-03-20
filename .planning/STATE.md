---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 06-03-PLAN.md
last_updated: "2026-03-20T19:07:42.657Z"
progress:
  total_phases: 6
  completed_phases: 5
  total_plans: 20
  completed_plans: 20
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-19)

**Core value:** Salons never run out of quality content — the platform generates, recycles, and publishes it automatically while building the salon's online reputation.
**Current focus:** Phase 06 — per-salon-platform-content-routing

## Current Position

Phase: 06 (per-salon-platform-content-routing) — EXECUTING
Plan: 3 of 3

## Performance Metrics

**Velocity:**

- Total plans completed: 2
- Average duration: 3 min
- Total execution time: 0.1 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 02-content-engine P01 | 291 | 2 tasks | 5 files |
| Phase 01-vendor-sync P03 | 1 | 1 tasks | 1 files |
| Phase 01-vendor-sync P01 | 2 | 2 tasks | 6 files |
| Phase 01-vendor-sync P02 | 3 | 2 tasks | 4 files |
| Phase 01-vendor-sync P05 | 525558 | 1 tasks | 1 files |
| Phase 01-vendor-sync P04 | 2 | 1 tasks | 1 files |
| Phase quick P260319-t0p | 4 | 2 tasks | 4 files |
| Phase 02-content-engine P02 | 181 | 2 tasks | 3 files |
| Phase 02-content-engine P04 | 4 | 2 tasks | 2 files |
| Phase 02-content-engine P03 | 8 | 2 tasks | 2 files |
| Phase 03-reels-video P01 | 120 | 2 tasks | 3 files |
| Phase 03-reels-video P02 | 5 | 2 tasks | 4 files |
| Phase 03-reels-video P03 | 8 | 2 tasks | 1 files |
| Phase 03-reels-video P04 | 3 | 2 tasks | 3 files |
| Phase 05-guest-care-and-support-staff P01 | 2 | 2 tasks | 4 files |
| Phase 05-guest-care-and-support-staff P03 | 8 | 2 tasks | 6 files |
| Phase 05 P02 | 413 | 3 tasks | 3 files |
| Phase 06-per-salon-platform-content-routing P01 | 2 | 2 tasks | 3 files |
| Phase 06-per-salon-platform-content-routing P02 | 2 | 2 tasks | 1 files |
| Phase 06 P03 | 5 | 2 tasks | 2 files |

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Guest Care and Support Staff — receptionist/front-desk staff type that posts on behalf of stylists with modified portal flow, service provider dropdown, support member leaderboard scoring, and tailored welcome SMS
- Phase 6 added: Per-Salon Platform Content Routing — per-salon control over which content types publish to which platform+format, with Admin→Integrations UI toggles, scheduler routing check, and Platform Console global defaults

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Project init: Vendor sync writes into existing vendor_campaigns schema (avoids divergence with vendorScheduler.js)
- Project init: Video files hosted locally at data/uploads/videos/ (no S3 dependency)
- Project init: Smart recycler triggers at queue depth < 3 AND 48hr since last publish
- Project init: Featured Review posts use sharp (consistent with celebration/promo image pattern)
- Project init: GMB OAuth from FEAT-020 reused for Reputation Manager (no new auth flow)
- [Phase 01-vendor-sync Plan 02]: getBrowser singleton reused from puppeteerRenderer.js — never launch second Chrome on Render
- [Phase 01-vendor-sync Plan 02]: pdfjs-dist (legacy ESM) chosen for PDF annotation extraction; pdf-parse cannot extract hyperlinks
- [Phase 01-vendor-sync Plan 02]: imageDownloadStrategy='auto' — HEAD check first, Puppeteer fallback for auth-protected images
- [Phase 01-vendor-sync Plan 02]: CDP download + file-system polling dual strategy for --single-process Chrome compatibility
- [Phase 01-vendor-sync]: pdf_sync campaigns bypass AI entirely — caption_body used verbatim with [SALON NAME] replacement
- [Phase 01-vendor-sync]: Both source and caption_body must be truthy for PDF path — guards against malformed rows
- [Phase 01-vendor-sync]: product_value column added to vendor_brands in migration 045 — was in CLAUDE.md but had no migration
- [Phase 01-vendor-sync]: UNIQUE index on (vendor_name, campaign_name, release_date) — NULLs distinct in SQLite UNIQUE, acceptable since Wave 1 will always set release_date
- [Phase 01-vendor-sync]: vendorSyncRanToday guard resets on restart — acceptable since runVendorSync is idempotent (INSERT OR IGNORE)
- [Phase 01-vendor-sync]: Sync route fires async (fire-and-forget) — operator refreshes page to see result via last_sync_at
- [Phase 01-vendor-sync]: syncVendor() uses fetch() JS not form POST — allows button state feedback without page reload
- [Phase quick-260319-t0p]: KB articles live in mostlypostly-site/kb/ as standalone HTML — no CMS; 4-section structure mandatory; article required for all user-facing features
- [Phase 02-content-engine Plan 01]: cloneAndEnqueue is a shared helper exported separately for future manual recycle routes
- [Phase 02-content-engine Plan 01]: Dynamic SQL for weekday exclusion — excludeTypes built from MID_WEEK Set, appended only when non-empty
- [Phase 02-content-engine Plan 01]: generateCaption dynamically imported to avoid circular deps at module load time
- [Phase 02-content-engine]: Reel posts excluded from 7-day distribution query and scored -1 — bonus content that never skews cadence
- [Phase 02-content-engine]: pickNextPost falls back to full posts array when all candidates filtered — scheduler never stalls
- [Phase 02-content-engine]: Deficit scoring (target.min - current_ratio) replaces static priority sort — dynamic cadence enforcement
- [Phase 02-content-engine Plan 04]: Recycle banner uses datetime('now', '-7 days') rolling window — not calendar week boundary
- [Phase 02-content-engine Plan 04]: Undo form passes salon as query param matching resolveSalonId(req) pattern in dashboard.js
- [Phase 02-content-engine]: Caption refresh toggle omitted from DOM entirely for Starter/trial (not greyed)
- [Phase 02-content-engine]: Manual recycle calls shared cloneAndEnqueue same path as auto-recycle for consistent RECYC-05 behavior
- [Phase 03-reels-video]: No new express.static mount for videos — existing /uploads mount covers UPLOADS_DIR/videos/ subdirectory
- [Phase 03-reels-video]: isVideo flag passed to handleIncomingMessage suppresses auto-ACK for video MMS
- [Phase 03-reels-video]: postTypeLabel in analytics.js already handled reel type — no change needed
- [Phase 03-reels-video]: generateReelCaption derives stylistId from stylist parameter, not _stylistId local variable in handleIncomingMessage
- [Phase 03-reels-video]: composeFinalCaption called with correct {caption} param name (not baseCaption as in plan docs) — actual signature from composeFinalCaption.js
- [Phase 03-reels-video]: getSalonPolicy used as static import in generateReelCaption — already imported at top of messageRouter.js, no dynamic import needed
- [Phase 03-reels-video]: waitForContainer extended with optional timeout params (backward-compatible); reel branch in scheduler catches FB/IG independently; GMB excluded for reel posts
- [Phase 05-guest-care-and-support-staff]: Separate SELECT role query for coordinator detection — avoids altering existing manager JOIN shape
- [Phase 05-guest-care-and-support-staff]: submitted_by defaults NULL — backward compatible with all existing post saves
- [Phase 05-guest-care-and-support-staff]: getCoordinatorLeaderboard uses 50% point values (Math.round(getPointValue * 0.5)) — coordinators facilitate rather than originate content
- [Phase 05-guest-care-and-support-staff]: submitted_by lookup is per-row synchronous DB call in dashboard.js map() — acceptable since better-sqlite3 is sync and result set is capped at 1000 rows
- [Phase 05]: GPT-4o-mini with json_object response_format for coordinator stylist name extraction
- [Phase 05]: isCoordinatorFlow detection via post.submitted_by IS NOT NULL in stylistPortal — clean backward-compatible check
- [Phase 06-per-salon-platform-content-routing]: platform_routing stored as TEXT JSON on salons row — consistent with brand_palette/default_hashtags columns, avoids separate routing table join on scheduler tick
- [Phase 06-per-salon-platform-content-routing]: NULL platform_routing = all-enabled defaults — zero migration of existing data required, fully backward compatible
- [Phase 06-per-salon-platform-content-routing]: isEnabledFor() returns true for unknown post types — new types will not be accidentally suppressed before routing rules are set
- [Phase 06-per-salon-platform-content-routing]: buildRoutingRows() defined as closure in GET handler — needs access to isGmbPlanAllowed, fbConnected, tiktokConnected without extra params
- [Phase 06-per-salon-platform-content-routing]: TikTok column greyed for availability, promotions, celebration_story — skipped by scheduler anyway; greying prevents manager confusion
- [Phase 06-per-salon-platform-content-routing]: isEnabledFor() guards wrap individual publish calls in scheduler so FB and IG can be disabled independently per post type
- [Phase 06-per-salon-platform-content-routing]: GMB and TikTok routing added as && condition on existing eligible check — no restructuring needed
- [Phase 06-per-salon-platform-content-routing]: Platform Console reset-routing uses requireSecret + requirePin middleware pattern from existing routes

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1: FEAT-031 blocked until Aveda portal URL and login type confirmed from Tasha — build parallel components (caption gen, dedup, schema) while waiting
- Phase 3: TikTok Developer app approval is external (1-4 weeks) — stub only this milestone; full publish is v2

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260319-dqb | Fix vendor post image not publishing to social platforms | 2026-03-19 | 86319c9 | [260319-dqb-fix-vendor-post-image-not-publishing-to-](./quick/260319-dqb-fix-vendor-post-image-not-publishing-to-/) |
| 260319-fii | Fix AI Generate button in Platform Console campaign forms | 2026-03-19 | 4560978 | [260319-fii-fix-ai-generate-button-in-platform-conso](./quick/260319-fii-fix-ai-generate-button-in-platform-conso/) |
| 260319-i8s | Inject affiliate URL into vendor posts (deterministic) | 2026-03-19 | ba90a69 | [260319-i8s-inject-affiliate-url-into-vendor-posts-f](./quick/260319-i8s-inject-affiliate-url-into-vendor-posts-f/) |
| 260319-q5j | Vendor campaign posting frequency controls (min-gap, auto-expiry, tone_direction removal) | 2026-03-19 | 65a68f7 | [260319-q5j-audit-vendor-campaign-posting-frequency-](./quick/260319-q5j-audit-vendor-campaign-posting-frequency-/) |
| 260319-t0p | KB article workflow — template, Post Queue demo article, Definition of Done enforcement | 2026-03-20 | f505962 | [260319-t0p-ensure-kb-article-is-created-for-every-n](./quick/260319-t0p-ensure-kb-article-is-created-for-every-n/) |
| 260320-ate | Fix CSP inline event handler violations in vendorAdmin (onerror/onclick → event delegation) | 2026-03-20 | 57b8a71 | [260320-ate-fix-csp-inline-event-handler-violation-o](./quick/260320-ate-fix-csp-inline-event-handler-violation-o/) |
| 260320-dn3 | Add collapsible recent activity section to manager dashboard (5 visible, rest collapsible, 14-day window) | 2026-03-20 | 40feec9 | [260320-dn3-add-collapsible-recent-activity-section-](./quick/260320-dn3-add-collapsible-recent-activity-section-/) |

## Session Continuity

Last session: 2026-03-20T19:07:42.655Z
Stopped at: Completed 06-03-PLAN.md
Resume file: None
