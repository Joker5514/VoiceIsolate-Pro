/**
 * VoiceIsolate Pro — Landing Page Visualizer (Layer 4: Presentation)
 *
 * Two wired graphs driven by one adaptive render loop:
 *
 *   1. Stem waveform overview — min/max envelope of the Clean stem (accent)
 *      over the Noise stem (gray), with a live playhead. Click to seek.
 *   2. Live output spectrum — frequency bars from PlaybackMixer's
 *      AnalyserNode (post-EQ, post-master), so every slider move is visible
 *      in the graph in real time.
 *
 * Pure presentation: reads mixer state, never touches ML or the pipeline.
 */
'use strict';

import { createYieldBudget } from '../pipeline/ui-yield.js';

const ACCENT = '#ef4444';
const NOISE_COLOR = 'rgba(154, 154, 164, 0.55)';
const GRID = 'rgba(80, 80, 90, 0.5)';
const PLAYHEAD = '#34d399';
const CROP_FILL = 'rgba(52, 211, 153, 0.14)';
const CROP_EDGE = 'rgba(52, 211, 153, 0.75)';
const LOOP_COLOR = 'rgba(239, 68, 68, 0.35)';
const IDLE_FRAME_MS = 250;

export class LandingVisualizer {
  /**
   * @param {import('/src/pipeline/PlaybackMixer.js').PlaybackMixer} mixer
   * @param {HTMLCanvasElement} waveCanvas
   * @param {HTMLCanvasElement} specCanvas
   */
  constructor(mixer, waveCanvas, specCanvas) {
    this.mixer = mixer;
    this.waveCanvas = waveCanvas;
    this.specCanvas = specCanvas;
    this.waveCtx = waveCanvas.getContext('2d');
    this.specCtx = specCanvas.getContext('2d');
    this._rafId = null;
    this._idleTimer = null;
    this._running = false;
    this._freqData = null;
    /** Smoothed bar heights + peak-hold for fluid spectrum animation */
    this._barSmooth = null;
    this._barPeak = null;
    /** Precomputed envelopes: { clean: {min,max}, noise: {min,max}, columns } */
    this._envelope = null;
    this._duration = 0;
    /** Cancels stale async envelope work when a newer file arrives. */
    this._loadGeneration = 0;
    this._waveDirty = true;
    this._spectrumDirty = true;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();

    // Click-to-seek on the waveform overview.
    this._onWaveClick = async (e) => {
      if (!this._duration) return;
      const rect = this.waveCanvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      try { await this.mixer.seek(frac * this._duration); } catch (err) {
        console.warn('[VIP][visualizer] seek failed:', err);
      }
    };
    this.waveCanvas.addEventListener('click', this._onWaveClick);
    this._onWaveTouch = (e) => {
      if (!e.touches || !e.touches[0]) return;
      e.preventDefault();
      this._onWaveClick({ clientX: e.touches[0].clientX });
    };
    this.waveCanvas.addEventListener('touchstart', this._onWaveTouch, { passive: false });
  }

  _resize() {
    for (const canvas of [this.waveCanvas, this.specCanvas]) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 100;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this._waveDirty = true;
    this._spectrumDirty = true;
    if (this._envelope && !this._running) this._drawWave();
  }

  /**
   * Mark presentation state dirty without forcing an always-on render loop.
   */
  invalidate() {
    this._waveDirty = true;
    this._spectrumDirty = true;
    if (!this._running) {
      this._drawWave();
      this._drawSpectrum();
    }
  }

