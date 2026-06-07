/**
 * NeonPulse Visualizer Card — VoiceIsolate Pro
 * ─────────────────────────────────────────────
 * Self-contained Card component that attaches to the live
 * AnalyserNode (input OR output) already created in app.js.
 *
 * 5 Visualization Modes:
 *  0 – SPECTRUM BAR    (FFT bars, red→cyan gradient)
 *  1 – WAVEFORM SCOPE  (oscilloscope, cyan line + fill)
 *  2 – RADIAL RING     (polar spectrum ring, neon pulse)
 *  3 – WATERFALL       (scrolling spectrogram, hot-orange)
 *  4 – LISSAJOUS       (stereo X/Y phase, purple trail)
 *
 * Integration:
 *   window.NeonPulseViz.init(analyserNodeL, analyserNodeR?);
 *   window.NeonPulseViz.updateStats({ voice, noise, snr, cpu });
 *
 * CONSTRAINT: 100% local, zero fetch, no cloud.
 */

(() => {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  const MODES = ['SPECTRUM', 'WAVEFORM', 'RADIAL', 'WATERFALL', 'LISSAJOUS'];
  const MODE_COLORS = [
    ['#ff0050', '#00e5ff'],   // spectrum
    ['#00e5ff', '#00ff88'],   // waveform
    ['#bf00ff', '#ff0050'],   // radial
    ['#ff6600', '#ffd600'],   // waterfall
    ['#bf00ff', '#00e5ff'],   // lissajous
  ];

  // ── State ───────────────────────────────────────────────────────
  let _analyserL = null;
  let _analyserR = null;
  let _fftSize   = 2048;
  let _dataL     = null;   // Uint8Array frequency
  let _dataR     = null;
  let _timeL     = null;   // Uint8Array time-domain
  let _timeR     = null;
  let _rafId     = null;
  let _mode      = 0;      // current viz mode
  let _canvas    = null;
  let _ctx       = null;
  let _resizeBound = false;
  let _waterfallBuf = null;  // offscreen ImageData for waterfall
  let _waterfallOff = null;  // OffscreenCanvas or null
  let _peakHold  = new Float32Array(256);
  let _peakDecay = new Float32Array(256);
  let _lissHist  = [];     // trail for lissajous
  let _frame     = 0;
  let _stats     = { voice: 87, noise: 13, snr: 32, cpu: 15 };

  // ── HTML Template ───────────────────────────────────────────────
  function buildCard() {
    const card = document.createElement('div');
    card.className = 'np-card';
    card.id = 'np-visualizer-card';
    card.innerHTML = `
      <div class="np-card-header">
        <span class="np-card-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          NEON PULSE ANALYZER
        </span>
        <span class="np-live-badge">
          <span class="np-live-dot"></span> LIVE
        </span>
      </div>

      <div class="np-tabs" role="tablist" aria-label="Visualizer mode">
        ${MODES.map((m, i) => `
          <button class="np-tab${i===0?' active':''}" data-mode="${i}" role="tab"
            aria-selected="${i===0}" aria-label="${m} view">
            ${m}
          </button>
        `).join('')}
      </div>

      <div class="np-canvas-wrap" id="np-canvas-wrap">
        <canvas class="np-canvas" id="np-canvas" aria-label="Live audio visualizer"></canvas>
        <div class="np-scanline"></div>
      </div>

      <div class="np-stats">
        <div class="np-stat">
          <div class="np-stat-val" id="np-stat-voice">--</div>
          <div class="np-stat-label">Voice %</div>
        </div>
        <div class="np-stat">
          <div class="np-stat-val" id="np-stat-noise">--</div>
          <div class="np-stat-label">Noise %</div>
        </div>
        <div class="np-stat">
          <div class="np-stat-val" id="np-stat-snr">--</div>
          <div class="np-stat-label">SNR dB</div>
        </div>
        <div class="np-stat">
          <div class="np-stat-val" id="np-stat-cpu">--</div>
          <div class="np-stat-label">CPU %</div>
        </div>
      </div>

      <div class="np-legend" id="np-legend"></div>
    `;
    return card;
  }

  // ── Inject CSS link if not already loaded ───────────────────────
  function injectCss() {
    if (document.getElementById('np-styles')) return;
    const link = document.createElement('link');
    link.id   = 'np-styles';
    link.rel  = 'stylesheet';
    link.href = './neon-pulse-visualizer.css';
    document.head.appendChild(link);
  }

  // ── Mount card into a target element ────────────────────────────
  function mount(targetSelector) {
    injectCss();
    const target = typeof targetSelector === 'string'
      ? document.querySelector(targetSelector)
      : targetSelector;
    if (!target) { console.warn('[NeonPulse] Mount target not found:', targetSelector); return; }
    const card = buildCard();
    target.appendChild(card);
    _canvas = card.querySelector('#np-canvas');
    _ctx    = _canvas.getContext('2d', { alpha: false });
    resizeCanvas();
    bindTabs(card);
    setLegend();
    if (!_resizeBound) {
      window.addEventListener('resize', resizeCanvas);
      _resizeBound = true;
    }
    return card;
  }

  // ── Canvas DPI-aware resize ──────────────────────────────────────
  function resizeCanvas() {
    if (!_canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = _canvas.getBoundingClientRect();
    _canvas.width  = Math.round(rect.width  * dpr);
    _canvas.height = Math.round(rect.height * dpr);
    _ctx.scale(dpr, dpr);
    // Invalidate waterfall buffer on resize
    _waterfallBuf = null;
    _waterfallOff = null;
  }

  // ── Tab switching ────────────────────────────────────────────────
  function bindTabs(card) {
    card.querySelectorAll('.np-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _mode = parseInt(btn.dataset.mode, 10);
        card.querySelectorAll('.np-tab').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn);
        });
        _lissHist = [];
        _peakHold.fill(0);
        setLegend();
      });
    });
  }

  // ── Legend labels per mode ───────────────────────────────────────
  function setLegend() {
    const el = document.getElementById('np-legend');
    if (!el) return;
    const legends = [
      [['#ff0050','Voice'], ['#00e5ff','Background'], ['#ffd600','Peak Hold']],
      [['#00e5ff','Input Waveform'], ['#00ff88','Output Waveform']],
      [['#bf00ff','Radial Spectrum'], ['#ff0050','Peak Ring']],
      [['#ff6600','Low Freq'], ['#ffd600','Mid Freq'], ['#00e5ff','High Freq']],
      [['#bf00ff','L+R Phase'], ['#00e5ff','Lissajous Trail']],
    ];
    el.innerHTML = (legends[_mode] || []).map(([c,l]) =>
      `<span class="np-legend-item"><span class="np-legend-dot" style="background:${c}"></span>${l}</span>`
    ).join('');
  }

  // ── Init: receive AnalyserNodes from app.js ──────────────────────
  function init(analyserL, analyserR) {
    _analyserL = analyserL;
    _analyserR = analyserR || analyserL;
    _fftSize   = _analyserL.fftSize || 2048;
    _dataL  = new Uint8Array(_analyserL.frequencyBinCount);
    _dataR  = new Uint8Array(_analyserR.frequencyBinCount);
    _timeL  = new Uint8Array(_fftSize);
    _timeR  = new Uint8Array(_fftSize);
    _peakHold  = new Float32Array(_analyserL.frequencyBinCount);
    _peakDecay = new Float32Array(_analyserL.frequencyBinCount);
    if (_rafId) cancelAnimationFrame(_rafId);
    loop();
  }

  // ── Update stats from app state ──────────────────────────────────
  function updateStats(s) {
    Object.assign(_stats, s);
    const set = (id, v, unit='') => {
      const el = document.getElementById(id);
      if (el) el.textContent = (typeof v === 'number' ? Math.round(v) : v) + unit;
    };
    set('np-stat-voice', _stats.voice, '%');
    set('np-stat-noise', _stats.noise, '%');
    set('np-stat-snr',   _stats.snr,   '');
    set('np-stat-cpu',   _stats.cpu,   '%');
  }

  // ── Render loop ──────────────────────────────────────────────────
  function loop() {
    _rafId = requestAnimationFrame(loop);
    if (!_canvas || !_analyserL) return;
    _frame++;
    const W = _canvas.width  / (window.devicePixelRatio || 1);
    const H = _canvas.height / (window.devicePixelRatio || 1);
    _analyserL.getByteFrequencyData(_dataL);
    _analyserR.getByteFrequencyData(_dataR);
    _analyserL.getByteTimeDomainData(_timeL);
    _analyserR.getByteTimeDomainData(_timeR);
    switch (_mode) {
      case 0: drawSpectrum(W, H);   break;
      case 1: drawWaveform(W, H);   break;
      case 2: drawRadial(W, H);     break;
      case 3: drawWaterfall(W, H);  break;
      case 4: drawLissajous(W, H);  break;
    }
    // Peak flash on canvas wrap
    peakFlash();
  }

  // ── MODE 0: Spectrum Bars ────────────────────────────────────────
  function drawSpectrum(W, H) {
    const c = _ctx;
    c.fillStyle = '#060608';
    c.fillRect(0, 0, W, H);

    const bins = _dataL.length;
    const barW = Math.max(1, W / bins * 2.2);
    const grad = c.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0,   '#ff0050');
    grad.addColorStop(0.5, '#ff6600');
    grad.addColorStop(1,   '#00e5ff');

    for (let i = 0; i < bins; i++) {
      const x  = (i / bins) * W;
      const v  = _dataL[i] / 255;
      const bh = v * H;

      // Update peak hold
      if (v > _peakHold[i]) { _peakHold[i] = v; _peakDecay[i] = 0; }
      else { _peakDecay[i]++; if (_peakDecay[i] > 40) _peakHold[i] = Math.max(0, _peakHold[i] - 0.005); }

      // Bar
      c.fillStyle = grad;
      c.fillRect(x, H - bh, barW, bh);

      // Glow overlay
      if (v > 0.6) {
        c.fillStyle = `rgba(0,229,255,${(v - 0.6) * 0.4})`;
        c.fillRect(x, H - bh, barW, 2);
      }

      // Peak hold line
      const ph = _peakHold[i] * H;
      c.fillStyle = '#ffd600';
      c.fillRect(x, H - ph - 1, barW, 2);
    }

    // Grid lines
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    c.lineWidth = 1;
    for (let db = 0.25; db < 1; db += 0.25) {
      const y = H * (1 - db);
      c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
    }
    // Freq labels
    const freqLabels = ['100', '500', '1k', '5k', '10k', '20k'];
    const freqPos    = [0.02, 0.1, 0.2, 0.6, 0.8, 0.99];
    c.fillStyle = 'rgba(255,255,255,0.25)';
    c.font = '9px Courier New';
    freqPos.forEach((p, i) => c.fillText(freqLabels[i], p * W, H - 4));
  }

  // ── MODE 1: Waveform Scope ───────────────────────────────────────
  function drawWaveform(W, H) {
    const c = _ctx;
    c.fillStyle = '#060608';
    c.fillRect(0, 0, W, H);

    // Grid
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * H;
      c.beginPath(); c.moveTo(0,y); c.lineTo(W,y); c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.03)';
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * W;
      c.beginPath(); c.moveTo(x,0); c.lineTo(x,H); c.stroke();
    }

    // Channel L (cyan)
    drawWaveLine(_timeL, W, H, '#00e5ff', 0.18);
    // Channel R (green, if stereo and differs)
    if (_analyserR !== _analyserL) drawWaveLine(_timeR, W, H, '#00ff88', 0.09);

    // Zero axis
    c.strokeStyle = 'rgba(255,255,255,0.2)';
    c.lineWidth = 1;
    c.setLineDash([4,4]);
    c.beginPath(); c.moveTo(0,H/2); c.lineTo(W,H/2); c.stroke();
    c.setLineDash([]);
  }

  function drawWaveLine(data, W, H, color, fillAlpha) {
    const c = _ctx;
    const step = W / data.length;
    c.strokeStyle = color;
    c.lineWidth = 1.5;
    c.shadowColor = color;
    c.shadowBlur  = 8;
    c.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = ((data[i] / 128.0) - 1) * (H / 2) + H / 2;
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    c.shadowBlur = 0;
    // Fill
    c.lineTo(W, H/2); c.lineTo(0, H/2); c.closePath();
    c.fillStyle = color.replace(')', `,${fillAlpha})`).replace('rgb', 'rgba').replace('#', 'rgba(').replace('rgba(00e5ff', 'rgba(0,229,255').replace('rgba(00ff88','rgba(0,255,136');
    // Safer fill using globalAlpha
    c.globalAlpha = fillAlpha;
    c.fillStyle   = color;
    c.fill();
    c.globalAlpha = 1;
  }

  // ── MODE 2: Radial Ring ──────────────────────────────────────────
  function drawRadial(W, H) {
    const c  = _ctx;
    const cx = W / 2, cy = H / 2;
    const r0 = Math.min(W, H) * 0.28;
    c.fillStyle = '#060608';
    c.fillRect(0, 0, W, H);

    // Rotating hue ring
    const hue = (_frame * 0.4) % 360;
    const gBg = c.createRadialGradient(cx,cy,r0*0.3,cx,cy,r0*1.4);
    gBg.addColorStop(0, `hsla(${hue},80%,10%,0.15)`);
    gBg.addColorStop(1, 'transparent');
    c.fillStyle = gBg;
    c.fillRect(0,0,W,H);

    const bins  = Math.min(_dataL.length, 128);
    const step  = (2 * Math.PI) / bins;

    for (let i = 0; i < bins; i++) {
      const v     = _dataL[i] / 255;
      const angle = i * step - Math.PI / 2;
      const len   = v * r0 * 0.8;
      const x0    = cx + Math.cos(angle) * r0;
      const y0    = cy + Math.sin(angle) * r0;
      const x1    = cx + Math.cos(angle) * (r0 + len);
      const y1    = cy + Math.sin(angle) * (r0 + len);

      const lh = (hue + i * 2.8) % 360;
      c.strokeStyle = `hsl(${lh},100%,${55 + v * 35}%)`;
      c.lineWidth   = 1.5 + v * 2;
      c.shadowColor = `hsl(${lh},100%,60%)`;
      c.shadowBlur  = 6 + v * 10;
      c.beginPath(); c.moveTo(x0,y0); c.lineTo(x1,y1); c.stroke();
    }
    c.shadowBlur = 0;

    // Inner circle
    c.beginPath();
    c.arc(cx, cy, r0, 0, 2*Math.PI);
    c.strokeStyle = 'rgba(191,0,255,0.4)';
    c.lineWidth   = 1.5;
    c.stroke();

    // Center label
    c.fillStyle = 'rgba(255,255,255,0.5)';
    c.font = '10px Courier New';
    c.textAlign = 'center';
    c.fillText('SPECTRUM', cx, cy + 4);
    c.textAlign = 'left';
  }

  // ── MODE 3: Waterfall (scrolling spectrogram) ────────────────────
  function drawWaterfall(W, H) {
    const c  = _ctx;
    const IW = Math.floor(W);
    const IH = Math.floor(H);

    // Init offscreen
    if (!_waterfallBuf || _waterfallBuf.width !== IW) {
      _waterfallOff = document.createElement('canvas');
      _waterfallOff.width  = IW;
      _waterfallOff.height = IH;
      const oc = _waterfallOff.getContext('2d');
      oc.fillStyle = '#030305';
      oc.fillRect(0,0,IW,IH);
    }

    const oc = _waterfallOff.getContext('2d');
    // Scroll up 1 row
    const img = oc.getImageData(0,1,IW,IH-1);
    oc.putImageData(img,0,0);

    // Draw new row at bottom
    const bins = _dataL.length;
    for (let i = 0; i < IW; i++) {
      const binIdx = Math.floor((i / IW) * bins);
      const v      = _dataL[binIdx] / 255;
      // hot colormap: black→red→orange→yellow→white
      let r = 0, g = 0, b = 0;
      if (v < 0.25)      { r = v * 4 * 200; }
      else if (v < 0.5)  { r = 200 + (v-0.25)*4*55; g = (v-0.25)*4*100; }
      else if (v < 0.75) { r = 255; g = 100 + (v-0.5)*4*155; }
      else               { r = 255; g = 255; b = (v-0.75)*4*255; }
      oc.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      oc.fillRect(i, IH-1, 1, 1);
    }

    c.drawImage(_waterfallOff, 0, 0, W, H);

    // Frequency guides
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth = 1;
    [0.1, 0.3, 0.6, 0.9].forEach(p => {
      c.beginPath(); c.moveTo(p*W,0); c.lineTo(p*W,H); c.stroke();
    });
  }

  // ── MODE 4: Lissajous Phase Plot ─────────────────────────────────
  function drawLissajous(W, H) {
    const c  = _ctx;
    const cx = W/2, cy = H/2;
    const r  = Math.min(W,H) * 0.44;
    c.fillStyle = 'rgba(6,6,8,0.35)';
    c.fillRect(0,0,W,H);

    // Axes
    c.strokeStyle = 'rgba(255,255,255,0.08)';
    c.lineWidth   = 1;
    c.beginPath(); c.moveTo(cx,0); c.lineTo(cx,H); c.stroke();
    c.beginPath(); c.moveTo(0,cy); c.lineTo(W,cy); c.stroke();
    // Diagonal guides
    c.strokeStyle = 'rgba(255,255,255,0.04)';
    c.beginPath(); c.moveTo(cx-r,cy-r); c.lineTo(cx+r,cy+r); c.stroke();
    c.beginPath(); c.moveTo(cx+r,cy-r); c.lineTo(cx-r,cy+r); c.stroke();

    const N = Math.min(_timeL.length, 512);
    for (let i = 0; i < N; i++) {
      const x = cx + ((_timeL[i] / 128.0) - 1) * r;
      const y = cy - ((_timeR[i] / 128.0) - 1) * r;
      _lissHist.push({ x, y, age: 0 });
    }
    // Age and trim
    const MAX_TRAIL = 2000;
    if (_lissHist.length > MAX_TRAIL) _lissHist.splice(0, _lissHist.length - MAX_TRAIL);

    for (let i = 0; i < _lissHist.length; i++) {
      const p   = _lissHist[i];
      p.age++;
      const t   = 1 - p.age / MAX_TRAIL;
      const hue = (240 + (1-t) * 120) % 360;
      c.fillStyle = `hsla(${hue},100%,65%,${t * 0.8})`;
      c.fillRect(p.x - 1, p.y - 1, 2, 2);
    }
  }

  // ── Peak flash ───────────────────────────────────────────────────
  let _lastPeak = 0;
  function peakFlash() {
    if (!_dataL) return;
    const max = Math.max(...Array.from(_dataL).slice(0, 20));
    if (max > 230 && Date.now() - _lastPeak > 300) {
      _lastPeak = Date.now();
      const wrap = document.getElementById('np-canvas-wrap');
      if (wrap) {
        wrap.classList.remove('np-peak-flash');
        void wrap.offsetWidth;
        wrap.classList.add('np-peak-flash');
      }
    }
  }

  // ── Demo mode (no analyser — uses synthetic data) ────────────────
  function startDemo() {
    _analyserL = createFakeAnalyser();
    _analyserR = _analyserL;
    _dataL  = new Uint8Array(1024);
    _dataR  = new Uint8Array(1024);
    _timeL  = new Uint8Array(2048);
    _timeR  = new Uint8Array(2048);
    _peakHold  = new Float32Array(1024);
    _peakDecay = new Float32Array(1024);
    if (_rafId) cancelAnimationFrame(_rafId);
    loop();
  }

  function createFakeAnalyser() {
    let t = 0;
    return {
      frequencyBinCount: 1024,
      fftSize: 2048,
      getByteFrequencyData(arr) {
        t += 0.03;
        for (let i = 0; i < arr.length; i++) {
          const f = i / arr.length;
          arr[i] = Math.max(0, Math.min(255,
            180 * Math.exp(-f * 4) * (0.7 + 0.3 * Math.sin(t + i * 0.05))
            + 40 * Math.exp(-((f-0.3)**2)*60) * (0.5 + 0.5*Math.sin(t*2.3+i*0.1))
            + 20 * Math.random()
          ));
        }
      },
      getByteTimeDomainData(arr) {
        t += 0.003;
        for (let i = 0; i < arr.length; i++) {
          arr[i] = 128 + 60 * Math.sin((i/arr.length)*6.28*3 + t*4)
                       + 20 * Math.sin((i/arr.length)*6.28*11 + t*7)
                       + 10 * (Math.random()-0.5);
        }
      }
    };
  }

  // ── Public API ───────────────────────────────────────────────────
  window.NeonPulseViz = {
    mount,
    init,
    updateStats,
    startDemo,
    setMode: m => { _mode = m; _lissHist = []; _peakHold.fill(0); },
  };

})();
