/**
 * Shared audio isolation provider contract (web / Android WebView / Electron).
 * All SAM and ONNX backends implement this surface.
 *
 * @typedef {'text'|'span'|'visual'} PromptMode
 * @typedef {'target'|'residual'|'both'} OutputMode
 * @typedef {'live'|'creator'|'forensic'|'batch'} ProcessingMode
 *
 * @typedef {object} IsolationRequest
 * @property {Float32Array|Float32Array[]} audio
 * @property {number} sampleRate
 * @property {number} [channels]
 * @property {string} [prompt]
 * @property {PromptMode} [mode]
 * @property {Array<{start:number,end:number}>} [anchors]
 * @property {boolean} [predictSpans]
 * @property {number} [rerankingCandidates]
 * @property {OutputMode} [output]
 * @property {boolean} [preserveResidual]
 * @property {ProcessingMode} [processingMode]
 *
 * @typedef {object} IsolationResult
 * @property {Float32Array|Float32Array[]} [target]
 * @property {Float32Array|Float32Array[]} [residual]
 * @property {number} sampleRate
 * @property {string} provider
 * @property {string} [jobId]
 * @property {object} [meta]
 */
'use strict';

/**
 * Base class — not constructible for production use without subclass.
 */
export class AudioIsolationProvider {
  /** @returns {string} */
  get id() {
    return 'base';
  }

  async initialize() {
    return { ok: true };
  }

  /**
   * @returns {Promise<{
   *   available: boolean,
   *   mode: string,
   *   backends: string[],
   *   live: boolean,
   *   offline: boolean,
   *   browserSam: boolean,
   *   localWorker: boolean,
   *   reasons?: string[]
   * }>}
   */
  async getCapabilities() {
    return {
      available: false,
      mode: 'disabled',
      backends: [],
      live: false,
      offline: false,
      browserSam: false,
      localWorker: false,
      reasons: ['not-implemented'],
    };
  }

  /**
   * @param {IsolationRequest} _request
   * @returns {Promise<IsolationResult>}
   */
  async isolate(_request) {
    throw new Error(`[VIP][provider:${this.id}] isolate() not implemented`);
  }

  /**
   * @param {string} _jobId
   * @returns {Promise<{ ok: boolean }>}
   */
  async cancel(_jobId) {
    return { ok: false };
  }

  async dispose() {
    return { ok: true };
  }
}

export default AudioIsolationProvider;