  /**
   * Precompute per-pixel-column min/max envelopes cooperatively. Long clips
   * yield to the browser instead of doing two full-file scans in one task.
   * Stale work is abandoned when a newer file is loaded.
   *
   * @param {Float32Array[]} cleanChannels
   * @param {Float32Array[]} noiseChannels
   * @param {number} duration seconds
   * @returns {Promise<boolean>} true when this generation became active
   */
  async loadStems(cleanChannels, noiseChannels, duration) {
    const cleanSamples = cleanChannels?.[0];
    const noiseSamples = noiseChannels?.[0];
    if (!cleanSamples?.length || !noiseSamples?.length) return false;

    const generation = ++this._loadGeneration;
    // Publish seek/crop state before the first cooperative await. Callers can
    // remain non-blocking while the expensive waveform envelope finishes.
    this._duration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    this._waveDirty = true;
    this._spectrumDirty = true;

    const columns = Math.max(200, Math.ceil(this.waveCanvas.clientWidth || 600));
    const maybeYield = createYieldBudget();
    const isCurrent = () => generation === this._loadGeneration;

    const clean = await envelopeOfAsync(cleanSamples, columns, { maybeYield, isCurrent });
    if (!clean || !isCurrent()) return false;
    const noise = await envelopeOfAsync(noiseSamples, columns, { maybeYield, isCurrent });
    if (!noise || !isCurrent()) return false;

    this._envelope = { clean, noise, columns };
    this._waveDirty = true;
    this._spectrumDirty = true;
    this.start();
    return true;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._scheduleNextFrame(0);
  }

  _scheduleNextFrame(delayMs) {
    if (!this._running || this._rafId !== null || this._idleTimer !== null) return;
    const request = () => {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this._renderTick();
      });
    };
    if (delayMs > 0) {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        request();
      }, delayMs);
    } else {
      request();
    }
  }

  _renderTick() {
    if (!this._running) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const playing = !hidden && Boolean(this.mixer.isPlaying?.());

    if (!hidden) {
      if (playing || this._waveDirty) {
        this._drawWave();
        this._waveDirty = false;
      }
      if (playing || this._spectrumDirty) {
        this._drawSpectrum();
        this._spectrumDirty = false;
      }
    }

    // Full-rate only while playback is active. Paused/hidden pages fall back
    // to a 4 Hz wake-up so they do not continuously repaint canvases.
    this._scheduleNextFrame(playing ? 0 : IDLE_FRAME_MS);
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    if (this._idleTimer !== null) clearTimeout(this._idleTimer);
    this._rafId = null;
    this._idleTimer = null;
  }

  dispose() {
    ++this._loadGeneration;
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.waveCanvas.removeEventListener('click', this._onWaveClick);
    this.waveCanvas.removeEventListener('touchstart', this._onWaveTouch);
  }

  // ── Waveform overview + playhead ───────────────────────────────────────
  _drawWave() {
    const ctx = this.waveCtx;
    const W = this.waveCanvas.clientWidth;
    const H = this.waveCanvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H);
    if (!this._envelope) {
      drawIdleText(ctx, W, H, 'Process a file to see its stems');
      return;
    }

    const { clean, noise, columns } = this._envelope;
    const mid = H / 2;
    const colW = W / columns;

    // Noise stem behind (what the AI removed)…
    ctx.fillStyle = NOISE_COLOR;
    for (let c = 0; c < columns; c++) {
      const y0 = mid + noise.min[c] * mid;
      const y1 = mid + noise.max[c] * mid;
      ctx.fillRect(c * colW, y0, Math.max(1, colW), Math.max(1, y1 - y0));
    }
    // …clean voice stem in front.
    ctx.fillStyle = ACCENT;
    for (let c = 0; c < columns; c++) {
      const y0 = mid + clean.min[c] * mid;
      const y1 = mid + clean.max[c] * mid;
      ctx.fillRect(c * colW, y0, Math.max(1, colW), Math.max(1, y1 - y0));
    }

    if (this._duration > 0) {
      const region = this.mixer.getCropRegion?.() || { in: 0, out: this._duration };
      if (this.mixer.hasCrop?.()) {
        const x0 = (region.in / this._duration) * W;
        const x1 = (region.out / this._duration) * W;
        ctx.fillStyle = CROP_FILL;
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), H);
        ctx.strokeStyle = CROP_EDGE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, 0); ctx.lineTo(x0, H);
        ctx.moveTo(x1, 0); ctx.lineTo(x1, H);
        ctx.stroke();
      }
      if (this.mixer.isLoopEnabled?.()) {
        const lx0 = (region.in / this._duration) * W;
        const lx1 = (region.out / this._duration) * W;
        ctx.strokeStyle = LOOP_COLOR;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(lx0, 2, Math.max(1, lx1 - lx0), H - 4);
        ctx.setLineDash([]);
      }
      const x = (this.mixer.currentTime() / this._duration) * W;
      ctx.strokeStyle = PLAYHEAD;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

  // ── Live output spectrum ───────────────────────────────────────────────
  _drawSpectrum() {
    const ctx = this.specCtx;
    const W = this.specCanvas.clientWidth;
    const H = this.specCanvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    drawGrid(ctx, W, H);

    const analyser = this.mixer.getAnalyser();
    const bins = analyser.frequencyBinCount;
    if (!this._freqData || this._freqData.length !== bins) {
      this._freqData = new Uint8Array(bins);
    }
    analyser.getByteFrequencyData(this._freqData);

    const bars = 96;
    const step = Math.max(1, Math.floor(bins / bars));
    const barW = W / bars - 1;
    if (!this._barSmooth || this._barSmooth.length !== bars) {
      this._barSmooth = new Float32Array(bars);
      this._barPeak = new Float32Array(bars);
    }
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += this._freqData[i * step + k] || 0;
      const raw = sum / step / 255;
      this._barSmooth[i] = this._barSmooth[i] * 0.72 + raw * 0.28;
      this._barPeak[i] = Math.max(this._barSmooth[i], this._barPeak[i] * 0.94);
      const h = Math.max(1, this._barSmooth[i] * H * 0.92);
      const g = ctx.createLinearGradient(0, H - h, 0, H);
      g.addColorStop(0, 'rgba(239, 68, 68, 0.9)');
      g.addColorStop(1, 'rgba(239, 68, 68, 0.08)');
      ctx.fillStyle = g;
      ctx.fillRect(i * (barW + 1), H - h, barW, h);
      const peakH = this._barPeak[i] * H * 0.92;
      if (peakH > h + 2) {
        ctx.fillStyle = 'rgba(52, 211, 153, 0.75)';
        ctx.fillRect(i * (barW + 1), H - peakH, barW, 1.5);
      }
    }
    if (!this.mixer.isPlaying()) {
      drawIdleText(ctx, W, H, this._envelope ? 'Press Play — sliders move this graph live' : '');
    }
  }
}

