/**
 * VoiceIsolate Pro — Export Controls (Layer 4: Presentation)
 *
 * UI component for audio export functionality.
 * Provides controls for format selection, stem selection, and export triggering.
 *
 * Architecture:
 * - Layer 4 (Presentation): DOM manipulation only
 * - Imports ExportOrchestrator (Layer 3) for export logic
 * - Integrates with PlaybackMixer for stem access
 * - Shows progress during encoding
 * - Triggers browser download when complete
 */
'use strict';

import { ExportOrchestrator } from '../pipeline/ExportOrchestrator.js';

export class ExportControls {
  /**
   * @param {object} options
   * @param {import('../pipeline/PlaybackMixer.js').PlaybackMixer} options.mixer - PlaybackMixer instance
   * @param {HTMLElement} options.container - Container element for controls
   */
  constructor(options) {
    const { mixer, container } = options;
    
    if (!mixer) {
      throw new TypeError('[VIP][ExportControls] PlaybackMixer instance required.');
    }
    if (!container) {
      throw new TypeError('[VIP][ExportControls] Container element required.');
    }

    this.mixer = mixer;
    this.container = container;
    this.orchestrator = new ExportOrchestrator(mixer);
    
    this._isExporting = false;
    this._render();
    this._attachListeners();
  }

  /**
   * Render the export controls UI.
   * @private
   */
  _render() {
    this.container.innerHTML = `
      <div class="vip-export-controls">
        <h3 class="vip-export-title">Export Audio</h3>
        
        <div class="vip-export-section">
          <label class="vip-export-label">
            <span>Stems:</span>
            <select id="vip-export-stems" class="vip-export-select">
              <option value="clean">Clean Voice Only</option>
              <option value="noise">Background/Noise Only</option>
              <option value="both">Both Stems (Separate Files)</option>
            </select>
          </label>
        </div>

        <div class="vip-export-section">
          <label class="vip-export-label">
            <span>Format:</span>
            <select id="vip-export-format" class="vip-export-select">
              <option value="wav">WAV (Uncompressed)</option>
              <option value="mp3">MP3 (Compressed)</option>
            </select>
          </label>
        </div>

        <div class="vip-export-section vip-export-mp3-options" style="display: none;">
          <label class="vip-export-label">
            <span>MP3 Bitrate:</span>
            <select id="vip-export-bitrate" class="vip-export-select">
              <option value="128">128 kbps</option>
              <option value="192" selected>192 kbps</option>
              <option value="256">256 kbps</option>
              <option value="320">320 kbps</option>
            </select>
          </label>
        </div>

        <div class="vip-export-section">
          <label class="vip-export-checkbox">
            <input type="checkbox" id="vip-export-automation">
            <span>Apply Speaker Automation (volume/mute/solo)</span>
          </label>
        </div>

        <div class="vip-export-section">
          <label class="vip-export-label">
            <span>Filename:</span>
            <input type="text" id="vip-export-filename" class="vip-export-input" value="voiceisolate-export" placeholder="filename">
          </label>
        </div>

        <div class="vip-export-actions">
          <button id="vip-export-button" class="vip-export-button">
            <span class="vip-export-button-text">Export</span>
          </button>
        </div>

        <div class="vip-export-progress" style="display: none;">
          <div class="vip-export-progress-bar">
            <div class="vip-export-progress-fill" style="width: 0%"></div>
          </div>
          <div class="vip-export-progress-text">Preparing...</div>
        </div>

        <div class="vip-export-status" style="display: none;"></div>
      </div>
    `;

    this._injectStyles();
  }

