'use strict';

const fs = require('fs');
const path = require('path');

// Load DSPCore to give the worker a real DSP implementation
const dspCoreJs = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const DSPCore = (() => {
  const exports = {};
  const module = { exports };
  const window = {};
  const self = {};
  eval(dspCoreJs); // eslint-disable-line no-eval
  return module.exports;
})();

const workerSrc = fs.readFileSync(path.join(__dirname, '../public/app/dsp-worker.js'), 'utf8');

/**
 * Spin up a fresh worker instance by evaluating the source inside a mock
 * self/importScripts environment. Returns the mock self (with .onmessage set)
 * and a messages array that accumulates every postMessage call.
 */
function loadWorker() {
  const messages = [];
  const mockSelf = {
    DSPCore,         // importScripts mock copies this onto self
    ort: null,       // no ONNX runtime by default
    onmessage: null,
    postMessage(msg, transfers) { messages.push({ msg, transfers }); },
  };

  function importScripts() {
    // dsp-core.js is already available as mockSelf.DSPCore — no-op
  }

  const fn = new Function('self', 'importScripts', 'module', workerSrc);
  fn(mockSelf, importScripts, { exports: {} });

  return { self: mockSelf, messages };
}

/** Dispatch a message and wait for the async handler to fully settle. */
async function dispatch(mockSelf, messages, type, payload, id = 1) {
  const before = messages.length;
  await mockSelf.onmessage({ data: { type, id, payload } });
  return messages.slice(before);
}

// ── message routing ───────────────────────────────────────────────────────────

describe('dsp-worker message routing', () => {
  test('unknown type posts an error response', async () => {
    const { self: s, messages } = loadWorker();
    const replies = await dispatch(s, messages, 'unknown_type', {});
    expect(replies[0].msg.type).toBe('error');
    expect(replies[0].msg.error).toMatch(/Unknown message type/);
  });

  test('reply id always mirrors request id', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 42);
    expect(messages[0].msg.id).toBe(42);
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

describe('dsp-worker: init', () => {
  test('returns status=initialized with provided sampleRate', async () => {
    const { self: s, messages } = loadWorker();
    const [r] = await dispatch(s, messages, 'init', { sampleRate: 44100 });
    expect(r.msg.type).toBe('result');
    expect(r.msg.result.status).toBe('initialized');
    expect(r.msg.result.sampleRate).toBe(44100);
  });

  test('defaults sampleRate to 48000 when not provided', async () => {
    const { self: s, messages } = loadWorker();
    const [r] = await dispatch(s, messages, 'init', {});
    expect(r.msg.result.sampleRate).toBe(48000);
  });
});

// ── process ───────────────────────────────────────────────────────────────────

describe('dsp-worker: process', () => {
  test('process before init posts error', async () => {
    const { self: s, messages } = loadWorker();
    const audio = new Float32Array(8192).fill(0.1);
    const [r] = await dispatch(s, messages, 'process', { audioData: audio.buffer, sampleRate: 48000 });
    expect(r.msg.type).toBe('error');
    expect(r.msg.error).toMatch(/not initialized/);
  });

  test('process after init returns result with processedData ArrayBuffer', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(8192).fill(0.1);
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer, sampleRate: 48000, params: null, enabledModels: []
    }, 2);
    expect(r.msg.type).toBe('result');
    // Check byteLength rather than instanceof to avoid cross-realm constructor mismatch
    expect(r.msg.result.processedData.byteLength).toBeGreaterThanOrEqual(0);
  });

  test('processedData result key is present and buffer-like', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(8192).fill(0.1);
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer, sampleRate: 48000, params: null
    }, 2);
    expect(r.msg.type).toBe('result');
    expect(typeof r.msg.result.processedData.byteLength).toBe('number');
  });

  test('process with params applies spectral operations without crashing', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(8192).fill(0.2);
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer,
      sampleRate: 48000,
      params: { nrFloor: -60, nrAmount: 50 },
      enabledModels: []
    }, 2);
    expect(r.msg.type).toBe('result');
  });

  test('process with all-zeros audio returns without error', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(8192); // all zeros
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer, sampleRate: 48000, params: null
    }, 2);
    expect(r.msg.type).toBe('result');
  });

  test('process with short (< fftSize) audio completes without error', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(512).fill(0.1); // shorter than fftSize=4096
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer, sampleRate: 48000, params: null
    }, 2);
    // Should not crash — STFT will have 0 frames; iSTFT returns empty buffer
    expect(r.msg.type).toBe('result');
  });
});

// ── loadModel ─────────────────────────────────────────────────────────────────

