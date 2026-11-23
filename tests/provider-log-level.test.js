'use strict';
/**
 * Boot log on the Stems page (live report): worker.ready and
 * ingest.provider.verify were WARN with PROVIDER_UNVERIFIED before any
 * InferenceSession existed. Unverified is the correct state then (#939), but
 * it is pending, not a fault, so it must not be a warning. A session-backed
 * announcement that is still unverified, or a provider init failure, stays loud.
 */
let handshake;
let landingSrc;
beforeAll(async () => {
  handshake = await import('../src/core/ProviderHandshake.js');
  landingSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'landing.js'), 'utf8');
});

test('ready handshake before any session: PROVIDER_UNVERIFIED stays, level is info', () => {
  const msg = { type: 'ready', backend: 'wasm', gpuCandidate: true, providerVerified: false };
  const provider = handshake.explainProviderReady(msg);
  expect(provider.code).toBe('PROVIDER_UNVERIFIED');
  expect(provider.providerVerified).toBe(false);
  expect(handshake.providerLogLevel(provider, msg)).toBe('info');
});

test('session-backed announcement that is not verified is a warning', () => {
  const msg = { type: 'ort-provider', backend: 'bogus', providerVerified: true };
  const provider = handshake.explainProviderReady(msg);
  expect(provider.providerVerified).toBe(false);
  expect(handshake.providerLogLevel(provider, msg)).toBe('warn');
  const created = { type: 'ready', backend: 'wasm', sessionCreated: true, providerVerified: false };
  expect(handshake.providerLogLevel(handshake.explainProviderReady(created), created)).toBe('warn');
});

test('verified providers are info; init failures are errors', () => {
  const ok = { type: 'ort-provider', backend: 'wasm', providerVerified: true };
  expect(handshake.providerLogLevel(handshake.explainProviderReady(ok), ok)).toBe('info');
  const bad = { type: 'error', code: 'PROVIDER_INIT_FAILED' };
  expect(handshake.providerLogLevel(handshake.explainProviderReady(bad), bad)).toBe('error');
});

test('the Stems page logs provider status through providerLogLevel', () => {
  const ready = landingSrc.slice(landingSrc.indexOf("explainProviderReady({ ...msg, type: 'ready' })"), landingSrc.indexOf("case 'ort-provider'"));
  expect(ready).toMatch(/vipLog\(readyLevel, 'worker\.ready'/);
  expect(ready).toMatch(/vipLog\(verifyLevel, 'ingest\.provider\.verify'/);
  expect(ready).toMatch(/providerLogLevel\(provider/);
  // No hard-coded warn for an unverified-but-pending handshake.
  expect(ready).not.toMatch(/vipLog\(verified \? 'info' : 'warn'/);
});
