---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: unknown
stopped_at: Completed 03-reels-video/03-04-PLAN.md
last_updated: "2026-03-20T14:20:58.875Z"
progress:
  total_phases: 5
  completed_phases: 3
  total_plans: 14
  completed_plans: 14
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-19)

**Core value:** Salons never run out of quality content — the platform generates, recycles, and publishes it automatically while building the salon's online reputation.
**Current focus:** Phase 03 — reels-video

## Current Position

Phase: 03 (reels-video) — EXECUTING
Plan: 1 of 4

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

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Guest Care and Support Staff — receptionist/front-desk staff type that posts on behalf of stylists with modified portal flow, service provider dropdown, support member leaderboard scoring, and tailored welcome SMS

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

Last session: 2026-03-20T14:16:26.028Z
Stopped at: Completed 03-reels-video/03-04-PLAN.md
Resume file: None
