/**
 * VoiceIsolate Pro — post-Process session stats (Layer 2: Core)
 *
 * Level-invariant, reference-free estimates from 50 ms frame energies of the
 * original (o), the processed stem (p) and the removed stem (r; o - p when
 * absent). Speech frames are the processed stem's frames more than 6 dB above
 * its between-phrase level (the mean of its quietest 30 % of frames).
 *
 *   voicePct            speech-locked share of p: (mean(Ep) - gap) / mean(Ep)
 *   snrDb               p's speech frames above its gaps, dB
 *   noiseReductionDb    snrDb minus the same measure on o (>= 0)
 *   whisperRetentionPct 100 * (1 - speech-locked energy in r / speech-locked energy in o)
 *
 * Gain applied to the whole session, or to p alone, does not change them.
 * They are estimates, not a reference measurement: SI-SDR / STOI against a
 * clean reference remain the ground truth offline.
 *
 * measureExportLoudness() reports the exported file's integrated loudness
 * (ITU-R BS.1770-4) and 4x true peak.
 */
'use strict';

import { measureIntegratedLufs } from './Loudness.js';
import { measureTruePeak } from './TruePeakLimiter.js';

export const STATS_FRAME_SEC = 0.05;
export const SPEECH_MARGIN_DB = 6;
/** Between-phrase level = mean of the processed stem's quietest 30 % of frames. */
export const GAP_QUANTILE = 0.3;

const clampDb = (v) => Math.max(-40, Math.min(60, v));
const ratioDb = (a, b) => clampDb(10 * Math.log10(Math.max(a, 1e-20) / Math.max(b, 1e-20)));

/**
 * Stats from per-frame mean energies (equal-length arrays).
 * @param {ArrayLike<number>} Eo original
 * @param {ArrayLike<number>} Ep processed stem
 * @param {ArrayLike<number>} Er removed stem
 */
export function statsFromFrames(Eo, Ep, Er) {
  const n = Math.min(Eo.length, Ep.length, Er.length);
  const empty = {
    voicePct: null, noisePct: null, snrDb: null, snrInDb: null,
    noiseReductionDb: null, whisperRetentionPct: null, speechFraction: 0,
  };
  if (n < 4) return empty;
  const sorted = Float64Array.from({ length: n }, (_, i) => Ep[i]).sort();
  const lowQ = sorted[Math.floor((n - 1) * GAP_QUANTILE)];
  let gapSum = 0;
  let gapN = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += Ep[i];
    if (Ep[i] <= lowQ) { gapSum += Ep[i]; gapN++; }
  }
  const gap = gapN ? gapSum / gapN : 0;
  const thr = gap * 10 ** (SPEECH_MARGIN_DB / 10);
  let sp = 0;
  let spP = 0; let spO = 0; let spR = 0;
  let gpO = 0; let gpR = 0;
  for (let i = 0; i < n; i++) {
    if (Ep[i] > thr && Ep[i] > 1e-12) {
      sp++; spP += Ep[i]; spO += Eo[i]; spR += Er[i];
    } else {
      gpO += Eo[i]; gpR += Er[i];
    }
  }
  const ng = n - sp;
  if (!sp || !ng) {
    return { ...empty, voicePct: sp ? 100 : 0, noisePct: sp ? 0 : 100, speechFraction: sp / n };
  }
  const meanP = total / n;
  const Sp = Math.max(0, spP / sp - gap);
  const gapO = gpO / ng;
  const So = Math.max(0, spO / sp - gapO);
  const Sr = Math.max(0, spR / sp - gpR / ng);
  const voicePct = meanP > 0 ? Math.max(0, Math.min(100, (100 * Math.max(0, meanP - gap)) / meanP)) : 0;
  const snrDb = ratioDb(Sp, gap);
  const snrInDb = ratioDb(So, gapO);
  return {
    voicePct,
    noisePct: 100 - voicePct,
    snrDb,
    snrInDb,
    noiseReductionDb: Math.max(0, snrDb - snrInDb),
    whisperRetentionPct: So > 0 ? Math.max(0, Math.min(100, 100 * (1 - Sr / So))) : null,
    speechFraction: sp / n,
  };
}

/**
 * Frame energies of o, p and r (r = o - p when null), then statsFromFrames().
 * @param {Float32Array} o
 * @param {Float32Array} p
 * @param {Float32Array|null} r
 * @param {number} sampleRate
 * @param {{ yieldFn?: () => Promise<void>, isStale?: () => boolean, chunkFrames?: number }} [opts]
 * @returns {Promise<object|null>} null when stale
 */
export async function computeStemStats(o, p, r, sampleRate, opts = {}) {
  const F = Math.max(32, Math.round((sampleRate || 48000) * STATS_FRAME_SEC));
  const len = Math.min(o.length, p.length, r ? r.length : Infinity);
  const frames = Math.floor(len / F);
  const Eo = new Float64Array(frames);
  const Ep = new Float64Array(frames);
  const Er = new Float64Array(frames);
  const chunk = opts.chunkFrames || 400;
  for (let f0 = 0; f0 < frames; f0 += chunk) {
    if (opts.isStale && opts.isStale()) return null;
    const f1 = Math.min(frames, f0 + chunk);
    for (let f = f0; f < f1; f++) {
      let eo = 0; let ep = 0; let er = 0;
      const base = f * F;
      for (let i = base; i < base + F; i++) {
        const ov = o[i]; const pv = p[i];
        const rv = r ? r[i] : ov - pv;
        eo += ov * ov; ep += pv * pv; er += rv * rv;
      }
      Eo[f] = eo / F; Ep[f] = ep / F; Er[f] = er / F;
    }
    if (opts.yieldFn && f1 < frames) await opts.yieldFn();
  }
  if (opts.isStale && opts.isStale()) return null;
  return statsFromFrames(Eo, Ep, Er);
}

/**
 * Integrated loudness and 4x true peak of an exported buffer.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{ lufs: number|null, truePeakDb: number|null }}
 */
export function measureExportLoudness(channels, sampleRate) {
  if (!Array.isArray(channels) || !channels.length || !channels[0]?.length) {
    return { lufs: null, truePeakDb: null };
  }
  const lufsRaw = measureIntegratedLufs(channels, sampleRate);
  const tp = measureTruePeak(channels);
  return {
    lufs: Number.isFinite(lufsRaw) && lufsRaw > -70 ? lufsRaw : null,
    truePeakDb: tp > 0 ? 20 * Math.log10(tp) : null,
  };
}

export default { computeStemStats, statsFromFrames, measureExportLoudness, STATS_FRAME_SEC, SPEECH_MARGIN_DB };
