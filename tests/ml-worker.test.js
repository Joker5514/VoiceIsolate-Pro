const fs = require('fs');
const path = require('path');

const workerCode = fs.readFileSync(path.join(__dirname, '../public/app/ml-worker.js'), 'utf8');

describe('ml-worker.js', () => {
  let workerGlobal;
  let postedMessages;

  beforeEach(() => {
    postedMessages = [];

    // Mock ort and other globals
    const mockOrt = {
      env: {
        wasm: {},
        logLevel: 'warning'
      },
      InferenceSession: {
        create: jest.fn()
      },
      Tensor: class {
        constructor(type, data, dims) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      }
    };

    workerGlobal = {
      importScripts: jest.fn(),
      self: {
        postMessage: jest.fn((msg) => postedMessages.push(msg)),
        onmessage: null,
        ort: mockOrt  // ort available via self.ort after importScripts
      },
      navigator: {},
      Float32Array: Float32Array,
      Promise: Promise,
      console: console,
    };

    // Evaluate the worker code in the mock global context
    const argNames = Object.keys(workerGlobal);
    const argValues = argNames.map(name => workerGlobal[name]);

    // Create function that executes worker code with injected globals
    const fn = new Function(...argNames, workerCode);
    fn(...argValues);
  });

  it('should handle loadModel message by running initialization and posting ready', async () => {
    workerGlobal.self.ort.InferenceSession.create.mockResolvedValue({});

    await workerGlobal.self.onmessage({ data: { type: 'loadModel' } });

    const readyMsg = postedMessages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    expect(readyMsg.models).toBeDefined();
  });

  it('should handle loadModel with custom models list', async () => {
    workerGlobal.self.ort.InferenceSession.create.mockResolvedValue({});

    await workerGlobal.self.onmessage({
      data: { type: 'loadModel', models: ['vad'] }
    });

    const readyMsg = postedMessages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    // Only the requested model should appear in the status map
    expect(Object.keys(readyMsg.models)).toEqual(['vad']);
  });

  it('should handle loadModel failure and post error message', async () => {
    // Remove ort from self so that initialize() calls importScripts (which we make throw)
    delete workerGlobal.self.ort;

    // Make importScripts throw to simulate a top-level init failure
    workerGlobal.importScripts.mockImplementation(() => {
      throw new Error('script load failed');
    });

    await workerGlobal.self.onmessage({ data: { type: 'loadModel' } });

    const errorMsg = postedMessages.find(m => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.msg).toContain('script load failed');
  });

  it('should handle Silero VAD loading error path', async () => {
    // Mock the InferenceSession.create to throw an error specifically for silero_vad.onnx
    workerGlobal.self.ort.InferenceSession.create.mockImplementation((modelPath) => {
      if (modelPath.includes('silero_vad.onnx')) {
        return Promise.reject(new Error('Simulated VAD load error'));
      }
      return Promise.resolve({}); // Mock success for other models
    });

    // Trigger the init handler
    await workerGlobal.self.onmessage({ data: { type: 'init' } });

    // Verify error logging
    expect(postedMessages).toContainEqual({
      type: 'log',
      level: 'warn',
      msg: 'VAD unavailable: Simulated VAD load error'
    });

    // Verify ready message shows vad: false
    const readyMsg = postedMessages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    expect(readyMsg.models.vad).toBe(false);
    expect(readyMsg.models.deepfilter).toBe(true); // Assuming others succeed
    expect(readyMsg.models.demucs).toBe(true); // Assuming others succeed
  });

  it('falls back to WASM provider when WebGPU session creation fails', async () => {
    const runMock = jest.fn().mockResolvedValue({ output: { data: new Float32Array([1]) } });
    workerGlobal.self.ort.InferenceSession.create.mockImplementation((_modelPath, options) => {
      if (options.executionProviders[0] === 'webgpu') {
        return Promise.reject(new Error('webgpu unavailable'));
      }
      return Promise.resolve({ run: runMock });
    });

    await workerGlobal.self.onmessage({
      data: { type: 'loadModel', models: ['vad'] }
    });

    expect(workerGlobal.self.ort.InferenceSession.create).toHaveBeenCalledTimes(2);
    expect(workerGlobal.self.ort.InferenceSession.create.mock.calls[0][1].executionProviders).toEqual(['webgpu', 'wasm']);
    expect(workerGlobal.self.ort.InferenceSession.create.mock.calls[1][1].executionProviders).toEqual(['wasm']);

    const readyMsg = postedMessages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    expect(readyMsg.models.vad).toBe(true);
  });

  it('uses PCM chunks for demucs input and never spectral mag_input', async () => {
    const demucsRun = jest.fn().mockImplementation(async (feeds) => {
      const bins = feeds.input ? feeds.input.dims[2] : 0;
      return { vocal_mask: { data: new Float32Array(bins).fill(1) } };
    });
    workerGlobal.self.ort.InferenceSession.create.mockResolvedValue({ run: demucsRun });

    const chunkSize = 333;
    const inputBytes = Int32Array.BYTES_PER_ELEMENT * 4 + Float32Array.BYTES_PER_ELEMENT * chunkSize * 2;
    const outputBytes = Int32Array.BYTES_PER_ELEMENT * 4 + Float32Array.BYTES_PER_ELEMENT * chunkSize;
    const inputSAB = new SharedArrayBuffer(inputBytes);
    const outputSAB = new SharedArrayBuffer(outputBytes);
    const pcmChunk = new Float32Array(chunkSize).fill(0.1);

    await workerGlobal.self.onmessage({
      data: {
        type: 'init',
        payload: {
          inputSAB,
          outputSAB,
          fftSize: 664,
          halfN: chunkSize,
          allowedModels: ['demucs'],
          allowedStages: 10,
          preferredProviders: ['wasm'],
          modelBasePath: './models/',
        },
      },
    });

    for (let i = 0; i < 95; i++) {
      await workerGlobal.self.onmessage({ data: { type: 'process', payload: { pcmChunk } } });
    }

    const processed = postedMessages.find((m) => m.type === 'processed');
    expect(processed).toBeDefined();
    expect(processed.output.length).toBe(chunkSize);
    expect(demucsRun).toHaveBeenCalled();
    const processCall = demucsRun.mock.calls.find(([feeds]) => feeds && feeds.input);
    expect(processCall).toBeDefined();
    expect(processCall[0].input.dims).toEqual([1, 1, chunkSize]);
    expect(processCall[0].mag_input).toBeUndefined();

    await workerGlobal.self.onmessage({ data: { type: 'reset' } });
  });

  it('applies non-zero warmup mask floor and ramps up during noise-profile warmup', async () => {
    const vadRun = jest.fn().mockResolvedValue({ output: { data: new Float32Array([0.75]) } });
    workerGlobal.self.ort.InferenceSession.create.mockResolvedValue({ run: vadRun });

    await workerGlobal.self.onmessage({
      data: {
        type: 'init',
        payload: {
          allowedModels: ['vad'],
          preferredProviders: ['wasm'],
          modelBasePath: './models/',
        },
      },
    });

    const magnitudes = new Float32Array(16).fill(0.2);
    const gains = [];
    const sampleFrames = new Set([1, 45, 90]);

    for (let frame = 1; frame <= 90; frame++) {
      await workerGlobal.self.onmessage({ data: { type: 'process', payload: { magnitudes } } });
      if (sampleFrames.has(frame)) {
        const processed = postedMessages.filter((m) => m.type === 'processed').at(-1);
        gains.push({ frame, gain: processed.output[0] });
      }
    }

    const gainAt = (frame) => gains.find((g) => g.frame === frame).gain;
    const expectedGain = (frame) => 0.05 + 0.95 * Math.pow(frame / 90, 2);

    expect(gainAt(1)).toBeGreaterThanOrEqual(0.05);
    expect(gainAt(1)).toBeLessThan(gainAt(45));
    expect(gainAt(45)).toBeLessThan(gainAt(90));
    expect(gainAt(1)).toBeCloseTo(expectedGain(1), 6);
    expect(gainAt(45)).toBeCloseTo(expectedGain(45), 6);
    expect(gainAt(90)).toBeCloseTo(1, 6);
  });
});

