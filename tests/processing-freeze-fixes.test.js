/**
 * VoiceIsolate Pro — Processing freeze & crash bug fixes (source-level audit)
 *
 * Covers the three bugs fixed in this PR:
 *  1. MLWorker cacheRequest() now times out after 30s instead of hanging forever.
 *  2. ProcessingOrchestrator.initialize() no longer leaks a timer on early abort.
 *  3. landing.js onStems() PlaybackMixer init is wrapped in try/catch.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');

// ── Bug #1: cacheRequest() timeout ────────────────────────────────────────────

describe('MLWorker cacheRequest timeout', () => {
  let mlWorkerSrc;
  beforeAll(() => {
    mlWorkerSrc = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
  });

  test('declares CACHE_REQUEST_TIMEOUT_MS constant', () => {
    expect(mlWorkerSrc).toMatch(/CACHE_REQUEST_TIMEOUT_MS\s*=\s*\d+/);
  });

  test('cacheRequest wraps resolve and reject with clearTimeout', () => {
    // The fix wraps resolve/reject inside timer-clearing closures.
    // Verify the pattern: resolve: (v) => { clearTimeout(timer); resolve(v); }
    expect(mlWorkerSrc).toMatch(/resolve\s*:\s*\([^)]*\)\s*=>\s*\{\s*clearTimeout\(timer\)/);
    expect(mlWorkerSrc).toMatch(/reject\s*:\s*\([^)]*\)\s*=>\s*\{\s*clearTimeout\(timer\)/);
  });

  test('cacheRequest rejects via timer when cache-response never arrives', (done) => {
    jest.setTimeout(5000);
    // Run MLWorker in a VM context with a tiny CACHE_REQUEST_TIMEOUT_MS so we
    // don't wait 30 seconds in the test.
    const patchedSrc = mlWorkerSrc
      .replace(/CACHE_REQUEST_TIMEOUT_MS\s*=\s*\d+/, 'CACHE_REQUEST_TIMEOUT_MS = 50');
    const messages = [];
    const context = vm.createContext({
      importScripts() {},
      self: {
        postMessage(msg) { messages.push(msg); },
        navigator: { hardwareConcurrency: 4 },
        crossOriginIsolated: true,
      },
      ort: {},
      crypto: webcrypto,
      console: { log() {}, warn() {}, error() {} },
      Float32Array, Uint8Array, Uint32Array, ArrayBuffer,
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
      SharedArrayBuffer,
      Atomics,
      Promise,
      Error,
    });
    vm.runInContext(patchedSrc, context);

    // Manually trigger a cache-request by calling cacheRequest() equivalent:
    // postMessage a 'process' request with USE_DESKTOP_CACHE = true so
    // fetchModelBytes() calls bridgedCacheGet() which calls cacheRequest().
    // Instead, directly test: trigger one cache-request and wait for the timeout reject.
    // We add a helper to the context that calls cacheRequest directly.
    vm.runInContext(`
      self.__testCacheRequestTimeout = function() {
        USE_DESKTOP_CACHE = true;
        return cacheRequest('get', 'test-key-no-response');
      };
    `, context);

    context.self.__testCacheRequestTimeout().then(() => {
      done(new Error('Should have rejected'));
    }).catch((err) => {
      expect(err.message).toMatch(/cache-request.*timed out/i);
      done();
    });
  });

  test('cacheRequest resolves immediately when cache-response arrives before timeout', (done) => {
    const patchedSrc = mlWorkerSrc
      .replace(/CACHE_REQUEST_TIMEOUT_MS\s*=\s*\d+/, 'CACHE_REQUEST_TIMEOUT_MS = 5000');
    const postedMessages = [];
    const context = vm.createContext({
      importScripts() {},
      self: {
        postMessage(msg) {
          postedMessages.push(msg);
          // Immediately simulate main-thread responding with cache-response.
          if (msg.type === 'cache-request') {
            setTimeout(() => {
              context.self.onmessage?.({ data: {
                type: 'cache-response',
                requestId: msg.requestId,
                ok: true,
                buffer: null,
              }});
            }, 10);
          }
        },
        navigator: { hardwareConcurrency: 4 },
        crossOriginIsolated: true,
      },
      ort: {},
      crypto: webcrypto,
      console: { log() {}, warn() {}, error() {} },
      Float32Array, Uint8Array, Uint32Array, ArrayBuffer,
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
      SharedArrayBuffer, Atomics, Promise, Error,
    });
    vm.runInContext(patchedSrc, context);
    vm.runInContext(`
      self.__testCacheRequestOk = function() {
        USE_DESKTOP_CACHE = true;
        return cacheRequest('get', 'test-key-will-respond');
      };
    `, context);

    context.self.__testCacheRequestOk().then((result) => {
      expect(result).toBeNull(); // bridge returned null (cache miss)
      done();
    }).catch(done);
  });
});

// ── Bug #2: ProcessingOrchestrator.initialize() early-abort timer leak ────────

describe('ProcessingOrchestrator.initialize() early-abort fix', () => {
  let src;
  beforeAll(() => {
    src = fs.readFileSync(path.join(ROOT, 'src/pipeline/ProcessingOrchestrator.js'), 'utf8');
  });

  test('handler variable is declared before the early-abort onAbort closure', () => {
    // The fix declares `let handler = null;` at the top of the Promise executor,
    // BEFORE the timeout and onAbort are defined.
    // Verify `let handler = null` appears before the first `clearTimeout(timeout)` inside onAbort.
    const handlerIdx = src.indexOf('let handler = null;');
    const onAbortIdx = src.indexOf('const onAbort = ()');
    expect(handlerIdx).toBeGreaterThan(0);
    expect(handlerIdx).toBeLessThan(onAbortIdx);
  });

  test('onAbort checks handler existence before calling removeEventListener', () => {
    // The fix guards with: if (handler) this.mlWorker.removeEventListener('message', handler);
    expect(src).toMatch(/if\s*\(handler\)\s*this\.mlWorker\.removeEventListener\('message',\s*handler\)/);
  });

  test('timeout callback also guards handler existence', () => {
    // Both the timeout and onAbort paths must guard.
    const matches = (src.match(/if\s*\(handler\)\s*this\.mlWorker\.removeEventListener\('message',\s*handler\)/g) || []);
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test('early-abort path does not leave timer running', async () => {
    const { ProcessingOrchestrator } = await import('../src/pipeline/ProcessingOrchestrator.js');
    const mockWorker = {
      postMessage: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    const orchestrator = new ProcessingOrchestrator({ mlWorker: mockWorker });
    // Pre-aborted signal
    const ctrl = new AbortController();
    ctrl.abort();
    // Should reject immediately with CancellationError (or compatible message), not hang
    await expect(orchestrator.initialize(ctrl.signal)).rejects.toThrow(/cancel/i);
    // _initPromise should be null after early abort
    expect(orchestrator._initPromise).toBeNull();
  });
});

// ── Bug #13: landing.js onStems() PlaybackMixer init wrapped in try/catch ─────

describe('landing.js PlaybackMixer init guarded', () => {
  let src;
  beforeAll(() => {
    src = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
  });

  test('PlaybackMixer construction is inside a try block', () => {
    // The fix wraps: try { mixer = new PlaybackMixer(); } catch (err) { failProcessing(...) }
    expect(src).toMatch(/try\s*\{\s*mixer\s*=\s*new PlaybackMixer\(\)/);
  });

  test('catch block calls failProcessing on PlaybackMixer init failure', () => {
    expect(src).toMatch(/catch\s*\(err\)\s*\{[\s\S]*?failProcessing\(/);
  });

  test('catch block returns early so mixer.loadStems is not called on undefined mixer', () => {
    // Verify return statement is inside the catch block before mixer.loadStems
    const catchIdx = src.indexOf('catch (err) {', src.indexOf('mixer = new PlaybackMixer()'));
    const returnIdx = src.indexOf('return;', catchIdx);
    const loadStemsIdx = src.indexOf('mixer.loadStems(', catchIdx);
    expect(returnIdx).toBeGreaterThan(catchIdx);
    expect(returnIdx).toBeLessThan(loadStemsIdx);
  });
});
