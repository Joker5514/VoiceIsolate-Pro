/**
 * VoiceIsolate Pro — Audio Encoder Worker (Layer 2: Workers)
 *
 * Web Worker that encodes PCM to 16-bit WAV off the main thread.
 *
 * WAV is the only format. MP3 was advertised through an undeclared, unbundled
 * `lamejs` import (with a CDN fallback hint, which CLAUDE.md forbids); no
 * shipped page could reach it and the import could only fail. A request for
 * any other format is rejected.
 *
 * Message Protocol:
 * - 'encode': { requestId, channels: Float32Array[], sampleRate, format: 'wav' }
 *   → 'result': { requestId, blob, format, clippedSamples }
 *   → 'error': { requestId, error }
 *   → 'progress': { requestId, progress, stage }
 *
 * Input contract (rejected otherwise, never silently patched):
 * - 1–8 channels, each a Float32Array, all the same non-zero length
 * - every sample finite (NaN/±Infinity used to become silent zeros)
 * - integer sample rate in [8000, 384000] Hz
 * - the RIFF/data sizes fit their 32-bit fields
 * Clipping policy: samples beyond ±1 are clamped to full scale and counted in
 * `clippedSamples`, so callers can tell a clamped export from a clean one.
 */
'use strict';

export const WAV_LIMITS = Object.freeze({
  maxChannels: 8,
  minSampleRate: 8000,
  maxSampleRate: 384000,
  // RIFF chunk size (data + 36) must fit a uint32.
  maxDataBytes: 0xFFFFFFFF - 36,
});

/**
 * Validate PCM for WAV encoding; throws a TypeError/RangeError naming the fault.
 * @param {unknown} channels
 * @param {unknown} sampleRate
 * @returns {{ numChannels: number, length: number }}
 */
export function validatePcm(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > WAV_LIMITS.maxChannels) {
    throw new TypeError(`Invalid channels: expected 1–${WAV_LIMITS.maxChannels} Float32Array channels.`);
  }
  if (!channels.every((ch) => ch instanceof Float32Array)) {
    throw new TypeError('Invalid channels: every channel must be a Float32Array.');
  }
  const length = channels[0].length;
  if (length === 0) throw new RangeError('Invalid channels: audio is empty.');
  if (!channels.every((ch) => ch.length === length)) {
    throw new RangeError(`Invalid channels: lengths differ (${channels.map((c) => c.length).join(', ')}).`);
  }
  if (!Number.isInteger(sampleRate) || sampleRate < WAV_LIMITS.minSampleRate || sampleRate > WAV_LIMITS.maxSampleRate) {
    throw new RangeError(`Invalid sample rate ${sampleRate}: expected an integer from ${WAV_LIMITS.minSampleRate} to ${WAV_LIMITS.maxSampleRate} Hz.`);
  }
  const dataBytes = length * channels.length * 2;
  if (dataBytes > WAV_LIMITS.maxDataBytes) {
    throw new RangeError('Audio is too long for a WAV file (4 GiB limit).');
  }
  let nonFinite = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) nonFinite++;
  }
  if (nonFinite) throw new RangeError(`Audio contains ${nonFinite} non-finite samples.`);
  return { numChannels: channels.length, length };
}

/**
 * Encode validated Float32 PCM to a 16-bit WAV.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{ blob: Blob, clippedSamples: number }}
 */
export function encodeWAV(channels, sampleRate) {
  const { numChannels, length } = validatePcm(channels, sampleRate);
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let clippedSamples = 0;
  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let sample = channels[ch][i];
      if (sample > 1) { sample = 1; clippedSamples++; } else if (sample < -1) { sample = -1; clippedSamples++; }
      // Round, not truncate: setInt16 truncates toward zero, a 2-LSB dead zone.
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7FFF), true);
      offset += 2;
    }
  }
  return { blob: new Blob([buffer], { type: 'audio/wav' }), clippedSamples };
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Message Handler
// ─────────────────────────────────────────────────────────────────────────────

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => {
    const { type, requestId, channels, sampleRate, format } = e.data || {};
    if (type !== 'encode') return;
    try {
      if (format !== 'wav') {
        throw new TypeError(`Unsupported format "${format}": this build encodes WAV only.`);
      }
      self.postMessage({ type: 'progress', requestId, progress: 0.5, stage: 'encoding-wav' });
      const { blob, clippedSamples } = encodeWAV(channels, sampleRate);
      self.postMessage({ type: 'progress', requestId, progress: 1, stage: 'complete' });
      self.postMessage({ type: 'result', requestId, blob, format: 'wav', clippedSamples });
    } catch (error) {
      console.error('[VIP][AudioEncoderWorker] Encoding error:', error);
      self.postMessage({ type: 'error', requestId, error: error?.message || 'Encoding failed.' });
    }
  };

  self.postMessage({ type: 'ready' });
}
