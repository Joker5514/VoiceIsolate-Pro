/**
 * VoiceIsolate Pro — Processing Orchestrator (Layer 3: Pipeline)
 *
 * Orchestrates file ingestion + MLWorker model chaining for isolation modes.
 * Supports AbortSignal / jobId cooperative cancel and soft result cache.
 */
'use strict';

import { ingestFile } from './FileIngestion.js';
import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { debugLog } from '../core/debug.js';
import {
  CancellationError,
  isCancellationError,
  throwIfAborted,
} from './JobController.js';

const MANIFEST_ARRAY = Object.values(MODEL_MANIFEST);

/** Soft in-memory stem cache (session only, no telemetry). */
const _stemCache = new Map();
const STEM_CACHE_MAX = 4;

function fileCacheKey(file, options = {}) {
  if (!file) return null;
  const name = file.name || '';
  const size = file.size || 0;
  const mt = file.lastModified || 0;
  const mode = options.isolationMode || 'standard';
  const prompt = options.prompt || options.description || '';
  const sam = options.samMode || '';
  return `${name}|${size}|${mt}|${mode}|${prompt}|${sam}`;
}

export class ProcessingOrchestrator {
  constructor(options) {
    if (!options.mlWorker) {
      throw new TypeError('[VIP][ProcessingOrchestrator] mlWorker is required');
    }
    this.mlWorker = options.mlWorker;
    this.onProgress = options.onProgress || (() => {});
    this._initialized = false;
    this._initPromise = null;
    this._rejectInit = null;
    this._requestSeq = 0;
    this._activeRequestId = null;
    this._activeSettlement = null;
    this._timings = [];
  }

  async initialize(signal) {
    throwIfAborted(signal);
    if (this._initialized) return;
    if (this._initPromise) {
      await this._initPromise;
      throwIfAborted(signal);
      return;
    }

    let resolveInit;
    let rejectInitPromise;
    const initPromise = new Promise((resolve, reject) => {
      resolveInit = resolve;
      rejectInitPromise = reject;
    });
    const initToken = {};
    this._initPromise = initPromise;
    this._initToken = initToken;

    let settled = false;
    let timeout = null;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      this.mlWorker.removeEventListener('message', handler);
      this.mlWorker.removeEventListener('error', onWorkerError);
      this.mlWorker.removeEventListener('messageerror', onMessageError);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (this._initToken === initToken) {
        this._initPromise = null;
        this._initToken = null;
        this._rejectInit = null;
      }
      callback();
    };
    const rejectInit = (error) => settle(() => rejectInitPromise(error));
    const onAbort = () => rejectInit(new CancellationError('Cancelled during ML init'));
    const onWorkerError = (event) => rejectInit(new Error(
      `[VIP][ProcessingOrchestrator] MLWorker initialization failed: ${event?.message || 'worker error'}`,
    ));
    const onMessageError = () => rejectInit(new Error(
      '[VIP][ProcessingOrchestrator] MLWorker initialization message could not be deserialized',
    ));
    const handler = (event) => {
      const msg = event?.data;
      if (!msg || typeof msg !== 'object') {
        rejectInit(new Error('[VIP][ProcessingOrchestrator] Malformed MLWorker initialization message'));
        return;
      }
      if (msg.type === 'ready') {
        this._initialized = true;
        debugLog('ProcessingOrchestrator', `MLWorker ready (${msg.backend})`);
        settle(resolveInit);
      } else if (msg.type === 'error') {
        rejectInit(new Error(msg.message || 'MLWorker init error'));
      }
    };

    this._rejectInit = rejectInit;
    timeout = setTimeout(() => {
      rejectInit(new Error('[VIP][ProcessingOrchestrator] MLWorker initialization timeout'));
    }, 30000);
    this.mlWorker.addEventListener('message', handler);
    this.mlWorker.addEventListener('error', onWorkerError);
    this.mlWorker.addEventListener('messageerror', onMessageError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    try {
      this.mlWorker.postMessage({ type: 'init', manifest: MANIFEST_ARRAY });
    } catch (error) {
      rejectInit(error);
    }

    await initPromise;
  }

