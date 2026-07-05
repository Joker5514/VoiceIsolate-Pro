/**
 * VoiceIsolate Pro — Isolation Mode Selector (Layer 4: Presentation)
 *
 * UI component for selecting voice isolation mode. Exposes the backend's
 * model chaining capability (MLWorker.js modelIds array) to users.
 *
 * Three modes:
 * - "Standard" - BS-RNN vocals only (current default, fast)
 * - "Maximum" - BS-RNN vocals → BiGRU denoise chain (best quality)
 * - "Noise Suppression" - BiGRU denoise only (for non-vocal audio)
 *
 * Architecture:
 * - Pure presentation layer (Layer 4)
 * - Emits custom events when mode changes
 * - No direct coupling to pipeline or workers
 * - Follows SliderUI.js pattern for DOM interaction
 *
 * Expected markup:
 *   <select id="isolationModeSelector">
 *     <option value="standard">Standard</option>
 *     <option value="maximum">Maximum Isolation</option>
 *     <option value="noise-suppression">Noise Suppression</option>
 *   </select>
 *   <div id="isolationModeDescription"></div>
 */
'use strict';

import { debugLog } from '../core/debug.js';

/**
 * Isolation mode definitions with metadata.
 * Maps mode keys to model chains and user-facing information.
 */
export const ISOLATION_MODES = Object.freeze({
  standard: Object.freeze({
    id: 'standard',
    name: 'Standard',
    description: 'Demucs v4 vocal extraction. Best quality for most recordings.',
    modelIds: ['demucs'],
    estimatedTime: '~5-8s per minute of audio',
    icon: '🎤',
  }),
  maximum: Object.freeze({
    id: 'maximum',
    name: 'Maximum Isolation',
    description: 'Demucs vocal extraction followed by BiGRU noise suppression. Highest isolation quality.',
    modelIds: ['demucs', 'rnnoise'],
    estimatedTime: '~8-12s per minute of audio',
    icon: '🎯',
  }),
  'noise-suppression': Object.freeze({
    id: 'noise-suppression',
    name: 'Noise Suppression',
    description: 'BiGRU noise suppressor only. Use for non-vocal audio or when you only need background noise removal.',
    modelIds: ['rnnoise'],
    estimatedTime: '~1-2s per minute of audio',
    icon: '🔇',
  }),
});

/** Default mode when none is specified. */
export const DEFAULT_MODE = 'standard';

/** Stable list of mode ids. */
export const MODE_IDS = Object.freeze(Object.keys(ISOLATION_MODES));

/**
 * Get mode definition by id, with fallback to default.
 * @param {string} modeId
 * @returns {typeof ISOLATION_MODES[keyof typeof ISOLATION_MODES]}
 */
export function getMode(modeId) {
  return ISOLATION_MODES[modeId] || ISOLATION_MODES[DEFAULT_MODE];
}

/**
 * Validate that a mode id is known.
 * @param {string} modeId
 * @returns {boolean}
 */
export function isValidMode(modeId) {
  return MODE_IDS.includes(modeId);
}

/**
 * IsolationModeSelector - UI component for mode selection.
 *
 * Emits 'isolationmodechange' custom event when mode changes:
 *   event.detail = { mode: string, modelIds: string[] }
 */
export class IsolationModeSelector {
  /**
   * @param {object} [options]
   * @param {Document} [options.document] - Injectable for tests
   * @param {string} [options.selectorId] - ID of the <select> element
   * @param {string} [options.descriptionId] - ID of the description container
   * @param {(mode: string) => void} [options.onChange] - Optional change callback
   * @param {string} [options.initialMode] - Initial mode (default: 'standard')
   */
  constructor(options = {}) {
    this.doc = options.document || globalThis.document;
    this.selectorId = options.selectorId || 'isolationModeSelector';
    this.descriptionId = options.descriptionId || 'isolationModeDescription';
    this.onChange = options.onChange || null;
    this._currentMode = options.initialMode || DEFAULT_MODE;
    
    this._selector = null;
    this._description = null;
    this._boundHandler = null;
  }

  /**
   * Get the currently selected mode id.
   * @returns {string}
   */
  get currentMode() {
    return this._currentMode;
  }

  /**
   * Get the model IDs for the current mode.
   * @returns {string[]}
   */
  get currentModelIds() {
    return getMode(this._currentMode).modelIds;
  }

  /**
   * Bind to DOM elements and set up event listeners.
   * @returns {boolean} - True if successfully bound
   */
  bind() {
    this._selector = this.doc.getElementById(this.selectorId);
    this._description = this.doc.getElementById(this.descriptionId);

    if (!this._selector) {
      console.warn(`[VIP][IsolationModeSelector] Element #${this.selectorId} not found`);
      return false;
    }

    // Set initial value
    this._selector.value = this._currentMode;
    this._updateDescription();

    // Bind change handler
    this._boundHandler = () => this._handleChange();
    this._selector.addEventListener('change', this._boundHandler);

    debugLog('IsolationModeSelector', `Bound to #${this.selectorId}, initial mode: ${this._currentMode}`);
    return true;
  }

  /**
   * Handle mode selection change.
   * @private
   */
  _handleChange() {
    const newMode = this._selector.value;
    
    if (!isValidMode(newMode)) {
      console.warn(`[VIP][IsolationModeSelector] Invalid mode '${newMode}', reverting to ${this._currentMode}`);
      this._selector.value = this._currentMode;
      return;
    }

    if (newMode === this._currentMode) {
      return; // No change
    }

    const oldMode = this._currentMode;
    this._currentMode = newMode;
    this._updateDescription();

    debugLog('IsolationModeSelector', `Mode changed: ${oldMode} → ${newMode}`);

    // Emit custom event
    const mode = getMode(newMode);
    const event = new CustomEvent('isolationmodechange', {
      detail: {
        mode: newMode,
        modelIds: mode.modelIds,
        previousMode: oldMode,
      },
      bubbles: true,
    });
    this._selector.dispatchEvent(event);

    // Call optional callback
    if (this.onChange) {
      this.onChange(newMode);
    }
  }

  /**
   * Update the description text based on current mode.
   * @private
   */
  _updateDescription() {
    if (!this._description) return;

    const mode = getMode(this._currentMode);
    this._description.innerHTML = `
      <div class="isolation-mode-info">
        <span class="mode-icon">${mode.icon}</span>
        <div class="mode-details">
          <strong>${mode.name}</strong>
          <p>${mode.description}</p>
          <small class="mode-time">${mode.estimatedTime}</small>
        </div>
      </div>
    `;
  }

  /**
   * Programmatically set the mode.
   * @param {string} modeId
   * @returns {boolean} - True if mode was changed
   */
  setMode(modeId) {
    if (!isValidMode(modeId)) {
      console.warn(`[VIP][IsolationModeSelector] Invalid mode '${modeId}'`);
      return false;
    }

    if (modeId === this._currentMode) {
      return false; // No change
    }

    this._currentMode = modeId;
    
    if (this._selector) {
      this._selector.value = modeId;
      this._updateDescription();
    }

    return true;
  }

  /**
   * Get the full mode definition for the current mode.
   * @returns {typeof ISOLATION_MODES[keyof typeof ISOLATION_MODES]}
   */
  getCurrentModeDefinition() {
    return getMode(this._currentMode);
  }

  /**
   * Detach event listeners and clean up.
   */
  dispose() {
    if (this._selector && this._boundHandler) {
      this._selector.removeEventListener('change', this._boundHandler);
    }
    this._selector = null;
    this._description = null;
    this._boundHandler = null;
  }
}

export default IsolationModeSelector;

// Made with Bob
