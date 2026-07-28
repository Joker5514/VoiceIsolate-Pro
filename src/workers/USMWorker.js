/**
 * VoiceIsolate Pro — Universal Source Matrix Worker (Layer 2)
 *
 * Runs classical separateUniversal off the main thread so Analyze/Process
 * never freeze the Engineer UI. Message protocol:
 *   { type: 'separate', requestId, samples: Float32Array, sampleRate, config? }
 *   → { type: 'heartbeat'|'progress', requestId, percent, stage }
 *   → { type: 'result', requestId, result }  (stems transferred)
 *   → { type: 'error', requestId, message }
 *
 * Live-Mix contract: this worker is NEVER invoked from slider/mute/solo.
 */
'use strict';

import { separateUniversal } from '../core/UniversalSourceMatrix.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type !== 'separate') return;
  const requestId = msg.requestId;
  let heartbeat = null;
  try {
    const post = (type, extra = {}) => {
      self.postMessage({ type, requestId, ...extra });
    };
    post('progress', { percent: 5, stage: 'prepare' });
    // Heartbeat while classical NMF runs (sync) so host can show "not stuck".
    let tick = 8;
    heartbeat = setInterval(() => {
      tick = Math.min(88, tick + 4);
      post('heartbeat', { percent: tick, stage: 'nmf' });
    }, 400);

    let samples = msg.samples;
    if (!(samples instanceof Float32Array)) {
      samples = new Float32Array(samples || []);
    }
    if (!samples.length) {
      throw new Error('No samples for USM separation');
    }
    const sampleRate = msg.sampleRate || 48000;
    const config = msg.config || { mode: 'auto', numSources: 6 };

    post('progress', { percent: 15, stage: 'stft-nmf' });
    const result = separateUniversal(samples, sampleRate, config);
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    post('progress', { percent: 95, stage: 'pack' });

    // Transfer PCM + masks to avoid structured-clone cost on large stems.
    const transfer = [];
    const sources = (result.sources || []).map((s) => {
      const pcm = s.pcm instanceof Float32Array ? s.pcm : new Float32Array(s.pcm || []);
      const mask = s.mask instanceof Float32Array ? s.mask : null;
      if (pcm.buffer) transfer.push(pcm.buffer);
      if (mask?.buffer) transfer.push(mask.buffer);
      return {
        id: s.id,
        label: s.label,
        pcm,
        mask,
        confidence: s.confidence,
        quality: s.quality,
        method: s.method,
      };
    });

    self.postMessage(
      {
        type: 'result',
        requestId,
        result: {
          sources,
          shape: result.shape,
          method: result.method,
          // stft dropped — large; stems already rendered
        },
      },
      transfer,
    );
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    self.postMessage({
      type: 'error',
      requestId,
      message: err && err.message ? err.message : String(err),
    });
  }
};
