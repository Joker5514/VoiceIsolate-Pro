/**
 * VoiceIsolate Pro — Spectral Cleanup Worker (Layer 2: Workers)
 *
 * Module worker (spawned with { type: 'module' }) that runs the pure offline
 * spectral-cleanup core off the main thread so long files never jank the UI.
 * No ONNX, no DOM, no microphone — STFT-domain noise reduction + dereverb,
 * computed once per processed file on the CLEAN voice stem (CLAUDE.md §1).
 *
 * Protocol (postMessage):
 *   → { type: 'cleanup', requestId, channels: Float32Array[], sampleRate,
 *       noiseReduction?: number (0–1), dereverb?: number (0–1) }
 *   ← { type: 'cleaned', requestId, channels: Float32Array[], sampleRate }
 *   ← { type: 'error', requestId?, message }
 *
 * Both strengths are processing parameters fixed for this pass — never live
 * sliders. Prefer fused cleanupSpectral() so NR+dereverb share one STFT/iSTFT.
 */
'use strict';

import { cleanupSpectral, reduceNoise, dereverb } from '../core/SpectralCleanup.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'cleanup': {
        const sampleRate = msg.sampleRate;
        const nr = Number(msg.noiseReduction) || 0;
        const dr = Number(msg.dereverb) || 0;
        const channels = (msg.channels || []).map((ch) => {
          const input = ch instanceof Float32Array ? ch : new Float32Array(ch || []);
          // Fused path when both stages are active (one reconstructive STFT).
          if (nr > 0 && dr > 0) {
            return cleanupSpectral(input, { noiseReduction: nr, dereverb: dr, sampleRate });
          }
          if (nr > 0) return reduceNoise(input, { amount: nr, sampleRate });
          if (dr > 0) return dereverb(input, { amount: dr, sampleRate });
          return new Float32Array(input);
        });
        self.postMessage(
          { type: 'cleaned', requestId: msg.requestId, channels, sampleRate },
          channels.map((c) => c.buffer),
        );
        break;
      }
      default:
        self.postMessage({
          type: 'error',
          requestId: msg.requestId,
          message: `Unknown message type '${msg.type}'`,
        });
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      message: err?.message || String(err),
    });
  }
};
