# Celebration Templates + Preview — Design Document
_2026-03-16_

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:executing-plans to implement this plan task-by-task.

## Goal

Replace the 3 font-style checkboxes in Admin → Branding with 5 visually distinct celebration post templates. Managers pick one as their salon default and can generate a live test preview (opens in a new tab) without publishing a post.

## Architecture

### Template Registry (`src/core/postTemplates.js`)

A shared registry keyed by post type, designed to support future post types (model callouts, etc.):

```js
export const TEMPLATES = {
  celebration: {
    script:    buildHtml_script,
    editorial: buildHtml_editorial,
    bold:      buildHtml_bold,
    luxury:    buildHtml_luxury,
    minimal:   buildHtml_minimal,
  },
  // model_callout: { ... }  ← future
};
```

Each value is a pure function: `(opts) => HTML string`. The `opts` shape is the same across all templates:
```js
{ width, height, photoDataUri, logoDataUri, firstName, celebrationType, subLabel, accentHex }
```

### DB Change — Migration 036

```sql
ALTER TABLE salons ADD COLUMN celebration_template TEXT DEFAULT 'script';
```

Old columns `celebration_font_styles` and `celebration_font_index` are left in place — no data loss, easy rollback. New code ignores them.

---

## The 5 Templates

All templates render at 1080×1080 (feed) and 1080×1920 (story). Each handles missing photo via a dark gradient fallback. All include salon logo (top-right frosted pill) and `#MostlyPostly` watermark (bottom-left).

| Key | Name | Visual Style |
|-----|------|-------------|
| `script` | Handwritten Elegance | Full-bleed photo, heavy bottom vignette, Great Vibes script eyebrow, bold sans name, accent bar |
| `editorial` | Magazine Split | Photo top 58%, solid color band bottom 42%, Montserrat 800 uppercase name, wide-tracked eyebrow |
| `bold` | Vertical Statement | Full-bleed photo, name rotated 90° running vertically up left edge, right-side dark panel with eyebrow + type |
| `luxury` | Frosted Card | Full-bleed photo, centered frosted glass card mid-canvas, serif italic name, thin accent divider, milestone text |
| `minimal` | Moody Centered | Full-bleed darkened photo (brightness 0.4), all text centered, large thin-weight name, pill accent element |

---

## Admin UI — Template Selector

**Location:** Admin → Branding tab, replacing the current font style checkboxes.

**Layout:** 5-card grid (wrap on mobile). Each card:
- Template name + short descriptor ("Script font · Photo-first")
- Selected state: accent border + checkmark badge
- "Generate Preview" inline form (opens new tab)

**Preview form per card:**
```html
<form method="GET" action="/manager/admin/celebration-preview" target="_blank">
  <input type="hidden" name="template" value="editorial" />
  <select name="stylist"><!-- salon stylists --></select>
  <select name="type">
    <option value="birthday">Birthday</option>
    <option value="anniversary">Anniversary</option>
  </select>
  <button type="submit">Preview →</button>
</form>
```

**Save active template:**
```
POST /manager/admin/celebration-template
  body: { template: "editorial" }
  → UPDATE salons SET celebration_template = ? WHERE slug = ?
  → redirect back to /manager/admin#branding
```

---

## Preview Endpoint

```
GET /manager/admin/celebration-preview
  ?template=editorial&stylist=<id>&type=birthday
```

1. Load stylist + salon from DB (validate stylist belongs to salon)
2. Resolve photo and logo paths
3. Call `generateCelebrationImage({ template, ... })`
4. File saved to `public/uploads/celebrations/`
5. `res.redirect(imageUrl)` — browser opens JPEG in new tab

Preview images are ephemeral — no separate cleanup needed.

---

## Scheduler Path

`celebrationScheduler.js` reads `salon.celebration_template` (default `'script'` if null). Passes it to `generateCelebrationImage()`. The image generator looks up `TEMPLATES.celebration[template]`, falling back to `'script'` if the key is unrecognized.

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| Unknown template key | Fall back to `script`, log warning |
| Stylist not found / wrong salon | Redirect to admin with `?err=` param |
| Puppeteer render failure | 500 error page |
| Missing stylist photo | Dark gradient fallback (existing behavior) |
| Missing logo | Skip logo layer (existing behavior) |

---

## Extensibility — Model Callouts

The template registry is designed for reuse. When model callouts are built:
- Add `TEMPLATES.model_callout = { ... }` with callout-specific layouts
- Add `model_callout_template TEXT DEFAULT 'script'` to salons via a new migration
- Reuse the same preview endpoint with `?postType=model_callout`
- No changes to the renderer or image save path

---

## Implementation Tasks

| Task ID | Description |
|---------|-------------|
| #18 | Template registry (`postTemplates.js`) + migration 036 + update `generateCelebrationImage()` |
| #19 | 5 celebration template HTML builders (blocked by #18) |
| #20 | Admin template selector UI + preview endpoint + save endpoint (blocked by #18, #19) |
| #21 | Wire scheduler + error handling (blocked by #18, #19) |
