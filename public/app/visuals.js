/* ============================================================================
   VoiceIsolate Pro — visuals.js
   Visualization Engine add-on
   ----------------------------------------------------------------------------
   This file is ADDITIVE to the existing VoiceIsolatePro app. It does NOT
   replace any existing visualizers — it provides:

     1. VIP_SPEAKER_COLORS  — single source of truth for per-speaker colors
     2. VIP_INFERNO_LUT     — 256-entry Inferno colormap (Uint8ClampedArray)
     3. VIP_buildInfernoLUT — builder for the LUT above
     4. VisualizationEngine — class that drives:
           • per-speaker VU meters in #panel-vu-meters  (DOM, no canvas)
           • diarization timeline on #diarCanvas       (2D canvas)
           • optional SPECTRAL_FRAME consumer from dsp-processor.js

   The engine is designed to run ALONGSIDE the existing diagnostic dashboard
   (6-panel, drawn by VoiceIsolatePro itself). It does NOT duplicate polling:
     • VU meters & diarization timeline run on the engine's own RAF loop,
       but they read from the SAME AnalyserNode instances that the existing
       diagnostic dashboard already uses — no new analysers are created.
     • SPECTRAL_FRAME consumption is passive: if the dsp-processor worklet
       emits SPECTRAL_FRAME messages, we attach a magnitude/phase buffer to
       `engine.lastSpectralFrame` for other consumers. We do NOT try to
       re-render the spectrogram here (the existing startSpectro() owns it).

   CONSTRAINTS satisfied:
     • 100% local — no fetch(), no CDN. Loaded via <script src="./visuals.js">.
     • Single canvas context per canvas — the engine only touches canvases
       that the existing app does NOT already own.
     • One RAF loop — the engine has exactly one requestAnimationFrame loop.
     • Speaker colors are a single source of truth (VIP_SPEAKER_COLORS).
     • No ES module syntax — exposes globals on `window` so it works with
       the existing `<script src="...">` loading pattern in index.html.
============================================================================ */

