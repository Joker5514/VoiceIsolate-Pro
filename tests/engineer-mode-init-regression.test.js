'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The real-time worklet pipeline was removed (Stem-Split & Live-Mix — CLAUDE.md §1).
// dsp-processor.js remains as the legacy processor definition but nothing registers it.
describe('Engineer mode slider/worklet wiring', () => {
  const dspSrc  = read('public/app/dsp-processor.js');

  test('no module registers the worklet anymore (live pipeline removed)', () => {
    const fs2 = require('fs');
    const appDir = path.join(__dirname, '../public/app');
    const offenders = fs2.readdirSync(appDir)
      .filter((f) => f.endsWith('.js'))
      .filter((f) => /audioWorklet\.addModule\s*\(/.test(read(`public/app/${f}`)));
    expect(offenders).toEqual([]);
  });

  test('dsp-processor accepts single param messages', () => {
    expect(dspSrc).toContain("case 'param':");
    expect(dspSrc).toContain('this._params[id]');
  });
});

// ONNX session management lives in ml-worker.js (legacy) and src/workers/MLWorker.js (new).
describe('ONNX init sequencing and fallback', () => {
  const mlSrc = read('public/app/ml-worker.js');

  test('ml-worker uses WebGPU first with WASM fallback providers', () => {
    expect(mlSrc).toContain("executionProviders: ['webgpu', 'wasm']");
    expect(mlSrc).toContain("executionProviders: ['wasm']");
  });

  test('ml-worker handles init message and manages session lifecycle', () => {
    expect(mlSrc).toContain("case 'init':");
    expect(mlSrc).toContain('session,');
  });
});

describe('Vercel global header coverage', () => {
  const cfg = JSON.parse(read('vercel.json'));

  test('COOP/COEP are configured for all routes', () => {
    const allRoute = cfg.headers.find((h) => h.source === '/(.*)');
    expect(allRoute).toBeDefined();
    const keys = allRoute.headers.map((h) => h.key);
    expect(keys).toContain('Cross-Origin-Opener-Policy');
    expect(keys).toContain('Cross-Origin-Embedder-Policy');
  });

  test('content-types are declared for js/wasm/onnx routes', () => {
    const jsRule   = cfg.headers.find((h) => h.source === '/(.*\\.js)');
    const wasmRule = cfg.headers.find((h) => h.source === '/(.*\\.wasm)');
    const onnxRule = cfg.headers.find((h) => h.source === '/(.*\\.onnx)');
    expect(jsRule).toBeDefined();
    expect(wasmRule).toBeDefined();
    expect(onnxRule).toBeDefined();
  });
});
