/**
 * VoiceIsolate Pro — API Router v22
 *
 * Mounts all API routes on the Express server.
 * Import this router from server.js or api/handler.js using:
 *   import apiRouter from './api-routes/index.js'
 * Then: app.use('/api', apiRouter)
 *
 * Routes:
 *   /api/client-config     → Browser-safe runtime config (RC public SDK keys)
 *   /api/checkout          → Stripe Checkout session creation
 *   /api/webhook/stripe    → Stripe webhook handler
 *   /api/license/*         → License validation and activation
 *   /api/usage/*           → Usage recording for metered billing
 *   /api/pricing           → Public pricing info
 *   /api/sync/*            → Cloud sync (Studio/Enterprise)
 *   /api/health            → Health check
 */

import express from 'express';
import monetizationRouter from './monetization.js';
import syncRouter from './sync.js';
import clientConfigHandler from './client-config.js';
import { getStore, storeReadiness } from './store.js';
import { drainOutbox, getMailTransport, mailTransportStatus } from './mailer.js';

const router = express.Router();

// ─── Rate limiting (best-effort) ──────────────────────────────────────────────
// Tight buckets on the abuse-prone endpoints (login, checkout). For serverless
// or multi-instance deploys, back this with Redis/Upstash — the in-memory
// limiter below only protects a single Node process.
let checkoutLimiter = (_req, _res, next) => next();
try {
  const { default: rateLimit } = await import('express-rate-limit');
  checkoutLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many checkout attempts. Try again later.' },
  });
} catch {
  console.warn('[api] express-rate-limit not installed; rate limiting disabled.');
}

// ─── Runtime Client Config ────────────────────────────────────────────────────
router.get('/client-config', clientConfigHandler);

// ─── Health Check ─────────────────────────────────────────────────────────────
// Liveness plus truthful readiness. "configured" means the variables are set;
// nothing here contacts Stripe, so it never claims a provider is reachable.
// Paid features need a signing secret, Stripe, and a durable store. Email only
// confirms the purchase; license delivery is by Stripe-verified claim.
router.get('/health', (req, res) => {
  const store = storeReadiness();
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
  const signing = process.env.LICENSE_JWT_SECRET ? 'configured' : 'ephemeral';
  res.json({
    status: 'ok',
    version: '25.0.2',
    timestamp: new Date().toISOString(),
    services: {
      stripe: { configured: stripeConfigured },
      license: { signing, ready: signing === 'configured' && store.ready },
      store,
      licenseDelivery: stripeConfigured && store.durable && signing === 'configured' ? 'claim' : 'unavailable',
      email: mailTransportStatus(),
      sync: { ready: signing === 'configured' && store.ready, multiInstanceSafe: store.multiInstanceSafe },
      nim: 'not-available',
    },
  });
});

// ─── Request body budgets ─────────────────────────────────────────────────────
// Each route family gets exactly one parser with an explicit limit, chosen
// before any body is read. A global default parser used to run first, so the
// sync router's 1 MB and NIM's 50 MB limits never applied (bodies over 100 KB
// were rejected before reaching them).
export const BODY_LIMITS = Object.freeze({
  webhook: '512kb', // Stripe event payloads (raw, for signature verification)
  sync: '1mb',      // presets / noise profiles; per-user quota enforced in sync.js
  default: '100kb', // checkout, license, usage
});
router.use('/webhook/stripe', express.raw({ type: 'application/json', limit: BODY_LIMITS.webhook }));
router.use('/sync', express.json({ limit: BODY_LIMITS.sync }));
const defaultJson = express.json({ limit: BODY_LIMITS.default });
router.use((req, res, next) => {
  // /nim answers 501 without reading a body; the others have their own parser.
  if (/^\/(webhook\/stripe|sync|nim)(\/|$)/.test(req.path)) return next();
  return defaultJson(req, res, next);
});

// Attach limiters to the abuse-prone paths before the routers mount
router.use('/checkout', checkoutLimiter);

// ─── Monetization Routes ──────────────────────────────────────────────────────
router.use('/', monetizationRouter);

// NOTE: There is intentionally no /api/auth router. Username/password auth
// with seeded users was removed by design — see CLAUDE.md §3. Do not re-add.

// ─── NIM Integration (lazy — gRPC modules loaded on first request only) ─────
let _nimRouterPromise = null;
router.use('/nim', async (req, res, next) => {
  try {
    if (!_nimRouterPromise) _nimRouterPromise = import('./nim/index.js');
    const { default: nimRouter } = await _nimRouterPromise;
    nimRouter(req, res, next);
  } catch (err) {
    _nimRouterPromise = null;
    next(err);
  }
});

// ─── Cloud Sync Routes ────────────────────────────────────────────────────────
router.use('/sync', syncRouter);

// ─── Terminal error middleware ────────────────────────────────────────────────
// Swallows unhandled route errors into a stable JSON shape so upstream clients
// don't receive Express default HTML error pages or leak stack traces.
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, _next) => {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const payload = { error: 'Internal server error' };
  // Body-parser failures are the client's: say which, in the same JSON shape.
  if (err?.type === 'entity.too.large') payload.error = 'Request body too large';
  else if (err?.type === 'entity.parse.failed') payload.error = 'Malformed JSON body';
  else if (status >= 400 && status < 500) payload.error = 'Bad request';
  if (process.env.NODE_ENV !== 'production' && err?.message) {
    payload.message = err.message;
  }
  try {
    console.error('[api] unhandled error', {
      path:   req.originalUrl,
      method: req.method,
      status,
      msg:    err?.message,
      stack:  err?.stack?.split('\n').slice(0, 5).join('\n'),
    });
  } catch { /* logging must never throw */ }
  if (!res.headersSent) res.status(status).json(payload);
});

export default router;

/**
 * Retry pending/failed-transient outbox mail on an interval (server.js calls
 * this once at start). No-op without a transport or a store. Unref'd so it
 * never holds the process open.
 */
export function startOutboxDrain(intervalMs = 60_000) {
  if (!getMailTransport()) return null;
  const timer = setInterval(() => {
    const store = getStore();
    if (store) drainOutbox(store, getMailTransport()).catch((err) => console.error('[VIP] [mail] drain failed:', err?.message || err));
  }, intervalMs);
  timer.unref?.();
  return timer;
}
