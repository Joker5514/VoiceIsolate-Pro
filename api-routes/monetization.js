/**
 * VoiceIsolate Pro — Monetization API v22
 *
 * Endpoints:
 *   POST /api/checkout          — Create Stripe Checkout session
 *   POST /api/webhook/stripe    — Handle Stripe webhooks (subscription events)
 *   POST /api/license/claim     — Deliver a license for a paid Checkout session
 *   POST /api/license/refresh   — Renew a token while the subscription is active
 *   POST /api/license/validate  — Validate a license token
 *   POST /api/license/activate  — Activate license after payment
 *   GET  /api/license/status    — Get current license status for a user
 *   POST /api/usage/record      — Record API usage (for API tier billing)
 *
 * Access is decided by the customer's current entitlement record in the
 * durable store (api-routes/store.js, VIP_DATA_DIR), kept current by Stripe
 * webhooks; tokens are short-lived identity credentials (entitlements.js).
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
 *   VIP_DATA_DIR                — Persistent directory for the license store
 *   STRIPE_API_BASE             — Dev/test only: loopback fake Stripe API for the
 *                                 e2e smoke (refused unless NODE_ENV=development|test)
 */

import express from 'express';
import { getStore } from './store.js';
import {
  licenseSecret,
  createLicenseToken,
  verifyLicenseToken,
  resolveEntitlement,
  bearer,
} from './entitlements.js';

const router = express.Router();

// Fail fast at start-up in production without a signing secret.
licenseSecret();

// ─── Persistence gate ────────────────────────────────────────────────────────
// Licenses, the webhook ledger, the delivery outbox and usage live in the
// durable store (api-routes/store.js). Without one (production without
// VIP_DATA_DIR) these endpoints refuse instead of keeping paid state in RAM.
function requireStore(req, res, next) {
  const store = getStore();
  if (!store) {
    return res.status(503).json({ error: 'Licensing is unavailable: persistent storage is not configured.' });
  }
  req.store = store;
  next();
}

// ─── Lazy-load Stripe (only when keys are available) ─────────────────────────
// Uses dynamic ESM import so the module doesn't crash when stripe is absent.
let _stripeOverride = null;
async function getStripe() {
  if (_stripeOverride) return _stripeOverride;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const { default: Stripe } = await import('stripe');
  return new Stripe(key, { apiVersion: '2023-10-16', ...stripeApiBase() });
}

/**
 * STRIPE_API_BASE points the real SDK at a local fake Stripe API for the
 * end-to-end smoke (scripts/monetization-e2e.mjs). Allowed only for a loopback
 * host under NODE_ENV development/test, so a misconfigured deploy can never send
 * payment calls anywhere but Stripe.
 */
export function stripeApiBase() {
  const base = process.env.STRIPE_API_BASE;
  if (!base) return {};
  // Fail closed: only an explicit dev/test environment, only a loopback host.
  if (!['development', 'test'].includes(process.env.NODE_ENV)) {
    throw new Error('STRIPE_API_BASE is only allowed when NODE_ENV is development or test');
  }
  const u = new URL(base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('STRIPE_API_BASE must point at a loopback host');
  }
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol.replace(':', ''),
  };
}