describe('dsp-worker: loadModel', () => {
  test('without ort available posts descriptive error', async () => {
    const { self: s, messages } = loadWorker();
    const [r] = await dispatch(s, messages, 'loadModel', {
      modelName: 'vad', modelPath: '/models/silero_vad.onnx'
    });
    expect(r.msg.type).toBe('error');
    expect(r.msg.error).toMatch(/onnxruntime/i);
  });

  test('with mock ort resolves successfully', async () => {
    const { self: s, messages } = loadWorker();
    s.ort = {
      InferenceSession: {
        create: jest.fn().mockResolvedValue({
          inputNames: ['input'],
          outputNames: ['output'],
        }),
      },
    };
    const [r] = await dispatch(s, messages, 'loadModel', {
      modelName: 'test_model', modelPath: '/models/test.onnx'
    });
    expect(r.msg.type).toBe('result');
    expect(r.msg.result.status).toBe('loaded');
    expect(r.msg.result.modelName).toBe('test_model');
    expect(r.msg.result.inputNames).toEqual(['input']);
  });

  test('ort.InferenceSession.create failure posts error', async () => {
    const { self: s, messages } = loadWorker();
    s.ort = {
      InferenceSession: {
        create: jest.fn().mockRejectedValue(new Error('model not found')),
      },
    };
    const [r] = await dispatch(s, messages, 'loadModel', {
      modelName: 'bad_model', modelPath: '/missing.onnx'
    });
    expect(r.msg.type).toBe('error');
    expect(r.msg.error).toMatch(/model not found/);
  });
});

// ── getMetrics / reset ────────────────────────────────────────────────────────

describe('dsp-worker: getMetrics and reset', () => {
  test('getMetrics before init returns empty object', async () => {
    const { self: s, messages } = loadWorker();
    const [r] = await dispatch(s, messages, 'getMetrics', {});
    expect(r.msg.type).toBe('result');
    expect(r.msg.result).toEqual({});
  });

  test('reset after init returns status=reset', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const [r] = await dispatch(s, messages, 'reset', {});
    expect(r.msg.result.status).toBe('reset');
  });

  test('reset before init does not throw', async () => {
    const { self: s, messages } = loadWorker();
    const [r] = await dispatch(s, messages, 'reset', {});
    expect(r.msg.type).toBe('result');
  });
});

// ── demucs branch (enabled but no session) ───────────────────────────────────

describe('dsp-worker: demucs graceful fallback', () => {
  test('enabledModels includes demucs but session missing → falls back silently', async () => {
    const { self: s, messages } = loadWorker();
    await dispatch(s, messages, 'init', { sampleRate: 48000 }, 1);
    messages.length = 0;
    const audio = new Float32Array(8192).fill(0.1);
    const [r] = await dispatch(s, messages, 'process', {
      audioData: audio.buffer,
      sampleRate: 48000,
      params: null,
      enabledModels: ['demucs'], // listed but not loaded
    }, 2);
    // Should fall back to classical DSP without error
    expect(r.msg.type).toBe('result');
  });
});

// ── fallback conditioning off the main thread (audit PERF-001) ────────────────

describe('dsp-worker: condition', () => {
  function fixture(n = 48000) {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / 48000) + 0.02 + (i % 9000 === 0 ? 0.9 : 0);
    }
    return x;
  }
  const params = { clickSensitivity: 3, gateThresh: -42, deEssAmt: 40, deEssFreq: 6500 };

  test('matches the in-thread DSPCore chain sample for sample', async () => {
    const { self: s, messages } = loadWorker();
    const input = fixture();
    const expected = DSPCore.conditionFallbackChannel(new Float32Array(input), params, 48000);
    const buf = new Float32Array(input).buffer;
    const [reply] = await dispatch(s, messages, 'condition', { channels: [buf], sampleRate: 48000, params });
    expect(reply.msg.type).toBe('result');
    const out = new Float32Array(reply.msg.result.channels[0]);
    expect(out.length).toBe(input.length);
    expect(Array.from(out)).toEqual(Array.from(expected));
    // The chain changed the audio (DC removed, click repaired), not a passthrough.
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i] - input[i]));
    expect(diff).toBeGreaterThan(0.01);
  });

  test('eqDynamics matches the in-thread DSPCore pass', async () => {
    const { self: s, messages } = loadWorker();
    const input = fixture();
    const p = { hpFreq: 80, eqPresence: 4, compRatio: 3, compThresh: -20, limThresh: -1 };
    const expected = DSPCore.eqDynamicsChannel(new Float32Array(input), p, 48000);
    const [reply] = await dispatch(s, messages, 'eqDynamics', {
      channels: [new Float32Array(input).buffer], sampleRate: 48000, params: p,
    });
    expect(Array.from(new Float32Array(reply.msg.result.channels[0]))).toEqual(Array.from(expected));
  });

  test('returns channel buffers as transfers, not clones', async () => {
    const { self: s, messages } = loadWorker();
    const [reply] = await dispatch(s, messages, 'condition', {
      channels: [fixture(4800).buffer, fixture(4800).buffer], sampleRate: 48000, params,
    });
    expect(reply.msg.result.channels).toHaveLength(2);
    expect(reply.transfers).toEqual(reply.msg.result.channels);
  });
});
