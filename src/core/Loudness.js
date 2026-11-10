/**
 * ITU-R BS.1770-4 integrated loudness at 48 kHz.
 *
 * K-weighting is the recommendation's 48 kHz biquad pair (high shelf, then
 * the RLB high-pass). Gating uses 400 ms blocks hopped by 100 ms, an absolute
 * gate of −70 LUFS, then a relative gate 10 LU below the absolute-gated mean.
 * Mono and stereo channels are weighted 1 (the L/R case). This is a meter.
 * It does not change samples and it is not the export true-peak limiter.
 */
'use strict';

export const LOUDNESS_SAMPLE_RATE = 48000;

const ABS_GATE_LUFS = -70;
const REL_GATE_LU = 10;
const OFFSET_DB = -0.691;
const BLOCK_SEC = 0.4;
const HOP_SEC = 0.1;

// BS.1770-4, 48 kHz.
const SHELF_B = Object.freeze([1.53512485958697, -2.69169618940638, 1.19839281085285]);
const SHELF_A = Object.freeze([1, -1.69065929318241, 0.73248077421585]);
const HP_B = Object.freeze([1, -2, 1]);
const HP_A = Object.freeze([1, -1.99004745483398, 0.99007225036621]);

function biquad() {
  return { x1: 0, x2: 0, y1: 0, y2: 0 };
}

function step(state, x, b, a) {
  const y = b[0] * x + b[1] * state.x1 + b[2] * state.x2 - a[1] * state.y1 - a[2] * state.y2;
  state.x2 = state.x1;
  state.x1 = x;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

export function createKWeight() {
  const shelf = biquad();
  const hp = biquad();
  return {
    process(x) {
      return step(hp, step(shelf, x, SHELF_B, SHELF_A), HP_B, HP_A);
    },
    reset() {
      shelf.x1 = shelf.x2 = shelf.y1 = shelf.y2 = 0;
      hp.x1 = hp.x2 = hp.y1 = hp.y2 = 0;
    },
  };
}

function asChannels(input) {
  if (input instanceof Float32Array) return [input];
  if (Array.isArray(input) && input.length && input[0] instanceof Float32Array) return input;
  throw new TypeError('[VIP][Loudness] expected a Float32Array or a list of channels');
}

/** Mean-square of each 400 ms block. One short block when the buffer is shorter. */
export function kWeightedBlockPowers(channels, sampleRate = LOUDNESS_SAMPLE_RATE) {
  const chs = asChannels(channels);
  const n = chs.reduce((m, ch) => Math.min(m, ch.length), chs[0].length);
  if (!n) return [];
  const filtered = chs.map((ch) => {
    const y = new Float32Array(n);
    const filter = createKWeight();
    for (let i = 0; i < n; i++) y[i] = filter.process(ch[i]);
    return y;
  });
  const block = Math.max(1, Math.round(BLOCK_SEC * sampleRate));
  const hop = Math.max(1, Math.round(HOP_SEC * sampleRate));
  const powers = [];
  const emit = (start, len) => {
    let z = 0;
    for (const y of filtered) {
      let s = 0;
      for (let i = start; i < start + len; i++) s += y[i] * y[i];
      z += s / len;
    }
    powers.push(z);
  };
  if (n < block) {
    emit(0, n);
    return powers;
  }
  for (let start = 0; start + block <= n; start += hop) emit(start, block);
  return powers;
}

function lufsOf(meanSquare) {
  return OFFSET_DB + 10 * Math.log10(meanSquare);
}

/** Gated loudness from block mean-squares. No blocks above the absolute gate → −70. */
export function gatedLoudness(blockMeanSquares) {
  const zs = [];
  for (const z of blockMeanSquares) {
    if (Number.isFinite(z) && z > 0) zs.push(z);
  }
  if (!zs.length) return ABS_GATE_LUFS;
  const absolute = zs.filter((z) => lufsOf(z) > ABS_GATE_LUFS);
  if (!absolute.length) return ABS_GATE_LUFS;
  let ungated = 0;
  for (const z of absolute) ungated += z;
  ungated /= absolute.length;
  const relative = lufsOf(ungated) - REL_GATE_LU;
  const kept = absolute.filter((z) => lufsOf(z) > relative);
  const use = kept.length ? kept : absolute;
  let mean = 0;
  for (const z of use) mean += z;
  mean /= use.length;
  return lufsOf(mean);
}

/**
 * Integrated loudness, LUFS.
 * @param {Float32Array|Float32Array[]} channels
 * @param {number} [sampleRate]
 */
export function measureIntegratedLufs(channels, sampleRate = LOUDNESS_SAMPLE_RATE) {
  return gatedLoudness(kWeightedBlockPowers(channels, sampleRate));
}

/**
 * Streaming meter for the header. `integrated` is gated. `shortTerm` is the
 * ungated mean of about the last 3 s of 400 ms blocks.
 */
export function createLoudnessMeter() {
  const filter = createKWeight();
  const block = Math.round(BLOCK_SEC * LOUDNESS_SAMPLE_RATE);
  const hop = Math.round(HOP_SEC * LOUDNESS_SAMPLE_RATE);
  const ring = new Float32Array(block);
  let write = 0;
  let count = 0;
  let sinceHop = hop;
  const powers = [];
  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        ring[write] = filter.process(samples[i]);
        write = (write + 1) % block;
        if (count < block) count += 1;
        if (count < block) continue;
        sinceHop += 1;
        if (sinceHop < hop) continue;
        sinceHop = 0;
        let s = 0;
        for (let k = 0; k < block; k++) s += ring[k] * ring[k];
        powers.push(s / block);
        if (powers.length > 1800) powers.shift();
      }
    },
    integrated() {
      return gatedLoudness(powers);
    },
    shortTerm() {
      const n = Math.round(3 / HOP_SEC);
      const slice = powers.slice(Math.max(0, powers.length - n));
      if (!slice.length) return ABS_GATE_LUFS;
      let mean = 0;
      for (const z of slice) mean += z;
      mean /= slice.length;
      return mean > 0 ? lufsOf(mean) : ABS_GATE_LUFS;
    },
    reset() {
      ring.fill(0);
      write = 0;
      count = 0;
      sinceHop = hop;
      powers.length = 0;
      filter.reset();
    },
  };
}
