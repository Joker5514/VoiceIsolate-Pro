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
    this._activeRequestId = null;
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
      this.onProgress(8, 'vad');
      const mono = downmixToMono(channels);
      const extraction = extractFrameFeatures(mono, sampleRate, {
        frameSec: opts.frameSec,
        hopSec: opts.hopSec,
      });
      throwIfAborted(opts.signal);
      if (this._enableMlVad) {
        const hints = await buildVadHints(mono, sampleRate, extraction);
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
      if (err instanceof CancellationError || err?.name === 'CancellationError') throw err;
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
    throwIfAborted(signal);
    const enriched = await this._withVadHints(channels, sampleRate, opts);
    throwIfAborted(signal);

    const worker = this._ensureWorker();
    if (!worker) {
      this.onProgress(20, 'features');
      throwIfAborted(signal);
      const analysis = analyzeAudio(channels, sampleRate, enriched);
      throwIfAborted(signal);
      this.onProgress(100, 'complete');
      return analysis;
    }

    const requestId = ++this._requestId;
    this._activeRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timeoutMs = enriched.timeoutMs ?? 180000;
      const stallMs = enriched.stallMs ?? 45000;
      let lastActivity = Date.now();
      const hardDeadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        const now = Date.now();
        if (signal?.aborted) {
          cleanup();
          reject(new CancellationError('Cancelled'));
          return;
        }
        if (now - lastActivity > stallMs) {
          cleanup();
          reject(new Error('Full analysis stalled (no worker heartbeat) — retry Analyze'));
        } else if (now > hardDeadline) {
          cleanup();
          reject(new Error('Full analysis timed out'));
        }
      }, 2000);

      const onAbort = () => {
        try {
          worker.postMessage({ type: 'cancel', requestId });
        } catch { /* ignore */ }
        cleanup();
        reject(new CancellationError('Cancelled'));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.requestId !== requestId) return;
        if (msg.type === 'progress' || msg.type === 'heartbeat') {
          lastActivity = Date.now();
          this.onProgress(msg.percent || 0, msg.stage || (msg.type === 'heartbeat' ? 'working' : 'analysis'));
        } else if (msg.type === 'result') {
          cleanup();
          resolve(msg.analysis);
        } else if (msg.type === 'cancelled') {
          cleanup();
          reject(new CancellationError('Cancelled'));
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message || 'Analysis failed'));
        }
      };

      const onError = (err) => {
        cleanup();
        if (signal?.aborted) {
          reject(new CancellationError('Cancelled'));
          return;
        }
        debugLog('FullAnalysisHost', `Worker error, falling back: ${err.message || err}`);
        try {
          const analysis = analyzeAudio(channels, sampleRate, enriched);
          resolve(analysis);
        } catch (e) {
          reject(e);
        }
      };

      const cleanup = () => {
        clearInterval(timer);
        signal?.removeEventListener?.('abort', onAbort);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (this._activeRequestId === requestId) this._activeRequestId = null;
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      const optsForWorker = { ...enriched };
      delete optsForWorker.signal;
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

      this.onProgress(15, 'dispatch');
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
    });
  }

  cancelActive() {
    if (this._activeRequestId == null || !this._worker) return;
    try {
      this._worker.postMessage({ type: 'cancel', requestId: this._activeRequestId });
    } catch { /* ignore */ }
  }

  dispose() {
    this.cancelActive();
    if (this._worker) {
      try { this._worker.terminate(); } catch { /* ignore */ }
      this._worker = null;
    }
  }
}

export default FullAnalysisHost;
