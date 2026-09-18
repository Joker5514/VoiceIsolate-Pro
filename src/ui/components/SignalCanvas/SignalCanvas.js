/**
 * VoiceIsolate-Pro — Signal Canvas
 * The center of the product per issue §3
 * - waveform
 * - spectrogram
 * - synchronized timeline
 * - zoom / pan
 * - playback cursor
 * - region markers
 * - analysis overlays
 * - Waveform / Spectrogram / Combined views
 * - Direct signal interaction: click+drag time selection, rect time-freq selection
 */

import { WaveformLayer } from '../WaveformLayer/WaveformLayer.js';
import { SpectrogramLayer } from '../SpectrogramLayer/SpectrogramLayer.js';
import { RegionSelection } from '../RegionSelection/RegionSelection.js';
import { AnalysisOverlay } from '../AnalysisOverlay/AnalysisOverlay.js';
import { Tokens, ComparisonModes } from '../../tokens/design-tokens.js';

export class SignalCanvas {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      sampleRate: 48000,
      duration: 0,
      viewMode: 'combined', // waveform | spectrogram | combined
      comparisonMode: ComparisonModes.PROCESSED,
      ...options,
    };
    this._channelData = null;
    this._duration = 0;
    this._viewStart = 0;
    this._viewEnd = 1;
    this._playbackTime = 0;
    this._regions = [];
    this._listeners = new Map();
    this._layers = {};
    this._selection = null;

    this._initDOM();
    this._initLayers();
    this._bindEvents();
  }

  _initDOM() {
    this.container.className = 'vip-signal-canvas';
    this.container.style.cssText = `
      position: relative;
      width: 100%;
      min-height: 320px;
      background: ${Tokens.canvas.bg};
      border: 1px solid ${Tokens.border.subtle};
      border-radius: ${Tokens.radius.xl};
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;

    this.container.innerHTML = `
      <div data-header style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid ${Tokens.border.subtle}; background:${Tokens.surface.panel};">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:6px; height:6px; border-radius:50%; background:${Tokens.success.default}; box-shadow:0 0 0 4px ${Tokens.success.wash};"></span>
          <span style="font:600 11px/1 ${Tokens.font.mono}; letter-spacing:0.08em; text-transform:uppercase; color:${Tokens.text.dim};">Signal Canvas</span>
          <span data-state style="font:500 10px/1 ${Tokens.font.mono}; padding:2px 6px; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.full}; color:${Tokens.text.dim};">Idle</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button data-view="waveform" aria-pressed="false" style="min-height:28px; padding:4px 10px; font:500 11px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Waveform</button>
          <button data-view="spectrogram" aria-pressed="false" style="min-height:28px; padding:4px 10px; font:500 11px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Spectrogram</button>
          <button data-view="combined" aria-pressed="true" style="min-height:28px; padding:4px 10px; font:500 11px/1 ${Tokens.font.ui}; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.primary}; cursor:pointer;">Combined</button>
        </div>
      </div>
      <div data-canvas-stack style="position:relative; flex:1; min-height:240px; overflow:hidden;">
        <canvas data-waveform style="position:absolute; inset:0; width:100%; height:50%;"></canvas>
        <canvas data-spectrogram style="position:absolute; left:0; right:0; top:50%; bottom:0; width:100%; height:50%;"></canvas>
        <div data-overlay-host style="position:absolute; inset:0; pointer-events:none;"></div>
        <div data-selection-host style="position:absolute; inset:0;"></div>
        <div data-cursor style="position:absolute; top:0; bottom:0; width:2px; background:${Tokens.text.primary}; pointer-events:none; z-index:8; display:none;">
          <div style="position:absolute; top:0; left:50%; transform:translateX(-50%); width:10px; height:10px; background:${Tokens.text.primary}; border-radius:50%;"></div>
        </div>
        <div data-timeline style="position:absolute; bottom:0; left:0; right:0; height:24px; background:rgba(13,19,27,0.9); border-top:1px solid ${Tokens.border.subtle}; display:flex; align-items:center; padding:0 8px; font:500 10px/1 ${Tokens.font.mono}; color:${Tokens.text.dim}; z-index:9;">
          <span data-time>0:00 / 0:00</span>
          <span style="margin-left:auto; display:flex; gap:8px;">
            <button data-action="zoomIn" style="width:24px; height:24px; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:4px; color:${Tokens.text.secondary}; cursor:pointer;">+</button>
            <button data-action="zoomOut" style="width:24px; height:24px; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:4px; color:${Tokens.text.secondary}; cursor:pointer;">−</button>
            <button data-action="zoomFit" style="min-height:24px; padding:0 8px; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:4px; color:${Tokens.text.secondary}; cursor:pointer; font:500 10px/1 ${Tokens.font.ui};">Fit</button>
          </span>
        </div>
      </div>
    `;

    this._els = {
      headerState: this.container.querySelector('[data-state]'),
      waveformCanvas: this.container.querySelector('[data-waveform]'),
      spectrogramCanvas: this.container.querySelector('[data-spectrogram]'),
      overlayHost: this.container.querySelector('[data-overlay-host]'),
      selectionHost: this.container.querySelector('[data-selection-host]'),
      cursor: this.container.querySelector('[data-cursor]'),
      timeline: this.container.querySelector('[data-timeline]'),
      timeLabel: this.container.querySelector('[data-time]'),
      viewBtns: {
        waveform: this.container.querySelector('[data-view="waveform"]'),
        spectrogram: this.container.querySelector('[data-view="spectrogram"]'),
        combined: this.container.querySelector('[data-view="combined"]'),
      },
    };
  }

  _initLayers() {
    // Waveform
    this._layers.waveform = new WaveformLayer(this._els.waveformCanvas, {
      sampleRate: this.options.sampleRate,
      comparisonMode: this.options.comparisonMode,
    });

    // Spectrogram
    this._layers.spectrogram = new SpectrogramLayer(this._els.spectrogramCanvas, {
      sampleRate: this.options.sampleRate,
    });

    // Analysis overlay — shared host but positioned over both
    this._layers.analysis = new AnalysisOverlay(this._els.overlayHost, {
      duration: this._duration,
    });

    // Region selection — host over canvas stack
    this._layers.selection = new RegionSelection(this._els.selectionHost, {
      duration: this._duration,
      mode: 'time',
    });

    // Forward selection events
    this._layers.selection.on('selected', (sel) => {
      this._selection = sel;
      this._emit('regionSelected', sel);
    });
    this._layers.selection.on('changing', (sel) => {
      this._emit('regionChanging', sel);
    });
    this._layers.selection.on('cleared', () => {
      this._selection = null;
      this._emit('regionCleared');
    });

    this._layers.analysis.on('regionClicked', (region) => {
      // Convert region to selection
      const sel = {
        id: region.id,
        start: region.start,
        end: region.end,
        freqLow: region.freqLow || 0,
        freqHigh: region.freqHigh || 1,
        type: region.type,
      };
      this._layers.selection.setSelection(sel);
      this._selection = sel;
      this._emit('regionSelected', sel);
    });
  }

  _bindEvents() {
    // View mode switching
    for (const [mode, btn] of Object.entries(this._els.viewBtns)) {
      btn.addEventListener('click', () => this.setViewMode(mode));
    }

    // Zoom
    this.container.querySelector('[data-action="zoomIn"]').addEventListener('click', () => this._zoom(0.8));
    this.container.querySelector('[data-action="zoomOut"]').addEventListener('click', () => this._zoom(1.25));
    this.container.querySelector('[data-action="zoomFit"]').addEventListener('click', () => this._zoomFit());

    // Wheel zoom
    this._els.selectionHost.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.1 : 0.9;
        this._zoom(factor, e.clientX);
      }
    }, { passive: false });

    // Pan via drag (middle mouse or shift+drag)
    let isPanning = false;
    let panStartX = 0;
    let panStartView = null;
    this._els.selectionHost.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.shiftKey && e.button === 0)) {
        isPanning = true;
        panStartX = e.clientX;
        panStartView = { start: this._viewStart, end: this._viewEnd };
        e.preventDefault();
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!isPanning) return;
      const rect = this._els.selectionHost.getBoundingClientRect();
      const deltaNorm = (e.clientX - panStartX) / rect.width;
      const viewSpan = panStartView.end - panStartView.start;
      let newStart = panStartView.start - deltaNorm * viewSpan;
      let newEnd = panStartView.end - deltaNorm * viewSpan;
      // Clamp
      if (newStart < 0) {
        newEnd -= newStart;
        newStart = 0;
      }
      if (newEnd > 1) {
        newStart -= (newEnd - 1);
        newEnd = 1;
      }
      this._viewStart = Math.max(0, newStart);
      this._viewEnd = Math.min(1, newEnd);
      this._updateLayersView();
    });
    window.addEventListener('pointerup', () => { isPanning = false; });

    // Pinch zoom for touch
    let lastPinchDist = 0;
    this._els.selectionHost.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    });
    this._els.selectionHost.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDist > 0) {
          const factor = lastPinchDist / dist;
          const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          this._zoom(factor, centerX);
        }
        lastPinchDist = dist;
      }
    }, { passive: false });
    this._els.selectionHost.addEventListener('touchend', () => { lastPinchDist = 0; });
  }

  _zoom(factor, centerClientX = null) {
    const span = this._viewEnd - this._viewStart;
    const newSpan = Math.max(0.001, Math.min(1, span * factor));
    let centerNorm = 0.5;
    if (centerClientX != null) {
      const rect = this._els.selectionHost.getBoundingClientRect();
      centerNorm = (centerClientX - rect.left) / rect.width;
      centerNorm = centerNorm * span + this._viewStart;
    } else {
      centerNorm = (this._viewStart + this._viewEnd) / 2;
    }
    let newStart = centerNorm - newSpan * (centerClientX != null ? (centerClientX - this._els.selectionHost.getBoundingClientRect().left) / this._els.selectionHost.getBoundingClientRect().width : 0.5);
    // Simpler: center around centerNorm
    newStart = centerNorm - newSpan / 2;
    let newEnd = newStart + newSpan;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    this._viewStart = Math.max(0, newStart);
    this._viewEnd = Math.min(1, newEnd);
    this._updateLayersView();
  }

  _zoomFit() {
    this._viewStart = 0;
    this._viewEnd = 1;
    this._updateLayersView();
  }

  _updateLayersView() {
    this._layers.waveform.setViewRange(this._viewStart, this._viewEnd);
    this._layers.spectrogram.setViewRange(this._viewStart, this._viewEnd);
    // Analysis overlay doesn't need view range — it uses duration mapping, but we could filter
    this._emit('viewChanged', { start: this._viewStart, end: this._viewEnd });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setAudioData(channelData, duration, sampleRate = 48000) {
    this._channelData = channelData;
    this._duration = duration || (channelData?.[0]?.length / sampleRate) || 0;
    this.options.sampleRate = sampleRate;
    this.options.duration = this._duration;

    this._layers.waveform.setData(channelData, this._duration, sampleRate);
    this._layers.spectrogram.setAudioData(channelData, sampleRate);
    this._layers.analysis.setDuration(this._duration);
    this._layers.selection.setDuration(this._duration);

    this._els.timeLabel.textContent = `0:00 / ${this._formatTime(this._duration)}`;
    this._els.headerState.textContent = 'Ready';
    this._els.headerState.style.background = Tokens.success.wash;
    this._els.headerState.style.color = Tokens.success.default;
  }

  setSpectrogramData(data) {
    this._layers.spectrogram.setSpectrogramData(data, this._duration);
  }

  setRegions(regions) {
    this._regions = regions;
    this._layers.analysis.setRegions(regions);
  }

  setPlaybackTime(time) {
    this._playbackTime = time;
    const frac = this._duration > 0 ? time / this._duration : 0;
    const stackWidth = this._els.selectionHost.clientWidth;
    this._els.cursor.style.display = 'block';
    this._els.cursor.style.left = `${frac * 100}%`;
    this._els.timeLabel.textContent = `${this._formatTime(time)} / ${this._formatTime(this._duration)}`;

    // Auto-scroll if playback outside view
    if (frac < this._viewStart || frac > this._viewEnd) {
      const span = this._viewEnd - this._viewStart;
      this._viewStart = Math.max(0, frac - span * 0.2);
      this._viewEnd = Math.min(1, this._viewStart + span);
      this._updateLayersView();
    }
  }

  setViewMode(mode) {
    this.options.viewMode = mode;
    for (const [m, btn] of Object.entries(this._els.viewBtns)) {
      const active = m === mode;
      btn.setAttribute('aria-pressed', String(active));
      btn.style.background = active ? Tokens.surface.raised : 'transparent';
      btn.style.color = active ? Tokens.text.primary : Tokens.text.secondary;
      btn.style.borderColor = active ? Tokens.border.strong : Tokens.border.subtle;
    }

    // Show/hide canvases
    if (mode === 'waveform') {
      this._els.waveformCanvas.style.height = '100%';
      this._els.spectrogramCanvas.style.display = 'none';
      this._layers.selection.setMode('time');
    } else if (mode === 'spectrogram') {
      this._els.waveformCanvas.style.display = 'none';
      this._els.spectrogramCanvas.style.height = '100%';
      this._els.spectrogramCanvas.style.top = '0';
      this._layers.selection.setMode('time_freq');
    } else {
      this._els.waveformCanvas.style.display = 'block';
      this._els.waveformCanvas.style.height = '50%';
      this._els.spectrogramCanvas.style.display = 'block';
      this._els.spectrogramCanvas.style.height = '50%';
      this._els.spectrogramCanvas.style.top = '50%';
      this._layers.selection.setMode('time');
    }

    this._emit('viewModeChanged', mode);
  }

  setComparisonMode(mode) {
    this.options.comparisonMode = mode;
    this._layers.waveform.setComparisonMode(mode);
  }

  getSelection() {
    return this._layers.selection.getSelection();
  }

  setSelection(sel) {
    this._layers.selection.setSelection(sel);
  }

  clearSelection() {
    this._layers.selection.clear();
  }

  zoomToSelection() {
    const sel = this.getSelection();
    if (!sel) return;
    const pad = (sel.end - sel.start) * 0.1;
    const startNorm = Math.max(0, (sel.start - pad) / this._duration);
    const endNorm = Math.min(1, (sel.end + pad) / this._duration);
    this._viewStart = startNorm;
    this._viewEnd = endNorm;
    this._updateLayersView();
  }

  setState(stateText, type = 'idle') {
    this._els.headerState.textContent = stateText;
    const colors = {
      idle: { bg: Tokens.surface.raised, color: Tokens.text.dim },
      ready: { bg: Tokens.success.wash, color: Tokens.success.default },
      analyzing: { bg: 'rgba(46,213,229,0.12)', color: Tokens.signal.primary },
      processing: { bg: Tokens.selection.wash, color: Tokens.selection.default },
      error: { bg: Tokens.critical.wash, color: Tokens.critical.default },
    };
    const cfg = colors[type] || colors.idle;
    this._els.headerState.style.background = cfg.bg;
    this._els.headerState.style.color = cfg.color;
  }

  _formatTime(sec) {
    if (!isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
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
    for (const layer of Object.values(this._layers)) {
      try { layer.dispose(); } catch {}
    }
  }
}

export default SignalCanvas;
