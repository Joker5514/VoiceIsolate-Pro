/**
 * Local SAM-Audio worker client (Option B).
 * Speaks only to loopback hosts (directly, or through the Electron main process).
 * Never uploads to fal/Replicate/HF from the browser.
 */
'use strict';

import { AudioIsolationProvider, assertSupportedTargeting } from './AudioIsolationProvider.js';

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

/** server.py caps a request body at 64 MiB; base64 float32 costs 16/3 bytes a sample. */
export const MAX_JOB_SAMPLES = Math.floor(((64 * 1024 * 1024 - 4096) * 3) / 4 / 4);
const MAX_PENDING_CANCELS = 64;

/**
 * Globally unique job id. Per-instance counters restarted at `sam-1`, so a
 * cancel for one provider's job also cancelled every later provider's first job.
 */
export function newSamJobId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return `sam-${c.randomUUID()}`;
  if (typeof c?.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    return `sam-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  throw new Error('[VIP][sam-worker] no secure random source for job ids');
}

function cancelledError() {
  return Object.assign(new Error('[VIP][sam-worker] cancelled'), {
    name: 'CancellationError',
    code: 'CANCELLED',
  });
}

function unavailableCaps(reasons) {
  return {
    available: false,
    mode: 'local-worker',
    backends: [],
    live: false,
    offline: true,
    browserSam: false,
    localWorker: true,
    reasons,
  };
}

/**
 * Transports, in order:
 *   fetch — an injected fetchImpl, or global fetch outside a document (Node tools/tests)
 *   ipc   — Electron: window.vipDesktop.samWorkerSeparate (main process talks to loopback)
 *   none  — a web page: CSP connect-src blocks loopback and the worker answers no
 *           CORS preflight, so a direct fetch can never succeed there.
 */
export class LocalSamAudioWorkerProvider extends AudioIsolationProvider {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl='http://127.0.0.1:8765']
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {object} [opts.desktop] Electron bridge (defaults to globalThis.vipDesktop)
   * @param {number} [opts.timeoutMs=120000]
   */
  constructor(opts = {}) {
    super();
    this.baseUrl = String(opts.baseUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
    this._injectedFetch = typeof opts.fetchImpl === 'function';
    this._fetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._desktop = opts.desktop !== undefined ? opts.desktop : (globalThis.vipDesktop || null);
    this.timeoutMs = opts.timeoutMs || 120000;
    /** Job ids cancelled locally; entries leave when their job settles. */
    this._aborted = new Set();
  }

  get id() {
    return 'sam-local-worker';
  }

  /** @returns {'fetch'|'ipc'|'none'} */
  get transport() {
    if (this._injectedFetch) return 'fetch';
    if (typeof this._desktop?.samWorkerSeparate === 'function') return 'ipc';
    if (typeof document !== 'undefined') return 'none';
    return this._fetch ? 'fetch' : 'none';
  }

  async initialize() {
    if (this.transport === 'fetch') assertLoopbackBaseUrl(this.baseUrl);
    const caps = await this.getCapabilities();
    return { ok: caps.available, capabilities: caps };
  }

  async getCapabilities() {
    const transport = this.transport;
    if (transport === 'none') {
      return unavailableCaps([this._fetch ? 'browser-transport-unavailable' : 'fetch-unavailable']);
    }
    try {
      let body;
      if (transport === 'ipc') {
        const r = await this._desktop.samWorkerCapabilities();
        if (!r?.ok) return unavailableCaps([r?.reason || 'worker-unreachable']);
        body = r.capabilities || {};
      } else {
        assertLoopbackBaseUrl(this.baseUrl);
        const res = await this._timedFetch(`${this.baseUrl}/capabilities`, { method: 'GET' });
        if (!res.ok) return unavailableCaps([`http-${res.status}`]);
        body = await res.json();
      }
      return {
        available: !!body.available,
        mode: 'local-worker',
        transport,
        backends: body.backends || ['sam-audio-worker'],
        live: false,
        offline: true,
        browserSam: false,
        localWorker: true,
        model: body.model || body.modelId || null,
        device: body.device || null,
        mock: !!body.mock,
        reasons: body.reasons || [],
      };
    } catch (err) {
      return unavailableCaps([err?.message || 'worker-unreachable']);
    }
  }

  /**
   * @param {import('./AudioIsolationProvider.js').IsolationRequest} request
   */
  async isolate(request) {
    if ((request.processingMode || 'creator') === 'live') {
      throw new Error('[VIP][sam-worker] not available in live mode');
    }
    assertSupportedTargeting(request, this.id);
    const transport = this.transport;
    if (transport === 'none') {
      throw new Error('[VIP][sam-worker] no transport to the local worker from a web page; use the desktop app.');
    }
    if (transport === 'fetch') assertLoopbackBaseUrl(this.baseUrl);

    const mono = toMono(request.audio);
    if (mono.length > MAX_JOB_SAMPLES) {
      const secs = Math.floor(MAX_JOB_SAMPLES / (request.sampleRate || 48000));
      throw new RangeError(`[VIP][sam-worker] one job is limited to ${MAX_JOB_SAMPLES} samples (about ${secs} s).`);
    }
    if (request.signal?.aborted) throw cancelledError();

    const jobId = newSamJobId();
    const onExtAbort = () => { void this.cancel(jobId); };
    try {
      request.signal?.addEventListener?.('abort', onExtAbort, { once: true });
    } catch { /* ignore */ }

    try {
      const body = transport === 'ipc'
        ? await this._separateIpc(jobId, mono, request)
        : await this._separateFetch(jobId, mono, request);
      if (this._aborted.has(jobId) || request.signal?.aborted) throw cancelledError();
      /** @type {import('./AudioIsolationProvider.js').IsolationResult} */
      const out = {
        sampleRate: body.sampleRate || request.sampleRate,
        provider: this.id,
        jobId,
        meta: { mock: !!body.mock, model: body.model, device: body.device, transport },
      };
      if (body.target) out.target = body.target;
      if (body.residual) out.residual = body.residual;
      return out;
    } catch (err) {
      if (this._aborted.has(jobId) || request.signal?.aborted) throw cancelledError();
      throw err;
    } finally {
      try { request.signal?.removeEventListener?.('abort', onExtAbort); } catch { /* ignore */ }
      this._aborted.delete(jobId);
    }
  }

  async _separateIpc(jobId, mono, request) {
    const r = await this._desktop.samWorkerSeparate({
      jobId,
      audio: mono,
      sampleRate: request.sampleRate,
      prompt: String(request.prompt || 'person speaking'),
      predictSpans: !!request.predictSpans,
      rerankingCandidates: request.rerankingCandidates ?? 1,
      output: request.output || 'both',
      timeoutMs: this.timeoutMs,
    });
    if (!r?.ok) throw new Error(`[VIP][sam-worker] separate failed: ${r?.status ?? 0} ${String(r?.error || '').slice(0, 200)}`);
    return r;
  }

  async _separateFetch(jobId, mono, request) {
    const payload = {
      jobId,
      sampleRate: request.sampleRate,
      channels: 1,
      prompt: String(request.prompt || 'person speaking'),
      mode: 'text',
      anchors: [],
      predictSpans: !!request.predictSpans,
      rerankingCandidates: request.rerankingCandidates ?? 1,
      output: request.output || 'both',
      // PCM as base64 float32 LE
      audioBase64: float32ToBase64(mono),
    };
    const res = await this._timedFetch(`${this.baseUrl}/separate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      externalSignal: request.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[VIP][sam-worker] separate failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    return {
      ...body,
      target: body.targetBase64 ? base64ToFloat32(body.targetBase64) : undefined,
      residual: body.residualBase64 ? base64ToFloat32(body.residualBase64) : undefined,
    };
  }

  async cancel(jobId) {
    this._aborted.add(jobId);
    // Cancels for jobs that never settle here (another provider's id) stay bounded.
    while (this._aborted.size > MAX_PENDING_CANCELS) {
      this._aborted.delete(this._aborted.values().next().value);
    }
    try {
      const transport = this.transport;
      if (transport === 'ipc' && typeof this._desktop.samWorkerCancel === 'function') {
        await this._desktop.samWorkerCancel(jobId);
      } else if (transport === 'fetch') {
        assertLoopbackBaseUrl(this.baseUrl);
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
