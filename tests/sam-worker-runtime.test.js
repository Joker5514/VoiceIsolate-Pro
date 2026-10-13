/**
 * F16 / F17 / F18 — the REAL services/sam-audio/server.py (deterministic mock
 * model, SAM_AUDIO_ALLOW_MOCK=1) on an ephemeral loopback port, driven by the
 * real LocalSamAudioWorkerProvider and the real Electron main-process proxy.
 * Skipped only when no python3 interpreter is installed.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PYTHON || 'python3';
const hasPython = spawnSync(PYTHON, ['--version']).status === 0;
const describePy = hasPython ? describe : describe.skip;

let proc;
let port;
let baseUrl;
let providers;
let samProxy;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function raw(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const postJson = (p, obj, headers = {}) => raw('POST', p, {
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(obj),
});

const tone = (n) => Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i / 7));
const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');

beforeAll(async () => {
  providers = await import('../src/core/providers/index.js');
  samProxy = require('../electron/sam-proxy.cjs');
  if (!hasPython) return;
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  proc = spawn(PYTHON, ['server.py', '--port', String(port)], {
    cwd: path.join(ROOT, 'services/sam-audio'),
    // ALLOW_MOCK only permits the fallback; a model id that cannot load (and
    // an offline hub) forces it, so `mock: true` holds on hosts with weights.
    env: {
      ...process.env,
      SAM_AUDIO_ALLOW_MOCK: '1',
      SAM_AUDIO_PRODUCTION: '',
      SAM_AUDIO_REQUIRE_REAL: '',
      SAM_AUDIO_MODEL: '/nonexistent/vip-forced-mock',
      HF_HUB_OFFLINE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await raw('GET', '/health')).status === 200) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('SAM worker did not start');
}, 20000);

afterAll(() => {
  if (proc) proc.kill();
});

describePy('F17 — job ids are globally unique and cancellation is bounded', () => {
  test('a cancelled job does not poison a fresh provider, and concurrent jobs both run', async () => {
    const a = new providers.LocalSamAudioWorkerProvider({ baseUrl });
    const ac = new AbortController();
    const pa = a.isolate({ audio: tone(48000), sampleRate: 48000, prompt: 'speech', signal: ac.signal });
    ac.abort();
    await expect(pa).rejects.toMatchObject({ code: 'CANCELLED' });

    const b = new providers.LocalSamAudioWorkerProvider({ baseUrl });
    const ok = await b.isolate({ audio: tone(48000), sampleRate: 48000, prompt: 'speech' });
    expect(ok.target).toHaveLength(48000);

    const [r1, r2] = await Promise.all([1, 2].map(() => new providers.LocalSamAudioWorkerProvider({ baseUrl })
      .isolate({ audio: tone(4800), sampleRate: 48000, prompt: 'speech' })));
    expect(r1.jobId).not.toBe(r2.jobId);
    expect(r1.jobId).toMatch(/^sam-[0-9a-f-]{36}$/);
    expect(a._aborted.size + b._aborted.size).toBe(0);
  });

  test('a cancel that arrives first refuses that job once, then the id is released', async () => {
    const jobId = 'sam-early-cancel-1';
    expect((await postJson('/cancel', { jobId })).status).toBe(200);
    const body = { jobId, sampleRate: 48000, prompt: 'speech', audioBase64: b64(tone(480)) };
    expect((await postJson('/separate', body)).status).toBe(499);
    expect((await postJson('/separate', body)).status).toBe(200);
  });

  test('server job bookkeeping: one run per id, live cancels never expire, ids fullmatch', () => {
    const script = `
import server as s
assert s._start_job("j1") and not s._start_job("j1")
s._mark_cancelled("j1")
real = s.time.monotonic
s.time.monotonic = lambda: real() + s.CANCEL_TTL_S * 10
for i in range(s.MAX_CANCELLED + 50):
    s._mark_cancelled(f"idle-{i}")
assert s._is_cancelled("j1"), "active cancel expired or was evicted"
assert len(s._cancelled) <= s.MAX_CANCELLED + 1
s._finish_job("j1")
assert not s._is_cancelled("j1") and s._start_job("j1")
assert not s._valid_job_id("x\\n") and s._valid_job_id("sam-1")
print("ok")
`;
    const r = spawnSync(PYTHON, ['-c', script], {
      cwd: path.join(ROOT, 'services/sam-audio'),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
    });
    expect(r.stderr.split('\n').filter((l) => /Error|assert/i.test(l))).toEqual([]);
    expect(r.stdout.trim()).toBe('ok');
  });

  test('a jobId with a trailing newline is refused', async () => {
    expect((await postJson('/cancel', { jobId: 'sam-x\n' })).status).toBe(400);
    const body = { jobId: 'sam-x\n', sampleRate: 48000, audioBase64: b64(tone(480)) };
    expect((await postJson('/separate', body)).status).toBe(400);
  });

  test('client-side cancels for unknown jobs stay bounded', async () => {
    const p = new providers.LocalSamAudioWorkerProvider({ baseUrl });
    for (let i = 0; i < 200; i++) await p.cancel(`sam-unknown-${i}`);
    expect(p._aborted.size).toBeLessThanOrEqual(64);
  });
});

describePy('F18 — unsupported targeting is refused, never silently run as text', () => {
  test.each([
    ['span with anchors', { mode: 'span', anchors: [{ start: 0.1, end: 0.2 }] }],
    ['visual', { mode: 'visual' }],
    ['text with anchors', { mode: 'text', anchors: [{ start: 0, end: 1 }] }],
  ])('provider refuses %s before any request', async (_n, targeting) => {
    let calls = 0;
    const p = new providers.LocalSamAudioWorkerProvider({ baseUrl, fetchImpl: (...a) => { calls++; return fetch(...a); } });
    await expect(p.isolate({ audio: tone(480), sampleRate: 48000, ...targeting }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TARGETING' });
    expect(calls).toBe(0);
  });

  test('server refuses span/visual sent directly', async () => {
    for (const extra of [{ mode: 'span', anchors: [{ start: 0, end: 1 }] }, { mode: 'visual' }]) {
      const r = await postJson('/separate', { jobId: 'sam-direct-1', sampleRate: 48000, audioBase64: b64(tone(480)), ...extra });
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: 'unsupported-targeting', supported: ['text'] });
    }
  });

  test('the ONNX provider refuses span targeting too', async () => {
    const onnx = new providers.ExistingOnnxProvider({});
    await expect(onnx.isolate({ audio: tone(480), sampleRate: 48000, mode: 'span', anchors: [{ start: 0, end: 1 }] }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_TARGETING' });
  });
});

describePy('F16 — loopback transport without CORS', () => {
  test('browser-shaped requests are refused', async () => {
    expect((await raw('OPTIONS', '/separate', { headers: { Origin: 'http://localhost:3000' } })).status).toBe(501);
    expect((await raw('GET', '/capabilities', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await raw('POST', '/cancel', { headers: { 'Content-Type': 'text/plain' }, body: '{"jobId":"x"}' })).status).toBe(415);
    expect((await raw('GET', '/health', { headers: { Host: `rebind.example:${port}` } })).status).toBe(403);
    expect((await postJson('/cancel', { jobId: 'has space' })).status).toBe(400);
  });

  test('Electron main-process proxy separates and returns typed PCM', async () => {
    const proxy = samProxy.createSamProxy({ port: () => port });
    const r = await proxy.separate({ jobId: 'sam-proxy-1', audio: tone(4800), sampleRate: 48000, prompt: 'speech' });
    expect(r).toMatchObject({ ok: true, jobId: 'sam-proxy-1', sampleRate: 48000, mock: true });
    expect(r.target).toBeInstanceOf(Float32Array);
    expect(r.target).toHaveLength(4800);
    expect(r.residual).toHaveLength(4800);
  });

  test('a proxy cancel aborts the in-flight request promptly', async () => {
    const proxy = samProxy.createSamProxy({ port: () => port });
    const pending = proxy.separate({ jobId: 'sam-proxy-long', audio: tone(2_000_000), sampleRate: 48000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(proxy.inflightCount()).toBe(1);
    const t1 = Date.now();
    const cancelled = proxy.cancel('sam-proxy-long');
    expect(await pending).toEqual({ ok: false, status: 499, error: 'cancelled' });
    expect(Date.now() - t1).toBeLessThan(500);
    expect(await cancelled).toEqual({ ok: true, aborted: true });
    expect(proxy.inflightCount()).toBe(0);
  });

  test('provider uses the Electron bridge when present and never fetches', async () => {
    const proxy = samProxy.createSamProxy({ port: () => port });
    const desktop = {
      samWorkerSeparate: (req) => proxy.separate(structuredClone(req)),
      samWorkerCancel: (id) => proxy.cancel(id),
      samWorkerCapabilities: async () => ({ ok: true, capabilities: (await raw('GET', '/capabilities')).json }),
    };
    const p = new providers.LocalSamAudioWorkerProvider({ desktop });
    p._fetch = () => { throw new Error('fetch must not be used'); };
    expect(p.transport).toBe('ipc');
    expect(await p.getCapabilities()).toMatchObject({ available: true, transport: 'ipc', mock: true });
    const out = await p.isolate({ audio: tone(4800), sampleRate: 48000, prompt: 'speech' });
    expect(out.target).toHaveLength(4800);
    expect(out.meta.transport).toBe('ipc');
  });
});

describe('proxy target verification and resource caps (fake loopback services)', () => {
  function fakeService(handler) {
    return new Promise((resolve) => {
      const seen = [];
      const srv = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url}`);
        req.resume();
        req.on('end', () => handler(req, res));
      });
      srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port }));
    });
  }
  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const req = (jobId) => ({ jobId, audio: tone(4800), sampleRate: 48000 });

  test('a different service on the port never receives PCM', async () => {
    const { srv, seen, port: p } = await fakeService((_q, res) => json(res, 200, { ok: true }));
    try {
      const r = await samProxy.createSamProxy({ port: () => p }).separate(req('sam-other-1'));
      expect(r).toMatchObject({ ok: false, error: 'not-sam-worker' });
      expect(seen).toEqual(['GET /health']);
    } finally { srv.close(); }
  });

  test('privileged or invalid ports are refused before any connection', async () => {
    for (const bad of [0, 80, 443, 70000, 8765.5, NaN]) {
      const r = await samProxy.createSamProxy({ port: () => bad }).separate(req('sam-port-1'));
      expect(r).toMatchObject({ ok: false, error: 'invalid-worker-port' });
    }
    expect(samProxy.isValidWorkerPort(8765)).toBe(true);
  });

  test('an oversized worker response is cut off, not buffered', async () => {
    const { srv, port: p } = await fakeService((q, res) => {
      if (q.url === '/health') return json(res, 200, { service: 'sam-audio-worker' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(1 << 20, 0x41);
      let sent = 0;
      const pump = () => {
        while (sent < 64 && res.write(chunk)) sent++;
        if (sent < 64) res.once('drain', pump); else res.end();
      };
      pump();
    });
    try {
      const r = await samProxy.createSamProxy({ port: () => p }).separate(req('sam-big-1'));
      expect(r).toMatchObject({ ok: false, error: 'worker-response-too-large' });
    } finally { srv.close(); }
  });

  test('concurrent jobs are capped and a running jobId cannot start twice', async () => {
    const hold = [];
    const { srv, port: p } = await fakeService((q, res) => {
      if (q.url === '/health') return json(res, 200, { service: 'sam-audio-worker' });
      if (q.url === '/cancel') return json(res, 200, { ok: true });
      hold.push(res);
    });
    try {
      const proxy = samProxy.createSamProxy({ port: () => p });
      const first = proxy.separate(req('sam-cc-1'));
      expect(await proxy.separate(req('sam-cc-1'))).toMatchObject({ ok: false, status: 409 });
      const second = proxy.separate(req('sam-cc-2'));
      expect(samProxy.MAX_CONCURRENT_JOBS).toBe(2);
      expect(await proxy.separate(req('sam-cc-3'))).toMatchObject({ ok: false, status: 429 });
      // A cancel that lands before the request is sent still stops the job.
      expect(await proxy.cancel('sam-cc-2')).toEqual({ ok: true, aborted: true });
      expect(await second).toEqual({ ok: false, status: 499, error: 'cancelled' });
      await new Promise((r) => setTimeout(r, 50));
      hold.forEach((res) => json(res, 200, { sampleRate: 48000, mock: true }));
      expect(await first).toMatchObject({ ok: true, jobId: 'sam-cc-1' });
      expect(proxy.activeJobs()).toBe(0);
    } finally { srv.close(); }
  });
});

describe('proxy request validation (no worker needed)', () => {
  const ok = { jobId: 'sam-1', audio: tone(32), sampleRate: 48000 };
  test.each([
    ['bad job id', { ...ok, jobId: 'a b' }, /jobId/],
    ['plain array audio', { ...ok, audio: [0, 1] }, /Float32Array/],
    ['too short', { ...ok, audio: new Float32Array(4) }, /short/],
    ['fractional rate', { ...ok, sampleRate: 44100.5 }, /sampleRate/],
    ['span mode', { ...ok, mode: 'span' }, /unsupported-targeting/],
    ['anchors', { ...ok, anchors: [{ start: 0, end: 1 }] }, /unsupported-targeting/],
  ])('%s', (_n, req, re) => {
    expect(() => samProxy.validateSeparateRequest(req)).toThrow(re);
  });

  test('too long for the worker body limit', () => {
    const huge = new Float32Array(samProxy.MAX_SAMPLES + 1);
    expect(() => samProxy.validateSeparateRequest({ ...ok, audio: huge })).toThrow(/too long/);
    expect(() => samProxy.validateSeparateRequest({ ...ok, audio: huge.subarray(1) })).not.toThrow();
  });

  test('a web page (document, no bridge) reports no transport instead of a CSP-blocked fetch', async () => {
    globalThis.document = {};
    try {
      const p = new providers.LocalSamAudioWorkerProvider({ desktop: null });
      expect(p.transport).toBe('none');
      expect(await p.getCapabilities()).toMatchObject({ available: false, reasons: ['browser-transport-unavailable'] });
      await expect(p.isolate({ audio: tone(32), sampleRate: 48000 })).rejects.toThrow(/desktop app/);
    } finally {
      delete globalThis.document;
    }
  });
});
