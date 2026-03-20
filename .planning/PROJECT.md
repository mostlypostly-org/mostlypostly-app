# MostlyPostly

## What This Is

MostlyPostly is an AI-driven social media automation platform built for hair salons. Stylists text a photo or video from their phone, AI generates a branded caption, the manager approves, and the post publishes automatically to Facebook, Instagram, and Google Business Profile on a smart schedule — no app download required for stylists.

This is an existing, production Node.js/Express application (ESM, SQLite, Render.com). This milestone adds four features that extend the content engine: automated vendor asset ingestion, smart content recycling with an intelligent cadence scheduler, Reels/video publishing (gating TikTok), and a Google Review reputation manager.

## Core Value

Salons never run out of quality content — the platform generates, recycles, and publishes it automatically while building the salon's online reputation.

## Requirements

### Validated

- ✓ Stylist SMS-to-post workflow (photo → AI caption → approval → publish) — existing
- ✓ Manager web dashboard (approve, edit, schedule, analytics) — existing
- ✓ Facebook + Instagram publishing — existing
- ✓ Google Business Profile publishing (FEAT-020) — existing
- ✓ Post scheduling with drag-and-drop queue — existing
- ✓ Multi-location support — existing
- ✓ Vendor brand integrations (Pro plan) with scheduler, hashtag tiers, affiliate URLs — existing
- ✓ Stripe billing (Starter/Growth/Pro) — existing
- ✓ Zenoti salon software integration (availability posts) — existing
- ✓ UTM tracking short URLs with click analytics — existing
- ✓ Celebration posts (birthdays/anniversaries) — existing
- ✓ Platform Console (internal admin tool) — existing

### Active

- [ ] FEAT-031: Automated vendor asset sync — Playwright scraper ingests Aveda (and future vendor) assets nightly from brand portal; generates captions; zero manual intervention after setup
- [ ] FEAT-019+001: Smart content recycler — auto-requeues top-performing posts when queue runs low; optional GPT-4o caption refresh; manager controls (block flag, SMS alert, dashboard notice)
- [ ] FEAT-019+001: Intelligent cadence scheduler — pickNextPost() enforces 7-day content-type balance (50–60% standard, 15–20% before/after, 10–15% promo, 10% availability)
- [ ] FEAT-022: Reels & video publishing — detect video MMS from stylists, download/re-host, publish as Instagram Reel + Facebook Reel; same zero-friction workflow
- [ ] FEAT-022: TikTok publishing foundation — tiktok.js publisher stub; TikTok Dev app submitted in parallel
- [ ] FEAT-026: Reputation Manager — pull Google reviews via GMB API, AI-generate replies in brand voice, identify stylist mentioned, turn 4–5 star reviews into Featured Review social posts
- [ ] FEAT-026: Reputation dashboard — new portal tab with review list, aggregate stats, reply rate, rating trend sparkline

### Out of Scope

- Post-appointment SMS review nudges (FEAT-026 V2) — depends on Zenoti appointment.completed webhook; deferred to next milestone
- TikTok full publish flow — Dev app approval takes 1–4 weeks; only stub + OAuth connection this milestone
- Vagaro integration — deferred, not blocking any active feature
- Mobile app (iOS/Android) for stylists — web/SMS-first remains the model

## Context

- **Stack:** Node.js + Express (ESM), SQLite via better-sqlite3 (synchronous — no await on DB calls), Twilio, OpenAI GPT-4o/mini, Facebook Graph API v22.0, Instagram Graph API, GMB API v4, Render.com hosting
- **Existing GMB OAuth:** FEAT-020 is complete — google_access_token, google_refresh_token, googleTokenRefresh.js, and googleAuth.js are all live. Reputation Manager reuses this directly.
- **Existing vendor scheduler:** vendorScheduler.js and vendor_campaigns table exist — FEAT-031 writes into this existing schema
- **Puppeteer singleton:** launchPromise mutex exists in puppeteerRenderer.js — any Playwright work must not conflict
- **Image generation pattern:** buildPromotionImage/buildAvailabilityImage use real photos (no DALL-E); Featured Review posts follow the same sharp-based pattern
- **FEAT-031 open question:** Aveda portal URL + login type not yet confirmed from Tasha — may affect build start

## Constraints

- **Tech stack:** Must stay ESM, better-sqlite3 synchronous, Express — no new runtime dependencies without clear justification
- **Security:** All DB queries must include salon_id filter tied to session; no new routes skip requireAuth; webhook signatures must be validated
- **No cloud storage:** Videos and images go to public/uploads/ or data/uploads/videos/ — no S3 unless explicitly decided
- **FEAT-031 dependency:** Vendor sync is blocked until Aveda portal URL/login type confirmed; build in parallel where possible
- **TikTok timeline:** Developer app approval is external — stub and OAuth only this milestone

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Reuse existing GMB OAuth for Reputation Manager | FEAT-020 already live; no new auth flow needed | — Pending |
| Vendor sync writes into existing vendor_campaigns schema | Avoids schema divergence with vendorScheduler.js | — Pending |
| Video files hosted locally (data/uploads/videos/) | No S3 dependency; Instagram requires public URL via Express static | — Pending |
| Smart recycler triggers at queue depth < 3 AND 48hr since last publish | Avoids over-recycling during active periods | — Pending |
| Featured Review posts use sharp (existing pattern) | Consistent with celebration/promo image generation | — Pending |

## Current State

Phase 05 (Guest Care & Support Staff) complete — coordinator role can submit posts on behalf of stylists via SMS or portal upload, with attribution badges, leaderboard scoring, and welcome SMS.

---
*Last updated: 2026-03-20 — Phase 05 complete*
