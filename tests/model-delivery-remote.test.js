'use strict';
const crypto = require('crypto');
let delivery;
beforeAll(async () => { delivery = await import('../scripts/lib/model-delivery.mjs'); });
const bytes = Buffer.from('verified model bytes');
const entry = { id: 'probe', url: '/app/models/probe.onnx', sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
function response(body, headers = {}) { return { ok: true, headers: new Headers(headers), body: (async function* () { yield body; })() }; }
test('remote verification downloads exact bytes and hashes them', async () => {
  const result = await delivery.verifyRemoteModel(entry, 'https://models.example', { fetchImpl: async () => response(bytes, { 'content-length': String(bytes.length) }) });
  expect(result).toMatchObject({ ok: true, size: bytes.length, sha256: entry.sha256 });
});
test.each([
  ['corrupt', Buffer.from('tampered model bytes'), {}],
  ['truncated', bytes.subarray(0, 4), {}],
  ['oversize', Buffer.concat([bytes, bytes]), {}],
  ['wrong-length', bytes, { 'content-length': '1' }],
])('rejects %s remote bytes', async (_name, body, headers) => {
  const result = await delivery.verifyRemoteModel(entry, 'https://models.example', { fetchImpl: async () => response(body, headers) });
  expect(result.ok).toBe(false);
});
test('unreachable and HTTP failures are explicit, optional models are skipped', async () => {
  const unreachable = await delivery.verifyRemoteModel(entry, 'https://models.example', { fetchImpl: async () => { throw new Error('socket closed'); } });
  expect(unreachable).toMatchObject({ ok: false, error: 'socket closed' });
  const http = await delivery.verifyRemoteModel(entry, 'https://models.example', { fetchImpl: async () => ({ ok: false, status: 404 }) });
  expect(http).toMatchObject({ ok: false, error: 'HTTP 404' });
  const result = await delivery.verifyRemoteDelivery({ base: 'https://models.example', manifest: { probe: entry, optional: { ...entry, id: 'optional', shipped: false, optional: true } }, fetchImpl: async () => response(bytes) });
  expect(result.ok).toBe(true); expect(result.skipped).toEqual(['optional']);
});
test('remote base must be HTTPS without credentials', () => {
  expect(() => delivery.deliveryBase(process.cwd(), 'http://models.example')).toThrow(/HTTPS/);
  expect(() => delivery.deliveryBase(process.cwd(), 'https://user:pass@models.example')).toThrow(/HTTPS/);
});
