# Roadmap: MostlyPostly — March 2026 Milestone

## Overview

This milestone extends the MostlyPostly content engine with four capabilities: automated vendor asset ingestion (so Pro salons always have fresh brand content), smart content recycling with an intelligent cadence scheduler (so the queue never goes empty and distribution is balanced), Reels and video publishing (so stylists can post video with the same zero-friction flow as photos), and a Google Review reputation manager (so salons build their online presence automatically). The platform ships these in dependency order — vendor content first, then the scheduler layer that governs all post types, then video, then reputation.

## Phases

- [x] **Phase 1: Vendor Sync** - Nightly automated ingestion of Aveda brand assets into the vendor campaign library (completed 2026-03-19)
- [ ] **Phase 2: Content Engine** - Smart content recycler and intelligent cadence scheduler that keep the queue balanced and non-empty
- [x] **Phase 7: Content Calendar View** - Visual 4-week calendar grid showing scheduled and published posts by date, with click-to-preview, day panel actions, and drag-to-reschedule (FEAT-018) (completed 2026-03-21)
- [ ] **Phase 3: Reels & Video** - Detect, download, and publish Instagram/Facebook Reels from stylist MMS video with same approval flow
- [ ] **Phase 4: Reputation Manager** - Pull Google reviews, generate AI replies, surface Featured Review posts, and expose a Reputation portal tab
- [x] **Phase 5: Guest Care and Support Staff** - Coordinator role SMS posting, stylist attribution, leaderboard scoring, and welcome SMS (completed 2026-03-20)

## Phase Details

### Phase 1: Vendor Sync
**Goal**: Pro salons automatically receive fresh Aveda campaign content in their vendor library every night — zero manual intervention after credentials are configured
**Depends on**: Nothing (first phase)
**Requirements**: VSYNC-01, VSYNC-02, VSYNC-03, VSYNC-04, VSYNC-05, VSYNC-06, VSYNC-07, VSYNC-08, VSYNC-09, VSYNC-10, VSYNC-11
**Success Criteria** (what must be TRUE):
  1. Platform Console shows a Sync Now button and last-synced timestamp per vendor; triggering it imports new Aveda assets without duplicating existing campaigns
  2. Nightly sync runs automatically and new vendor campaigns appear in the salon's vendor feed without any manual upload
  3. Platform Console operator can add a second vendor brand by providing only a config block and three env vars — no code changes to existing sync logic
  4. Scraped campaigns have AI-generated captions, normalized product names, and fetched descriptions stored in vendor_campaigns ready for scheduler pickup
**Plans:** 5/5 plans complete

Plans:
- [ ] 01-01-PLAN.md — Test infrastructure (vitest config) + DB migration 045 (sync columns)
- [ ] 01-02-PLAN.md — Core sync pipeline (vendorSync.js + vendorConfigs.js)
- [ ] 01-03-PLAN.md — vendorScheduler.js [SALON NAME] replacement for pdf_sync campaigns
- [ ] 01-04-PLAN.md — Platform Console Sync Now button + status display
- [ ] 01-05-PLAN.md — Nightly cron wiring in scheduler.js

### Phase 2: Content Engine
**Goal**: Salons always have a balanced, non-empty post queue — the scheduler intelligently picks content types and auto-recycles top posts when the queue runs low
**Depends on**: Phase 1
**Requirements**: RECYC-01, RECYC-02, RECYC-03, RECYC-04, RECYC-05, RECYC-06, RECYC-07, RECYC-08, RECYC-09, RECYC-10, RECYC-11, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05, SCHED-06
**Success Criteria** (what must be TRUE):
  1. When the queue drops below 3 posts and no publish has occurred in 48 hours, a top-performing post is automatically cloned and enqueued, and the manager receives an SMS notification
  2. Manager can flag a published post "block from recycling" in the Database view, and that post never appears in recycle candidates
  3. Manager can toggle auto-recycle on/off per salon in Admin settings and manually trigger recycling on any individual published post
  4. Dashboard shows a notice this week when posts were auto-recycled, with a link to view or undo
  5. Over any rolling 7-day window, the scheduled post mix reflects the target distribution: ~50-60% standard, 15-20% before/after (skewed Tue-Thu), promotions never back-to-back and capped at 2-3/week, availability slots mid-week only
**Plans:** 4/5 plans executed

Plans:
- [ ] 02-01-PLAN.md — Migration 048 + content recycler core logic (checkAndAutoRecycle) + scheduler wiring
- [ ] 02-02-PLAN.md — Intelligent cadence scheduler (pickNextPost) + scheduler wiring
- [ ] 02-03-PLAN.md — Admin toggles (auto-recycle, caption refresh) + Database view actions (Recycle, Block)
- [ ] 02-04-PLAN.md — Dashboard auto-recycle notice banner + undo-recycle handler
- [ ] 02-05-PLAN.md — Full test suite verification + human checkpoint

### Phase 3: Reels & Video
**Goal**: Stylists can text a video from their phone and it publishes as an Instagram Reel and Facebook Reel through the same approval flow they already know
**Depends on**: Phase 2
**Requirements**: REEL-01, REEL-02, REEL-03, REEL-04, REEL-05, REEL-06, REEL-07, REEL-08, REEL-09, REEL-10
**Success Criteria** (what must be TRUE):
  1. A stylist who texts a video receives an SMS asking for a service description, then sees a Reel caption preview — no difference in experience from a photo post
  2. After manager approval, the video publishes as a Reel on both Instagram and Facebook; failures surface with plain-English error messages via the existing error flow
  3. Analytics and the team leaderboard correctly count and score reel posts (20 pts vs 10 for standard)
  4. A tiktok.js publisher stub exists in the codebase, ready to be wired once TikTok Developer app approval is received