  /**
   * Inject CSS styles for export controls.
   * @private
   */
  _injectStyles() {
    if (document.getElementById('vip-export-styles')) return;

    const style = document.createElement('style');
    style.id = 'vip-export-styles';
    style.textContent = `
      .vip-export-controls {
        padding: 20px;
        background: rgba(0, 0, 0, 0.8);
        border-radius: 8px;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        max-width: 500px;
      }

      .vip-export-title {
        margin: 0 0 20px 0;
        font-size: 20px;
        font-weight: 600;
        color: #00ffff;
      }

      .vip-export-section {
        margin-bottom: 16px;
      }

      .vip-export-label {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 14px;
      }

      .vip-export-label > span {
        font-weight: 500;
        color: #aaa;
      }

      .vip-export-select,
      .vip-export-input {
        padding: 10px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 4px;
        color: #fff;
        font-size: 14px;
        outline: none;
        transition: border-color 0.2s;
      }

      .vip-export-select:focus,
      .vip-export-input:focus {
        border-color: #00ffff;
      }

      .vip-export-select option {
        background: #1a1a1a;
        color: #fff;
      }

      .vip-export-checkbox {
        display: flex;
        align-items: center;
        gap: 10px;
        cursor: pointer;
        font-size: 14px;
      }

      .vip-export-checkbox input[type="checkbox"] {
        width: 18px;
        height: 18px;
        cursor: pointer;
      }

      .vip-export-actions {
        margin-top: 24px;
      }

      .vip-export-button {
        width: 100%;
        padding: 14px;
        background: linear-gradient(135deg, #00ffff, #0099ff);
        border: none;
        border-radius: 6px;
        color: #000;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, opacity 0.2s;
      }

      .vip-export-button:hover:not(:disabled) {
        transform: translateY(-2px);
      }

      .vip-export-button:active:not(:disabled) {
        transform: translateY(0);
      }

      .vip-export-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .vip-export-progress {
        margin-top: 20px;
      }

      .vip-export-progress-bar {
        width: 100%;
        height: 8px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        overflow: hidden;
      }

      .vip-export-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #00ffff, #0099ff);
        transition: width 0.3s ease;
      }

      .vip-export-progress-text {
        margin-top: 8px;
        font-size: 13px;
        color: #aaa;
        text-align: center;
      }

      .vip-export-status {
        margin-top: 16px;
        padding: 12px;
        border-radius: 4px;
        font-size: 14px;
        text-align: center;
      }

      .vip-export-status.success {
        background: rgba(0, 255, 0, 0.1);
        border: 1px solid rgba(0, 255, 0, 0.3);
        color: #0f0;
      }

      .vip-export-status.error {
        background: rgba(255, 0, 0, 0.1);
        border: 1px solid rgba(255, 0, 0, 0.3);
        color: #f66;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Attach event listeners to controls.
   * @private
   */
  _attachListeners() {
    const formatSelect = this.container.querySelector('#vip-export-format');
    const mp3Options = this.container.querySelector('.vip-export-mp3-options');
    const exportButton = this.container.querySelector('#vip-export-button');

    // Show/hide MP3 options based on format
    formatSelect.addEventListener('change', () => {
      mp3Options.style.display = formatSelect.value === 'mp3' ? 'block' : 'none';
    });

    // Export button click
    exportButton.addEventListener('click', () => this._handleExport());
  }

  /**
   * Handle export button click.
   * @private
   */
  async _handleExport() {
    if (this._isExporting) return;

    // Validate stems are loaded
    if (!this.mixer.cleanBuffer || !this.mixer.noiseBuffer) {
      this._showStatus('error', 'No audio loaded. Please load a file first.');
      return;
    }

    const stems = this.container.querySelector('#vip-export-stems').value;
    const format = this.container.querySelector('#vip-export-format').value;
    const bitrate = parseInt(this.container.querySelector('#vip-export-bitrate').value, 10);
    const applySpeakerAutomation = this.container.querySelector('#vip-export-automation').checked;
    const filename = this.container.querySelector('#vip-export-filename').value.trim() || 'export';

    this._isExporting = true;
    this._setButtonState(true);
    this._showProgress(true);
    this._hideStatus();

    try {
      const result = await this.orchestrator.export({
        stems,
        format,
        bitrate,
        filename,
        applySpeakerAutomation,
        onProgress: (progress, stage) => this._updateProgress(progress, stage),
      });

      // Handle single or multiple results
      const results = Array.isArray(result) ? result : [result];
      
      // Download each file
      for (const res of results) {
        this._downloadBlob(res.blob, res.filename);
      }

      this._showStatus('success', `Exported ${results.length} file${results.length > 1 ? 's' : ''} successfully!`);
    } catch (error) {
      console.error('[VIP][ExportControls] Export failed:', error);
      this._showStatus('error', `Export failed: ${error.message}`);
    } finally {
      this._isExporting = false;
      this._setButtonState(false);
      this._showProgress(false);
    }
  }

  /**
   * Update progress display.
   * @private
   * @param {number} progress - Progress 0-1
   * @param {string} stage - Stage description
   */
  _updateProgress(progress, stage) {
    const progressFill = this.container.querySelector('.vip-export-progress-fill');
    const progressText = this.container.querySelector('.vip-export-progress-text');
    
    if (progressFill) {
      progressFill.style.width = `${progress * 100}%`;
    }
    
    if (progressText) {
      const stageLabels = {
        'preparing': 'Preparing export...',
        'reading': 'Reading audio data...',
        'applying-automation': 'Applying speaker automation...',
        'encoding': 'Encoding audio...',
        'encoding-wav': 'Encoding WAV...',
        'encoding-mp3': 'Encoding MP3...',
        'complete': 'Complete!',
      };
      progressText.textContent = stageLabels[stage] || stage;
    }
  }

  /**
   * Show/hide progress bar.
   * @private
   * @param {boolean} show
   */
  _showProgress(show) {
    const progress = this.container.querySelector('.vip-export-progress');
    if (progress) {
      progress.style.display = show ? 'block' : 'none';
      if (!show) {
        // Reset progress
        const fill = this.container.querySelector('.vip-export-progress-fill');
        if (fill) fill.style.width = '0%';
      }
    }
  }

  /**
   * Show status message.
   * @private
   * @param {'success'|'error'} type
   * @param {string} message
   */
  _showStatus(type, message) {
    const status = this.container.querySelector('.vip-export-status');
    if (status) {
      status.textContent = message;
      status.className = `vip-export-status ${type}`;
      status.style.display = 'block';
      
      // Auto-hide success messages after 5 seconds
      if (type === 'success') {
        setTimeout(() => this._hideStatus(), 5000);
      }
    }
  }

  /**
   * Hide status message.
   * @private
   */
  _hideStatus() {
    const status = this.container.querySelector('.vip-export-status');
    if (status) {
      status.style.display = 'none';
    }
  }

  /**
   * Set export button enabled/disabled state.
   * @private
   * @param {boolean} disabled
   */
  _setButtonState(disabled) {
    const button = this.container.querySelector('#vip-export-button');
    const buttonText = this.container.querySelector('.vip-export-button-text');
    
    if (button) {
      button.disabled = disabled;
      if (buttonText) {
        buttonText.textContent = disabled ? 'Exporting...' : 'Export';
      }
    }
  }

  /**
   * Trigger browser download of a blob.
   * @private
   * @param {Blob} blob
   * @param {string} filename
   */
  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // Clean up — use a.remove() so this is safe even if DOM is torn down first
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Clean up resources.
   */
  dispose() {
    if (this.orchestrator) {
      this.orchestrator.dispose();
    }
    this.container.innerHTML = '';
  }
}

export default ExportControls;

// Made with Bob
