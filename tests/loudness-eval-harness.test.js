'use strict';

/**
 * Regression: PR #916 published VIPLoudness but called measureIntegratedLufs
 * directly. Jest eval helpers strip ESM imports, so app.js failed to load
 * and the session meter was unreachable. The browser import stays; the
 * eval harness inlines src/core/Loudness.js and call sites resolve through
 * VIPLoudness with a typeof-safe fallback.
 */
const getAppCode = require('./helpers/get-app-code');

function loadApp() {
  const appJs = getAppCode();
  const safeCode = appJs.replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
  return new Function(
    'window',
    'document',
    'globalThis',
    safeCode + '; return { VoiceIsolatePro, VIPLoudness: globalThis.VIPLoudness };',
  )({}, { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement() { return { style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }; } }, globalThis);
}

test('app.js loads in the Jest eval harness after ESM imports are stripped', () => {
  const { VoiceIsolatePro } = loadApp();
  expect(typeof VoiceIsolatePro).toBe('function');
});

test('the BS.1770-4 meter is reachable on VIPLoudness in the eval harness', () => {
  const { VIPLoudness } = loadApp();
  expect(VIPLoudness).toBeDefined();
  expect(typeof VIPLoudness.measureIntegratedLufs).toBe('function');
  expect(typeof VIPLoudness.createLoudnessMeter).toBe('function');
  // 1 kHz sine at amplitude -20 dBFS, 48 kHz: same fixture as tests/loudness-bs1770.test.js
  const sr = 48000;
  const amp = 10 ** (-20 / 20);
  const tone = new Float32Array(sr);
  for (let i = 0; i < tone.length; i++) tone[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / sr);
  expect(VIPLoudness.measureIntegratedLufs(tone, sr)).toBeCloseTo(-23.0, 1);
});
