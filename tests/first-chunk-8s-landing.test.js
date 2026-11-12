'use strict';

/**
 * Real BSRNN landing path: an 8 s first core then 20 s cores vs the current
 * uniform 20 s plan, on a crop long enough to include the first join and a
 * later 20 s window.
 *
 * The input is generated deterministically in this file (seeded tones +
 * noise) so the test runs in any checkout. It used to read a 75 s fixture
 * from an absolute, machine-specific path
 * (/workspace/echo-artifacts/fixtures/syn-long-75s/in0.f32) and skip when
 * the file was absent, so the regression never ran outside that machine.
 * The click check is the same second-difference rule as the audit harness
 * (see newClicks in tests/chunked-extraction.test.js); the old version
 * shelled out to a machine-specific Python tool for it.
 *
 * Stated tolerance: SI-SDR of the short-first output vs uniform-20 s
 * chunking is at least 35 dB, and the click detector reports no new
 * discontinuities at the first join. Exact measured values are logged.
 */

jest.setTimeout(180000);

const SR = 48000;
const HOP = 1024;
const FIRST = Math.floor((8 * SR) / HOP) * HOP;
const CORE = Math.floor((20 * SR) / HOP) * HOP;
const CROP_SEC = 30;
const CROP = CROP_SEC * SR;

/**
 * Deterministic stand-in for the old 75 s fixture: three tones with slow
 * tremolo plus low-level noise from a seeded LCG. The comparison is between
 * two chunkings of the same input, so the exact content does not matter —
 * only that it is fixed and exercises the model and the joins.
 */
function synthInput(frames) {
  const out = new Float32Array(frames);
  let seed = 0x12345678;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const trem = 0.75 + 0.25 * Math.sin(2 * Math.PI * 0.5 * t);
    out[i] = trem * (
      0.45 * Math.sin(2 * Math.PI * 220 * t) +
      0.30 * Math.sin(2 * Math.PI * 440 * t + 0.7) +
      0.15 * Math.sin(2 * Math.PI * 660 * t + 1.3)
    ) + 0.05 * rnd();
  }
  return out;
}

function maxAbs(a, b) {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function siSdr(ref, est) {
  const n = Math.min(ref.length, est.length);
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    dot += ref[i] * est[i];
    energy += ref[i] * ref[i];
  }
  if (energy === 0) return Infinity;
  const scale = dot / energy;
  let noise = 0;
  let signal = 0;
  for (let i = 0; i < n; i++) {
    const s = scale * ref[i];
    signal += s * s;
    const e = est[i] - s;
    noise += e * e;
  }
  if (noise === 0) return Infinity;
  return 10 * Math.log10(signal / noise);
}

/** Second-difference spikes that the reference does not explain, same rule as the audit harness. */
function newClicks(out, src) {
  const d2 = (x) => {
    const d = new Float64Array(Math.max(0, x.length - 2));
    for (let i = 0; i < d.length; i++) d[i] = Math.abs(x[i] - 2 * x[i + 1] + x[i + 2]);
    return d;
  };
  const dout = d2(out);
  const dsrc = d2(src);
  const hits = [];
  const thresh = 10 ** (-70 / 20);
  for (let i = 0; i < dout.length; i++) {
    if (dout[i] <= 14 * 1e-7 && dout[i] <= thresh) continue;
    const a = Math.max(0, i - 49);
    const b = Math.min(dsrc.length, i + 48);
    let srcMax = 0;
    for (let j = a; j < b; j++) if (dsrc[j] > srcMax) srcMax = dsrc[j];
    // A click is a 2nd-difference peak much larger than the reference nearby.
    if (dout[i] > 14 * Math.max(srcMax, 1e-7) && dout[i] > 2 * Math.max(srcMax, 1e-6)) {
      if (!hits.length || (i + 1) - hits[hits.length - 1] > 96) hits.push(i + 1);
    }
  }
  return hits;
}

describe('first-chunk 8 s then 20 s, landing BSRNN', () => {
  test('output stays within 35 dB SI-SDR of uniform 20 s chunking and does not click at the first join', async () => {
    const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');
    const IB = await import('../src/core/IngestionBudget.js');
    const CE = await import('../src/pipeline/ChunkedExtraction.js');
    const input = synthInput(CROP);
    const contract = IB.chainChunkContract(['bsrnn_vocals']);
    const hop = contract.hopSize;
    const fade = hop;
    const context = contract.contextFrames;
    function plan(first) {
      return {
        totalFrames: input.length,
        outputChannels: 1,
        chunk: {
          viable: true,
          coreFrames: CORE,
          firstCoreFrames: first || undefined,
          contextFrames: context,
          fadeFrames: fade,
          strideFrames: CORE - fade,
        },
      };
    }
    const worker = await createMlWorker();
    async function run(p) {
      return CE.runChunkedExtraction(null, p, {
        sink: 'memory',
        readWindow: async (s, n) => [input.subarray(s, s + n)],
        processWindow: async (window) => {
          const res = await worker.separate(window, { modelIds: ['bsrnn_vocals'], processingConfig: null });
          return res.clean;
        },
      });
    }
    const uniform = await run(plan(0));
    const shorter = await run(plan(FIRST));
    expect(shorter.frames).toBe(input.length);
    expect(uniform.frames).toBe(input.length);
    expect(shorter.segments[0].frames).toBe(FIRST);
    const score = siSdr(uniform.clean[0], shorter.clean[0]);
    const peak = maxAbs(uniform.clean[0], shorter.clean[0]);
    const join = FIRST - fade;
    const hits = newClicks(shorter.clean[0], uniform.clean[0]);
    const fadeSec = fade / SR;
    const joinClicks = hits.filter((h) => Math.abs(h / SR - join / SR) < 2 * fadeSec);
    console.log(`FIRST_CHUNK_8S_MEASUREMENTS ${JSON.stringify({
      cropSec: CROP_SEC,
      siSdrVsUniform20s: score,
      maxAbs: peak,
      firstJoinFrame: join,
      newClicks: hits.length,
      newClickAtS: hits.map((h) => Number((h / SR).toFixed(3))),
      joinClicks,
    })}`);
    // Stated tolerance vs current (uniform 20 s) chunking on this 30 s crop:
    // SI-SDR ≥ 35 dB, and the audit click detector (2nd-difference vs a
    // rolling robust scale, same as the quality harness) reports no hits
    // within two fade lengths of the first join.
    expect(score).toBeGreaterThanOrEqual(35);
    expect(joinClicks).toEqual([]);
    expect(hits.length).toBe(0);
  });
});
