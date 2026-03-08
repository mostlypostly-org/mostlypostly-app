// src/routes/billing.js
import express from "express";
import Stripe from "stripe";
import db from "../../db.js";
import pageShell from "../ui/pageShell.js";

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

const PLAN_LIMITS = {
  starter: { posts: 60,  stylists: 5,   locations: 1 },
  growth:  { posts: 200, stylists: 20,  locations: 3 },
  pro:     { posts: 500, stylists: null, locations: 5 },
  trial:   { posts: 20,  stylists: 5,   locations: 1 },
};

function requireAuth(req, res, next) {
  if (!req.session?.manager_id || !req.session?.salon_id) {
    return res.redirect("/manager/login");
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
  const offerTrial = !salon.trial_used;

  const sessionParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      ...(offerTrial ? { trial_period_days: 14 } : {}),
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
  const { salon_id } = req.session;
  const isNew   = req.query.new === "1";
  const hasTrial = req.query.trial === "1";

  // New accounts: redirect to onboarding to complete setup
  if (isNew) {
    return res.redirect(`/onboarding/salon?salon=${encodeURIComponent(salon_id)}`);
  }

  const trialMsg = hasTrial
    ? `Your 14-day free trial is active. No charge until your trial ends.<br/>We'll send a reminder before your first billing date.`
    : `Your subscription is now active. Thank you for choosing MostlyPostly!`;

  res.send(pageShell({
    title: "Subscription Active",
    current: "billing",
    salon_id,
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

router.get("/manager/billing", requireAuth, async (req, res) => {
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

  const PLAN_DETAILS = {
    starter: { monthly: 49,  annual: 44,  desc: "60 posts · 5 stylists · 1 location" },
    growth:  { monthly: 149, annual: 134, desc: "200 posts · 20 stylists · 3 locations" },
    pro:     { monthly: 249, annual: 224, desc: "500 posts · Unlimited stylists · 5 locations" },
  };

  const planCards = ["starter", "growth", "pro"].map(p => {
    const isCurrent = salon.plan === p;
    const isHinted  = planHint === p && !isCurrent;
    const d = PLAN_DETAILS[p];
    return `
      <div id="plan-card-${p}" class="rounded-xl border ${isCurrent ? "border-mpAccent bg-mpAccentLight/20" : isHinted ? "border-mpAccent ring-2 ring-mpAccent/30" : "border-mpBorder bg-mpBg"} p-5 flex flex-col">
        <div class="flex items-start justify-between">
          <p class="font-bold text-mpCharcoal capitalize">${p}</p>
          ${isCurrent ? `<span class="rounded-full bg-mpAccentLight px-2.5 py-0.5 text-[10px] font-bold text-mpAccent uppercase tracking-wide">Current</span>` : isHinted ? `<span class="rounded-full bg-mpAccentLight px-2.5 py-0.5 text-[10px] font-bold text-mpAccent uppercase tracking-wide">Recommended</span>` : ""}
        </div>
        <p class="text-2xl font-extrabold text-mpCharcoal mt-2">
          <span class="price-monthly">$${d.monthly}</span>
          <span class="price-annual hidden">$${d.annual}</span>
          <span class="text-sm font-normal text-mpMuted">/mo</span>
        </p>
        <p class="price-annual-note hidden text-[11px] text-green-600 font-medium mt-0.5">Billed $${d.annual * 12}/year — save 10%</p>
        <p class="text-xs text-mpMuted mt-1 leading-relaxed">${d.desc}</p>
        ${isCurrent
          ? `<p class="mt-4 text-xs text-mpMuted">This is your current plan.</p>`
          : `<a data-plan="${p}" data-monthly="/billing/checkout?plan=${p}&cycle=monthly" data-annual="/billing/checkout?plan=${p}&cycle=annual"
                href="/billing/checkout?plan=${p}&cycle=monthly"
                class="plan-checkout-btn mt-auto pt-4 block text-center rounded-full bg-mpCharcoal text-white text-xs font-bold py-2.5 hover:bg-mpCharcoalDark transition-colors">
                Select ${p.charAt(0).toUpperCase() + p.slice(1)}
             </a>`
        }
      </div>`;
  }).join("");

  res.send(pageShell({
    title: "Billing",
    current: "billing",
    salon_id,
    body: `
      <div class="space-y-6 max-w-3xl">

        ${isNewAccount ? `
        <div class="rounded-2xl border border-mpAccent bg-mpAccentLight/30 p-5 flex gap-4 items-start">
          <div class="mt-0.5 flex-shrink-0 w-8 h-8 rounded-full bg-mpAccent/20 flex items-center justify-center">
            <svg class="w-4 h-4 text-mpAccent" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div>
            <p class="text-sm font-bold text-mpCharcoal">Account created! Choose your plan to continue.</p>
            <p class="text-xs text-mpMuted mt-0.5">Select a plan below and enter your card details. Your 14-day free trial starts immediately — no charge until it ends.</p>
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
              <button type="button" id="cycleToggle" onclick="toggleCycle()"
                class="relative inline-flex h-6 w-11 items-center rounded-full bg-mpBorder transition-colors focus:outline-none">
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
          <p class="mt-4 text-xs text-mpMuted">${salon.trial_used ? "Cancel anytime." : "New accounts include a 14-day free trial. Cancel anytime."}</p>
        </div>

        ${planHint ? `<script>
          document.addEventListener('DOMContentLoaded', () => {
            const card = document.getElementById('plan-card-${planHint}');
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
        </script>` : ""}

        <script>
          let isAnnual = false;
          function toggleCycle() {
            isAnnual = !isAnnual;
            const thumb   = document.getElementById('cycleThumb');
            const toggle  = document.getElementById('cycleToggle');
            const lm      = document.getElementById('label-monthly');
            const la      = document.getElementById('label-annual');

            thumb.style.transform  = isAnnual ? 'translateX(1.375rem)' : 'translateX(0.25rem)';
            toggle.style.background = isAnnual ? '#D4897A' : '';
            lm.className = 'text-xs font-semibold ' + (isAnnual ? 'text-mpMuted' : 'text-mpCharcoal');
            la.className = 'text-xs font-semibold ' + (isAnnual ? 'text-mpCharcoal' : 'text-mpMuted');

            document.querySelectorAll('.price-monthly').forEach(el => el.classList.toggle('hidden', isAnnual));
            document.querySelectorAll('.price-annual').forEach(el => el.classList.toggle('hidden', !isAnnual));
            document.querySelectorAll('.price-annual-note').forEach(el => el.classList.toggle('hidden', !isAnnual));
            document.querySelectorAll('.plan-checkout-btn').forEach(btn => {
              btn.href = isAnnual ? btn.dataset.annual : btn.dataset.monthly;
            });
          }
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
        try {
          const stripe = getStripe();
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          hasTrialFromStripe = !!sub.trial_end && sub.trial_end > Math.floor(Date.now() / 1000);
        } catch {}

        const newStatus   = hasTrialFromStripe ? "trialing" : "active";
        const trialEndSql = hasTrialFromStripe ? `datetime('now', '+14 days')` : "NULL";

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
        const salon = db.prepare("SELECT slug FROM salons WHERE stripe_customer_id=?").get(obj.customer);
        if (!salon) break;
        db.prepare(`
          UPDATE salons SET plan_status='suspended', stripe_subscription_id=NULL, updated_at=datetime('now') WHERE slug=?
        `).run(salon.slug);
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
