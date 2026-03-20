# MostlyPostly

AI-driven social media automation for hair salons. Stylists text a photo → AI generates a branded caption → manager approves → post publishes to Facebook, Instagram, and Google Business Profile on a smart schedule. No app download required.

**Creator**: Troy Hardister — Carmel, Indiana

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js, Express.js, ES Modules |
| Database | SQLite via `better-sqlite3` (synchronous) |
| SMS/MMS | Twilio |
| AI | OpenAI GPT-4o Vision (captions), GPT-4o-mini (coordinator flows) |
| Publishing | Facebook Graph API v22.0, Instagram Graph API, Google Business Profile API v4 |
| Payments | Stripe (subscriptions + webhooks) |
| Email | Resend |
| Image gen | sharp + Pexels API (no DALL-E) |
| Hosting | Render.com — auto-deploys from `main` (production) and `dev` (staging) |
| Frontend | Server-rendered HTML + Tailwind CSS CDN |

---

## Quick Start (Local)

```bash
npm install
node server.js
```

Requires a `.env` file — see environment variables below.

---

## Environment Variables

```env
# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Telegram (optional secondary channel)
TELEGRAM_BOT_TOKEN=

# OpenAI
OPENAI_API_KEY=

# Facebook / Meta
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Google Business Profile
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# Google Places (address autocomplete at signup)
GOOGLE_PLACES_API_KEY=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER_MONTHLY=
STRIPE_PRICE_STARTER_ANNUAL=
STRIPE_PRICE_GROWTH_MONTHLY=
STRIPE_PRICE_GROWTH_ANNUAL=
STRIPE_PRICE_PRO_MONTHLY=
STRIPE_PRICE_PRO_ANNUAL=

# Image backgrounds
PEXELS_API_KEY=

# App
BASE_URL=https://app.mostlypostly.com
PUBLIC_BASE_URL=https://app.mostlypostly.com
APP_ENV=local
SESSION_SECRET=

# Email
RESEND_API_KEY=
EMAIL_FROM=hello@mostlypostly.com

# Internal admin tool
INTERNAL_SECRET=
INTERNAL_PIN=

# RCS (optional)
RCS_ENABLED=

# Promo code (sent on signup if set)
FOUNDER_PROMO_CODE=
```

`APP_ENV=local` enables JSON salon file fallback in `./salons/` for dev without a populated DB.

---

## Repository Layout

```
mostlypostly-app/
├── server.js               # Express app entry point
├── db.js                   # better-sqlite3 singleton + migration runner
├── src/
│   ├── routes/             # Express route handlers (one domain per file)
│   ├── core/               # Business logic (messageRouter, storage, AI, scheduler...)
│   ├── publishers/         # Facebook, Instagram, Google Business publishers
│   ├── ui/pageShell.js     # Shared HTML shell (sidebar nav, mobile menu)
│   └── scheduler.js        # Post scheduling engine
├── migrations/             # SQLite schema migrations (001–049+)
├── public/
│   ├── admin.js            # Client-side admin panel JS
│   └── logo/               # Logo assets
└── .render.yaml            # Render.com deployment config
```

---

## Branching & Deployment

- `main` → production (`https://app.mostlypostly.com`) — Render auto-deploys
- `dev` → staging (`https://mostlypostly-staging.onrender.com`) — Render auto-deploys
- Work on `dev`, test on staging, merge to `main` to ship
- After merging to `main`: `git checkout dev && git merge main && git push origin dev && git checkout main`

---

## Post Flow (End to End)

```
Stylist texts photo (SMS or Telegram)
  → messageRouter.js: AI caption via GPT-4o Vision
  → Stylist approves/edits/redoes via SMS
  → If manager approval required: saved as manager_pending, manager link sent
  → Manager approves in dashboard
  → enqueuePost() → scheduler picks up at next window
  → Published to Facebook + Instagram + Google Business Profile
  → Analytics synced from Graph API
```

**Coordinator flow**: A coordinator with the `coordinator` role can text on behalf of any stylist. GPT-4o-mini extracts the stylist name from the message. Coordinator can also upload via `/manager/coordinator/upload`.

---

## Plans

| Plan | Monthly | Posts/mo | Stylists | Locations |
|---|---|---|---|---|
| Starter | $49 | 60 | 4 | 1 |
| Growth | $149 | 150 | 12 | 2 |
| Pro | $249 | 400 | Unlimited | 5 |

Vendor Brand Integrations (Pro only). 7-day free trial on all plans.

---

## License

© 2026 MostlyPostly. All rights reserved.
