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
 * Routing
 * -------
 * vercel.json rewrites /api/:path* → /api/handler so every API request
 * reaches this file regardless of the other files in the api/ directory.
 */

import express    from 'express';
import apiRouter  from './index.js';

const app = express();

// Raw body for Stripe webhook signature verification (must come before json())
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }));

// JSON body parser for all other routes
app.use(express.json());

// Mount the main API router at /api — this strips the /api prefix, which lets
// the sub-routers match their relative paths (/auth/login, /sync/pull, etc.)
app.use('/api', apiRouter);

export default app;
