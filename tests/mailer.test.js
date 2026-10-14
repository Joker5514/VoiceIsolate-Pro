/**
 * Transactional email: the real api-routes/mailer.js against a mocked fetch.
 * Nothing leaves the process.
 */
'use strict';

let mailer;
let storeMod;

beforeAll(async () => {
  mailer = await import('../api-routes/mailer.js');
  storeMod = await import('../api-routes/store.js');
});

const saved = { key: process.env.RESEND_API_KEY, from: process.env.EMAIL_FROM };
afterEach(() => {
  for (const [k, v] of [['RESEND_API_KEY', saved.key], ['EMAIL_FROM', saved.from]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function configure() {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.EMAIL_FROM = 'VoiceIsolate Pro <billing@example.com>';
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return { ok: r.status < 300, status: r.status, json: async () => r.body || {} };
  };
  fn.calls = calls;
  return fn;
}

async function storeWith(rows) {
  const store = storeMod.createStore({ kind: 'memory' });
  await store.transact((s) => { s.outbox.push(...rows); });
  return store;
}

const row = (n, extra = {}) => ({
  id: `license-issued:evt_${n}`, type: 'license-issued', customerId: `cus_${n}`,
  email: `buyer${n}@example.com`, tier: 'PRO', at: 1, status: 'pending', ...extra,
});

describe('mail transport configuration', () => {
  test('no transport without both RESEND_API_KEY and EMAIL_FROM', () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    expect(mailer.getMailTransport()).toBeNull();
    expect(mailer.mailTransportStatus()).toBe('not-configured');
    process.env.RESEND_API_KEY = 're_x';
    expect(mailer.getMailTransport()).toBeNull();
  });

  test('drain is a no-op without a transport', async () => {
    const store = await storeWith([row(1)]);
    expect(await mailer.drainOutbox(store, null)).toEqual({ sent: 0, failed: 0, skipped: true });
    expect((await store.read()).outbox[0].status).toBe('pending');
  });
});

describe('drainOutbox()', () => {
  test('sends a pending row once, with auth, sender and idempotency key', async () => {
    configure();
    const fetchImpl = fakeFetch([{ status: 200, body: { id: 'em_1' } }]);
    const store = await storeWith([row(1)]);
    const r = await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }));
    expect(r).toEqual({ sent: 1, failed: 0, skipped: false });
    const [call] = fetchImpl.calls;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.headers.authorization).toBe('Bearer re_test_key');
    expect(call.init.headers['idempotency-key']).toBe('license-issued:evt_1');
    expect(call.body).toMatchObject({ from: 'VoiceIsolate Pro <billing@example.com>', to: ['buyer1@example.com'] });
    expect(call.body.text).not.toMatch(/eyJ/); // never a token in the mail
    const [saved] = (await store.read()).outbox;
    expect(saved).toMatchObject({ status: 'sent', providerId: 'em_1' });

    await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }));
    expect(fetchImpl.calls).toHaveLength(1);
  });

  test('a 5xx is retried later with backoff, then succeeds', async () => {
    configure();
    let t = 1_000_000;
    const now = () => t;
    const fetchImpl = fakeFetch([{ status: 503, body: { message: 'down' } }, { status: 200, body: { id: 'em_2' } }]);
    const store = await storeWith([row(2)]);
    const transport = mailer.getMailTransport({ fetchImpl });

    expect(await mailer.drainOutbox(store, transport, { now })).toMatchObject({ failed: 1 });
    let [r] = (await store.read()).outbox;
    expect(r).toMatchObject({ status: 'retry', attempts: 1, nextAttemptAt: t + 60_000 });

    await mailer.drainOutbox(store, transport, { now });
    expect(fetchImpl.calls).toHaveLength(1); // not due yet

    t += 60_000;
    expect(await mailer.drainOutbox(store, transport, { now })).toMatchObject({ sent: 1 });
    [r] = (await store.read()).outbox;
    expect(r.status).toBe('sent');
    expect(fetchImpl.calls.map((c) => c.init.headers['idempotency-key'])).toEqual(['license-issued:evt_2', 'license-issued:evt_2']);
  });

  test('a 4xx (bad address) fails permanently without retry', async () => {
    configure();
    const fetchImpl = fakeFetch([{ status: 422, body: { message: 'invalid to' } }]);
    const store = await storeWith([row(3)]);
    await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }));
    const [r] = (await store.read()).outbox;
    expect(r).toMatchObject({ status: 'failed', attempts: 1 });
    expect(r.lastError).toMatch(/422/);
  });

  test('gives up after MAX_ATTEMPTS transient failures', async () => {
    configure();
    let t = 0;
    const fetchImpl = fakeFetch([{ status: 500 }]);
    const store = await storeWith([row(4)]);
    const transport = mailer.getMailTransport({ fetchImpl });
    for (let i = 0; i < mailer.MAX_ATTEMPTS + 2; i += 1) {
      t += 24 * 60 * 60 * 1000;
      await mailer.drainOutbox(store, transport, { now: () => t });
    }
    expect(fetchImpl.calls).toHaveLength(mailer.MAX_ATTEMPTS);
    expect((await store.read()).outbox[0].status).toBe('failed');
  });

  test('a row stuck in "sending" (crashed process) is re-sent with the same key', async () => {
    configure();
    const fetchImpl = fakeFetch([{ status: 200, body: { id: 'em_5' } }]);
    const t = 10_000_000;
    const store = await storeWith([row(5, { status: 'sending', leasedAt: t - 5 * 60 * 1000 }), row(6, { status: 'sending', leasedAt: t - 11 * 60 * 1000 })]);
    await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }), { now: () => t });
    expect(fetchImpl.calls.map((c) => c.init.headers['idempotency-key'])).toEqual(['license-issued:evt_6']);
  });

  test('rows without an email or of another type are left alone', async () => {
    configure();
    const fetchImpl = fakeFetch([{ status: 200 }]);
    const store = await storeWith([row(7, { email: '' }), row(8, { type: 'other' })]);
    await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }));
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('outbox safety', () => {
  test('a row whose outcome is unknown past the idempotency window is failed, not re-sent', async () => {
    configure();
    const fetchImpl = fakeFetch([{ status: 200 }]);
    const t = 100 * 60 * 60 * 1000;
    const store = await storeWith([row(9, { status: 'sending', leasedAt: t - 24 * 60 * 60 * 1000, firstAttemptAt: t - 24 * 60 * 60 * 1000 })]);
    await mailer.drainOutbox(store, mailer.getMailTransport({ fetchImpl }), { now: () => t });
    expect(fetchImpl.calls).toHaveLength(0);
    expect((await store.read()).outbox[0]).toMatchObject({ status: 'failed', lastError: expect.stringMatching(/idempotency window/) });
  });

  test('the outbox cap drops sent/failed history, never unsent mail', async () => {
    const store = storeMod.createStore({ kind: 'memory' });
    await store.transact((s) => {
      for (let i = 0; i < 10; i += 1) s.outbox.push(row(`p${i}`));
      for (let i = 0; i < 10_000; i += 1) s.outbox.push(row(`s${i}`, { status: 'sent' }));
    });
    const { outbox } = await store.read();
    expect(outbox).toHaveLength(10_000);
    expect(outbox.filter((r) => r.status === 'pending')).toHaveLength(10);
  });
});
