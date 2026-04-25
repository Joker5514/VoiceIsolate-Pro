'use strict';

const fs = require('fs');
const path = require('path');

// ── AudioWorklet environment mock ─────────────────────────────────────────────
const _registered = {};
global.AudioWorkletProcessor = class AudioWorkletProcessor {
  constructor() {
    this.port = { postMessage: jest.fn(), onmessage: null };
  }
};
global.registerProcessor = (name, cls) => { _registered[name] = cls; };
global.sampleRate = 48000;

// Load the processor file (defines HarmonicEnhancer, VoiceIsolateProcessor,
// then calls registerProcessor at the bottom)
const processorSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/voice-isolate-processor.js'), 'utf8'
);
eval(processorSrc); // eslint-disable-line no-eval

const VoiceIsolateProcessor = _registered['voice-isolate-processor'];

// Extract HarmonicEnhancer via the instance it creates inside the constructor
const _sampleInst = new VoiceIsolateProcessor({});
const HarmonicEnhancer = _sampleInst.harmonicEnhancer.constructor;

// ── HarmonicEnhancer ──────────────────────────────────────────────────────────

describe('HarmonicEnhancer', () => {
  test('amount=0: enabled is false', () => {
    const he = new HarmonicEnhancer(0);
    expect(he.enabled).toBe(false);
  });

  test('amount=100: enabled is true, drive is 5', () => {
    const he = new HarmonicEnhancer(100);
    expect(he.enabled).toBe(true);
    expect(he.drive).toBeCloseTo(5, 5);
  });

  test('processSample with amount=0 returns sample unchanged', () => {
    const he = new HarmonicEnhancer(0);
    expect(he.processSample(0.5)).toBe(0.5);
    expect(he.processSample(-0.3)).toBe(-0.3);
  });

  test('processSample with amount>0 applies soft saturation', () => {
    const he = new HarmonicEnhancer(50);
    const out = he.processSample(0.5);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).not.toBeCloseTo(0.5, 3);
  });

  test('processSample(0) returns 0 for any amount', () => {
    for (const amt of [0, 25, 50, 100]) {
      expect(new HarmonicEnhancer(amt).processSample(0)).toBeCloseTo(0, 6);
    }
  });

  test('processSample preserves polarity', () => {
    const he = new HarmonicEnhancer(50);
    expect(he.processSample(0.3)).toBeGreaterThan(0);
    expect(he.processSample(-0.3)).toBeLessThan(0);
  });

  test('setAmount clamps below 0 to 0', () => {
    const he = new HarmonicEnhancer(50);
    he.setAmount(-10);
    expect(he.amount).toBe(0);
    expect(he.enabled).toBe(false);
  });

  test('setAmount clamps above 100 to 100', () => {
    const he = new HarmonicEnhancer(50);
    he.setAmount(200);
    expect(he.amount).toBe(100);
  });

  test('wetGain + dryGain sum to 1.0', () => {
    const he = new HarmonicEnhancer(60);
    expect(he.wetGain + he.dryGain).toBeCloseTo(1.0, 6);
  });
});

// ── VoiceIsolateProcessor construction ───────────────────────────────────────

