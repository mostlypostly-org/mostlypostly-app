// src/routes/billing.js
import express from "express";
import Stripe from "stripe";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";
import { sendCancellationEmail } from "../core/email.js";

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
}

const PLAN_PRICES = {
  starter: {
    monthly: process.env.STRIPE_PRICE_STARTER_MONTHLY,
    annual:  process.env.STRIPE_PRICE_STARTER_ANNUAL,
  },
  growth: {
    monthly: process.env.STRIPE_PRICE_GROWTH_MONTHLY,
    annual:  process.env.STRIPE_PRICE_GROWTH_ANNUAL,
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
    annual:  process.env.STRIPE_PRICE_PRO_ANNUAL,
  },
};

export const PLAN_LIMITS = {
  starter: { posts: 60,  stylists: 4,    locations: 1, managers: 0    },
  growth:  { posts: 150, stylists: 12,   locations: 2, managers: 1    },
  pro:     { posts: 400, stylists: null,  locations: 5, managers: null },
  trial:   { posts: 20,  stylists: 4,    locations: 1, managers: 0    },
};

function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) {
    return res.redirect("/manager/login");
  }
  next();
}

function requireOwner(req, res, next) {
  const mgr = db.prepare("SELECT role FROM managers WHERE id = ?").get(req.session.manager_id);
  if (!mgr || mgr.role !== "owner") {
    return res.redirect("/manager?notice=Billing+is+only+accessible+to+account+owners.");
  }
  next();
}

// ─── GET /billing/checkout?plan=starter&cycle=monthly ─────────────────────

router.get("/checkout", requireAuth, async (req, res) => {
  const { plan = "starter", cycle = "monthly" } = req.query;
  const { manager_id, salon_id } = req.session;

  const priceId = PLAN_PRICES[plan]?.[cycle];
  if (!priceId) {
    return res.status(400).send("Invalid plan or billing cycle. Check your Stripe price IDs in env vars.");
  }

  const stripe = getStripe();
  const salon  = db.prepare("SELECT name, stripe_customer_id, trial_used, status FROM salons WHERE slug=?").get(salon_id);
  const mgr    = db.prepare("SELECT email FROM managers WHERE id=?").get(manager_id);

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "http://localhost:3000";

  // Only offer trial if this salon has never activated one before
  // Founders get 30 days — revert TRIAL_DAYS to 7 after the founders window closes
  const TRIAL_DAYS = 30;
  const offerTrial = !salon.trial_used;

  const sessionParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(offerTrial ? { trial_period_days: TRIAL_DAYS } : {}),
      metadata: { salon_id, plan, cycle },
    },
    success_url: `${PUBLIC_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}${offerTrial ? "&trial=1" : ""}${salon.status === "setup_incomplete" ? "&new=1" : ""}`,
    cancel_url:  `${PUBLIC_BASE_URL}/manager/billing`,
    metadata: { salon_id, plan, cycle },
    allow_promotion_codes: true,
  };

  if (salon.stripe_customer_id) {
    sessionParams.customer = salon.stripe_customer_id;
  } else if (mgr?.email) {
    sessionParams.customer_email = mgr.email;
  }

  try {
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.redirect(303, session.url);
  } catch (err) {
    console.error("[Stripe] Checkout session error:", err.message);
    res.status(500).send("Could not create checkout session. Please try again.");
  }
});

// ─── GET /billing/success ──────────────────────────────────────────────────

router.get("/success", requireAuth, (req, res) => {
  const { salon_id, manager_id } = req.session;
  const isNew   = req.query.new === "1";
  const hasTrial = req.query.trial === "1";

  // New accounts: set pending plan_status so the plan gate passes before webhook fires,
  // then redirect to onboarding to complete setup
  if (isNew) {
    db.prepare(
      "UPDATE salons SET plan_status = COALESCE(plan_status, 'pending') WHERE slug = ?"
    ).run(salon_id);
    return res.redirect(`/onboarding/salon?salon=${encodeURIComponent(salon_id)}`);
  }

  const trialMsg = hasTrial
    ? `Your 30-day free trial is active. No charge until your trial ends.<br/>We'll send a reminder before your first billing date.`
    : `Your subscription is now active. Thank you for choosing MostlyPostly!`;

  res.send(pageShell({
    title: "Subscription Active",
    current: "billing",
    salon_id,
    manager_id,
    body: `
      <div class="max-w-lg mx-auto text-center py-16">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 mb-6">
          <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
        </div>
        <h1 class="text-2xl font-extrabold text-mpCharcoal">You're all set!</h1>
        <p class="mt-3 text-mpMuted leading-relaxed">${trialMsg}</p>
        <div class="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/manager?salon=${salon_id}" class="rounded-full bg-mpCharcoal px-8 py-3 text-sm font-bold text-white hover:bg-mpCharcoalDark transition-colors">
            Go to Dashboard →
          </a>
          <a href="/manager/billing?salon=${salon_id}" class="rounded-full border border-mpBorder bg-white px-8 py-3 text-sm font-bold text-mpCharcoal hover:bg-mpBg transition-colors">
            View Billing
          </a>
        </div>
      </div>
    `,
  }));
});

