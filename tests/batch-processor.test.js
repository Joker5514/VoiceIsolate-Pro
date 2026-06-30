'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/app/batch-processor.js'), 'utf8');

// Patch the source to expose private helpers alongside the public API so we
// can unit-test them directly without changing the production file.
const patchedSrc = src.replace(
  /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = BP;/,
  `if (typeof module !== 'undefined' && module.exports) {
    module.exports = BP;
    module.exports._normalize = _normalize;
    module.exports._encodeWAV = _encodeWAV;
    module.exports._applyWatermark = _applyWatermark;
  }`
);

// Browser globals required by the IIFE
global.window = {
  LicenseManager: null,
  Paywall: null,
  AudioContext: class {
    decodeAudioData() {
      return Promise.resolve({
        getChannelData: () => new Float32Array(1024).fill(0.1),
        sampleRate: 48000,
      });
    }
    close() { return Promise.resolve(); }
  },
  webkitAudioContext: undefined,
  VoiceIsolatePipeline: null,
  JSZip: null,
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
};
global.document = {
  createElement: () => ({ href: '', download: '', click: () => {} }),
  body: { appendChild: () => {}, removeChild: () => {} },
};
global.AbortController = class {
  constructor() { this.signal = { aborted: false, addEventListener: () => {} }; }
  abort() { this.signal.aborted = true; }
};
global.FileReader = class {
  readAsArrayBuffer() {
    // Simulate async read via setTimeout so signal.abort can fire first
    setTimeout(() => this.onload({ target: { result: new ArrayBuffer(1024) } }), 0);
  }
  abort() {}
};
global.Blob = class Blob {
  constructor(parts = [], opts = {}) {
    this.type = opts.type || '';
    this.size = parts.reduce((a, b) => a + (b ? (b.byteLength || b.size || 0) : 0), 0);
  }
};

/** Return a fresh BatchProcessor instance with clean internal state. */
function freshBP() {
  const exports = {};
  const module = { exports };
  eval(patchedSrc); // eslint-disable-line no-eval
  return module.exports;
}

// ── _normalize ────────────────────────────────────────────────────────────────

describe('BatchProcessor._normalize', () => {
  test('scales peak to target dBFS', () => {
    const bp = freshBP();
    const data = new Float32Array([0.2, -0.4, 0.6, -0.1]);
    const out = bp._normalize(data, -6);
    const peak = Math.max(...Array.from(out).map(Math.abs));
    expect(peak).toBeCloseTo(Math.pow(10, -6 / 20), 3);
  });

  test('all-zeros input is returned unchanged', () => {
    const bp = freshBP();
    const out = bp._normalize(new Float32Array(10), -1);
    expect(out.every(v => v === 0)).toBe(true);
  });

  test('returns a new Float32Array (does not mutate input)', () => {
    const bp = freshBP();
    const data = new Float32Array([0.5, -0.5]);
    const out = bp._normalize(data, -6);
    expect(out).not.toBe(data);
  });

  test('output has the same length as input', () => {
    const bp = freshBP();
    const data = new Float32Array(100).fill(0.3);
    expect(bp._normalize(data, -3).length).toBe(100);
  });
});

// ── _encodeWAV ────────────────────────────────────────────────────────────────

