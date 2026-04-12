/**
 * VoiceIsolate Pro — Monetization API v22
 *
 * Endpoints:
 *   POST /api/checkout          — Create Stripe Checkout session
 *   POST /api/webhook/stripe    — Handle Stripe webhooks (subscription events)
 *   POST /api/license/validate  — Validate a license token
 *   POST /api/license/activate  — Activate license after payment
 *   GET  /api/license/status    — Get current license status for a user
 *   POST /api/usage/record      — Record API usage (for API tier billing)
 *
 * Environment variables required:
 *   STRIPE_SECRET_KEY           — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET       — Stripe webhook signing secret (whsec_...)
 *   LICENSE_JWT_SECRET          — Secret for signing license tokens
 *   STRIPE_PRICE_PRO_MONTHLY    — Stripe price ID for Pro monthly
 *   STRIPE_PRICE_PRO_ANNUAL     — Stripe price ID for Pro annual
 *   STRIPE_PRICE_STUDIO_MONTHLY — Stripe price ID for Studio monthly
 *   STRIPE_PRICE_STUDIO_ANNUAL  — Stripe price ID for Studio annual
 *
 * Install: npm install stripe jsonwebtoken
 */

import express from 'express';
import crypto from 'crypto';

const router = express.Router();


// ─── Simulated Database ───────────────────────────────────────────────────────
const _licensesStore = new Map();
const db = {
  licenses: {
    upsert: async (data) => {
      const existing = _licensesStore.get(data.customerId) || {};
      _licensesStore.set(data.customerId, { ...existing, ...data });
      return _licensesStore.get(data.customerId);
    },
    get: async (customerId) => {
      return _licensesStore.get(customerId) || null;
    }
  }
};

// ─── Simulated Email ──────────────────────────────────────────────────────────
async function sendEmail(to, subject, token) {
  console.log(`[Email] Sending to ${to}...`);
  console.log(`[Email] Subject: ${subject}`);
  console.log(`[Email] Token: ${token}`);
  return true;
}

// ─── Lazy-load Stripe (only when keys are available) ─────────────────────────
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  // Dynamic import to avoid crashing when Stripe is not installed
  const Stripe = require('stripe');
  return Stripe(key);
}

// ─── License Token Utilities ──────────────────────────────────────────────────
if (!process.env.LICENSE_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('LICENSE_JWT_SECRET environment variable is required');
  }
  process.env.LICENSE_JWT_SECRET = 'voiceisolate-dev-secret-key-minimum-32-chars';
  console.warn('[monetization] LICENSE_JWT_SECRET not set — using dev default. Do NOT use in production.');
}
const LICENSE_SECRET = process.env.LICENSE_JWT_SECRET;

function createLicenseToken(userId, email, tier, daysValid = 365) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    email,
    tier: tier.toLowerCase(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (daysValid * 86400),
    source: 'stripe',
    jti: crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function validateLicenseToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = crypto
      .createHmac('sha256', LICENSE_SECRET)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expectedSig, 'base64url'), Buffer.from(parts[2], 'base64url'))) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Tier → Price ID Mapping ──────────────────────────────────────────────────
const PRICE_TO_TIER = {
  [process.env.STRIPE_PRICE_PRO_MONTHLY]:    'PRO',
  [process.env.STRIPE_PRICE_PRO_ANNUAL]:     'PRO',
  [process.env.STRIPE_PRICE_STUDIO_MONTHLY]: 'STUDIO',
  [process.env.STRIPE_PRICE_STUDIO_ANNUAL]:  'STUDIO',
};

const PRICE_IDS = {
  PRO_monthly:    process.env.STRIPE_PRICE_PRO_MONTHLY,
  PRO_annual:     process.env.STRIPE_PRICE_PRO_ANNUAL,
  STUDIO_monthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY,
  STUDIO_annual:  process.env.STRIPE_PRICE_STUDIO_ANNUAL,
};

