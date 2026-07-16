/**
 * VoiceIsolate Pro — Research Session Logger (Layer 1: Core)
 *
 * Captures reproducible experiment metadata: models, FFT/hop, params,
 * stage timings, provider. Pure module; export is JSON Blob for download.
 *
 * Constraints:
 *  - Never sends data over the network.
 *  - No audio bytes stored unless caller explicitly attaches references.
 */
'use strict';

import { snapshotParams } from './ParameterSchema.js';
import { getOrtStatus } from './OrtStatus.js';
import {
  QUANTUM,
  FFT_SIZE_LIVE,
  FFT_SIZE_CREATOR,
  HOP_SIZE,
  MASK_FLOOR_DB,
} from './ring-buffer-constants.js';

let _seq = 0;

/**
 * @typedef {object} ResearchStageEvent
 * @property {string} stage
 * @property {number} t
 * @property {number} [ms]
 * @property {Record<string, unknown>} [meta]
 */

/**
 * @typedef {object} ResearchSessionConfig
 * @property {string} [sourceName]
 * @property {string[]} [modelIds]
 * @property {string} [preset]
 * @property {string} [mode] live|creator|forensic
 * @property {number} [fftSize]
 * @property {number} [hopSize]
 * @property {number} [sampleRate]
 * @property {Record<string, number>} [params]
 * @property {boolean} [deterministic]
 */

export class ResearchSession {
  /**
   * @param {ResearchSessionConfig} [config]
   */
  constructor(config = {}) {
    this.id = `vip-rs-${Date.now().toString(36)}-${(++_seq).toString(36)}`;
    this.startedAt = new Date().toISOString();
    this.endedAt = null;
    this.config = {
      sourceName: config.sourceName || '',
      modelIds: Array.isArray(config.modelIds) ? [...config.modelIds] : [],
      preset: config.preset || null,
      mode: config.mode || 'creator',
      fftSize: config.fftSize || FFT_SIZE_CREATOR,
      hopSize: config.hopSize || HOP_SIZE,
      sampleRate: config.sampleRate || 48000,
      params: snapshotParams(config.params || {}),
      deterministic: Boolean(config.deterministic),
      quantum: QUANTUM,
      maskFloorDb: MASK_FLOOR_DB,
      fftSizeLive: FFT_SIZE_LIVE,
      singlePassSpectral: true,
      architecture: 'stem-split-live-mix',
      architectureDoc: 'docs/VoiceIsolate_Pro_Architecture_v26.md',
    };
    /** @type {ResearchStageEvent[]} */
    this.stages = [];
    /** @type {object[]} */
    this.notes = [];
    this._t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.metrics = {
      decodeMs: null,
      mlMs: null,
      dspMs: null,
      totalMs: null,
      provider: getOrtStatus().provider,
    };
  }

  /**
   * @param {string} stage
   * @param {Record<string, unknown>} [meta]
   */
  mark(stage, meta = {}) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const last = this.stages[this.stages.length - 1];
    const ms = last ? now - (this._t0 + last.t) : now - this._t0;
    // Store relative time from session start
    this.stages.push({
      stage: String(stage),
      t: now - this._t0,
      ms: Math.max(0, ms),
      meta: { ...meta },
    });
    return this;
  }

  /**
   * @param {Partial<typeof this.metrics>} patch
   */
  setMetrics(patch = {}) {
    Object.assign(this.metrics, patch);
    this.metrics.provider = getOrtStatus().provider;
    return this;
  }

  /**
   * @param {Record<string, number>} params
   */
  updateParams(params) {
    this.config.params = snapshotParams(params || {});
    return this;
  }

  /**
   * @param {string} text
   */
  note(text) {
    this.notes.push({ t: Date.now(), text: String(text) });
    return this;
  }

  finish() {
    this.endedAt = new Date().toISOString();
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.metrics.totalMs = now - this._t0;
    this.metrics.provider = getOrtStatus().provider;
    return this;
  }

  /**
   * @returns {object}
   */
  toJSON() {
    if (!this.endedAt) this.finish();
    return {
      schemaVersion: 1,
      id: this.id,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      config: this.config,
      stages: this.stages,
      metrics: this.metrics,
      notes: this.notes,
      ort: getOrtStatus(),
      reproducibility: {
        singlePassStft: true,
        localOnly: true,
        noCloudInference: true,
        seedPolicy: this.config.deterministic
          ? 'deterministic-flags-on (no DSP RNG)'
          : 'best-effort floating-point',
      },
    };
  }

  /**
   * @returns {Blob}
   */
  toBlob() {
    const json = JSON.stringify(this.toJSON(), null, 2);
    return new Blob([json], { type: 'application/json' });
  }

  /**
   * Trigger a browser download of the session JSON.
   * @param {string} [filename]
   */
  download(filename) {
    const blob = this.toBlob();
    const name = filename || `${this.id}.json`;
    if (typeof document === 'undefined') return blob;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return blob;
  }
}

/** @type {ResearchSession|null} */
let _active = null;

/**
 * @param {ResearchSessionConfig} [config]
 * @returns {ResearchSession}
 */
export function beginResearchSession(config) {
  _active = new ResearchSession(config);
  if (typeof globalThis !== 'undefined') globalThis.__vipResearchSession = _active;
  return _active;
}

/** @returns {ResearchSession|null} */
export function getActiveResearchSession() {
  return _active;
}

/** @returns {ResearchSession|null} */
export function endResearchSession() {
  if (_active) _active.finish();
  return _active;
}

export default {
  ResearchSession,
  beginResearchSession,
  getActiveResearchSession,
  endResearchSession,
};