/* eslint-disable no-var */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. SPEAKER_COLORS — single source of truth                          */
  /* ------------------------------------------------------------------ */
  // 8 perceptually distinct colors. Index 0 is the isolated target voice
  // and is the same cyan the rest of the app already uses for "processed".
  var SPEAKER_COLORS = [
    '#22d3ee', // Speaker 0 — target / isolated  (cyan, matches app chrome)
    '#ff4081', // Speaker 1 — hot pink
    '#69ff47', // Speaker 2 — lime green
    '#ff9100', // Speaker 3 — amber
    '#d500f9', // Speaker 4 — purple
    '#ffea00', // Speaker 5 — yellow
    '#00e676', // Speaker 6 — mint
    '#ff6d00'  // Speaker 7 — deep orange
  ];

  /* ------------------------------------------------------------------ */
  /* 2. Inferno Colormap LUT                                             */
  /* ------------------------------------------------------------------ */
  // Returns a Uint8ClampedArray of length 256*3 (RGB triplets). Built by
  // linear interpolation between matplotlib Inferno control points.
  function buildInfernoLUT() {
    var lut = new Uint8ClampedArray(256 * 3);
    // Control points: [index, r, g, b]
    var stops = [
      [0,     0,   0,   4],
      [32,   40,  11,  84],
      [64,  101,  21, 110],
      [96,  159,  42,  99],
      [128, 212,  72,  66],
      [160, 245, 125,  21],
      [192, 252, 185,  15],
      [224, 252, 230,  90],
      [255, 252, 255, 164]
    ];
    for (var s = 0; s < stops.length - 1; s++) {
      var a = stops[s];
      var b = stops[s + 1];
      var i0 = a[0], i1 = b[0];
      var r0 = a[1], g0 = a[2], b0 = a[3];
      var r1 = b[1], g1 = b[2], b1 = b[3];
      var span = i1 - i0;
      for (var x = i0; x <= i1; x++) {
        var t = span > 0 ? (x - i0) / span : 0;
        lut[x * 3]     = Math.round(r0 + t * (r1 - r0));
        lut[x * 3 + 1] = Math.round(g0 + t * (g1 - g0));
        lut[x * 3 + 2] = Math.round(b0 + t * (b1 - b0));
      }
    }
    return lut;
  }

  var INFERNO_LUT = buildInfernoLUT();

  // Helper: sample the Inferno LUT at a normalized value in [0, 1].
  // gamma < 1 brightens, > 1 darkens. Returns a CSS 'rgb(r,g,b)' string.
  function inferno(v, gamma) {
    if (!(v > 0)) v = 0;
    if (v > 1) v = 1;
    if (gamma && gamma !== 1) v = Math.pow(v, gamma);
    var idx = Math.min(255, Math.floor(v * 255)) * 3;
    return 'rgb(' + INFERNO_LUT[idx] + ',' + INFERNO_LUT[idx + 1] + ',' + INFERNO_LUT[idx + 2] + ')';
  }

  /* ------------------------------------------------------------------ */
  /* 3. VU Meter DOM helpers                                             */
  /* ------------------------------------------------------------------ */
  // Builds <div class="vu-meter"> elements inside a container for N speakers.
  // Each meter has its own color (from SPEAKER_COLORS) set as a CSS custom
  // property so the --speaker-color / --vu-level driven CSS can style it.
  function buildVUMeterPanel(panelEl, numSpeakers) {
    if (!panelEl) return [];
    panelEl.innerHTML = '';
    var meters = [];
    for (var i = 0; i < numSpeakers; i++) {
      var color = SPEAKER_COLORS[i % SPEAKER_COLORS.length];

      var wrap = document.createElement('div');
      wrap.className = 'vu-meter';
      wrap.dataset.speaker = String(i);
      wrap.style.setProperty('--speaker-color', color);
      wrap.style.setProperty('--vu-level', '0%');
      wrap.style.setProperty('--peak-top', '100%');

      var bar = document.createElement('div');
      bar.className = 'vu-meter-fill';
      wrap.appendChild(bar);

      var peak = document.createElement('div');
      peak.className = 'vu-meter-peak';
      wrap.appendChild(peak);

      var label = document.createElement('span');
      label.className = 'vu-meter-label';
      label.textContent = 'SPK ' + i;
      wrap.appendChild(label);

      panelEl.appendChild(wrap);
      meters.push({ el: wrap, bar: bar, peak: peak, label: label,
                    color: color, peakDb: -60, peakHoldUntil: 0 });
    }
    return meters;
  }

  // Convert a linear RMS value to a 0..100 bar height. Floor = -60 dBFS.
  function rmsLinearToPct(rmsLin) {
    if (!(rmsLin > 1e-6)) return 0;
    var db = 20 * Math.log10(rmsLin);
    if (db < -60) db = -60;
    if (db > 0)   db = 0;
    return (db + 60) / 60 * 100;
  }

  /* ------------------------------------------------------------------ */
  /* 4. VisualizationEngine class                                        */
  /* ------------------------------------------------------------------ */
  /**
   * VisualizationEngine
   *
   * Options:
   *   getAnalysers      : () => { orig: AnalyserNode|null, proc: AnalyserNode|null }
   *                       A getter (not a static reference) because the
   *                       existing app tears down and rebuilds the audio
   *                       graph on every play()/pause()/seek().
   *   workletNode       : AudioWorkletNode | null (optional)
   *                       If provided, we attach a `message` listener for
   *                       SPECTRAL_FRAME messages from dsp-processor.js.
   *   vuPanel           : HTMLElement   — container for VU meters (or null)
   *   diarCanvas        : HTMLCanvasElement — diarization timeline (or null)
   *   getSpeakerState   : () => diarizationState
   *                       Live state getter. Expected shape:
   *                       {
   *                         activeSpeaker:  Number,        // index
   *                         numSpeakers:    Number,        // 1..8
   *                         confidence:     Number,        // 0..1
   *                         speakerRMS:     Float32Array,  // per-speaker lin RMS
   *                         history:        [{speaker, confidence, startTime, endTime}]
   *                       }
   *   maxSpeakers       : Number (default 8)
   */
  function VisualizationEngine(opts) {
    opts = opts || {};
    this.getAnalysers    = opts.getAnalysers || function () { return { orig: null, proc: null }; };
    this.workletNode     = opts.workletNode || null;
    this.vuPanel         = opts.vuPanel || null;
    this.diarCanvas      = opts.diarCanvas || null;
    this.getSpeakerState = opts.getSpeakerState || function () { return null; };
    this.maxSpeakers     = Math.max(1, Math.min(8, opts.maxSpeakers || 8));

    // State
    this._rafId          = 0;
    this._running        = false;
    this._meters         = [];         // VU meter DOM refs
    this._timeBuf        = new Float32Array(2048);
    this._freqBuf        = null;       // lazy alloc based on analyser size
    this._lastFrameTime  = 0;

    // Latest spectral frame received from worklet (passive consumer)
    this.lastSpectralFrame = null;     // { magnitude, phase, rms, timestamp }

    // Diarization timeline state — 30s window, newest at right
    this._diarWindowSec   = 30;
    this._diarLastDrawMs  = 0;
    this._pulsePhase      = 0;

    // Wire SPECTRAL_FRAME listener if we have a worklet
    this._onWorkletMessage = this._onWorkletMessage.bind(this);
    if (this.workletNode && this.workletNode.port) {
      this.workletNode.port.addEventListener('message', this._onWorkletMessage);
      // port.onmessage may already be claimed by the existing app — we use
      // addEventListener so we don't stomp on it. start() is required on
      // MessagePorts that were never assigned onmessage=... but the existing
      // dsp-processor hookups typically use onmessage= so port is already live.
      try { this.workletNode.port.start(); } catch (_) { /* already started */ }
    }

    // Build VU meters if the panel exists
    if (this.vuPanel) {
      this._meters = buildVUMeterPanel(this.vuPanel, this.maxSpeakers);
    }

    // Clear diarization canvas to the app's dark theme
    if (this.diarCanvas) {
      this._resizeCanvas(this.diarCanvas);
      this._clearDiar('Waiting for diarization…');
    }
  }

  VisualizationEngine.prototype._resizeCanvas = function (c) {
    if (!c) return;
    var r = c.getBoundingClientRect();
    if (r.width  > 0) c.width  = Math.floor(r.width);
    if (r.height > 0) c.height = Math.floor(r.height);
  };

  VisualizationEngine.prototype._clearDiar = function (msg) {
    var c = this.diarCanvas;
    if (!c) return;
    var x = c.getContext('2d');
    x.fillStyle = '#030306';
    x.fillRect(0, 0, c.width, c.height);
    if (msg) {
      x.font = '10px Outfit, sans-serif';
      x.fillStyle = 'rgba(255,255,255,0.14)';
      x.textAlign = 'center';
      x.fillText(msg, c.width / 2, c.height / 2 + 3);
    }
  };

  /* ---- SPECTRAL_FRAME consumer (passive) ---- */
  VisualizationEngine.prototype._onWorkletMessage = function (e) {
    var d = e && e.data;
    if (!d || d.type !== 'SPECTRAL_FRAME') return;
    // Store latest frame for any consumers that want to read it. We do
    // not copy — the worklet transfers/sends typed arrays that are owned
    // by the receiver on the main thread after the postMessage.
    this.lastSpectralFrame = {
      magnitude: d.magnitude,
      phase:     d.phase,
      rms:       d.rms,
      timestamp: d.timestamp
    };
  };

  /* ---- Public API ---- */
  VisualizationEngine.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    this._lastFrameTime = performance.now();

    var self = this;
    var loop = function (ts) {
      if (!self._running) return;
      self._rafId = requestAnimationFrame(loop);

      // Skip a frame if analysers aren't ready yet (buildLiveChain hasn't
      // fired, or the user hasn't pressed play).
      var ans = self.getAnalysers();
      if (!ans || !ans.proc) {
        // Still update diarization timeline so the timebase keeps moving.
        self._drawDiarization(ts);
        return;
      }

      self._updateVUMeters(ans.proc);
      self._drawDiarization(ts);
    };
    this._rafId = requestAnimationFrame(loop);
  };

  VisualizationEngine.prototype.stop = function () {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    // Decay all meters back to zero so they don't look frozen.
    for (var i = 0; i < this._meters.length; i++) {
      var m = this._meters[i];
      m.el.style.setProperty('--vu-level', '0%');
      m.el.style.setProperty('--peak-top', '100%');
      m.el.classList.remove('is-target');
    }
  };

  VisualizationEngine.prototype.destroy = function () {
    this.stop();
    if (this.workletNode && this.workletNode.port) {
      try {
        this.workletNode.port.removeEventListener('message', this._onWorkletMessage);
      } catch (_) { /* noop */ }
    }
    if (this.vuPanel) this.vuPanel.innerHTML = '';
    this.lastSpectralFrame = null;
  };

  /* ---- VU meter update loop ---- */
  VisualizationEngine.prototype._updateVUMeters = function (analyser) {
    if (!this._meters.length) return;

    // Read per-speaker RMS from diarization state if present, otherwise
    // derive a single global RMS from the post-chain analyser and route
    // it to the active speaker's meter only.
    var state = this.getSpeakerState() || null;
    var nowMs = performance.now();

    // Figure out how many meters are currently 'active'
    var numSpeakers = state && state.numSpeakers ? Math.min(state.numSpeakers, this._meters.length) : 1;
    var activeIdx   = state && typeof state.activeSpeaker === 'number' ? state.activeSpeaker : 0;

    // Fallback path: no per-speaker RMS array -> derive global RMS from analyser
    var globalRms = 0;
    if (!state || !state.speakerRMS) {
      if (analyser.fftSize !== this._timeBuf.length) {
        this._timeBuf = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(this._timeBuf);
      var sumSq = 0;
      for (var i = 0; i < this._timeBuf.length; i++) {
        var s = this._timeBuf[i];
        sumSq += s * s;
      }
      globalRms = Math.sqrt(sumSq / this._timeBuf.length);
    }

    for (var k = 0; k < this._meters.length; k++) {
      var m = this._meters[k];
      var rmsLin;
      if (state && state.speakerRMS && k < state.speakerRMS.length) {
        rmsLin = state.speakerRMS[k];
      } else if (k === activeIdx && k < numSpeakers) {
        rmsLin = globalRms;
      } else {
        rmsLin = 0;
      }

      var pct = rmsLinearToPct(rmsLin);
      m.el.style.setProperty('--vu-level', pct.toFixed(1) + '%');

      // Peak hold: 2s hold, then fall at ~0.5% per frame
      var curDb = rmsLin > 1e-6 ? 20 * Math.log10(rmsLin) : -60;
      if (curDb > m.peakDb) {
        m.peakDb = curDb;
        m.peakHoldUntil = nowMs + 2000;
      } else if (nowMs > m.peakHoldUntil) {
        m.peakDb = Math.max(-60, m.peakDb - 0.3);
      }
      var peakPct = Math.max(0, Math.min(100, (m.peakDb + 60) / 60 * 100));
      // Peak line top: distance from top of container (0% = top, 100% = bottom)
      m.el.style.setProperty('--peak-top', (100 - peakPct).toFixed(1) + '%');

      // Active speaker glow
      if (k === activeIdx && k < numSpeakers) {
        if (!m.el.classList.contains('is-target')) m.el.classList.add('is-target');
      } else {
        if (m.el.classList.contains('is-target')) m.el.classList.remove('is-target');
      }

      // Hide meters beyond numSpeakers
      m.el.style.display = k < numSpeakers ? '' : 'none';
    }
  };

  /* ---- Diarization timeline ---- */
  VisualizationEngine.prototype._drawDiarization = function (tsMs) {
    var c = this.diarCanvas;
    if (!c) return;
    // Throttle to ~30 fps — the timeline doesn't need 60
    if (tsMs - this._diarLastDrawMs < 33) return;
    this._diarLastDrawMs = tsMs;

    var state = this.getSpeakerState();
    var ctx = c.getContext('2d');
    var w = c.width, h = c.height;

    // Background
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, w, h);

    if (!state || !state.history || state.history.length === 0) {
      this._clearDiar('Waiting for diarization…');
      return;
    }

    var numSpeakers = Math.max(1, Math.min(this.maxSpeakers, state.numSpeakers || 1));
    var laneH = h / numSpeakers;
    var nowSec = (typeof state.currentTime === 'number') ? state.currentTime : (tsMs / 1000);
    var windowStart = nowSec - this._diarWindowSec;
    var pxPerSec = w / this._diarWindowSec;

    // Lane separators + labels
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textBaseline = 'middle';
    for (var lane = 0; lane < numSpeakers; lane++) {
      var laneY = lane * laneH;
      // Lane background stripe
      ctx.fillStyle = (lane % 2 === 0) ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.01)';
      ctx.fillRect(0, laneY, w, laneH);
      // Separator
      if (lane > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, laneY + 0.5);
        ctx.lineTo(w, laneY + 0.5);
        ctx.stroke();
      }
      // Lane label (left-side)
      var laneColor = SPEAKER_COLORS[lane % SPEAKER_COLORS.length];
      ctx.fillStyle = laneColor;
      ctx.globalAlpha = 0.75;
      ctx.fillText('SPK ' + lane, 4, laneY + laneH / 2);
      ctx.globalAlpha = 1;
    }

    // Draw speaker segments within the visible window
    var hist = state.history;
    for (var i = 0; i < hist.length; i++) {
      var seg = hist[i];
      if (!seg || typeof seg.speaker !== 'number') continue;
      if (seg.endTime   < windowStart) continue;
      if (seg.startTime > nowSec)      continue;

      var segStart = Math.max(seg.startTime, windowStart);
      var segEnd   = Math.min(seg.endTime,   nowSec);
      var xStart = (segStart - windowStart) * pxPerSec;
      var xEnd   = (segEnd   - windowStart) * pxPerSec;
      var segW   = Math.max(1, xEnd - xStart);
      var segLaneY = (seg.speaker % numSpeakers) * laneH;

      var col = SPEAKER_COLORS[seg.speaker % SPEAKER_COLORS.length];
      var conf = typeof seg.confidence === 'number' ? seg.confidence : 1;
      if (conf < 0.4) conf = 0.4;
      if (conf > 1)   conf = 1;
      ctx.fillStyle = col;
      ctx.globalAlpha = conf;
      ctx.fillRect(xStart, segLaneY + 3, segW, laneH - 6);
      ctx.globalAlpha = 1;
    }

    // Current-time cursor (right edge)
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w - 1, 0);
    ctx.lineTo(w - 1, h);
    ctx.stroke();

    // Active speaker lane: pulsing glow bar on the right
    var activeIdx = typeof state.activeSpeaker === 'number' ? state.activeSpeaker : 0;
    if (activeIdx >= 0 && activeIdx < numSpeakers) {
      this._pulsePhase = (this._pulsePhase + 0.08) % (Math.PI * 2);
      var glow = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(this._pulsePhase));
      var gLaneY = activeIdx * laneH;
      var gCol = SPEAKER_COLORS[activeIdx % SPEAKER_COLORS.length];
      ctx.fillStyle = gCol;
      ctx.globalAlpha = glow;
      ctx.fillRect(w - 4, gLaneY, 4, laneH);
      ctx.globalAlpha = 1;
    }
  };

  /* ------------------------------------------------------------------ */
  /* 5. Global exports                                                   */
  /* ------------------------------------------------------------------ */
  global.VIP_SPEAKER_COLORS = SPEAKER_COLORS;
  global.VIP_INFERNO_LUT    = INFERNO_LUT;
  global.VIP_buildInfernoLUT = buildInfernoLUT;
  global.VIP_inferno        = inferno;
  global.VisualizationEngine = VisualizationEngine;
})(typeof window !== 'undefined' ? window : this);
