/**
 * Local SAM-Audio worker client (Option B).
 * Speaks only to loopback hosts. Never uploads to fal/Replicate/HF from the browser.
 */
'use strict';

import { AudioIsolationProvider } from './AudioIsolationProvider.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * @param {string} baseUrl
 * @returns {URL}
 */
export function assertLoopbackBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error('[VIP][sam-worker] invalid base URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('[VIP][sam-worker] only http(s) allowed');
  }
  const host = u.hostname.toLowerCase();
  if (!LOOPBACK.has(host)) {
    throw new Error(`[VIP][sam-worker] refused non-loopback host: ${host}`);
  }
  return u;
}

export class LocalSamAudioWorkerProvider extends AudioIsolationProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl='http://127.0.0.1:8765']
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {number} [opts.timeoutMs=120000]
   */
  constructor(opts = {}) {
    super();
    this.baseUrl = String(opts.baseUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
    this._fetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.timeoutMs = opts.timeoutMs || 120000;
    this._jobId = 0;
    this._aborted = new Set();
  }

  get id() {
    return 'sam-local-worker';
  }

  async initialize() {
    assertLoopbackBaseUrl(this.baseUrl);
    const caps = await this.getCapabilities();
    return { ok: caps.available, capabilities: caps };
  }

  async getCapabilities() {
    if (!this._fetch) {
      return {
        available: false,
        mode: 'local-worker',
        backends: [],
        live: false,
        offline: true,
        browserSam: false,
        localWorker: true,
        reasons: ['fetch-unavailable'],
      };
    }
    try {
      assertLoopbackBaseUrl(this.baseUrl);
      const res = await this._timedFetch(`${this.baseUrl}/capabilities`, { method: 'GET' });
      if (!res.ok) {
        return {
          available: false,
          mode: 'local-worker',
          backends: [],
          live: false,
          offline: true,
          browserSam: false,
          localWorker: true,
          reasons: [`http-${res.status}`],
        };
      }
      const body = await res.json();
      return {
        available: !!body.available,
        mode: 'local-worker',
        backends: body.backends || ['sam-audio-worker'],
        live: false,
        offline: true,
        browserSam: false,
        localWorker: true,
        model: body.model || null,
        device: body.device || null,
        mock: !!body.mock,
        reasons: body.reasons || [],
      };
    } catch (err) {
      return {
        available: false,
        mode: 'local-worker',
        backends: [],
        live: false,
        offline: true,
        browserSam: false,
        localWorker: true,
        reasons: [err?.message || 'worker-unreachable'],
      };
    }
  }

  /**
   * @param {import('./AudioIsolationProvider.js').IsolationRequest} request
   */
  async isolate(request) {
    if ((request.processingMode || 'creator') === 'live') {
      throw new Error('[VIP][sam-worker] not available in live mode');
    }
    assertLoopbackBaseUrl(this.baseUrl);
    if (!this._fetch) throw new Error('[VIP][sam-worker] fetch unavailable');

    const jobId = `sam-${++this._jobId}`;
    const mono = toMono(request.audio);
    const payload = {
      jobId,
      sampleRate: request.sampleRate,
      channels: 1,
      prompt: String(request.prompt || 'person speaking'),
      mode: request.mode || 'text',
      anchors: request.anchors || [],
      predictSpans: !!request.predictSpans,
      rerankingCandidates: request.rerankingCandidates ?? 1,
      output: request.output || 'both',
      // PCM as base64 float32 LE
      audioBase64: float32ToBase64(mono),
    };

    // External AbortSignal (JobController) + internal job abort set.
    if (request.signal?.aborted) {
      this._aborted.add(jobId);
      throw Object.assign(new Error('[VIP][sam-worker] cancelled'), {
        name: 'CancellationError',
        code: 'CANCELLED',
      });
    }
    const onExtAbort = () => {
      this._aborted.add(jobId);
      void this.cancel(jobId);
    };
    try {
      request.signal?.addEventListener?.('abort', onExtAbort, { once: true });
    } catch { /* ignore */ }

    let res;
    try {
      res = await this._timedFetch(`${this.baseUrl}/separate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        externalSignal: request.signal,
      });
    } finally {
      try { request.signal?.removeEventListener?.('abort', onExtAbort); } catch { /* ignore */ }
    }
    if (this._aborted.has(jobId) || request.signal?.aborted) {
      throw Object.assign(new Error('[VIP][sam-worker] cancelled'), {
        name: 'CancellationError',
        code: 'CANCELLED',
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[VIP][sam-worker] separate failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    /** @type {import('./AudioIsolationProvider.js').IsolationResult} */
    const out = {
      sampleRate: body.sampleRate || request.sampleRate,
      provider: this.id,
      jobId,
      meta: { mock: !!body.mock, model: body.model, device: body.device },
    };
    if (body.targetBase64) out.target = base64ToFloat32(body.targetBase64);
    if (body.residualBase64) out.residual = base64ToFloat32(body.residualBase64);
    return out;
  }

  async cancel(jobId) {
    this._aborted.add(jobId);
    try {
      assertLoopbackBaseUrl(this.baseUrl);
      if (this._fetch) {
        await this._timedFetch(`${this.baseUrl}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId }),
        });
      }
    } catch { /* best-effort */ }
    return { ok: true };
  }

  async _timedFetch(url, init = {}) {
    const { externalSignal, ...fetchInit } = init;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    const onExt = () => { try { ctrl?.abort(); } catch { /* ignore */ } };
    try {
      externalSignal?.addEventListener?.('abort', onExt, { once: true });
      if (externalSignal?.aborted) onExt();
      return await this._fetch(url, { ...fetchInit, signal: ctrl?.signal || externalSignal });
    } finally {
      if (t) clearTimeout(t);
      try { externalSignal?.removeEventListener?.('abort', onExt); } catch { /* ignore */ }
    }
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
  throw new TypeError('[VIP][sam-worker] audio must be Float32Array or Float32Array[]');
}

function getNodeBuffer() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.Buffer) return globalThis.Buffer;
  } catch { /* ignore */ }
  return null;
}

export function float32ToBase64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  const Buf = getNodeBuffer();
  if (Buf) return Buf.from(bytes).toString('base64');
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToFloat32(b64) {
  let bytes;
  const Buf = getNodeBuffer();
  if (Buf) {
    bytes = new Uint8Array(Buf.from(b64, 'base64'));
  } else {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

export default LocalSamAudioWorkerProvider;