**Plans:** 2/4 plans executed

Plans:
- [ ] 03-01-PLAN.md — Video download utility + Express static serving + Twilio video detection
- [ ] 03-02-PLAN.md — Gamification scoring (reel=20pts) + error translations + TikTok stub + integrations card
- [ ] 03-03-PLAN.md — messageRouter video SMS flow (description prompt, caption gen, reel post creation)
- [ ] 03-04-PLAN.md — IG Reels + FB Reels publishers + scheduler wiring

### Phase 4: Reputation Manager
**Goal**: Managers can see all Google reviews in one place, send AI-drafted replies in their brand voice, and turn great reviews into Featured Review social posts — automatically
**Depends on**: Phase 3
**Requirements**: REP-01, REP-02, REP-03, REP-04, REP-05, REP-06, REP-07, REP-08, REP-09, REP-10, REP-11, REP-12
**Success Criteria** (what must be TRUE):
  1. The manager portal has a Reputation tab showing all Google reviews with rating, reviewer name, text snippet, reply status badge, and post status badge — populated automatically every 4 hours
  2. For any unresponded review, the manager can view an AI-generated reply in the salon's brand voice, edit it if needed, and send it — or enable auto-send so replies go out without manual intervention
  3. A 4-5 star review where a stylist is identified generates a Featured Review social post (star graphic + caption) that enters the standard approval queue; 5-star confirmed matches can auto-publish
  4. Reputation tab displays aggregate stats: average rating, total review count, reply rate, posts generated this month, and a 30-day rating trend sparkline

### Phase 5: Guest Care and Support Staff
**Goal**: Coordinators (receptionists/front-desk staff) can submit posts on behalf of stylists via SMS and portal, with GPT-based stylist name extraction, portal confirmation, 50% leaderboard scoring, flood protection, and tailored welcome SMS
**Depends on**: Phase 4
**Requirements**: COORD-01, COORD-02, COORD-03, COORD-04, COORD-05, COORD-06, COORD-07, COORD-08, COORD-09, COORD-10
**Success Criteria** (what must be TRUE):
  1. Coordinator texting a photo with a stylist name receives a portal link to confirm attribution; post is attributed to the named stylist with submitted_by tracking the coordinator
  2. Coordinator texting a photo without a stylist name receives a single "Who is this for?" SMS; reply continues the flow
  3. Performance page has Stylists/Coordinators tab toggle; coordinator leaderboard shows 50% of base point values
  4. "Submitted by [Coordinator] on behalf of [Stylist]" badge visible in manager approval queue and Database view
  5. Welcome SMS with posting instructions sent when coordinator is added via Team page
**Plans:** 3/3 plans complete

Plans:
- [ ] 05-01-PLAN.md — Migration 049 (submitted_by column) + savePost wiring + salonLookup coordinator detection
- [ ] 05-02-PLAN.md — messageRouter coordinator SMS branch + GPT name extraction + portal stylist dropdown + flood warning
- [ ] 05-03-PLAN.md — Coordinator leaderboard + Performance tab + welcome SMS + submitted-by badge

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Vendor Sync | 5/5 | Complete   | 2026-03-19 |
| 2. Content Engine | 4/5 | In Progress|  |
| 3. Reels & Video | 2/4 | In Progress|  |
| 4. Reputation Manager | 0/TBD | Not started | - |
| 5. Guest Care | 3/3 | Complete   | 2026-03-20 |
| 6. Content Routing | 3/3 | Complete | - |
| 7. Content Calendar View | 3/3 | Complete   | 2026-03-21 |

### Phase 6: Per-Salon Platform Content Routing

**Goal:** Salon managers control which content types publish to which platforms — per-salon routing rules stored as JSON, enforced by the scheduler, managed via the Integrations page toggle grid
**Requirements**: TBD
**Depends on:** Phase 5
**Plans:** 3/3 plans complete

Plans:
- [x] 06-01-PLAN.md — Migration 051 (platform_routing column) + platformRouting.js helper module
- [x] 06-02-PLAN.md — Content Routing card on Integrations page (toggle grid + save handler)
- [x] 06-03-PLAN.md — Scheduler routing guards + Platform Console global defaults viewer

### Phase 7: Content Calendar View

**Goal:** Managers can see all scheduled and published posts on a visual 4-week calendar, click any day to preview posts in a slide-out panel, approve/deny/post-now directly from the panel, and drag-drop posts to reschedule them (FEAT-018)
**Depends on:** Phase 6
**Requirements**: CAL-01, CAL-02, CAL-03, CAL-04, CAL-05
**Plans:** 3/3 plans complete

Plans:
- [x] 07-00-PLAN.md — Wave 0 test scaffold (calendarPillClass, date range, reschedule date math)
- [x] 07-01-PLAN.md — Calendar route + month grid with color-coded post pills + pageShell nav + server.js mount
- [x] 07-02-PLAN.md — Day panel fragment endpoint + approve/deny/post-now actions + drag-to-reschedule
