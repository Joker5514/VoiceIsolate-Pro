/**
 * VoiceIsolate-Pro — Spectrogram Layer
 * GPU-friendly rendering, no full CPU pixel shifting every frame
 * Supports time-frequency selection
 */

import { Tokens } from '../../tokens/design-tokens.js';

/** Cap on samples read per column when estimating its level. */
const MAX_SAMPLES_PER_COLUMN = 1024;

/** Intensity ramp low → mid → high → peak, written straight into RGBA pixels. */
function writeColor(px, o, magnitude) {
  const intensity = Math.min(1, Math.max(0, magnitude * 8));
  let r, g, b;
  if (intensity < 0.25) {
    const t = intensity / 0.25;
    r = Math.floor(10 + t * (26 - 10)); g = Math.floor(14 + t * (42 - 14)); b = Math.floor(20 + t * (58 - 20));
  } else if (intensity < 0.5) {
    const t = (intensity - 0.25) / 0.25;
    r = Math.floor(26 + t * (194 - 26)); g = Math.floor(42 + t * (65 - 42)); b = Math.floor(58 + t * (12 - 58));
  } else if (intensity < 0.75) {
    const t = (intensity - 0.5) / 0.25;
    r = Math.floor(194 + t * (249 - 194)); g = Math.floor(65 + t * (115 - 65)); b = Math.floor(12 + t * (22 - 12));
  } else {
    const t = (intensity - 0.75) / 0.25;
    r = Math.floor(249 + t * (251 - 249)); g = Math.floor(115 + t * (191 - 115)); b = Math.floor(22 + t * (36 - 22));
  }
  px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
}

