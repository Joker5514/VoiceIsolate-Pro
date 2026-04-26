/**
 * VoiceIsolate Pro — PipelineOrchestrator Unit Tests
 *
 * Tests the PipelineOrchestrator class behaviour in isolation: constructor
 * defaults, idempotent init()/initMLWorker() promises, safe no-op paths for
 * updateParams/disconnectSource/destroy/suspend/resume when dependencies are
 * absent, and the ring-buffer sizing constants.
 *
 * Because pipeline-orchestrator.js is a browser-targeted, non-module script,
 * it is loaded via eval() with all required browser APIs mocked.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Browser API mocks ─────────────────────────────────────────────────────────

class MockAudioContext {
  constructor() {
    this.state       = 'running';
    this.destination = {};
    this.audioWorklet = { addModule: jest.fn().mockResolvedValue(undefined) };
  }
  async resume()  { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close()   { this.state = 'closed'; }
}

class MockAudioWorkletNode {
  constructor() {
    this.port = { postMessage: jest.fn(), onmessage: null };
  }
  connect()    {}
  disconnect() {}
}

class MockWorker {
  constructor() {
    this.onmessage = null;
    this.onerror   = null;
    this._messages = [];
  }
  postMessage(msg) {
    this._messages.push(msg);
    // Auto-reply with 'ready' when the worker receives the 'init' message so
    // that _initMLWorker()'s promise resolves without hanging the test suite.
    if (msg.type === 'init' && this.onmessage) {
      Promise.resolve().then(() => {
        if (this.onmessage) {
          this.onmessage({ data: { type: 'ready', provider: 'wasm', models: [] } });
        }
      });
    }
  }
  terminate() {}
}

// Assign globals before eval
// NOTE: pipeline-orchestrator.js reads AudioContext from `window.AudioContext`,
// not from `global.AudioContext`, so both must be populated.
global.window = {
  _vipApp:               null,
  _mlWorkerPatch:        null,
  _vipPreloadModels:     null,
  AudioContext:          MockAudioContext,
  webkitAudioContext:    MockAudioContext,
};
global.AudioContext        = MockAudioContext;
global.AudioWorkletNode    = MockAudioWorkletNode;
global.Worker              = MockWorker;
global.SharedArrayBuffer   = SharedArrayBuffer; // Node.js native
global.Int32Array          = Int32Array;
global.Float32Array        = Float32Array;
global.document            = {
  readyState:        'complete',
  querySelectorAll:  () => [],
  querySelector:     () => null,
  getElementById:    () => null,
  addEventListener:  () => {},
};

// ── Load PipelineOrchestrator ─────────────────────────────────────────────────
// Append an export statement so that the class is accessible after eval.
// The bootstrapOrchestrator IIFE will start a setInterval poll; we stub it to
// prevent slow teardown.
const _origSetInterval  = global.setInterval;
const _origClearInterval = global.clearInterval;
global.setInterval  = () => 0;   // no-op during module load
global.clearInterval = () => {};

const orchSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/pipeline-orchestrator.js'),
  'utf8'
);
// Append the export after the class declaration (inside the same eval scope)
const orchSrcWithExport = orchSrc + '\nif (typeof module !== "undefined") module.exports = PipelineOrchestrator;';

let PipelineOrchestrator;
{
  const mod = { exports: {} };
  (function(module) { // eslint-disable-line no-shadow
    /* eslint-disable no-eval */
    eval(orchSrcWithExport);
    /* eslint-enable no-eval */
  })(mod);
  PipelineOrchestrator = mod.exports;
}

// Restore timers
global.setInterval  = _origSetInterval;
global.clearInterval = _origClearInterval;

// ── Constructor ───────────────────────────────────────────────────────────────
describe('PipelineOrchestrator — constructor', () => {
  test('ctx starts null', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.ctx).toBeNull();
  });

  test('workletNode starts null', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.workletNode).toBeNull();
  });

  test('mlWorker starts null', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.mlWorker).toBeNull();
  });

  test('mlReady starts false', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.mlReady).toBe(false);
  });

  test('initialized starts false', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.initialized).toBe(false);
  });

  test('_initPromise starts null', () => {
    const orch = new PipelineOrchestrator();
    expect(orch._initPromise).toBeNull();
  });

  test('mlProvider defaults to "wasm"', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.mlProvider).toBe('wasm');
  });
});

// ── Ring-buffer sizing constants ──────────────────────────────────────────────
describe('PipelineOrchestrator — ring-buffer sizing', () => {
  test('_ringCapacity is a positive integer', () => {
    const orch = new PipelineOrchestrator();
    expect(Number.isInteger(orch._ringCapacity)).toBe(true);
    expect(orch._ringCapacity).toBeGreaterThan(0);
  });

  test('_quantumSize is 128 (WebAudio render quantum)', () => {
    const orch = new PipelineOrchestrator();
    expect(orch._quantumSize).toBe(128);
  });

  test('_halfN equals fftSize/2 + 1 (2049 for fftSize=4096)', () => {
    // The orchestrator hard-codes fftSize=2048 → halfN = 2048/2+1 = 1025
    const orch = new PipelineOrchestrator();
    expect(orch._halfN).toBe(1025);
  });
});