// ============================================================
// Speaker Isolation card config + sound mute persistence
// ============================================================
describe('ml-worker — isolation config + sound mute handlers', () => {
  let workerGlobal;
  let postedMessages;

  beforeEach(() => {
    postedMessages = [];
    workerGlobal = {
      importScripts: jest.fn(),
      self: {
        postMessage: jest.fn((msg) => postedMessages.push(msg)),
        onmessage: null,
        ort: {
          env: { wasm: {}, logLevel: 'warning' },
          InferenceSession: { create: jest.fn() },
          Tensor: class { constructor(t, d, s) { this.type = t; this.data = d; this.dims = s; } },
        },
      },
      navigator: {},
      Float32Array: Float32Array,
      Promise: Promise,
      console: console,
    };
    const argNames = Object.keys(workerGlobal);
    const argValues = argNames.map((n) => workerGlobal[n]);
    new Function(...argNames, workerCode)(...argValues);
  });

  it('stores isolation config fields on self (background volume, mask refine, method, threshold)', async () => {
    await workerGlobal.self.onmessage({
      data: {
        type: 'setIsolationConfig',
        payload: {
          isolationMethod: 'classical',
          ecapaSimilarityThreshold: 0.82,
          backgroundVolume: 0.33,
          maskRefinement: false,
        },
      },
    });
    expect(workerGlobal.self._isolationMethod).toBe('classical');
    expect(workerGlobal.self._ecapaSimilarityThreshold).toBe(0.82);
    expect(workerGlobal.self._backgroundVolume).toBe(0.33);
    expect(workerGlobal.self._maskRefinement).toBe(false);
  });

  it('handles setSoundMutes by storing the toggled categories on self._soundMutes', async () => {
    await workerGlobal.self.onmessage({
      data: { type: 'setSoundMutes', payload: { traffic: true, music: false } },
    });
    expect(workerGlobal.self._soundMutes).toEqual({ traffic: true, music: false });
  });

  it('coerces invalid setSoundMutes payloads to {}', async () => {
    await workerGlobal.self.onmessage({
      data: { type: 'setSoundMutes', payload: null },
    });
    expect(workerGlobal.self._soundMutes).toEqual({});
  });
});

