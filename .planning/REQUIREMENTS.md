# Requirements: MostlyPostly — March 2026 Milestone

**Defined:** 2026-03-19
**Core Value:** Salons never run out of quality content — the platform generates, recycles, and publishes it automatically while building the salon's online reputation.

## v1 Requirements

### Vendor Sync (FEAT-031)

- [x] **VSYNC-01**: System can authenticate to Aveda brand portal using stored credentials via Puppeteer automation
- [x] **VSYNC-02**: System downloads the current release PDF from the Aveda portal (monthly release cadence; 30-day rolling window deferred until API access available)
- [x] **VSYNC-03**: System deduplicates scraped assets against existing vendor_campaigns (by vendor_name + campaign_name + release_date) and skips existing entries
- [x] **VSYNC-04**: System downloads new vendor images to public/uploads/vendor/aveda/
- [x] **VSYNC-05**: System stores brand-provided captions from PDF verbatim as caption_body; product name sourced from PDF content
- [x] **VSYNC-06**: Product description sourced from PDF caption_body — no separate product page fetch required
- [x] **VSYNC-07**: System generates salon-toned FB/IG captions at post time via GPT-4o-mini, using PDF caption as brand messaging brief
- [x] **VSYNC-08**: System stores completed campaigns in vendor_campaigns with all required fields
- [x] **VSYNC-09**: Platform Console shows a "Sync Now" button per vendor and displays last_synced_at timestamp
- [x] **VSYNC-10**: Nightly scheduled sync runs automatically via scheduler.js cron
- [x] **VSYNC-11**: Vendor sync factory pattern abstracts scraper config so adding a new vendor requires only a config block and three env vars

### Content Recycler (FEAT-019)

- [x] **RECYC-01**: System auto-triggers recycling when queue depth drops below salon threshold (default 3) AND last publish was more than 48 hours ago
- [x] **RECYC-02**: System selects recycle candidates from posts published in past 90 days, ranked by reach DESC
- [x] **RECYC-03**: System excludes posts recycled in the last 45 days and posts flagged block_from_recycle from candidate pool
- [x] **RECYC-04**: System enforces post_type distribution (does not recycle same type twice in a row)
- [x] **RECYC-05**: System optionally refreshes caption via GPT-4o rewrite at recycle time (per-salon toggle)
- [x] **RECYC-06**: Recycled posts are cloned as new rows with recycled_from_id FK set and enqueued via enqueuePost()
- [x] **RECYC-07**: Manager receives SMS notification when auto-recycle fires
- [x] **RECYC-08**: Manager can toggle auto-recycle on/off per salon in Admin settings
- [x] **RECYC-09**: Manager can flag individual published posts as "block from recycling" in Database view
- [x] **RECYC-10**: Manager can manually trigger recycle on any published post via Recycle button
- [x] **RECYC-11**: Dashboard shows a notice when posts were auto-recycled this week with link to view/undo

### Intelligent Scheduler (FEAT-001)

- [x] **SCHED-01**: pickNextPost() helper selects from pending queue by content-type weight based on last 7 published posts
- [x] **SCHED-02**: Scheduler enforces 50–60% standard portfolio posts across a 7-day rolling window
- [x] **SCHED-03**: Scheduler enforces 15–20% before/after posts, preferred Tue–Thu
- [x] **SCHED-04**: Scheduler caps promotions at max 2–3/week and never back-to-back
- [x] **SCHED-05**: Scheduler slots availability posts to mid-week only (Tue–Thu)
- [x] **SCHED-06**: Reels count as bonus and do not displace core cadence

### Reels & Video Publishing (FEAT-022)

- [x] **REEL-01**: messageRouter.js detects video/* content type from Twilio MMS and branches to video flow
- [x] **REEL-02**: System downloads Twilio video file (auth required) and saves to data/uploads/videos/
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