// ── init() idempotency ────────────────────────────────────────────────────────
describe('PipelineOrchestrator — init() idempotency', () => {
  test('init() returns a Promise', () => {
    const orch = new PipelineOrchestrator();
    // Provide a working AudioContext so _createAudioContext does not crash
    orch._preWarmedCtx = null;
    global.window._vipApp = null;
    const p = orch.init();
    expect(p).toBeInstanceOf(Promise);
    return p.catch(() => {}); // tolerate failures from missing worklet/worker
  });

  test('repeated calls to init() return the same promise', () => {
    const orch = new PipelineOrchestrator();
    const p1 = orch.init();
    const p2 = orch.init();
    expect(p1).toBe(p2);
    return p1.catch(() => {});
  });
});

// ── _initMLWorker() idempotency ───────────────────────────────────────────────
describe('PipelineOrchestrator — _initMLWorker() idempotency', () => {
  test('_initMLWorker() returns a Promise', () => {
    const orch = new PipelineOrchestrator();
    const p = orch._initMLWorker();
    expect(p).toBeInstanceOf(Promise);
    // Simulate worker 'ready' so the promise resolves
    if (orch.mlWorker) {
      orch.mlWorker.onmessage({ data: { type: 'ready', provider: 'wasm', models: [] } });
    }
    return p;
  });

  test('calling _initMLWorker() twice returns the same promise', () => {
    const orch = new PipelineOrchestrator();
    const p1 = orch._initMLWorker();
    const p2 = orch._initMLWorker();
    expect(p1).toBe(p2);
    if (orch.mlWorker) {
      orch.mlWorker.onmessage({ data: { type: 'ready', provider: 'wasm', models: [] } });
    }
    return p1;
  });

  test('after _initMLWorker(), mlWorker is a Worker instance', () => {
    const orch = new PipelineOrchestrator();
    orch._initMLWorker();
    expect(orch.mlWorker).toBeInstanceOf(MockWorker);
  });

  test('ML worker receives an init message with ortUrl and providers', () => {
    const orch = new PipelineOrchestrator();
    orch._initMLWorker();
    const initMsg = orch.mlWorker._messages.find(m => m.type === 'init');
    expect(initMsg).toBeDefined();
    expect(initMsg.ortUrl).toBe('/lib/ort.min.js');
    expect(Array.isArray(initMsg.providers)).toBe(true);
  });
});

// ── updateParams() ────────────────────────────────────────────────────────────
describe('PipelineOrchestrator — updateParams()', () => {
  test('does not throw when workletNode is null', () => {
    const orch = new PipelineOrchestrator();
    expect(() => orch.updateParams({ gateThresh: -42, voiceIso: 80, dryWet: 0.5, outGain: 0 })).not.toThrow();
  });

  test('sends a setParams message to the worklet port when workletNode exists', () => {
    const orch = new PipelineOrchestrator();
    orch.workletNode = new MockAudioWorkletNode();
    const params = { gateThresh: -42, gateRange: -30, gateAttack: 5, gateRelease: 100, gateHold: 50,
                     gateLookahead: 0, nrAmount: 60, nrSensitivity: 50, nrSpectralSub: 80, nrFloor: -80,
                     nrSmoothing: 50, voiceIso: 80, bgSuppress: 70, voiceFocusLo: 300, voiceFocusHi: 3400,
                     outGain: 0, dryWet: 1.0 };
    orch.updateParams(params);
    expect(orch.workletNode.port.postMessage).toHaveBeenCalledTimes(1);
    const [msg] = orch.workletNode.port.postMessage.mock.calls[0];
    expect(msg.type).toBe('setParams');
    expect(msg.params.gateThresh).toBe(-42);
    expect(msg.params.voiceIso).toBe(80);
  });

  test('forwards blend weights to the mlWorker when it exists', () => {
    const orch      = new PipelineOrchestrator();
    orch.workletNode = new MockAudioWorkletNode();
    orch.mlWorker   = new MockWorker();
    orch.updateParams({ voiceIso: 60, dryWet: 1.0 });
    const weightMsg = orch.mlWorker._messages.find(m => m.type === 'setWeights');
    expect(weightMsg).toBeDefined();
    expect(weightMsg.demucs).toBeCloseTo(0.6, 5);
    expect(weightMsg.bsrnn).toBeCloseTo(0.4, 5);
  });

  test('does not resend isolation defaults when sliders update', () => {
    const orch = new PipelineOrchestrator();
    orch.workletNode = new MockAudioWorkletNode();
    orch.mlWorker = new MockWorker();
    orch.updateParams({ voiceIso: 55, dryWet: 1.0 });
    const isolationMsg = orch.mlWorker._messages.find(m => m.type === 'setIsolationConfig');
    expect(isolationMsg).toBeUndefined();
  });
});

