/**
 * VoiceIsolate Pro — Diarization Worker (Layer 2: Workers)
 *
 * Module worker (spawned with { type: 'module' }) that runs the pure
 * diarization core off the main thread so long files never jank the UI.
 * No ONNX, no DOM, no microphone — feature extraction + k-means only,
 * computed once per processed file on the CLEAN voice stem.
 *
 * Protocol (postMessage):
 *   → { type: 'diarize', requestId, samples: Float32Array, sampleRate }
 *   ← { type: 'segments', requestId, segments: Segment[], speakers: Summary[] }
 *   ← { type: 'error', requestId?, message }
 */
'use strict';

import { diarizeChannel, summarizeSpeakers } from '../core/diarization.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'diarize': {
        const samples = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples || []);
        const segments = diarizeChannel(samples, msg.sampleRate);
        self.postMessage({
          type: 'segments',
          requestId: msg.requestId,
          segments,
          speakers: summarizeSpeakers(segments),
        });
        break;
      }
      default:
        self.postMessage({ type: 'error', message: `Unknown message type '${msg.type}'` });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err?.message || String(err),
    });
  }
};
