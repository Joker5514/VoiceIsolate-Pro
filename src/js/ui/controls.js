/**
 * VoiceIsolate Pro v9.0 - UI Controls Manager
 * Handles all DOM event bindings, sliders, toggles, presets, drag-and-drop,
 * file pickers, modals, progress display, and stats updates.
 * Uses event delegation and addEventListener exclusively.
 */

export class ControlsManager {
  /**
   * @param {Object} config - Shared configuration object reference (mutated in place)
   */
  constructor(config) {
    /** @type {Object} */
    this._config = config || {};

    /** @type {Map<string, {key: string, unit: string, min: number, max: number, default: number, step: number}>} */
    this._sliderMeta = new Map();

    /** @type {Map<string, Object>} */
    this._presets = new Map();

    /** @type {AbortController} - Central controller for tearing down all listeners */
    this._abortController = new AbortController();

    /** @type {HTMLElement|null} */
    this._modalEl = null;
    this._modalBackdropEl = null;

    /** @type {HTMLElement|null} */
    this._exportMenuEl = null;

    /** @type {HTMLElement|null} */
    this._progressEl = null;

    this._boundOnResize = this._onResize.bind(this);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Bind all UI event listeners. Call once after DOM is ready.
   */
  init() {
    const signal = this._abortController.signal;

    // Global keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      this._handleKeyboard(e);
    }, { signal });

    // Close export menu on outside click (delegated on document)
    document.addEventListener('click', (e) => {
      if (this._exportMenuEl && !this._exportMenuEl.contains(e.target)) {
        this.hideExportMenu();
      }
    }, { signal });

    // Window resize
    window.addEventListener('resize', this._boundOnResize, { signal });

