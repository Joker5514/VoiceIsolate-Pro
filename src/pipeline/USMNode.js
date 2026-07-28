/**
 * VoiceIsolate Pro — Universal Source Matrix Node (Layer 3: Pipeline)
 *
 * **Internal backend service** (not a user-facing panel). Consumed by:
 *   a) Full Analysis pipeline — source segmentation / labeling chips
 *   b) WhisperHunter — per-source stems for whisper isolation targeting
 *
 * Flow: mixture PCM → K soft-masked stems + labels (once per file, cached).
 * Public API for consumers: getSourceStems(), getSourceLabels(), ensureComputed().
 *
 * Does NOT re-run on slider / mute / solo changes (Live-Mix contract).
 * Mute/solo/gain stay for SourceAuditionEngine only — not Engineer slider UI.
 *
 * Classical NMF runs in USMWorker (off main thread). Optional ONNX via MLWorker
 * when `universal_separator` is in the manifest and weights are present.
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
/** Classical USM module worker (separate from ONNX MLWorker). */
let _usmWorker = null;
let _usmSeq = 0;

function getWorker() {
  if (_worker) return _worker;
  _worker = createMLWorker();
  return _worker;
}

function getUsmWorker() {
  if (_usmWorker) return _usmWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    const url = new URL('/src/workers/USMWorker.js', globalThis.location?.href || 'http://localhost/');
    _usmWorker = new Worker(url.href, { type: 'module' });
    return _usmWorker;
  } catch {
    return null;
  }
}

/**
 * Classical separateUniversal via USMWorker (heartbeat + timeout).
 * Falls back to main-thread if workers unavailable.
 * @returns {Promise<import('../core/UniversalSourceMatrix.js').USMResult>}
 */