  /**
   * @param {File|Blob} file
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.jobId]
   */
  async processFile(file, options = {}) {
    const signal = options.signal;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    throwIfAborted(signal, options.jobId);

    const cacheKey = fileCacheKey(file, options);
    if (cacheKey && _stemCache.has(cacheKey) && options.isolationMode !== 'prompted') {
      // Prompted isolation often depends on live SAM worker state — skip soft cache.
      const cached = _stemCache.get(cacheKey);
      this.onProgress(1, 'complete-cached');
      debugLog('ProcessingOrchestrator', `stem cache hit ${cacheKey.slice(0, 48)}`);
      return {
        ...cached,
        metadata: {
          ...(cached.metadata || {}),
          fromCache: true,
        },
      };
    }

    if (!this._initialized) await this.initialize(signal);
    throwIfAborted(signal, options.jobId);

    const { isolationMode = 'standard', prompt, samMode } = options;

    this.onProgress(0, 'ingesting');
    const tIngest0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ingested = await ingestFile(file, { isolationMode, signal });
    throwIfAborted(signal, options.jobId);
    this._noteTiming('ingest', tIngest0);

    this.onProgress(0.2, 'processing');

    const channelData = ingested.channelData.map((c) => new Float32Array(c));

    // Prompted / SAM-class isolation — Creator path via provider selector
    if (isolationMode === 'prompted') {
      const { runPromptedIsolation } = await import('./PromptedIsolation.js');
      const isDesktop = typeof globalThis !== 'undefined'
        && globalThis.vipDesktop
        && typeof globalThis.vipDesktop.samWorkerStart === 'function';
      const isAndroid = typeof navigator !== 'undefined'
        && /Android/i.test(navigator.userAgent || '');

      if (isDesktop) {
        try {
          throwIfAborted(signal, options.jobId);
          await globalThis.vipDesktop.samWorkerStart({});
        } catch (err) {
          if (isCancellationError(err)) throw err;
          /* worker optional if already running */
        }
      }

      this.onProgress(0.35, 'prompted-isolation');
      const tPrompt0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const pr = await runPromptedIsolation({
        audio: channelData,
        sampleRate: ingested.sampleRate,
        prompt: prompt || options.description || 'person speaking',
        mode: options.promptMode || 'text',
        anchors: options.anchors || [],
        output: 'both',
        processingMode: options.processingMode || 'creator',
        samMode: samMode || (isDesktop ? 'local-worker' : 'auto'),
        isDesktop,
        isAndroid,
        signal,
        jobId: options.jobId,
      });
      throwIfAborted(signal, options.jobId);
      this._noteTiming('prompted', tPrompt0);

      const target = pr.target instanceof Float32Array
        ? pr.target
        : (Array.isArray(pr.target) ? pr.target[0] : channelData[0]);
      const residual = pr.residual instanceof Float32Array
        ? pr.residual
        : (Array.isArray(pr.residual) ? pr.residual[0] : new Float32Array(target.length));

      this.onProgress(1, 'complete');
      this._noteTiming('total', t0);
      return {
        cleanStem: target,
        noiseStem: residual,
        cleanChannels: [target],
        noiseChannels: [residual],
        metadata: {
          isolationMode: 'prompted',
          modelIds: [],
          providerId: pr.providerId,
          selectionReason: pr.selectionReason,
          mock: !!(pr.meta && pr.meta.mock),
          sourceName: ingested.sourceName,
          duration: ingested.duration,
          sampleRate: pr.sampleRate || ingested.sampleRate,
          passthrough: false,
          timingsMs: this._timings.slice(),
        },
      };
    }

    const requestId = ++this._requestSeq;
    this._activeRequestId = requestId;
    const tMl0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let result;
    try {
      result = await this._processWithMLWorker(
        channelData,
        ingested.sampleRate,
        ingested.modelIds,
        requestId,
        signal,
      );
    } finally {
      if (this._activeRequestId === requestId) this._activeRequestId = null;
    }
    throwIfAborted(signal, options.jobId);
    this._noteTiming('ml', tMl0);

    if (result.passthrough) {
      throw new Error('ML isolation failed — models unavailable or inference error.');
    }

    this.onProgress(1, 'complete');
    this._noteTiming('total', t0);

    const mono = this._mixToMono(result.clean);
    const noiseMono = this._mixToMono(result.noise);

    const out = {
      cleanStem: mono,
      noiseStem: noiseMono,
      cleanChannels: result.clean,
      noiseChannels: result.noise,
      metadata: {
        isolationMode: ingested.isolationMode,
        modelIds: ingested.modelIds,
        sourceName: ingested.sourceName,
        duration: ingested.duration,
        sampleRate: ingested.sampleRate,
        passthrough: false,
        timingsMs: this._timings.slice(),
      },
    };

    if (cacheKey) {
      _stemCache.set(cacheKey, out);
      while (_stemCache.size > STEM_CACHE_MAX) {
        const first = _stemCache.keys().next().value;
        _stemCache.delete(first);
      }
    }

    return out;
  }

