/**
 * VoiceIsolate Pro — Timeline Lane Renderer (Layer 4: Presentation)
 *
 * Renders stacked source lanes from analysis.visualLayers.
 */
'use strict';

const DEFAULT_COLORS = {
  lead_speech: '#3b82f6',
  secondary_speech: '#8b5cf6',
  music: '#ec4899',
  noise: '#6b7280',
  hum: '#f59e0b',
  transients: '#ef4444',
  ambience: '#14b8a6',
  silence: '#374151',
  whisper: '#a3e635',
  difficult: '#fbbf24',
  overlap: '#f472b6',
};

const finiteNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class TimelineRenderer {
  /**
   * @param {HTMLCanvasElement|HTMLElement} container
   * @param {object} [opts]
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.duration = 1;
    this.layers = [];
    this.playhead = 0;
    this._canvas = null;
    this._tooltip = null;
    this._onRegionClick = opts.onRegionClick || null;
    this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this._ensureCanvas();
  }

  _ensureCanvas() {
    if (!this.container) return;
    if (this.container.tagName === 'CANVAS') {
      this._canvas = this.container;
    } else {
      let c = this.container.querySelector('canvas.vip-timeline-canvas');
      if (!c) {
        c = document.createElement('canvas');
        c.className = 'vip-timeline-canvas';
        c.style.width = '100%';
        c.style.height = '100%';
        c.style.display = 'block';
        this.container.replaceChildren();
        this.container.appendChild(c);
      }
      this._canvas = c;
    }
    this._canvas.addEventListener('click', (e) => this._handleClick(e));
    this._canvas.addEventListener('mousemove', (e) => this._handleMove(e));
    this._canvas.addEventListener('mouseleave', () => this._hideTip());
  }

  /**
   * @param {object} analysis
   */
  setAnalysis(analysis) {
    this.duration = Math.max(0.01, finiteNumber(analysis?.duration, 1));
    const visualLayers = Array.isArray(analysis?.visualLayers) ? analysis.visualLayers : [];
    this.layers = visualLayers.filter((layer) => Array.isArray(layer?.segments) && layer.segments.length);
    // Always keep structure of all lanes for empty state
    if (!this.layers.length) {
      this.layers = visualLayers;
    }
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = clamp(finiteNumber(t, 0), 0, this.duration);
    this.draw();
  }

  draw() {
    const canvas = this._canvas;
    if (!canvas) return;
    const parent = canvas.parentElement || canvas;
    const cssW = parent.clientWidth || 640;
    const laneH = 28;
    const labelW = 120;
    const cssH = Math.max(laneH * Math.max(this.layers.length, 1) + 8, 120);
    canvas.style.height = `${cssH}px`;
    const dpr = this._dpr;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // background
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, cssW, cssH);

    const trackW = Math.max(1, cssW - labelW - 8);
    const layers = this.layers.length ? this.layers : [{ id: 'empty', label: 'No analysis yet', segments: [], color: '#334155' }];

    layers.forEach((layer, i) => {
      const y = 4 + i * laneH;
      // label
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(layer.label || layer.id, 6, y + laneH / 2);

      // track bg
      ctx.fillStyle = '#111827';
      ctx.fillRect(labelW, y + 4, trackW, laneH - 8);

      const segs = Array.isArray(layer.segments) ? layer.segments : [];
      if (!segs.length) {
        ctx.fillStyle = 'rgba(51,65,85,0.35)';
        ctx.fillRect(labelW, y + 4, trackW, laneH - 8);
        ctx.fillStyle = '#475569';
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText('not detected', labelW + 8, y + laneH / 2);
        return;
      }

      for (const s of segs) {
        const start = clamp(finiteNumber(s?.start, 0), 0, this.duration);
        const end = clamp(finiteNumber(s?.end, start), start, this.duration);
        const x0 = labelW + (start / this.duration) * trackW;
        const x1 = labelW + (end / this.duration) * trackW;
        const conf = clamp(finiteNumber(s?.confidence, finiteNumber(layer.confidence, 0.5)), 0, 1);
        const col = layer.color || DEFAULT_COLORS[layer.id] || '#64748b';
        ctx.globalAlpha = 0.25 + conf * 0.7;
        ctx.fillStyle = col;
        ctx.fillRect(x0, y + 4, Math.max(2, x1 - x0), laneH - 8);
        ctx.globalAlpha = 1;
      }
    });

    // playhead
    const px = labelW + (clamp(this.playhead, 0, this.duration) / this.duration) * trackW;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, cssH);
    ctx.stroke();

    this._layout = { labelW, trackW, laneH, cssW, cssH, layers };
  }

  _handleClick(e) {
    const hit = this._hit(e);
    if (!hit) return;
    if (this._onRegionClick) this._onRegionClick(hit);
  }

  _handleMove(e) {
    const hit = this._hit(e);
    if (!hit || !hit.segment) {
      this._hideTip();
      return;
    }
    this._showTip(e, hit);
  }

  _hit(e) {
    if (!this._layout) return null;
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { labelW, trackW, laneH, layers } = this._layout;
    if (x < labelW) return null;
    const i = Math.floor((y - 4) / laneH);
    if (i < 0 || i >= layers.length) return null;
    const layer = layers[i];
    const t = clamp(((x - labelW) / trackW) * this.duration, 0, this.duration);
    const segments = Array.isArray(layer.segments) ? layer.segments : [];
    const segment = segments.find((s) => {
      const start = finiteNumber(s?.start, -1);
      const end = finiteNumber(s?.end, -1);
      return t >= start && t <= end;
    }) || null;
    return { layer, time: t, segment };
  }

  _showTip(e, hit) {
    if (typeof document === 'undefined') return;
    if (!this._tooltip) {
      this._tooltip = document.createElement('div');
      this._tooltip.className = 'vip-timeline-tooltip';
      this._tooltip.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;background:#0f172a;color:#e2e8f0;border:1px solid #334155;padding:6px 8px;border-radius:6px;font:11px/1.35 ui-sans-serif,system-ui;max-width:240px;';
      document.body.appendChild(this._tooltip);
    }
    const s = hit.segment;
    const conf = Math.round(clamp(finiteNumber(s?.confidence, 0), 0, 1) * 100);
    const title = document.createElement('strong');
    title.textContent = String(hit.layer.label || hit.layer.id || 'Timeline region');
    const timing = s
      ? `${finiteNumber(s.start, 0).toFixed(2)}s – ${finiteNumber(s.end, 0).toFixed(2)}s`
      : `${finiteNumber(hit.time, 0).toFixed(2)}s`;
    const lines = [title, document.createElement('br'), timing, document.createElement('br'), `Confidence: ${conf}%`];
    if (s?.meta != null && String(s.meta)) {
      lines.push(document.createElement('br'), String(s.meta));
    }
    this._tooltip.replaceChildren(...lines);
    this._tooltip.style.left = `${e.clientX + 12}px`;
    this._tooltip.style.top = `${e.clientY + 12}px`;
    this._tooltip.style.display = 'block';
  }

  _hideTip() {
    if (this._tooltip) this._tooltip.style.display = 'none';
  }

  dispose() {
    this._hideTip();
    if (this._tooltip && this._tooltip.parentNode) this._tooltip.parentNode.removeChild(this._tooltip);
    this._tooltip = null;
  }
}

export default TimelineRenderer;