describe('VoiceIsolateProcessor construction', () => {
  test('instantiates without throwing', () => {
    expect(() => new VoiceIsolateProcessor({})).not.toThrow();
  });

  test('default params are correct', () => {
    const p = new VoiceIsolateProcessor({}).params;
    expect(p.bypass).toBe(false);
    expect(p.gateThresh).toBe(-42);
    expect(p.dryWet).toBe(100);
    expect(p.harmonicEnhance).toBe(0);
    expect(p.outGain).toBe(0);
  });

  test('FFT_SIZE=4096, HOP_SIZE=1024, HALF_N=2049', () => {
    const proc = new VoiceIsolateProcessor({});
    expect(proc.FFT_SIZE).toBe(4096);
    expect(proc.HOP_SIZE).toBe(1024);
    expect(proc.HALF_N).toBe(2049);
  });

  test('accumulation buffers are 4× FFT_SIZE', () => {
    const proc = new VoiceIsolateProcessor({});
    expect(proc.inputAccum.length).toBe(proc.FFT_SIZE * 4);
    expect(proc.outputAccum.length).toBe(proc.FFT_SIZE * 4);
    expect(proc.outputWindowSum.length).toBe(proc.FFT_SIZE * 4);
  });

  test('all pointers start at 0', () => {
    const proc = new VoiceIsolateProcessor({});
    expect(proc.inputHead).toBe(0);
    expect(proc.inputProcessed).toBe(0);
    expect(proc.outputHead).toBe(0);
    expect(proc.drainHead).toBe(0);
    expect(proc.hopsSinceInit).toBe(0);
  });

  test('fft scratch buffers are FFT_SIZE long', () => {
    const proc = new VoiceIsolateProcessor({});
    expect(proc.fftReal.length).toBe(proc.FFT_SIZE);
    expect(proc.fftImag.length).toBe(proc.FFT_SIZE);
  });
});

// ── VoiceIsolateProcessor._onMessage ─────────────────────────────────────────

describe('VoiceIsolateProcessor._onMessage', () => {
  let proc;
  beforeEach(() => { proc = new VoiceIsolateProcessor({}); });

  test('param: updates a single known parameter', () => {
    proc._onMessage({ type: 'param', key: 'gateThresh', value: -30 });
    expect(proc.params.gateThresh).toBe(-30);
  });

  test('param: silently ignores unknown keys', () => {
    expect(() => proc._onMessage({ type: 'param', key: 'nonexistent', value: 99 })).not.toThrow();
    expect(proc.params.nonexistent).toBeUndefined();
  });

  test('param: harmonicEnhance also updates the HarmonicEnhancer', () => {
    proc._onMessage({ type: 'param', key: 'harmonicEnhance', value: 75 });
    expect(proc.harmonicEnhancer.amount).toBe(75);
    expect(proc.harmonicEnhancer.enabled).toBe(true);
  });

  test('paramBulk: updates multiple params at once', () => {
    proc._onMessage({ type: 'paramBulk', params: { gateThresh: -20, gateRange: -30, outGain: 3 } });
    expect(proc.params.gateThresh).toBe(-20);
    expect(proc.params.gateRange).toBe(-30);
    expect(proc.params.outGain).toBe(3);
  });

  test('bypass: sets the bypass flag', () => {
    proc._onMessage({ type: 'bypass', value: true });
    expect(proc.params.bypass).toBe(true);
    proc._onMessage({ type: 'bypass', value: false });
    expect(proc.params.bypass).toBe(false);
  });

  test('initRingBuffers: resets all pointers to zero', () => {
    proc.inputHead = 512;
    proc.drainHead = 256;
    proc._onMessage({ type: 'initRingBuffers', fftSize: 4096, hopSize: 1024 });
    expect(proc.inputHead).toBe(0);
    expect(proc.drainHead).toBe(0);
    expect(proc.inputProcessed).toBe(0);
    expect(proc.hopsSinceInit).toBe(0);
  });

  test('initRingBuffers: posts ready message', () => {
    proc._onMessage({ type: 'initRingBuffers', fftSize: 4096, hopSize: 1024 });
    expect(proc.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready', fftSize: 4096 })
    );
  });

  test('initRingBuffers: posts error when inputSAB is too small', () => {
    const tinyBuf = typeof SharedArrayBuffer !== 'undefined' ? (() => {
      try { return new SharedArrayBuffer(4); } catch { return null; }
    })() : null;

    if (!tinyBuf) { expect(true).toBe(true); return; } // SAB not available in env

    proc._onMessage({ type: 'initRingBuffers', fftSize: 4096, hopSize: 1024, inputSAB: tinyBuf });
    expect(proc.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    );
  });
});

// ── VoiceIsolateProcessor.process() ──────────────────────────────────────────

