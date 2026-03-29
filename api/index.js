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
 *   /api/sync/*            → Cloud sync (Studio/Enterprise)
 *   /api/health            → Health check
 */

import express from 'express';
import monetizationRouter from './monetization.js';
import syncRouter from './sync.js';

const router = express.Router();

// ─── Health Check ─────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '22.0.0',
    timestamp: new Date().toISOString(),
    services: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      sync: !!process.env.DATABASE_URL,
      license: !!process.env.LICENSE_JWT_SECRET,
    },
  });
});

// ─── Monetization Routes ──────────────────────────────────────────────────────
router.use('/', monetizationRouter);

// ─── Cloud Sync Routes ────────────────────────────────────────────────────────
router.use('/sync', syncRouter);

// ─── Rate Limiting Middleware ─────────────────────────────────────────────────
// Install: npm install express-rate-limit
// Uncomment when deploying to production:
/*
import rateLimit from 'express-rate-limit';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
router.use(limiter);
*/

export default router;
