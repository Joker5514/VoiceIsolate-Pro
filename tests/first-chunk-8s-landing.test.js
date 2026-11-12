'use strict';

/**
 * Real BSRNN landing path: an 8 s first core then 20 s cores vs the current
 * uniform 20 s plan, on a crop long enough to include the first join and a
 * later 20 s window.
 *
 * Stated tolerance (pinned from this fixture): SI-SDR of the short-first
 * output vs uniform-20 s chunking is at least 35 dB, and the click detector
 * reports no new discontinuities at the first join. Exact measured values
 * are logged and also reported in the PR after the 75 s run.
 */
const fs = require('fs');
const path = require('path');

jest.setTimeout(180000);

const SR = 48000;
const HOP = 1024;
const FIRST = Math.floor((8 * SR) / HOP) * HOP;
const CORE = Math.floor((20 * SR) / HOP) * HOP;
const CROP_SEC = 30;
const CROP = CROP_SEC * SR;
const FIX = '/workspace/echo-artifacts/fixtures/syn-long-75s/in0.f32';

function rd(f) {
  const b = fs.readFileSync(f);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
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

function wr(f, a) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(a.buffer, a.byteOffset, a.byteLength));
}

function auditClicks(est, ref, inp) {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vip-first-chunk-'));
  wr(path.join(dir, 'est.f32'), est);
  wr(path.join(dir, 'ref.f32'), ref);
  wr(path.join(dir, 'in.f32'), inp);
  const r = spawnSync('/workspace/echo-venv/bin/python', [
    '/workspace/echo-artifacts/round4/tradeoffs/scripts/tools.py', 'metrics',
    path.join(dir, 'est.f32'), path.join(dir, 'ref.f32'), path.join(dir, 'in.f32'), String(SR),
  ], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

describe('first-chunk 8 s then 20 s, landing BSRNN', () => {
  if (!fs.existsSync(FIX)) {
    test.skip('requires the 75 s fixture', () => {});
    return;
  }

  test('output stays within 35 dB SI-SDR of uniform 20 s chunking and does not click at the first join', async () => {
    const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');
    const IB = await import('../src/core/IngestionBudget.js');
    const CE = await import('../src/pipeline/ChunkedExtraction.js');
    const input = rd(FIX).subarray(0, CROP);
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
    const met = auditClicks(shorter.clean[0], uniform.clean[0], input);
    const fadeSec = fade / SR;
    const joinClicks = (met.new_click_at_s || []).filter((t) => Math.abs(t - join / SR) < 2 * fadeSec);
    // eslint-disable-next-line no-console
    console.log(`FIRST_CHUNK_8S_MEASUREMENTS ${JSON.stringify({
      cropSec: CROP_SEC,
      siSdrVsUniform20s: score,
      pesqVsUniform20s: met.pesq,
      stoiVsUniform20s: met.stoi,
      maxAbs: peak,
      firstJoinFrame: join,
      newClicks: met.new_clicks,
      newClickAtS: met.new_click_at_s,
      joinClicks,
    })}`);
    // Stated tolerance vs current (uniform 20 s) chunking on this 30 s crop:
    // SI-SDR ≥ 35 dB, and the audit click detector (2nd-difference vs a
    // rolling robust scale, same as the quality harness) reports no hits
    // within two fade lengths of the first join.
    expect(score).toBeGreaterThanOrEqual(35);
    expect(joinClicks).toEqual([]);
    expect(met.new_clicks).toBe(0);
  });
});
