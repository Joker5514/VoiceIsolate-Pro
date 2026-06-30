/**
 * VoiceIsolate Pro — Processing Orchestrator (Layer 3: Pipeline)
 *
 * Orchestrates the complete file processing workflow with model chaining support.
 * Bridges the UI layer (IsolationModeSelector) with the pipeline layer (FileIngestion, MLWorker).
 *
 * Workflow:
 * 1. User selects isolation mode via IsolationModeSelector
 * 2. User uploads file
 * 3. FileIngestion decodes and resamples
 * 4. MLWorker processes with model chain based on mode
 * 5. Results returned as stems for PlaybackMixer
 *
 * This is the integration point that makes model chaining accessible to users.
 */
'use strict';

import { ingestFile } from './FileIngestion.js';
import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { debugLog } from '../core/debug.js';

/**
 * ProcessingOrchestrator - Coordinates file ingestion and ML processing with mode selection.
 */
export class ProcessingOrchestrator {
  /**
   * @param {object} options
   * @param {Worker} options.mlWorker - MLWorker instance
   * @param {(progress: number, stage: string) => void} [options.onProgress] - Progress callback
   */
  constructor(options) {
    if (!options.mlWorker) {
      throw new TypeError('[VIP][ProcessingOrchestrator] mlWorker is required');
    }
    
    this.mlWorker = options.mlWorker;
    this.onProgress = options.onProgress || (() => {});
    this._initialized = false;
  }

  /**
   * Initialize MLWorker with model manifest.
   * Must be called before processing.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[VIP][ProcessingOrchestrator] MLWorker initialization timeout'));
      }, 10000);

      const handler = (event) => {
        if (event.data.type === 'initialized') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          this._initialized = true;
          debugLog('ProcessingOrchestrator', 'MLWorker initialized');
          resolve();
        } else if (event.data.type === 'error') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          reject(new Error(`MLWorker init error: ${event.data.error}`));
        }
      };

      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.postMessage({
        type: 'init',
        models: MODEL_MANIFEST,
      });
    });
  }

  /**
   * Process a file with the specified isolation mode.
   * 
   * @param {File|Blob} file - Audio/video file to process
   * @param {object} [options]
   * @param {string} [options.isolationMode] - Isolation mode ('standard', 'maximum', 'noise-suppression')
   * @returns {Promise<ProcessingResult>}
   * 
   * @typedef {object} ProcessingResult
   * @property {Float32Array} cleanStem - Isolated voice/clean audio
   * @property {Float32Array} noiseStem - Background/noise audio
   * @property {object} metadata - Processing metadata
   */
  async processFile(file, options = {}) {
    if (!this._initialized) {
      await this.initialize();
    }

    const { isolationMode = 'standard' } = options;

    // Stage 1: Ingest file (decode + resample)
    this.onProgress(0, 'ingesting');
    const ingested = await ingestFile(file, {
      isolationMode,
      onProgress: (stage) => {
        debugLog('ProcessingOrchestrator', `Ingestion stage: ${stage}`);
      },
    });

    debugLog(
      'ProcessingOrchestrator',
      `Ingested ${ingested.sourceName}: ${ingested.duration.toFixed(2)}s, ` +
      `${ingested.numberOfChannels}ch, mode: ${ingested.isolationMode}, ` +
      `models: [${ingested.modelIds.join(', ')}]`
    );

    // Stage 2: Process with MLWorker using model chain
    this.onProgress(0.2, 'processing');
    
    // For now, we'll process with the first model in the chain
    // Full model chaining will be implemented when MLWorker supports it
    const modelId = ingested.modelIds[0];
    
    // Convert stereo to mono for processing (mix down)
    const monoData = this._mixToMono(ingested.channelData);

    const result = await this._processWithMLWorker(monoData, ingested.sampleRate, modelId);

    this.onProgress(1, 'complete');

    return {
      cleanStem: result.audioData,
      noiseStem: this._computeNoiseStem(monoData, result.audioData),
      metadata: {
        ...result.metadata,
        isolationMode: ingested.isolationMode,
        modelIds: ingested.modelIds,
        sourceName: ingested.sourceName,
        duration: ingested.duration,
      },
    };
  }

  /**
   * Process audio with MLWorker.
   * @private
   * @param {Float32Array} audioData
   * @param {number} sampleRate
   * @param {string} modelId
   * @returns {Promise<{audioData: Float32Array, metadata: object}>}
   */
  _processWithMLWorker(audioData, sampleRate, modelId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[VIP][ProcessingOrchestrator] MLWorker processing timeout'));
      }, 300000); // 5 minutes

      const handler = (event) => {
        const { type } = event.data;

        if (type === 'progress') {
          const { stage, progress } = event.data;
          this.onProgress(0.2 + progress * 0.8, stage);
        } else if (type === 'result') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          resolve({
            audioData: event.data.audioData,
            metadata: event.data.metadata,
          });
        } else if (type === 'error') {
          clearTimeout(timeout);
          this.mlWorker.removeEventListener('message', handler);
          reject(new Error(`MLWorker error: ${event.data.error}`));
        }
      };

      this.mlWorker.addEventListener('message', handler);
      this.mlWorker.postMessage({
        type: 'process',
        audioData,
        sampleRate,
        modelId,
      }, [audioData.buffer]); // Transfer ownership
    });
  }

  /**
   * Mix stereo channels to mono.
   * @private
   * @param {Float32Array[]} channelData
   * @returns {Float32Array}
   */
  _mixToMono(channelData) {
    if (channelData.length === 1) {
      return new Float32Array(channelData[0]);
    }

    const length = channelData[0].length;
    const mono = new Float32Array(length);
    
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let ch = 0; ch < channelData.length; ch++) {
        sum += channelData[ch][i];
      }
      mono[i] = sum / channelData.length;
    }
    
    return mono;
  }

  /**
   * Compute noise stem as residual (input - clean).
   * @private
   * @param {Float32Array} input
   * @param {Float32Array} clean
   * @returns {Float32Array}
   */
  _computeNoiseStem(input, clean) {
    const noise = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      noise[i] = input[i] - clean[i];
    }
    return noise;
  }

  /**
   * Clean up resources.
   */
  dispose() {
    // MLWorker is owned by caller, don't terminate it
    this._initialized = false;
  }
}

export default ProcessingOrchestrator;

// Made with Bob