describe('VoiceIsolateProcessor.process()', () => {
  function mkBufs(size = 128, fill = 0.1) {
    const inBuf = new Float32Array(size).fill(fill);
    const outBuf = new Float32Array(size);
    return { inputs: [[inBuf]], outputs: [[outBuf]], inBuf, outBuf };
  }

  test('returns true (keep-alive signal)', () => {
    const proc = new VoiceIsolateProcessor({});
    const { inputs, outputs } = mkBufs();
    expect(proc.process(inputs, outputs)).toBe(true);
  });

  test('returns true when inputs/outputs are empty', () => {
    const proc = new VoiceIsolateProcessor({});
    expect(proc.process([[]], [[]])).toBe(true);
  });

  test('bypass mode: output == input', () => {
    const proc = new VoiceIsolateProcessor({});
    proc.params.bypass = true;
    const { inputs, outputs, inBuf, outBuf } = mkBufs();
    proc.process(inputs, outputs);
    for (let i = 0; i < 128; i++) expect(outBuf[i]).toBe(inBuf[i]);
  });

  test('output is silent during latency window (hopsSinceInit < 4)', () => {
    const proc = new VoiceIsolateProcessor({});
    const { inputs, outputs, outBuf } = mkBufs(128, 0.5);
    proc.process(inputs, outputs);
    expect(outBuf.every(v => v === 0)).toBe(true);
  });

  test('inputHead advances by 128 each render', () => {
    const proc = new VoiceIsolateProcessor({});
    const { inputs, outputs } = mkBufs();
    proc.process(inputs, outputs);
    expect(proc.inputHead).toBe(128);
    proc.process(inputs, outputs);
    expect(proc.inputHead).toBe(256);
  });

  test('inputProcessed advances after HOP_SIZE samples are fed', () => {
    const proc = new VoiceIsolateProcessor({});
    const { inputs, outputs } = mkBufs();
    // 8 × 128 = 1024 = HOP_SIZE
    for (let i = 0; i < 8; i++) proc.process(inputs, outputs);
    expect(proc.inputProcessed).toBeGreaterThanOrEqual(proc.HOP_SIZE);
  });

  test('output is finite after enough renders to exit latency window', () => {
    const proc = new VoiceIsolateProcessor({});
    const inBuf = new Float32Array(128).fill(0.3);
    const outBuf = new Float32Array(128);
    // Feed 40 quanta (40×128=5120 samples, well past 4× HOP latency)
    for (let i = 0; i < 40; i++) proc.process([[inBuf]], [[outBuf]]);
    for (const v of outBuf) expect(Number.isFinite(v)).toBe(true);
  });
});

// ── VoiceIsolateProcessor._forwardSTFTFrame ───────────────────────────────────

describe('VoiceIsolateProcessor._forwardSTFTFrame', () => {
  let proc;
  beforeEach(() => { proc = new VoiceIsolateProcessor({}); });

  test('returns Float32Array of length HALF_N', () => {
    const frame = Float32Array.from({ length: proc.FFT_SIZE }, () => Math.random() * 0.1);
    const phase = proc._forwardSTFTFrame(frame);
    expect(phase).toBeInstanceOf(Float32Array);
    expect(phase.length).toBe(proc.HALF_N);
  });

  test('phase values are in [-π, π]', () => {
    const frame = Float32Array.from({ length: proc.FFT_SIZE }, () => Math.random() - 0.5);
    const phase = proc._forwardSTFTFrame(frame);
    for (const p of phase) {
      expect(p).toBeGreaterThanOrEqual(-Math.PI - 1e-6);
      expect(p).toBeLessThanOrEqual(Math.PI + 1e-6);
    }
  });

  test('zero-valued frame produces zero magnitudes in fftReal/fftImag', () => {
    const frame = new Float32Array(proc.FFT_SIZE); // all zeros
    proc._forwardSTFTFrame(frame);
    // DC bin of a zero-input FFT is 0
    expect(proc.fftReal[0]).toBeCloseTo(0, 6);
  });
});

// ── parameterDescriptors ──────────────────────────────────────────────────────

describe('VoiceIsolateProcessor.parameterDescriptors', () => {
  test('is an empty array', () => {
    expect(VoiceIsolateProcessor.parameterDescriptors).toEqual([]);
  });
});
