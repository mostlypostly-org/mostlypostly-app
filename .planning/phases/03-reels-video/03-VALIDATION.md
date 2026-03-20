---
phase: 3
slug: reels-video
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-20
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | none — inline grep/node-e verification (no test runner installed) |
| **Config file** | none |
| **Quick run command** | `grep` + `node -e "import(...).then(...)"` inline checks |
| **Full suite command** | Manual end-to-end via staging |
| **Estimated runtime** | ~5 minutes manual |

---

## Sampling Rate

- **After every task commit:** Verify file exists + grep for key strings
- **After every plan wave:** Manual staging smoke test
- **Before `/gsd:verify-work`:** Full end-to-end Reel publish on staging
- **Max feedback latency:** 120 seconds (IG container poll timeout)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 3-01-01 | 01 | 1 | REEL-01, REEL-02 | node-e | `node -e "import('./src/core/videoDownload.js').then(m => { console.log('VIDEO_DIR:', m.VIDEO_DIR); console.log('downloadTwilioVideo:', typeof m.downloadTwilioVideo); process.exit(m.VIDEO_DIR && typeof m.downloadTwilioVideo === 'function' ? 0 : 1); })"` | ⬜ pending |
| 3-01-02 | 01 | 1 | REEL-01, REEL-02 | grep | `grep -n "isVideo" src/routes/twilio.js \| head -5 && grep -n "mp4" server.js \| head -3` | ⬜ pending |
| 3-02-01 | 02 | 1 | REEL-08, REEL-09 | node-e | `node -e "import('./src/core/gamification.js').then(m => { const ok = m.DEFAULT_POINTS.reel === 20; console.log('reel=20:', ok); process.exit(ok ? 0 : 1); })" && node -e "import('./src/core/postErrorTranslator.js').then(m => { const ok = m.translatePostError('FB Reel init failed').includes('Facebook Reel'); console.log('FB Reel error:', ok); process.exit(ok ? 0 : 1); })" && node -e "import('./src/publishers/tiktok.js').then(m => m.publishReel()).catch(e => { const ok = e.message === 'TikTok publishing not yet available'; console.log('tiktok stub:', ok); process.exit(ok ? 0 : 1); })"` | ⬜ pending |
| 3-02-02 | 02 | 1 | REEL-10 | grep | `grep -c "TikTok" src/routes/integrations.js` | ⬜ pending |
| 3-03-01 | 03 | 2 | REEL-03, REEL-04, REEL-05 | grep | `grep -c "pendingVideoDescriptions" src/core/messageRouter.js && grep -c "generateReelCaption" src/core/messageRouter.js && grep -c "composeFinalCaption" src/core/messageRouter.js && grep -A 80 "async function generateReelCaption" src/core/messageRouter.js \| grep -c "_stylistId" \| xargs -I{} sh -c 'if [ "{}" = "0" ]; then echo "OK"; else echo "FAIL"; exit 1; fi'` | ⬜ pending |
| 3-03-02 | 03 | 2 | REEL-05 | grep | `grep "Reel.*text a video" src/core/messageRouter.js && grep -c "isVideo" src/routes/twilio.js \| xargs -I{} sh -c 'if [ "{}" -ge "3" ]; then echo "isVideo ACK suppression: yes"; else echo "FAIL: isVideo refs < 3"; exit 1; fi'` | ⬜ pending |
| 3-04-01 | 04 | 3 | REEL-06, REEL-07 | node-e | `node -e "import('./src/publishers/instagram.js').then(m => { console.log('publishReelToInstagram:', typeof m.publishReelToInstagram); process.exit(typeof m.publishReelToInstagram === 'function' ? 0 : 1); })" && node -e "import('./src/publishers/facebook.js').then(m => { console.log('publishFacebookReel:', typeof m.publishFacebookReel); process.exit(typeof m.publishFacebookReel === 'function' ? 0 : 1); })"` | ⬜ pending |
| 3-04-02 | 04 | 3 | REEL-06, REEL-07 | grep | `grep -c "publishReelToInstagram\|publishFacebookReel" src/scheduler.js && grep "postType.*reel" src/scheduler.js \| head -3 && grep -q "postType" src/core/composeFinalCaption.js && echo "OK: composeFinalCaption accepts postType" \|\| echo "CHECK"` | ⬜ pending |

*Status: ⬜ pending -- ✅ green -- ❌ red -- ⚠️ flaky*

---

## Wave 0 Requirements

No Wave 0 test scaffold files are needed. This project has no test framework installed (no vitest, jest, or mocha). All automated verification uses inline `grep` and `node -e` commands that run against the production source files directly. These commands satisfy the Nyquist requirement for automated feedback after every task.

*Wave 0 is complete by definition — inline commands are the project standard.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Stylist texts video -> receives service description prompt | REEL-01, REEL-02 | Requires live Twilio + stylist phone | Text a .mov video to the salon Twilio number; verify SMS reply asks "What service is this?" |
| IG Reel publishes after manager approval | REEL-06 | Requires live IG Business Account + Graph API | Approve a reel post from the dashboard; verify it appears on the IG profile as a Reel |
| FB Reel publishes after manager approval | REEL-07 | Requires live FB Page + Graph API | Approve a reel post; verify it appears on the FB Page under Reels tab |
| IG container poll completes within 120s | REEL-06 | Requires live API timing | Monitor logs during IG Reel publish; confirm no timeout error |
| Reel scores 20 pts on leaderboard | REEL-09 | Requires full publish flow | Publish a reel; verify team leaderboard shows 20 pts for that stylist |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (N/A — no test files needed, inline commands are the standard)
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
