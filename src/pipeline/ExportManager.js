/**
 * VoiceIsolate Pro — Export Manager (Layer 3: Pipeline)
 *
 * Thin reliability wrapper around ExportOrchestrator + raw buffer export
 * for Engineer Mode when PlaybackMixer is not the source of truth.
 */
'use strict';

import { isDesktopShell, saveExportBlob, filtersForFilename } from '../core/DesktopBridge.js';
import { debugLog } from '../core/debug.js';

/**
 * Encode Float32 channels to 16-bit PCM WAV.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {Blob}
 */
export function encodeWav(channels, sampleRate) {
  const numChannels = channels.length || 1;
  const length = channels[0]?.length || 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let s = channels[ch][i] || 0;
      s = Math.max(-1, Math.min(1, s));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
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
export async function exportAudioBuffer(audioBuffer, filename = 'voiceisolate-export.wav') {
  if (!audioBuffer) {
    return { ok: false, error: 'No audio buffer to export', filename };
  }
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const blob = encodeWav(channels, audioBuffer.sampleRate);
  return downloadBlob(blob, filename);
}

export default {
  encodeWav,
  safeFilename,
  downloadBlob,
  exportAudioBuffer,
};
