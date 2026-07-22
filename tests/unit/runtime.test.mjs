import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const runtime = require('../../public/app/runtime.js');
function makeAudioContext() { function AudioContext() {} AudioContext.prototype.audioWorklet = {}; return AudioContext; }
test('full live mode on isolated web with SAB and AudioWorklet', () => {
  const caps = runtime.detectRuntime({ window: { crossOriginIsolated: true, isSecureContext: true, AudioContext: makeAudioContext(), AudioWorkletNode: function () {}, OfflineAudioContext: function () {} }, navigator: { userAgent: 'Mozilla/5.0', gpu: {}, mediaDevices: { getUserMedia: async () => {} } }, SharedArrayBuffer: function () {} });
  const mode = runtime.selectExecutionMode(caps);
  assert.equal(caps.sabSafe, true); assert.equal(caps.hasAudioWorklet, true); assert.equal(mode, 'full-live'); assert.equal(runtime.isLiveModeAllowed(caps, mode), true);
});
test('Android WebView without isolation does not get full live', () => {
  const caps = runtime.detectRuntime({ window: { crossOriginIsolated: false, isSecureContext: true, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' }, AudioContext: makeAudioContext(), AudioWorkletNode: function () {}, OfflineAudioContext: function () {} }, navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36; wv)' }, SharedArrayBuffer: undefined });
  const mode = runtime.selectExecutionMode(caps);
  assert.equal(caps.androidWebView, true); assert.equal(caps.sabSafe, false); assert.notEqual(mode, 'full-live'); assert.ok(['limited-live', 'offline-only'].includes(mode));
  const messages = runtime.statusMessages({ capabilities: caps, mode, backend: 'wasm' });
  assert.ok(messages.some((m) => m.text.includes('SharedArrayBuffer not supported')));
});
test('no AudioWorklet but OfflineAudioContext yields offline-only', () => {
  const caps = runtime.detectRuntime({ window: { crossOriginIsolated: false, isSecureContext: true, OfflineAudioContext: function () {} }, navigator: { userAgent: 'Mozilla/5.0' }, SharedArrayBuffer: undefined });
  assert.equal(runtime.selectExecutionMode(caps), 'offline-only');
});
test('missing required audio APIs yields unsupported', () => {
  const caps = runtime.detectRuntime({ window: { crossOriginIsolated: false, isSecureContext: true }, navigator: { userAgent: 'Mozilla/5.0' }, SharedArrayBuffer: undefined });
  assert.equal(runtime.selectExecutionMode(caps), 'unsupported');
});
test('asset resolution rejects remote hosts', () => {
  assert.throws(() => runtime.resolveAssetUrl('https://evil.example/model.onnx', 'https://localhost/app/index.html'));
});
test('asset resolution allows same-origin relative paths', () => {
  assert.equal(runtime.resolveAssetUrl('./models/voice_isolate_pro.onnx', 'https://localhost/app/index.html'), 'https://localhost/app/models/voice_isolate_pro.onnx');
});
