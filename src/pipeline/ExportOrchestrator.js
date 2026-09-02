/**
 * VoiceIsolate Pro — Export Orchestrator (Layer 3: Pipeline)
 *
 * Orchestrates audio export from PlaybackMixer stems to downloadable files.
 * Supports multiple export formats (WAV, MP3) and stem selection options.
 *
 * Architecture:
 * - Reads stems from PlaybackMixer (cleanBuffer, noiseBuffer)
 * - Applies per-speaker automation offline for accurate export
 * - Delegates encoding to AudioEncoderWorker (Layer 2)
 * - Returns Blob for download
 *
 * Export Options:
 * - Stem selection: 'clean', 'noise', 'both' (separate files)
 * - Format: 'wav', 'mp3'
 * - Per-speaker export: applies speaker automation offline
 * - Bitrate (MP3 only): 128, 192, 256, 320 kbps
 *
 * Output contract: { blob: Blob, filename: string, format: string }
 */
'use strict';

import { debugLog } from '../core/debug.js';

const WORKER_INIT_TIMEOUT_MS = 10000;
const ENCODE_TIMEOUT_MS = 120000;

/**
 * @typedef {object} ExportOptions
 * @property {'clean'|'noise'|'both'} [stems='clean'] - Which stems to export
 * @property {'wav'|'mp3'} [format='wav'] - Output format
 * @property {number} [bitrate=192] - MP3 bitrate in kbps (128, 192, 256, 320)
 * @property {string} [filename='export'] - Base filename (extension added automatically)
 * @property {boolean} [applySpeakerAutomation=false] - Apply per-speaker volume/mute offline
 * @property {(progress: number, stage: string) => void} [onProgress] - Progress callback
 */

/**
 * @typedef {object} ExportResult
 * @property {Blob} blob - Encoded audio blob
 * @property {string} filename - Suggested filename with extension
 * @property {string} format - Format used ('wav' or 'mp3')
 * @property {number} duration - Duration in seconds
 * @property {number} sampleRate - Sample rate
 * @property {number} channels - Number of channels
 */

export class ExportOrchestrator {
  /**
   * @param {import('./PlaybackMixer.js').PlaybackMixer} mixer - Source of stems
   */
  constructor(mixer) {
    if (!mixer) {
      throw new TypeError('[VIP][ExportOrchestrator] PlaybackMixer instance required.');
    }
    this.mixer = mixer;
    this._worker = null;
    this._workerReady = false;
    this._initPromise = null;
    this._pendingRequests = new Map();
    this._requestId = 0;
  }

  /**
   * Initialize the encoder worker. Called lazily on first export.
   * @private
   */
  async _initWorker() {
    if (this._workerReady) return;
    if (this._initPromise) return this._initPromise;

    const worker = new Worker('/src/workers/AudioEncoderWorker.js', { type: 'module' });
    this._worker = worker;

    this._initPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finishInit = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this._initPromise = null;
        callback();
      };
      const timeout = setTimeout(() => {
        const error = new Error('[VIP][ExportOrchestrator] Worker initialization timeout.');
        this._resetWorker(worker, error);
        finishInit(() => reject(error));
      }, WORKER_INIT_TIMEOUT_MS);

      worker.onmessage = (e) => {
        const { type, requestId, error, blob, format: resultFormat } = e.data;

        if (type === 'ready') {
          if (this._worker !== worker) return;
          this._workerReady = true;
          debugLog('ExportOrchestrator', 'Encoder worker ready.');
          finishInit(resolve);
          return;
        }

        if (type === 'error') {
          const pending = this._pendingRequests.get(requestId);
          if (pending) {
            this._pendingRequests.delete(requestId);
            clearTimeout(pending.timeout);
            pending.reject(new Error(error || 'Encoding failed.'));
          }
          return;
        }

        if (type === 'result') {
          const pending = this._pendingRequests.get(requestId);
          if (pending) {
            this._pendingRequests.delete(requestId);
            clearTimeout(pending.timeout);
            pending.resolve({ blob, format: resultFormat });
          }
          return;
        }

        if (type === 'progress') {
          const pending = this._pendingRequests.get(requestId);
          if (pending && pending.onProgress) {
            pending.onProgress(e.data.progress, e.data.stage);
          }
        }
      };

