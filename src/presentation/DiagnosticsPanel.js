'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';

export class DiagnosticsPanel {
  constructor(mixer, options = {}) {
    if (!mixer) throw new TypeError('[VIP][DiagnosticsPanel] A PlaybackMixer instance is required.');
    this.mixer = mixer;
    this.doc = options.document || globalThis.document;
    this.batchProcessor = options.batchProcessor || null;
    this.getWorkerState = options.getWorkerState || (() => ({}));
    this.getPresetState = options.getPresetState || (() => ({}));
    this.getIngestionState = options.getIngestionState || (() => ({}));
    this._logs = [];
  }

  record(level, message, data = null) {
    this._logs.push({
      ts: new Date().toISOString(),
      level,
      message,
      data,
    });
    if (this._logs.length > 100) this._logs.shift();
  }

  snapshot() {
    const analyser = this.mixer.getAnalyser?.();
    const batchStats = this.batchProcessor?.getStats?.() || null;
    return {
      audio: {
        sampleRate: this.mixer.ctx?.sampleRate || SAMPLE_RATE,
        playing: this.mixer.isPlaying?.() || false,
        currentTime: this.mixer.currentTime?.() || 0,
        duration: this.mixer.duration?.() || 0,
        voiceMuted: this.mixer.isVoiceMuted?.() || false,
        noiseMuted: this.mixer.isNoiseMuted?.() || false,
        speakers: this.mixer.speakerIds?.() || [],
        analyserFftSize: analyser?.fftSize || null,
      },
      presets: this.getPresetState() || {},
      ingestion: this.getIngestionState() || {},
      workers: this.getWorkerState() || {},
      batch: batchStats,
      logs: this._logs.slice(),
    };
  }

  exportJson() {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  render(container) {
    if (!container) throw new TypeError('[VIP][DiagnosticsPanel] A container element is required.');
    const snap = this.snapshot();
    container.textContent = '';
    const pre = this.doc.createElement('pre');
    pre.className = 'vip-diagnostics-panel';
    pre.textContent = JSON.stringify(snap, null, 2);
    container.appendChild(pre);
    return snap;
  }
}

export default DiagnosticsPanel;