---
phase: 1
slug: vendor-sync
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.2.4 (already in package.json) |
| **Config file** | `vitest.config.mjs` — Wave 0 creates this if missing |
| **Quick run command** | `npx vitest run --reporter=verbose src/core/vendorSync.test.js` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose src/core/vendorSync.test.js`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 0 | VSYNC-03, VSYNC-08, VSYNC-10 | unit stubs | `npx vitest run src/core/vendorSync.test.js` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 0 | VSYNC-11 | unit stubs | `npx vitest run src/core/vendorConfigs.test.js` | ❌ W0 | ⬜ pending |
| 1-01-03 | 01 | 0 | VSYNC-09 | integration stub | `npx vitest run src/routes/vendorAdmin.test.js` | ❌ W0 | ⬜ pending |
| 1-02-01 | 02 | 1 | VSYNC-03 | unit | `npx vitest run src/core/vendorSync.test.js -t "dedup"` | ❌ W0 | ⬜ pending |
| 1-02-02 | 02 | 1 | VSYNC-08 | unit | `npx vitest run src/core/vendorSync.test.js -t "insert"` | ❌ W0 | ⬜ pending |
| 1-02-03 | 02 | 1 | VSYNC-10 | unit | `npx vitest run src/core/vendorSync.test.js -t "nightly guard"` | ❌ W0 | ⬜ pending |
| 1-03-01 | 03 | 1 | VSYNC-11 | unit | `npx vitest run src/core/vendorConfigs.test.js` | ❌ W0 | ⬜ pending |
| 1-04-01 | 04 | 2 | VSYNC-09 | integration | `npx vitest run src/routes/vendorAdmin.test.js -t "sync"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.mjs` — vitest is in package.json (v3.2.4) but config not found in project root; create minimal config
- [ ] `src/core/vendorSync.test.js` — stubs for VSYNC-03 (dedup), VSYNC-08 (DB insert), VSYNC-10 (nightly guard)
- [ ] `src/core/vendorConfigs.test.js` — stubs for VSYNC-11 (factory config structure)
- [ ] `src/routes/vendorAdmin.test.js` — stubs for VSYNC-09 (sync route + last_sync_at update)
- [ ] `tests/fixtures/` directory — for sample PDF fixture once obtainable

*Existing infrastructure: vitest is installed (v3.2.4). No config file found — Wave 0 must create it.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Puppeteer portal login | VSYNC-01 | Requires live AVEDA_PORTAL_USER + AVEDA_PORTAL_PASS credentials and network access to avedapurepro.com | Run vendorSync.js with headless:false and real credentials; confirm login succeeds |
| PDF search + download | VSYNC-02 | Requires live portal session and real monthly PDF | Trigger Sync Now in Platform Console staging; verify PDF downloads to temp dir |
| Image download | VSYNC-04 | Requires real PDF with real image URLs | After real PDF parse, verify images land in public/uploads/vendor/aveda/ with correct filenames |
| PDF field extraction accuracy | VSYNC-05/06/07 (overridden) | Extraction heuristics depend on actual Aveda PDF layout | Inspect parsed campaigns from a real PDF run; verify campaign name, date, caption, hashtags match source |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
