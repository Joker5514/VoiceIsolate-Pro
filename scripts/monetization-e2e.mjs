#!/usr/bin/env node
/**
 * Monetization end-to-end smoke: checkout → signed webhook → license claim →
 * server-verified entitlement → cancellation, through the real api-routes
 * router on a real HTTP port, with the real Stripe SDK.
 *
 * Default (offline): the SDK talks to a local fake Stripe API over HTTP
 * (STRIPE_API_BASE), so request shapes, auth headers and responses cross a
 * real socket. Webhooks are signed with the SDK's own test-header helper and
 * verified by the route exactly as in production.
 *
 * Live test mode: STRIPE_E2E_LIVE=1 with STRIPE_SECRET_KEY=sk_test_... and
 * STRIPE_PRICE_PRO_MONTHLY set creates a real Checkout session in Stripe test
 * mode. A session nobody paid must then be refused by /license/claim (402).
 * sk_live_ keys are refused.
 *
 *   pnpm test:monetization:e2e
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Stripe from 'stripe';

const live = process.env.STRIPE_E2E_LIVE === '1';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
};

if (live) {
  if (!/^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '')) {
    console.error('[monetization-e2e] STRIPE_E2E_LIVE needs an sk_test_ key; live keys are refused.');
    process.exit(1);
  }
  if (process.env.STRIPE_API_BASE) {
    console.error('[monetization-e2e] STRIPE_E2E_LIVE talks to Stripe itself; unset STRIPE_API_BASE.');
    process.exit(1);
  }
  if (!process.env.STRIPE_PRICE_PRO_MONTHLY) {
    console.error('[monetization-e2e] STRIPE_E2E_LIVE needs STRIPE_PRICE_PRO_MONTHLY (a test-mode price).');
    process.exit(1);
  }
}

// ── Fake Stripe API (offline mode) ──────────────────────────────────────────
const fake = { sessions: new Map(), calls: [] };
let fakeServer = null;
if (!live) {
  fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fake.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json', 'request-id': `req_${crypto.randomUUID()}` });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const form = new URLSearchParams(body);
        const id = `cs_test_${crypto.randomBytes(12).toString('hex')}`;
        const session = {
          id,
          object: 'checkout.session',
          url: `https://checkout.stripe.test/pay/${id}`,
          status: 'open',
          payment_status: 'unpaid',
          customer: null,
          customer_email: form.get('customer_email'),
          metadata: { tier: form.get('metadata[tier]'), cycle: form.get('metadata[cycle]') },
          price: form.get('line_items[0][price]'),
        };
        fake.sessions.set(id, session);
        return send(200, session);
      }
      const m = req.url.match(/^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)/);
      if (req.method === 'GET' && m) {
        const session = fake.sessions.get(m[1]);
        return session ? send(200, session) : send(404, { error: { type: 'invalid_request_error', message: 'No such checkout.session' } });
      }
      return send(404, { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${req.method}: ${req.url})` } });
    });
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    STRIPE_API_BASE: `http://127.0.0.1:${fakeServer.address().port}`,
    STRIPE_SECRET_KEY: 'sk_test_e2e_offline',
    STRIPE_PRICE_PRO_MONTHLY: 'price_e2e_pro_monthly',
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-monetization-e2e-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  VIP_DATA_DIR: dataDir,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_E2E_WEBHOOK_SECRET || 'whsec_e2e_local',
  LICENSE_JWT_SECRET: process.env.LICENSE_JWT_SECRET || crypto.randomBytes(48).toString('hex'),
});

const { default: apiRouter } = await import('../api-routes/index.js');
const app = express();
app.use('/api', apiRouter);
const apiServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${apiServer.address().port}`;
const origin = 'https://voiceisolate.test';
const signer = new Stripe(process.env.STRIPE_SECRET_KEY);

async function api(method, route, { body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { origin, ...(body || raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function webhook(event, { badSignature = false } = {}) {
  const payload = JSON.stringify(event);
  const header = signer.webhooks.generateTestHeaderString({
    payload,
    secret: badSignature ? 'whsec_wrong' : process.env.STRIPE_WEBHOOK_SECRET,
  });
  return api('POST', '/api/webhook/stripe', { raw: payload, headers: { 'stripe-signature': header } });
}

const event = (type, object, created = Math.floor(Date.now() / 1000)) => ({
  id: `evt_${crypto.randomBytes(10).toString('hex')}`,
  object: 'event',
  type,
  created,
  data: { object },
});

try {
  // 1. Checkout session through the real SDK.
  const checkout = await api('POST', '/api/checkout', { body: { tier: 'PRO', cycle: 'monthly', email: 'buyer@example.com' } });
  check('checkout returns a Stripe Checkout URL', checkout.status === 200 && /^https:\/\//.test(checkout.json?.url || ''), `status ${checkout.status}`);
  const sessionId = checkout.json?.sessionId;
  if (!live) {
    const call = fake.calls.find((c) => c.method === 'POST' && c.url === '/v1/checkout/sessions');
    const form = new URLSearchParams(call?.body || '');
    check('SDK sent the configured price and tier over HTTP',
      form.get('line_items[0][price]') === 'price_e2e_pro_monthly' && form.get('metadata[tier]') === 'PRO');
    check('SDK authenticated with the secret key', call?.auth === 'Bearer sk_test_e2e_offline');
  }

  // 2. Unpaid session cannot be claimed.
  const early = await api('POST', '/api/license/claim', { body: { sessionId } });
  check('unpaid session is refused by /license/claim', early.status === 402, `status ${early.status}`);

  if (!live) {
    // 3. Customer pays: Stripe marks the session complete and sends the webhook.
    const customer = `cus_${crypto.randomBytes(8).toString('hex')}`;
    Object.assign(fake.sessions.get(sessionId), { status: 'complete', payment_status: 'paid', customer, subscription: 'sub_e2e' });

    const bad = await webhook(event('checkout.session.completed', { customer }), { badSignature: true });
    check('webhook with a wrong signature is rejected', bad.status === 400, `status ${bad.status}`);

    const completed = event('checkout.session.completed', {
      id: sessionId,
      customer,
      customer_details: { email: 'buyer@example.com' },
      subscription: 'sub_e2e',
      metadata: { tier: 'PRO', cycle: 'monthly' },
    });
    const first = await webhook(completed);
    check('signed checkout.session.completed is applied', first.status === 200 && first.json?.received === true && !first.json?.duplicate);
    const replay = await webhook(completed);
    check('replayed event is acknowledged as a duplicate', replay.status === 200 && replay.json?.duplicate === true);

    // 4. License claim → token → server-verified entitlement.
    const claim = await api('POST', '/api/license/claim', { body: { sessionId } });
    check('paid session claims a PRO license', claim.status === 200 && claim.json?.tier === 'PRO' && typeof claim.json?.token === 'string', `status ${claim.status}`);
    const auth = { authorization: `Bearer ${claim.json?.token}` };
    const status = await api('GET', '/api/license/status', { headers: auth });
    check('entitlement is PRO and active', status.json?.tier === 'PRO' && status.json?.active === true, JSON.stringify(status.json));

    // 5. Cancellation revokes the entitlement on the next server check.
    const cancel = await webhook(event('customer.subscription.deleted', { id: 'sub_e2e', customer }, Math.floor(Date.now() / 1000) + 1));
    check('subscription.deleted is applied', cancel.status === 200);
    const after = await api('GET', '/api/license/status', { headers: auth });
    check('entitlement is revoked after cancellation', after.json?.active === false, JSON.stringify(after.json));
    const refresh = await api('POST', '/api/license/refresh', { headers: auth });
    check('token refresh is refused after cancellation', refresh.status === 403, `status ${refresh.status}`);
  }
} catch (err) {
  check('flow ran without throwing', false, err?.stack || String(err));
} finally {
  apiServer.close();
  fakeServer?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n[monetization-e2e] ${live ? 'Stripe test mode' : 'offline fake Stripe API'}: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
