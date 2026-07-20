/**
 * VoiceIsolate Pro — Full Analysis Worker (Layer 2: Workers)
 *
 * Runs analyzeAudio off the main thread. Message protocol:
 *   { type: 'analyze', requestId, channels: Float32Array[], sampleRate, opts? }
 *   → { type: 'progress', requestId, percent, stage }
 *   → { type: 'result', requestId, analysis }
 *   → { type: 'error', requestId, message }
 */
'use strict';

import { analyzeAudio } from '../core/FullAnalysis.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'analyze') return;
  const requestId = msg.requestId;
  try {
    self.postMessage({ type: 'progress', requestId, percent: 5, stage: 'prepare' });
    const channels = (msg.channels || []).map((c) => {
      if (c instanceof Float32Array) return c;
      return new Float32Array(c);
    });
    if (!channels.length) {
      throw new Error('No channel data for analysis');
    }
    const sampleRate = msg.sampleRate || 48000;
    self.postMessage({ type: 'progress', requestId, percent: 20, stage: 'features' });
    const analysis = analyzeAudio(channels, sampleRate, msg.opts || {});
    self.postMessage({ type: 'progress', requestId, percent: 95, stage: 'recommend' });
    // Structured clone — analysis is plain data (no transfer needed for result object)
    self.postMessage({ type: 'result', requestId, analysis });
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId,
      message: err && err.message ? err.message : String(err),
    });
  }
};
