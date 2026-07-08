/**
 * VoiceIsolate Pro — Landing Page Visualizer (Layer 4: Presentation)
 *
 * Two wired graphs, both driven by one requestAnimationFrame loop:
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

const ACCENT = '#ef4444';
const NOISE_COLOR = 'rgba(154, 154, 164, 0.55)';
const GRID = 'rgba(80, 80, 90, 0.5)';
const PLAYHEAD = '#34d399';
const CROP_FILL = 'rgba(52, 211, 153, 0.14)';
const CROP_EDGE = 'rgba(52, 211, 153, 0.75)';
const LOOP_COLOR = 'rgba(239, 68, 68, 0.35)';

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
    this._freqData = null;
    /** Smoothed bar heights + peak-hold for fluid spectrum animation */
    this._barSmooth = null;
    this._barPeak = null;
    /** Precomputed envelopes: { clean: {min,max}, noise: {min,max}, columns } */
    this._envelope = null;
    this._duration = 0;

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
    if (this._envelope) this._drawWave();
  }

  /**
   * Precompute per-pixel-column min/max envelopes of both stems.
   * Called once per processed file — O(samples), then drawing is O(width).
   * @param {Float32Array[]} cleanChannels
   * @param {Float32Array[]} noiseChannels
   * @param {number} duration seconds
   */
  invalidate() {
    this._drawWave();
  }

  loadStems(cleanChannels, noiseChannels, duration) {
    const columns = Math.max(200, this.waveCanvas.clientWidth || 600);
    this._envelope = {
      clean: envelopeOf(cleanChannels[0], columns),
      noise: envelopeOf(noiseChannels[0], columns),
      columns,
    };
    this._duration = duration;
    this.start();
  }

  start() {
    if (this._rafId !== null) return;
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._drawWave();
      this._drawSpectrum();
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  dispose() {
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
    const step = Math.floor(bins / bars);
    const barW = W / bars - 1;
    if (!this._barSmooth || this._barSmooth.length !== bars) {
      this._barSmooth = new Float32Array(bars);
      this._barPeak = new Float32Array(bars);
    }
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += this._freqData[i * step + k];
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

/** Min/max envelope of one channel, downsampled to `columns` buckets. */
function envelopeOf(samples, columns) {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const bucket = Math.max(1, Math.floor(samples.length / columns));
  for (let c = 0; c < columns; c++) {
    let lo = 0, hi = 0;
    const start = c * bucket;
    const end = Math.min(samples.length, start + bucket);
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = Math.max(-1, lo);
    max[c] = Math.min(1, hi);
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
