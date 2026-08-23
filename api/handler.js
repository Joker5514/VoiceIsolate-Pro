/**
 * VoiceIsolate Pro — api/handler.js
 *
 * Single Vercel serverless entry-point for all /api/* routes.
 *
 * Why this file exists
 * --------------------
 * Vercel's file-based routing calls each api/<name>.js with the FULL request
 * path (e.g. /api/auth/login).  The sub-routers in index.js / auth.js define
 * routes at RELATIVE paths (/login, /me, /logout …), so they cannot match
 * the full path when called directly by Vercel.
 *
 * This file wraps the main router in a proper Express app mounted at /api,
 * so Express strips the /api prefix before dispatching to the sub-routers —
 * matching exactly what server.js does locally.
 *
 * Deployment boundary
 * -------------------
 * `.vercelignore` intentionally excludes `api/` and `api-routes/` from the
 * static Vercel production deployment. This entry point is for local Express
 * or an explicitly configured serverful deployment; do not add a Vercel
 * rewrite until the API directory is included and production function smoke
 * tests are enabled.
 */

import express    from 'express';
import apiRouter  from '../api-routes/index.js';

const app = express();
app.disable('x-powered-by');

// Raw body for Stripe webhook signature verification (must come before json())
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }));

// JSON body parser for all other routes
app.use(express.json());

// Mount the main API router at /api — this strips the /api prefix, which lets
// the sub-routers match their relative paths (/auth/login, /sync/pull, etc.)
app.use('/api', apiRouter);

// Wrap in an explicit (req, res) function. Vercel's @vercel/node runtime
// auto-detects request handlers; passing the bare Express app instance works
// in most cases but has caused FUNCTION_INVOCATION_FAILED on Express 5
// bundles. Wrapping makes the export shape deterministic across Express
// majors and Vercel bundler versions.
export default function handler(req, res) {
  return app(req, res);
}
