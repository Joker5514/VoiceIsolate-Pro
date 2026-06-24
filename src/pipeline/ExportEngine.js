'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { buildExportFilename, encodeWav, EXPORT_FORMATS } from '../core/audio-export.js';

export class ExportEngine {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || SAMPLE_RATE;
    this.document = options.document || globalThis.document || null;
    this.url = options.url || globalThis.URL || null;
    this.BlobCtor = options.BlobCtor || globalThis.Blob;
    this.now = options.now || (() => new Date().toISOString());
  }

  exportMix(payload) {
    return this._export(payload, 'mix');
  }

  exportVoice(payload) {
    return this._export(payload, 'voice');
  }

  exportNoise(payload) {
    return this._export(payload, 'noise');
  }

  _export(payload, kind) {
    const channels = pickChannels(payload, kind);
    const sampleRate = payload?.sampleRate || this.sampleRate;
    const filename = buildExportFilename(payload?.sourceName, kind, EXPORT_FORMATS.WAV);
    const wav = encodeWav(channels, sampleRate);
    const blob = new this.BlobCtor([wav], { type: 'audio/wav' });
    this._download(blob, filename);
    return {
      filename,
      mimeType: 'audio/wav',
      bytes: blob.size,
      sampleRate,
      channels: channels.length,
      exportedAt: this.now(),
      kind,
    };
  }

  _download(blob, filename) {
    if (!this.document || !this.url) {
      throw new Error('[VIP][ExportEngine] Download APIs are not available.');
    }
    const href = this.url.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    this.document.body.appendChild(anchor);
    anchor.click();
    this.document.body.removeChild(anchor);
    this.url.revokeObjectURL(href);
  }
}

function pickChannels(payload, kind) {
  const clean = payload?.cleanChannels;
  const noise = payload?.noiseChannels;
  if (!Array.isArray(clean) || !Array.isArray(noise) || clean.length === 0 || noise.length === 0) {
    throw new TypeError('[VIP][ExportEngine] cleanChannels and noiseChannels are required.');
  }
  if (kind === 'voice') return clean;
  if (kind === 'noise') return noise;
  if (clean.length !== noise.length) {
    throw new TypeError('[VIP][ExportEngine] Stem channel counts must match.');
  }
  return clean.map((channel, index) => sumChannels(channel, noise[index]));
}

function sumChannels(left, right) {
  if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) {
    throw new TypeError('[VIP][ExportEngine] Stem channels must be same-length Float32Arrays.');
  }
  const out = new Float32Array(left.length);
  for (let index = 0; index < left.length; index++) {
    out[index] = left[index] + right[index];
  }
  return out;
}

export default ExportEngine;