/**
 * VoiceIsolate Pro — Export Manager (Layer 3: Pipeline)
 *
 * Thin reliability wrapper around ExportOrchestrator + raw buffer export
 * for Engineer Mode when PlaybackMixer is not the source of truth.
 */
'use strict';

import { isDesktopShell, saveExportBlob, filtersForFilename } from '../core/DesktopBridge.js';
import { debugLog } from '../core/debug.js';
import { encodeWavArrayBuffer } from '../core/WavEncoder.js';

/**
 * Encode Float32 channels to WAV. The bytes come from the shared encoder
 * (`src/core/wav-encoder-impl.js`): 16-bit PCM by default, 24-bit PCM or
 * 32-bit IEEE float when `bitDepth` says so.
 *
 * Dither (VIP-040): `ditherAmt` 0-3 selects off / TPDF / error-feedback
 * (coefficients 0.45 and 0.82). With `ditherSeed` set (any finite number)
 * the TPDF noise comes from a seeded mulberry32 stream instead of
 * Math.random(), so the export is bit-reproducible. Without a seed the
 * dither is random TPDF and intentionally not bit-reproducible. ditherAmt 0
 * is always deterministic. Float exports ignore dither.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{ ditherAmt?: number, ditherSeed?: number, bitDepth?: number, truePeakDb?: number }} [options]
 * @returns {Blob}
 */
export function encodeWav(channels, sampleRate, options = {}) {
  const list = channels && channels.length ? channels : [new Float32Array(0)];
  const { buffer } = encodeWavArrayBuffer(list, sampleRate, options);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Safe download filename.
 * @param {string} base
 * @param {string} ext
 */
export function safeFilename(base, ext = 'wav') {
  const cleaned = String(base || 'voiceisolate-export')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'voiceisolate-export';
  return `${cleaned}.${ext.replace(/^\./, '')}`;
}

/**
 * Trigger browser or desktop download with user-visible failure.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<{ ok: boolean, error?: string, filename: string }>}
 */
export async function downloadBlob(blob, filename) {
  const name = safeFilename(filename, filename.includes('.') ? filename.split('.').pop() : 'wav');
  try {
    if (isDesktopShell() && typeof saveExportBlob === 'function') {
      const result = await saveExportBlob(blob, {
        defaultName: name,
        filters: typeof filtersForFilename === 'function' ? filtersForFilename(name) : undefined,
      });
      if (result && result.canceled) {
        return { ok: false, error: 'Export canceled', filename: name };
      }
      return { ok: true, filename: name };
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return { ok: true, filename: name };
  } catch (err) {
    debugLog('ExportManager', err.message || err);
    return { ok: false, error: err.message || String(err), filename: name };
  }
}

/**
 * Export an AudioBuffer as WAV and download.
 * @param {AudioBuffer} audioBuffer
 * @param {string} [filename]
 */
export async function exportAudioBuffer(audioBuffer, filename = 'voiceisolate-export.wav', options = {}) {
  if (!audioBuffer) {
    return { ok: false, error: 'No audio buffer to export', filename };
  }
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const blob = encodeWav(channels, audioBuffer.sampleRate, options);
  const delivered = await downloadBlob(blob, filename);
  return delivered.ok ? { ...delivered, blob } : delivered;
}

export default {
  encodeWav,
  safeFilename,
  downloadBlob,
  exportAudioBuffer,
};
