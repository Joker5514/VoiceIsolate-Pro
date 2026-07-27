/**
 * VoiceIsolate Pro — Universal Source Matrix Node (Layer 3: Pipeline)
 *
 * Upgrades the offline ML separation slot for Creator / Forensic modes:
 *   mixture PCM → K soft-masked stems + labels → Source Matrix Live-Mix.
 *
 * Does NOT re-run on slider / mute / solo changes (Live-Mix contract).
 * Text "Refine" intentionally re-runs query separation once.
 *
 * Prefer classical core USM always available; optionally ask MLWorker for an
 * ONNX AudioSep-class model when `universal_separator` is in the manifest
 * and the weights are present.
 */
'use strict';

import {
  separateUniversal,
  mixSources,
  dbToGain,
  USM_DEFAULT_SOURCES,
  USM_MAX_SOURCES,
} from '../core/UniversalSourceMatrix.js';
import { SAMPLE_RATE } from '../core/audio-config.js';
import { createMLWorker, initMLWorker } from './MLWorkerHost.js';

/**
 * @typedef {{ id: string, label: string, gainDb: number, mute: boolean, solo: boolean, pcm: Float32Array, confidence?: number, quality?: string, method?: string }} USMSourceState
 */

let _worker = null;
let _ready = null;
let _seq = 0;

function getWorker() {
  if (_worker) return _worker;
  _worker = createMLWorker();
  return _worker;
}

function ensureWorkerReady() {
  if (_ready) return _ready;
  const w = getWorker();
  _ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('[VIP][USMNode] MLWorker init timeout'));
    }, 30000);
    const onMsg = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        cleanup();
        resolve(msg.backend || 'wasm');
      } else if (msg.type === 'error' && !msg.requestId) {
        cleanup();
        reject(new Error(msg.message || 'MLWorker init failed'));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(new Error(e.message || 'MLWorker error'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    initMLWorker(w);
  });
  return _ready;
}

/**
 * Try ONNX universal separator via MLWorker; return null if unavailable.
 * @returns {Promise<import('../core/UniversalSourceMatrix.js').USMResult|null>}
 */
async function tryOnnxUniversal(samples, sampleRate, config) {
  try {
    await ensureWorkerReady();
  } catch {
    return null;
  }
  const w = getWorker();
  const requestId = ++_seq;
  const copy = new Float32Array(samples);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 120000);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'universal_separate_result') {
        cleanup();
        resolve({
          sources: (m.sources || []).map((s, i) => ({
            id: s.id || `usm_${i + 1}`,
            label: s.label || `Source ${i + 1}`,
            mask: s.mask,
            pcm: s.pcm,
            confidence: s.confidence ?? 0.7,
            quality: s.quality || 'high',
            method: 'onnx-universal',
          })),
          shape: m.shape || { frames: 0, bins: 0 },
          method: 'onnx-universal',
          stft: null,
        });
      } else if (m.type === 'error') {
        cleanup();
        resolve(null);
      }
    };
    const onErr = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({
      type: 'universal_separate',
      requestId,
      waveform: copy,
      sampleRate,
      mode: config.mode || 'auto',
      numSources: config.numSources || USM_DEFAULT_SOURCES,
      queries: config.queries || [],
    }, [copy.buffer]);
  });
}

/**
 * Downmix multi-channel to mono Float32Array (copy).
 * @param {Float32Array[]} channels
 */
export function downmixChannels(channels) {
  if (!channels?.length) return new Float32Array(0);
  if (channels.length === 1) {
    return channels[0] instanceof Float32Array
      ? new Float32Array(channels[0])
      : new Float32Array(channels[0]);
  }
  const len = channels[0].length;
  const out = new Float32Array(len);
  const n = channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i];
    out[i] = s / n;
  }
  return out;
}

/**
 * USMNode — drop-in offline separation stage.
 */
export class USMNode {
  /**
   * @param {object} [options]
   * @param {boolean} [options.preferOnnx=true]
   * @param {(p: number, label?: string) => void} [options.onProgress]
   */
  constructor(options = {}) {
    this.id = 'usm';
    this.name = 'Universal Source Matrix';
    this.enabled = true;
    this.requiresML = true;
    this.requiresGPU = false;
    // ONNX path is opt-in until universal-separator.onnx is shipped + pinned.
    this.preferOnnx = options.preferOnnx === true;
    this.onProgress = options.onProgress || (() => {});
    /** @type {USMSourceState[]} */
    this.sources = [];
    this._lastResult = null;
    this._sampleRate = SAMPLE_RATE;
    /** @type {Float32Array|null} mixture mono retained for refine() */
    this._mixtureMono = null;
  }

  /**
   * @param {USMConfig} config
   */
  configure(config = {}) {
    this._config = {
      mode: config.mode === 'query' ? 'query' : 'auto',
      numSources: Math.max(2, Math.min(USM_MAX_SOURCES, config.numSources || USM_DEFAULT_SOURCES)),
      queries: Array.isArray(config.queries) ? config.queries.slice(0, USM_MAX_SOURCES) : [],
      nmfIterations: config.nmfIterations,
      seed: config.seed,
    };
  }

