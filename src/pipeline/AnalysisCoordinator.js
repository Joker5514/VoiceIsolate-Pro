/** Shared analysis boundary: in-flight dedupe, cancellation, cache and stale suppression. */
'use strict';

import { validateAnalysisSnapshot } from '../core/IntelligenceContracts.js';
import {
  adaptAutoAnalysisToSnapshot,
  snapshotToOverlayModel,
  AUTO_ANALYSIS_ANALYZER_VERSION,
} from '../core/AnalysisSnapshotAdapter.js';
import { runAutoAnalysis } from '../core/audio/analysis/AutoAnalysis.js';

/** Why a coordinator request did not produce a fresh snapshot. */
export const ANALYSIS_OUTCOMES = Object.freeze({
  CANCELLED: 'CANCELLED',
  STALE: 'STALE',
  FAILED: 'FAILED',
});

export class StaleAnalysisError extends Error {
  constructor(message = '[VIP][AnalysisCoordinator] Stale result suppressed') {
    super(message);
    this.name = 'StaleAnalysisError';
    this.code = ANALYSIS_OUTCOMES.STALE;
  }
}

function abortError() {
  const err = new Error('[VIP][AnalysisCoordinator] Cancelled');
  err.name = 'AbortError';
  err.code = ANALYSIS_OUTCOMES.CANCELLED;
  return err;
}

/**
 * A key without a content fingerprint would let two different files share a
 * cache entry, so such requests are neither cached nor deduplicated.
 */
function isCacheable(identity) {
  const fp = identity?.contentFingerprint;
  return typeof fp === 'string' && fp.length > 0 && fp !== 'unknown';
}

export class AnalysisCoordinator {
  constructor({ analyze, maxEntries = 8 } = {}) {
    if (typeof analyze !== 'function') throw new TypeError('[VIP][AnalysisCoordinator] analyze is required');
    this.analyzeFn = analyze;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    /** key -> { promise, controller, waiters, generation } */
    this.inflight = new Map();
    this.generation = new Map();
  }

  static cacheKey(identity) {
    const parts = ['contentFingerprint', 'analysisVersion', 'analyzerVersions', 'modelVersions', 'configuration', 'runtime'];
    return parts.map((key) => JSON.stringify(identity[key] ?? null)).join('|');
  }

