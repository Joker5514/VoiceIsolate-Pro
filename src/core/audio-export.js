'use strict';

import { SAMPLE_RATE } from './audio-config.js';

export const EXPORT_FORMATS = Object.freeze({
  WAV: 'wav',
});

export function interleaveChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TypeError('[VIP][audio-export] Expected at least one channel.');
  }
  const length = channels[0]?.length || 0;
  if (!length) {
    throw new RangeError('[VIP][audio-export] Channels must be non-empty.');
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length !== length) {
      throw new TypeError('[VIP][audio-export] Channels must be same-length Float32Arrays.');
    }
  }

  if (channels.length === 1) return new Float32Array(channels[0]);

  const out = new Float32Array(length * channels.length);
  let write = 0;
  for (let index = 0; index < length; index++) {
    for (let channel = 0; channel < channels.length; channel++) {
      out[write++] = channels[channel][index];
    }
  }
  return out;
}

export function encodeWav(channels, sampleRate = SAMPLE_RATE) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError('[VIP][audio-export] sampleRate must be a positive number.');
  }
  const channelCount = channels.length;
  const interleaved = interleaveChannels(channels);
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = interleaved.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < interleaved.length; index++, offset += 2) {
    const sample = clamp(interleaved[index], -1, 1);
    const pcm = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset, Math.round(pcm), true);
  }
  return buffer;
}

export function buildExportFilename(sourceName, suffix, extension = EXPORT_FORMATS.WAV) {
  const stem = String(sourceName || 'voiceisolate-export')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'voiceisolate-export';
  const safeSuffix = String(suffix || 'mix')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'mix';
  return `${stem}-${safeSuffix}.${extension}`;
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}