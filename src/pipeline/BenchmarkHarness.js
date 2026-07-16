/**
 * VoiceIsolate Pro — Benchmark Harness (Layer 3: Pipeline)
 *
 * Aggregates PipelineTiming stages + wall-clock measurements for UI and
 * research export. No network; pure in-process metrics.
 */
'use strict';

import { getTimings } from './PipelineTiming.js';
import { getOrtStatus, formatOrtProviderLabel } from '../core/OrtStatus.js';

/**
 * @typedef {object} BenchmarkSample
 * @property {number} t
 * @property {string} label
 * @property {number} ms
 * @property {Record<string, number>} [stages]
 */

export class BenchmarkHarness {
  constructor() {
    /** @type {BenchmarkSample[]} */
    this.samples = [];
    this._marks = new Map();
  }

  /**
   * @param {string} label
   */
  start(label) {
    const key = String(label || 'job');
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._marks.set(key, t0);
    return this;
  }

  /**
   * @param {string} label
   * @returns {BenchmarkSample|null}
   */
  end(label) {
    const key = String(label || 'job');
    const t0 = this._marks.get(key);
    if (t0 == null) return null;
    this._marks.delete(key);
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const ms = Math.max(0, t1 - t0);
    const stages = getTimings() || {};
    const sample = {
      t: Date.now(),
      label: key,
      ms,
      stages: { ...stages },
    };
    this.samples.push(sample);
    if (this.samples.length > 50) this.samples.shift();
    if (typeof globalThis !== 'undefined') {
      globalThis.__vipLastBenchmark = sample;
    }
    return sample;
  }

  /**
   * Summary for UI strip.
   * @returns {object}
   */
  summary() {
    const n = this.samples.length;
    const last = n ? this.samples[n - 1] : null;
    const avg = n
      ? this.samples.reduce((s, x) => s + x.ms, 0) / n
      : 0;
    return {
      sampleCount: n,
      lastMs: last?.ms ?? null,
      lastLabel: last?.label ?? null,
      avgMs: avg,
      lastStages: last?.stages || {},
      liveTimings: getTimings(),
      ort: getOrtStatus(),
      ortLabel: formatOrtProviderLabel(),
    };
  }

  /**
   * Human-readable one-liner for status bars.
   * @returns {string}
   */
  formatStatusLine() {
    const s = this.summary();
    if (!s.lastMs && s.lastMs !== 0) return `Bench idle · ${s.ortLabel}`;
    const stages = s.lastStages || {};
    const decode = stages.decode != null ? ` decode ${Math.round(stages.decode)}ms` : '';
    const ml = stages.ml_isolation != null ? ` ml ${Math.round(stages.ml_isolation)}ms` : '';
    const iso = stages.isolate != null ? ` iso ${Math.round(stages.isolate)}ms` : '';
    return `${s.lastLabel || 'job'}: ${Math.round(s.lastMs)}ms${decode}${ml}${iso} · ${s.ortLabel}`;
  }

  clear() {
    this.samples.length = 0;
    this._marks.clear();
  }
}

/** Shared singleton for Engineer / Landing. */
export const globalBenchmark = new BenchmarkHarness();

if (typeof globalThis !== 'undefined') {
  globalThis.__vipBenchmark = globalBenchmark;
}

export default BenchmarkHarness;