// ─── POST /api/checkout ───────────────────────────────────────────────────────
router.post('/checkout', async (req, res) => {
  try {
    const { tier, cycle = 'monthly', email, successUrl, cancelUrl } = req.body;
    if (!tier || !['PRO', 'STUDIO', 'ENTERPRISE'].includes(tier.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    if (tier.toUpperCase() === 'ENTERPRISE') {
      return res.json({ redirect: 'mailto:sales@voiceisolatepro.com' });
    }

    const priceKey = `${tier.toUpperCase()}_${cycle}`;
    const priceId = PRICE_IDS[priceKey];
    if (!priceId) return res.status(400).json({ error: 'Price not configured' });

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      success_url: successUrl || `${req.headers.origin}/app/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${req.headers.origin}/app/?payment=cancelled`,
      metadata: { tier: tier.toUpperCase(), cycle },
      subscription_data: {
        metadata: { tier: tier.toUpperCase(), cycle },
        trial_period_days: 14,
      },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[Checkout Error]', err.message);
    res.status(500).json({ error: 'Checkout failed. Please try again.' });
  }
});

// ─── POST /api/webhook/stripe ─────────────────────────────────────────────────
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Webhook Signature Error]', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const tier = session.metadata?.tier || 'PRO';
        const email = session.customer_email;
        const customerId = session.customer;
        const subscriptionId = session.subscription;

        // Generate license token
        const token = createLicenseToken(customerId, email, tier, 400);
        console.log(`[Webhook] New subscription: ${email} → ${tier} (${subscriptionId})`);

        // Store in database and email the token to the user
        await db.licenses.upsert({ customerId, email, tier, token, subscriptionId });
        await sendEmail(email, 'Your VoiceIsolate Pro License', token);
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data[0]?.price?.id;
        const tier = PRICE_TO_TIER[priceId] || 'PRO';
        const customerId = sub.customer;
        console.log(`[Webhook] Subscription updated: ${customerId} → ${tier}`);
        // TODO: Update license in database
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log(`[Webhook] Subscription cancelled: ${sub.customer}`);
        // TODO: Downgrade to FREE in database
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log(`[Webhook] Payment failed: ${invoice.customer_email}`);
        // TODO: Send dunning email
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook Processing Error]', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─── POST /api/license/validate ───────────────────────────────────────────────
router.post('/license/validate', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false, error: 'Token required' });

  const payload = validateLicenseToken(token);
  if (!payload) return res.json({ valid: false, error: 'Invalid or expired token' });

  res.json({
    valid: true,
    tier: payload.tier.toUpperCase(),
    email: payload.email,
    expiresAt: payload.exp * 1000,
    source: payload.source,
  });
});

// ─── POST /api/license/activate ───────────────────────────────────────────────
router.post('/license/activate', (req, res) => {
  const { token, email } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token required' });

  const payload = validateLicenseToken(token);
  if (!payload) return res.status(400).json({ success: false, error: 'Invalid or expired license' });

  res.json({
    success: true,
    tier: payload.tier.toUpperCase(),
    email: email || payload.email,
    expiresAt: payload.exp * 1000,
  });
});

// ─── GET /api/license/status ──────────────────────────────────────────────────
router.get('/license/status', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.json({ tier: 'FREE', active: false });
  }
  const token = authHeader.slice(7);
  const payload = validateLicenseToken(token);
  if (!payload) return res.json({ tier: 'FREE', active: false });

  res.json({
    tier: payload.tier.toUpperCase(),
    active: true,
    email: payload.email,
    expiresAt: payload.exp * 1000,
    daysRemaining: Math.ceil((payload.exp - Date.now() / 1000) / 86400),
  });
});

// ─── POST /api/usage/record ───────────────────────────────────────────────────
router.post('/usage/record', (req, res) => {
  const { event: usageEvent, units = 1 } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const payload = validateLicenseToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });

  // TODO: Record usage in database for metered billing
  console.log(`[Usage] ${payload.email} — ${usageEvent} × ${units}`);
  res.json({ recorded: true, event: usageEvent, units });
});

// ─── GET /api/pricing ─────────────────────────────────────────────────────────
router.get('/pricing', (req, res) => {
  res.json({
    tiers: {
      FREE:       { price: 0, priceAnnual: 0 },
      PRO:        { price: 12, priceAnnual: 99, priceIds: { monthly: PRICE_IDS.PRO_monthly, annual: PRICE_IDS.PRO_annual } },
      STUDIO:     { price: 29, priceAnnual: 249, priceIds: { monthly: PRICE_IDS.STUDIO_monthly, annual: PRICE_IDS.STUDIO_annual } },
      ENTERPRISE: { price: 199, priceAnnual: 1999, contact: 'sales@voiceisolatepro.com' },
    },
    trialDays: 14,
    moneyBackDays: 30,
  });
});

export default router;
