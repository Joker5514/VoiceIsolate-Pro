/**
 * VoiceIsolate Pro — AudioWorklet Loader Fallback and Failure Tests
 *
 * This test suite verifies the loadDspProcessorWorklet helper function
 * in public/app/pipeline-orchestrator.js under various fetch conditions,
 * specifically testing that:
 *   1. It succeeds via the same-origin path if available.
 *   2. It falls back to the CDN mirror if the same-origin path fails.
 *   3. It rejects and throws appropriate errors if CDN mirrors return incorrect
 *      files (missing registration, hash integrity mismatches, HTTP errors).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Web API Mocks ─────────────────────────────────────────────────────────────

class MockAudioContext {
  constructor() {
    this.audioWorklet = {
      addModule: jest.fn()
    };
  }
}

// Custom Blob mock
class MockBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.options = options;
  }
}

// Simple Web Crypto subtle digest mock
const mockSubtleDigest = async (algorithm, data) => {
  if (algorithm.toUpperCase() !== 'SHA-256') {
    throw new Error('Unsupported algorithm in mock: ' + algorithm);
  }
  const hash = crypto.createHash('sha256').update(data);
  const buffer = hash.digest();
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

// ── Load the target function ──────────────────────────────────────────────────
const orchSrc = fs.readFileSync(
  path.resolve(__dirname, '../public/app/pipeline-orchestrator.js'),
  'utf8'
);

// Append export so we can test the loadDspProcessorWorklet function in isolation
const orchSrcWithExport = orchSrc + '\nif (typeof module !== "undefined") module.exports = { loadDspProcessorWorklet, _WORKLET_FALLBACK_CACHE };';

let loadDspProcessorWorklet;
let _WORKLET_FALLBACK_CACHE;
{
  // Set up globals needed for the script execution
  global.window = {};
  global.self = {};
  global.crypto = {
    subtle: {
      digest: mockSubtleDigest
    }
  };
  global.TextEncoder = require('util').TextEncoder;
  global.Blob = MockBlob;
  global.URL = {
    createObjectURL: jest.fn().mockReturnValue('blob:mock-url'),
    revokeObjectURL: jest.fn(),
  };
  global.fetch = jest.fn();

  // Stub setInterval/clearInterval during script load to avoid timers hanging Jest
  const origSetInterval = global.setInterval;
  const origClearInterval = global.clearInterval;
  global.setInterval = () => 0;
  global.clearInterval = () => {};

  const mod = { exports: {} };
  (function(module) {
    /* eslint-disable no-eval */
    eval(orchSrcWithExport);
    /* eslint-enable no-eval */
  })(mod);
  loadDspProcessorWorklet = mod.exports.loadDspProcessorWorklet;
  _WORKLET_FALLBACK_CACHE = mod.exports._WORKLET_FALLBACK_CACHE;

  // Restore timers
  global.setInterval = origSetInterval;
  global.clearInterval = origClearInterval;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('AudioWorklet Loader and Fallback — loadDspProcessorWorklet', () => {
  let ctx;
  const canonicalHash = 'f7342fdb267b89d1544d228f41ed9a4fa60ce86c3dee774927682bc2834b8795';
  const canonicalSrc = 'registerProcessor("dsp-processor", class DspProcessor {});';

  beforeEach(() => {
    ctx = new MockAudioContext();
    jest.clearAllMocks();
    global.fetch = jest.fn();
    if (_WORKLET_FALLBACK_CACHE) {
      _WORKLET_FALLBACK_CACHE.manifest = null;
      _WORKLET_FALLBACK_CACHE.sourceText = null;
    }
  });

  test('Primary path: succeeds via same-origin and returns "same-origin"', async () => {
    ctx.audioWorklet.addModule.mockResolvedValue(undefined);

    const result = await loadDspProcessorWorklet(ctx);

    expect(result).toBe('same-origin');
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/app/dsp-processor.js');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Fallback path: fetches from CDN mirror when same-origin fails', async () => {
    // 1. Same-origin fails
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('404 same-origin worklet not found'));
    // 2. Mock manifest fetch (returns our test manifest with a mock Verel Blob CDN entry)
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        worklets: {
          dsp_processor: {
            sources: [
              { provider: 'same-origin', url: '/app/dsp-processor.js', sha256: canonicalHash },
              { provider: 'vercel-blob', url: 'https://mock.cdn/dsp-processor.js', sha256: canonicalHash }
            ]
          }
        }
      })
    });
    // 3. Mock CDN file fetch (returns canonical source text)
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => canonicalSrc
    });
    // 4. Blob addModule succeeds
    ctx.audioWorklet.addModule.mockResolvedValueOnce(undefined);

    const result = await loadDspProcessorWorklet(ctx);

    expect(result).toBe('vercel-blob');
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(2);
    expect(ctx.audioWorklet.addModule).toHaveBeenNakedCalledWith(1, '/app/dsp-processor.js');
    expect(ctx.audioWorklet.addModule).toHaveBeenNakedCalledWith(2, 'blob:mock-url');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('Failure path: throws when CDN mirror loads incorrect file (hash mismatch)', async () => {
    // 1. Same-origin fails
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('404'));
    // 2. Manifest loads
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        worklets: {
          dsp_processor: {
            sources: [
              { provider: 'vercel-blob', url: 'https://mock.cdn/dsp-processor.js', sha256: canonicalHash }
            ]
          }
        }
      })
    });
    // 3. CDN returns different/corrupt/incorrect file (hash mismatch) but passes registration check
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => 'registerProcessor("dsp-processor", class DspProcessor {}); // but different content here'
    });

    await expect(loadDspProcessorWorklet(ctx)).rejects.toThrow(/worklet integrity mismatch/);
  });

  test('Failure path: throws when CDN mirror loads incorrect file (missing registration)', async () => {
    // Calculate hash of this new incorrect file so it passes the integrity check but fails the registration guard
    const invalidText = 'console.log("no registerProcessor call here");';
    const invalidHash = crypto.createHash('sha256').update(invalidText).digest('hex');

    // 1. Same-origin fails
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('404'));
    // 2. Manifest loads
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        worklets: {
          dsp_processor: {
            sources: [
              { provider: 'vercel-blob', url: 'https://mock.cdn/dsp-processor.js', sha256: invalidHash }
            ]
          }
        }
      })
    });
    // 3. CDN returns file that passes integrity check but lacks the processor registration
    global.fetch.mockResolvedValueOnce({
      ok: true,
      text: async () => invalidText
    });

    await expect(loadDspProcessorWorklet(ctx)).rejects.toThrow(/mirror does not contain dsp-processor registration/);
  });

  test('Failure path: throws when all fetches fail with HTTP errors', async () => {
    // 1. Same-origin fails
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error('404'));
    // 2. Manifest loads
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        worklets: {
          dsp_processor: {
            sources: [
              { provider: 'vercel-blob', url: 'https://mock.cdn/dsp-processor.js', sha256: canonicalHash }
            ]
          }
        }
      })
    });
    // 3. CDN loads incorrectly (returns HTTP 500 error)
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500
    });

    await expect(loadDspProcessorWorklet(ctx)).rejects.toThrow(/All worklet sources failed: HTTP 500/);
  });
});

// Helper matcher since jest mock calls array has arguments
expect.extend({
  toHaveBeenNakedCalledWith(received, callIndex, expectedArg) {
    const calls = received.mock.calls;
    if (calls.length < callIndex) {
      return {
        message: () => `expected mock to be called at least ${callIndex} times, but was called ${calls.length} times`,
        pass: false,
      };
    }
    const actualArg = calls[callIndex - 1][0];
    const pass = this.equals(actualArg, expectedArg);
    return {
      message: () => `expected call ${callIndex} to have argument ${expectedArg}, but got ${actualArg}`,
      pass,
    };
  }
});
