/**
 * VoiceIsolate Pro — look-ahead true-peak limiter (Layer 1: Core, pure math)
 *
 * The export ceiling. Detection is the 4× oversampled true peak (ITU-R
 * BS.1770-4 Annex 2 style), linked across channels. The gain is a sliding
 * minimum over the look-ahead window, then a moving average of the same
 * length, then a one-pole release. Every sample in the averaging window is at
 * most the gain the peak needs, so the peak never passes the ceiling, and the
 * gain falls over the whole look-ahead instead of in one sample: no clipped
 * flat tops and no gain steps (clicks). Release is program-dependent: the
 * lower of a fast follower (the Release control) and a slow follower (60 ms
 * attack, max(400 ms, 8× release) release), so isolated peaks recover fast
 * and sustained limiting holds steadily instead of pumping.
 *
 * Offline: the input arrays are read at random, so the look-ahead adds no
 * output delay. Audio whose true peak stays under the ceiling is returned
 * untouched (the same arrays, bit for bit).
 */
'use strict';

/** Default output ceiling when no limiter ceiling is engaged, dBTP. */
export const SAFETY_CEILING_DB = -1;

const FACTOR = 4;
// Shared with src/workers/TruePeakLimiterProcessor.js (live + export render);
// tests/true-peak-limiter-worklet.test.js pins the two to the same output.
const MARGIN_DB = 0.05;
const LOOKAHEAD_MS = 5;
const SLOW_ATTACK_MS = 60;
const SLOW_RELEASE_FACTOR = 8;
const MIN_SLOW_RELEASE_MS = 400;

/** Fixed latency of the streaming limiter worklet, frames. */
export function truePeakLimiterLatencyFrames(sampleRate) {
  return Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate)) + 16;
}
const HALF = 16; // taps each side of the interpolated point
const TAPS = 2 * HALF;

// Phase p (1..3) interpolates x(n + p/4) from x[n-15 .. n+16]. Hann-windowed
// sinc, each phase normalised to unit DC gain. Phase 0 is x[n] itself.
const PHASES = (() => {
  const out = [];
  for (let p = 1; p < FACTOR; p++) {
    const h = new Float64Array(TAPS);
    let sum = 0;
    for (let j = 0; j < TAPS; j++) {
      const u = (HALF - 1) + p / FACTOR - j;
      const sinc = Math.sin(Math.PI * u) / (Math.PI * u);
      const w = Math.abs(u) < HALF ? 0.5 + 0.5 * Math.cos((Math.PI * u) / HALF) : 0;
      h[j] = sinc * w;
      sum += h[j];
    }
    for (let j = 0; j < TAPS; j++) h[j] /= sum;
    out.push(h);
  }
  return out;
})();

/** Largest |interpolated value| per unit input: bounds when interpolation can matter. */
const PHASE_L1 = Math.max(...PHASES.map((h) => h.reduce((s, v) => s + Math.abs(v), 0)));

function dbToGain(db) { return Math.pow(10, db / 20); }

/**
 * True peak of frame n across channels (sample and inter-sample points).
 * `localMax` is max |x| over x[n-15..n+16] (any channel); when even the
 * worst-case interpolation of that cannot reach `skipBelow`, only the sample
 * peak is returned.
 */
