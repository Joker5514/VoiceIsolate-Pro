/**
 * NeonPulseCard v2.0 — VoiceIsolate Pro
 * ─────────────────────────────────────
 * A self-contained, responsive "Card" component that:
 *  1. Renders itself into any container element via NeonPulseCard.mount(selector)
 *  2. Subscribes to the global PipelineState bus for live AnalyserNode data
 *  3. Renders 4 simultaneous animated graph types on a single Canvas:
 *       - FFT Spectrum Bars (bottom)
 *       - Oscilloscope Waveform (mid)
 *       - Circular Radial Burst (centre)
 *       - Waterfall Spectrogram (top strip)
 *  4. Exposes a public API:  card.setMode(mode) | card.destroy()
 *
 * 100% local — zero fetch calls to external servers.
 * Works in AudioWorklet Live mode AND OfflineAudioContext Creator mode.
 */

(function (global) {
  'use strict';

  /* ══════════════════════════════════════════
     CONSTANTS & THEME
  ══════════════════════════════════════════ */
  const THEME = {
    bg:           '#090b10',
    card:         '#0d1117',
    border:       '#1e2d40',
    glow1:        '#00ffe7',  // cyan
    glow2:        '#bf00ff',  // violet
    glow3:        '#ff3cac',  // hot-pink
    glow4:        '#f7971e',  // amber
    text:         '#c8d8e8',
    textDim:      '#4a6070',
    accent:       '#00ffe7',
    labelFont:    "11px 'JetBrains Mono', 'Fira Code', monospace",
  };

  const FFT_SIZE     = 2048;
  const SMOOTH       = 0.82;
  const MODES        = ['spectrum', 'waveform', 'radial', 'waterfall', 'combined'];

  /* ══════════════════════════════════════════
     CARD HTML TEMPLATE
  ══════════════════════════════════════════ */
  function buildTemplate(uid) {
    return `
<div class="np-card" id="np-card-${uid}" role="region" aria-label="Neon Pulse Visualizer">
  <div class="np-card__header">
    <span class="np-card__badge">LIVE</span>
    <span class="np-card__title">Neon Pulse <span class="np-accent">Visualizer</span></span>
    <div class="np-card__controls">
      <button class="np-btn np-btn--mode" data-mode="combined"   aria-label="Combined view" title="Combined">⬡</button>
      <button class="np-btn np-btn--mode" data-mode="spectrum"   aria-label="Spectrum view" title="Spectrum">▤</button>
      <button class="np-btn np-btn--mode" data-mode="waveform"   aria-label="Waveform view" title="Waveform">〜</button>
      <button class="np-btn np-btn--mode" data-mode="radial"     aria-label="Radial view" title="Radial">◎</button>
      <button class="np-btn np-btn--mode" data-mode="waterfall"  aria-label="Waterfall view" title="Waterfall">▦</button>
      <button class="np-btn np-btn--action" id="np-freeze-${uid}" aria-label="Freeze visualizer" title="Freeze">❄</button>
    </div>
  </div>

  <div class="np-canvas-wrap">
    <canvas class="np-canvas" id="np-canvas-${uid}" role="img" aria-label="Live audio visualizer"></canvas>
    <div class="np-overlay-stats" id="np-stats-${uid}">
      <span class="np-stat" id="np-rms-${uid}">RMS <b>—</b></span>
      <span class="np-stat" id="np-peak-${uid}">PEAK <b>—</b></span>
      <span class="np-stat" id="np-snr-${uid}">SNR <b>—</b></span>
    </div>
  </div>

  <div class="np-card__footer">
    <span class="np-label" id="np-mode-label-${uid}">Mode: combined</span>
    <span class="np-label" id="np-fps-${uid}">60 fps</span>
    <span class="np-label" id="np-bins-${uid}">FFT ${FFT_SIZE}</span>
  </div>
</div>`;
  }

  /* ══════════════════════════════════════════
     INLINED CSS  (injected once per page)
  ══════════════════════════════════════════ */
  function injectStyles() {
    if (document.getElementById('np-card-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-card-styles';
    s.textContent = `
/* ── NeonPulseCard v2 ── */
.np-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: ${THEME.card};
  border: 1px solid ${THEME.border};
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 0 28px rgba(0,255,231,.06), 0 0 6px rgba(191,0,255,.06);
  transition: box-shadow .3s ease;
  font-family: 'JetBrains Mono','Fira Code',monospace;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}
.np-card:hover {
  box-shadow: 0 0 44px rgba(0,255,231,.18), 0 0 16px rgba(191,0,255,.14);
}
/* ── Header ── */
.np-card__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: rgba(255,255,255,.02);
  border-bottom: 1px solid ${THEME.border};
  flex-wrap: wrap;
}
.np-card__badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 2px;
  color: ${THEME.bg};
  background: ${THEME.glow1};
  padding: 2px 7px;
  border-radius: 4px;
  animation: np-badge-pulse 1.8s ease-in-out infinite;
}
@keyframes np-badge-pulse {
  0%,100% { box-shadow: 0 0 4px ${THEME.glow1}; }
  50%      { box-shadow: 0 0 14px ${THEME.glow1}, 0 0 24px rgba(0,255,231,.4); }
}
.np-card__title {
  flex: 1;
  font-size: 13px;
  color: ${THEME.text};
  letter-spacing: .5px;
}
.np-accent { color: ${THEME.glow1}; }
/* ── Mode Buttons ── */
.np-card__controls {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.np-btn {
  background: transparent;
  border: 1px solid ${THEME.border};
  color: ${THEME.textDim};
  border-radius: 7px;
  padding: 4px 9px;
  font-size: 14px;
  cursor: pointer;
  transition: all .2s;
  line-height: 1;
}
.np-btn:hover, .np-btn.active {
  border-color: ${THEME.glow1};
  color: ${THEME.glow1};
  box-shadow: 0 0 8px rgba(0,255,231,.35);
  background: rgba(0,255,231,.06);
}
.np-btn--action {
  border-color: ${THEME.glow2};
  color: ${THEME.glow2};
}
.np-btn--action.frozen {
  background: rgba(191,0,255,.15);
  box-shadow: 0 0 10px rgba(191,0,255,.5);
}
/* ── Canvas ── */
.np-canvas-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16/7;
  background: ${THEME.bg};
}
.np-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
/* ── Overlay Stats ── */
.np-overlay-stats {
  position: absolute;
  top: 8px; right: 10px;
  display: flex;
  gap: 10px;
  pointer-events: none;
}
.np-stat {
  font-size: 10px;
  color: ${THEME.textDim};
  letter-spacing: .5px;
}
.np-stat b { color: ${THEME.glow1}; }
/* ── Footer ── */
.np-card__footer {
  display: flex;
  gap: 14px;
  padding: 6px 14px;
  border-top: 1px solid ${THEME.border};
  background: rgba(255,255,255,.01);
  flex-wrap: wrap;
}
.np-label {
  font-size: 10px;
  color: ${THEME.textDim};
  letter-spacing: .5px;
}
/* ── Entrance animation ── */
@keyframes np-slide-in {
  from { opacity: 0; transform: translateY(18px); }
  to   { opacity: 1; transform: translateY(0); }
}
.np-card { animation: np-slide-in .45s cubic-bezier(.22,.68,0,1.2) both; }

/* ══ MOBILE ══════════════════════════════════ */
@media (max-width: 600px) {
  .np-card { border-radius: 10px; }
  .np-card__header { padding: 8px 10px; gap: 6px; }
  .np-card__title { font-size: 11px; }
  .np-btn { padding: 4px 7px; font-size: 13px; }
  .np-overlay-stats { top: 5px; right: 6px; gap: 6px; }
  .np-stat { font-size: 9px; }
  .np-card__footer { padding: 4px 10px; gap: 10px; }
  .np-label { font-size: 9px; }
}
@media (max-width: 400px) {
  .np-card__controls .np-btn--mode:nth-child(n+4) { display: none; }
}
    `;
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════════
     CORE VISUALIZER CLASS
  ══════════════════════════════════════════ */
  class NeonPulseCard {
    constructor(container, options = {}) {
      this._uid      = Math.random().toString(36).slice(2, 7);
      this._container = typeof container === 'string'
        ? document.querySelector(container)
        : container;

      if (!this._container) throw new Error('[NeonPulseCard] container not found');

      injectStyles();

      this._container.insertAdjacentHTML('beforeend', buildTemplate(this._uid));

      this._card    = document.getElementById(`np-card-${this._uid}`);
      this._canvas  = document.getElementById(`np-canvas-${this._uid}`);
      this._ctx     = this._canvas.getContext('2d', { alpha: false });

      this._mode    = options.mode || 'combined';
      this._frozen  = false;
      this._rafId   = null;

      // DSP state (injected by PipelineState or set manually)
      this._analyser    = null;   // Web Audio AnalyserNode
      this._freqData    = null;   // Uint8Array
      this._timeData    = null;   // Uint8Array
      this._rms         = 0;
      this._peak        = -Infinity;
      this._snr         = 0;

      // Waterfall history buffer
      this._waterfallBuf = [];
      this._waterfallMax = 80; // rows

      // Radial rotation
      this._radialAngle = 0;

      // FPS tracker
      this._fpsLastTime = performance.now();
      this._fpsFrames   = 0;
      this._fps         = 60;

      this._bindEvents();
      this._resize();
      this._connectToAppState();
      this._startRaf();
    }

    /* ── Event bindings ──────────────────────── */
    _bindEvents() {
      this._card.querySelectorAll('.np-btn--mode').forEach(btn => {
        btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
      });
      document.getElementById(`np-freeze-${this._uid}`)
        .addEventListener('click', () => this._toggleFreeze());

      let roPending = false;
      this._ro = new ResizeObserver(() => {
        if (roPending) return;
        roPending = true;
        requestAnimationFrame(() => {
          roPending = false;
          this._resize();
        });
      });
      this._ro.observe(this._canvas);
    }

    /* ── Resize canvas to display size ────────── */
    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this._canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));
      this._canvas.width = cssW * dpr;
      this._canvas.height = cssH * dpr;
      this._canvas.style.width = cssW + 'px';
      this._canvas.style.height = cssH + 'px';
      this._ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._ctx.scale(dpr, dpr);
      this._W = cssW;
      this._H = cssH;
    }

    /* ── Wire to global PipelineState ─────────── */
    _connectToAppState() {
      // Strategy 1: PipelineState event bus (preferred)
      if (global.PipelineState && typeof global.PipelineState.on === 'function') {
        global.PipelineState.on('analyser:ready', (analyser) => {
          this.connectAnalyser(analyser);
        });
        // Pick up already-live analyser immediately
        if (global.PipelineState.analyser) {
          this.connectAnalyser(global.PipelineState.analyser);
        }
      }

      // Strategy 2: poll window.VIPApp for analyserNode (legacy boot path)
      if (!this._analyser) {
        this._pollTimer = setInterval(() => {
          const a = global.VIPApp?.analyserNode
                 || global.appState?.analyserNode
                 || global.dspCore?.analyserNode;
          if (a) {
            clearInterval(this._pollTimer);
            this.connectAnalyser(a);
          }
        }, 400);
      }
    }

    /* ── Public: attach an AnalyserNode ───────── */
    connectAnalyser(analyser) {
      this._analyser = analyser;
      analyser.fftSize              = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTH;
      this._freqData = new Uint8Array(analyser.frequencyBinCount);
      this._timeData = new Uint8Array(analyser.fftSize);
      console.info('[NeonPulseCard] AnalyserNode connected.');
    }

    /* ── Public: change render mode ────────────── */
    setMode(mode) {
      if (!MODES.includes(mode)) return;
      this._mode = mode;
      this._card.querySelectorAll('.np-btn--mode').forEach(b =>
        b.classList.toggle('active', b.dataset.mode === mode)
      );
      document.getElementById(`np-mode-label-${this._uid}`).textContent = `Mode: ${mode}`;
    }

    _toggleFreeze() {
      this._frozen = !this._frozen;
      document.getElementById(`np-freeze-${this._uid}`)
        .classList.toggle('frozen', this._frozen);
    }

    /* ── RAF loop ───────────────────────────────── */
    _startRaf() {
      const tick = (ts) => {
        this._rafId = requestAnimationFrame(tick);
        if (this._frozen) return;

        // FPS counter
        this._fpsFrames++;
        if (ts - this._fpsLastTime >= 1000) {
          this._fps = this._fpsFrames;
          this._fpsFrames = 0;
          this._fpsLastTime = ts;
          document.getElementById(`np-fps-${this._uid}`).textContent = `${this._fps} fps`;
        }

        this._pullData();
        this._render();
        this._updateStats();
      };
      this._rafId = requestAnimationFrame(tick);
    }

    /* ── Pull data from AnalyserNode ────────────── */
    _pullData() {
      if (!this._analyser) {
        // Generate synthetic idle animation when no audio connected
        if (!this._freqData) {
          this._freqData = new Uint8Array(FFT_SIZE / 2);
          this._timeData = new Uint8Array(FFT_SIZE);
        }
        const t = performance.now() / 1000;
        for (let i = 0; i < this._freqData.length; i++) {
          this._freqData[i] = Math.max(0, Math.min(255,
            20 + 18 * Math.sin(t * 1.2 + i * 0.04) +
            10 * Math.sin(t * 3.1 + i * 0.1) +
            5  * Math.random()
          ));
        }
        for (let i = 0; i < this._timeData.length; i++) {
          this._timeData[i] = 128 + 20 * Math.sin(t * 6 + i * 0.05);
        }
        return;
      }
      this._analyser.getByteFrequencyData(this._freqData);
      this._analyser.getByteTimeDomainData(this._timeData);

      // Compute RMS
      let sum = 0;
      for (let i = 0; i < this._timeData.length; i++) {
        const s = (this._timeData[i] - 128) / 128;
        sum += s * s;
      }
      this._rms = Math.sqrt(sum / this._timeData.length);
      this._peak = Math.max(...this._freqData) / 255;
    }

    /* ── Main render dispatcher ─────────────────── */
    _render() {
      const ctx = this._ctx;
      const W = this._W, H = this._H;

      ctx.fillStyle = THEME.bg;
      ctx.fillRect(0, 0, W, H);

      switch (this._mode) {
        case 'spectrum':   this._drawSpectrum(ctx, W, H, 0, 0, W, H);  break;
        case 'waveform':   this._drawWaveform(ctx, W, H, 0, 0, W, H);  break;
        case 'radial':     this._drawRadial(ctx, W, H, W/2, H/2, Math.min(W,H)*0.42); break;
        case 'waterfall':  this._drawWaterfall(ctx, W, H, 0, 0, W, H); break;
        case 'combined':
        default:           this._drawCombined(ctx, W, H);               break;
      }
    }

    /* ── COMBINED layout ────────────────────────── */
    _drawCombined(ctx, W, H) {
      const topH      = H * 0.18;   // waterfall strip
      const midH      = H * 0.35;   // waveform
      const botH      = H * 0.47;   // spectrum + radial overlay

      this._drawWaterfall(ctx, W, H, 0, 0,              W, topH);
      this._drawWaveform (ctx, W, H, 0, topH,           W, midH);
      this._drawSpectrum (ctx, W, H, 0, topH + midH,    W, botH);

      // Small radial overlay in bottom-right corner
      const r = Math.min(botH, W * 0.18) * 0.45;
      this._drawRadial(ctx, W, H,
        W - r - 12,
        topH + midH + botH * 0.5,
        r * 0.85
      );

      // Divider lines
      ctx.strokeStyle = THEME.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, topH); ctx.lineTo(W, topH);
      ctx.moveTo(0, topH + midH); ctx.lineTo(W, topH + midH);
      ctx.stroke();
    }

    /* ── SPECTRUM BARS ──────────────────────────── */
    _drawSpectrum(ctx, W, H, x0, y0, w, h) {
      if (!this._freqData) return;
      const bins    = Math.min(this._freqData.length, 256);
      const barW    = w / bins;
      const grad    = ctx.createLinearGradient(x0, y0 + h, x0, y0);
      grad.addColorStop(0,   THEME.glow1);
      grad.addColorStop(0.5, THEME.glow2);
      grad.addColorStop(1,   THEME.glow3);

      for (let i = 0; i < bins; i++) {
        const v    = this._freqData[i] / 255;
        const bH   = v * h * 0.95;
        const bx   = x0 + i * barW;
        const by   = y0 + h - bH;

        ctx.fillStyle = grad;
        ctx.fillRect(bx + 0.5, by, Math.max(1, barW - 1), bH);

        // Glow cap
        if (v > 0.5) {
          ctx.shadowColor = THEME.glow1;
          ctx.shadowBlur  = 6;
          ctx.fillRect(bx + 0.5, by, Math.max(1, barW - 1), 2);
          ctx.shadowBlur = 0;
        }
      }

      // Frequency axis labels
      ctx.fillStyle = THEME.textDim;
      ctx.font      = THEME.labelFont;
      const labels  = ['100Hz', '1kHz', '4kHz', '8kHz', '16kHz'];
      const positions = [0.04, 0.2, 0.45, 0.65, 0.9];
      labels.forEach((lbl, i) => {
        ctx.fillText(lbl, x0 + positions[i] * w, y0 + h - 4);
      });
    }

    /* ── OSCILLOSCOPE WAVEFORM ──────────────────── */
    _drawWaveform(ctx, W, H, x0, y0, w, h) {
      if (!this._timeData) return;
      const mid     = y0 + h / 2;
      const slice   = w / this._timeData.length;

      // Background grid
      ctx.strokeStyle = 'rgba(0,255,231,0.04)';
      ctx.lineWidth   = 1;
      for (let g = 0; g <= 4; g++) {
        const gy = y0 + (g / 4) * h;
        ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x0 + w, gy); ctx.stroke();
      }

      // Primary waveform
      const grad = ctx.createLinearGradient(x0, y0, x0 + w, y0);
      grad.addColorStop(0,   THEME.glow1);
      grad.addColorStop(0.5, THEME.glow2);
      grad.addColorStop(1,   THEME.glow3);

      ctx.beginPath();
      ctx.strokeStyle = grad;
      ctx.lineWidth   = 2;
      ctx.shadowColor = THEME.glow1;
      ctx.shadowBlur  = 8;

      for (let i = 0; i < this._timeData.length; i++) {
        const v  = (this._timeData[i] / 128) - 1;
        const px = x0 + i * slice;
        const py = mid + v * (h * 0.45);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Mirror ghost
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(191,0,255,0.18)';
      ctx.lineWidth   = 1;
      for (let i = 0; i < this._timeData.length; i++) {
        const v  = (this._timeData[i] / 128) - 1;
        const px = x0 + i * slice;
        const py = mid - v * (h * 0.45);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    /* ── RADIAL BURST ───────────────────────────── */
    _drawRadial(ctx, W, H, cx, cy, r) {
      if (!this._freqData) return;
      const bins = 128;
      const step = (Math.PI * 2) / bins;
      this._radialAngle += 0.005;

      for (let i = 0; i < bins; i++) {
        const v    = this._freqData[i] / 255;
        const angle = i * step + this._radialAngle;
        const len  = r * (0.25 + v * 0.75);
        const x1   = cx + Math.cos(angle) * r * 0.28;
        const y1   = cy + Math.sin(angle) * r * 0.28;
        const x2   = cx + Math.cos(angle) * (r * 0.28 + len);
        const y2   = cy + Math.sin(angle) * (r * 0.28 + len);

        const hue = (i / bins) * 300 + 160;
        ctx.strokeStyle = `hsla(${hue},100%,65%,${0.5 + v * 0.5})`;
        ctx.lineWidth   = 1 + v * 2;
        ctx.shadowColor = `hsl(${hue},100%,65%)`;
        ctx.shadowBlur  = v * 10;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Inner glow ring
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.28);
      grd.addColorStop(0,   'rgba(0,255,231,0.25)');
      grd.addColorStop(1,   'rgba(0,255,231,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }

    /* ── WATERFALL SPECTROGRAM ──────────────────── */
    _drawWaterfall(ctx, W, H, x0, y0, w, h) {
      if (!this._freqData) return;

      // Push new row
      if (this._waterfallBuf.length >= this._waterfallMax) this._waterfallBuf.shift();
      this._waterfallBuf.push(new Uint8Array(this._freqData.subarray(0, 256)));

      const rows   = this._waterfallBuf.length;
      const rowH   = h / this._waterfallMax;
      const colW   = w / 256;

      for (let r = 0; r < rows; r++) {
        const row   = this._waterfallBuf[rows - 1 - r];
        const ry    = y0 + r * rowH;
        const alpha = 1 - r / this._waterfallMax;

        for (let c = 0; c < 256; c++) {
          const v = row[c] / 255;
          if (v < 0.03) continue;
          const hue = 220 - v * 200;
          ctx.fillStyle = `hsla(${hue},100%,55%,${alpha * v})`;
          ctx.fillRect(x0 + c * colW, ry, Math.max(1, colW), Math.max(1, rowH));
        }
      }
    }

    /* ── HUD stats update ───────────────────────── */
    _updateStats() {
      const rmsDb  = this._rms > 0 ? (20 * Math.log10(this._rms)).toFixed(1) : '-∞';
      const peakDb = this._peak > 0 ? (20 * Math.log10(this._peak)).toFixed(1) : '-∞';

      document.getElementById(`np-rms-${this._uid}`).innerHTML =
        `RMS <b>${rmsDb} dB</b>`;
      document.getElementById(`np-peak-${this._uid}`).innerHTML =
        `PEAK <b>${peakDb} dB</b>`;
      document.getElementById(`np-snr-${this._uid}`).innerHTML =
        `SNR <b>${this._snr ? this._snr.toFixed(1) + ' dB' : '—'}</b>`;
    }

    /* ── Public: receive SNR from pipeline ─────── */
    setSNR(snrDb) { this._snr = snrDb; }

    /* ── Cleanup ─────────────────────────────────── */
    destroy() {
      if (this._rafId)   cancelAnimationFrame(this._rafId);
      if (this._ro)      this._ro.disconnect();
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._card.remove();
    }
  }

  /* ══════════════════════════════════════════
     STATIC FACTORY
  ══════════════════════════════════════════ */
  NeonPulseCard.mount = function (selector, options) {
    return new NeonPulseCard(selector, options);
  };

  /* ══════════════════════════════════════════
     AUTO-MOUNT on DOMContentLoaded
     Looks for <div data-np-card> in the page
  ══════════════════════════════════════════ */
  function autoMount() {
    document.querySelectorAll('[data-np-card]').forEach(el => {
      if (!el._npCard) {
        el._npCard = new NeonPulseCard(el, {
          mode: el.dataset.npMode || 'combined'
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }

  /* ── Export ────────────────────────────────────── */
  global.NeonPulseCard = NeonPulseCard;

}(typeof globalThis !== 'undefined' ? globalThis : window));
