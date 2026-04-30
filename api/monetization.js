/* global process, console, Buffer */
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
const _usageStore = [];
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
  },
  usage: {
    record: async (data) => {
      const entry = { ...data, recordedAt: Math.floor(Date.now() / 1000) };
      _usageStore.push(entry);
      return entry;
    },
    list: async (email) => {
      return email ? _usageStore.filter(e => e.email === email) : [..._usageStore];
    }
  }
};

// ─── Simulated Email ──────────────────────────────────────────────────────────
async function sendEmail(to, subject, token) {
  console.log(`[Email] Sending to ${to}...`);
  console.log(`[Email] Subject: ${subject}`);
  // Token intentionally omitted from logs — contains full license grant
  return true;
}

// ─── Lazy-load Stripe (only when keys are available) ─────────────────────────
// Uses dynamic ESM import so the module doesn't crash when stripe is absent.
async function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const { default: Stripe } = await import('stripe');
  return new Stripe(key, { apiVersion: '2023-10-16' });
}


// ─── License Token Utilities ──────────────────────────────────────────────────
// Production: env var is required. Non-production: use a random per-process
// secret so tokens never reuse a hardcoded value, and so preview deploys
// without env vars still boot.
const LICENSE_SECRET = (() => {
  if (process.env.LICENSE_JWT_SECRET) return process.env.LICENSE_JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[monetization] LICENSE_JWT_SECRET is required in production.');
  }
  const random = crypto.randomBytes(48).toString('base64url');
  console.warn(
    '[monetization] WARNING: LICENSE_JWT_SECRET not set. Using random per-process secret. ' +
    'License tokens will not validate after restart. Set LICENSE_JWT_SECRET for stability.'
  );
  return random;
})();

