/**
 * VoiceIsolate-Pro — Region Selection
 * Handles time selection (waveform) and time-frequency rectangle (spectrogram)
 * Requirements per issue §3:
 * - visible bounds
 * - draggable resize handles
 * - selected-region playback
 * - zoom-to-selection
 * - clear/remove selection
 * - precise timestamp display
 */

export class RegionSelection {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      sampleRate: 48000,
      duration: 0,
      mode: 'time', // time | time_freq
      minDuration: 0.05, // seconds
      handleSize: 10,
      touchHandleSize: 20,
      ...options,
    };
    this._selection = null; // { id, start, end, freqLow, freqHigh }
    this._isDragging = false;
    this._dragHandle = null; // 'start' | 'end' | 'move' | 'freqLow' | 'freqHigh' | null
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragStartSelection = null;
    this._listeners = new Map();
    this._overlay = null;
    this._handles = {};
    this._timestampEl = null;

    this._initDOM();
    this._bindEvents();
  }

  _initDOM() {
    // Create overlay for selection visualization
    this._overlay = document.createElement('div');
    this._overlay.className = 'vip-region-selection';
    this._overlay.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      pointer-events: none;
      z-index: 10;
      display: none;
    `;
    this._overlay.innerHTML = `
      <div class="vip-region-bounds" style="
        position: absolute;
        top: 0;
        bottom: 0;
        border: 2px solid #9b6cff;
        background: rgba(155,108,255,0.14);
        box-shadow: 0 0 0 1px rgba(155,108,255,0.32), 0 0 20px rgba(155,108,255,0.15);
        pointer-events: auto;
        cursor: move;
      ">
        <div class="vip-region-handle vip-region-handle-start" data-handle="start" style="
          position: absolute;
          left: -6px;
          top: 0;
          bottom: 0;
          width: 12px;
          background: #9b6cff;
          cursor: ew-resize;
          border-radius: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <div style="width: 2px; height: 20px; background: white; border-radius: 1px;"></div>
        </div>
        <div class="vip-region-handle vip-region-handle-end" data-handle="end" style="
          position: absolute;
          right: -6px;
          top: 0;
          bottom: 0;
          width: 12px;
          background: #9b6cff;
          cursor: ew-resize;
          border-radius: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <div style="width: 2px; height: 20px; background: white; border-radius: 1px;"></div>
        </div>
        <div class="vip-region-label" style="
          position: absolute;
          top: -24px;
          left: 0;
          background: #9b6cff;
          color: white;
          font: 10px/1 ui-monospace, monospace;
          padding: 2px 6px;
          border-radius: 3px;
          white-space: nowrap;
          pointer-events: none;
        "></div>
      </div>
    `;

    // Ensure container is positioned
    const style = window.getComputedStyle(this.container);
    if (style.position === 'static') {
      this.container.style.position = 'relative';
    }
    this.container.appendChild(this._overlay);

    this._boundsEl = this._overlay.querySelector('.vip-region-bounds');
    this._labelEl = this._overlay.querySelector('.vip-region-label');
    this._handles.start = this._overlay.querySelector('[data-handle="start"]');
    this._handles.end = this._overlay.querySelector('[data-handle="end"]');

    // Timestamp display
    this._timestampEl = document.createElement('div');
    this._timestampEl.className = 'vip-region-timestamp';
    this._timestampEl.style.cssText = `
      position: absolute;
      bottom: -22px;
      left: 0;
      font: 10px/1 ui-monospace, monospace;
      color: #8d9aaa;
      background: rgba(7,11,16,0.9);
      padding: 2px 6px;
      border-radius: 3px;
      border: 1px solid #1d2a34;
      white-space: nowrap;
      pointer-events: none;
      display: none;
    `;
    this._boundsEl.appendChild(this._timestampEl);

    // For touch devices, larger handles
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      this._handles.start.style.width = '24px';
      this._handles.start.style.left = '-12px';
      this._handles.end.style.width = '24px';
      this._handles.end.style.right = '-12px';
    }
  }

  _bindEvents() {
    // Mouse/touch events for creating selection and dragging
    const onPointerDown = (e, handle = null) => {
      const point = this._getPoint(e);
      if (!point) return;

      if (handle) {
        this._isDragging = true;
        this._dragHandle = handle;
        this._dragStartX = point.x;
        this._dragStartY = point.y;
        this._dragStartSelection = this._selection ? { ...this._selection } : null;
        e.preventDefault();
        e.stopPropagation();
        this.container.setPointerCapture?.(e.pointerId);
        return;
      }

      // If clicking on existing selection, start move
      if (this._selection && this._isInsideSelection(point)) {
        this._isDragging = true;
        this._dragHandle = 'move';
        this._dragStartX = point.x;
        this._dragStartY = point.y;
        this._dragStartSelection = { ...this._selection };
        e.preventDefault();
        return;
      }

      // Start new selection
      const time = this._xToTime(point.x);
      this._selection = {
        id: `sel-${Date.now()}`,
        start: time,
        end: time,
        freqLow: 0,
        freqHigh: 1,
      };
      this._isDragging = true;
      this._dragHandle = 'end';
      this._dragStartX = point.x;
      this._dragStartY = point.y;
      this._dragStartSelection = { ...this._selection };
      this._updateDOM();
    };

    const onPointerMove = (e) => {
      if (!this._isDragging) return;
      const point = this._getPoint(e);
      if (!point) return;

      const deltaX = point.x - this._dragStartX;
      const deltaTime = this._xToTimeDelta(deltaX);

      if (!this._dragStartSelection) return;

      let newSel = { ...this._dragStartSelection };

      switch (this._dragHandle) {
        case 'start':
          newSel.start = Math.max(0, this._dragStartSelection.start + deltaTime);
          if (newSel.start > newSel.end - this.options.minDuration) {
            newSel.start = newSel.end - this.options.minDuration;
          }
          break;
        case 'end':
          newSel.end = Math.min(this.options.duration, this._dragStartSelection.end + deltaTime);
          if (newSel.end < newSel.start + this.options.minDuration) {
            newSel.end = newSel.start + this.options.minDuration;
          }
          break;
        case 'move': {
          const dur = this._dragStartSelection.end - this._dragStartSelection.start;
          newSel.start = Math.max(0, Math.min(this.options.duration - dur, this._dragStartSelection.start + deltaTime));
          newSel.end = newSel.start + dur;
          break;
        }
        default: {
          // Creating new selection
          const curTime = this._xToTime(point.x);
          newSel.start = Math.min(this._dragStartSelection.start, curTime);
          newSel.end = Math.max(this._dragStartSelection.start, curTime);
          break;
        }
      }

      // For spectrogram mode, handle freq
      if (this.options.mode === 'time_freq') {
        const deltaY = point.y - this._dragStartY;
        const deltaFreq = -deltaY / this.container.clientHeight; // invert Y
        if (this._dragHandle === 'freqLow') {
          newSel.freqLow = Math.max(0, Math.min(1, this._dragStartSelection.freqLow + deltaFreq));
        } else if (this._dragHandle === 'freqHigh') {
          newSel.freqHigh = Math.max(0, Math.min(1, this._dragStartSelection.freqHigh + deltaFreq));
        } else if (this._dragHandle === 'move') {
          // freq move already handled via time move? For simplicity, keep freq same on move
        } else {
          // New rect selection
          const curFreq = this._yToFreq(point.y);
          newSel.freqLow = Math.min(this._dragStartSelection.freqLow, curFreq);
          newSel.freqHigh = Math.max(this._dragStartSelection.freqLow, curFreq);
        }
      }

      this._selection = newSel;
      this._updateDOM();
      this._emit('changing', this._selection);
    };

    const onPointerUp = (e) => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this._dragHandle = null;
      this.container.releasePointerCapture?.(e.pointerId);

      // Validate selection
      if (this._selection) {
        const dur = this._selection.end - this._selection.start;
        if (dur < this.options.minDuration) {
          // Too small, clear
          this.clear();
          return;
        }
        this._emit('selected', this._selection);
      }
    };

    // Bind to container and handles
    this.container.addEventListener('pointerdown', (e) => onPointerDown(e, null));
    this._handles.start.addEventListener('pointerdown', (e) => onPointerDown(e, 'start'));
    this._handles.end.addEventListener('pointerdown', (e) => onPointerDown(e, 'end'));
    this._boundsEl.addEventListener('pointerdown', (e) => {
      // Check if handle
      if (e.target.closest('[data-handle]')) return;
      onPointerDown(e, 'move');
    });

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    // Keyboard nudging for accessibility (Browser/Desktop)
    this.container.addEventListener('keydown', (e) => {
      if (!this._selection) return;
      const step = e.shiftKey ? 0.1 : 0.01;
      let changed = false;
      switch (e.key) {
        case 'ArrowLeft':
          if (e.metaKey || e.ctrlKey) {
            this._selection.start = Math.max(0, this._selection.start - step);
            this._selection.end = Math.max(this._selection.start + this.options.minDuration, this._selection.end - step);
          } else {
            this._selection.start = Math.max(0, this._selection.start - step);
            this._selection.end = Math.max(this._selection.start + this.options.minDuration, this._selection.end);
          }
          changed = true;
          break;
        case 'ArrowRight':
          if (e.metaKey || e.ctrlKey) {
            this._selection.start = Math.min(this.options.duration - this.options.minDuration, this._selection.start + step);
            this._selection.end = Math.min(this.options.duration, this._selection.end + step);
          } else {
            this._selection.end = Math.min(this.options.duration, this._selection.end + step);
          }
          changed = true;
          break;
        case 'Escape':
          this.clear();
          break;
      }
      if (changed) {
        e.preventDefault();
        this._updateDOM();
        this._emit('selected', this._selection);
      }
    });

    // Make container focusable for keyboard
    if (!this.container.hasAttribute('tabindex')) {
      this.container.setAttribute('tabindex', '0');
    }
  }

  _getPoint(e) {
    const rect = this.container.getBoundingClientRect();
    const x = (e.clientX ?? e.touches?.[0]?.clientX) - rect.left;
    const y = (e.clientY ?? e.touches?.[0]?.clientY) - rect.top;
    if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
      // Allow slightly outside for handles
      if (!this._isDragging) return null;
    }
    return { x, y };
  }

  _xToTime(x) {
    const rect = this.container.getBoundingClientRect();
    const norm = x / rect.width;
    return norm * this.options.duration;
  }

  _xToTimeDelta(deltaX) {
    const rect = this.container.getBoundingClientRect();
    const normDelta = deltaX / rect.width;
    return normDelta * this.options.duration;
  }

  _yToFreq(y) {
    const rect = this.container.getBoundingClientRect();
    // y=0 top = high freq (1), bottom = low freq (0)
    return 1 - y / rect.height;
  }

  _isInsideSelection(point) {
    if (!this._selection) return false;
    const rect = this.container.getBoundingClientRect();
    const startX = (this._selection.start / this.options.duration) * rect.width;
    const endX = (this._selection.end / this.options.duration) * rect.width;
    return point.x >= startX && point.x <= endX;
  }

  _updateDOM() {
    if (!this._selection) {
      this._overlay.style.display = 'none';
      return;
    }
    this._overlay.style.display = 'block';
    const rect = this.container.getBoundingClientRect();
    const startX = (this._selection.start / this.options.duration) * rect.width;
    const endX = (this._selection.end / this.options.duration) * rect.width;
    const left = Math.min(startX, endX);
    const width = Math.abs(endX - startX);

    this._boundsEl.style.left = `${left}px`;
    this._boundsEl.style.width = `${width}px`;

    // Freq for spectrogram
    if (this.options.mode === 'time_freq' && this._selection.freqLow !== undefined) {
      const top = (1 - this._selection.freqHigh) * rect.height;
      const bottom = (1 - this._selection.freqLow) * rect.height;
      this._boundsEl.style.top = `${top}px`;
      this._boundsEl.style.height = `${bottom - top}px`;
    } else {
      this._boundsEl.style.top = '0';
      this._boundsEl.style.height = '100%';
    }

    // Label and timestamp
    const dur = this._selection.end - this._selection.start;
    this._labelEl.textContent = `${this._formatTime(this._selection.start)} – ${this._formatTime(this._selection.end)} (${dur.toFixed(2)}s)`;
    this._timestampEl.textContent = `${this._formatTime(this._selection.start)} → ${this._formatTime(this._selection.end)}`;
    this._timestampEl.style.display = 'block';
  }

  _formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setSelection(selection) {
    this._selection = selection ? { ...selection } : null;
    this._updateDOM();
    if (selection) this._emit('selected', selection);
  }

  getSelection() {
    return this._selection ? { ...this._selection } : null;
  }

  clear() {
    this._selection = null;
    this._updateDOM();
    this._emit('cleared', null);
  }

  setDuration(duration) {
    this.options.duration = duration;
    if (this._selection) {
      // Clamp
      this._selection.start = Math.max(0, Math.min(duration, this._selection.start));
      this._selection.end = Math.max(this._selection.start, Math.min(duration, this._selection.end));
      this._updateDOM();
    }
  }

  setMode(mode) {
    this.options.mode = mode;
  }

  zoomToSelection() {
    if (!this._selection) return null;
    // Return zoom range to fit selection with some padding
    const pad = (this._selection.end - this._selection.start) * 0.1;
    return {
      start: Math.max(0, this._selection.start - pad),
      end: Math.min(this.options.duration, this._selection.end + pad),
    };
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(payload); } catch {}
      }
    }
  }

  dispose() {
    this._overlay?.remove();
    this._timestampEl?.remove();
  }
}

export default RegionSelection;