function runClassicalInWorker(mono, sampleRate, cfg, onProgress, timeoutMs = 120000) {
  const w = getUsmWorker();
  if (!w) {
    onProgress?.(0.25, 'classical-usm-main');
    return Promise.resolve(separateUniversal(mono, sampleRate, cfg));
  }
  const requestId = ++_usmSeq;
  const copy = mono instanceof Float32Array ? new Float32Array(mono) : new Float32Array(mono);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('[VIP][USMNode] USMWorker timed out'));
    }, timeoutMs);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'progress' || m.type === 'heartbeat') {
        const pct = Math.max(0.15, Math.min(0.95, (m.percent || 0) / 100));
        onProgress?.(pct, m.stage || 'usm');
      } else if (m.type === 'result') {
        cleanup();
        resolve(m.result);
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message || 'USMWorker failed'));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(new Error(e?.message || 'USMWorker error'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    onProgress?.(0.12, 'dispatch-usm-worker');
    w.postMessage(
      { type: 'separate', requestId, samples: copy, sampleRate, config: cfg },
      [copy.buffer],
    );
  });
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
  } catch (err) {
    console.warn('[VIP][USMNode] MLWorker init failed for ONNX USM:', err?.message || err);
    return null;
  }
  const w = getWorker();
  const requestId = ++_seq;
  const copy = new Float32Array(samples);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      console.warn('[VIP][USMNode] universal_separate timed out — classical fallback');
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
        console.warn('[VIP][USMNode] universal_separate error:', m.message || 'unknown');
        resolve(null);
      }
    };
    const onErr = (e) => {
      cleanup();
      console.warn('[VIP][USMNode] universal_separate worker error:', e?.message || e);
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
    /** @type {string|null} cache key for ensureComputed() */
    this._cacheKey = null;
  }

  /** Public sample-rate accessor (UI must not read `_sampleRate`). */
  get sampleRate() {
    return this._sampleRate || SAMPLE_RATE;
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
      try {
        result = await runClassicalInWorker(
          mono,
          this._sampleRate,
          cfg,
          (p, label) => this.onProgress(p, label),
          config.timeoutMs || 120000,
        );
      } catch (err) {
        console.warn('[VIP][USMNode] worker failed, main-thread fallback:', err?.message || err);
        result = separateUniversal(mono, this._sampleRate, cfg);
      }
    }

    this.onProgress(0.9, 'pack-sources');
    this._lastResult = result;
    this.sources = result.sources.map((s) => ({
      id: s.id,
      label: s.label,
      gainDb: 0,
      mute: false,
      solo: false,
      pcm: s.pcm instanceof Float32Array ? s.pcm : new Float32Array(s.pcm || []),
      confidence: s.confidence,
      quality: s.quality,
      method: s.method,
      mask: s.mask,
    }));
    this._cacheKey = this._buildCacheKey(mono, this._sampleRate, cfg);

    this.onProgress(1, 'complete');
    return {
      sources: this.sources,
      shape: result.shape,
      method: result.method,
      sampleRate: this._sampleRate,
    };
  }

  /**
   * Ensure stems exist for this mixture (once per file). Skips recompute if
   * cache key matches. Safe to call from Analyze / WhisperHunter — never from
   * slider or mute/solo handlers.
   * @param {Float32Array|Float32Array[]} channelData
   * @param {number} sampleRate
   * @param {object} [config]
   */
  async ensureComputed(channelData, sampleRate = SAMPLE_RATE, config = {}) {
    if (config && Object.keys(config).length) this.configure(config);
    const cfg = this._config || { mode: 'auto', numSources: USM_DEFAULT_SOURCES, queries: [] };
    const channels = Array.isArray(channelData) && channelData[0]?.length != null
      ? channelData
      : [channelData];
    const mono = downmixChannels(channels);
    const key = this._buildCacheKey(mono, sampleRate || SAMPLE_RATE, cfg);
    if (this.sources?.length && this._cacheKey === key) {
      return {
        sources: this.sources,
        shape: this._lastResult?.shape,
        method: this._lastResult?.method || 'cached',
        sampleRate: this._sampleRate,
        cached: true,
      };
    }
    return this.process(mono, sampleRate, config);
  }

  _buildCacheKey(mono, sampleRate, cfg) {
    const n = mono?.length || 0;
    const mid = n ? mono[n >> 1] : 0;
    const end = n ? mono[n - 1] : 0;
    let sum = 0;
    const step = Math.max(1, Math.floor(n / 64));
    for (let i = 0; i < n; i += step) sum += Math.abs(mono[i]);
    return `${sampleRate}|${n}|${sum.toFixed(4)}|${mid}|${end}|${cfg.mode}|${cfg.numSources}|${(cfg.queries || []).join(',')}`;
  }

  /**
   * Internal API: soft-mask stems (Float32Array PCM) for WhisperHunter / audition.
   * @returns {{ id: string, label: string, pcm: Float32Array, confidence: number, quality: string, method: string }[]}
   */
  getSourceStems() {
    return this.sources.map((s) => ({
      id: s.id,
      label: s.label,
      pcm: s.pcm,
      confidence: s.confidence ?? 0,
      quality: s.quality || 'medium',
      method: s.method || 'classical-nmf',
    }));
  }

  /**
   * Internal API: labels + confidence for Analyzer summary chips (no PCM).
   * @returns {{ id: string, label: string, confidence: number, quality: string }[]}
   */
  getSourceLabels() {
    return this.sources.map((s) => ({
      id: s.id,
      label: s.label,
      confidence: s.confidence ?? 0,
      quality: s.quality || 'medium',
    }));
  }

  /** True when at least one stem is cached from the last ensureComputed/process. */
  isReady() {
    return Array.isArray(this.sources) && this.sources.length > 0;
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
    if (this.sources.length > USM_MAX_SOURCES) {
      // Reject rather than silently dropping stems (keeps audition layers consistent)
      this.sources.pop();
      throw new Error(
        `[VIP][USMNode] Max sources (${USM_MAX_SOURCES}) reached — remove a stem before refine`
      );
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
    this._cacheKey = null;
  }

  dispose() {
    this.clear();
    if (_worker) {
      try { _worker.terminate(); } catch { /* ignore */ }
      _worker = null;
      _ready = null;
    }
    if (_usmWorker) {
      try { _usmWorker.terminate(); } catch { /* ignore */ }
      _usmWorker = null;
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
  const sr = sampleRate || SAMPLE_RATE;
  const out = [];
  for (const s of sources || []) {
    if (!s?.pcm || !(s.pcm.length > 0)) continue;
    const buf = ctx.createBuffer(1, s.pcm.length, sr);
    buf.copyToChannel(s.pcm, 0);
    out.push({
      id: s.id,
      label: s.label,
      buffer: buf,
      confidence: s.confidence,
      quality: s.quality || 'medium',
    });
  }
  return out;
}

export default USMNode;