// Validate that a user-supplied redirect URL is safe. Accepts same-origin
// relative paths (starting with "/") or absolute URLs whose origin matches
// the request origin. Returns the trusted URL or null.
function safeRedirectUrl(candidate, originHeader) {
  if (!candidate || typeof candidate !== 'string') return null;
  try {
    if (candidate.startsWith('/') && !candidate.startsWith('//')) {
      return originHeader ? new URL(candidate, originHeader).toString() : null;
    }
    const url = new URL(candidate);
    if (!originHeader) return null;
    const origin = new URL(originHeader);
    if (url.origin !== origin.origin) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// ReDoS-safe email normalization for legacy checkout callers that pass email
// in request body. Accepts trimmed strings within sane length bounds (5..254),
// exactly one "@", and domains containing at least one dot that is not leading/
// trailing. Returns normalized email or empty string when invalid.
function normalizeCheckoutEmail(candidate) {
  if (typeof candidate !== 'string') return '';
  const email = candidate.trim();
  if (email.length < 5 || email.length > 254 || email.includes(' ')) return '';
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return '';
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return '';
  return email;
}

// Simple in-memory idempotency cache for Stripe webhook event IDs. For
// serverless or multi-instance production deployments, swap for Redis.
const _processedWebhookEvents = new Map(); // eventId → expiresAt ms
const WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function hasProcessedEvent(eventId) {
  if (!eventId) return false;
  const exp = _processedWebhookEvents.get(eventId);
  if (!exp) return false;
  if (exp < Date.now()) { _processedWebhookEvents.delete(eventId); return false; }
  return true;
}

function markEventProcessed(eventId) {
  if (!eventId) return;
  _processedWebhookEvents.set(eventId, Date.now() + WEBHOOK_DEDUP_TTL_MS);
  // Periodic eviction to bound memory
  if (_processedWebhookEvents.size > 10000) {
    const now = Date.now();
    for (const [id, exp] of _processedWebhookEvents) {
      if (exp < now) _processedWebhookEvents.delete(id);
    }
  }
}

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
    const expected = Buffer.from(expectedSig, 'base64url');
    const got = Buffer.from(parts[2], 'base64url');
    if (expected.length !== got.length) return null;
    if (!crypto.timingSafeEqual(expected, got)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Simple in-memory rate limiter ────────────────────────────────────────────
function makeRateLimiter(maxReqs, windowMs) {
  const _map = new Map(); // ip → { count, windowStart }
  return function rateLimiter(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = _map.get(key) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count++;
    _map.set(key, entry);
    if (_map.size > 5000) {
      for (const [k, v] of _map) {
        if (now - v.windowStart > windowMs * 2) _map.delete(k);
      }
    }
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }
    next();
  };
}

const activateLimiter    = makeRateLimiter(5,  60_000); // 5 activations per minute per IP
const usageRecordLimiter = makeRateLimiter(30, 60_000); // 30 usage records per minute per IP

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
// Bearer auth is preferred. When present and valid, the token email is used
// as Stripe customer_email (request body email is ignored). For backwards
// compatibility with clients that do not send Authorization yet, checkout
// still works without Bearer auth and may use request-body email if provided.
// success/cancel URLs must be same-origin; anything else is silently dropped
// in favour of the safe default.
router.post('/checkout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let payload = null;
    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      payload = validateLicenseToken(authHeader.slice(7));
      if (!payload || !payload.email) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }

    const { tier, cycle = 'monthly', successUrl, cancelUrl, email } = req.body;
    if (!tier || !['PRO', 'STUDIO', 'ENTERPRISE'].includes(tier.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid tier' });
    }
    if (tier.toUpperCase() === 'ENTERPRISE') {
      return res.json({ redirect: 'mailto:sales@voiceisolatepro.com' });
    }

    const priceKey = `${tier.toUpperCase()}_${cycle}`;
    const priceId = PRICE_IDS[priceKey];
    if (!priceId) return res.status(400).json({ error: 'Price not configured' });

    const origin = req.headers.origin || (req.get('host') ? `${req.protocol}://${req.get('host')}` : null);
    const safeSuccess =
      safeRedirectUrl(successUrl, origin) ||
      (origin ? `${origin}/app/?payment=success&session_id={CHECKOUT_SESSION_ID}` : null);
    const safeCancel =
      safeRedirectUrl(cancelUrl, origin) ||
      (origin ? `${origin}/app/?payment=cancelled` : null);
    if (!safeSuccess || !safeCancel) {
      return res.status(400).json({ error: 'Missing or invalid redirect URL' });
    }

    const stripe = await getStripe();
    const customerEmail = payload?.email || normalizeCheckoutEmail(email);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      ...(customerEmail ? { customer_email: customerEmail } : {}),
      success_url: safeSuccess,
      cancel_url: safeCancel,
      metadata: { tier: tier.toUpperCase(), cycle, userId: payload?.sub || '' },
      subscription_data: {
        metadata: { tier: tier.toUpperCase(), cycle, userId: payload?.sub || '' },
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
    const stripe = await getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Webhook Signature Error]', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Idempotency: Stripe retries on any non-2xx or network timeout. Short-
  // circuit duplicate deliveries so we don't issue licenses or send emails
  // multiple times for the same event.
  if (hasProcessedEvent(event.id)) {
    return res.json({ received: true, duplicate: true });
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
        await db.licenses.upsert({ customerId, tier });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        console.log(`[Webhook] Subscription cancelled: ${sub.customer}`);
        await db.licenses.upsert({ customerId: sub.customer, tier: 'FREE' });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log(`[Webhook] Payment failed: ${invoice.customer_email}`);
        // TODO: Send dunning email
        break;
      }
    }

    markEventProcessed(event.id);
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
router.post('/license/activate', activateLimiter, (req, res) => {
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
router.post('/usage/record', usageRecordLimiter, async (req, res) => {
  const { event: usageEvent, units = 1 } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const payload = validateLicenseToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });

  const entry = await db.usage.record({ email: payload.email, event: usageEvent, units });
  console.log(`[Usage] ${entry.email} — ${entry.event} × ${entry.units}`);
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
