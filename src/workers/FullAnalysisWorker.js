/**
 * VoiceIsolate Pro — Full Analysis Worker (Layer 2: Workers)
 *
 * Message protocol:
 *   { type: 'features', requestId, channels, sampleRate, frameSec?, hopSec? }
 *   { type: 'analyze', requestId, channels, sampleRate, opts? }
 *   { type: 'cancel', requestId }
 *   → { type: 'progress', requestId, percent, stage }
 *   → { type: 'features', requestId, mono, extraction }
 *   → { type: 'result', requestId, analysis }
 *   → { type: 'cancelled', requestId }
 *   → { type: 'error', requestId, message }
 *
 * Feature extraction runs in slices and yields between them. A setInterval
 * heartbeat cannot fire while analyzeAudio occupies this thread, so progress
 * is posted from completed frames instead.
 */
'use strict';

import { analyzeAudioCooperative } from '../core/FullAnalysis.js';
import { downmixToMono, createFeaturePass, advanceFeaturePass } from '../core/FeatureExtractor.js';

/** @type {number|null} */
let _activeAnalyzeId = null;
/** @type {Set<number>} */
const _cancelledIds = new Set();
/** Last completed progress. The interval only repeats this; it does not invent a percent. */
let _beatRequest = null;
let _beatTimer = null;

const FRAMES_PER_SLICE = 400;
const HEARTBEAT_MS = 1000;

function asChannels(raw) {
  return (raw || []).map((c) => (c instanceof Float32Array ? c : new Float32Array(c)));
}

function yieldTurn() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function isCancelled(requestId) {
  return _cancelledIds.has(requestId) || (_activeAnalyzeId != null && _activeAnalyzeId !== requestId);
}

function noteBeat(requestId, percent, stage) {
  _beatRequest = { requestId, percent, stage };
  if (_beatTimer != null) return;
  // The timer runs only because feature slices yield. It cannot move during a
  // synchronous chunk, and it reports the last completed frame percent.
  _beatTimer = setInterval(() => {
    const beat = _beatRequest;
    if (!beat || isCancelled(beat.requestId)) return;
    globalThis.postMessage({
      type: 'heartbeat',
      requestId: beat.requestId,
      percent: beat.percent,
      stage: beat.stage,
    });
  }, HEARTBEAT_MS);
}

function stopHeartbeat(requestId) {
  if (_beatRequest?.requestId !== requestId) return;
  _beatRequest = null;
  if (_beatTimer != null) {
    clearInterval(_beatTimer);
    _beatTimer = null;
  }
}

globalThis.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'cancel') {
    const id = msg.requestId;
    if (id != null) _cancelledIds.add(id);
    if (id == null || id === _activeAnalyzeId) _activeAnalyzeId = null;
    globalThis.postMessage({ type: 'cancelled', requestId: id ?? null });
    return;
  }
  if (msg.type === 'features') {
    void runFeatures(msg);
    return;
  }
  if (msg.type === 'analyze') {
    void runAnalyze(msg);
  }
};

async function runFeatures(msg) {
  const requestId = msg.requestId;
  try {
    if (_cancelledIds.has(requestId)) {
      globalThis.postMessage({ type: 'cancelled', requestId });
      return;
    }
    const channels = asChannels(msg.channels);
    const mono = downmixToMono(channels);
    const sampleRate = msg.sampleRate || 48000;
    const pass = createFeaturePass(mono, sampleRate, msg);
    const total = Math.max(1, Math.ceil(Math.max(0, mono.length - pass.frameLen) / pass.hop));
    while (!pass.done) {
      if (_cancelledIds.has(requestId)) {
        globalThis.postMessage({ type: 'cancelled', requestId });
        return;
      }
      advanceFeaturePass(pass, FRAMES_PER_SLICE);
      const percent = Math.max(0, Math.min(100, Math.round((pass.frames.length / total) * 100)));
      noteBeat(requestId, percent, 'features');
      globalThis.postMessage({ type: 'progress', requestId, percent, stage: 'features' });
      if (!pass.done) await yieldTurn();
    }
    globalThis.postMessage(
      { type: 'features', requestId, mono, extraction: pass.result },
      [mono.buffer],
    );
  } catch (err) {
    globalThis.postMessage({
      type: 'error',
      requestId,
      message: err?.message || String(err),
    });
  } finally {
    stopHeartbeat(requestId);
  }
}

async function runAnalyze(msg) {
  const requestId = msg.requestId;
  _activeAnalyzeId = requestId;
  const post = (type, percent, stage) => {
    if (_cancelledIds.has(requestId) || _activeAnalyzeId !== requestId) return;
    globalThis.postMessage({ type, requestId, percent, stage });
  };
  try {
    if (_cancelledIds.has(requestId)) {
      globalThis.postMessage({ type: 'cancelled', requestId });
      return;
    }
    const channels = asChannels(msg.channels);
    if (!channels.length) throw new Error('No channel data for analysis');
    const sampleRate = msg.sampleRate || 48000;
    const reused = Array.isArray(msg.opts?.extraction?.frames);
    // A reused extraction is past the feature stage. Do not report 5% after
    // the host has already dispatched at 15%.
    const startPercent = reused ? 16 : 20;
    const startStage = reused ? 'classify' : 'features';
    noteBeat(requestId, startPercent, startStage);
    post('progress', startPercent, startStage);
    const analysis = await analyzeAudioCooperative(channels, sampleRate, msg.opts || {}, {
      framesPerSlice: FRAMES_PER_SLICE,
      shouldStop: () => isCancelled(requestId),
      onProgress: (done, total) => {
        const percent = 20 + Math.round((done / Math.max(1, total)) * 70);
        const clamped = Math.min(90, percent);
        noteBeat(requestId, clamped, 'features');
        post('progress', clamped, 'features');
      },
      yield: yieldTurn,
    });
    if (isCancelled(requestId)) {
      globalThis.postMessage({ type: 'cancelled', requestId });
      return;
    }
    noteBeat(requestId, 95, 'recommend');
    post('progress', 95, 'recommend');
    globalThis.postMessage({ type: 'result', requestId, analysis });
  } catch (err) {
    if (err?.code === 'CANCELLED' || _cancelledIds.has(requestId)) {
      globalThis.postMessage({ type: 'cancelled', requestId });
      return;
    }
    globalThis.postMessage({
      type: 'error',
      requestId,
      message: err?.message || String(err),
    });
  } finally {
    stopHeartbeat(requestId);
    if (_activeAnalyzeId === requestId) _activeAnalyzeId = null;
    _cancelledIds.delete(requestId);
  }
}
