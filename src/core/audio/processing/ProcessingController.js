/**
 * VoiceIsolate-Pro — Processing Controller
 * Handles Raw / Processed / Removed (Delta) workflow
 * Preserves raw immutable, generates derived views
 */

import { ComparisonModes } from '../../../ui/tokens/design-tokens.js';

export class ProcessingController {
  constructor(sessionStore) {
    this.store = sessionStore;
    this._raw = null;
    this._processed = null;
    this._removed = null;
  }

  setRaw(channelData, sampleRate) {
  setRaw(channelData, _sampleRate) {
    // Deep clone to preserve immutable raw
    this._raw = channelData.map((ch) => ch.slice());
    this.store?.setProcessingState('idle', 0, 'raw_set');
    return this._raw;
  }

  getRaw() {
    return this._raw ? this._raw.map((ch) => ch.slice()) : null;
  }

  /**
   * Set processed result, compute removed as delta
   * @param {Float32Array[]} processed
   * @param {number} sampleRate
   */
  setProcessed(processed, sampleRate) {
    if (!this._raw) {
      // If no raw yet, raw = processed for first import
      this._raw = processed.map((ch) => ch.slice());
    }
    this._processed = processed.map((ch) => ch.slice());
    
    // Compute removed = raw - processed (what was removed)
    this._removed = this._raw.map((rawCh, idx) => {
      const procCh = this._processed[idx] || this._processed[0] || new Float32Array(rawCh.length);
      const removed = new Float32Array(rawCh.length);
      const len = Math.min(rawCh.length, procCh.length);
      for (let i = 0; i < len; i++) {
        removed[i] = rawCh[i] - procCh[i];
      }
      // If raw longer than processed, remainder is fully removed
      for (let i = len; i < rawCh.length; i++) {
        removed[i] = rawCh[i];
      }
      return removed;
    });

    this.store?.applyProcessing({
      rawBuffer: this._raw.map((ch) => ch.slice()),
      processedBuffer: this._processed.map((ch) => ch.slice()),
      removedBuffer: this._removed.map((ch) => ch.slice()),
      sampleRate,
      channels: processed.length,
    });

    return {
      raw: this.getRaw(),
      processed: this.getProcessed(),
      removed: this.getRemoved(),
    };
  }

  getProcessed() {
    return this._processed ? this._processed.map((ch) => ch.slice()) : null;
  }

  getRemoved() {
    return this._removed ? this._removed.map((ch) => ch.slice()) : null;
  }

  /**
   * Get buffer for current comparison mode
   */
  getBufferForMode(mode) {
    switch (mode) {
      case ComparisonModes.RAW:
        return this.getRaw();
      case ComparisonModes.REMOVED:
        return this.getRemoved();
      case ComparisonModes.PROCESSED:
      default:
        return this.getProcessed();
    }
  }

  /**
   * Apply contextual action to selected region
   * @param {object} selection - { start, end, freqLow, freqHigh }
   * @param {string} action - isolate | enhance | reduce_noise | boost_whisper | etc.
   * @param {Float32Array[]} source - source to process (default raw)
   * @returns {Float32Array[]} processed region
   */
  applyActionToSelection(selection, action, source = null) {
    const src = source || this._raw || this._processed;
    if (!src) throw new Error('No source audio for processing');
    
    // For now, simple gain-based actions — real implementation would use DSP/ML
    const sampleRate = this.store?.getState()?.processing?.sampleRate || 48000;
    const startSample = Math.floor(selection.start * sampleRate);
    const endSample = Math.floor(selection.end * sampleRate);
    
    const result = src.map((ch) => ch.slice());
    
    for (const ch of result) {
      for (let i = startSample; i < Math.min(endSample, ch.length); i++) {
        switch (action) {
          case 'isolate':
            // Boost selected region, duck others slightly (simplified)
            // Actual isolation would use mask
            ch[i] = ch[i] * 1.2;
            break;
          case 'enhance_voice':
            ch[i] = ch[i] * 1.15;
            break;
          case 'reduce_noise':
            // Gentle reduction outside selection would be more complex
            ch[i] = ch[i] * 0.95;
            break;
          case 'boost_whisper':
            // Boost low-energy content
            if (Math.abs(ch[i]) < 0.05) {
              ch[i] = ch[i] * 2.5;
            }
            break;
          case 'preview':
          default:
            // No change for preview
            break;
        }
      }
    }
    
    // Clamp
    for (const ch of result) {
      for (let i = 0; i < ch.length; i++) {
        ch[i] = Math.max(-1, Math.min(1, ch[i]));
      }
    }
    
    return result;
  }

  /**
   * Validate that processing did not destroy speech
   * @returns {object} validation result
   */
  validateProcessing() {
    if (!this._raw || !this._processed) return { valid: true, warnings: [] };
    
    const raw = this._raw[0];
    const proc = this._processed[0];
    const len = Math.min(raw.length, proc.length);
    
    let rawEnergy = 0;
    let procEnergy = 0;
    for (let i = 0; i < len; i++) {
      rawEnergy += raw[i] * raw[i];
      procEnergy += proc[i] * proc[i];
    }
    
    const ratio = procEnergy / Math.max(1e-10, rawEnergy);
    const warnings = [];
    
    if (ratio < 0.01) {
      warnings.push('Processing removed nearly all audio — possible speech destruction');
    }
    if (ratio > 2) {
      warnings.push('Processing amplified significantly — check for clipping');
    }
    
    return {
      valid: warnings.length === 0,
      warnings,
      energyRatio: ratio,
      rawEnergy,
      procEnergy,
    };
  }

  clear() {
    this._raw = null;
    this._processed = null;
    this._removed = null;
  }
}

export default ProcessingController;
