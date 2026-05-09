/**
 * VoiceIsolate Pro — API index.js Unit Tests
 *
 * Tests the new features added to api/index.js in v24:
 *   1. Terminal error middleware — converts unhandled route errors into a
 *      stable JSON response, hides details in production.
 *   2. Rate limiting middleware — best-effort in-memory limiters for /login
 *      and /checkout paths (verified structurally since they require
 *      express-rate-limit which may not be available in all test envs).
 *   3. Health check endpoint — returns version 24.0.0.
 *
 * Because api/index.js is an ES module, the middleware logic is re-implemented
 * inline (same pattern used by the other test files in this suite).
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Terminal error middleware (api/index.js v24 new addition) ─────────────────
// The middleware converts unhandled Express errors into a stable JSON shape:
//   { error: 'Internal server error' }                   — always
//   { error: '...', message: err.message }               — non-production only
// It respects err.status if it's an integer, otherwise defaults to 500.
// It must never respond if headers are already sent.
describe('Terminal error middleware', () => {
  // Re-implement the middleware exactly as in api/index.js
  function makeErrorMiddleware(nodeEnv = 'development') {
    // eslint-disable-next-line no-unused-vars
    return (err, req, res, _next) => {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const payload = { error: 'Internal server error' };
      if (nodeEnv !== 'production' && err?.message) {
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
    };
  }

  function buildApp(nodeEnv = 'development') {
    const app = express();
    app.use(express.json());

    // Route that intentionally throws with a specific status
    app.get('/boom', (_req, _res, next) => {
      const err = new Error('Something went wrong');
      err.status = 422;
      next(err);
    });

    // Route that throws a plain Error (no .status property)
    app.get('/crash', (_req, _res, next) => {
      next(new Error('Unexpected crash'));
    });

    // Route that throws with a non-integer status (should default to 500)
    app.get('/bad-status', (_req, _res, next) => {
      const err = new Error('Bad status error');
      err.status = 'not-a-number';
      next(err);
    });

    // Attach the error middleware
    app.use(makeErrorMiddleware(nodeEnv));
    return app;
  }

  test('returns JSON { error: "Internal server error" } for unhandled errors', async () => {
    const app = buildApp();
    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  test('uses err.status when it is an integer', async () => {
    const app = buildApp();
    const res = await request(app).get('/boom');
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Internal server error');
  });

  test('defaults to 500 when err.status is not an integer', async () => {
    const app = buildApp();
    const res = await request(app).get('/bad-status');
    expect(res.status).toBe(500);
  });

  test('includes message in non-production environments', async () => {
    const app = buildApp('development');
    const res = await request(app).get('/crash');
    expect(res.body.message).toBe('Unexpected crash');
  });

  test('does NOT include message in production environment', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.message).toBeUndefined();
  });

  test('does NOT include message in production even when err has a message', async () => {
    const app = buildApp('production');
    const res = await request(app).get('/boom');
    expect(res.body.message).toBeUndefined();
  });

  test('response Content-Type is application/json', async () => {
    const app = buildApp();
    const res = await request(app).get('/crash');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('does not respond if headers are already sent', async () => {
    const app = express();
    app.get('/partial', (_req, res, next) => {
      // Send partial response first, then trigger error
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('partial ');
      const err = new Error('After partial send');
      next(err);
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const payload = { error: 'Internal server error' };
      if (process.env.NODE_ENV !== 'production' && err?.message) {
        payload.message = err.message;
      }
      try { console.error('[api] unhandled error', { msg: err?.message }); } catch {}
      if (!res.headersSent) res.status(status).json(payload);
      // If headersSent, we must end the response gracefully
      else res.end();
    });
    // Should not throw or crash
    await expect(request(app).get('/partial')).resolves.toBeDefined();
  });

  test('null error object does not cause a crash', async () => {
    const app = express();
    app.get('/null-err', (_req, _res, next) => {
      next(null);
    });
    app.use(makeErrorMiddleware('development'));
    // null errors are passed to Express default handling - just make sure no crash
    const res = await request(app).get('/null-err');
    expect([200, 404, 500]).toContain(res.status);
  });

  test('error with status 400 is respected', async () => {
    const app = express();
    app.get('/bad-request', (_req, _res, next) => {
      const err = new Error('Bad input');
      err.status = 400;
      next(err);
    });
    app.use(makeErrorMiddleware('development'));
    const res = await request(app).get('/bad-request');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.message).toBe('Bad input');
  });

  test('error with float status defaults to 500', async () => {
    const app = express();
    app.get('/float-status', (_req, _res, next) => {
      const err = new Error('Float status');
      err.status = 500.5;
      next(err);
    });
    app.use(makeErrorMiddleware());
    const res = await request(app).get('/float-status');
    expect(res.status).toBe(500);
  });
});

// ── Health check endpoint version (api/index.js v24) ─────────────────────────
describe('GET /health — version 24.0.0', () => {
  function buildHealthApp() {
    const app = express();
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        version: '24.0.0',
        timestamp: new Date().toISOString(),
        services: {
          stripe:  !!process.env.STRIPE_SECRET_KEY,
          sync:    !!process.env.DATABASE_URL,
          license: !!process.env.LICENSE_JWT_SECRET,
        },
      });
    });
    return app;
  }

  const healthApp = buildHealthApp();

  test('returns 200 with status:ok', async () => {
    const res = await request(healthApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('returns version 24.0.0', async () => {
    const res = await request(healthApp).get('/health');
    expect(res.body.version).toBe('24.0.0');
  });

  test('returns a valid ISO timestamp', async () => {
    const res = await request(healthApp).get('/health');
    expect(typeof res.body.timestamp).toBe('string');
    expect(() => new Date(res.body.timestamp)).not.toThrow();
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  test('services object has stripe, sync, and license keys', async () => {
    const res = await request(healthApp).get('/health');
    expect(res.body.services).toHaveProperty('stripe');
    expect(res.body.services).toHaveProperty('sync');
    expect(res.body.services).toHaveProperty('license');
  });

  test('services flags are boolean', async () => {
    const res = await request(healthApp).get('/health');
    expect(typeof res.body.services.stripe).toBe('boolean');
    expect(typeof res.body.services.sync).toBe('boolean');
    expect(typeof res.body.services.license).toBe('boolean');
  });
});

// ── Rate limiter structural tests ─────────────────────────────────────────────
// The rate limiting code uses a try/catch to optionally load express-rate-limit.
// We verify the structural pattern: fallback no-op middleware is correctly typed
// and rate-limiting is applied before routers.
describe('Rate limiting middleware structure', () => {
  test('api/index.js source attaches loginLimiter to /auth/login', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    expect(src).toContain("router.use('/auth/login', loginLimiter)");
  });

  test('api/index.js source attaches checkoutLimiter to /checkout', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    expect(src).toContain("router.use('/checkout', checkoutLimiter)");
  });

  test('rate limiters are attached before the route handlers', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    const limiterPos  = src.indexOf("router.use('/checkout', checkoutLimiter)");
    const monetizationPos = src.indexOf("router.use('/', monetizationRouter)");
    expect(limiterPos).toBeGreaterThan(-1);
    expect(monetizationPos).toBeGreaterThan(-1);
    expect(limiterPos).toBeLessThan(monetizationPos);
  });

  test('fallback no-op middleware is a pass-through function', () => {
    // Simulates the fallback: (_req, _res, next) => next()
    let nextCalled = false;
    const noopMiddleware = (_req, _res, next) => next();
    noopMiddleware(null, null, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  test('loginLimiter window is 15 minutes (900000 ms)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    expect(src).toContain('windowMs: 15 * 60 * 1000');
  });

  test('checkoutLimiter window is 60 seconds (60000 ms)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    expect(src).toContain('windowMs: 60 * 1000');
  });

  test('loginLimiter max is 20 requests', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    // The rate limit block order: loginLimiter has max: 20
    const loginBlock = src.slice(src.indexOf('loginLimiter = rateLimit'));
    expect(loginBlock.slice(0, loginBlock.indexOf('});'))).toContain('max: 20');
  });

  test('checkoutLimiter max is 10 requests', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../api/index.js'), 'utf8'
    );
    const checkoutBlock = src.slice(src.indexOf('checkoutLimiter = rateLimit'));
    expect(checkoutBlock.slice(0, checkoutBlock.indexOf('});'))).toContain('max: 10');
  });
});