  /**
   * Resolve a validated snapshot for `identity`. Concurrent callers with the
   * same identity share one analysis run; each caller's `signal` only detaches
   * that caller. The shared run is aborted once every waiter has detached.
   */
  analyze(identity, input, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    if (!isCacheable(identity)) return this._run(identity, input, options);

    const key = AnalysisCoordinator.cacheKey(identity);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve({ ...cached, freshness: 'cached' });
    }
    let entry = this.inflight.get(key);
    if (!entry) entry = this._start(key, identity, input, options);
    return this._attach(key, entry, signal);
  }

  _run(identity, input, options) {
    return Promise.resolve()
      .then(() => this.analyzeFn(input, { ...options, identity }))
      .then((snapshot) => {
        if (options.signal?.aborted) throw abortError();
        validateAnalysisSnapshot(snapshot);
        return { ...snapshot, freshness: 'fresh' };
      }, (error) => {
        // Report a caller's own cancellation the same way the shared path does.
        if (options.signal?.aborted) throw abortError();
        throw error;
      });
  }

  _start(key, identity, input, options) {
    const generation = (this.generation.get(key) || 0) + 1;
    this.generation.set(key, generation);
    const controller = new AbortController();
    const entry = { controller, waiters: 0, generation, promise: null };
    entry.promise = Promise.resolve()
      .then(() => this.analyzeFn(input, { ...options, identity, signal: controller.signal }))
      .then((snapshot) => {
        if (this.generation.get(key) !== generation) throw new StaleAnalysisError();
        if (controller.signal.aborted) throw abortError();
        validateAnalysisSnapshot(snapshot);
        const fresh = { ...snapshot, freshness: 'fresh' };
        this.cache.set(key, fresh);
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        return fresh;
      }, (error) => {
        // A run orphaned by invalidate()/clear() reports as stale, not as a failure.
        if (this.generation.get(key) !== generation) throw new StaleAnalysisError();
        throw error;
      })
      .finally(() => {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
    // Waiters observe the outcome through _attach; this handler only keeps a
    // run whose every waiter detached from surfacing as an unhandled rejection.
    entry.promise.catch(() => {});
    this.inflight.set(key, entry);
    return entry;
  }

  _attach(key, entry, signal) {
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const detach = () => {
        signal?.removeEventListener?.('abort', onAbort);
        entry.waiters -= 1;
        if (entry.waiters <= 0 && this.inflight.get(key) === entry) {
          this.inflight.delete(key);
          entry.controller.abort();
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        detach();
        reject(abortError());
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      entry.promise.then((value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        entry.waiters -= 1;
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        entry.waiters -= 1;
        reject(error);
      });
    });
  }

  /** Drop the cached snapshot and orphan any in-flight run for `identity`. */
  invalidate(identity) {
    const key = AnalysisCoordinator.cacheKey(identity);
    this.generation.set(key, (this.generation.get(key) || 0) + 1);
    this.cache.delete(key);
    // Existing waiters receive StaleAnalysisError; new callers start fresh.
    this.inflight.get(key)?.controller.abort();
    this.inflight.delete(key);
  }

  clear() {
    for (const [key, entry] of this.inflight) {
      this.generation.set(key, (this.generation.get(key) || 0) + 1);
      entry.controller.abort();
    }
    this.inflight.clear();
    this.cache.clear();
  }
}

/**
 * Deterministic, synchronous content fingerprint over decoded PCM channels so
 * Landing and Engineer callers can deduplicate & cache `AnalysisSnapshot` runs
 * before or alongside async source-blob SHA-256 hashing.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @returns {string}
 */
export function computeQuickAudioFingerprint(channelData, sampleRate) {
  if (!Array.isArray(channelData) || channelData.length === 0 || !channelData[0]?.length) {
    return 'unknown';
  }
  const chCount = channelData.length;
  const len = channelData[0].length;
  const sr = Math.round(Number(sampleRate) || 0);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (val) => {
    const v = val | 0;
    h1 ^= v & 0xffff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (v >>> 16) & 0xffff;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  };
  mix(chCount);
  mix(sr);
  mix(len);
  const stride = Math.max(1, Math.floor(len / 4096));
  for (let c = 0; c < chCount; c++) {
    const ch = channelData[c];
    if (!ch) continue;
    for (let i = 0; i < ch.length; i += stride) {
      mix(Math.round((ch[i] || 0) * 32767));
    }
    mix(Math.round((ch[ch.length - 1] || 0) * 32767));
  }
  return `pcm-fnv-${chCount}ch-${sr}hz-${len}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

let sharedAutoCoordinator = null;

/**
 * Shared `AnalysisCoordinator` singleton for automatic import analysis across
 * Landing (`landing.js`, `landing-premium.js`) and Engineer (`premium-workspace.js`).
 *
 * @returns {AnalysisCoordinator}
 */
export function getSharedAutoAnalysisCoordinator() {
  if (!sharedAutoCoordinator) {
    sharedAutoCoordinator = new AnalysisCoordinator({
      maxEntries: 8,
      analyze: async (input, opts) => {
        const raw = await runAutoAnalysis(input.channelData, input.sampleRate, {
          signal: opts.signal,
          maybeYield: input.maybeYield,
          detectSpeakers: input.detectSpeakers,
          speakerTimeoutMs: input.speakerTimeoutMs,
          onProgress: input.onProgress,
        });
        return adaptAutoAnalysisToSnapshot(raw, {
          sessionId: opts.identity?.sessionId,
          contentFingerprint: opts.identity?.contentFingerprint,
          analysisVersion: opts.identity?.analysisVersion || '1',
          analyzerVersion: AUTO_ANALYSIS_ANALYZER_VERSION,
        });
      },
    });
  }
  return sharedAutoCoordinator;
}

/**
 * Execute automatic import analysis through `AnalysisCoordinator`, returning a
 * unified overlay model containing the validated canonical `AnalysisSnapshot`
 * (`result.snapshot`). Concurrent callers for the same audio share one pass.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function runCoordinatedAutoAnalysis(channelData, sampleRate, options = {}) {
  const coordinator = options.coordinator || getSharedAutoAnalysisCoordinator();
  const contentFingerprint = options.contentFingerprint
    || computeQuickAudioFingerprint(channelData, sampleRate);
  const identity = {
    sessionId: options.sessionId || undefined,
    contentFingerprint,
    analysisVersion: '1',
    analyzerVersions: { auto: AUTO_ANALYSIS_ANALYZER_VERSION },
    configuration: {
      hasSpeakerHook: typeof options.detectSpeakers === 'function',
    },
  };
  const snapshot = await coordinator.analyze(
    identity,
    {
      channelData,
      sampleRate,
      maybeYield: options.maybeYield,
      detectSpeakers: options.detectSpeakers,
      speakerTimeoutMs: options.speakerTimeoutMs,
      onProgress: options.onProgress,
    },
    { signal: options.signal },
  );
  if (snapshot.freshness === 'cached' && typeof options.onProgress === 'function') {
    options.onProgress(100, { stage: 'complete', cached: true });
  }
  return snapshotToOverlayModel(snapshot);
}

export default AnalysisCoordinator;