      worker.onerror = (err) => {
        const error = new Error(`[VIP][ExportOrchestrator] Worker error: ${err.message || 'unknown error'}`);
        this._resetWorker(worker, error);
        finishInit(() => reject(error));
      };
    });
    return this._initPromise;
  }

  _resetWorker(worker, error) {
    if (worker && this._worker === worker) {
      try { worker.terminate(); } catch { /* worker already stopped */ }
      this._worker = null;
      this._workerReady = false;
    }
    for (const pending of this._pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this._pendingRequests.clear();
  }

  /**
   * Export audio from the mixer's loaded stems.
   * @param {ExportOptions} [options={}]
   * @returns {Promise<ExportResult|ExportResult[]>}
   */
  async export(options = {}) {
    const {
      stems = 'clean',
      format = 'wav',
      bitrate = 192,
      filename = 'export',
      applySpeakerAutomation = false,
      onProgress = () => {},
    } = options;

    // Validate stems are loaded
    if (!this.mixer.cleanBuffer || !this.mixer.noiseBuffer) {
      throw new Error('[VIP][ExportOrchestrator] No stems loaded in mixer.');
    }

    // Validate options
    if (!['clean', 'noise', 'both'].includes(stems)) {
      throw new TypeError('[VIP][ExportOrchestrator] Invalid stems option. Use "clean", "noise", or "both".');
    }
    if (!['wav', 'mp3'].includes(format)) {
      throw new TypeError('[VIP][ExportOrchestrator] Invalid format. Use "wav" or "mp3".');
    }
    if (![128, 192, 256, 320].includes(bitrate)) {
      throw new TypeError('[VIP][ExportOrchestrator] Invalid bitrate. Use 128, 192, 256, or 320.');
    }

    // Initialize worker if needed
    await this._initWorker();

    onProgress(0, 'preparing');

    // Export based on stem selection
    if (stems === 'both') {
      const [cleanResult, noiseResult] = await Promise.all([
        this._exportStem('clean', format, bitrate, `${filename}-clean`, applySpeakerAutomation, (p, s) => onProgress(p * 0.5, s)),
        this._exportStem('noise', format, bitrate, `${filename}-noise`, false, (p, s) => onProgress(0.5 + p * 0.5, s)),
      ]);
      return [cleanResult, noiseResult];
    } else {
      return this._exportStem(stems, format, bitrate, filename, applySpeakerAutomation, onProgress);
    }
  }

  /**
   * Export a single stem.
   * @private
   * @param {'clean'|'noise'} stem
   * @param {'wav'|'mp3'} format
   * @param {number} bitrate
   * @param {string} filename
   * @param {boolean} applySpeakerAutomation
   * @param {(progress: number, stage: string) => void} onProgress
   * @returns {Promise<ExportResult>}
   */
  async _exportStem(stem, format, bitrate, filename, applySpeakerAutomation, onProgress) {
    onProgress(0.1, 'reading');

    // Get the source buffer
    const sourceBuffer = stem === 'clean' ? this.mixer.cleanBuffer : this.mixer.noiseBuffer;
    
    // Extract channel data
    let channels = this._extractChannels(sourceBuffer);
    const sampleRate = sourceBuffer.sampleRate;
    const duration = sourceBuffer.duration;

    // Apply speaker automation if requested (clean stem only)
    if (applySpeakerAutomation && stem === 'clean') {
      onProgress(0.2, 'applying-automation');
      channels = this._applySpeakerAutomationOffline(channels, sampleRate);
    }

    onProgress(0.3, 'encoding');

    // Send to worker for encoding
    const requestId = this._requestId++;
    const { blob, format: resultFormat } = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this._pendingRequests.delete(requestId)) return;
        reject(new Error('[VIP][ExportOrchestrator] Encoding timeout.'));
      }, ENCODE_TIMEOUT_MS);
      this._pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        onProgress: (p, s) => onProgress(0.3 + p * 0.7, s),
      });
      
      // Transfer channel data to worker (zero-copy)
      const transferList = channels.map(ch => ch.buffer);
      this._worker.postMessage({
        type: 'encode',
        requestId,
        channels,
        sampleRate,
        format,
        bitrate,
      }, transferList);
    });

    onProgress(1, 'complete');

    const extension = resultFormat === 'mp3' ? 'mp3' : 'wav';
    return {
      blob,
      filename: `${filename}.${extension}`,
      format: resultFormat,
      duration,
      sampleRate,
      channels: channels.length,
    };
  }

  /**
   * Extract channel data from an AudioBuffer as Float32Arrays.
   * @private
   * @param {AudioBuffer} buffer
   * @returns {Float32Array[]}
   */
  _extractChannels(buffer) {
    const channels = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      // Copy data (getChannelData returns a view we can't transfer)
      channels.push(new Float32Array(buffer.getChannelData(ch)));
    }
    return channels;
  }

  /**
   * Apply per-speaker volume/mute automation offline.
   * Renders the speaker automation lane's gain schedule into the audio data.
   * @private
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @returns {Float32Array[]}
   */
  _applySpeakerAutomationOffline(channels, sampleRate) {
    const segments = this.mixer.getSpeakerSegments();
    if (segments.length === 0) {
      return channels; // No automation to apply
    }

    const length = channels[0].length;
    const output = channels.map(ch => new Float32Array(ch)); // Copy channels

    // Build a gain envelope from the speaker segments
    const gainEnvelope = new Float32Array(length);
    gainEnvelope.fill(1); // Default to unity gain

    for (const seg of segments) {
      const startSample = Math.floor(seg.start * sampleRate);
      const endSample = Math.floor(seg.end * sampleRate);
      const speakerState = this.mixer.getSpeakerState(seg.speakerId);
      
      if (!speakerState) continue;

      // Calculate effective gain (respects mute and solo)
      let gain = speakerState.volume / 100; // Convert percentage to linear
      if (speakerState.muted) gain = 0;
      
      const soloSpeaker = this.mixer.getSoloSpeaker();
      if (soloSpeaker && soloSpeaker !== seg.speakerId) {
        gain = 0; // Mute non-solo speakers
      }

      // Apply gain to envelope
      for (let i = Math.max(0, startSample); i < Math.min(length, endSample); i++) {
        gainEnvelope[i] = gain;
      }
    }

    // Apply envelope to all channels
    for (let ch = 0; ch < output.length; ch++) {
      for (let i = 0; i < length; i++) {
        output[ch][i] *= gainEnvelope[i];
      }
    }

    return output;
  }

  /**
   * Terminate the encoder worker and clean up resources.
   */
  dispose() {
    const error = new Error('[VIP][ExportOrchestrator] Disposed during export.');
    this._resetWorker(this._worker, error);
    this._initPromise = null;
  }
}

export default ExportOrchestrator;

// Made with Bob
