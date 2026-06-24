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
 * sliders. Each stage is a no-op at 0, so passing both 0 returns copies.
 */
'use strict';

import { reduceNoise, dereverb } from '../core/SpectralCleanup.js';

self.onmessage = (event) => {
  const msg = event.data || {};
  try {
    switch (msg.type) {
      case 'cleanup': {
        const sampleRate = msg.sampleRate;
        const nr = Number(msg.noiseReduction) || 0;
        const dr = Number(msg.dereverb) || 0;
        const channels = (msg.channels || []).map((ch) => {
          let out = ch instanceof Float32Array ? ch : new Float32Array(ch || []);
          // Denoise first (removes the stationary floor), then dereverb.
          if (nr > 0) out = reduceNoise(out, { amount: nr, sampleRate });
          if (dr > 0) out = dereverb(out, { amount: dr, sampleRate });
          return out;
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
