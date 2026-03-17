# Availability Post Templates — Design Document
_2026-03-17_

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

## Goal

Replace the 4 random SVG overlay styles in `buildAvailabilityImage.js` with 5 visually distinct HTML/Puppeteer templates matching the same visual family as the celebration templates. Managers pick one as their salon default from Admin → Branding and can generate a live preview without creating a post.

---

## Architecture

### Template Registry (`src/core/postTemplates.js`)

Extend the existing registry with an `availability` key:

```js
export const TEMPLATES = {
  celebration: { script, editorial, bold, luxury, minimal },  // existing
  availability: { script, editorial, bold, luxury, minimal },  // new
};

export const TEMPLATE_META = {
  celebration: { ... },  // existing
  availability: {
    script:    { label: "Handwritten Elegance", desc: "Script eyebrow · Photo-first · Slot rows" },
    editorial: { label: "Magazine Split",       desc: "White panel · Serif name · Slot list" },
    bold:      { label: "Vertical Statement",   desc: "Vertical name · Dark panel · Slots" },
    luxury:    { label: "Frosted Card",         desc: "Frosted glass card · Centered slots" },
    minimal:   { label: "Moody Centered",       desc: "Dark mood · Centered · Pill CTA" },
  },
};
```

Each availability builder is a pure function: `(opts) => HTML string`

**opts shape:**
```js
{
  width, height,          // 1080×1080 (feed) or 1080×1920 (story)
  photoDataUri,           // base64 data URI — background photo
  logoDataUri,            // base64 data URI — salon logo (nullable)
  stylistName,            // "Sarah"
  salonName,              // "Luxe Salon"
  slots,                  // string[] e.g. ["Friday: 2:00pm · Color", "Saturday: 10:00am · Haircut"]
  bookingCta,             // "Book via link in bio"
  instagramHandle,        // "@sarah_cuts" (no @) — optional
  accentHex,              // brand CTA/accent color
  bandHex,                // brand primary color for panel backgrounds (default #1a1c22)
}
```

### DB Change — Migration 037

```sql
ALTER TABLE salons ADD COLUMN availability_template TEXT DEFAULT 'script';
```

Old columns (`celebration_font_styles`, `celebration_font_index`) remain untouched.

---

## The 5 Templates

All render at 1080×1080 (feed) and 1080×1920 (story). Each handles missing photo via dark gradient fallback. All include salon logo (top-right frosted pill) and `#MostlyPostly` watermark.

| Key | Name | Visual Style |
|-----|------|-------------|
| `script` | Handwritten Elegance | Full-bleed photo, heavy bottom vignette, Great Vibes "NOW BOOKING" script eyebrow, bold sans stylist name, slot rows with accent dash, muted CTA |
| `editorial` | Magazine Split | White panel left (44%), photo right, Lato 300 "NOW AVAILABLE" tracked eyebrow, Playfair Display italic stylist name, slot list with accent dots, muted CTA |
| `bold` | Vertical Statement | Full-bleed photo, stylist name vertical left edge, dark right panel: "NOW BOOKING" eyebrow + "AVAILABLE" accent type word + slot list stacked |
| `luxury` | Frosted Card | Full-bleed darkened photo, centered frosted glass card (lower position), "Now Available" eyebrow, accent divider, Playfair italic stylist name, slot rows with rule separators, CTA |
| `minimal` | Moody Centered | Full-bleed photo brightness 0.3, all centered, thin "NOW BOOKING" caps, large thin stylist name, accent line, centered slot list, accent pill CTA |

---

## Refactor: `buildAvailabilityImage.js`

- Remove all 4 `buildOverlaySvg_*` functions and the random-selection logic
- Import `TEMPLATES` from `postTemplates.js`
- Read `salon.availability_template || "script"` from the DB
- Pass opts to `TEMPLATES.availability[template]`
- Render via `renderHtmlToJpeg` (same Puppeteer renderer as celebrations)
- Save to `public/uploads/availability/` — same path as before
- Fall back to `"script"` with `console.warn` if unknown template key

---

## Admin UI — Availability Template Selector

**Location:** Admin → Branding tab, below the existing Celebration Post Style section.

**Layout:** Same 5-card grid as celebration selector.

**Preview form:**
```html
<form method="GET" action="/manager/admin/availability-preview" target="_blank">
  <select name="template"><!-- 5 options --></select>
  <select name="stylist"><!-- salon stylists --></select>
  <button type="submit">Preview →</button>
</form>
```

No "Type" dropdown — availability posts have no birthday/anniversary distinction.

Preview uses 3 mock slots: `["Tuesday: 2:00pm · Color", "Wednesday: 10:00am · Haircut", "Friday: 3:30pm · Blowout"]`

**Save active template:**
```
POST /manager/admin/availability-template
  body: { template: "editorial" }
  → UPDATE salons SET availability_template = ? WHERE slug = ?
  → redirect back to /manager/admin#branding
```

---

## Preview Endpoint

```
GET /manager/admin/availability-preview
  ?template=editorial&stylist=<id>
```

1. Load stylist + salon from DB (validate stylist belongs to salon)
2. Resolve photo and logo paths
3. Call `buildAvailabilityImage()` with mock slots + requested template
4. `res.redirect(imageUrl)` — browser opens JPEG in new tab

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Unknown template key | Fall back to `script`, log warning |
| Stylist not found / wrong salon | Redirect to admin with `?err=` param |
| Puppeteer render failure | 500 error page |
| Missing stylist photo | Dark gradient fallback |
| Missing logo | Skip logo layer |
| Empty slots array | Show "Check back soon" placeholder row |

---

## Extensibility — Model Callouts

When model callouts are built:
- Add `TEMPLATES.model_callout = { ... }` with callout-specific layouts
- Add `model_callout_template TEXT DEFAULT 'script'` via a new migration
- Reuse the same preview endpoint with `?postType=model_callout`
- No changes to the renderer or image save path

---

## Implementation Tasks

| Task ID | Description |
|---------|-------------|
| #A | Migration 037 + add `TEMPLATES.availability` + 5 HTML builder functions to `postTemplates.js` |
| #B | Refactor `buildAvailabilityImage.js` to use registry + Puppeteer (blocked by #A) |
| #C | Admin UI: availability template selector + preview GET + save POST routes (blocked by #A, #B) |
| #D | Push to dev + main, smoke test |