  _noteTiming(label, t0) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ms = Math.round(now - t0);
    this._timings.push({ label, ms });
    debugLog('ProcessingOrchestrator', `timing ${label}=${ms}ms`);
  }

  _processWithMLWorker(channelData, sampleRate, modelIds, requestId, signal) {
    return new Promise((resolve, reject) => {
      let lastProgressAt = Date.now();
      let settled = false;
      let handler = null;
      let onWorkerError = null;
      let onMessageError = null;
      let timeout = null;
      let stallWatch = null;
      const worker = this.mlWorker;
      function cleanup() {
        clearTimeout(timeout);
        clearInterval(stallWatch);
        signal?.removeEventListener?.('abort', onAbort);
        if (handler) worker.removeEventListener('message', handler);
        if (onWorkerError) worker.removeEventListener('error', onWorkerError);
        if (onMessageError) worker.removeEventListener('messageerror', onMessageError);
        if (this._activeSettlement?.requestId === requestId) this._activeSettlement = null;
        if (this._activeRequestId === requestId) this._activeRequestId = null;
      }
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        cleanup.call(this);
        callback();
      };
      this._activeRequestId = requestId;
      this._activeSettlement = {
        requestId,
        reject: (error) => settle(() => reject(error)),
      };
      timeout = setTimeout(() => {
        try { this.mlWorker.postMessage({ type: 'cancel', requestId }); } catch { /* ignore */ }
        settle(() => reject(new Error('[VIP][ProcessingOrchestrator] MLWorker processing timeout')));
      }, 300000);
      stallWatch = setInterval(() => {
        if (Date.now() - lastProgressAt < 45000) return;
        try { this.mlWorker.postMessage({ type: 'cancel', requestId }); } catch { /* ignore */ }
        settle(() => reject(new Error('[VIP][ProcessingOrchestrator] processing stalled')));
      }, 5000);

      const onAbort = () => {
        try {
          this.mlWorker.postMessage({ type: 'cancel', requestId });
        } catch { /* ignore */ }
        settle(() => reject(new CancellationError('Cancelled')));
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      handler = (event) => {
        const msg = event?.data;
        if (!msg || typeof msg !== 'object' || msg.requestId !== requestId) return;

        if (msg.type === 'progress') {
          lastProgressAt = Date.now();
          const percent = Number.isFinite(msg.percent) ? Math.max(0, Math.min(100, msg.percent)) : 0;
          try {
            this.onProgress(0.2 + (percent / 100) * 0.8, 'processing');
          } catch { /* UI callbacks must not strand worker settlement */ }
        } else if (msg.type === 'stems') {
          settle(() => resolve({
            clean: msg.clean,
            noise: msg.noise,
            passthrough: Boolean(msg.passthrough),
          }));
        } else if (msg.type === 'cancelled') {
          settle(() => reject(new CancellationError('Cancelled')));
        } else if (msg.type === 'error') {
          settle(() => reject(new Error(msg.message || 'MLWorker error')));
        }
      };

      onWorkerError = (event) => {
        this._initialized = false;
        settle(() => reject(new Error(
          `[VIP][ProcessingOrchestrator] MLWorker failed: ${event?.message || 'worker error'}`,
        )));
      };
      onMessageError = () => {
        this._initialized = false;
        settle(() => reject(new Error(
          '[VIP][ProcessingOrchestrator] MLWorker message could not be deserialized',
        )));
      };

      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.addEventListener('error', onWorkerError);
      this.mlWorker.addEventListener('messageerror', onMessageError);
      const transfers = channelData.map((c) => c.buffer);
      try {
        this.mlWorker.postMessage({
          type: 'process',
          requestId,
          modelIds,
          channelData,
          sampleRate,
        }, transfers);
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }

  /** Best-effort cancel of in-flight ML process. */
  cancelActive(reason = 'Cancelled') {
    if (this._activeRequestId == null) return;
    const requestId = this._activeRequestId;
    try {
      this.mlWorker.postMessage({ type: 'cancel', requestId });
    } catch { /* ignore */ }
    this._activeSettlement?.reject(new CancellationError(reason));
  }

  _mixToMono(channelData) {
    if (channelData.length === 1) return new Float32Array(channelData[0]);
    const length = channelData[0].length;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let ch = 0; ch < channelData.length; ch++) sum += channelData[ch][i];
      mono[i] = sum / channelData.length;
    }
    return mono;
  }

  clearStemCache() {
    _stemCache.clear();
  }

  dispose() {
    this._rejectInit?.(new CancellationError('Disposed during ML init'));
    this.cancelActive('Disposed during processing');
    this._initialized = false;
    this._initPromise = null;
    this._initToken = null;
  }
}

export default ProcessingOrchestrator;