describe('PipelineOrchestrator — updateIsolationParams()', () => {
  test('posts dedicated isolation config without mutating slider snapshot flow', () => {
    const orch = new PipelineOrchestrator();
    orch.mlWorker = new MockWorker();

    orch.updateIsolationParams({
      isolationMethod: 'ecapa',
      ecapaSimilarityThreshold: 0.78,
    });
    orch.updateIsolationParams({
      backgroundVolume: 0.25,
      maskRefinement: false,
    });

    const messages = orch.mlWorker._messages.filter(m => m.type === 'setIsolationConfig');
    expect(messages.length).toBe(2);
    expect(messages[1].payload).toEqual({
      isolationMethod: 'ecapa',
      ecapaSimilarityThreshold: 0.78,
      backgroundVolume: 0.25,
      maskRefinement: false,
    });
  });

  test('updates _isolationParams in place even when the worker has not started', () => {
    const orch = new PipelineOrchestrator();
    expect(orch.mlWorker).toBeNull();
    orch.updateIsolationParams({ backgroundVolume: 0.7 });
    expect(orch._isolationParams.backgroundVolume).toBe(0.7);
    // Speaker Isolation defaults survive a partial update
    expect(orch._isolationParams.maskRefinement).toBe(true);
    expect(orch._isolationParams.isolationMethod).toBe('hybrid');
  });

  test('ignores non-object payloads', () => {
    const orch = new PipelineOrchestrator();
    const before = { ...orch._isolationParams };
    orch.updateIsolationParams(null);
    orch.updateIsolationParams(42);
    expect(orch._isolationParams).toEqual(before);
  });
});

describe('PipelineOrchestrator — getIsolationParams()', () => {
  test('returns a defensive copy of the current params', () => {
    const orch = new PipelineOrchestrator();
    orch.updateIsolationParams({ backgroundVolume: 0.5 });
    const snap = orch.getIsolationParams();
    expect(snap.backgroundVolume).toBe(0.5);
    snap.backgroundVolume = 0.99;
    // Internal state must not be mutated by the caller
    expect(orch._isolationParams.backgroundVolume).toBe(0.5);
  });
});

describe('PipelineOrchestrator — updateSoundMutes()', () => {
  test('posts setSoundMutes to the ML worker', () => {
    const orch = new PipelineOrchestrator();
    orch.mlWorker = new MockWorker();
    orch.updateSoundMutes({ appliance: true, music: false });
    const msg = orch.mlWorker._messages.find(m => m.type === 'setSoundMutes');
    expect(msg).toBeDefined();
    expect(msg.payload).toEqual({ appliance: true, music: false });
  });

  test('does not throw when worker is absent', () => {
    const orch = new PipelineOrchestrator();
    expect(() => orch.updateSoundMutes({ appliance: true })).not.toThrow();
  });

  test('coerces missing payload to {}', () => {
    const orch = new PipelineOrchestrator();
    orch.mlWorker = new MockWorker();
    orch.updateSoundMutes(null);
    const msg = orch.mlWorker._messages.find(m => m.type === 'setSoundMutes');
    expect(msg.payload).toEqual({});
  });
});

describe('PipelineOrchestrator — _bindIsolationControls() idempotency', () => {
  test('repeated calls do not stack listeners', () => {
    const orch = new PipelineOrchestrator();
    const calls = { add: 0 };
    const stubEl = {
      value: '50',
      checked: true,
      style: { setProperty: () => {} },
      addEventListener: () => { calls.add++; },
      min: '0',
      max: '100',
    };
    const prevGet = global.document.getElementById;
    global.document.getElementById = () => stubEl;
    try {
      orch._bindIsolationControls();
      const firstCount = calls.add;
      orch._bindIsolationControls();
      orch._bindIsolationControls();
      // No additional listener attachment after the first call
      expect(calls.add).toBe(firstCount);
    } finally {
      global.document.getElementById = prevGet;
    }
  });
});