/** Tests only: a stand-in Stripe client (never set in production code paths). */
export function _setStripeForTests(stripe) {
  _stripeOverride = stripe;
}

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
const claimLimiter       = makeRateLimiter(10, 60_000); // 10 claims/refreshes per minute per IP
const usageRecordLimiter = makeRateLimiter(30, 60_000); // 30 usage records per minute per IP
const validateLimiter    = makeRateLimiter(20, 60_000); // 20 validations per minute per IP
const statusLimiter      = makeRateLimiter(20, 60_000); // 20 status checks per minute per IP

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
router.post('/checkout', requireStore, async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let payload = null;
    if (authHeader) {
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      payload = verifyLicenseToken(authHeader.slice(7));
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
// Each event is applied in one store transaction together with its ledger
// entry: a crash before the commit leaves nothing applied and Stripe's retry
// reprocesses it; a committed event is acknowledged as a duplicate on retry,
// across restarts. Events older than the record's last applied event are
// ledgered but not applied (Stripe does not guarantee delivery order).
router.post('/webhook/stripe', requireStore, async (req, res) => {
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

  try {
    const outcome = await req.store.transact((state) => {
      if (state.processedEvents[event.id]) return 'duplicate';
      applyStripeEvent(state, event);
      state.processedEvents[event.id] = Date.now();
      return 'applied';
    });
    res.json(outcome === 'duplicate' ? { received: true, duplicate: true } : { received: true });
  } catch (err) {
    console.error('[Webhook Processing Error]', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/** Apply one verified Stripe event to the store draft (no I/O). */
function applyStripeEvent(state, event) {
  const at = Number(event.created) || Math.floor(Date.now() / 1000);
  const upsert = (customerId, patch) => {
    if (!customerId) return;
    const prev = state.licenses[customerId];
    if (prev && prev.lastEventAt && at < prev.lastEventAt) return; // stale, out of order
    // event.created has one-second resolution, so a tie cannot order two
    // events. A cancellation is never undone by a same-second event: an older
    // "active" update delivered after the deletion must not restore access.
    if (prev && at === prev.lastEventAt && prev.status === 'canceled' && patch.status !== 'canceled') return;
    state.licenses[customerId] = { ...(prev || { customerId }), ...patch, lastEventAt: at, updatedAt: Date.now() };
  };
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const email = obj.customer_details?.email || obj.customer_email || '';
      upsert(obj.customer, {
        email,
        tier: (obj.metadata?.tier || 'PRO').toUpperCase(),
        status: 'active',
        subscriptionId: obj.subscription || null,
      });
      // Delivery is by Stripe-verified claim (POST /license/claim). The outbox
      // records the issuance for a mail transport; no transport is configured,
      // so nothing claims an email was sent.
      state.outbox.push({ type: 'license-issued', customerId: obj.customer, email, at, status: 'pending' });
      console.log(`[Webhook] New subscription: ${obj.customer} → ${obj.metadata?.tier || 'PRO'}`);
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const priceId = obj.items?.data?.[0]?.price?.id;
      const tier = PRICE_TO_TIER[priceId] || state.licenses[obj.customer]?.tier || 'PRO';
      upsert(obj.customer, { tier, status: obj.status || 'active', subscriptionId: obj.id || null });
      console.log(`[Webhook] Subscription ${obj.status}: ${obj.customer} → ${tier}`);
      break;
    }
    case 'customer.subscription.deleted':
      upsert(obj.customer, { tier: 'FREE', status: 'canceled' });
      console.log(`[Webhook] Subscription cancelled: ${obj.customer}`);
      break;
    case 'invoice.payment_failed':
      if (state.licenses[obj.customer]) upsert(obj.customer, { status: 'past_due' });
      console.log(`[Webhook] Payment failed: ${obj.customer}`);
      break;
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      if (state.licenses[obj.customer]?.status === 'past_due') upsert(obj.customer, { status: 'active' });
      break;
    default:
      break;
  }
}

// ─── POST /api/license/claim ──────────────────────────────────────────────────
// License delivery: the checkout success URL carries the session id. Stripe is
// asked whether that session completed and was paid; the token is minted from
// the webhook-maintained record, so an unpaid or unknown session gets nothing.
router.post('/license/claim', claimLimiter, requireStore, async (req, res) => {
  const sessionId = req.body?.sessionId;
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{6,255}$/.test(sessionId)) {
    return res.status(400).json({ error: 'sessionId required' });
  }
  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session?.status === 'complete'
      && ['paid', 'no_payment_required'].includes(session.payment_status);
    if (!paid || !session.customer) return res.status(402).json({ error: 'Checkout is not complete.' });
    const rec = (await req.store.read()).licenses[session.customer];
    if (!rec) return res.status(409).json({ error: 'Payment received; the license is still being provisioned. Retry shortly.' });
    if (!['active', 'trialing'].includes(rec.status)) return res.status(403).json({ error: 'Subscription is not active.' });
    const token = createLicenseToken({ customerId: rec.customerId, email: rec.email, tier: rec.tier });
    res.json({ token, tier: rec.tier, expiresAt: verifyLicenseToken(token).exp * 1000 });
  } catch (err) {
    console.error('[License Claim Error]', err.message);
    res.status(502).json({ error: 'Could not verify the checkout session.' });
  }
});

// ─── POST /api/license/refresh ────────────────────────────────────────────────
router.post('/license/refresh', claimLimiter, requireStore, async (req, res) => {
  const ent = await resolveEntitlement(req.store, bearer(req));
  if (!ent) return res.status(401).json({ error: 'Invalid or expired token' });
  if (!ent.active) return res.status(403).json({ error: 'Subscription is not active.', tier: ent.tier });
  const token = createLicenseToken({ customerId: ent.customerId, email: ent.email, tier: ent.tier });
  res.json({ token, tier: ent.tier, expiresAt: verifyLicenseToken(token).exp * 1000 });
});

// ─── POST /api/license/validate ───────────────────────────────────────────────
// Valid means the signature checks out AND the customer's current record
// entitles them; the tier reported is the record's, not the token's.
router.post('/license/validate', validateLimiter, requireStore, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ valid: false, error: 'Token required' });
  const ent = await resolveEntitlement(req.store, token);
  if (!ent) return res.json({ valid: false, error: 'Invalid or expired token' });
  if (!ent.active) return res.json({ valid: false, tier: 'FREE', error: 'Subscription is not active' });
  res.json({
    valid: true,
    tier: ent.tier,
    email: ent.email,
    expiresAt: ent.payload.exp * 1000,
    source: ent.payload.source,
  });
});

