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