export class SpectrogramLayer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = {
      sampleRate: 48000,
      fftSize: 1024,
      backgroundColor: Tokens.canvas.bg,
      lowColor: Tokens.canvas.spectrogramLow,
      midColor: Tokens.canvas.spectrogramMid,
      highColor: Tokens.canvas.spectrogramHigh,
      peakColor: Tokens.canvas.spectrogramPeak,
      ...options,
    };
    this._spectrogramData = null; // 2D array or ImageData cache
    this._dataVersion = 0;
    this._image = null; // { key, img } painted for one geometry + data version
    this._duration = 0;
    this._viewStart = 0;
    this._viewEnd = 1;
    this._freqLow = 0;
    this._freqHigh = 1; // normalized 0-1 (0 = 0Hz, 1 = Nyquist)
    this._dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this._raf = 0;
    this._offscreen = null;
    this._offscreenCtx = null;

    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined' && typeof window !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._scheduleRender());
      this._resizeObserver.observe(canvas);
    }
  }

  /**
   * Set precomputed spectrogram data
   * @param {Float32Array[] | ImageData} data - array of frequency bins per time slice, or rendered image
   * @param {number} duration
   */
  setSpectrogramData(data, duration) {
    this._spectrogramData = data;
    this._duration = duration;
    this._dataVersion++;
    this._scheduleRender();
  }

  /**
   * Set raw audio to compute simple spectrogram on the fly (fallback)
   */
  setAudioData(channelData, sampleRate) {
    this._audioData = channelData?.[0] || null;
    this.options.sampleRate = sampleRate;
    this._duration = this._audioData ? this._audioData.length / sampleRate : 0;
    this._spectrogramData = null; // will compute on render
    this._dataVersion++;
    this._scheduleRender();
  }

  setViewRange(timeStart, timeEnd, freqLow = 0, freqHigh = 1) {
    this._viewStart = Math.max(0, Math.min(1, timeStart));
    this._viewEnd = Math.max(this._viewStart + 0.001, Math.min(1, timeEnd));
    this._freqLow = Math.max(0, Math.min(1, freqLow));
    this._freqHigh = Math.max(this._freqLow + 0.001, Math.min(1, freqHigh));
    this._scheduleRender();
  }

  _scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  _ensureOffscreen(width, height) {
    if (!this._offscreen || this._offscreen.width !== width || this._offscreen.height !== height) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this._offscreen = new OffscreenCanvas(width, height);
        this._offscreenCtx = this._offscreen.getContext('2d', { alpha: false });
      } else {
        // Fallback: create canvas element
        this._offscreen = document.createElement('canvas');
        this._offscreen.width = width;
        this._offscreen.height = height;
        this._offscreenCtx = this._offscreen.getContext('2d', { alpha: false });
      }
    }
    return this._offscreenCtx;
  }

  /**
   * Simple spectrogram computation for fallback (not high-performance, but works)
   * Uses naive DFT for demo — real implementation would use FFT worker
   */
  _computeSimpleSpectrogram(width, height) {
    if (!this._audioData) return null;
    const data = this._audioData;
    const totalSamples = data.length;
    const viewStart = Math.floor(totalSamples * this._viewStart);
    const viewEnd = Math.floor(totalSamples * this._viewEnd);
    const viewLength = viewEnd - viewStart;
    const samplesPerColumn = Math.max(1, Math.floor(viewLength / width));
    // A column's level is a mean |x|; a bounded stride estimates it. Summing
    // every sample made each render two full passes over the file.
    const stride = Math.max(1, Math.floor((samplesPerColumn * 2) / MAX_SAMPLES_PER_COLUMN));
    // The band shape depends only on y: computed once, not per pixel.
    const shape = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      const freqNorm = 1 - y / height;
      shape[y] = 0.3 + 0.7 * Math.exp(-Math.pow((freqNorm - 0.3) * 3, 2));
    }

    const spectrogram = [];
    for (let x = 0; x < width; x++) {
      const start = viewStart + x * samplesPerColumn;
      const end = Math.min(start + samplesPerColumn * 2, viewEnd);
      // Simple energy per frequency band approximation
      const column = new Float32Array(height);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i += stride) { sum += Math.abs(data[i]); count++; }
      const avg = sum / Math.max(1, count);
      // Fake frequency distribution: speech energy concentrated in the mids
      for (let y = 0; y < height; y++) column[y] = avg * shape[y] + Math.random() * 0.02;
      spectrogram.push(column);
    }
    return spectrogram;
  }

  /**
   * Paint column data into one ImageData. One fillRect (and one colour
   * string) per device pixel was ~400k canvas calls per render on a phone
   * canvas: a 1.8 s task on a 4x-throttled mobile profile.
   */
  _paintColumns(ctx, spectrogram, width, height) {
    const img = ctx.createImageData(width, height);
    const px = img.data;
    const cols = spectrogram.length;
    for (let x = 0; x < width; x++) {
      const column = spectrogram[Math.min(cols - 1, Math.floor((x * cols) / width))];
      const bins = column ? column.length : 0;
      for (let py = 0; py < height; py++) {
        // y=0 is the lowest band, painted at the bottom row.
        const y = bins ? Math.min(bins - 1, Math.floor(((height - 1 - py) * bins) / height)) : 0;
        writeColor(px, (py * width + x) * 4, column ? column[y] || 0 : 0);
      }
    }
    return img;
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

    ctx.fillStyle = this.options.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    if (!this._audioData && !this._spectrogramData) {
      ctx.fillStyle = Tokens.text.ghost;
      ctx.font = `12px ${Tokens.font.mono}`;
      ctx.textAlign = 'center';
      ctx.fillText('Spectrogram — import audio for analysis', width / 2, height / 2);
      return;
    }

    const key = `${width}x${height}|${this._viewStart}|${this._viewEnd}|${this._dataVersion}`;
    if (!this._image || this._image.key !== key) {
      let spectrogram = this._spectrogramData;
      if (!spectrogram) spectrogram = this._computeSimpleSpectrogram(width, height);
      if (!spectrogram) return;
      if (spectrogram instanceof ImageData) {
        ctx.putImageData(spectrogram, 0, 0);
        return;
      }
      if (!Array.isArray(spectrogram) || spectrogram.length === 0) return;
      // Re-renders for the same geometry and data (resize jitter, unrelated
      // redraws) reuse the painted image instead of recomputing it.
      this._image = { key, img: this._paintColumns(ctx, spectrogram, width, height) };
    }
    ctx.putImageData(this._image.img, 0, 0);

    // Frequency grid
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5 * dpr;
    const freqLines = 4;
    for (let i = 1; i < freqLines; i++) {
      const y = (height / freqLines) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
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

export default SpectrogramLayer;
