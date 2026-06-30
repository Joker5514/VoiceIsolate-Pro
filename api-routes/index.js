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
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '24.0.0',
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      sync: !!process.env.DATABASE_URL,
      license: !!process.env.LICENSE_JWT_SECRET,
    },
  });
});

// ─── Stripe webhook needs the raw body for signature verification — mount
//     express.raw() BEFORE express.json() so it wins for this one route.
router.use('/webhook/stripe', express.raw({ type: 'application/json' }));

// ─── JSON Body Parser (for all non-webhook routes) ────────────────────────────
router.use(express.json());

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
