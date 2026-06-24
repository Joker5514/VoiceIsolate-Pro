/**
 * VoiceIsolate Pro — Landing Page Visualizer (Layer 4: Presentation)
 *
 * Three wired views, all driven by one requestAnimationFrame loop:
 *
 *   1. Stem waveform overview — min/max envelope of the Clean stem (accent)
 *      over the Noise stem (gray), with a live playhead. Click to seek.
 *   2. Live output spectrogram — a scrolling pseudo-3D waterfall fed by
 *      PlaybackMixer's AnalyserNode (post-EQ, post-master), so every slider
 *      move is visible in the graph in real time.
 *   3. Speaker diarization timeline — lane view of detected speakers with a
 *      live playhead, driven by the one-shot diarization result.
 *
 * Pure presentation: reads mixer state, never touches ML or the pipeline.
 */
'use strict';

const ACCENT = '#ef4444';
const NOISE_COLOR = 'rgba(154, 154, 164, 0.55)';
const GRID = 'rgba(80, 80, 90, 0.5)';
const PLAYHEAD = '#34d399';
const DIAR_BG = '#0b1020';
const DIAR_GRID = 'rgba(120, 140, 170, 0.18)';
const DIAR_TEXT = 'rgba(226, 232, 240, 0.92)';
const DIAR_MUTED = 'rgba(148, 163, 184, 0.72)';
const SPEAKER_COLORS = Object.freeze([
  '#3b82f6',
  '#a855f7',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#84cc16',
  '#f97316',
]);

export class LandingVisualizer {
  /**
   * @param {import('/src/pipeline/PlaybackMixer.js').PlaybackMixer} mixer
   * @param {HTMLCanvasElement} waveCanvas
   * @param {HTMLCanvasElement} specCanvas
   * @param {HTMLCanvasElement|null} diarCanvas
   */
  constructor(mixer, waveCanvas, specCanvas, diarCanvas = null) {
    this.mixer = mixer;
    this.waveCanvas = waveCanvas;
    this.specCanvas = specCanvas;
    this.diarCanvas = diarCanvas;
    this.waveCtx = waveCanvas.getContext('2d');
    this.specCtx = specCanvas.getContext('2d');
    this.diarCtx = diarCanvas ? diarCanvas.getContext('2d') : null;
    this._rafId = null;
    this._freqData = null;
    this._envelope = null;
    this._duration = 0;
    this._spectrogram = [];
    this._spectrogramRows = 72;
    this._spectrogramBars = 72;
    this._speakerSegments = [];
    this._speakerOrder = [];

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();

    this._onWaveClick = async (e) => {
      if (!this._duration) return;
      const rect = this.waveCanvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      try {
        await this.mixer.seek(frac * this._duration);
      } catch (err) {
        console.warn('[VIP][visualizer] seek failed:', err);
      }
    };
    this.waveCanvas.addEventListener('click', this._onWaveClick);
  }

