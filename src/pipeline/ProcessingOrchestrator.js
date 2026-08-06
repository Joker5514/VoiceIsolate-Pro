/**
 * VoiceIsolate Pro — Processing Orchestrator (Layer 3: Pipeline)
 *
 * Orchestrates file ingestion + MLWorker model chaining for isolation modes.
 */
'use strict';

import { ingestFile } from './FileIngestion.js';
import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { debugLog } from '../core/debug.js';

const MANIFEST_ARRAY = Object.values(MODEL_MANIFEST);

export class ProcessingOrchestrator {
  constructor(options) {
    if (!options.mlWorker) {
      throw new TypeError('[VIP][ProcessingOrchestrator] mlWorker is required');
    }
    this.mlWorker = options.mlWorker;
    this.onProgress = options.onProgress || (() => {});
    this._initialized = false;
    this._requestSeq = 0;
  }

  async initialize() {
    if (this._initialized) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mlWorker.removeEventListener('message', handler);
        reject(new Error('[VIP][ProcessingOrchestrator] MLWorker initialization timeout'));
      }, 30000);

      const handler = (event) => {
        const msg = event.data || {};
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          this._initialized = true;
          debugLog('ProcessingOrchestrator', `MLWorker ready (${msg.backend})`);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          reject(new Error(msg.message || 'MLWorker init error'));
        }
      };

      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.postMessage({ type: 'init', manifest: MANIFEST_ARRAY });
    });
  }

  async processFile(file, options = {}) {
    if (!this._initialized) await this.initialize();

    const { isolationMode = 'standard', prompt, samMode } = options;

    this.onProgress(0, 'ingesting');
    const ingested = await ingestFile(file, { isolationMode });

    this.onProgress(0.2, 'processing');

    const channelData = ingested.channelData.map((c) => new Float32Array(c));

    // Prompted / SAM-class isolation — Creator path via provider selector
    // (Desktop local worker for real SAM; Android/Web ONNX or USM fallback).
    if (isolationMode === 'prompted') {
      const { runPromptedIsolation } = await import('./PromptedIsolation.js');
      const isDesktop = typeof globalThis !== 'undefined'
        && globalThis.vipDesktop
        && typeof globalThis.vipDesktop.samWorkerStart === 'function';
      const isAndroid = typeof navigator !== 'undefined'
        && /Android/i.test(navigator.userAgent || '');

      // Desktop: ensure local SAM worker is up so real Meta SAM can load.
      if (isDesktop) {
        try {
          await globalThis.vipDesktop.samWorkerStart({});
        } catch { /* worker optional if already running */ }
      }

      this.onProgress(0.35, 'prompted-isolation');
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
      });

      const target = pr.target instanceof Float32Array
        ? pr.target
        : (Array.isArray(pr.target) ? pr.target[0] : channelData[0]);
      const residual = pr.residual instanceof Float32Array
        ? pr.residual
        : (Array.isArray(pr.residual) ? pr.residual[0] : new Float32Array(target.length));

      this.onProgress(1, 'complete');
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
        },
      };
    }

    const requestId = ++this._requestSeq;
    const result = await this._processWithMLWorker(
      channelData,
      ingested.sampleRate,
      ingested.modelIds,
      requestId,
    );

    if (result.passthrough) {
      throw new Error('ML isolation failed — models unavailable or inference error.');
    }

    this.onProgress(1, 'complete');

    const mono = this._mixToMono(result.clean);
    const noiseMono = this._mixToMono(result.noise);

    return {
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
      },
    };
  }

  _processWithMLWorker(channelData, sampleRate, modelIds, requestId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.mlWorker.removeEventListener('message', handler);
        reject(new Error('[VIP][ProcessingOrchestrator] MLWorker processing timeout'));
      }, 600000);

      const handler = (event) => {
        const msg = event.data || {};
        if (msg.requestId !== requestId) return;

        if (msg.type === 'progress') {
          this.onProgress(0.2 + (msg.percent / 100) * 0.8, 'processing');
        } else if (msg.type === 'stems') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          resolve({
            clean: msg.clean,
            noise: msg.noise,
            passthrough: Boolean(msg.passthrough),
          });
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          reject(new Error(msg.message || 'MLWorker error'));
        }
      };

      this.mlWorker.addEventListener('message', handler);
      const transfers = channelData.map((c) => c.buffer);
      this.mlWorker.postMessage({
        type: 'process',
        requestId,
        modelIds,
        channelData,
        sampleRate,
      }, transfers);
    });
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

  dispose() {
    this._initialized = false;
  }
}

export default ProcessingOrchestrator;