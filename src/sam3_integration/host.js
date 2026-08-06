/**
 * Main-thread host for the SAM 3 vision worker.
 * Optional; does not touch AudioWorklet graph unless caller posts metadata.
 */
'use strict';

import { isSam3Enabled } from './featureFlag.js';
import { probeSam3Runtime, probeSam3ModelAsset } from './runtime.js';
import { validatePromptCommand } from './text_prompt_handler.js';
import { toWorkletMetadata } from './types.js';

const DEFAULT_WORKER_URL = '/src/sam3_integration/worker.js';

export class Sam3Host {
  /**
   * @param {{
   *   workerUrl?: string,
   *   enabled?: boolean,
   *   maxTracks?: number,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.workerUrl = opts.workerUrl || DEFAULT_WORKER_URL;
    this.enabled = opts.enabled ?? isSam3Enabled(null, { queryParam: true });
    this.maxTracks = opts.maxTracks ?? 10;
    /** @type {Worker|null} */
    this._worker = null;
    this._req = 0;
    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    this._pending = new Map();
    this._ready = false;
    this._runtime = probeSam3Runtime();
    /** @type {((meta: object) => void)|null} */
    this.onWorkletMeta = null;
  }

  get runtime() {
    return this._runtime;
  }

  /**
   * @returns {Promise<{ ok: boolean, runtime: object, reason?: string }>}
   */
  async start() {
    if (!this.enabled) {
      return { ok: false, runtime: this._runtime, reason: 'feature-flag-off' };
    }
    if (this._runtime.status === 'unsupported') {
      return { ok: false, runtime: this._runtime, reason: 'unsupported-runtime' };
    }
    if (this._worker) {
      return { ok: true, runtime: this._runtime };
    }
    try {
      this._worker = new Worker(this.workerUrl, { type: 'module', name: 'vip-sam3-worker' });
    } catch (err) {
      return {
        ok: false,
        runtime: this._runtime,
        reason: err?.message || 'worker-spawn-failed',
      };
    }
    this._worker.onmessage = (ev) => this._onMessage(ev.data || {});
    this._worker.onerror = (err) => {
      for (const [, p] of this._pending) {
        p.reject(new Error(err?.message || 'sam3-worker-error'));
      }
      this._pending.clear();
    };

    const model = await probeSam3ModelAsset();
    this._runtime = {
      ...probeSam3Runtime(),
      modelAsset: model,
      status: model.present ? 'ready' : 'ready-heuristic',
    };

    await this._request('init', {
      options: { maxTracks: this.maxTracks },
      force: true,
    });
    this._ready = true;
    return { ok: true, runtime: this._runtime };
  }

  stop() {
    if (this._worker) {
      try { this._worker.terminate(); } catch { /* ignore */ }
      this._worker = null;
    }
    this._ready = false;
    this._pending.clear();
  }

  /**
   * @param {object} command
   */
  async setPrompt(command) {
    const v = validatePromptCommand(command);
    if (!v.ok) throw new Error(v.reason || 'bad-prompt');
    await this.start();
    return this._request('setPrompt', { command: v.command });
  }

  async clearPrompts() {
    await this.start();
    return this._request('clearPrompts', {});
  }

  /**
   * @param {{ frameIndex: number, timestampMs: number, width: number, height: number }} frame
   */
  async segmentFrame(frame) {
    await this.start();
    const res = await this._request('segment', { frame });
    // Forward worklet-safe metadata to optional callback (caller binds to port)
    if (this.onWorkletMeta && Array.isArray(res?.results)) {
      for (const item of res.results) {
        if (item.workletMeta) this.onWorkletMeta(item.workletMeta);
        else if (item.frame) {
          const m = toWorkletMetadata(item.frame);
          if (m.ok && m.meta) this.onWorkletMeta(m.meta);
        }
      }
    }
    return res;
  }

  /**
   * @param {number} trackId
   * @param {object} patch
   */
  async correctTrack(trackId, patch) {
    await this.start();
    return this._request('correctTrack', { trackId, patch });
  }

  /**
   * Post only validated compact meta to an AudioWorkletNode port (optional).
   * Never posts masks or raw frames.
   * @param {MessagePort|{ postMessage: Function }} port
   * @param {object} frameResult
   */
  postToWorkletPort(port, frameResult) {
    if (!port || typeof port.postMessage !== 'function') {
      return { ok: false, reason: 'no-port' };
    }
    const m = toWorkletMetadata(frameResult);
    if (!m.ok || !m.meta) return { ok: false, reason: m.reason || 'invalid' };
    try {
      port.postMessage(m.meta);
      return { ok: true, meta: m.meta };
    } catch (err) {
      return { ok: false, reason: err?.message || 'post-failed' };
    }
  }

  /**
   * @param {string} type
   * @param {object} body
   */
  _request(type, body) {
    if (!this._worker) {
      return Promise.reject(new Error('sam3-worker-not-started'));
    }
    const requestId = ++this._req;
    return new Promise((resolve, reject) => {
      this._pending.set(requestId, { resolve, reject });
      this._worker.postMessage({ type, requestId, ...body });
      // Safety timeout (vision must not hang forever)
      setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          reject(new Error('sam3-timeout'));
        }
      }, 30000);
    });
  }

  _onMessage(msg) {
    const requestId = msg.requestId;
    if (msg.type === 'boot') {
      this._runtime = { ...this._runtime, ...msg.runtime };
      return;
    }
    if (requestId == null) return;
    const p = this._pending.get(requestId);
    if (!p) return;
    this._pending.delete(requestId);
    if (msg.type === 'error') {
      p.reject(new Error(msg.message || 'sam3-error'));
      return;
    }
    p.resolve(msg);
  }
}

export default Sam3Host;
