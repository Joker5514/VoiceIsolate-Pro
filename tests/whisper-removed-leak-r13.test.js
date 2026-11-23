/**
 * Round 13: whisper leaks into the Removed stem (Removed = input − Processed).
 * Measured on Randy's whisper-only file (Whisper Boost, real app, e9808d4):
 * Removed scored STOI 0.861 against the whisper, Processed 0.937.
 * Two sources, both fixed here without adding a pass:
 *  1. the post-isolation dewhistle was a one-pole low-pass. Its phase and
 *     in-band droop left a high-passed copy of the whole voice in Removed
 *     (−22 dB at 2 kHz, −16 dB at 4 kHz). It is now a zero-phase 4th-order
 *     Butterworth at 15 kHz, transparent in the speech band.
 *  2. MLWorker: on the whisper path, bins that the chain already scores as
 *     mostly voice keep a gain of 1 (mask < 1 and Whisper Lift > 1 both put
 *     voice in Removed). Uncertain bins, and bins below 150 Hz, are unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const getAppCode = require('./helpers/get-app-code');

const ROOT = path.join(__dirname, '..');
const SR = 48000;

function tone(len, freqs, amp = 0.05) {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SR + f);
    x[i] = amp * v;
  }
  return x;
}


/** Whisper-like: dense random-phase multitone 300-4000 Hz in 4 Hz syllables. */
const whisperCache = new Map();
function whisperBand(len, amp = 0.004) {
  const key = `${len}:${amp}`;
  if (whisperCache.has(key)) return whisperCache.get(key);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const comps = [];
  for (let k = 0; k < 160; k++) comps.push([300 + rnd() * 3700, rnd() * 2 * Math.PI]);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const [f, ph] of comps) v += Math.sin((2 * Math.PI * f * i) / SR + ph);
    x[i] = amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * 4 * i) / SR)) * v;
  }
  whisperCache.set(key, x);
  return x;
}

function ratioDb(x, y, from, to) {
  let e = 0; let ex = 0;
  for (let i = from; i < to; i++) { e += (x[i] - y[i]) ** 2; ex += x[i] ** 2; }
  return 10 * Math.log10(e / ex);
}

describe('post-isolation dewhistle', () => {
  let V;
  beforeAll(() => {
    const safe = getAppCode().replace(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?\}\);/, '');
    V = new Function('window', 'document', safe + '; return VoiceIsolatePro;')({}, {});
  });
  const run = async (x) => {
    const ctx = Object.create(V.prototype);
    ctx._isMobileEngineer = () => false;
    ctx._postMlChunkSamples = () => 12000; // several chunks: state must carry across
    ctx._processAbortSignal = () => null;
    const y = new Float32Array(x);
    await V.prototype._postIsolationDeWhistle.call(ctx, [y], SR);
    return y;
  };

  test.each([300, 1000, 2000, 4000, 7000])('leaves %i Hz speech-band content out of Removed (< -40 dB)', async (f) => {
    const x = tone(SR, [f]);
    const y = await run(x);
    expect(ratioDb(x, y, 2400, SR - 2400)).toBeLessThan(-40);
  });

  test('still attenuates a 19 kHz whistle (guard: at least 3 dB, as before)', async () => {
    const x = tone(SR, [19000]);
    const y = await run(x);
    let e = 0; let ex = 0;
    for (let i = 2400; i < SR - 2400; i++) { e += y[i] ** 2; ex += x[i] ** 2; }
    expect(10 * Math.log10(e / ex)).toBeLessThan(-3);
  });
});

describe('MLWorker whisper-path residual reroute', () => {
  let worker;
  let wbConfig;
  let plainConfig;
  beforeAll(async () => {
    class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
    const self = { navigator: { hardwareConcurrency: 8, userAgent: 'node-test X11' }, postMessage() {} };
    const sandbox = {
      self,
      ort: { Tensor, env: { wasm: {} } },
      console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
      performance, setTimeout, clearTimeout, Promise, Math, Object, Array, Set, Map, Error, Number, String, JSON, Symbol,
      Float32Array, Float64Array, Uint32Array, Uint8Array, Int16Array,
      importScripts(...urls) {
        for (const u of urls) {
          if (/ort(\.min)?\.js$/.test(u)) continue;
          const file = path.join(ROOT, u.replace(/^\//, ''));
          vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
        }
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8')
      + '\nself.__fused = runFusedSpectralMaskChain;', sandbox);
    worker = self;
    const { buildMlProcessingConfig } = await import('../src/core/ParameterSchema.js');
    const { getCalibratedPresets } = await import('../src/core/PresetCalibration.js');
    const presets = getCalibratedPresets();
    // Engineer gains neutralised so the test isolates the reroute itself
    // (stationary test tones would otherwise be tracked as noise by NR).
    const neutral = { nrAmount: 0, whisperLift: 0, bassCrush: 0, derevAmt: 0, snrFloor: -80, whisperClarity: 0 };
    wbConfig = buildMlProcessingConfig({ ...presets['Whisper Boost'], ...neutral });
    plainConfig = buildMlProcessingConfig({ ...presets['Whisper Boost'], ...neutral, whisperMode: 0 });
    expect(wbConfig.spectral.whisperMode).toBeGreaterThanOrEqual(1);
    expect(plainConfig.spectral.whisperMode).toBe(0);
  });

  const ENTRY = {
    id: 'const-mask', fftSize: 4096, hopSize: 1024, bins: 2049, sampleRate: SR,
    io: { input: 'in', output: 'out' }, inputNormalization: 'frame-max', maskExponent: 1,
  };
  const session = (v) => ({ async run(feeds) { return { out: { data: new Float32Array(feeds.in.data.length).fill(v) } }; } });
  const run = (x, mask, cfg) => worker.__fused([{ entry: ENTRY, session: session(mask) }], x, () => {}, cfg, SR, null);
  const SPEECH = [400, 900, 1700, 2600, 3500];
  beforeAll(() => { whisperBand(SR * 2); }, 30000);

  // Main: the whisper-mode spectral chain still strips ~8% of a voice the
  // model is fully sure of (Removed -11 dB). Rerouted, it stays in Processed.
  test('confident voice (mask 1.0) on the whisper path stays out of Removed (< -20 dB)', async () => {
    const x = whisperBand(SR * 2);
    const y = await run(x, 1, wbConfig);
    expect(ratioDb(x, y, SR / 4, (SR * 7) / 4)).toBeLessThan(-20);
  });

  test('uncertain bins (mask 0.3) keep their residual in Removed', async () => {
    const x = whisperBand(SR * 2);
    const y = await run(x, 0.3, wbConfig);
    expect(ratioDb(x, y, SR / 4, (SR * 7) / 4)).toBeGreaterThan(-6);
  });

  test('sub-150 Hz content (rumble / hum region) is not rerouted', async () => {
    const x = tone(SR * 2, [80], 0.02);
    const y = await run(x, 1, wbConfig);
    expect(ratioDb(x, y, SR / 4, (SR * 7) / 4)).toBeGreaterThan(-20);
  });

  test('without the whisper path the residual is unchanged', async () => {
    const x = tone(SR * 2, SPEECH, 0.02);
    const y = await run(x, 0.75, plainConfig);
    expect(ratioDb(x, y, SR / 4, (SR * 7) / 4)).toBeGreaterThan(-20);
  });
});
