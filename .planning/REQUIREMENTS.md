# Requirements: MostlyPostly — March 2026 Milestone

**Defined:** 2026-03-19
**Core Value:** Salons never run out of quality content — the platform generates, recycles, and publishes it automatically while building the salon's online reputation.

## v1 Requirements

### Vendor Sync (FEAT-031)

- [ ] **VSYNC-01**: System can authenticate to Aveda brand portal using stored credentials via Playwright automation
- [ ] **VSYNC-02**: System scrapes social-tagged asset cards from the past 30 days on the Aveda portal
- [ ] **VSYNC-03**: System deduplicates scraped assets against existing vendor_campaigns (by image URL or product name) and skips existing entries
- [ ] **VSYNC-04**: System downloads new vendor images to public/uploads/vendor/aveda/
- [ ] **VSYNC-05**: System extracts and normalizes product names from asset cards using GPT-4o-mini
- [ ] **VSYNC-06**: System fetches product descriptions from aveda.com product pages (with fallback to brand site search)
- [ ] **VSYNC-07**: System generates FB/IG-ready captions in Aveda brand voice using GPT-4o
- [ ] **VSYNC-08**: System stores completed campaigns in vendor_campaigns with all required fields
- [ ] **VSYNC-09**: Platform Console shows a "Sync Now" button per vendor and displays last_synced_at timestamp
- [ ] **VSYNC-10**: Nightly scheduled sync runs automatically via scheduler.js cron
- [ ] **VSYNC-11**: Vendor sync factory pattern abstracts scraper config so adding a new vendor requires only a config block and three env vars

### Content Recycler (FEAT-019)

- [ ] **RECYC-01**: System auto-triggers recycling when queue depth drops below salon threshold (default 3) AND last publish was more than 48 hours ago
- [ ] **RECYC-02**: System selects recycle candidates from posts published in past 90 days, ranked by reach DESC
- [ ] **RECYC-03**: System excludes posts recycled in the last 45 days and posts flagged block_from_recycle from candidate pool
- [ ] **RECYC-04**: System enforces post_type distribution (does not recycle same type twice in a row)
- [ ] **RECYC-05**: System optionally refreshes caption via GPT-4o rewrite at recycle time (per-salon toggle)
- [ ] **RECYC-06**: Recycled posts are cloned as new rows with recycled_from_id FK set and enqueued via enqueuePost()
- [ ] **RECYC-07**: Manager receives SMS notification when auto-recycle fires
- [ ] **RECYC-08**: Manager can toggle auto-recycle on/off per salon in Admin settings
- [ ] **RECYC-09**: Manager can flag individual published posts as "block from recycling" in Database view
- [ ] **RECYC-10**: Manager can manually trigger recycle on any published post via Recycle button
- [ ] **RECYC-11**: Dashboard shows a notice when posts were auto-recycled this week with link to view/undo

### Intelligent Scheduler (FEAT-001)

- [ ] **SCHED-01**: pickNextPost() helper selects from pending queue by content-type weight based on last 7 published posts
- [ ] **SCHED-02**: Scheduler enforces 50–60% standard portfolio posts across a 7-day rolling window
- [ ] **SCHED-03**: Scheduler enforces 15–20% before/after posts, preferred Tue–Thu
- [ ] **SCHED-04**: Scheduler caps promotions at max 2–3/week and never back-to-back
- [ ] **SCHED-05**: Scheduler slots availability posts to mid-week only (Tue–Thu)
- [ ] **SCHED-06**: Reels count as bonus and do not displace core cadence

### Reels & Video Publishing (FEAT-022)

- [ ] **REEL-01**: messageRouter.js detects video/* content type from Twilio MMS and branches to video flow
- [ ] **REEL-02**: System downloads Twilio video file (auth required) and saves to data/uploads/videos/
- [ ] **REEL-03**: System sends SMS prompt to stylist asking for service description to inform caption
- [ ] **REEL-04**: System generates Reel caption from stylist's SMS answer + salon tone via GPT-4o
- [ ] **REEL-05**: Post is created in DB with post_type=reel and enters standard approval queue
- [ ] **REEL-06**: Instagram Reels publisher handles container creation, status polling, and publish (three-step API)
- [ ] **REEL-07**: Facebook Reels publisher handles upload + publish independently from Instagram
- [ ] **REEL-08**: Reel post failures integrate with existing FEAT-033 error flow
- [ ] **REEL-09**: Analytics and leaderboard track reel post_type (20 pts vs 10 for standard)
- [ ] **REEL-10**: TikTok Developer app submitted in parallel; tiktok.js publisher stub created

### Reputation Manager (FEAT-026)

- [ ] **REP-01**: System fetches Google reviews from GMB Reviews API on a 4-hour scheduler poll, reusing existing FEAT-020 OAuth
- [ ] **REP-02**: Reviews are stored in google_reviews table (review_id, salon_id, reviewer_name, rating, text, reply_text, replied_at, stylist_id, post_generated, created_at)
- [ ] **REP-03**: System generates AI reply in salon brand voice via GPT-4o for each new review
- [ ] **REP-04**: Manager can Send or Edit AI-generated reply from Reputation portal
- [ ] **REP-05**: Manager can enable auto-send for replies (per-salon toggle in Admin)
- [ ] **REP-06**: System extracts stylist first names from review text via GPT-4o-mini and fuzzy-matches against salon's stylists
- [ ] **REP-07**: Manager confirms or manually selects stylist match before Featured Review post is generated
- [ ] **REP-08**: 4–5 star reviews with identified stylist generate a Featured Review post (star graphic via sharp + caption)
- [ ] **REP-09**: Featured Review posts enter the standard approval queue; auto-publish available for 5-star + confirmed match
- [ ] **REP-10**: Manager portal includes a Reputation tab showing review list with rating, reviewer, text snippet, reply status badge, and post status badge
- [ ] **REP-11**: Reputation tab shows aggregate stats: average rating, total reviews, reply rate, posts generated this month
- [ ] **REP-12**: Reputation tab shows 30-day rating trend sparkline

## v2 Requirements

### Post-Appointment Review Nudges (FEAT-026 V2)

- **NUDGE-01**: appointment.completed event triggers SMS review request to client after configurable delay (default 2 hrs)
- **NUDGE-02**: Anti-spam: one nudge per client per 90 days tracked in review_requests table
- **NUDGE-03**: If client replies with a complaint, message is routed to manager DM instead of going public

### TikTok Full Publishing (FEAT-022 Phase 2)

- **TIKTOK-01**: Manager can connect TikTok Business Account via OAuth
- **TIKTOK-02**: Reel posts auto-submitted to TikTok if salon has TikTok connected

## Out of Scope

| Feature | Reason |
|---------|--------|
| DALL-E image generation | Removed — real photos only policy |
| Post-appointment SMS nudges | Requires Zenoti appointment webhook; deferred to next milestone |
| TikTok full publish flow | Dev app approval is external (1–4 weeks); stub only this milestone |
| Vagaro integration | Not blocking any active feature; deferred |
| Mobile app for stylists | SMS-first remains the model |
| ffmpeg frame extraction for video captions | Phase 2 of Reels — SMS prompt is sufficient for v1 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| VSYNC-01 through VSYNC-11 | Phase 1 | Pending |
| RECYC-01 through RECYC-11 | Phase 2 | Pending |
| SCHED-01 through SCHED-06 | Phase 2 | Pending |
| REEL-01 through REEL-10 | Phase 3 | Pending |
| REP-01 through REP-12 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 50 total
- Mapped to phases: 50
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-19*
*Last updated: 2026-03-19 after initial definition*