/**
 * Min/max envelope of one channel, downsampled to `columns` buckets.
 * Uses proportional bucket boundaries so the tail is never dropped and yields
 * periodically on long recordings.
 *
 * @param {Float32Array} samples
 * @param {number} columns
 * @param {{ maybeYield?: () => Promise<void>, isCurrent?: () => boolean }} [opts]
 * @returns {Promise<{min: Float32Array, max: Float32Array}|null>}
 */
export async function envelopeOfAsync(samples, columns, opts = {}) {
  const nColumns = Math.max(1, Math.floor(columns) || 1);
  const min = new Float32Array(nColumns);
  const max = new Float32Array(nColumns);
  const maybeYield = opts.maybeYield || (async () => {});
  const isCurrent = opts.isCurrent || (() => true);
  const length = samples?.length || 0;

  if (!length) return { min, max };

  for (let c = 0; c < nColumns; c++) {
    if (!isCurrent()) return null;
    let lo = 0;
    let hi = 0;
    const start = Math.min(length - 1, Math.floor((c * length) / nColumns));
    const proportionalEnd = Math.floor(((c + 1) * length) / nColumns);
    const end = Math.min(length, Math.max(start + 1, proportionalEnd));
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = Math.max(-1, lo);
    max[c] = Math.min(1, hi);
    await maybeYield();
  }
  return { min, max };
}

function drawGrid(ctx, W, H) {
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 5]);
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, H * f);
    ctx.lineTo(W, H * f);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function drawIdleText(ctx, W, H, text) {
  if (!text) return;
  ctx.fillStyle = 'rgba(154, 154, 164, 0.8)';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, W / 2, H / 2);
}

export default LandingVisualizer;
