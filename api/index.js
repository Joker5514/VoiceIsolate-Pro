/**
 * VoiceIsolate Pro — API Router v22
 *
 * Mounts all API routes on the Express server.
 * Import this in server.js: import apiRouter from './api/index.js'
 * Then: app.use('/api', apiRouter)
 *
 * Routes:
 *   /api/checkout          → Stripe Checkout session creation
 *   /api/webhook/stripe    → Stripe webhook handler
 *   /api/license/*         → License validation and activation
 *   /api/usage/*           → Usage recording for metered billing
 *   /api/pricing           → Public pricing info
 *   /api/auth/*            → Authentication (login, me, logout)
 *   /api/sync/*            → Cloud sync (Studio/Enterprise)
 *   /api/health            → Health check
 */

import express from 'express';
import monetizationRouter from './monetization.js';
import syncRouter from './sync.js';
import authRouter from './auth.js';

const router = express.Router();

// ─── Rate limiting (best-effort) ──────────────────────────────────────────────
// Tight buckets on the abuse-prone endpoints (login, checkout). For serverless
// or multi-instance deploys, back this with Redis/Upstash — the in-memory
// limiter below only protects a single Node process.
let loginLimiter = (_req, _res, next) => next();
let checkoutLimiter = (_req, _res, next) => next();
try {
  const { default: rateLimit } = await import('express-rate-limit');
  loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
  });
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
router.use('/auth/login', loginLimiter);

// ─── Monetization Routes ──────────────────────────────────────────────────────
router.use('/', monetizationRouter);

// ─── Authentication Routes ───────────────────────────────────────────────────
router.use('/auth', authRouter);

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
