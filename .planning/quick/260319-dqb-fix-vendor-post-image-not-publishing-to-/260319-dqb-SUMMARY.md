# Quick Task 260319-dqb — Summary

**Task:** Fix vendor post image not publishing to social platforms — image shows in queue and dashboard but not sent to FB/IG at publish time

**Date:** 2026-03-19
**Commit:** 86319c9

## Root Cause

`src/publishers/facebook.js` had a silent fallback: when the Facebook Graph API's URL-based photo upload failed (Facebook's CDN couldn't fetch the image), the publisher would quietly fall back to a text-only feed post. No error was thrown, no retry was triggered, and no manager SMS was sent.

This caused vendor campaign posts to publish successfully as text+hashtags — but with no image. The `posts` table showed `status='published'` and `fb_post_id` was set (from the text-only fallback post), making the failure invisible.

## What Changed

**`src/publishers/facebook.js` — `publishToFacebook`:**

1. **URL-based upload still tried first** (no behavior change for working posts)
2. **New binary upload fallback** — if the URL method fails for a self-hosted image (URL starts with `PUBLIC_BASE_URL`), the publisher now:
   - Downloads the image bytes from our own server via `fetch(imageUrl)`
   - POSTs them directly to Facebook's `/photos` endpoint as multipart form data
   - This bypasses any issue with Facebook's CDN accessing our URL
3. **Error is thrown instead of text-only fallback** — if both URL and binary methods fail, or if the URL is external, the publisher throws. The scheduler's retry mechanism then kicks in, and after 3 retries the manager gets an SMS with the actual error message.
4. **Text-only path preserved** — when no `imageUrl` is provided at all, the text-only feed post still works as before

## Why Standard Posts Were Unaffected

Standard posts (stylist SMS photos) go through `rehostTwilioMedia` which always produces a fresh `.jpg` at a clean URL. If those URL uploads work, the binary fallback path is never hit.

## Files Changed

- `src/publishers/facebook.js` — 50 additions, 10 deletions
