# Quick Task 260319-q5j: Vendor Frequency Controls — Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Task Boundary

Implement a three-layer vendor posting frequency control system:
1. Platform-enforced minimum gap between vendor posts (floor — non-negotiable)
2. Platform-set default + maximum cap per campaign per month (ceiling)
3. Salon-adjustable frequency cap (bounded by platform ceiling)

Also: auto-set 30-day expiration when none provided, renew button in Platform Console,
and remove tone_direction from Platform Console UI.

</domain>

<decisions>
## Implementation Decisions

### Minimum gap (floor)
- Default: **3 days** minimum between any two vendor posts per salon
- Stored in `vendor_brands.min_gap_days` (INTEGER DEFAULT 3)
- Editable only in Platform Console — salons cannot go below this
- Scheduler enforces by checking last vendor post date before creating a new one

### Platform maximum cap (ceiling)
- Default: **6 posts/month** per campaign — the max a salon can set
- Stored in `vendor_brands.platform_max_cap` (INTEGER DEFAULT 6)
- Editable only in Platform Console

### Per-campaign default frequency cap
- Change default from **4 → 3** posts/month per campaign
- Stored in `vendor_campaigns.frequency_cap` (already exists)
- Salons can adjust per-vendor in their Admin → Vendor Feeds page
- Bounded: cannot exceed `vendor_brands.platform_max_cap`

### Salon frequency control
- In Salon Admin → Vendor Feeds: per-vendor frequency input (not per-campaign)
- Stored in `salon_vendor_feeds.frequency_cap` (already exists, repurpose)
- Platform Console can see but not override individual salon settings (only brand-level floor/ceiling)
- UI shows: "Post [brand] content X times/month" with note "Platform minimum: every N days"

### Auto-expiration
- If `expires_at` is NULL or not provided at campaign insert time, auto-set to **30 days from now**
- Applied in both CSV upload path and PDF sync insert path

### Campaign renew button
- Location: Platform Console → campaign detail / campaign list per brand
- Action: extend `expires_at` by **+30 days** from current expiry (not from today)
- No auth beyond existing `requireSecret` + `requirePin`

### Tone direction removal
- Remove `tone_direction` field from Platform Console campaign create/edit UI
- Remove from CSV template column list
- Remove from OpenAI prompt construction in `generateVendorCaption()`
- Salon tone from `salons.tone` already drives voice — `tone_direction` is redundant

### Claude's Discretion
- Migration numbering (next sequential after 045)
- Exact UI layout of frequency controls in Salon Admin
- Scheduler query approach for "last vendor post date" check

</decisions>

<specifics>
## Specific Requirements

- Vendor pitch framing: platform controls the floor ("your brand is protected from overexposure"),
  salons control up to the ceiling ("high-volume Aveda salons can align with their brand identity")
- Renewal extends from current `expires_at` + 30 days, not today + 30 days (respects existing schedule)
- `tone_direction` removed from: Platform Console form, CSV template, `generateVendorCaption()` prompt
- Default `frequency_cap` on NEW campaigns changes to 3; existing campaigns unaffected by migration

</specifics>

<canonical_refs>
## Canonical References

- `src/core/vendorScheduler.js` — `processCampaign()`, `generateVendorCaption()`, `processSalon()`
- `src/routes/vendorAdmin.js` — Platform Console campaign management
- `src/routes/admin.js` — Salon Admin (Vendor Feeds section may be in vendorFeeds.js)
- `migrations/045_vendor_sync_meta.js` — reference for migration pattern
- `vendor_brands` table — add `min_gap_days`, `platform_max_cap`
- `salon_vendor_feeds` table — `frequency_cap` already exists (repurpose for salon control)
- `vendor_campaigns` table — change default `frequency_cap` from 4 to 3

</canonical_refs>