describe('BatchProcessor._encodeWAV', () => {
  const readStr = (v, off, len) =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('');

  test('produces valid RIFF/WAVE/fmt /data header', () => {
    const bp = freshBP();
    const buf = bp._encodeWAV(new Float32Array(4), 48000);
    const v = new DataView(buf);
    expect(readStr(v, 0, 4)).toBe('RIFF');
    expect(readStr(v, 8, 4)).toBe('WAVE');
    expect(readStr(v, 12, 4)).toBe('fmt ');
    expect(readStr(v, 36, 4)).toBe('data');
  });

  test('buffer size = 44 + samples*2 (16-bit PCM)', () => {
    const bp = freshBP();
    expect(bp._encodeWAV(new Float32Array(100), 48000).byteLength).toBe(244);
  });

  test('sample rate written at offset 24', () => {
    const bp = freshBP();
    const v = new DataView(bp._encodeWAV(new Float32Array(1), 22050));
    expect(v.getUint32(24, true)).toBe(22050);
  });

  test('RIFF chunk size = 36 + dataSize', () => {
    const bp = freshBP();
    const v = new DataView(bp._encodeWAV(new Float32Array(10), 48000));
    expect(v.getUint32(4, true)).toBe(36 + 10 * 2);
  });

  test('data size field at offset 40 = samples*2', () => {
    const bp = freshBP();
    const v = new DataView(bp._encodeWAV(new Float32Array(20), 48000));
    expect(v.getUint32(40, true)).toBe(20 * 2);
  });

  test('positive sample clips at +32767', () => {
    const bp = freshBP();
    const v = new DataView(bp._encodeWAV(new Float32Array([2.0]), 48000));
    expect(v.getInt16(44, true)).toBe(0x7FFF);
  });

  test('channel count is 1 (mono)', () => {
    const bp = freshBP();
    const v = new DataView(bp._encodeWAV(new Float32Array(1), 48000));
    expect(v.getUint16(22, true)).toBe(1);
  });
});

// ── _applyWatermark ───────────────────────────────────────────────────────────

