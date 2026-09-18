/**
 * VoiceIsolate-Pro — Waveform Layer
 * Renders waveform with decimation for long files, 60 FPS target
 */

import { Tokens } from '../../tokens/design-tokens.js';

export class WaveformLayer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = {
      sampleRate: 48000,
      color: Tokens.canvas.waveformStroke,
      rawColor: Tokens.canvas.raw,
      processedColor: Tokens.canvas.processed,
      backgroundColor: Tokens.canvas.bg,
      lineWidth: 1.5,
      ...options,
    };
    this._data = null;
    this._duration = 0;
    this._viewStart = 0;
    this._viewEnd = 1; // normalized 0-1
    this._dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this._cachedPeaks = null;
    this._peaksVersion = 0;
    this._raf = 0;
    this._needsRender = false;

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined' && typeof window !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._scheduleRender());
      this._resizeObserver.observe(canvas);
    }
  }

  setData(channelData, duration, sampleRate = 48000) {
    this._data = channelData;
    this._duration = duration || (channelData?.[0]?.length / sampleRate) || 0;
    this.options.sampleRate = sampleRate;
    this._cachedPeaks = null;
    this._peaksVersion++;
    this._scheduleRender();
  }

  setViewRange(startNorm, endNorm) {
    this._viewStart = Math.max(0, Math.min(1, startNorm));
    this._viewEnd = Math.max(this._viewStart + 0.001, Math.min(1, endNorm));
    this._scheduleRender();
  }

  setComparisonMode(mode) {
    this.options.comparisonMode = mode;
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  /**
   * Decimate waveform for display — avoids drawing full-resolution file every frame
   */
  _computePeaks(width) {
    if (!this._data || !this._data[0]) return null;
    const channel = this._data[0];
    const totalSamples = channel.length;
    const viewStartSample = Math.floor(totalSamples * this._viewStart);
    const viewEndSample = Math.floor(totalSamples * this._viewEnd);
    const viewLength = viewEndSample - viewStartSample;
    if (viewLength <= 0) return null;

    const samplesPerPixel = Math.max(1, Math.floor(viewLength / width));
    const peaks = new Float32Array(width * 2); // min, max per pixel

    // Use cached if same view and width
    const cacheKey = `${this._peaksVersion}-${width}-${viewStartSample}-${viewEndSample}`;
    if (this._cachedPeaks && this._cachedPeaks.key === cacheKey) {
      return this._cachedPeaks.data;
    }

    let peakIdx = 0;
    for (let x = 0; x < width; x++) {
      const start = viewStartSample + Math.floor(x * samplesPerPixel);
      const end = Math.min(viewStartSample + Math.floor((x + 1) * samplesPerPixel), viewEndSample);
      let min = 0;
      let max = 0;
      for (let i = start; i < end; i++) {
        const s = channel[i];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      peaks[peakIdx++] = min;
      peaks[peakIdx++] = max;
    }

    this._cachedPeaks = { key: cacheKey, data: peaks };
    return peaks;
  }

  _render() {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!ctx) return;

    const dpr = this._dpr;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    // Clear
    ctx.fillStyle = this.options.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    if (!this._data || !this._data[0]) {
      // Empty state
      ctx.fillStyle = Tokens.text.ghost;
      ctx.font = `12px ${Tokens.font.mono}`;
      ctx.textAlign = 'center';
      ctx.fillText('No audio — import or record to begin', width / 2, height / 2);
      return;
    }

    const peaks = this._computePeaks(width);
    if (!peaks) return;

    const midY = height / 2;
    const ampScale = height * 0.45;

    // Choose color based on comparison mode
    let strokeColor = this.options.color;
    if (this.options.comparisonMode === 'raw') strokeColor = this.options.rawColor;
    else if (this.options.comparisonMode === 'removed') strokeColor = Tokens.canvas.removed;

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = this.options.lineWidth * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Draw waveform as filled area for better visibility
    ctx.beginPath();
    // Top edge (max)
    for (let x = 0; x < width; x++) {
      const max = peaks[x * 2 + 1];
      const y = midY - max * ampScale;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    // Bottom edge (min) reverse
    for (let x = width - 1; x >= 0; x--) {
      const min = peaks[x * 2];
      const y = midY - min * ampScale;
      ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Fill with translucent
    ctx.fillStyle = strokeColor + '33'; // 20% opacity
    // Convert hex to rgba if needed
    if (strokeColor.startsWith('#')) {
      const r = parseInt(strokeColor.slice(1, 3), 16);
      const g = parseInt(strokeColor.slice(3, 5), 16);
      const b = parseInt(strokeColor.slice(5, 7), 16);
      ctx.fillStyle = `rgba(${r},${g},${b},0.18)`;
    }
    ctx.fill();
    ctx.stroke();

    // Center line
    ctx.strokeStyle = Tokens.border.subtle;
    ctx.lineWidth = 0.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Grid lines (time)
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5 * dpr;
    const gridCount = 8;
    for (let i = 1; i < gridCount; i++) {
      const x = (width / gridCount) * i;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch {}
    }
  }
}

export default WaveformLayer;
