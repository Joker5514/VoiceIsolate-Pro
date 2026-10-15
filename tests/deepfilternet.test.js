'use strict';
/**
 * DeepFilterNet3 helper (src/workers/DeepFilterNet.js) against libDF 0.5.6.
 *
 * tests/fixtures/dfn3-libdf-output.f32 is libDF's analysis, ERB / unit norms,
 * deep filter and synthesis (DeepFilterLib 0.5.6, Python) around the same three
 * ONNX graphs, run on the deterministic input built below.
 */
const fs = require('fs');
const path = require('path');
const S = require('../scripts/quality/lib/signals.cjs');
const M = require('../scripts/quality/lib/metrics.cjs');

const ROOT = path.join(__dirname, '..');
const scope = {};
new Function('self', fs.readFileSync(path.join(ROOT, 'src/workers/DeepFilterNet.js'), 'utf8'))(scope);
const { runDeepFilterNet, VipDeepFilterNet: D } = scope;

let ort;
let sessions;
beforeAll(async () => {
  ort = require(path.join(ROOT, 'node_modules/onnxruntime-web'));
  ort.env.wasm.numThreads = 1;
  const { MODEL_MANIFEST } = await import('../src/core/ModelManifest.js');
  sessions = {};
  for (const [part, id] of Object.entries(MODEL_MANIFEST.deepfilternet3.parts)) {
    sessions[part] = await ort.InferenceSession.create(fs.readFileSync(path.join(ROOT, 'public', MODEL_MANIFEST[id].url)));
  }
});

async function run(part, feeds) {
  const tensors = {};
  for (const [name, f] of Object.entries(feeds)) tensors[name] = new ort.Tensor('float32', f.data, f.dims);
  const result = await sessions[part].run(tensors);
  const out = {};
  for (const [name, t] of Object.entries(result)) { out[name] = t.data; out[`${name}__dims`] = t.dims; }
  return out;
}

function fixtureInput() {
  const v = S.talker({ seconds: 0.5, seed: 7 });
  return S.mixAtSnr(v.signal, S.whiteNoise(v.signal.length, 8), 5, v.active).mix;
}

describe('DeepFilterNet3 helper', () => {
  it('960-point real FFT matches a direct DFT and inverts', () => {
    const x = new Float64Array(D.FFT);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.37) + 0.5 * Math.cos(i * 1.91) + (i % 7) / 10;
    const re = new Float64Array(D.FFT / 2 + 1);
    const im = new Float64Array(D.FFT / 2 + 1);
    D._rfft960(x, re, im);
    let err = 0;
    for (const k of [0, 1, 17, 96, 240, 479, 480]) {
      let r = 0;
      let i = 0;
      for (let n = 0; n < D.FFT; n++) {
        r += x[n] * Math.cos((2 * Math.PI * k * n) / D.FFT);
        i -= x[n] * Math.sin((2 * Math.PI * k * n) / D.FFT);
      }
      err = Math.max(err, Math.abs(re[k] - r), Math.abs(im[k] - i));
    }
    expect(err).toBeLessThan(1e-9);
    // Unnormalised inverse, like realfft's c2r: irfft(rfft(x)) = FFT · x.
    const back = new Float64Array(D.FFT);
    D._irfft960(re, im, back);
    for (let n = 0; n < D.FFT; n++) expect(Math.abs(back[n] / D.FFT - x[n])).toBeLessThan(1e-9);
  });

  it('matches libDF end to end (SI-SDR > 40 dB against the reference output)', async () => {
    const x = fixtureInput();
    const b = fs.readFileSync(path.join(__dirname, 'fixtures/dfn3-libdf-output.f32'));
    const ref = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const y = await runDeepFilterNet(x, run);
    expect(y.length).toBe(x.length);
    expect(M.nonFinite(y)).toBe(0);
    expect(M.siSdr(y, ref)).toBeGreaterThan(40);
    expect(Math.abs(M.rmsDb(y) - M.rmsDb(ref))).toBeLessThan(0.1);
  });

  // The exported graphs carry no GRU state, so chunks re-run LEFT frames of
  // context; the recurrent state is close to, not equal to, a single pass.
  it('chunked inference with warm-up context stays as close to the target as one pass', async () => {
    const v = S.talker({ seconds: 6, seed: 3 });
    const x = S.mixAtSnr(v.signal, S.whiteNoise(v.signal.length, 4), 5, v.active).mix;
    const whole = await runDeepFilterNet(x, run);
    let progress = 0;
    let yields = 0;
    const chunked = await runDeepFilterNet(x, run, {
      chunkFrames: 200, leftFrames: D.LEFT,
      onProgress: (p) => { progress = p; },
      yieldFn: () => { yields++; },
    });
    expect(progress).toBe(1);
    expect(yields).toBe(Math.ceil((Math.floor((x.length + D.FFT) / D.HOP)) / 200));
    expect(M.siSdr(chunked, whole)).toBeGreaterThan(15);
    expect(Math.abs(M.siSdr(chunked, v.signal) - M.siSdr(whole, v.signal))).toBeLessThan(0.5);
  });

  it('keeps digital silence silent and short input the same length', async () => {
    const y = await runDeepFilterNet(new Float32Array(D.HOP * 10), run);
    expect(M.peak(y)).toBeLessThan(1e-6);
    const short = await runDeepFilterNet(new Float32Array(100).fill(0.01), run);
    expect(short.length).toBe(100);
    expect(M.nonFinite(short)).toBe(0);
  });
});