// ─── POST /api/license/activate ───────────────────────────────────────────────
router.post('/license/activate', activateLimiter, requireStore, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: 'Token required' });
  const ent = await resolveEntitlement(req.store, token);
  if (!ent) return res.status(400).json({ success: false, error: 'Invalid or expired license' });
  if (!ent.active) return res.status(403).json({ success: false, error: 'Subscription is not active' });
  res.json({ success: true, tier: ent.tier, email: ent.email, expiresAt: ent.payload.exp * 1000 });
});

// ─── GET /api/license/status ──────────────────────────────────────────────────
router.get('/license/status', statusLimiter, requireStore, async (req, res) => {
  const ent = await resolveEntitlement(req.store, bearer(req));
  if (!ent || !ent.active) return res.json({ tier: 'FREE', active: false });
  res.json({
    tier: ent.tier,
    active: true,
    email: ent.email,
    expiresAt: ent.payload.exp * 1000,
    daysRemaining: Math.ceil((ent.payload.exp - Date.now() / 1000) / 86400),
  });
});

// ─── POST /api/usage/record ───────────────────────────────────────────────────
router.post('/usage/record', usageRecordLimiter, requireStore, async (req, res) => {
  const { event: usageEvent, units = 1 } = req.body || {};
  const ent = await resolveEntitlement(req.store, bearer(req));
  if (!ent || !ent.active) return res.status(401).json({ error: 'Invalid token' });

  if (typeof usageEvent !== 'string' || usageEvent.length === 0 || usageEvent.length > 128 ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(usageEvent)) {
    return res.status(400).json({ error: 'Invalid event name' });
  }
  const safeUnits = Number(units);
  if (!Number.isInteger(safeUnits) || safeUnits < 1 || safeUnits > 100_000) {
    return res.status(400).json({ error: 'units must be a positive integer (max 100000)' });
  }

  await req.store.transact((state) => {
    state.usage.push({ customerId: ent.customerId, event: usageEvent, units: safeUnits, recordedAt: Math.floor(Date.now() / 1000) });
  });
  res.json({ recorded: true, event: usageEvent, units: safeUnits });
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
