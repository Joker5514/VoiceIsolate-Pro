/* ============================================================
   VoiceIsolate Pro — ASTM FTS Processing Overlay
   Neural Audio Processor · Radial Spectrum + Oscilloscope
   v3.0  ·  VoiceIsolate Pro v25.0.0
   ============================================================ */

(function (global) {
  'use strict';

  /* ── Stage groups ─────────────────────────────────────────── */
  const STAGE_GROUPS = [
    {
      label: 'Input Decode',
      icon: '◉',
      start: 0, end: 4,
      color: 'cyan',
      hue: 180,
      messages: [
        'Decoding audio container…',
        'Allocating ring buffer…',
        'Removing DC offset…',
        'Normalizing peak levels…',
        'Running Voice Activity Detection…'
      ]
    },
    {
      label: 'Time-Domain Cleanup',
      icon: '≈',
      start: 5, end: 8,
      color: 'violet',
      hue: 275,
      messages: [
        'Closing noise gate…',
        'Detecting transient clicks…',
        'Scrubbing hum harmonics…',
        'Mapping sibilance frequencies…',
        'Sculpting pre-spectral dynamics…'
      ]
    },
    {
      label: 'Spectral Isolation',
      icon: '◌',
      start: 9, end: 19,
      color: 'pink',
      hue: 330,
      messages: [
        'Running Forward STFT…',
        'Building adaptive Wiener mask…',
        'Sweeping residual noise floor…',
        'Applying ERB spectral gate…',
        'Boosting speech-band harmonics…',
        'Cancelling stereo crosstalk…',
        'Smoothing temporal artifacts…',
        'Compensating spectral tilt…',
        'Estimating room decay profile…',
        'Reconstructing harmonic detail…',
        'Running Inverse STFT…'
      ]
    },
    {
      label: 'Post Processing',
      icon: '▣',
      start: 20, end: 25,
      color: 'amber',
      hue: 40,
      messages: [
        'Initializing OfflineAudioContext…',
        'Applying parametric EQ…',
        'Shaping multi-stage dynamics…',
        'Engaging brickwall limiter…',
        'Rendering final audio frame…'
      ]
    },
    {
      label: 'Export + Visuals',
      icon: '✦',
      start: 26, end: 31,
      color: 'cyan',
      hue: 186,
      messages: [
        'Blending dry/wet output…',
        'Computing integrated loudness…',
        'Updating waveform display…',
        'Writing forensic audit log…',
        'Preparing 32-bit float export…',
        'Verifying final signal integrity…'
      ]
    }
  ];

  function groupForStage(stageIndex) {
    if (!Number.isFinite(stageIndex)) return STAGE_GROUPS[0];
    return STAGE_GROUPS.find(g => stageIndex >= g.start && stageIndex <= g.end) || STAGE_GROUPS[STAGE_GROUPS.length - 1];
  }

  /* ── NeuralSpinner — radial spectrum + oscilloscope + helix ─────── */
  function NeuralSpinner(canvas) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.progress = 0;
    this.groupHue = 180;
    this.frame   = 0;
    this.running = false;
    this._raf    = null;

    /* Pre-seeded organic noise so every bar feels independent */
    this._phases = [];
    this._speeds = [];
    for (var i = 0; i < 64; i++) {
      this._phases.push(Math.random() * Math.PI * 2);
      this._speeds.push(0.7 + Math.random() * 1.6);
    }

    /* Neural-mesh particle field — orbiting "neurons" */
    this._particles = [];
    var pcount = 14;
    for (var pi = 0; pi < pcount; pi++) {
      this._particles.push({
        angle: (pi / pcount) * Math.PI * 2,
        radius: 70 + Math.random() * 22,
        speed: 0.35 + Math.random() * 0.6,
        size: 1.2 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2
      });
    }
  }

  NeuralSpinner.prototype.start = function () {
    this.running = true;
    this._loop();
  };

  NeuralSpinner.prototype.stop = function () {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  };

  NeuralSpinner.prototype.setProgress = function (pct) {
    this.progress = Math.min(1, Math.max(0, pct / 100));
  };

  NeuralSpinner.prototype.setGroup = function (hue) {
    this.groupHue = hue;
  };

  NeuralSpinner.prototype._loop = function () {
    if (!this.running) return;
    this._draw();
    var self = this;
    this._raf = requestAnimationFrame(function () { self._loop(); });
  };

  NeuralSpinner.prototype._draw = function () {
    var canvas = this.canvas;
    var ctx    = this.ctx;
    var W  = canvas.width;
    var H  = canvas.height;
    var cx = W / 2;
    var cy = H / 2;
    var t  = ++this.frame / 60;
    var p  = this.progress;
    var hue = this.groupHue;

    ctx.clearRect(0, 0, W, H);

    /* Background radial glow */
    var bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
    bgGrad.addColorStop(0,   'rgba(0,255,231,0.06)');
    bgGrad.addColorStop(0.5, 'rgba(157,77,255,0.03)');
    bgGrad.addColorStop(1,   'transparent');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    /* Orbit reference rings (static, dim) */
    var rings = [54, 82, 100];
    for (var ri = 0; ri < rings.length; ri++) {
      ctx.beginPath();
      ctx.arc(cx, cy, rings[ri], 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* ── Radial frequency bars (64 bars) ─────────────────── */
    var barCount = 64;
    var R_INNER  = 56;
    var R_MAX    = 36;     /* max extra radius */

    for (var i = 0; i < barCount; i++) {
      var angle  = (i / barCount) * Math.PI * 2 - Math.PI / 2;
      var phase  = this._phases[i];
      var speed  = this._speeds[i];

      /* Organic amplitude: sum of two sine waves per bar */
      var h = 0.35 + 0.65 * (
        0.5 + 0.3  * Math.sin(t * speed + phase)
            + 0.15 * Math.sin(t * speed * 1.9 + i * 0.21)
            + 0.1  * p
      );
      h = Math.min(1, Math.max(0.05, h));

      var r0 = R_INNER;
      var r1 = R_INNER + R_MAX * h;

      var x0 = cx + r0 * Math.cos(angle);
      var y0 = cy + r0 * Math.sin(angle);
      var x1 = cx + r1 * Math.cos(angle);
      var y1 = cy + r1 * Math.sin(angle);

      /* Hue shifts ±60° across all bars for spectral colour */
      var barHue = (hue + (i / barCount) * 120) % 360;
      var alpha  = 0.45 + 0.55 * h;

      ctx.strokeStyle = 'hsla(' + barHue + ',100%,68%,' + alpha + ')';
      ctx.lineWidth   = 2.2;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    /* ── Oscilloscope polar waveform ─────────────────────── */
    var oR = 46;
    ctx.beginPath();
    var oPoints = 128;
    for (var j = 0; j <= oPoints; j++) {
      var a = (j / oPoints) * Math.PI * 2;
      var wobble = 7 * (
          Math.sin(t * 4.1 + a * 3)   * 0.5
        + Math.sin(t * 2.8 + a * 5 + 1.2) * 0.3
        + Math.sin(t * 6.2 + a * 2)   * 0.2
      ) * (0.5 + 0.5 * p);
      var r = oR + wobble;
      var ox = cx + r * Math.cos(a);
      var oy = cy + r * Math.sin(a);
      if (j === 0) ctx.moveTo(ox, oy);
      else         ctx.lineTo(ox, oy);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,255,231,0.55)';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    /* Oscilloscope glow */
    ctx.beginPath();
    for (var k = 0; k <= oPoints; k++) {
      var ga = (k / oPoints) * Math.PI * 2;
      var gw = 7 * (
          Math.sin(t * 4.1 + ga * 3)   * 0.5
        + Math.sin(t * 2.8 + ga * 5 + 1.2) * 0.3
        + Math.sin(t * 6.2 + ga * 2)   * 0.2
      ) * (0.5 + 0.5 * p);
      var gr = oR + gw;
      var gx = cx + gr * Math.cos(ga);
      var gy = cy + gr * Math.sin(ga);
      if (k === 0) ctx.moveTo(gx, gy);
      else         ctx.lineTo(gx, gy);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,255,231,0.1)';
    ctx.lineWidth   = 6;
    ctx.stroke();

    /* ── Progress arc ────────────────────────────────────── */
    if (p > 0.005) {
      var arcR = R_INNER + R_MAX + 10;
      /* Glow layer */
      ctx.beginPath();
      ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.strokeStyle = 'rgba(0,255,231,0.18)';
      ctx.lineWidth   = 8;
      ctx.lineCap     = 'round';
      ctx.stroke();
      /* Bright arc */
      ctx.beginPath();
      ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
      ctx.strokeStyle = 'rgba(0,255,231,0.95)';
      ctx.lineWidth   = 2.5;
      ctx.stroke();
      /* Leading dot */
      var dotAngle = -Math.PI / 2 + Math.PI * 2 * p;
      ctx.beginPath();
      ctx.arc(
        cx + arcR * Math.cos(dotAngle),
        cy + arcR * Math.sin(dotAngle),
        4, 0, Math.PI * 2
      );
      ctx.fillStyle   = '#00ffe7';
      ctx.shadowColor = '#00ffe7';
      ctx.shadowBlur  = 12;
      ctx.fill();
      ctx.shadowBlur  = 0;
    }

    /* ── Central orb glow ────────────────────────────────── */
    var pulse = 0.25 + 0.12 * Math.sin(t * 2.2);
    var orbGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 34);
    orbGrad.addColorStop(0,   'rgba(0,255,231,' + (pulse + 0.1) + ')');
    orbGrad.addColorStop(0.5, 'rgba(157,77,255,' + pulse + ')');
    orbGrad.addColorStop(1,   'transparent');
    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 34, 0, Math.PI * 2);
    ctx.fill();

    /* ── Counter-rotating dual helix strands ─────────────── */
    /* Strand A — clockwise */
    var helixR = R_INNER + R_MAX + 26;
    var hueA = (hue + 0)   % 360;
    var hueB = (hue + 180) % 360;
    var twist = 3;
    for (var sa = 0; sa < 2; sa++) {
      var strandHue = sa === 0 ? hueA : hueB;
      var dir       = sa === 0 ? 1 : -1;
      ctx.beginPath();
      for (var st = 0; st <= 96; st++) {
        var sang = (st / 96) * Math.PI * 2;
        var wob  = 3 * Math.sin(sang * twist + dir * t * 2.2 + sa * Math.PI);
        var rr   = helixR + wob;
        var sx   = cx + rr * Math.cos(sang + dir * t * 0.18);
        var sy   = cy + rr * Math.sin(sang + dir * t * 0.18);
        if (st === 0) ctx.moveTo(sx, sy);
        else          ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = 'hsla(' + strandHue + ',95%,68%,0.55)';
      ctx.lineWidth   = 1.4;
      ctx.shadowColor = 'hsla(' + strandHue + ',95%,68%,0.75)';
      ctx.shadowBlur  = 8;
      ctx.stroke();
      ctx.shadowBlur  = 0;
    }

    /* ── Neural-mesh particles + connecting filaments ────── */
    var pts = [];
    for (var pp = 0; pp < this._particles.length; pp++) {
      var pa = this._particles[pp];
      pa.angle += pa.speed * 0.012;
      var radial = pa.radius + 2.5 * Math.sin(t * 1.3 + pa.phase);
      var px = cx + radial * Math.cos(pa.angle);
      var py = cy + radial * Math.sin(pa.angle);
      pts.push({ x: px, y: py });
      ctx.beginPath();
      ctx.arc(px, py, pa.size, 0, Math.PI * 2);
      ctx.fillStyle   = 'hsla(' + ((hue + pp * 18) % 360) + ',95%,72%,0.92)';
      ctx.shadowColor = 'hsla(' + ((hue + pp * 18) % 360) + ',95%,72%,0.95)';
      ctx.shadowBlur  = 10;
      ctx.fill();
      ctx.shadowBlur  = 0;
    }
    /* Connect nearest neighbours */
    for (var a = 0; a < pts.length; a++) {
      for (var b = a + 1; b < pts.length; b++) {
        var dx = pts[a].x - pts[b].x;
        var dy = pts[a].y - pts[b].y;
        var d  = Math.sqrt(dx * dx + dy * dy);
        if (d < 56) {
          ctx.beginPath();
          ctx.moveTo(pts[a].x, pts[a].y);
          ctx.lineTo(pts[b].x, pts[b].y);
          ctx.strokeStyle = 'hsla(' + hue + ',95%,72%,' + (0.18 * (1 - d / 56)) + ')';
          ctx.lineWidth   = 0.8;
          ctx.stroke();
        }
      }
    }

    /* ── VIP mark ────────────────────────────────────────── */
    ctx.save();
    ctx.shadowColor = 'rgba(0,255,231,0.9)';
    ctx.shadowBlur  = 14;
    ctx.fillStyle   = '#e8f4ff';
    ctx.font        = 'bold 14px "JetBrains Mono", monospace';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VIP', cx, cy);
    ctx.restore();
  };

  /* ── MiniSpectrograph — horizontal frequency bars ────────── */
  function MiniSpectrograph(canvas, barCount) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.barCount = barCount || 48;
    this.progress = 0;
    this.groupHue = 180;
    this.frame    = 0;
    this.running  = false;
    this._raf     = null;
    this._peaks   = new Float32Array(this.barCount);

    this._phases = [];
    this._speeds = [];
    for (var i = 0; i < this.barCount; i++) {
      this._phases.push(Math.random() * Math.PI * 2);
      this._speeds.push(0.4 + Math.random() * 2.2);
    }
  }

  MiniSpectrograph.prototype.start = function () {
    this.running = true;
    this._loop();
  };

  MiniSpectrograph.prototype.stop = function () {
    this.running = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  };

  MiniSpectrograph.prototype.setProgress = function (pct) {
    this.progress = Math.min(1, Math.max(0, pct / 100));
  };

  MiniSpectrograph.prototype.setGroup = function (hue) {
    this.groupHue = hue;
  };

  MiniSpectrograph.prototype._loop = function () {
    if (!this.running) return;
    this._draw();
    var self = this;
    this._raf = requestAnimationFrame(function () { self._loop(); });
  };

  MiniSpectrograph.prototype._draw = function () {
    var canvas   = this.canvas;
    var ctx      = this.ctx;
    var n        = this.barCount;
    var W        = canvas.width;
    var H        = canvas.height;
    var t        = ++this.frame / 60;
    var p        = this.progress;
    var hue      = this.groupHue;
    var gap      = 2;
    var barW     = (W - (n - 1) * gap) / n;

    ctx.clearRect(0, 0, W, H);

    for (var i = 0; i < n; i++) {
      var phase = this._phases[i];
      var speed = this._speeds[i];

      /* Bell-curve frequency shape peaking at 30% (typical voice range) */
      var pos     = i / n;
      var shape   = Math.exp(-3.2 * Math.pow(pos - 0.32, 2));
      var activity = 0.5 + 0.3 * Math.sin(t * speed + phase)
                         + 0.2 * Math.sin(t * speed * 1.8 + i * 0.35);
      var h = Math.max(0.04, shape * activity * (0.45 + 0.55 * p));

      var barH = h * H;
      var x    = i * (barW + gap);
      var y    = H - barH;

      /* Peak hold */
      if (barH > this._peaks[i]) {
        this._peaks[i] = barH;
      } else {
        this._peaks[i] = Math.max(3, this._peaks[i] - 0.6);
      }

      /* Gradient per bar */
      var grd = ctx.createLinearGradient(x, y, x, H);
      grd.addColorStop(0,   'hsla(' + hue         + ',100%,70%,0.92)');
      grd.addColorStop(0.5, 'hsla(' + ((hue + 25) % 360) + ',90%,55%,0.7)');
      grd.addColorStop(1,   'hsla(' + ((hue + 50) % 360) + ',80%,38%,0.4)');

      ctx.fillStyle = grd;
      /* rounded top corners */
      var radius = Math.min(2, barW / 2);
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(x, y, barW, barH, [radius, radius, 0, 0]);
      } else {
        ctx.rect(x, y, barW, barH);
      }
      ctx.fill();

      /* Peak marker */
      ctx.fillStyle = 'hsla(' + hue + ',100%,82%,0.95)';
      ctx.fillRect(x, H - this._peaks[i] - 2, barW, 2);
    }
  };

  /* ── DOM construction ────────────────────────────────────── */
  function buildOverlayDOM() {
    if (document.getElementById('processingOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id        = 'processingOverlay';
    overlay.className = 'processing-overlay';
    overlay.setAttribute('role',       'status');
    overlay.setAttribute('aria-live',  'polite');
    overlay.setAttribute('aria-hidden','true');
    overlay.setAttribute('aria-label', 'Processing audio in VoiceIsolate Pro');

    overlay.innerHTML = [
      '<div class="proc-backdrop" aria-hidden="true">',
        '<div class="proc-backdrop-grid"></div>',
        '<div class="proc-backdrop-scanline"></div>',
      '</div>',

      '<div class="processing-card vip-enter">',

        /* ── Header badge ── */
        '<div class="proc-title-wrap">',
          '<div class="proc-badge-wrap">',
            '<span class="proc-badge">ASTM · FTS</span>',
            '<span class="proc-badge proc-badge--dim">32-STAGE DECA-PASS</span>',
          '</div>',
          '<div class="proc-title">VoiceIsolate Pro Engine</div>',
          '<div class="proc-subtitle">Neural Audio Processor · Local DSP + ML</div>',
        '</div>',

        /* ── Canvas spinner ── */
        '<div class="proc-spinner-wrap" aria-hidden="true">',
          '<canvas class="proc-spinner-canvas" id="procSpinnerCanvas" width="220" height="220"></canvas>',
        '</div>',

        /* ── Stage info ── */
        '<div class="proc-stage-cluster">',
          '<div class="proc-stage-chip" id="procStageChip">◉ Input Decode</div>',
          '<div class="proc-stage-name" id="procStageName">Preparing pipeline…</div>',
          '<div class="proc-stage-meta">',
            '<span class="proc-stage-index" id="procStageIndex">Stage 1 / 32</span>',
            '<span class="proc-pct" id="procPct">0%</span>',
          '</div>',
        '</div>',

        /* ── Progress bar ── */
        '<div class="proc-bar-wrap" aria-hidden="true">',
          '<div class="proc-bar-fill" id="procBarFill"></div>',
          '<div class="proc-bar-shine"></div>',
        '</div>',

        /* ── Mini spectrograph ── */
        '<div class="proc-spectro-wrap" aria-hidden="true">',
          '<div class="proc-spectro-label">FREQUENCY ACTIVITY</div>',
          '<canvas class="proc-spectro-canvas" id="procSpectroCanvas" width="720" height="52"></canvas>',
        '</div>',

        /* ── Phase pills ── */
        '<div class="proc-phase-track" id="procPhaseTrack">',
          STAGE_GROUPS.map(function (g, idx) {
            return [
              '<div class="proc-phase-pill proc-phase-pill--' + g.color + '" data-phase-index="' + idx + '">',
                '<span class="proc-phase-icon">' + g.icon + '</span>',
                '<span class="proc-phase-label">' + g.label + '</span>',
              '</div>'
            ].join('');
          }).join(''),
        '</div>',

        /* ── Message ── */
        '<div class="proc-message-wrap">',
          '<div class="proc-message-label">Current operation</div>',
          '<div class="proc-message" id="procMessage">Loading models…</div>',
        '</div>',

        /* ── Status cells ── */
        '<div class="proc-status-grid">',
          '<div class="proc-status-cell">',
            '<span class="proc-status-k">Engine</span>',
            '<span class="proc-status-v">Neural DSP Core</span>',
          '</div>',
          '<div class="proc-status-cell">',
            '<span class="proc-status-k">Mode</span>',
            '<span class="proc-status-v" id="procModeVal">Creator / Forensic</span>',
          '</div>',
          '<div class="proc-status-cell">',
            '<span class="proc-status-k">Focus</span>',
            '<span class="proc-status-v" id="procFocusVal">Spectral isolation</span>',
          '</div>',
        '</div>',

        '<div class="proc-cancel-hint">Processing runs entirely on-device · no audio upload</div>',

      '</div>'
    ].join('');

    document.body.appendChild(overlay);
  }

  /* ── Overlay controller ──────────────────────────────────── */
  var Overlay = {
    _msgTimer:        null,
    _fadeTimer1:      null,
    _fadeTimer2:      null,
    _currentGroupIdx: 0,
    _msgIdx:          0,
    _lastStageIndex:  0,
    _spinner:         null,
    _spectro:         null,
    _pills:           null,

    _el()          { return document.getElementById('processingOverlay'); },
    _stageChip()   { return document.getElementById('procStageChip'); },
    _stageName()   { return document.getElementById('procStageName'); },
    _stageIndex()  { return document.getElementById('procStageIndex'); },
    _pct()         { return document.getElementById('procPct'); },
    _bar()         { return document.getElementById('procBarFill'); },
    _msg()         { return document.getElementById('procMessage'); },
    _focus()       { return document.getElementById('procFocusVal'); },
    _mode()        { return document.getElementById('procModeVal'); },
    _phasePills()  {
      if (!this._pills) {
        this._pills = Array.from(document.querySelectorAll('.proc-phase-pill'));
      }
      return this._pills;
    },

    _initCanvases() {
      if (this._spinner) return;

      var spinCanvas = document.getElementById('procSpinnerCanvas');
      var spectCanvas = document.getElementById('procSpectroCanvas');

      if (spinCanvas) {
        this._spinner = new NeuralSpinner(spinCanvas);
        this._spinner.start();
      }
      if (spectCanvas) {
        this._spectro = new MiniSpectrograph(spectCanvas, 48);
        this._spectro.start();
      }
    },

    show(stageName, pct) {
      var el = this._el();
      if (!el) return;
      this.update(stageName || 'Preparing pipeline…', pct || 0, 0);
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vip-processing-lock');
      this._initCanvases();
      this._startMessages(0);
    },

    hide() {
      var el = this._el();
      if (!el) return;
      el.classList.remove('active');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('vip-processing-lock');
      this._stopMessages();
    },

    update(stageName, pct, stageIndex) {
      var group      = groupForStage(stageIndex);
      var groupIndex = STAGE_GROUPS.indexOf(group);
      this._lastStageIndex = Number.isFinite(stageIndex) ? stageIndex : this._lastStageIndex;

      if (this._stageName() && stageName) this._stageName().textContent = stageName;
      if (this._pct() && Number.isFinite(pct))  this._pct().textContent  = pct + '%';
      if (this._bar() && Number.isFinite(pct))  this._bar().style.width  = pct + '%';
      if (this._stageIndex())                   this._stageIndex().textContent = 'Stage ' + Math.min(32, this._lastStageIndex + 1) + ' / 32';
      if (this._focus())                        this._focus().textContent = group.label;
      if (this._mode())                         this._mode().textContent  = /offline|creator|forensic/i.test(stageName || '') ? 'Creator / Forensic' : 'Live / Hybrid';

      if (this._stageChip()) {
        this._stageChip().textContent = group.icon + ' ' + group.label;
        this._stageChip().className   = 'proc-stage-chip proc-stage-chip--' + group.color;
      }

      this._phasePills().forEach(function (pill, idx) {
        pill.classList.toggle('active',   idx === groupIndex);
        pill.classList.toggle('complete', idx < groupIndex || (idx === groupIndex && pct >= 99));
      });

      /* Sync canvases with current group and progress */
      if (this._spinner) {
        this._spinner.setProgress(pct);
        this._spinner.setGroup(group.hue);
      }
      if (this._spectro) {
        this._spectro.setProgress(pct);
        this._spectro.setGroup(group.hue);
      }

      if (groupIndex !== this._currentGroupIdx) {
        this._currentGroupIdx = groupIndex;
        this._msgIdx = 0;
        this._cycleMessage();
      }
    },

    _startMessages(groupIndex) {
      this._currentGroupIdx = groupIndex || 0;
      this._msgIdx = 0;
      this._stopMessages();
      this._cycleMessage();
      var self = this;
      this._msgTimer = setInterval(function () { self._cycleMessage(); }, 1600);
    },

    _stopMessages() {
      if (this._msgTimer)  { clearInterval(this._msgTimer);    this._msgTimer  = null; }
      if (this._fadeTimer1){ clearTimeout(this._fadeTimer1);   this._fadeTimer1 = null; }
      if (this._fadeTimer2){ clearTimeout(this._fadeTimer2);   this._fadeTimer2 = null; }
    },

    _cycleMessage() {
      var msgEl = this._msg();
      if (!msgEl) return;
      var group = STAGE_GROUPS[this._currentGroupIdx] || STAGE_GROUPS[0];
      var text  = group.messages[this._msgIdx % group.messages.length];
      this._msgIdx += 1;

      msgEl.classList.add('fade-out');
      var self = this;
      this._fadeTimer1 = setTimeout(function () {
        self._fadeTimer1 = null;
        msgEl.textContent = text;
        msgEl.classList.remove('fade-out');
        msgEl.classList.add('fade-in');
        self._fadeTimer2 = setTimeout(function () {
          self._fadeTimer2 = null;
          msgEl.classList.remove('fade-in');
        }, 280);
      }, 260);
    }
  };

  /* ── Bootstrap ───────────────────────────────────────────── */
  function boot() {
    if (!document.getElementById('vip-overlay-css')) {
      var link = document.createElement('link');
      link.id   = 'vip-overlay-css';
      link.rel  = 'stylesheet';
      link.href = '/app/processing-overlay.css';
      document.head.appendChild(link);
    }
    buildOverlayDOM();
    global.VIPOverlay = Overlay;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* ── Pipeline patch ──────────────────────────────────────── */
  function applyOverlayPatches(vip) {
    if (vip._overlayPatched) return;
    vip._overlayPatched = true;

    vip.showProcessingOverlay = function (stageName, pct) {
      if (global.VIPOverlay) global.VIPOverlay.show(stageName, pct);
    };

    vip.hideProcessingOverlay = function () {
      if (global.VIPOverlay) global.VIPOverlay.hide();
    };

    vip.updateProcessingOverlay = function (stageName, pct, stageIndex) {
      if (global.VIPOverlay) global.VIPOverlay.update(stageName, pct, stageIndex);
    };

    var origPip = vip.pip ? vip.pip.bind(vip) : null;
    if (origPip) {
      vip.pip = async function (i, t) {
        var pct       = Math.round(((i + 1) / t) * 100);
        var stages    = global._vipApp && global._vipApp.STAGES;
        var stageName = (stages && stages[i]) ? stages[i] : ('Stage ' + (i + 1));
        this.updateProcessingOverlay(stageName, pct, i);
        return origPip(i, t);
      };
    }

    var origRun = vip.runPipeline.bind(vip);
    vip.runPipeline = async function () {
      this.showProcessingOverlay('Preparing pipeline…', 0);
      try {
        return await origRun();
      } finally {
        this.hideProcessingOverlay();
      }
    };

    console.info('[VIPOverlay] v3 ASTM FTS overlay patch applied.');
  }

  function patchOverlayWhenReady(attempts) {
    attempts = attempts || 0;
    var vip  = global.vip || global._vipApp;
    if (!vip || typeof vip.runPipeline !== 'function') {
      if (attempts < 80) setTimeout(function () { patchOverlayWhenReady(attempts + 1); }, 100);
      return;
    }
    applyOverlayPatches(vip);
  }

  patchOverlayWhenReady();

}(typeof globalThis !== 'undefined' ? globalThis : window));
