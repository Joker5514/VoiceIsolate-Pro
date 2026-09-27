/** Shared analysis boundary: in-flight dedupe, cancellation, cache and stale suppression. */
'use strict';

import { validateAnalysisSnapshot } from '../core/IntelligenceContracts.js';

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

export default AnalysisCoordinator;
