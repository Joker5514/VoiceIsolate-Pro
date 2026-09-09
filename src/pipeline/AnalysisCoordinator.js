/** Shared analysis boundary: in-flight dedupe, cancellation, cache and stale suppression. */
'use strict';

import { validateAnalysisSnapshot } from '../core/IntelligenceContracts.js';

export class AnalysisCoordinator {
  constructor({ analyze, maxEntries = 8 } = {}) {
    if (typeof analyze !== 'function') throw new TypeError('[VIP][AnalysisCoordinator] analyze is required');
    this.analyzeFn = analyze;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.inflight = new Map();
    this.generation = new Map();
  }

  static cacheKey(identity) {
    const parts = ['contentFingerprint', 'analysisVersion', 'analyzerVersions', 'modelVersions', 'configuration', 'runtime'];
    return parts.map((key) => JSON.stringify(identity[key] ?? null)).join('|');
  }

  async analyze(identity, input, options = {}) {
    const key = AnalysisCoordinator.cacheKey(identity);
    const cached = this.cache.get(key);
    if (cached) return { ...cached, freshness: 'cached' };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const generation = (this.generation.get(key) || 0) + 1;
    this.generation.set(key, generation);
    const promise = Promise.resolve().then(() => this.analyzeFn(input, { ...options, signal: options.signal }))
      .then((snapshot) => {
        validateAnalysisSnapshot(snapshot);
        if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (this.generation.get(key) !== generation) throw new Error('[VIP][AnalysisCoordinator] Stale result suppressed');
        const fresh = { ...snapshot, freshness: 'fresh' };
        this.cache.set(key, fresh);
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        return fresh;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(identity) {
    const key = AnalysisCoordinator.cacheKey(identity);
    this.generation.set(key, (this.generation.get(key) || 0) + 1);
    this.cache.delete(key);
  }

  clear() {
    for (const key of this.inflight.keys()) this.generation.set(key, (this.generation.get(key) || 0) + 1);
    this.cache.clear();
  }
}

export default AnalysisCoordinator;
