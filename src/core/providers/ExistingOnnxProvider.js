/**
 * Existing local ONNX isolation (BSRNN / RNNoise / classical USM).
 * Does not perform SAM-Audio. Safe default for all platforms.
 */
'use strict';

import { AudioIsolationProvider } from './AudioIsolationProvider.js';

export class ExistingOnnxProvider extends AudioIsolationProvider {
  /**
   * @param {object} [opts]
   * @param {(req: object) => Promise<object>} [opts.separateFn] injectable stem separator
   * @param {(pcm: Float32Array, sr: number, cfg: object) => object} [opts.usmFn] injectable USM
   */
  constructor(opts = {}) {
    super();
    this._separateFn = opts.separateFn || null;
    this._usmFn = opts.usmFn || null;
  }

  get id() {
    return 'onnx-local';
  }

  async getCapabilities() {
    return {
      available: true,
      mode: 'onnx-local',
      backends: ['bsrnn', 'rnnoise', 'usm-query'],
      live: false,
      offline: true,
      browserSam: false,
      localWorker: false,
      reasons: [],
    };
  }

  /**
   * Text/span “prompted” path uses USM query priors when usmFn is supplied;
   * otherwise returns a structured unavailable error for SAM-only expectations.
   * @param {import('./AudioIsolationProvider.js').IsolationRequest} request
   */
  async isolate(request) {
    const processingMode = request.processingMode || 'creator';
    if (processingMode === 'live') {
      throw new Error('[VIP][onnx-local] SAM/prompted isolation is not available in live mode');
    }

    const mono = toMono(request.audio);
    const sr = request.sampleRate || 48000;
    const prompt = String(request.prompt || 'speech').trim() || 'speech';

    if (typeof this._usmFn === 'function') {
      const result = this._usmFn(mono, sr, {
        mode: 'query',
        queries: [prompt],
        fftSize: 4096,
        hopSize: 1024,
      });
      const targetSrc = result.sources?.find((s) => !/residual/i.test(s.label)) || result.sources?.[0];
      const residualSrc = result.sources?.find((s) => /residual/i.test(s.label));
      const outMode = request.output || 'both';
      /** @type {import('./AudioIsolationProvider.js').IsolationResult} */
      const out = {
        sampleRate: sr,
        provider: this.id,
        meta: { method: result.method || 'usm-query', prompt },
      };
      if (outMode === 'target' || outMode === 'both') out.target = targetSrc?.pcm || mono;
      if (outMode === 'residual' || outMode === 'both') {
        out.residual = residualSrc?.pcm || new Float32Array(mono.length);
      }
      return out;
    }

    if (typeof this._separateFn === 'function') {
      const stems = await this._separateFn({
        channelData: [mono],
        sampleRate: sr,
        modelIds: ['bsrnn_vocals'],
      });
      return {
        target: stems.clean?.[0] || mono,
        residual: stems.noise?.[0] || new Float32Array(mono.length),
        sampleRate: sr,
        provider: this.id,
        meta: { method: 'onnx-stems' },
      };
    }

    // Transparent fallback — never invent cloud calls.
    return {
      target: new Float32Array(mono),
      residual: new Float32Array(mono.length),
      sampleRate: sr,
      provider: this.id,
      meta: { method: 'passthrough', warning: 'no-usm-or-stem-fn' },
    };
  }
}

function toMono(audio) {
  if (audio instanceof Float32Array) return audio;
  if (Array.isArray(audio) && audio[0] instanceof Float32Array) {
    if (audio.length === 1) return audio[0];
    const n = audio[0].length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < audio.length; c++) s += audio[c][i] || 0;
      out[i] = s / audio.length;
    }
    return out;
  }
  throw new TypeError('[VIP][onnx-local] audio must be Float32Array or Float32Array[]');
}

export default ExistingOnnxProvider;
