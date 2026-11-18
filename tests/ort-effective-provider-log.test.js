/**
 * Engineer Console session, Nov 17: the only provider line was the boot log
 * "ONNX runtime loaded { providerVerified: false, webgpuCandidate: true }".
 * That line is printed before any session exists and nothing later said
 * which execution provider ran. MLWorker does report it (ort-provider after
 * InferenceSession.create, ort-fallback when WebGPU fails, and the backend
 * of every session on the stems result), but none of it reached the log.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let OrtStatus;
let Host;

beforeAll(async () => {
  OrtStatus = await import('../src/core/OrtStatus.js');
  Host = await import('../src/pipeline/MLWorkerHost.js');
});

describe('describeEffectiveProvider', () => {
  test('a WebGPU stems result is reported as WebGPU, verified', () => {
    expect(OrtStatus.describeEffectiveProvider({
      backend: 'webgpu', preferredBackend: 'webgpu', sessionBackends: { bsrnn_vocals: 'webgpu' },
    })).toEqual({
      effectiveProvider: 'webgpu',
      preferredProvider: 'webgpu',
      webgpuFallback: false,
      sessionBackends: { bsrnn_vocals: 'webgpu' },
      summary: 'WebGPU (session verified)',
    });
  });

  test('WASM with a WebGPU adapter is reported as a fallback, not silently', () => {
    expect(OrtStatus.describeEffectiveProvider({
      backend: 'wasm', preferredBackend: 'webgpu', sessionBackends: { bsrnn_vocals: 'wasm' },
    })).toMatchObject({ effectiveProvider: 'wasm', webgpuFallback: true, summary: 'WASM (fell back from WebGPU)' });
  });

  test('WASM without an adapter is plain WASM', () => {
    expect(OrtStatus.describeEffectiveProvider({ backend: 'wasm', preferredBackend: 'wasm' }))
      .toMatchObject({ effectiveProvider: 'wasm', webgpuFallback: false, summary: 'WASM (no WebGPU adapter)' });
  });

  test('a cache hit ran no session and says so', () => {
    expect(OrtStatus.describeEffectiveProvider({ fromCache: true }))
      .toMatchObject({ effectiveProvider: 'none', summary: 'no ONNX session (stems from cache)' });
  });

  test('mixed composite sessions are named per model', () => {
    expect(OrtStatus.describeEffectiveProvider({
      backend: 'mixed', preferredBackend: 'webgpu', sessionBackends: { dfn3: 'mixed', bsrnn_vocals: 'webgpu' },
    })).toMatchObject({ effectiveProvider: 'mixed', webgpuFallback: true, summary: 'mixed (dfn3=mixed, bsrnn_vocals=webgpu)' });
  });
});

describe('MLWorkerHost logs provider verification and fallback', () => {
  let workers;
  let diag;
  beforeEach(() => {
    workers = [];
    diag = [];
    globalThis.Worker = class {
      constructor(url) { this.url = url; this.listeners = []; workers.push(this); }
      addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
      postMessage() {}
      emit(data) { for (const fn of this.listeners) fn({ data }); }
    };
    globalThis.VIP_liveDiagnostics = { log: (level, event, detail) => diag.push({ level, event, detail }) };
  });
  afterEach(() => {
    delete globalThis.Worker;
    delete globalThis.VIP_liveDiagnostics;
  });

  test('ort-provider is logged with the provider and session', () => {
    Host.createMLWorker();
    workers[0].emit({ type: 'ready', backend: 'wasm', gpuCandidate: true, providerVerified: false });
    workers[0].emit({ type: 'ort-provider', backend: 'webgpu', providerVerified: true, sessionKey: 'bsrnn_vocals' });
    const verified = diag.find((d) => d.event === 'ort.provider-verified');
    expect(verified).toEqual({
      level: 'info',
      event: 'ort.provider-verified',
      detail: { provider: 'webgpu', providerVerified: true, sessionKey: 'bsrnn_vocals' },
    });
    const ready = diag.find((d) => d.event === 'ort.worker-ready');
    expect(ready.detail).toEqual({ effectiveProvider: 'none (no session yet)', webgpuCandidate: true, providerVerified: false });
  });

  test('a WebGPU failure is logged as a warning naming the model and reason', () => {
    Host.createMLWorker();
    workers[0].emit({
      type: 'stage', stage: 'ort-fallback', backend: 'wasm', modelId: 'bsrnn_vocals',
      sessionKey: 'bsrnn_vocals', reason: 'session-compile', detail: 'webgpu compile error',
    });
    const fb = diag.find((d) => d.event === 'ort.webgpu-fallback');
    expect(fb).toEqual({
      level: 'warn',
      event: 'ort.webgpu-fallback',
      detail: { modelId: 'bsrnn_vocals', sessionKey: 'bsrnn_vocals', reason: 'session-compile', detail: 'webgpu compile error', retry: 'wasm' },
    });
  });
});

describe('Engineer log lines', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public/app/app.js'), 'utf8');
  const stems = fs.readFileSync(path.join(__dirname, '..', 'src/pipeline/StemSeparation.js'), 'utf8');

  test('ML isolation done states the effective provider', () => {
    const start = app.indexOf("structuredLog('info', '[VIP] ML isolation done', {");
    expect(start).toBeGreaterThan(0);
    const block = app.slice(start, app.indexOf('});', start));
    expect(block).toMatch(/\.\.\.describeEffectiveProvider\(result\)/);
  });

  test('the boot line no longer reads as a provider verdict', () => {
    const start = app.indexOf("structuredLog('info', '[VIP] ONNX runtime loaded', {");
    const block = app.slice(start, app.indexOf('});', start));
    expect(block).toMatch(/effectiveProvider: 'none \(no session yet\)'/);
  });

  test('stems results carry the per-session backends to the page', () => {
    expect(stems).toMatch(/preferredBackend: m\.preferredBackend \|\| null/);
    expect(stems).toMatch(/sessionBackends: m\.sessionBackends \|\| null/);
  });
});
