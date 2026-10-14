/**
 * F12 / F13 / F14 / F15 — the REAL api-routes modules (the older monetization
 * and sync suites test mirror copies). Stripe webhook signatures are generated
 * locally with the stripe library; the only Stripe API call (claim → session
 * retrieve) is answered by a test stand-in. Nothing leaves the process.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const Stripe = require('stripe');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-backend-'));
Object.assign(process.env, {
  LICENSE_JWT_SECRET: 'test-license-secret-0123456789-abcdefghij',
  STRIPE_SECRET_KEY: 'sk_test_dummy_not_used_for_network',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
  STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m',
  STRIPE_PRICE_STUDIO_MONTHLY: 'price_studio_m',
  VIP_DATA_DIR: DATA_DIR,
});

let app;
let storeMod;
let monetization;
let entitlements;
const realStripe = new Stripe('sk_test_dummy_not_used_for_network');
const sessions = new Map();

beforeAll(async () => {
  const router = (await import('../api-routes/index.js')).default;
  storeMod = await import('../api-routes/store.js');
  monetization = await import('../api-routes/monetization.js');
  entitlements = await import('../api-routes/entitlements.js');
  monetization._setStripeForTests({
    webhooks: realStripe.webhooks,
    checkout: { sessions: { retrieve: async (id) => sessions.get(id) || { status: 'open' } } },
  });
  app = express();
  app.use('/api', router);
});

afterAll(() => {
  monetization._setStripeForTests(null);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

let evtSeq = 0;
function webhook(type, object, created = Math.floor(Date.now() / 1000) + (evtSeq += 1)) {
  const event = { id: `evt_${type}_${evtSeq}`, type, created, data: { object } };
  return sendEvent(event);
}
function sendEvent(event) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return request(app).post('/api/webhook/stripe').set('stripe-signature', header)
    .set('content-type', 'application/json').send(payload);
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function subscribe(customer, tier = 'STUDIO') {
  await webhook('checkout.session.completed', {
    customer, customer_email: `${customer}@example.com`, subscription: `sub_${customer}`, metadata: { tier },
  });
  const sid = `cs_test_${customer}_ok`;
  sessions.set(sid, { status: 'complete', payment_status: 'paid', customer });
  const claim = await request(app).post('/api/license/claim').send({ sessionId: sid });
  expect(claim.status).toBe(200);
  return claim.body.token;
}

describe('F13 — entitlement is authoritative, not the signed tier', () => {
  test('downgrade, cancellation and failed payment take effect on the next request', async () => {
    const token = await subscribe('cus_a', 'STUDIO');
    expect((await request(app).get('/api/license/status').set(auth(token))).body).toMatchObject({ tier: 'STUDIO', active: true });
    expect((await request(app).get('/api/sync/pull').set(auth(token))).status).toBe(200);

    await webhook('customer.subscription.updated', { customer: 'cus_a', id: 'sub_cus_a', status: 'active', items: { data: [{ price: { id: 'price_pro_m' } }] } });
    expect((await request(app).get('/api/license/status').set(auth(token))).body).toMatchObject({ tier: 'PRO', active: true });
    expect((await request(app).post('/api/license/validate').send({ token })).body).toMatchObject({ valid: true, tier: 'PRO' });
    expect((await request(app).get('/api/sync/pull').set(auth(token))).status).toBe(403);

    await webhook('invoice.payment_failed', { customer: 'cus_a' });
    expect((await request(app).get('/api/license/status').set(auth(token))).body).toEqual({ tier: 'FREE', active: false });
    expect((await request(app).post('/api/usage/record').set(auth(token)).send({ event: 'export', units: 1 })).status).toBe(401);
    await webhook('invoice.paid', { customer: 'cus_a' });
    expect((await request(app).get('/api/license/status').set(auth(token))).body).toMatchObject({ tier: 'PRO', active: true });

    await webhook('customer.subscription.deleted', { customer: 'cus_a', id: 'sub_cus_a' });
    expect((await request(app).post('/api/license/validate').send({ token })).body.valid).toBe(false);
    expect((await request(app).post('/api/license/activate').send({ token })).status).toBe(403);
    expect((await request(app).post('/api/license/refresh').set(auth(token))).status).toBe(403);
    expect((await request(app).get('/api/sync/pull').set(auth(token))).status).toBe(403);
    expect((await request(app).post('/api/usage/record').set(auth(token)).send({ event: 'x' })).status).toBe(401);
  });

  test('tokens are short-lived; an expired one is refused everywhere', async () => {
    await subscribe('cus_exp', 'STUDIO');
    const decoded = JSON.parse(Buffer.from((await subscribe('cus_exp2', 'PRO')).split('.')[1], 'base64url'));
    expect(decoded.exp - decoded.iat).toBe(entitlements.LICENSE_TOKEN_TTL_DAYS * 86400);
    const expired = entitlements.createLicenseToken({ customerId: 'cus_exp', tier: 'STUDIO', ttlDays: -1 });
    expect((await request(app).post('/api/license/validate').send({ token: expired })).body.valid).toBe(false);
    expect((await request(app).get('/api/sync/pull').set(auth(expired))).status).toBe(401);
    expect((await request(app).get('/api/license/status').set(auth(expired))).body.active).toBe(false);
  });

  test('a signed token for a customer with no record grants nothing', async () => {
    const forged = entitlements.createLicenseToken({ customerId: 'cus_never_paid', tier: 'ENTERPRISE' });
    expect((await request(app).post('/api/license/validate').send({ token: forged })).body.valid).toBe(false);
    expect((await request(app).get('/api/sync/pull').set(auth(forged))).status).toBe(401);
  });

  test('claim refuses unpaid sessions', async () => {
    sessions.set('cs_test_unpaid_1', { status: 'open', payment_status: 'unpaid', customer: 'cus_b' });
    expect((await request(app).post('/api/license/claim').send({ sessionId: 'cs_test_unpaid_1' })).status).toBe(402);
  });

  test('a same-second "active" update delivered after a deletion does not restore access', async () => {
    const token = await subscribe('cus_tie', 'STUDIO');
    const t = Math.floor(Date.now() / 1000) + 20_000;
    await webhook('customer.subscription.deleted', { customer: 'cus_tie', id: 's' }, t);
    await webhook('customer.subscription.updated', { customer: 'cus_tie', id: 's', status: 'active', items: { data: [{ price: { id: 'price_studio_m' } }] } }, t);
    expect((await request(app).get('/api/license/status').set(auth(token))).body.active).toBe(false);
  });

  test('tokens minted with the old 400-day lifetime are refused while unexpired', async () => {
    await subscribe('cus_legacy', 'STUDIO');
    const legacy = entitlements.createLicenseToken({ customerId: 'cus_legacy', tier: 'STUDIO', ttlDays: 400 });
    expect((await request(app).post('/api/license/validate').send({ token: legacy })).body.valid).toBe(false);
    expect((await request(app).get('/api/sync/pull').set(auth(legacy))).status).toBe(401);
  });

  test('an out-of-order (older) event does not overwrite a newer state', async () => {
    const token = await subscribe('cus_order', 'STUDIO');
    const now = Math.floor(Date.now() / 1000) + 10_000;
    await webhook('customer.subscription.deleted', { customer: 'cus_order', id: 's' }, now);
    await webhook('customer.subscription.updated', { customer: 'cus_order', id: 's', status: 'active', items: { data: [{ price: { id: 'price_studio_m' } }] } }, now - 50);
    expect((await request(app).get('/api/license/status').set(auth(token))).body.active).toBe(false);
  });
});

describe('F12 — durable, transactional, restart-safe persistence', () => {
  test('a processed webhook stays processed across a restart', async () => {
    const event = { id: 'evt_restart_1', type: 'checkout.session.completed', created: 1, data: { object: { customer: 'cus_r', customer_email: 'r@example.com', metadata: { tier: 'PRO' } } } };
    expect((await sendEvent(event)).body).toEqual({ received: true });
    storeMod._setStoreForTests(undefined); // "restart": a fresh store from VIP_DATA_DIR
    expect((await sendEvent(event)).body).toEqual({ received: true, duplicate: true });
    const state = await storeMod.getStore().read();
    expect(state.licenses.cus_r).toMatchObject({ tier: 'PRO', status: 'active' });
    expect(state.outbox.filter((m) => m.customerId === 'cus_r')).toHaveLength(1);
  });

  test('a sync push rejected by the quota commits nothing', async () => {
    const token = await subscribe('cus_q', 'STUDIO');
    const ok = await request(app).post('/api/sync/push').set(auth(token))
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'p1', name: 'One', params: { a: 1 } } }] });
    expect(ok.body.success).toBe(true);
    // Fill the 10 MB quota with history, then one push that overflows it.
    const big = { blob: 'x'.repeat(15 * 1024) };
    const store = storeMod.getStore();
    await store.transact((s) => { s.sync.cus_q.history = Array.from({ length: 700 }, () => big); });
    const over = await request(app).post('/api/sync/push').set(auth(token))
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'p2', name: 'Two', params: { b: 'y'.repeat(60000) } } }] });
    expect(over.status).toBe(413);
    const pull = await request(app).get('/api/sync/pull').set(auth(token));
    expect(pull.body.presets.map((p) => p.id)).toEqual(['p1']);
  });

  test('the store file is owner-only', async () => {
    await storeMod.getStore().transact((st) => { st.usage.push({ at: 1 }); });
    const mode = fs.statSync(path.join(DATA_DIR, 'vip-backend.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('without a durable store (production, no VIP_DATA_DIR) paid and sync endpoints answer 503', async () => {
    // Drive getStore()'s own environment decision, not a test override.
    const saved = { dir: process.env.VIP_DATA_DIR, env: process.env.NODE_ENV };
    delete process.env.VIP_DATA_DIR;
    process.env.NODE_ENV = 'production';
    storeMod._setStoreForTests(undefined);
    try {
      expect(storeMod.getStore()).toBeNull();
      expect((await request(app).post('/api/license/validate').send({ token: 'x.y.z' })).status).toBe(503);
      expect((await request(app).get('/api/sync/pull').set(auth('x.y.z'))).status).toBe(503);
      expect((await request(app).post('/api/checkout').send({ tier: 'PRO' })).status).toBe(503);
      const health = (await request(app).get('/api/health')).body.services;
      expect(health.store).toMatchObject({ ready: false, kind: 'none' });
      expect(health.licenseDelivery).toBe('unavailable');
    } finally {
      process.env.VIP_DATA_DIR = saved.dir;
      process.env.NODE_ENV = saved.env;
      storeMod._setStoreForTests(undefined);
    }
  });

  test('/health stays up and reports the store when VIP_DATA_DIR cannot be created', async () => {
    const saved = process.env.VIP_DATA_DIR;
    process.env.VIP_DATA_DIR = path.join(DATA_DIR, 'vip-backend.json', 'nested'); // under a file
    storeMod._setStoreForTests(undefined);
    try {
      const r = await request(app).get('/api/health');
      expect(r.status).toBe(200);
      expect(r.body.services.store).toMatchObject({ ready: false, kind: 'error' });
    } finally {
      process.env.VIP_DATA_DIR = saved;
      storeMod._setStoreForTests(undefined);
    }
  });

  test('health reports configuration and limits, never fabricated readiness', async () => {
    const s = (await request(app).get('/api/health')).body.services;
    expect(s.store).toMatchObject({ ready: true, kind: 'file', durable: true, multiInstanceSafe: false });
    expect(s.email).toBe('not-configured');
    expect(s.nim).toBe('not-available');
    expect(s.licenseDelivery).toBe('claim');
    expect(s).not.toHaveProperty('sync', true);
  });
});

describe('F14 — NIM never fabricates results', () => {
  test('detect answers 501 with no data, before reading the body', async () => {
    const r = await request(app).post('/api/nim/detect').send({ video: 'v', audio: 'a' });
    expect(r.status).toBe(501);
    expect(r.body).not.toHaveProperty('data');
    expect(r.body).not.toHaveProperty('success');
    // Malformed and over-limit JSON would be 400/413 if a parser ran first.
    const bad = await request(app).post('/api/nim/detect').set('content-type', 'application/json').send('{"video":');
    expect(bad.status).toBe(501);
    const big = await request(app).post('/api/nim/detect').set('content-type', 'application/json')
      .send(JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(big.status).toBe(501);
  });
});

describe('F15 — explicit body budgets per route', () => {
  test('sync accepts bodies above the default limit and below its own', async () => {
    const token = await subscribe('cus_body', 'STUDIO');
    const r = await request(app).post('/api/sync/push').set(auth(token))
      .send({ changes: [{ type: 'history:add', data: { pad: 'z'.repeat(10) } }], pad: 'p'.repeat(500 * 1024) });
    expect(r.status).toBe(200);
    const tooBig = await request(app).post('/api/sync/push').set(auth(token)).set('content-type', 'application/json')
      .send(JSON.stringify({ changes: [], pad: 'p'.repeat(1100 * 1024) }));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body).toMatchObject({ error: 'Request body too large' });
  });

  test('default routes stop at 100 KB with the same JSON error shape', async () => {
    const r = await request(app).post('/api/license/validate').set('content-type', 'application/json')
      .send(JSON.stringify({ token: 't'.repeat(120 * 1024) }));
    expect(r.status).toBe(413);
    expect(r.body).toMatchObject({ error: 'Request body too large' });
    const bad = await request(app).post('/api/license/validate').set('content-type', 'application/json').send('{"token":');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: 'Malformed JSON body' });
  });
});

describe('STRIPE_API_BASE (e2e smoke override)', () => {
  const saved = { base: process.env.STRIPE_API_BASE, env: process.env.NODE_ENV };
  afterEach(() => {
    if (saved.base === undefined) delete process.env.STRIPE_API_BASE; else process.env.STRIPE_API_BASE = saved.base;
    process.env.NODE_ENV = saved.env;
  });

  test('unset leaves the SDK on api.stripe.com', () => {
    delete process.env.STRIPE_API_BASE;
    expect(monetization.stripeApiBase()).toEqual({});
  });

  test('maps a local base URL to SDK host options outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_API_BASE = 'http://127.0.0.1:12111';
    expect(monetization.stripeApiBase()).toEqual({ host: '127.0.0.1', port: 12111, protocol: 'http' });
  });

  test('is refused outside an explicit development/test NODE_ENV', () => {
    process.env.STRIPE_API_BASE = 'http://127.0.0.1:12111';
    for (const env of ['production', 'staging', 'Production', '']) {
      process.env.NODE_ENV = env;
      expect(() => monetization.stripeApiBase()).toThrow(/only allowed when NODE_ENV/);
    }
    delete process.env.NODE_ENV;
    expect(() => monetization.stripeApiBase()).toThrow(/only allowed when NODE_ENV/);
  });

  test('is refused for a non-loopback host', () => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_API_BASE = 'https://stripe.attacker.example';
    expect(() => monetization.stripeApiBase()).toThrow(/loopback/);
  });
});
