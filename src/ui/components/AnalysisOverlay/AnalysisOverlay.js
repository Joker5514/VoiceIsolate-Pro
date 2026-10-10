/**
 * VoiceIsolate-Pro — Analysis Overlay
 * Renders detected regions directly onto signal canvas
 * Overlays: Speech, Whisper, Background Noise, Hum, Music/bleed, Candidate secondary speaker
 * Each with confidence value
 */

import { Tokens } from '../../tokens/design-tokens.js';

const OverlayStyles = {
  speech: {
    bg: 'rgba(46,213,229,0.18)',
    border: 'rgba(46,213,229,0.55)',
    label: 'Speech',
    color: '#2ed5e5',
  },
  whisper: {
    bg: 'rgba(155,108,255,0.18)',
    border: 'rgba(155,108,255,0.55)',
    label: 'Whisper',
    color: '#9b6cff',
  },
  background_noise: {
    bg: 'rgba(141,154,170,0.12)',
    border: 'rgba(141,154,170,0.28)',
    label: 'Noise',
    color: '#8d9aaa',
  },
  hum: {
    bg: 'rgba(240,181,65,0.14)',
    border: 'rgba(240,181,65,0.40)',
    label: 'Hum',
    color: '#f0b541',
  },
  music: {
    bg: 'rgba(168,85,247,0.14)',
    border: 'rgba(168,85,247,0.40)',
    label: 'Music',
    color: '#a855f7',
  },
  secondary_speaker: {
    bg: 'rgba(59,130,246,0.14)',
    border: 'rgba(59,130,246,0.40)',
    label: 'Speaker',
    color: '#3b82f6',
  },
};

export class AnalysisOverlay {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      duration: 0,
      showConfidence: true,
      showLabels: true,
      ...options,
    };
    this._regions = [];
    this._elements = new Map();
    this._regionById = new Map();
    this._overlayEl = null;
    this._initDOM();
  }

  _initDOM() {
    this._overlayEl = document.createElement('div');
    this._overlayEl.className = 'vip-analysis-overlay';
    this._overlayEl.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 5;
      overflow: hidden;
    `;
    // Ensure container positioned
    const style = window.getComputedStyle(this.container);
    if (style.position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(this._overlayEl);
    // Delegated: three listeners per region element were rebuilt (and
    // retained by the closures) on every regions update.
    const regionOf = (e) => {
      const el = e.target?.closest?.('.vip-overlay-region');
      return el && this._overlayEl.contains(el) ? el : null;
    };
    this._overlayEl.addEventListener('mouseover', (e) => {
      const el = regionOf(e);
      if (!el || el.contains(e.relatedTarget)) return;
      const style = OverlayStyles[el.dataset.type] || OverlayStyles.background_noise;
      el.style.background = style.bg.replace('0.18', '0.28').replace('0.14', '0.24').replace('0.12', '0.22');
      el.style.zIndex = '6';
    });
    this._overlayEl.addEventListener('mouseout', (e) => {
      const el = regionOf(e);
      if (!el || el.contains(e.relatedTarget)) return;
      const style = OverlayStyles[el.dataset.type] || OverlayStyles.background_noise;
      el.style.background = style.bg;
      el.style.zIndex = 'auto';
    });
    this._overlayEl.addEventListener('click', (e) => {
      const el = regionOf(e);
      const region = el && this._regionById.get(el.dataset.regionId);
      if (!region) return;
      e.stopPropagation();
      this._emit('regionClicked', region);
    });
  }

  setDuration(duration) {
    this.options.duration = duration;
    this._render();
  }

  setRegions(regions) {
    this._regions = regions || [];
    this._render();
  }

  _render() {
    // Clear existing
    for (const el of this._elements.values()) el.remove();
    this._elements.clear();
    this._regionById.clear();

    if (!this._regions.length || !this.options.duration) return;

    const containerWidth = this.container.clientWidth;
    // One insertion for every region instead of one per element.
    const frag = document.createDocumentFragment();

    for (const region of this._regions) {
      const style = OverlayStyles[region.type] || OverlayStyles.background_noise;
      const el = document.createElement('div');
      el.className = `vip-overlay-region vip-overlay-${region.type}`;
      el.dataset.regionId = region.id;
      el.dataset.type = region.type;
      el.dataset.confidence = region.confidence;

      const startNorm = region.start / this.options.duration;
      const endNorm = region.end / this.options.duration;
      const left = startNorm * containerWidth;
      const width = (endNorm - startNorm) * containerWidth;

      // Skip if too narrow
      if (width < 2) continue;

      el.style.cssText = `
        position: absolute;
        top: 0;
        bottom: 0;
        left: ${left}px;
        width: ${width}px;
        background: ${style.bg};
        border-left: 2px solid ${style.border};
        border-right: 2px solid ${style.border};
        pointer-events: auto;
        cursor: pointer;
        transition: all 0.15s ease;
        overflow: hidden;
      `;

      // Label
      if (this.options.showLabels) {
        const label = document.createElement('div');
        label.className = 'vip-overlay-label';
        label.style.cssText = `
          position: absolute;
          top: 4px;
          left: 4px;
          font: 600 9px/1 ui-monospace, monospace;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: ${style.color};
          background: rgba(7,11,16,0.85);
          padding: 2px 4px;
          border-radius: 3px;
          border: 1px solid ${style.border};
          white-space: nowrap;
          max-width: ${Math.max(20, width - 8)}px;
          overflow: hidden;
          text-overflow: ellipsis;
        `;
        label.textContent = region.label || style.label;
        if (this.options.showConfidence && region.confidence != null) {
          label.textContent += ` ${Math.round(region.confidence * 100)}%`;
        }
        el.appendChild(label);
      }

      // Confidence indicator bar at bottom
      if (this.options.showConfidence && region.confidence != null) {
        const confBar = document.createElement('div');
        confBar.style.cssText = `
          position: absolute;
          bottom: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: ${style.border};
          opacity: ${region.confidence};
        `;
        el.appendChild(confBar);
      }

      frag.appendChild(el);
      this._elements.set(region.id, el);
      this._regionById.set(String(region.id), region);
    }
    this._overlayEl.appendChild(frag);
  }

  _listeners = new Map();

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

  highlightRegion(regionId) {
    for (const [id, el] of this._elements) {
      if (id === regionId) {
        el.style.boxShadow = `0 0 0 2px ${Tokens.selection.default}, 0 0 20px ${Tokens.selection.glow}`;
        el.style.zIndex = '7';
      } else {
        el.style.boxShadow = 'none';
        el.style.zIndex = 'auto';
      }
    }
  }

  clearHighlight() {
    for (const el of this._elements.values()) {
      el.style.boxShadow = 'none';
      el.style.zIndex = 'auto';
    }
  }

  dispose() {
    this._overlayEl?.remove();
  }
}

export default AnalysisOverlay;
