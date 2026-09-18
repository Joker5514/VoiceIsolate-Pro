/**
 * VoiceIsolate-Pro — Live Meters
 * Simplified default view per issue §6:
 * - Voice Clarity / Speech Retention
 * - Noise Reduction
 * - Whisper Retention
 * - Output Level / dBFS
 *
 * Advanced metrics in collapsible inspector
 */

import { Tokens } from '../../tokens/design-tokens.js';

export class LiveMeters {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      showAdvanced: false,
      ...options,
    };
    this._metrics = {
      voiceClarity: null,
      noiseReduction: null,
      whisperRetention: null,
      outputLevelDb: null,
      snrDb: null,
      rms: null,
      peak: null,
      advanced: {},
    };
    this._els = {};
    this._initDOM();
  }

  _initDOM() {
    this.container.className = 'vip-live-meters';
    this.container.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      background: ${Tokens.surface.panel};
      border: 1px solid ${Tokens.border.subtle};
      border-radius: ${Tokens.radius.lg};
    `;

    this.container.innerHTML = `
      <div class="vip-meters-header" style="display:flex; align-items:center; justify-content:space-between;">
        <span style="font:600 11px/1 ${Tokens.font.mono}; letter-spacing:0.08em; text-transform:uppercase; color:${Tokens.text.dim};">Live Metrics</span>
        <button data-action="toggleAdvanced" style="font:500 10px/1 ${Tokens.font.ui}; color:${Tokens.text.secondary}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:4px; padding:4px 8px; cursor:pointer;">Advanced</button>
      </div>
      <div class="vip-meters-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div data-meter="voiceClarity" class="vip-meter-card"></div>
        <div data-meter="noiseReduction" class="vip-meter-card"></div>
        <div data-meter="whisperRetention" class="vip-meter-card"></div>
        <div data-meter="outputLevel" class="vip-meter-card"></div>
      </div>
      <div data-advanced="true" class="vip-meters-advanced" style="display:none; flex-direction:column; gap:8px; padding-top:12px; border-top:1px solid ${Tokens.border.subtle};">
        <div style="font:600 10px/1 ${Tokens.font.mono}; color:${Tokens.text.dim}; text-transform:uppercase;">Forensic Inspector</div>
        <div data-advanced-grid style="display:grid; gap:8px; font:10px/1.4 ${Tokens.font.mono}; color:${Tokens.text.secondary};"></div>
      </div>
    `;

    this._els.grid = this.container.querySelector('.vip-meters-grid');
    this._els.advanced = this.container.querySelector('[data-advanced="true"]');
    this._els.advancedGrid = this.container.querySelector('[data-advanced-grid]');

    // Bind toggle
    this.container.querySelector('[data-action="toggleAdvanced"]').addEventListener('click', () => {
      this.options.showAdvanced = !this.options.showAdvanced;
      this._els.advanced.style.display = this.options.showAdvanced ? 'flex' : 'none';
    });

    // Init meter cards
    this._renderMeters();
  }

  _createMeterCard(key, label, unit = '%', color = Tokens.signal.primary) {
    const card = this.container.querySelector(`[data-meter="${key}"]`);
    if (!card) return;
    card.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
      background: ${Tokens.surface.raised};
      border: 1px solid ${Tokens.border.subtle};
      border-radius: ${Tokens.radius.md};
    `;
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font:500 10px/1 ${Tokens.font.ui}; color:${Tokens.text.dim}; text-transform:uppercase; letter-spacing:0.06em;">${label}</span>
        <span data-value style="font:700 12px/1 ${Tokens.font.mono}; color:${Tokens.text.primary};">--</span>
      </div>
      <div style="position:relative; height:6px; background:${Tokens.surface.overlay}; border-radius:999px; overflow:hidden;">
        <div data-fill style="position:absolute; inset:0 auto 0 0; width:0%; background:${color}; border-radius:999px; transition:width 0.2s ease;"></div>
      </div>
    `;
    return {
      card,
      valueEl: card.querySelector('[data-value]'),
      fillEl: card.querySelector('[data-fill]'),
    };
  }

  _renderMeters() {
    this._meterEls = {
      voiceClarity: this._createMeterCard('voiceClarity', 'Voice Clarity', '%', Tokens.signal.primary),
      noiseReduction: this._createMeterCard('noiseReduction', 'Noise Reduction', 'dB', Tokens.success.default),
      whisperRetention: this._createMeterCard('whisperRetention', 'Whisper Retention', '%', Tokens.selection.default),
      outputLevel: this._createMeterCard('outputLevel', 'Output Level', 'dBFS', Tokens.warning.default),
    };
  }

  setMetrics(metrics) {
    this._metrics = { ...this._metrics, ...metrics };
    this._updateDOM();
  }

  _updateDOM() {
    const m = this._metrics;

    // Voice Clarity — derived from speech retention / SNR
    if (this._meterEls.voiceClarity) {
      const val = m.voiceClarity ?? (m.snrDb != null ? Math.min(100, Math.max(0, (m.snrDb + 10) * 3)) : null);
      this._setMeter(this._meterEls.voiceClarity, val, '%');
    }

    if (this._meterEls.noiseReduction) {
      const val = m.noiseReduction ?? (m.snrDb != null ? Math.max(0, m.snrDb) : null);
      this._setMeter(this._meterEls.noiseReduction, val, ' dB', 0, 40);
    }

    if (this._meterEls.whisperRetention) {
      const val = m.whisperRetention ?? 85; // default high
      this._setMeter(this._meterEls.whisperRetention, val, '%');
    }

    if (this._meterEls.outputLevel) {
      const val = m.outputLevelDb ?? (m.rms != null ? 20 * Math.log10(Math.max(1e-6, m.rms)) : null);
      this._setMeter(this._meterEls.outputLevel, val, ' dBFS', -60, 0, true);
    }

    // Advanced
    if (this.options.showAdvanced && this._els.advancedGrid) {
      const adv = m.advanced || {};
      const lines = [
        m.vadConfidence != null ? `VAD Confidence: ${(m.vadConfidence * 100).toFixed(1)}%` : null,
        m.noiseFloorHistory?.length ? `Noise Floor: ${m.noiseFloorHistory.slice(-1)[0]?.toFixed(1)} dB` : null,
        adv.fftSize ? `FFT: ${adv.fftSize}` : null,
        adv.inferenceTimeMs ? `Inference: ${adv.inferenceTimeMs} ms` : null,
        adv.model ? `Model: ${adv.model}` : null,
        adv.backend ? `Backend: ${adv.backend}` : null,
      ].filter(Boolean);
      this._els.advancedGrid.innerHTML = lines.map((l) => `<div>${l}</div>`).join('') || '<div style="color:var(--vip-text-ghost);">No advanced metrics yet</div>';
    }
  }

  _setMeter(els, value, unit = '', min = 0, max = 100, isDb = false) {
    if (!els) return;
    if (value == null || isNaN(value)) {
      els.valueEl.textContent = '--';
      els.fillEl.style.width = '0%';
      return;
    }
    const clamped = Math.max(min, Math.min(max, value));
    const pct = ((clamped - min) / (max - min)) * 100;
    els.fillEl.style.width = `${pct}%`;
    if (isDb) {
      els.valueEl.textContent = `${value.toFixed(1)}${unit}`;
    } else {
      els.valueEl.textContent = `${Math.round(value)}${unit}`;
    }
    // Color based on value
    if (pct < 30) els.fillEl.style.background = Tokens.critical.default;
    else if (pct < 70) els.fillEl.style.background = Tokens.warning.default;
    else els.fillEl.style.background = Tokens.success.default;
  }

  dispose() {
    this.container.innerHTML = '';
  }
}

export default LiveMeters;