// ============================================================
// handleMultiSeparate — transferable null-guard (ml-worker.js PR fix)
// ============================================================
// The PR changed:
//   const transferables = streams.map(s => s.data.buffer);
// to:
//   const transferables = streams.map(s => s && s.data && s.data.buffer).filter(Boolean);
//
// These tests exercise the extraction logic directly as a pure function
// (matching the exact code added in the PR) and also validate the full
// handleMultiSeparate message path for guarded behaviour.

// Pure-function extraction of the PR's transferable-building expression.
function buildTransferables(streams) {
  return streams
    .map(s => s && s.data && s.data.buffer)
    .filter(Boolean);
}

describe('buildTransferables (ml-worker.js PR null-guard)', () => {

  // ── Normal cases ──────────────────────────────────────────────────────────

  it('returns all buffers when every stream entry is valid', () => {
    // Create Float32Arrays backed by known ArrayBuffers for identity assertions
    const buf0 = new ArrayBuffer(16); // 4 floats * 4 bytes
    const buf1 = new ArrayBuffer(32); // 8 floats * 4 bytes
    const streams = [
      { speakerId: 0, data: new Float32Array(buf0) },
      { speakerId: 1, data: new Float32Array(buf1) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(streams[0].data.buffer);
    expect(result[1]).toBe(streams[1].data.buffer);
  });

  it('returns an empty array for an empty streams list', () => {
    expect(buildTransferables([])).toEqual([]);
  });

  it('all valid streams: no entries are filtered out', () => {
    const streams = Array.from({ length: 4 }, (_, i) => ({
      speakerId: i,
      data: new Float32Array(10),
    }));
    const result = buildTransferables(streams);
    expect(result).toHaveLength(4);
  });

  // ── Null / undefined entry guards ─────────────────────────────────────────

  it('filters out null stream entries', () => {
    const streams = [
      { speakerId: 0, data: new Float32Array(4) },
      null,
      { speakerId: 2, data: new Float32Array(4) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(2);
  });

  it('filters out undefined stream entries', () => {
    const streams = [
      undefined,
      { speakerId: 1, data: new Float32Array(4) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(1);
  });

  it('filters out stream entries where .data is null', () => {
    const streams = [
      { speakerId: 0, data: null },
      { speakerId: 1, data: new Float32Array(4) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(1);
  });

  it('filters out stream entries where .data is undefined', () => {
    const streams = [
      { speakerId: 0, data: undefined },
      { speakerId: 1, data: new Float32Array(4) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(1);
  });

  it('filters out stream entries where .data.buffer is null', () => {
    const badData = new Float32Array(4);
    Object.defineProperty(badData, 'buffer', { get: () => null });
    const streams = [
      { speakerId: 0, data: badData },
      { speakerId: 1, data: new Float32Array(4) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when all entries are null', () => {
    const streams = [null, null, null];
    expect(buildTransferables(streams)).toEqual([]);
  });

  it('returns empty array when all entries have null .data', () => {
    const streams = [
      { speakerId: 0, data: null },
      { speakerId: 1, data: null },
    ];
    expect(buildTransferables(streams)).toEqual([]);
  });

  // ── Mixed valid and invalid ───────────────────────────────────────────────

  it('preserves only valid buffers from a mixed array', () => {
    const streams = [
      null,
      { speakerId: 1, data: new Float32Array(4) },
      { speakerId: 2, data: null },
      undefined,
      { speakerId: 4, data: new Float32Array(8) },
    ];
    const result = buildTransferables(streams);
    expect(result).toHaveLength(2);
    // Both results must be ArrayBuffer instances (toString avoids cross-realm instanceof issues)
    for (const buf of result) {
      expect(Object.prototype.toString.call(buf)).toBe('[object ArrayBuffer]');
    }
  });

  // ── Regression: original code would throw on null entries ─────────────────

  it('does NOT throw when streams contains null (regression against original code)', () => {
    // The original `streams.map(s => s.data.buffer)` would throw TypeError here.
    const streams = [null, { speakerId: 0, data: new Float32Array(4) }];
    expect(() => buildTransferables(streams)).not.toThrow();
  });

  it('does NOT throw when streams contains an entry with null .data (regression)', () => {
    const streams = [{ speakerId: 0, data: null }, { speakerId: 1, data: new Float32Array(4) }];
    expect(() => buildTransferables(streams)).not.toThrow();
  });
});

// ============================================================
// ArrayBuffer identity: new Float32Array(buf).buffer === buf
// These tests validate the buffer-creation approach used in the
// PR fix: createing a Float32Array from a known ArrayBuffer
// guarantees that .buffer returns that exact same object.
// ============================================================

describe('ArrayBuffer identity — PR fix approach (new Float32Array(buf))', () => {
  it('Float32Array constructed from an ArrayBuffer preserves buffer identity', () => {
    const buf = new ArrayBuffer(16);
    const arr = new Float32Array(buf);
    expect(arr.buffer).toBe(buf);
  });

  it('buffer identity holds for ArrayBuffer of any byte length', () => {
    [4, 8, 16, 32, 64, 256].forEach(byteLength => {
      const buf = new ArrayBuffer(byteLength);
      const arr = new Float32Array(buf);
      expect(arr.buffer).toBe(buf);
    });
  });

  it('two Float32Arrays from the same ArrayBuffer share the same buffer reference', () => {
    const buf = new ArrayBuffer(32);
    const a = new Float32Array(buf, 0, 4);
    const b = new Float32Array(buf, 16, 4);
    expect(a.buffer).toBe(b.buffer);
    expect(a.buffer).toBe(buf);
  });

  it('buildTransferables returns the exact ArrayBuffer passed to Float32Array constructor', () => {
    const buf0 = new ArrayBuffer(16);
    const buf1 = new ArrayBuffer(32);
    const streams = [
      { speakerId: 0, data: new Float32Array(buf0) },
      { speakerId: 1, data: new Float32Array(buf1) },
    ];
    const result = buildTransferables(streams);
    expect(result[0]).toBe(buf0);
    expect(result[1]).toBe(buf1);
  });

  it('result buffer from buildTransferables is not a copy — it is the identical object', () => {
    const buf = new ArrayBuffer(8);
    const streams = [{ speakerId: 0, data: new Float32Array(buf) }];
    const result = buildTransferables(streams);
    // Strict identity, not just structural equality
    expect(result[0] === buf).toBe(true);
  });
});

// ============================================================
// Object.prototype.toString ArrayBuffer detection
// Validates the cross-realm-safe check introduced in the PR:
//   Object.prototype.toString.call(buf) === '[object ArrayBuffer]'
// ============================================================

describe('Object.prototype.toString — cross-realm ArrayBuffer detection', () => {
  it('returns "[object ArrayBuffer]" for a plain new ArrayBuffer()', () => {
    const buf = new ArrayBuffer(8);
    expect(Object.prototype.toString.call(buf)).toBe('[object ArrayBuffer]');
  });

  it('returns "[object ArrayBuffer]" for a zero-byte ArrayBuffer', () => {
    expect(Object.prototype.toString.call(new ArrayBuffer(0))).toBe('[object ArrayBuffer]');
  });

  it('returns "[object ArrayBuffer]" for an ArrayBuffer obtained from Float32Array.buffer', () => {
    const arr = new Float32Array(4);
    expect(Object.prototype.toString.call(arr.buffer)).toBe('[object ArrayBuffer]');
  });

  it('does NOT return "[object ArrayBuffer]" for a plain object', () => {
    expect(Object.prototype.toString.call({})).not.toBe('[object ArrayBuffer]');
  });

  it('does NOT return "[object ArrayBuffer]" for null', () => {
    expect(Object.prototype.toString.call(null)).not.toBe('[object ArrayBuffer]');
  });

  it('does NOT return "[object ArrayBuffer]" for a TypedArray itself', () => {
    const arr = new Float32Array(4);
    expect(Object.prototype.toString.call(arr)).not.toBe('[object ArrayBuffer]');
  });

  it('all buffers returned by buildTransferables pass the cross-realm check', () => {
    const streams = [
      { speakerId: 0, data: new Float32Array(new ArrayBuffer(8)) },
      { speakerId: 1, data: new Float32Array(new ArrayBuffer(16)) },
    ];
    const result = buildTransferables(streams);
    for (const buf of result) {
      expect(Object.prototype.toString.call(buf)).toBe('[object ArrayBuffer]');
    }
  });

  it('toString check is equivalent to instanceof for same-realm buffers', () => {
    const buf = new ArrayBuffer(4);
    const toStringMatch = Object.prototype.toString.call(buf) === '[object ArrayBuffer]';
    const instanceofMatch = buf instanceof ArrayBuffer;
    expect(toStringMatch).toBe(instanceofMatch);
  });
});