// ─── GET /manager/billing ──────────────────────────────────────────────────

router.get("/manager/billing", requireAuth, requireOwner, async (req, res) => {
  const { manager_id, salon_id } = req.session;
  const isNewAccount = req.query.new === "1";
  const planHint = ["starter","growth","pro"].includes(req.query.plan) ? req.query.plan : null;

  const salon = db.prepare(`
    SELECT name, plan, plan_status, billing_cycle, trial_ends_at, stripe_customer_id, trial_used
    FROM salons WHERE slug=?
  `).get(salon_id);

  if (!salon) return res.redirect("/manager/login");

  const limits = PLAN_LIMITS[salon.plan] || PLAN_LIMITS.trial;

  const postsThisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM posts
    WHERE salon_id=? AND status='published'
    AND strftime('%Y-%m', published_at) = strftime('%Y-%m', 'now')
  `).get(salon_id)?.count || 0;

  const usagePct  = limits.posts ? Math.min(100, Math.round((postsThisMonth / limits.posts) * 100)) : 0;
  const usageBar  = usagePct >= 100 ? "bg-red-500" : usagePct >= 80 ? "bg-yellow-400" : "bg-mpAccent";
  const usageWarn = usagePct >= 100
    ? `<p class="mt-2 text-xs font-semibold text-red-600">Post limit reached. Upgrade your plan to continue posting.</p>`
    : usagePct >= 80
    ? `<p class="mt-2 text-xs font-semibold text-yellow-600">⚠ You're at ${usagePct}% of your monthly post limit.</p>`
    : "";

  const statusBadge = {
    active:    `<span class="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700"><span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>Active</span>`,
    trialing:  `<span class="inline-flex items-center gap-1.5 rounded-full bg-mpAccentLight px-3 py-1 text-xs font-semibold text-mpAccent"><span class="w-1.5 h-1.5 rounded-full bg-mpAccent"></span>Free Trial</span>`,
    past_due:  `<span class="inline-flex items-center gap-1.5 rounded-full bg-yellow-100 px-3 py-1 text-xs font-semibold text-yellow-700"><span class="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>Past Due</span>`,
    suspended: `<span class="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700"><span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>Suspended</span>`,
  }[salon.plan_status] || `<span class="text-xs text-mpMuted">${salon.plan_status || "—"}</span>`;

  const trialNote = salon.plan_status === "trialing" && salon.trial_ends_at
    ? `Trial ends ${new Date(salon.trial_ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
    : salon.billing_cycle === "annual" ? "Annual billing" : "Monthly billing";

  // Stripe Customer Portal
  let portalUrl = null;
  if (salon.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = getStripe();
      const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "http://localhost:3000";
      const portal = await stripe.billingPortal.sessions.create({
        customer: salon.stripe_customer_id,
        return_url: `${PUBLIC_BASE_URL}/manager/billing`,
      });
      portalUrl = portal.url;
    } catch (err) {
      console.error("[Stripe] Portal session error:", err.message);
    }
  }

  // Helper: checkmark bullet
  const check = (dark) => `<span class="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${dark ? "bg-mpAccent/20 text-mpAccent" : "bg-mpAccentLight text-mpAccent"} text-[10px] font-bold">&#10003;</span>`;
  const li = (text, dark) => `<li class="flex items-start gap-2">${check(dark)}<span>${text}</span></li>`;
  const liMuted = (text, dark) => `<li class="flex items-start gap-2 ${dark ? "text-slate-400" : "text-mpMuted"}"><span class="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${dark ? "bg-white/10 text-slate-400" : "bg-mpBorder text-mpMuted"} text-[10px] font-bold">+</span><span>${text}</span></li>`;

  const PLAN_CONFIG = {
    starter: {
      monthly: 99, annual: 89,
      annualTotal: 1068, annualSave: 120,
      badge: "Single Location",
      badgeDark: false,
      tagline: "Perfect for a single-location salon getting started.",
      strikethrough: null,
      founderNote: null,
      features: [
        "<strong>60 posts</strong> per month",
        "Up to <strong>4 stylists</strong>",
        "<strong>1 location</strong>",
        "AI captions, hashtags &amp; CTAs",
        "Manager approval workflow",
        "Facebook &amp; Instagram publishing",
        "SMS + Telegram channels",
        "Brand tone, hashtags &amp; booking URL",
        "1 manager seat",
      ],
      overage: "Overage: $2.50 per 10 additional posts",
      dark: false,
    },
    growth: {
      monthly: 149, annual: 134,
      annualTotal: 1609, annualSave: 179,
      badge: "Most Popular",
      badgeDark: true,
      tagline: "For growing salons with an active team.",
      strikethrough: null,
      founderNote: null,
      features: [
        "<strong>150 posts</strong> per month",
        "Up to <strong>12 stylists</strong>",
        "<strong>1–2 locations</strong> (+$49/additional)",
        "Everything in Starter",
        "<strong>2 manager seats</strong>",
        "Future messaging channels (FB Messenger, Slack)",
        "Priority support",
      ],
      overage: "Overage: $2.00 per 10 additional posts",
      dark: true,
    },
    pro: {
      monthly: 249, annual: 224,
      annualTotal: 2689, annualSave: 299,
      badge: "Vendor Integration",
      badgeDark: false,
      tagline: "Multi-location salons and brand-aligned teams.",
      strikethrough: null,
      founderNote: null,
      features: [
        "<strong>400 posts</strong> per month",
        "<strong>Unlimited stylists</strong>",
        "<strong>Up to 5 locations</strong> (+$49/additional)",
        "Everything in Growth",
        "<strong>Unlimited manager seats</strong>",
        "All messaging channels",
        "<strong>Vendor brand integration</strong> — Aveda, Wella, Redken &amp; more",
        "Multi-location analytics",
        "Dedicated onboarding",
      ],
      overage: "Overage: $1.50 per 10 additional posts",
      dark: false,
    },
  };

  const planCards = ["starter", "growth", "pro"].map(p => {
    const isCurrent = salon.plan === p;
    const isHinted  = planHint === p && !isCurrent;
    const c = PLAN_CONFIG[p];
    const dark = c.dark;

    const bgClass = dark
      ? "border-2 border-mpCharcoal bg-mpCharcoal"
      : isCurrent
        ? "border-mpAccent bg-mpAccentLight/10"
        : isHinted
          ? "border-mpAccent ring-2 ring-mpAccent/30 bg-white"
          : "border-mpBorder bg-white";

    const badgeBg = dark ? "bg-white text-mpCharcoal" : p === "pro" ? "bg-mpCharcoal text-white" : "bg-mpAccent text-white";

    const statusBadge2 = isCurrent
      ? `<span class="rounded-full bg-mpAccentLight px-2.5 py-0.5 text-[10px] font-bold text-mpAccent uppercase tracking-wide">Current</span>`
      : isHinted
        ? `<span class="rounded-full bg-mpAccentLight px-2.5 py-0.5 text-[10px] font-bold text-mpAccent uppercase tracking-wide">Recommended</span>`
        : "";

    return `
      <div id="plan-card-${p}" class="relative rounded-xl border ${bgClass} p-5 flex flex-col">
        <!-- Badge -->
        <div class="absolute -top-3 left-4">
          <span class="rounded-full ${badgeBg} px-3 py-1 text-[10px] font-bold uppercase tracking-wide shadow-sm">${c.badge}</span>
        </div>

        <div class="mt-3 flex items-start justify-between">
          <div>
            <p class="font-bold ${dark ? "text-white" : "text-mpCharcoal"} capitalize text-base">${p.charAt(0).toUpperCase() + p.slice(1)}</p>
            <p class="text-xs ${dark ? "text-slate-400" : "text-mpMuted"} mt-0.5">${c.tagline}</p>
          </div>
          ${statusBadge2}
        </div>

        <!-- Price -->
        <div class="mt-4">
          <div class="flex items-baseline gap-2">
            ${c.strikethrough ? `<span class="text-sm font-medium text-red-400 line-through decoration-red-400">${c.strikethrough}</span>` : ""}
            <span class="price-monthly text-3xl font-extrabold ${dark ? "text-white" : "text-mpCharcoal"}">$${c.monthly}</span>
            <span class="price-annual hidden text-3xl font-extrabold ${dark ? "text-white" : "text-mpCharcoal"}">$${c.annual}</span>
            <span class="text-sm ${dark ? "text-slate-400" : "text-mpMuted"}">/mo</span>
          </div>
          <p class="price-annual-note hidden text-[11px] ${dark ? "text-slate-400" : "text-mpMuted"} mt-0.5">
            Billed as <strong class="${dark ? "text-white" : "text-mpCharcoal"}">$${c.annualTotal.toLocaleString()}/yr</strong> — save $${c.annualSave} vs monthly
          </p>
          ${c.founderNote ? `<p class="mt-1 text-[11px] text-mpAccent font-semibold">${c.founderNote}</p>` : `<p class="mt-1 invisible text-[11px]">&#8203;</p>`}
        </div>

        <!-- Features -->
        <ul class="mt-5 space-y-2 text-xs ${dark ? "text-slate-200" : "text-mpCharcoal"} flex-1">
          ${c.features.map(f => li(f, dark)).join("")}
          ${liMuted(c.overage, dark)}
        </ul>

        <!-- CTA -->
        ${isCurrent
          ? `<p class="mt-5 text-xs ${dark ? "text-slate-400" : "text-mpMuted"} text-center">This is your current plan.</p>`
          : `<a data-plan="${p}"
                data-monthly="/billing/checkout?plan=${p}&cycle=monthly"
                data-annual="/billing/checkout?plan=${p}&cycle=annual"
                href="/billing/checkout?plan=${p}&cycle=monthly"
                class="plan-checkout-btn mt-5 block text-center rounded-full text-xs font-bold py-2.5 transition-colors
                  ${dark ? "bg-mpAccent text-white hover:bg-[#2E5E9E] shadow-lg" : "border-2 border-mpCharcoal bg-white text-mpCharcoal hover:bg-mpBg"}">
                Select ${p.charAt(0).toUpperCase() + p.slice(1)} →
             </a>`
        }
      </div>`;
  }).join("");

  res.send(pageShell({
    title: "Billing",
    current: "billing",
    salon_id,
    manager_id: req.session.manager_id,
    body: `
      <div class="space-y-6 max-w-3xl">

        ${isNewAccount ? `
        <div class="rounded-2xl border border-mpAccent bg-mpAccentLight/30 p-5 flex gap-4 items-start">
          <div class="mt-0.5 flex-shrink-0 w-8 h-8 rounded-full bg-mpAccent/20 flex items-center justify-center">
            <svg class="w-4 h-4 text-mpAccent" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div>
            <p class="text-sm font-bold text-mpCharcoal">Account created! Choose your plan to continue.</p>
            <p class="text-xs text-mpMuted mt-0.5">Select a plan below and enter your card details. Your 30-day free trial starts immediately — no charge until it ends.</p>
          </div>
        </div>` : ""}

        <div>
          <h1 class="text-2xl font-extrabold text-mpCharcoal">Billing &amp; Plan</h1>
          <p class="mt-1 text-sm text-mpMuted">Manage your subscription, usage, and payment method.</p>
        </div>

        <!-- Current Plan Card -->
        <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-widest text-mpMuted mb-3">Current Plan</p>
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div class="flex items-center gap-3 flex-wrap">
                <span class="text-xl font-extrabold text-mpCharcoal capitalize">${salon.plan || "Trial"}</span>
                ${statusBadge}
              </div>
              <p class="mt-1 text-sm text-mpMuted">${trialNote}</p>
            </div>
            <div class="flex gap-2 flex-wrap">
              ${portalUrl ? `<a href="${portalUrl}" target="_blank" rel="noopener" class="rounded-full border border-mpBorder bg-mpBg px-5 py-2 text-sm font-semibold text-mpCharcoal hover:border-mpAccent transition-colors">Manage Payment &amp; Invoices →</a>` : ""}
            </div>
          </div>
        </div>

        <!-- Usage Card -->
        <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
          <p class="text-xs font-bold uppercase tracking-widest text-mpMuted mb-4">Usage This Month</p>
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-semibold text-mpCharcoal">Posts Published</span>
              <span class="text-sm font-bold text-mpCharcoal">${postsThisMonth} / ${limits.posts ?? "∞"}</span>
            </div>
            <div class="h-2.5 w-full rounded-full bg-mpBg border border-mpBorder overflow-hidden">
              <div class="h-full rounded-full ${usageBar} transition-all" style="width:${usagePct}%"></div>
            </div>
            ${usageWarn}
          </div>
          <div class="mt-4 pt-4 border-t border-mpBorder grid grid-cols-2 gap-4 text-sm">
            <div>
              <p class="text-mpMuted text-xs">Stylists</p>
              <p class="font-semibold text-mpCharcoal mt-0.5">${limits.stylists ?? "Unlimited"} max</p>
            </div>
            <div>
              <p class="text-mpMuted text-xs">Locations</p>
              <p class="font-semibold text-mpCharcoal mt-0.5">${limits.locations} max</p>
            </div>
          </div>
        </div>

        <!-- Plan Options -->
        <div class="rounded-2xl border border-mpBorder bg-white p-6 shadow-sm">
          <div class="flex items-center justify-between flex-wrap gap-3 mb-5">
            <p class="text-xs font-bold uppercase tracking-widest text-mpMuted">Plans</p>
            <!-- Monthly / Annual toggle -->
            <div class="flex items-center gap-3">
              <span id="label-monthly" class="text-xs font-semibold text-mpCharcoal">Monthly</span>
              <button type="button" id="cycleToggle"
                class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none" style="background-color:#E2E8F0">
                <span id="cycleThumb" class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform translate-x-1"></span>
              </button>
              <span id="label-annual" class="text-xs font-semibold text-mpMuted">
                Annual <span class="text-green-600 font-bold">–10%</span>
              </span>
            </div>
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            ${planCards}
          </div>
          <p class="mt-4 text-xs text-mpMuted">${salon.trial_used ? "Cancel anytime." : "New accounts include a 30-day free trial. Cancel anytime."}</p>
        </div>

        ${planHint ? `<script>
          document.addEventListener('DOMContentLoaded', () => {
            const card = document.getElementById('plan-card-${planHint}');
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        </script>` : ""}

        <script>
          (function() {
            var annual = false;
            function applyToggle() {
              var toggle = document.getElementById('cycleToggle');
              var thumb  = document.getElementById('cycleThumb');
              var lm     = document.getElementById('label-monthly');
              var la     = document.getElementById('label-annual');
              if (!toggle) return;
              toggle.style.backgroundColor = annual ? '#3B72B9' : '#E2E8F0';
              thumb.style.transform = annual ? 'translateX(1.375rem)' : 'translateX(0.25rem)';
              lm.style.fontWeight = annual ? '400' : '700';
              la.style.fontWeight = annual ? '700' : '400';
              lm.style.color = annual ? '#6B7280' : '#2B2D35';
              la.style.color = annual ? '#2B2D35' : '#6B7280';
              document.querySelectorAll('.price-monthly').forEach(function(el) { el.style.display = annual ? 'none' : ''; });
              document.querySelectorAll('.price-annual').forEach(function(el) { el.style.display = annual ? '' : 'none'; });
              document.querySelectorAll('.price-annual-note').forEach(function(el) { el.style.display = annual ? '' : 'none'; });
              document.querySelectorAll('.plan-checkout-btn').forEach(function(btn) {
                btn.href = annual ? btn.dataset.annual : btn.dataset.monthly;
              });
            }
            document.addEventListener('DOMContentLoaded', function() {
              // Hide annual prices initially (they start with class="hidden" but ensure via JS too)
              document.querySelectorAll('.price-annual,.price-annual-note').forEach(function(el) { el.style.display = 'none'; });
              var btn = document.getElementById('cycleToggle');
              if (btn) {
                btn.addEventListener('click', function() {
                  annual = !annual;
                  applyToggle();
                });
              }
            });
          })();
        </script>

      </div>
    `,
  }));
});

// ─── Stripe Webhook Handler (exported for early mounting in server.js) ─────
// IMPORTANT: This must be mounted BEFORE bodyParser in server.js
// using: app.post('/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler)

export async function stripeWebhookHandler(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[Stripe] Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const obj = event.data.object;

  try {
    switch (event.type) {

      case "checkout.session.completed": {
        const salon_id = obj.metadata?.salon_id;
        const plan     = obj.metadata?.plan || "starter";
        const cycle    = obj.metadata?.cycle || "monthly";
        if (!salon_id) break;

        // Determine if Stripe actually granted a trial on this subscription
        let hasTrialFromStripe = false;
        let trialEndIso = null;
        try {
          const stripe = getStripe();
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          hasTrialFromStripe = !!sub.trial_end && sub.trial_end > Math.floor(Date.now() / 1000);
          if (hasTrialFromStripe) {
            trialEndIso = new Date(sub.trial_end * 1000).toISOString();
          }
        } catch {}

        const newStatus   = hasTrialFromStripe ? "trialing" : "active";
        const trialEndSql = hasTrialFromStripe ? `'${trialEndIso}'` : "NULL";

        db.prepare(`
          UPDATE salons SET
            stripe_customer_id     = ?,
            stripe_subscription_id = ?,
            plan                   = ?,
            plan_status            = '${newStatus}',
            billing_cycle          = ?,
            trial_ends_at          = ${trialEndSql},
            trial_used             = 1,
            updated_at             = datetime('now')
          WHERE slug = ?
        `).run(obj.customer, obj.subscription, plan, cycle, salon_id);
        console.log(`[Stripe] checkout.session.completed: ${salon_id} → plan=${plan} status=${newStatus}`);
        break;
      }

      case "customer.subscription.updated": {
        const salon = db.prepare("SELECT slug FROM salons WHERE stripe_customer_id=?").get(obj.customer);
        if (!salon) break;
        const status = { trialing: "trialing", active: "active", past_due: "past_due" }[obj.status] || "suspended";
        db.prepare(`
          UPDATE salons SET plan_status=?, stripe_subscription_id=?, updated_at=datetime('now') WHERE slug=?
        `).run(status, obj.id, salon.slug);
        console.log(`[Stripe] subscription.updated: ${salon.slug} → ${status}`);
        break;
      }

      case "invoice.paid": {
        const salon = db.prepare("SELECT slug FROM salons WHERE stripe_customer_id=?").get(obj.customer);
        if (!salon) break;
        db.prepare(`UPDATE salons SET plan_status='active', updated_at=datetime('now') WHERE slug=?`).run(salon.slug);
        console.log(`[Stripe] invoice.paid: ${salon.slug} → active`);
        break;
      }

      case "invoice.payment_failed": {
        const salon = db.prepare("SELECT slug FROM salons WHERE stripe_customer_id=?").get(obj.customer);
        if (!salon) break;
        db.prepare(`UPDATE salons SET plan_status='past_due', updated_at=datetime('now') WHERE slug=?`).run(salon.slug);
        console.log(`[Stripe] invoice.payment_failed: ${salon.slug} → past_due`);
        break;
      }

      case "customer.subscription.deleted": {
        const salon = db.prepare("SELECT slug, name FROM salons WHERE stripe_customer_id=?").get(obj.customer);
        if (!salon) break;
        // Store access end date (current_period_end from the sub object)
        const accessEndsAt = obj.current_period_end
          ? new Date(obj.current_period_end * 1000).toISOString()
          : null;
        db.prepare(`
          UPDATE salons SET plan_status='suspended', stripe_subscription_id=NULL,
            subscription_ends_at=?, updated_at=datetime('now') WHERE slug=?
        `).run(accessEndsAt, salon.slug);
        // Send cancellation email to the owner
        const owner = db.prepare("SELECT name, email FROM managers WHERE salon_id=? AND email_verified=1 ORDER BY rowid LIMIT 1").get(salon.slug);
        if (owner?.email) {
          sendCancellationEmail({ to: owner.email, name: owner.name, accessEndsAt }).catch(() => {});
        }
        console.log(`[Stripe] subscription.deleted: ${salon.slug} → suspended`);
        break;
      }

      default:
        // Unhandled event type — not an error
        break;
    }
  } catch (err) {
    console.error(`[Stripe] Webhook handler error (${event.type}):`, err.message);
    // Return 200 anyway so Stripe doesn't retry — the error is ours to fix
  }

  res.json({ received: true });
}

export default router;
