/**
 * VoiceIsolate Pro — Segment Merger (Layer 1: Core)
 *
 * Converts frame-level labels into continuous segments, merges short gaps,
 * and drops jitter. Pure module.
 */
'use strict';

/**
 * @typedef {{ start: number, end: number, label?: string, confidence?: number, meta?: object }} Segment
 */

/**
 * Merge adjacent frames with the same label into segments.
 * @param {Array<{ t: number, label: string, confidence?: number }>} labeledFrames
 * @param {number} hopSec
 * @param {object} [opts]
 * @returns {Segment[]}
 */
export function framesToSegments(labeledFrames, hopSec, opts = {}) {
  const minSec = opts.minSec ?? 0.12;
  const mergeGapSec = opts.mergeGapSec ?? 0.15;
  if (!labeledFrames || labeledFrames.length === 0) return [];

  /** @type {Segment[]} */
  const raw = [];
  let cur = null;
  for (const f of labeledFrames) {
    const conf = f.confidence != null ? f.confidence : 1;
    if (!cur || cur.label !== f.label) {
      if (cur) raw.push(cur);
      cur = {
        start: f.t,
        end: f.t + hopSec,
        label: f.label,
        confidence: conf,
        _n: 1,
        _cSum: conf,
      };
    } else {
      cur.end = f.t + hopSec;
      cur._n += 1;
      cur._cSum += conf;
      cur.confidence = cur._cSum / cur._n;
    }
  }
  if (cur) raw.push(cur);

  // Drop internal counters and short segments after gap merge
  const cleaned = raw.map((s) => ({
    start: s.start,
    end: s.end,
    label: s.label,
    confidence: Math.max(0, Math.min(1, s.confidence ?? 1)),
  }));

  return mergeGaps(cleaned, mergeGapSec, minSec);
}

/**
 * Merge same-label segments separated by short gaps; drop short remnants.
 * @param {Segment[]} segments
 * @param {number} mergeGapSec
 * @param {number} minSec
 */
export function mergeGaps(segments, mergeGapSec = 0.15, minSec = 0.12) {
  if (!segments.length) return [];
  const sorted = segments.slice().sort((a, b) => a.start - b.start);
  /** @type {Segment[]} */
  const out = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.label === cur.label && s.start - cur.end <= mergeGapSec) {
      cur.end = Math.max(cur.end, s.end);
      cur.confidence = Math.max(cur.confidence ?? 0, s.confidence ?? 0);
    } else {
      if (cur.end - cur.start >= minSec) out.push(cur);
      cur = { ...s };
    }
  }
  if (cur.end - cur.start >= minSec) out.push(cur);
  return out;
}

/**
 * Smooth a binary activity series with majority vote over a window.
 * @param {boolean[]} series
 * @param {number} radius frames
 */
export function majoritySmooth(series, radius = 2) {
  if (!series || series.length === 0) return [];
  const out = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    let yes = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j < 0 || j >= series.length) continue;
      n++;
      if (series[j]) yes++;
    }
    out[i] = yes * 2 >= n;
  }
  return out;
}

/**
 * Build labeled frame list from activity masks.
 * @param {Array<object>} frames feature frames with .t
 * @param {(frame: object, index: number) => string} labelFn
 * @param {(frame: object, index: number) => number} [confFn]
 */
export function labelFrames(frames, labelFn, confFn) {
  return frames.map((f, i) => ({
    t: f.t,
    label: labelFn(f, i),
    confidence: confFn ? confFn(f, i) : 1,
  }));
}

/**
 * Continuity score: fraction of frames whose label matches neighbors.
 * @param {string[]} labels
 */
export function continuityScore(labels) {
  if (!labels || labels.length < 2) return 1;
  let same = 0;
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] === labels[i - 1]) same++;
  }
  return same / (labels.length - 1);
}

export default {
  framesToSegments,
  mergeGaps,
  majoritySmooth,
  labelFrames,
  continuityScore,
};
