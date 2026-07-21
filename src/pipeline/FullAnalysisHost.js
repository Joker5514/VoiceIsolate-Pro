/**
 * VoiceIsolate Pro — Full Analysis Host (Layer 3: Pipeline)
 *
 * Spawns FullAnalysisWorker, falls back to main-thread analyzeAudio if
 * workers are unavailable.
 */
'use strict';

import { analyzeAudio } from '../core/FullAnalysis.js';
import { extractFrameFeatures, downmixToMono } from '../core/FeatureExtractor.js';
import { buildVadHints } from './VadAnalysis.js';
import { debugLog } from '../core/debug.js';

export class FullAnalysisHost {
  constructor(options = {}) {
    this.onProgress = options.onProgress || (() => {});
    this._worker = null;
    this._requestId = 0;
    this._useWorker = options.useWorker !== false && typeof Worker !== 'undefined';
    this._enableMlVad = options.enableMlVad !== false;
  }

  _ensureWorker() {
    if (!this._useWorker) return null;
    if (this._worker) return this._worker;
    try {
      // Module worker — path resolved from page origin
      const url = new URL('/src/workers/FullAnalysisWorker.js', globalThis.location?.href || 'http://localhost/');
      this._worker = new Worker(url.href, { type: 'module' });
      return this._worker;
    } catch (err) {
      debugLog('FullAnalysisHost', `Worker unavailable: ${err.message}`);
      this._useWorker = false;
      return null;
    }
  }

  /**
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {object} [opts]
   * @returns {Promise<object>} analysis
   */
  /**
   * Enrich opts with Silero/classical soft-VAD hints before analyzeAudio.
   */
  async _withVadHints(channels, sampleRate, opts = {}) {
    if (opts.mlHints?.vadScores || opts.skipVad) return opts;
    try {
      this.onProgress(8, 'vad');
      const mono = downmixToMono(channels);
      const extraction = extractFrameFeatures(mono, sampleRate, {
        frameSec: opts.frameSec,
        hopSec: opts.hopSec,
      });
      if (this._enableMlVad) {
        const hints = await buildVadHints(mono, sampleRate, extraction);
        return {
          ...opts,
          mlHints: {
            ...(opts.mlHints || {}),
            ...hints,
          },
        };
      }
    } catch (err) {
      debugLog('FullAnalysisHost', `VAD hints skipped: ${err.message || err}`);
    }
    return opts;
  }

  async analyze(channels, sampleRate, opts = {}) {
    const enriched = await this._withVadHints(channels, sampleRate, opts);
    const worker = this._ensureWorker();
    if (!worker) {
      this.onProgress(20, 'features');
      const analysis = analyzeAudio(channels, sampleRate, enriched);
      this.onProgress(100, 'complete');
      return analysis;
    }

    const requestId = ++this._requestId;
    return new Promise((resolve, reject) => {
      const timeoutMs = enriched.timeoutMs ?? 180000;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Full analysis timed out'));
      }, timeoutMs);

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.requestId !== requestId) return;
        if (msg.type === 'progress') {
          this.onProgress(msg.percent || 0, msg.stage || 'analysis');
        } else if (msg.type === 'result') {
          cleanup();
          resolve(msg.analysis);
        } else if (msg.type === 'error') {
          cleanup();
          reject(new Error(msg.message || 'Analysis failed'));
        }
      };

      const onError = (err) => {
        cleanup();
        // Fallback to main thread
        debugLog('FullAnalysisHost', `Worker error, falling back: ${err.message || err}`);
        try {
          const analysis = analyzeAudio(channels, sampleRate, enriched);
          resolve(analysis);
        } catch (e) {
          reject(e);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);

      // Serialize mlHints (typed arrays → plain) for worker postMessage clone
      const optsForWorker = { ...enriched };
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

      // Copy channels for transfer if possible
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

  dispose() {
    if (this._worker) {
      try { this._worker.terminate(); } catch { /* ignore */ }
      this._worker = null;
    }
  }
}

export default FullAnalysisHost;
