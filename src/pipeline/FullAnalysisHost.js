/**
 * VoiceIsolate Pro — Full Analysis Host (Layer 3: Pipeline)
 *
 * Spawns FullAnalysisWorker, falls back to main-thread analyzeAudio if
 * workers are unavailable. Supports AbortSignal cooperative cancel.
 */
'use strict';

import { analyzeAudio } from '../core/FullAnalysis.js';
import { extractFrameFeatures, downmixToMono } from '../core/FeatureExtractor.js';
import { buildVadHints } from './VadAnalysis.js';
import { debugLog } from '../core/debug.js';
import {
  CancellationError,
  throwIfAborted,
} from './JobController.js';

export class FullAnalysisHost {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this._worker = null;
    this._requestId = 0;
    this._useWorker = options.useWorker !== false && typeof Worker !== 'undefined';
    this._enableMlVad = options.enableMlVad !== false;
    this._buildVadHints = options.buildVadHints || buildVadHints;
    this._activeRequestId = null;
    this._activeSettlement = null;
    this._analysisGeneration = 0;
  }

  _recycleWorker(worker = this._worker) {
    if (!worker || this._worker !== worker) return;
    try { worker.terminate(); } catch { /* worker already stopped */ }
    this._worker = null;
  }

  _ensureWorker() {
    if (!this._useWorker) return null;
    if (this._worker) return this._worker;
    try {
      const url = new URL('/src/workers/FullAnalysisWorker.js', globalThis.location?.href || 'http://localhost/');
      this._worker = new Worker(url.href, { type: 'module' });
      return this._worker;
    } catch (err) {
      debugLog('FullAnalysisHost', `Worker unavailable: ${err.message}`);
      this._useWorker = false;
      return null;
    }
  }

  async _withVadHints(channels, sampleRate, opts = {}) {
    if (opts.mlHints?.vadScores || opts.skipVad) return opts;
    throwIfAborted(opts.signal);
    try {
      const reportProgress = typeof opts.onProgress === 'function' ? opts.onProgress : this.onProgress;
      try { reportProgress(8, 'vad'); } catch { /* UI callbacks must not stop analysis */ }
      const mono = downmixToMono(channels);
      const extraction = extractFrameFeatures(mono, sampleRate, {
        frameSec: opts.frameSec,
        hopSec: opts.hopSec,
      });
      throwIfAborted(opts.signal);
      if (this._enableMlVad) {
        const hints = await this._buildVadHints(mono, sampleRate, extraction, {
          signal: opts.signal,
          timeoutMs: opts.vadTimeoutMs,
        });
        throwIfAborted(opts.signal);
        return {
          ...opts,
          mlHints: {
            ...(opts.mlHints || {}),
            ...hints,
          },
        };
      }
    } catch (err) {
      if (err instanceof CancellationError
        || err?.name === 'CancellationError'
        || err?.name === 'AbortError'
        || opts.signal?.aborted) throw err;
      debugLog('FullAnalysisHost', `VAD hints skipped: ${err.message || err}`);
    }
    return opts;
  }

  /**
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]
   */
  async analyze(channels, sampleRate, opts = {}) {
    const signal = opts.signal;
    const generation = ++this._analysisGeneration;
    this._cancelWorkerRequest('Superseded by a newer analysis');
    const reportProgress = typeof opts.onProgress === 'function' ? opts.onProgress : this.onProgress;
    const reportProgressSafely = (percent, stage) => {
      try { reportProgress(percent, stage); } catch { /* UI callbacks must not stop analysis */ }
    };
    throwIfAborted(signal);
    const enriched = await this._withVadHints(channels, sampleRate, opts);
    throwIfAborted(signal);
    if (generation !== this._analysisGeneration) {
      throw new CancellationError('Superseded by a newer analysis');
    }

    const worker = this._ensureWorker();
    if (!worker) {
      reportProgressSafely(20, 'features');
      throwIfAborted(signal);
      const analysis = analyzeAudio(channels, sampleRate, enriched);
      throwIfAborted(signal);
      if (generation !== this._analysisGeneration) {
        throw new CancellationError('Superseded by a newer analysis');
      }
      reportProgressSafely(100, 'complete');
      return analysis;
    }

    const requestId = ++this._requestId;
    this._activeRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timeoutMs = enriched.timeoutMs ?? 180000;
      const stallMs = enriched.expectHeartbeats === true
        && Number.isFinite(enriched.stallMs)
        && enriched.stallMs > 0
        ? enriched.stallMs
        : null;
      let lastActivity = Date.now();
      let settled = false;
      const hardDeadline = Date.now() + timeoutMs;
      let timer = null;

      const cleanup = () => {
        clearInterval(timer);
        signal?.removeEventListener?.('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onMessageError);
        if (this._activeSettlement?.requestId === requestId) this._activeSettlement = null;
        if (this._activeRequestId === requestId) this._activeRequestId = null;
      };
      const settle = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const failWorker = (error) => settle(() => {
        this._recycleWorker(worker);
        reject(error);
      });

      const onAbort = () => {
        try {
          worker.postMessage({ type: 'cancel', requestId });
        } catch { /* worker may already be gone */ }
        failWorker(new CancellationError('Cancelled'));
      };
      const onMessage = (event) => {
        const msg = event?.data;
        if (!msg || typeof msg !== 'object' || msg.requestId !== requestId) return;
        if (msg.type === 'progress' || msg.type === 'heartbeat') {
          lastActivity = Date.now();
          const percent = Number.isFinite(msg.percent) ? Math.max(0, Math.min(100, msg.percent)) : 0;
          try {
            reportProgress(percent, msg.stage || (msg.type === 'heartbeat' ? 'working' : 'analysis'));
          } catch { /* UI callbacks must not strand worker settlement */ }
        } else if (msg.type === 'result') {
          settle(() => resolve(msg.analysis));
        } else if (msg.type === 'cancelled') {
          failWorker(new CancellationError('Cancelled'));
        } else if (msg.type === 'error') {
          failWorker(new Error(msg.message || 'Analysis failed'));
        }
      };
      const onError = (err) => {
        debugLog('FullAnalysisHost', `Worker error: ${err?.message || err}`);
        failWorker(new Error(`Full analysis worker failed: ${err?.message || 'worker error'}`));
      };
      const onMessageError = () => {
        failWorker(new Error('Full analysis worker message could not be deserialized'));
      };

      this._activeSettlement = { requestId, reject: failWorker };
      timer = setInterval(() => {
        const now = Date.now();
        if (signal?.aborted) {
          onAbort();
          return;
        }
        if (now > hardDeadline) {
          try { worker.postMessage({ type: 'cancel', requestId }); } catch { /* ignore */ }
          failWorker(new Error('Full analysis timed out'));
        } else if (stallMs && now - lastActivity > stallMs) {
          try { worker.postMessage({ type: 'cancel', requestId }); } catch { /* ignore */ }
          failWorker(new Error('Full analysis stalled (no worker heartbeat) — retry Analyze'));
        }
      }, 2000);

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMessageError);

      try {
        const optsForWorker = { ...enriched };
        delete optsForWorker.signal;
        delete optsForWorker.onProgress;
        if (optsForWorker.mlHints) {
          const h = { ...optsForWorker.mlHints };
          if (h.vadScores && typeof h.vadScores.length === 'number') {
            h.vadScores = Array.from(h.vadScores);
          }
          if (h.vadActive && typeof h.vadActive.length === 'number') {
            h.vadActive = Array.from(h.vadActive);
          }
          optsForWorker.mlHints = h;
        }

        const transfer = [];
        const payloadChannels = channels.map((ch) => {
          const copy = ch.slice();
          transfer.push(copy.buffer);
          return copy;
        });

        reportProgressSafely(15, 'dispatch');
        worker.postMessage(
          {
            type: 'analyze',
            requestId,
            channels: payloadChannels,
            sampleRate,
            opts: optsForWorker,
          },
          transfer,
        );
      } catch (error) {
        failWorker(error);
      }
    });
  }

  _cancelWorkerRequest(reason) {
    if (this._activeRequestId == null || !this._worker) return;
    const requestId = this._activeRequestId;
    const worker = this._worker;
    try {
      worker.postMessage({ type: 'cancel', requestId });
    } catch { /* ignore */ }
    if (this._activeSettlement?.requestId === requestId) {
      this._activeSettlement.reject(new CancellationError(reason));
    } else {
      this._activeRequestId = null;
      this._recycleWorker(worker);
    }
  }

  cancelActive(reason = 'Cancelled') {
    this._analysisGeneration += 1;
    this._cancelWorkerRequest(reason);
  }

  dispose() {
    this.cancelActive('Disposed during analysis');
    if (this._worker) {
      this._recycleWorker(this._worker);
    }
  }
}

export default FullAnalysisHost;