    // Ensure modal & progress containers exist or create them
    this._ensureModal();
    this._ensureProgress();
  }

  // ---------------------------------------------------------------------------
  // Sliders
  // ---------------------------------------------------------------------------

  /**
   * Set up slider controls from configuration array.
   * Each slider should be an <input type="range"> with a matching display element.
   * @param {Array<{id: string, key: string, unit: string, min: number, max: number, default: number, step: number}>} sliderConfigs
   */
  setupSliders(sliderConfigs) {
    const signal = this._abortController.signal;

    for (const cfg of sliderConfigs) {
      const { id, key, unit, min, max, step } = cfg;
      const defaultVal = cfg.default;

      this._sliderMeta.set(id, cfg);

      const slider = document.getElementById(id);
      if (!slider) {
        console.warn(`[ControlsManager] Slider #${id} not found`);
        continue;
      }

      // Apply attributes
      slider.min = min;
      slider.max = max;
      slider.step = step;
      slider.value = defaultVal;

      // Set initial config value
      this._config[key] = defaultVal;

      // Update display
      this.updateSliderDisplay(id, defaultVal, unit);

      // Bind input event for real-time feedback
      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this._config[key] = val;
        this.updateSliderDisplay(id, val, unit);
      }, { signal });

      // Bind change event for final commit
      slider.addEventListener('change', (e) => {
        const val = parseFloat(e.target.value);
        this._config[key] = val;
        this.updateSliderDisplay(id, val, unit);
        this._dispatchConfigChange(key, val);
      }, { signal });

      // Double-click to reset to default
      slider.addEventListener('dblclick', () => {
        slider.value = defaultVal;
        this._config[key] = defaultVal;
        this.updateSliderDisplay(id, defaultVal, unit);
        this._dispatchConfigChange(key, defaultVal);
      }, { signal });
    }
  }

  /**
   * Update the value display element next to a slider.
   * Looks for an element with id `${sliderId}-value` or `${sliderId}-display`.
   * @param {string} id - Slider element ID
   * @param {number} value - Current value
   * @param {string} unit - Unit suffix
   */
  updateSliderDisplay(id, value, unit) {
    const displayEl =
      document.getElementById(`${id}-value`) ||
      document.getElementById(`${id}-display`);
    if (displayEl) {
      displayEl.textContent = this._formatValue(value, unit);
    }
  }

  // ---------------------------------------------------------------------------
  // Toggles
  // ---------------------------------------------------------------------------

  /**
   * Bind all toggle switches (checkboxes with [data-toggle] attribute).
   * The data-toggle value is used as the config key.
   */
  setupToggles() {
    const signal = this._abortController.signal;
    const toggles = document.querySelectorAll('[data-toggle]');

    for (const toggle of toggles) {
      const key = toggle.dataset.toggle;
      const isCheckbox = toggle.type === 'checkbox';

      // Initialize config
      if (isCheckbox) {
        this._config[key] = toggle.checked;
      }

      toggle.addEventListener('change', (e) => {
        const val = isCheckbox ? e.target.checked : e.target.value;
        this._config[key] = val;
        this._dispatchConfigChange(key, val);
      }, { signal });
    }
  }

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------

  /**
   * Set up preset buttons. Each button should have [data-preset] attribute.
   * @param {Object} presets - Map of preset name to config values, e.g. { 'voice': { noiseSuppression: 80, ... } }
   */
  setupPresets(presets) {
    const signal = this._abortController.signal;

    // Store presets
    for (const [name, values] of Object.entries(presets)) {
      this._presets.set(name, values);
    }

    // Use event delegation on document for preset buttons
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;

      const presetName = btn.dataset.preset;
      this.applyPreset(presetName);

      // Update active state styling
      const allPresetBtns = document.querySelectorAll('[data-preset]');
      for (const b of allPresetBtns) {
        b.classList.toggle('active', b.dataset.preset === presetName);
      }
    }, { signal });
  }

  /**
   * Apply a named preset to all sliders and toggles.
   * @param {string} presetName
   */
  applyPreset(presetName) {
    const preset = this._presets.get(presetName);
    if (!preset) {
      console.warn(`[ControlsManager] Unknown preset: ${presetName}`);
      return;
    }

    this.setConfig(preset);

    // Dispatch event
    document.dispatchEvent(new CustomEvent('voiceisolate:preset', {
      detail: { preset: presetName, values: preset },
    }));
  }

  // ---------------------------------------------------------------------------
  // Drag and Drop
  // ---------------------------------------------------------------------------

  /**
   * Configure drag-and-drop file handling on a drop zone element.
   * @param {string} dropZoneId - ID of the drop zone element
   * @param {function(File): void} onFile - Callback receiving the dropped File
   */
  setupDragDrop(dropZoneId, onFile) {
    const signal = this._abortController.signal;
    const zone = document.getElementById(dropZoneId);
    if (!zone) {
      console.warn(`[ControlsManager] Drop zone #${dropZoneId} not found`);
      return;
    }

    let dragCounter = 0;

    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      zone.classList.add('drag-over');
    }, { signal });

    zone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        zone.classList.remove('drag-over');
      }
    }, { signal });

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }, { signal });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      zone.classList.remove('drag-over');

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        if (this._isAudioFile(file)) {
          onFile(file);
        } else {
          console.warn(`[ControlsManager] Unsupported file type: ${file.type}`);
          this._flashError(zone, 'Unsupported file type. Please use WAV, MP3, FLAC, OGG, or WebM.');
        }
      }
    }, { signal });
  }

  // ---------------------------------------------------------------------------
  // File Picker
  // ---------------------------------------------------------------------------

  /**
   * Configure a file input element for audio file selection.
   * @param {string} inputId - ID of the <input type="file"> element
   * @param {function(File): void} onFile - Callback receiving the selected File
   */
  setupFilePicker(inputId, onFile) {
    const signal = this._abortController.signal;
    const input = document.getElementById(inputId);
    if (!input) {
      console.warn(`[ControlsManager] File input #${inputId} not found`);
      return;
    }

    input.accept = 'audio/*,.wav,.mp3,.flac,.ogg,.webm,.m4a,.aac';

    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        onFile(file);
      }
      // Reset so the same file can be re-selected
      input.value = '';
    }, { signal });
  }

  // ---------------------------------------------------------------------------
  // A/B Toggle
  // ---------------------------------------------------------------------------

  /**
   * Set up A/B comparison toggle control.
   * @param {function(string): void} onModeChange - Callback receiving 'A', 'B', or 'split'
   */
  setupABToggle(onModeChange) {
    const signal = this._abortController.signal;

    // Look for A/B toggle buttons
    const abContainer = document.querySelector('[data-ab-toggle]');
    if (!abContainer) return;

    abContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ab-mode]');
      if (!btn) return;

      const mode = btn.dataset.abMode;

      // Update active states
      const siblings = abContainer.querySelectorAll('[data-ab-mode]');
      for (const sib of siblings) {
        sib.classList.toggle('active', sib === btn);
      }

      onModeChange(mode);
    }, { signal });

    // Keyboard shortcut: Tab to cycle A/B
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const active = abContainer.querySelector('[data-ab-mode].active');
        if (!active) return;
        const modes = ['A', 'B', 'split'];
        const currentIdx = modes.indexOf(active.dataset.abMode);
        if (currentIdx === -1) return;
        e.preventDefault();
        const nextMode = modes[(currentIdx + 1) % modes.length];
        const nextBtn = abContainer.querySelector(`[data-ab-mode="${nextMode}"]`);
        if (nextBtn) {
          nextBtn.click();
        }
      }
    }, { signal });
  }

  // ---------------------------------------------------------------------------
  // Mode Selector
  // ---------------------------------------------------------------------------

  /**
   * Set up the processing mode selector (Live / Creator / Forensic / Batch).
   * @param {function(string): void} onModeChange - Callback receiving mode name
   */
  setupModeSelector(onModeChange) {
    const signal = this._abortController.signal;
    const container = document.querySelector('[data-mode-selector]');
    if (!container) return;

    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;

      const mode = btn.dataset.mode;

      // Update active state
      const siblings = container.querySelectorAll('[data-mode]');
      for (const sib of siblings) {
        sib.classList.toggle('active', sib === btn);
      }

      this._config.processingMode = mode;
      onModeChange(mode);
    }, { signal });
  }

  // ---------------------------------------------------------------------------
  // Volume Control
  // ---------------------------------------------------------------------------

  /**
   * Set up a volume slider control.
   * @param {function(number): void} onChange - Callback receiving volume (0..1)
   */
  setupVolumeControl(onChange) {
    const signal = this._abortController.signal;
    const slider = document.getElementById('volume') || document.querySelector('[data-volume]');
    if (!slider) return;

    slider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this._config.volume = vol;
      onChange(vol);

      // Update mute icon if present
      const icon = document.querySelector('[data-volume-icon]');
      if (icon) {
        if (vol === 0) icon.dataset.volumeState = 'muted';
        else if (vol < 0.5) icon.dataset.volumeState = 'low';
        else icon.dataset.volumeState = 'high';
      }
    }, { signal });
  }

  // ---------------------------------------------------------------------------
  // Config Management
  // ---------------------------------------------------------------------------

  /**
   * Return current configuration values.
   * @returns {Object}
   */
  getConfig() {
    return { ...this._config };
  }

  /**
   * Update all controls to match a given config object.
   * @param {Object} config - Key-value pairs to apply
   */
  setConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      this._config[key] = value;
    }

    // Sync sliders
    for (const [id, meta] of this._sliderMeta) {
      if (meta.key in config) {
        const slider = document.getElementById(id);
        if (slider) {
          slider.value = config[meta.key];
          this.updateSliderDisplay(id, config[meta.key], meta.unit);
        }
      }
    }

    // Sync toggles
    const toggles = document.querySelectorAll('[data-toggle]');
    for (const toggle of toggles) {
      const key = toggle.dataset.toggle;
      if (key in config) {
        if (toggle.type === 'checkbox') {
          toggle.checked = !!config[key];
        } else {
          toggle.value = config[key];
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Export Menu
  // ---------------------------------------------------------------------------

  /**
   * Position and show an export dropdown menu.
   * @param {HTMLElement} anchorEl - The element to anchor the menu to
   */
  showExportMenu(anchorEl) {
    this._exportMenuEl = document.getElementById('export-menu') || document.querySelector('[data-export-menu]');
    if (!this._exportMenuEl) return;

    this._positionMenu(this._exportMenuEl, anchorEl);
    this._exportMenuEl.classList.add('visible');
    this._exportMenuEl.setAttribute('aria-hidden', 'false');
  }

  /**
   * Hide the export dropdown menu.
   */
  hideExportMenu() {
    if (this._exportMenuEl) {
      this._exportMenuEl.classList.remove('visible');
      this._exportMenuEl.setAttribute('aria-hidden', 'true');
    }
  }

  // ---------------------------------------------------------------------------
  // Processing State
  // ---------------------------------------------------------------------------

  /**
   * Enable the process button(s).
   */
  enableProcessing() {
    const btns = document.querySelectorAll('[data-action="process"]');
    for (const btn of btns) {
      btn.disabled = false;
      btn.classList.remove('disabled');
    }
  }

  /**
   * Disable the process button(s).
   */
  disableProcessing() {
    const btns = document.querySelectorAll('[data-action="process"]');
    for (const btn of btns) {
      btn.disabled = true;
      btn.classList.add('disabled');
    }
  }

  // ---------------------------------------------------------------------------
  // Progress Display
  // ---------------------------------------------------------------------------

  /**
   * Show and update the progress display.
   * @param {number} percent - Progress percentage (0..100)
   * @param {string} stageName - Current processing stage name
   * @param {string} [eta] - Estimated time remaining (e.g., "~12s")
   */
  showProgress(percent, stageName, eta) {
    this._ensureProgress();
    if (!this._progressEl) return;

    this._progressEl.classList.add('visible');
    this._progressEl.setAttribute('aria-hidden', 'false');

    const bar = this._progressEl.querySelector('[data-progress-bar]');
    const label = this._progressEl.querySelector('[data-progress-label]');
    const etaEl = this._progressEl.querySelector('[data-progress-eta]');
    const percentEl = this._progressEl.querySelector('[data-progress-percent]');

    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      bar.style.transition = 'width 0.3s ease';
    }
    if (label) {
      label.textContent = stageName;
    }
    if (etaEl) {
      etaEl.textContent = eta ? `ETA: ${eta}` : '';
    }
    if (percentEl) {
      percentEl.textContent = `${Math.round(percent)}%`;
    }

    // Update ARIA
    this._progressEl.setAttribute('aria-valuenow', String(Math.round(percent)));
    this._progressEl.setAttribute('aria-label', `${stageName}: ${Math.round(percent)}%`);
  }

  /**
   * Hide the progress display.
   */
  hideProgress() {
    if (this._progressEl) {
      this._progressEl.classList.remove('visible');
      this._progressEl.setAttribute('aria-hidden', 'true');
    }
  }

  // ---------------------------------------------------------------------------
  // Stats Display
  // ---------------------------------------------------------------------------

  /**
   * Update the audio statistics display.
   * @param {Object} stats
   * @param {number} stats.peak - Peak amplitude (dBFS)
   * @param {number} stats.rms - RMS level (dBFS)
   * @param {number} stats.lufs - Integrated loudness (LUFS)
   * @param {number} stats.snr - Signal-to-noise ratio (dB)
   * @param {number} stats.noiseFloor - Noise floor (dBFS)
   */
  updateStats(stats) {
    const fields = {
      peak: { suffix: ' dBFS', decimals: 1 },
      rms: { suffix: ' dBFS', decimals: 1 },
      lufs: { suffix: ' LUFS', decimals: 1 },
      snr: { suffix: ' dB', decimals: 1 },
      noiseFloor: { suffix: ' dBFS', decimals: 1 },
    };

    for (const [key, fmt] of Object.entries(fields)) {
      if (stats[key] == null) continue;

      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) {
        const value = typeof stats[key] === 'number'
          ? stats[key].toFixed(fmt.decimals)
          : stats[key];
        el.textContent = `${value}${fmt.suffix}`;

        // Color coding for peak level
        if (key === 'peak') {
          el.classList.toggle('warning', stats[key] > -3);
          el.classList.toggle('danger', stats[key] > -0.5);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Batch UI
  // ---------------------------------------------------------------------------

  /**
   * Update the batch processing queue display.
   * @param {Array<{name: string, status: string, progress?: number}>} items
   */
  updateBatchUI(items) {
    const container = document.getElementById('batch-queue') || document.querySelector('[data-batch-queue]');
    if (!container) return;

    // Clear existing items
    container.textContent = '';

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const el = document.createElement('div');
      const safeStatus = String(item.status).replace(/[^a-z]/g, '');
      el.className = `batch-item batch-item--${safeStatus}`;
      el.dataset.batchIndex = String(i);

      // Status icon
      const iconMap = {
        pending: '\u25CB',    // circle
        processing: '\u25D4', // half-filled circle
        completed: '\u2713',  // checkmark
        error: '\u2717',      // cross
      };

      // Build batch item using safe DOM methods to prevent XSS
      const iconSpan = document.createElement('span');
      iconSpan.className = 'batch-item__icon';
      iconSpan.textContent = iconMap[item.status] || '\u25CB';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'batch-item__name';
      nameSpan.title = item.name;
      nameSpan.textContent = item.name;

      const statusSpan = document.createElement('span');
      statusSpan.className = 'batch-item__status';
      statusSpan.textContent = item.status;

      el.appendChild(iconSpan);
      el.appendChild(nameSpan);
      el.appendChild(statusSpan);

      if (item.status === 'processing' && item.progress != null) {
        const progressDiv = document.createElement('div');
        progressDiv.className = 'batch-item__progress';
        progressDiv.style.width = `${Math.max(0, Math.min(100, item.progress))}%`;
        el.appendChild(progressDiv);
      }

      container.appendChild(el);
    }
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------

  /**
   * Show a modal dialog.
   * @param {string} title - Modal title
   * @param {string|HTMLElement} body - Modal body text (plain text) or pre-built DOM element
   * @param {Array<{label: string, className?: string, onClick: function}>} actions - Action buttons
   */
  showModal(title, body, actions) {
    this._ensureModal();

    const titleEl = this._modalEl.querySelector('[data-modal-title]');
    const bodyEl = this._modalEl.querySelector('[data-modal-body]');
    const actionsEl = this._modalEl.querySelector('[data-modal-actions]');

    if (titleEl) titleEl.textContent = title;
    if (bodyEl) {
      bodyEl.textContent = '';
      if (body instanceof HTMLElement) {
        bodyEl.appendChild(body);
      } else {
        bodyEl.textContent = body;
      }
    }

    if (actionsEl) {
      actionsEl.textContent = '';
      for (const action of actions || []) {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.className = `modal__btn ${action.className || ''}`.trim();
        btn.addEventListener('click', () => {
          if (action.onClick) action.onClick();
          this.hideModal();
        });
        actionsEl.appendChild(btn);
      }
    }

    this._modalEl.classList.add('visible');
    this._modalEl.setAttribute('aria-hidden', 'false');
    this._modalBackdropEl.classList.add('visible');

    // Focus trap: focus the first button
    const firstBtn = this._modalEl.querySelector('button');
    if (firstBtn) firstBtn.focus();
  }

  /**
   * Hide the modal dialog.
   */
  hideModal() {
    if (this._modalEl) {
      this._modalEl.classList.remove('visible');
      this._modalEl.setAttribute('aria-hidden', 'true');
    }
    if (this._modalBackdropEl) {
      this._modalBackdropEl.classList.remove('visible');
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /**
   * Tear down all event listeners and DOM modifications.
   */
  destroy() {
    this._abortController.abort();
    window.removeEventListener('resize', this._boundOnResize);

    if (this._modalEl && this._modalEl.parentNode) {
      this._modalEl.parentNode.removeChild(this._modalEl);
    }
    if (this._modalBackdropEl && this._modalBackdropEl.parentNode) {
      this._modalBackdropEl.parentNode.removeChild(this._modalBackdropEl);
    }

    this._sliderMeta.clear();
    this._presets.clear();
    this._config = {};
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Format a slider value with its unit.
   * @param {number} value
   * @param {string} unit - e.g., 'dB', '%', 'Hz', 'ms', 'x'
   * @returns {string}
   */
  _formatValue(value, unit) {
    switch (unit) {
      case '%':
        return `${Math.round(value)}%`;
      case 'dB':
        return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
      case 'Hz':
        if (value >= 1000) return `${(value / 1000).toFixed(1)} kHz`;
        return `${Math.round(value)} Hz`;
      case 'ms':
        if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
        return `${Math.round(value)} ms`;
      case 'x':
        return `${value.toFixed(1)}x`;
      case 's':
        return `${value.toFixed(1)}s`;
      default:
        return unit ? `${value} ${unit}` : String(value);
    }
  }

  /**
   * Smart menu positioning: ensures the menu stays within viewport bounds.
   * @param {HTMLElement} menu - The menu element to position
   * @param {HTMLElement} anchor - The anchor element to position relative to
   */
  _positionMenu(menu, anchor) {
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const gap = 4;

    // Default: position below the anchor, aligned to its left edge
    let top = anchorRect.bottom + gap;
    let left = anchorRect.left;

    // If menu extends beyond right edge, align to right edge of anchor
    if (left + menuRect.width > viewportW - gap) {
      left = anchorRect.right - menuRect.width;
    }

    // If menu extends below viewport, position above anchor
    if (top + menuRect.height > viewportH - gap) {
      top = anchorRect.top - menuRect.height - gap;
    }

    // Clamp to viewport
    left = Math.max(gap, Math.min(left, viewportW - menuRect.width - gap));
    top = Math.max(gap, Math.min(top, viewportH - menuRect.height - gap));

    menu.style.position = 'fixed';
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  }

  /**
   * Validate that a file has an audio MIME type or audio extension.
   * @param {File} file
   * @returns {boolean}
   */
  _isAudioFile(file) {
    if (file.type && file.type.startsWith('audio/')) return true;
    const ext = file.name.split('.').pop().toLowerCase();
    return ['wav', 'mp3', 'flac', 'ogg', 'webm', 'm4a', 'aac', 'opus', 'wma'].includes(ext);
  }

  /**
   * Briefly flash an error message on a given element.
   * @param {HTMLElement} el
   * @param {string} message
   */
  _flashError(el, message) {
    const msgEl = document.createElement('div');
    msgEl.className = 'flash-error';
    msgEl.textContent = message;
    msgEl.style.cssText = `
      position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
      background: rgba(255, 50, 50, 0.9); color: #fff; padding: 6px 14px;
      border-radius: 6px; font-size: 13px; pointer-events: none;
      animation: flash-fade 2.5s ease forwards; z-index: 100;
    `;

    // Ensure the parent is positioned
    const originalPosition = el.style.position;
    if (!originalPosition || originalPosition === 'static') {
      el.style.position = 'relative';
    }

    el.appendChild(msgEl);

    setTimeout(() => {
      if (msgEl.parentNode) msgEl.parentNode.removeChild(msgEl);
      if (originalPosition === '' || originalPosition === 'static') {
        el.style.position = originalPosition;
      }
    }, 2600);
  }

  /**
   * Dispatch a custom config change event.
   * @param {string} key
   * @param {*} value
   */
  _dispatchConfigChange(key, value) {
    document.dispatchEvent(new CustomEvent('voiceisolate:configchange', {
      detail: { key, value, config: this.getConfig() },
    }));
  }

  /**
   * Global keyboard shortcut handler.
   * @param {KeyboardEvent} e
   */
  _handleKeyboard(e) {
    // Escape to close modals or menus
    if (e.key === 'Escape') {
      if (this._modalEl && this._modalEl.classList.contains('visible')) {
        this.hideModal();
        e.preventDefault();
        return;
      }
      if (this._exportMenuEl && this._exportMenuEl.classList.contains('visible')) {
        this.hideExportMenu();
        e.preventDefault();
        return;
      }
    }

    // Space to toggle playback (only if not focused on an input)
    if (e.key === ' ' && e.target === document.body) {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('voiceisolate:toggleplay'));
    }
  }

  /**
   * Window resize handler - recalculate menu positions etc.
   */
  _onResize() {
    if (this._exportMenuEl && this._exportMenuEl.classList.contains('visible')) {
      this.hideExportMenu();
    }
  }

  /**
   * Ensure the modal DOM structure exists.
   * If the page already contains a [data-modal] element, use it.
   * Otherwise, create one dynamically.
   */
  _ensureModal() {
    this._modalEl = document.querySelector('[data-modal]');
    this._modalBackdropEl = document.querySelector('[data-modal-backdrop]');

    if (!this._modalEl) {
      // Create backdrop
      this._modalBackdropEl = document.createElement('div');
      this._modalBackdropEl.className = 'modal-backdrop';
      this._modalBackdropEl.dataset.modalBackdrop = '';
      this._modalBackdropEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this._modalBackdropEl);

      // Create modal
      this._modalEl = document.createElement('div');
      this._modalEl.className = 'modal';
      this._modalEl.dataset.modal = '';
      this._modalEl.setAttribute('role', 'dialog');
      this._modalEl.setAttribute('aria-modal', 'true');
      this._modalEl.setAttribute('aria-hidden', 'true');
      // Create header
      const headerDiv = document.createElement('div');
      headerDiv.className = 'modal__header';
      const titleH3 = document.createElement('h3');
      titleH3.setAttribute('data-modal-title', '');
      const closeBtn = document.createElement('button');
      closeBtn.className = 'modal__close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '×';
      headerDiv.appendChild(titleH3);
      headerDiv.appendChild(closeBtn);

      // Create body
      const bodyDiv = document.createElement('div');
      bodyDiv.className = 'modal__body';
      bodyDiv.setAttribute('data-modal-body', '');

      // Create actions
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'modal__actions';
      actionsDiv.setAttribute('data-modal-actions', '');

      this._modalEl.appendChild(headerDiv);
      this._modalEl.appendChild(bodyDiv);
      this._modalEl.appendChild(actionsDiv);

      document.body.appendChild(this._modalEl);

      // Close button
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.hideModal(), {
          signal: this._abortController.signal,
        });
      }

      // Backdrop click closes modal
      this._modalBackdropEl.addEventListener('click', () => this.hideModal(), {
        signal: this._abortController.signal,
      });
    }
  }

  /**
   * Ensure the progress display DOM element is referenced.
   */
  _ensureProgress() {
    this._progressEl =
      document.getElementById('progress') ||
      document.querySelector('[data-progress]');
  }

  /**
   * Escape HTML entities to prevent XSS in dynamic content.
   * @param {string} str
   * @returns {string}
   */
  _escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

export default ControlsManager;
