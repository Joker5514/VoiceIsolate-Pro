/**
 * VoiceIsolate Pro — Full Analysis Worker (Layer 2: Workers)
 *
 * Runs analyzeAudio off the main thread. Message protocol:
 *   { type: 'analyze', requestId, channels: Float32Array[], sampleRate, opts? }
 *   → { type: 'progress'|'heartbeat', requestId, percent, stage }
 *   → { type: 'result', requestId, analysis }
 *   → { type: 'error', requestId, message }
 *
 * Heartbeats keep the Engineer processing overlay from appearing stuck while
 * classical feature extraction runs (sync work inside analyzeAudio).
 */
'use strict';

import { analyzeAudio } from '../core/FullAnalysis.js';

/** @type {number|null} */
let _activeAnalyzeId = null;
/** @type {Set<number>} */
const _cancelledIds = new Set();

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'cancel') {
    const id = msg.requestId;
    if (id != null) _cancelledIds.add(id);
    if (id == null || id === _activeAnalyzeId) {
      _activeAnalyzeId = null;
    }
    self.postMessage({ type: 'cancelled', requestId: id ?? null });
    return;
  }
  if (msg.type !== 'analyze') return;
  const requestId = msg.requestId;
  _activeAnalyzeId = requestId;
  let heartbeat = null;
  try {
    const post = (type, percent, stage) => {
      if (_cancelledIds.has(requestId) || _activeAnalyzeId !== requestId) return;
      self.postMessage({ type, requestId, percent, stage });
    };
    if (_cancelledIds.has(requestId)) {
      self.postMessage({ type: 'cancelled', requestId });
      return;
    }
    post('progress', 5, 'prepare');
    const channels = (msg.channels || []).map((c) => {
      if (c instanceof Float32Array) return c;
      return new Float32Array(c);
    });
    if (!channels.length) {
      throw new Error('No channel data for analysis');
    }
    const sampleRate = msg.sampleRate || 48000;
    post('progress', 20, 'features');
    // Heartbeat while sync analyzeAudio runs — host timeout reset / UI pulse.
    let tick = 22;
    heartbeat = setInterval(() => {
      if (_cancelledIds.has(requestId)) {
        clearInterval(heartbeat);
        heartbeat = null;
        return;
      }
      tick = Math.min(90, tick + 3);
      post('heartbeat', tick, 'analyze');
    }, 500);

    const analysis = analyzeAudio(channels, sampleRate, msg.opts || {});
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (_cancelledIds.has(requestId) || _activeAnalyzeId !== requestId) {
      self.postMessage({ type: 'cancelled', requestId });
      return;
    }
    post('progress', 95, 'recommend');
    // Structured clone — analysis is plain data (no transfer needed for result object)
    self.postMessage({ type: 'result', requestId, analysis });
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    if (_cancelledIds.has(requestId)) {
      self.postMessage({ type: 'cancelled', requestId });
      return;
    }
    self.postMessage({
      type: 'error',
      requestId,
      message: err && err.message ? err.message : String(err),
    });
  } finally {
    if (_activeAnalyzeId === requestId) _activeAnalyzeId = null;
    _cancelledIds.delete(requestId);
  }
};