function framePeak(channels, n, frames, localMax, skipBelow) {
  let peak = 0;
  for (let c = 0; c < channels.length; c++) {
    const v = Math.abs(channels[c][n] || 0);
    if (v > peak) peak = v;
  }
  if (localMax * PHASE_L1 < skipBelow) return peak;
  const lo = n - (HALF - 1);
  const interior = lo >= 0 && lo + TAPS <= frames;
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c];
    for (let p = 0; p < PHASES.length; p++) {
      const h = PHASES[p];
      let acc = 0;
      if (interior) {
        for (let j = 0; j < TAPS; j++) acc += h[j] * x[lo + j];
      } else {
        for (let j = 0; j < TAPS; j++) {
          const m = lo + j;
          if (m >= 0 && m < frames) acc += h[j] * x[m];
        }
      }
      const a = acc < 0 ? -acc : acc;
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Sliding max of max_c |x| over the interpolation support, as an iterator state. */
function makeLocalMax(channels, frames) {
  // Monotone deque of indices with decreasing |x| over [n-15, n+16].
  const dq = new Int32Array(TAPS + 2);
  let head = 0; let tail = 0; let next = 0;
  const at = (i) => {
    let v = 0;
    for (let c = 0; c < channels.length; c++) {
      const a = Math.abs(channels[c][i] || 0);
      if (a > v) v = a;
    }
    return v;
  };
  const vals = new Float64Array(TAPS + 2);
  return (n) => {
    const hi = Math.min(frames - 1, n + HALF);
    while (next <= hi) {
      const v = at(next);
      while (tail > head && vals[(tail - 1) % vals.length] <= v) tail--;
      dq[tail % dq.length] = next;
      vals[tail % vals.length] = v;
      tail++;
      next++;
    }
    while (tail > head && dq[head % dq.length] < n - (HALF - 1)) head++;
    return tail > head ? vals[head % vals.length] : 0;
  };
}

/**
 * Highest 4× true peak across channels, linear.
 * @param {Float32Array[]} channels
 */
export function measureTruePeak(channels) {
  const frames = channels[0] ? channels[0].length : 0;
  const localMax = makeLocalMax(channels, frames);
  let peak = 0;
  for (let n = 0; n < frames; n++) {
    const p = framePeak(channels, n, frames, localMax(n), peak);
    if (p > peak) peak = p;
  }
  return peak;
}

/**
 * Limit `channels` so their 4× true peak stays at or under `ceilingDb`.
 * @param {Float32Array[]} channels  read only
 * @param {number} sampleRate
 * @param {{ ceilingDb?: number, releaseMs?: number, lookaheadMs?: number, signal?: AbortSignal,
 *           yieldEvery?: number, yieldFn?: () => Promise<void> }} [options]
 * @returns {Promise<{ channels: Float32Array[], limited: boolean, maxReductionDb: number, inputPeakDb: number, outputPeakDb: number }>}
 */
export async function limitTruePeak(channels, sampleRate, options = {}) {
  const frames = channels?.[0]?.length || 0;
  const ceilingDb = Number.isFinite(options.ceilingDb) ? Math.min(0, options.ceilingDb) : SAFETY_CEILING_DB;
  const releaseMs = Number.isFinite(options.releaseMs) ? Math.min(2000, Math.max(5, options.releaseMs)) : 60;
  const lookaheadMs = Number.isFinite(options.lookaheadMs) ? Math.min(20, Math.max(0.5, options.lookaheadMs)) : LOOKAHEAD_MS;
  const yieldEvery = options.yieldEvery || 1 << 16;
  const yieldFn = options.yieldFn || (() => new Promise((r) => setTimeout(r, 0)));
  const checkAbort = () => {
    if (options.signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
  };
  const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));
  const ceiling = dbToGain(ceilingDb);
  const inputPeak = measureTruePeak(channels);
  if (!(frames > 0) || inputPeak <= ceiling) {
    return { channels, limited: false, maxReductionDb: 0, inputPeakDb: db(inputPeak), outputPeakDb: db(inputPeak) };
  }

  let source = channels;
  let result = null;
  let maxReduction = 1;
  // Gain modulation can lift an inter-sample point a hair; re-run on the output
  // with the target lowered by that excess (converges in one extra pass).
  let target = ceiling * dbToGain(-MARGIN_DB);
  for (let pass = 0; pass < 3; pass++) {
    const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
    const rel = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
    const slowAttack = Math.exp(-1 / ((SLOW_ATTACK_MS / 1000) * sampleRate));
    const slowRel = Math.exp(-1 / ((Math.max(MIN_SLOW_RELEASE_MS, releaseMs * SLOW_RELEASE_FACTOR) / 1000) * sampleRate));
    let gSlow = 1;
    const out = source.map((ch) => new Float32Array(ch.length));
    const localMax = makeLocalMax(source, frames);
    // Ring of the last L+1 required gains (sliding min via monotone deque).
    const dqIdx = new Int32Array(L + 2); const dqVal = new Float64Array(L + 2);
    let head = 0; let tail = 0;
    const ring = new Float64Array(L + 1); // A[m] = min greq[max(0,m) .. m+L]
    let ringSum = 0;
    let g = 1;
    for (let n = 0; n < frames + 2 * L; n++) {
      if (n > 0 && n % yieldEvery === 0) { checkAbort(); await yieldFn(); }
      // Required gain at n (1 beyond the end).
      let greq = 1;
      if (n < frames) {
        const p = framePeak(source, n, frames, localMax(n), target);
        if (p > target) greq = target / p;
      }
      while (tail > head && dqVal[(tail - 1) % dqVal.length] >= greq) tail--;
      dqIdx[tail % dqIdx.length] = n; dqVal[tail % dqVal.length] = greq; tail++;
      while (dqIdx[head % dqIdx.length] < n - L) head++;
      // A[m] for m = n - L is now complete.
      // Before the start, A[m] is the min over the frames that exist (from 0),
      // so the averaging window for the first outputs already holds them.
      const m = n - L;
      const a = dqVal[head % dqVal.length];
      const slot = ((m % (L + 1)) + (L + 1)) % (L + 1);
      ringSum += a - ring[slot];
      ring[slot] = a;
      // Output index q = m: attack-smoothed gain is the mean of A[q-L .. q].
      const q = m;
      if (q < 0 || q >= frames) continue;
      const gatt = Math.min(1, ringSum / (L + 1));
      g = gatt < g ? gatt : g + (gatt - g) * (1 - rel);
      gSlow = gatt < gSlow ? gSlow + (gatt - gSlow) * (1 - slowAttack) : gSlow + (gatt - gSlow) * (1 - slowRel);
      const gain = g < gSlow ? g : gSlow;
      if (gain < maxReduction) maxReduction = gain;
      for (let c = 0; c < source.length; c++) out[c][q] = source[c][q] * gain;
    }
    result = out;
    const outPeak = measureTruePeak(result);
    if (outPeak <= ceiling) break;
    source = result;
    target = target * (ceiling / outPeak) * dbToGain(-MARGIN_DB);
  }
  const outputPeak = measureTruePeak(result);
  return {
    channels: result,
    limited: true,
    maxReductionDb: -db(maxReduction),
    inputPeakDb: db(inputPeak),
    outputPeakDb: db(outputPeak),
  };
}

export default { limitTruePeak, measureTruePeak, truePeakLimiterLatencyFrames, SAFETY_CEILING_DB };