  /**
   * Process mono or multi-channel PCM.
   * @param {Float32Array|Float32Array[]} channelData
   * @param {number} sampleRate
   * @param {object} [config]
   */
  async process(channelData, sampleRate = SAMPLE_RATE, config = {}) {
    if (config && Object.keys(config).length) this.configure(config);
    const cfg = this._config || { mode: 'auto', numSources: USM_DEFAULT_SOURCES, queries: [] };
    const channels = Array.isArray(channelData) && channelData[0]?.length != null
      ? channelData
      : [channelData];
    const mono = downmixChannels(channels);
    this._mixtureMono = mono;
    this._sampleRate = sampleRate || SAMPLE_RATE;

    this.onProgress(0.05, 'universal-separate');

    let result = null;
    if (this.preferOnnx) {
      this.onProgress(0.1, 'try-onnx-universal');
      result = await tryOnnxUniversal(mono, this._sampleRate, cfg);
    }

    if (!result || !result.sources?.length) {
      this.onProgress(0.2, 'classical-usm');
      result = separateUniversal(mono, this._sampleRate, cfg);
    }

    this.onProgress(0.9, 'pack-sources');
    this._lastResult = result;
    this.sources = result.sources.map((s) => ({
      id: s.id,
      label: s.label,
      gainDb: 0,
      mute: false,
      solo: false,
      pcm: s.pcm,
      confidence: s.confidence,
      quality: s.quality,
      method: s.method,
      mask: s.mask,
    }));

    this.onProgress(1, 'complete');
    return {
      sources: this.sources,
      shape: result.shape,
      method: result.method,
      sampleRate: this._sampleRate,
    };
  }

  /**
   * Refine: run a single text query and append (or replace matching) source.
   * Intentional one-shot inference — not a slider event.
   * @param {string} query
   */
  async refine(query) {
    if (!query || !String(query).trim()) {
      throw new Error('[VIP][USMNode] refine() requires a non-empty text query');
    }
    if (!this._mixtureMono?.length) {
      throw new Error('[VIP][USMNode] Run process() before refine()');
    }
    const mono = this._mixtureMono;

    const result = separateUniversal(mono, this._sampleRate, {
      mode: 'query',
      queries: [String(query).trim()],
    });
    // Keep the first (target) stem from query mode; drop residual unless empty
    const target = result.sources[0];
    if (!target) return this.sources;

    const id = `usm_refine_${Date.now().toString(36)}`;
    this.sources.push({
      id,
      label: target.label || String(query).trim(),
      gainDb: 0,
      mute: false,
      solo: false,
      pcm: target.pcm,
      confidence: target.confidence,
      quality: 'medium',
      method: 'query-refine',
      mask: target.mask,
    });
    // Cap visible sources
    if (this.sources.length > USM_MAX_SOURCES) {
      this.sources = this.sources.slice(-USM_MAX_SOURCES);
    }
    return this.sources;
  }

  /**
   * Combined Live-Mix buffer from current mute/solo/gainDb state.
   */
  renderMix() {
    const states = this.sources.map((s) => ({
      pcm: s.pcm,
      mute: s.mute,
      solo: s.solo,
      gain: dbToGain(s.gainDb),
    }));
    const len = states[0]?.pcm?.length || 0;
    return mixSources(states, len);
  }

  setMute(id, mute) {
    const s = this.sources.find((x) => x.id === id);
    if (s) s.mute = Boolean(mute);
  }

  setSolo(id, solo) {
    if (solo) {
      for (const s of this.sources) s.solo = s.id === id;
    } else {
      const s = this.sources.find((x) => x.id === id);
      if (s) s.solo = false;
    }
  }

  setGainDb(id, gainDb) {
    const s = this.sources.find((x) => x.id === id);
    if (s) s.gainDb = Math.max(-120, Math.min(24, Number(gainDb) || 0));
  }

  setLabel(id, label) {
    const s = this.sources.find((x) => x.id === id);
    if (s) s.label = String(label || s.label).slice(0, 64);
  }

  /** Float32Array[] of stem PCMs for export / audition. */
  getStemBuffers() {
    return this.sources.map((s) => s.pcm);
  }

  clear() {
    this.sources = [];
    this._lastResult = null;
    this._mixtureMono = null;
  }

  dispose() {
    this.clear();
    if (_worker) {
      try { _worker.terminate(); } catch { /* ignore */ }
      _worker = null;
      _ready = null;
    }
  }
}

/**
 * Build AudioBuffers for each USM source (browser only).
 * @param {AudioContext} ctx
 * @param {USMSourceState[]} sources
 * @param {number} sampleRate
 */
export function usmSourcesToAudioBuffers(ctx, sources, sampleRate) {
  if (!ctx) throw new TypeError('[VIP][USMNode] AudioContext required');
  return sources.map((s) => {
    const buf = ctx.createBuffer(1, s.pcm.length, sampleRate || SAMPLE_RATE);
    buf.copyToChannel(s.pcm, 0);
    return { id: s.id, label: s.label, buffer: buf, confidence: s.confidence, quality: s.quality || 'medium' };
  });
}

export default USMNode;