describe('BatchProcessor._applyWatermark', () => {
  test('output has the same length as input', () => {
    const bp = freshBP();
    const data = new Float32Array(4800).fill(0.3);
    expect(bp._applyWatermark(data, 48000).length).toBe(4800);
  });

  test('watermark modifies the signal (output != input)', () => {
    const bp = freshBP();
    const data = new Float32Array(4800).fill(0.5);
    const out = bp._applyWatermark(data, 48000);
    let differs = false;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(out[i] - 0.5) > 1e-5) { differs = true; break; }
    }
    expect(differs).toBe(true);
  });

  test('watermark amplitude is small (< 0.02)', () => {
    const bp = freshBP();
    const data = new Float32Array(4800); // silence
    const out = bp._applyWatermark(data, 48000);
    for (const v of out) expect(Math.abs(v)).toBeLessThan(0.02);
  });

  test('output is always finite', () => {
    const bp = freshBP();
    const data = new Float32Array(48000).fill(0.9); // long signal
    const out = bp._applyWatermark(data, 48000);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

// ── event system ──────────────────────────────────────────────────────────────

describe('BatchProcessor event system', () => {
  test('on() returns an unsubscribe function', () => {
    const bp = freshBP();
    const unsub = bp.on('job:queued', () => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  test('pause() emits queue:paused', () => {
    const bp = freshBP();
    const cb = jest.fn();
    bp.on('queue:paused', cb);
    bp.pause();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('resume() emits queue:resumed', () => {
    const bp = freshBP();
    const cb = jest.fn();
    bp.on('queue:resumed', cb);
    bp.resume();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  test('wildcard (*) listener receives all events', () => {
    const bp = freshBP();
    const cb = jest.fn();
    bp.on('*', cb);
    bp.pause();
    bp.resume();
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('unsubscribed listener no longer fires', () => {
    const bp = freshBP();
    const cb = jest.fn();
    const unsub = bp.on('queue:paused', cb);
    unsub();
    bp.pause();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── pause / resume ────────────────────────────────────────────────────────────

describe('BatchProcessor.pause and resume', () => {
  test('pause() sets paused=true in stats', () => {
    const bp = freshBP();
    bp.pause();
    expect(bp.getStats().paused).toBe(true);
  });

  test('resume() sets paused=false in stats', () => {
    const bp = freshBP();
    bp.pause();
    bp.resume();
    expect(bp.getStats().paused).toBe(false);
  });
});

// ── getStats / getQueue ───────────────────────────────────────────────────────

describe('BatchProcessor.getStats and getQueue', () => {
  test('initial stats are all zero', () => {
    const bp = freshBP();
    const s = bp.getStats();
    expect(s).toEqual({ total: 0, done: 0, processing: 0, queued: 0, errors: 0, paused: false });
  });

  test('getQueue returns empty array initially', () => {
    expect(freshBP().getQueue()).toEqual([]);
  });
});

// ── setConcurrency ────────────────────────────────────────────────────────────

describe('BatchProcessor.setConcurrency', () => {
  test('does not throw for valid values', () => {
    const bp = freshBP();
    expect(() => bp.setConcurrency(5)).not.toThrow();
    expect(() => bp.setConcurrency(1)).not.toThrow();
  });

  test('clamps to minimum of 1', () => {
    const bp = freshBP();
    expect(() => bp.setConcurrency(0)).not.toThrow();
    expect(() => bp.setConcurrency(-5)).not.toThrow();
  });
});

// ── clearCompleted ────────────────────────────────────────────────────────────

describe('BatchProcessor.clearCompleted', () => {
  test('does not throw on empty queue', () => {
    expect(() => freshBP().clearCompleted()).not.toThrow();
  });
});

// ── addFiles ──────────────────────────────────────────────────────────────────

describe('BatchProcessor.addFiles', () => {
  afterEach(() => { global.window.LicenseManager = null; });

  test('returns [] when LicenseManager is absent (maxBatch=0)', () => {
    global.window.LicenseManager = null;
    expect(freshBP().addFiles([{ name: 'test.wav', size: 100 }])).toEqual([]);
  });

  test('returns job IDs when unlimited batch is allowed', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: -1 } }) };
    const ids = freshBP().addFiles([{ name: 'a.wav', size: 100 }, { name: 'b.wav', size: 200 }]);
    expect(ids.length).toBe(2);
  });

  test('respects maxBatch cap', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: 2 } }) };
    const files = [{ name: 'a.wav', size: 1 }, { name: 'b.wav', size: 1 }, { name: 'c.wav', size: 1 }];
    expect(freshBP().addFiles(files).length).toBe(2);
  });

  test('queued jobs have correct name and state', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: -1 } }) };
    const bp = freshBP();
    bp.addFiles([{ name: 'test.wav', size: 500 }]);
    const q = bp.getQueue();
    expect(q.length).toBe(1);
    expect(q[0].state).toBe('queued');
    expect(q[0].name).toBe('test.wav');
    expect(q[0].size).toBe(500);
  });

  test('emits job:queued event per file', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: -1 } }) };
    const bp = freshBP();
    const cb = jest.fn();
    bp.on('job:queued', cb);
    bp.addFiles([{ name: 'a.wav', size: 1 }, { name: 'b.wav', size: 2 }]);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

// ── cancel / cancelAll ────────────────────────────────────────────────────────

describe('BatchProcessor.cancel and cancelAll', () => {
  afterEach(() => { global.window.LicenseManager = null; });

  test('cancel on unknown ID does not throw', () => {
    expect(() => freshBP().cancel('no_such_id')).not.toThrow();
  });

  test('cancelAll on empty queue does not throw', () => {
    expect(() => freshBP().cancelAll()).not.toThrow();
  });

  test('cancel marks a queued job as cancelled', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: -1 } }) };
    const bp = freshBP();
    const [id] = bp.addFiles([{ name: 'x.wav', size: 100 }]);
    bp.cancel(id);
    const job = bp.getQueue().find(j => j.id === id);
    expect(job.state).toBe('cancelled');
  });

  test('cancelAll marks all non-terminal jobs as cancelled', () => {
    global.window.LicenseManager = { getTierDef: () => ({ limits: { batchFiles: -1 } }) };
    const bp = freshBP();
    bp.addFiles([{ name: 'a.wav', size: 1 }, { name: 'b.wav', size: 2 }]);
    bp.cancelAll();
    const states = bp.getQueue().map(j => j.state);
    expect(states.every(s => s === 'cancelled')).toBe(true);
  });
});
