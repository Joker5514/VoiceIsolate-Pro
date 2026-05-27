'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// Worklet init is owned by pipeline-orchestrator.js (CLAUDE.md §2 — audioWorklet.addModule
// must only be called from pipeline-orchestrator.js, never from app.js).
describe('Engineer mode slider/worklet wiring', () => {
  const orchSrc = read('public/app/pipeline-orchestrator.js');
  const dspSrc  = read('public/app/dsp-processor.js');

  test('pipeline-orchestrator initializes worklet module before node construction', () => {
    expect(orchSrc).toMatch(/audioWorklet\.addModule/);
    expect(orchSrc).toContain("new AudioWorkletNode(this.ctx, 'dsp-processor'");
  });

  test('pipeline-orchestrator posts param updates to worklet port', () => {
    expect(orchSrc).toContain('workletNode.port.postMessage');
  });

  test('dsp-processor accepts single param messages', () => {
    expect(dspSrc).toContain("case 'param':");
    expect(dspSrc).toContain('this._params[id]');
  });
});

// ONNX session management lives in ml-worker.js (CLAUDE.md §3 — ML worker is owned by
// pipeline-orchestrator.js; inference logic including execution providers lives in ml-worker.js).
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