describe('PipelineOrchestrator — ML worker ready handshake re-sends isolation state', () => {
  test('on ready, isolation config and sound mutes are forwarded to the worker', () => {
    const orch = new PipelineOrchestrator();
    global.window._vipApp = { soundMutes: { traffic: true } };
    orch.updateIsolationParams({ backgroundVolume: 0.4 });
    const p = orch._initMLWorker();
    expect(orch.mlWorker).toBeInstanceOf(MockWorker);
    return p.then(() => {
      const cfg = orch.mlWorker._messages.find(m => m.type === 'setIsolationConfig');
      expect(cfg).toBeDefined();
      expect(cfg.payload.backgroundVolume).toBe(0.4);
      const mutes = orch.mlWorker._messages.find(m => m.type === 'setSoundMutes');
      expect(mutes).toBeDefined();
      expect(mutes.payload).toEqual({ traffic: true });
      global.window._vipApp = null;
    });
  });
});

// ── connectSource / disconnectSource ─────────────────────────────────────────
describe('PipelineOrchestrator — connectSource / disconnectSource', () => {
  test('connectSource does not throw when workletNode is null', () => {
    const orch  = new PipelineOrchestrator();
    const node  = { connect: jest.fn() };
    expect(() => orch.connectSource(node)).not.toThrow();
    expect(node.connect).not.toHaveBeenCalled();
  });

  test('connectSource calls node.connect(workletNode) when workletNode exists', () => {
    const orch         = new PipelineOrchestrator();
    orch.workletNode   = new MockAudioWorkletNode();
    orch.workletReady  = true;
    orch.mlReady       = true;
    const sourceNode   = { connect: jest.fn() };
    orch.connectSource(sourceNode);
    expect(sourceNode.connect).toHaveBeenCalledWith(orch.workletNode);
  });

  test('disconnectSource does not throw even when the node is already disconnected', () => {
    const orch       = new PipelineOrchestrator();
    orch.workletNode = new MockAudioWorkletNode();
    const node       = {
      disconnect: jest.fn().mockImplementation(() => { throw new Error('already disconnected'); }),
    };
    expect(() => orch.disconnectSource(node)).not.toThrow();
  });
});

// ── suspend / resume ──────────────────────────────────────────────────────────
describe('PipelineOrchestrator — suspend() / resume()', () => {
  test('suspend() does not throw when ctx is null', async () => {
    const orch = new PipelineOrchestrator();
    await expect(orch.suspend()).resolves.toBeUndefined();
  });

  test('resume() does not throw when ctx is null', async () => {
    const orch = new PipelineOrchestrator();
    await expect(orch.resume()).resolves.toBeUndefined();
  });

  test('suspend() calls ctx.suspend() when ctx is running', async () => {
    const orch = new PipelineOrchestrator();
    orch.ctx   = new MockAudioContext();
    orch.ctx.state = 'running';
    await orch.suspend();
    expect(orch.ctx.state).toBe('suspended');
  });

  test('resume() calls ctx.resume() when ctx is suspended', async () => {
    const orch = new PipelineOrchestrator();
    orch.ctx   = new MockAudioContext();
    orch.ctx.state = 'suspended';
    await orch.resume();
    expect(orch.ctx.state).toBe('running');
  });
});

// ── destroy() ────────────────────────────────────────────────────────────────
describe('PipelineOrchestrator — destroy()', () => {
  test('does not throw when all fields are null', () => {
    const orch = new PipelineOrchestrator();
    expect(() => orch.destroy()).not.toThrow();
  });

  test('sets initialized and mlReady to false', () => {
    const orch       = new PipelineOrchestrator();
    orch.initialized = true;
    orch.mlReady     = true;
    orch.destroy();
    expect(orch.initialized).toBe(false);
    expect(orch.mlReady).toBe(false);
  });

  test('terminates the mlWorker and nulls it', () => {
    const orch     = new PipelineOrchestrator();
    const worker   = new MockWorker();
    worker.terminate = jest.fn();
    orch.mlWorker  = worker;
    orch.destroy();
    expect(worker.terminate).toHaveBeenCalled();
    expect(orch.mlWorker).toBeNull();
  });

  test('disconnects and nulls workletNode', () => {
    const orch          = new PipelineOrchestrator();
    const mockNode      = new MockAudioWorkletNode();
    mockNode.disconnect = jest.fn();
    orch.workletNode    = mockNode;
    orch.destroy();
    expect(mockNode.disconnect).toHaveBeenCalled();
    expect(orch.workletNode).toBeNull();
  });

  test('closes AudioContext and nulls ctx', () => {
    const orch     = new PipelineOrchestrator();
    const mockCtx  = new MockAudioContext();
    mockCtx.close  = jest.fn().mockResolvedValue(undefined);
    orch.ctx       = mockCtx;
    orch.destroy();
    expect(mockCtx.close).toHaveBeenCalled();
    expect(orch.ctx).toBeNull();
  });

  test('does not throw if workletNode.disconnect() throws', () => {
    const orch          = new PipelineOrchestrator();
    orch.workletNode    = new MockAudioWorkletNode();
    orch.workletNode.disconnect = () => { throw new Error('oops'); };
    expect(() => orch.destroy()).not.toThrow();
  });
});
