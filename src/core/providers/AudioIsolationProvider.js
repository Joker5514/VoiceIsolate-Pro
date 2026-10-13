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
 * Prompt modes a provider actually honours. Span and visual targeting are in
 * the request type for SAM-Audio, but no shipped backend implements them, so
 * a request for one is refused instead of silently running a text prompt.
 */
export const SUPPORTED_PROMPT_MODES = Object.freeze(['text']);

/**
 * @param {IsolationRequest} request
 * @param {string} providerId
 * @throws {Error & { code: 'UNSUPPORTED_TARGETING' }}
 */
export function assertSupportedTargeting(request, providerId) {
  const mode = request?.mode ?? 'text';
  const anchors = request?.anchors;
  let why = null;
  if (!SUPPORTED_PROMPT_MODES.includes(mode)) why = `prompt mode "${mode}" is not supported`;
  else if (Array.isArray(anchors) && anchors.length) why = 'span anchors are not supported';
  if (why) {
    throw Object.assign(new Error(`[VIP][provider:${providerId}] ${why}; only text prompts are implemented.`), {
      name: 'UnsupportedTargetingError',
      code: 'UNSUPPORTED_TARGETING',
    });
  }
}

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
