'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Engineer mode slider/worklet wiring', () => {
  const appSrc = read('public/app/app.js');
  const dspSrc = read('public/app/dsp-processor.js');

  test('app initializes worklet module before node construction', () => {
    expect(appSrc).toContain("await this.ctx.audioWorklet.addModule('./dsp-processor.js')");
    expect(appSrc).toContain("new AudioWorkletNode(this.ctx, 'dsp-processor'");
  });

  test('app posts per-slider param updates to worklet port', () => {
    expect(appSrc).toContain("this.workletNode.port.postMessage({ type: 'param', id: sliderId, value })");
  });

  test('dsp-processor accepts single param messages', () => {
    expect(dspSrc).toContain("case 'param':");
    expect(dspSrc).toContain('this._params[id]');
  });
});

describe('ONNX init sequencing and fallback', () => {
  const appSrc = read('public/app/app.js');

  test('app uses WebGPU first with WASM fallback providers', () => {
    expect(appSrc).toContain("executionProviders: ['webgpu', 'wasm']");
    expect(appSrc).toContain("executionProviders: ['wasm']");
  });

  test('app posts init to ml-worker after session setup path', () => {
    expect(appSrc).toContain("type: 'init'");
    expect(appSrc).toContain('session,');
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
    const jsRule = cfg.headers.find((h) => h.source === '/(.*\\.js)');
    const wasmRule = cfg.headers.find((h) => h.source === '/(.*\\.wasm)');
    const onnxRule = cfg.headers.find((h) => h.source === '/(.*\\.onnx)');
    expect(jsRule).toBeDefined();
    expect(wasmRule).toBeDefined();
    expect(onnxRule).toBeDefined();
  });
});