  _resize() {
    for (const canvas of [this.waveCanvas, this.specCanvas, this.diarCanvas].filter(Boolean)) {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 100;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (this._envelope) this._drawWave();
    if (this.diarCanvas) this._drawTimeline();
  }

  loadStems(cleanChannels, noiseChannels, duration) {
    const columns = Math.max(200, this.waveCanvas.clientWidth || 600);
    this._envelope = {
      clean: envelopeOf(cleanChannels[0], columns),
      noise: envelopeOf(noiseChannels[0], columns),
      columns,
    };
    this._duration = duration;
    this._spectrogram = [];
    this.start();
  }

  loadSpeakerSegments(segments) {
    this._speakerSegments = Array.isArray(segments) ? segments.slice() : [];
    this._speakerOrder = [...new Set(this._speakerSegments.map((seg) => seg.speakerId))];
    if (this.diarCanvas) this._drawTimeline();
  }

  start() {
    if (this._rafId !== null) return;
    const loop = () => {
      this._rafId = requestAnimationFrame(loop);
      this._drawWave();
      this._drawSpectrum();
      this._drawTimeline();
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
  }

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

    ctx.fillStyle = NOISE_COLOR;
    for (let c = 0; c < columns; c++) {
      const y0 = mid + noise.min[c] * mid;
      const y1 = mid + noise.max[c] * mid;
      ctx.fillRect(c * colW, y0, Math.max(1, colW), Math.max(1, y1 - y0));
    }

    ctx.fillStyle = ACCENT;
    for (let c = 0; c < columns; c++) {
      const y0 = mid + clean.min[c] * mid;
      const y1 = mid + clean.max[c] * mid;
      ctx.fillRect(c * colW, y0, Math.max(1, colW), Math.max(1, y1 - y0));
    }

    if (this._duration > 0) {
      const x = (this.mixer.currentTime() / this._duration) * W;
      ctx.strokeStyle = PLAYHEAD;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

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

    const bars = this._spectrogramBars;
    const step = Math.max(1, Math.floor(bins / bars));
    const row = new Float32Array(bars);
    for (let i = 0; i < bars; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) {
        const idx = Math.min(bins - 1, i * step + k);
        sum += this._freqData[idx];
      }
      row[i] = sum / step / 255;
    }
    this._spectrogram.push(row);
    if (this._spectrogram.length > this._spectrogramRows) this._spectrogram.shift();

    const depth = this._spectrogram.length;
    const rowH = Math.max(2, H / (this._spectrogramRows + 6));
    for (let z = 0; z < depth; z++) {
      const frame = this._spectrogram[depth - 1 - z];
      const perspective = 1 - z / (this._spectrogramRows + 4);
      const yBase = H - z * rowH - 6;
      const xInset = (1 - perspective) * W * 0.18;
      const usableW = W - xInset * 2;
      for (let i = 0; i < bars; i++) {
        const v = frame[i];
        const h = Math.max(1, v * H * 0.22 * perspective + 1);
        ctx.fillStyle = inferno(v, 0.18 + perspective * 0.82);
        const x = xInset + (i / bars) * usableW;
        const w = Math.max(1, (usableW / bars) - 1);
        ctx.fillRect(x, yBase - h, w, h);
      }
      ctx.strokeStyle = `rgba(255,255,255,${0.03 + perspective * 0.05})`;
      ctx.beginPath();
      ctx.moveTo(xInset, yBase + 0.5);
      ctx.lineTo(W - xInset, yBase + 0.5);
      ctx.stroke();
    }

    if (!this.mixer.isPlaying()) {
      drawIdleText(ctx, W, H, this._envelope ? 'Press Play — sliders move this 3D spectrogram live' : '');
    }
  }

  _drawTimeline() {
    if (!this.diarCtx || !this.diarCanvas) return;
    const ctx = this.diarCtx;
    const W = this.diarCanvas.clientWidth;
    const H = this.diarCanvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = DIAR_BG;
    ctx.fillRect(0, 0, W, H);

    if (!this._speakerSegments.length || !this._duration) {
      drawGrid(ctx, W, H);
      drawIdleText(ctx, W, H, this._duration ? 'No distinct speakers detected' : 'Process a file to see speaker turns');
      return;
    }

    const lanes = Math.max(1, this._speakerOrder.length);
    const laneH = Math.max(24, (H - 22) / lanes);
    const toX = (t) => (t / this._duration) * W;

    ctx.strokeStyle = DIAR_GRID;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * W;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H - 18);
      ctx.stroke();
      ctx.fillStyle = DIAR_MUTED;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = i === 4 ? 'right' : 'center';
      ctx.fillText(formatTimelineTime((i / 4) * this._duration), i === 4 ? x - 2 : x, H - 4);
    }

    for (let lane = 0; lane < lanes; lane++) {
      const y = lane * laneH + 4;
      ctx.fillStyle = lane % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(0, y, W, laneH - 4);
      ctx.fillStyle = DIAR_TEXT;
      ctx.textAlign = 'left';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(this._speakerOrder[lane], 8, y + 14);
    }

    for (const seg of this._speakerSegments) {
      const lane = this._speakerOrder.indexOf(seg.speakerId);
      if (lane < 0) continue;
      const x = toX(seg.start);
      const w = Math.max(2, toX(seg.end) - x);
      const y = lane * laneH + 22;
      const h = Math.max(10, laneH - 28);
      const color = speakerColor(seg.speakerId, lane);
      ctx.fillStyle = colorWithAlpha(color, 0.35 + (seg.confidence || 0.8) * 0.55);
      roundRect(ctx, x, y, w, h, 5);
      ctx.fill();
      if (w > 54) {
        ctx.fillStyle = '#f8fafc';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(seg.label || seg.speakerId, x + 6, y + h / 2 + 3);
      }
    }

    const playX = toX(this.mixer.currentTime());
    ctx.strokeStyle = PLAYHEAD;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, H - 18);
    ctx.stroke();
  }
}

function envelopeOf(samples, columns) {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  const bucket = Math.max(1, Math.floor(samples.length / columns));
  for (let c = 0; c < columns; c++) {
    let lo = 0;
    let hi = 0;
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

function inferno(value, alpha = 1) {
  const v = Math.max(0, Math.min(1, value));
  const r = Math.round(20 + v * 235);
  const g = Math.round(v < 0.5 ? v * 2 * 90 : 90 + (v - 0.5) * 2 * 120);
  const b = Math.round(v < 0.35 ? 80 + v * 2.85 * 120 : 180 - (v - 0.35) * 1.538 * 180);
  return `rgba(${r}, ${Math.max(0, Math.min(255, g))}, ${Math.max(0, Math.min(255, b))}, ${alpha})`;
}

function speakerColor(speakerId, index) {
  const numeric = Number(String(speakerId).replace(/\D+/g, ''));
  const idx = Number.isFinite(numeric) && numeric > 0
    ? (numeric - 1) % SPEAKER_COLORS.length
    : index % SPEAKER_COLORS.length;
  return SPEAKER_COLORS[idx];
}

function colorWithAlpha(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatTimelineTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

export default LandingVisualizer;