/* ============================================================
   VoiceIsolate Pro — Processing Overlay Controller
   Premium rotating messages + DNA helix spinner
   v1.0  ·  Threads from Space v12
   ============================================================ */

(function (global) {
  'use strict';

  // ── Premium message queues (per pipeline phase) ──────────────
  const MSG_POOLS = [
    // Input / prep phase (S01–S05)
    [
      'Decoding audio container…',
      'Allocating ring buffer…',
      'Removing DC offset…',
      'Normalizing peak levels…',
      'Running Voice Activity Detection…',
    ],
    // Time-domain phase (S06–S09)
    [
      'Closing noise gate…',
      'Detecting transient clicks…',
      'Scrubbing 60 Hz hum harmonics…',
      'Mapping sibilance frequencies…',
      'Sculpting pre-spectral dynamics…',
    ],
    // Spectral phase (S10–S19)
    [
      'Running Forward STFT…',
      'Building adaptive Wiener mask…',
      'Second-pass Wiener residual sweep…',
      'Gating 32-band ERB spectrum…',
      'Boosting voice-band spectral emphasis…',
      'Cancelling L/R crosstalk…',
      'Applying temporal anti-garble smoothing…',
      'Compensating spectral tilt…',
      'Estimating room impulse response…',
      'Reconstructing lost harmonics v2…',
      'Running Inverse STFT…',
    ],
    // Post-spectral phase (S20–S26)
    [
      'Initialising OfflineAudioContext…',
      'Applying 10-band parametric EQ…',
      'Shaping dynamics with multi-stage compressor…',
      'Engaging brickwall limiter ceiling…',
      'Rendering final audio frame…',
    ],
    // Output / forensic phase (S27–S32)
    [
      'Blending dry/wet mix…',
      'Computing LUFS integrated loudness…',
      'Updating waveform display…',
      'Writing SHA-256 forensic audit log…',
      'Preparing 32-bit float WAV export…',
      'Pipeline complete — verifying output…',
    ],
  ];

  // Map stage index (0–31) → message pool index
  function poolForStage(i) {
    if (i <= 4)  return 0;
    if (i <= 8)  return 1;
    if (i <= 19) return 2;
    if (i <= 25) return 3;
    return 4;
  }

  // ── DOM build ────────────────────────────────────────────────
  function buildOverlayDOM() {
    if (document.getElementById('processingOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'processingOverlay';
    overlay.className = 'processing-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-label', 'Processing audio');

    overlay.innerHTML = `
      <div class="processing-card">
        <!-- DNA helix spinner -->
        <div class="proc-helix-wrap" aria-hidden="true">
          <div class="proc-ring-outer"></div>
          <div class="proc-ring-mid"></div>
          <div class="proc-ring-inner"></div>
          <div class="proc-core"></div>
          <div class="proc-node"></div>
          <div class="proc-node"></div>
          <div class="proc-node"></div>
          <div class="proc-node"></div>
          <div class="proc-node"></div>
          <div class="proc-node"></div>
        </div>

        <!-- Title -->
        <div class="proc-title">Processing Audio</div>

        <!-- Live stage name -->
        <div class="proc-stage-name" id="procStageName">Initialising pipeline…</div>

        <!-- Percent -->
        <div class="proc-pct" id="procPct">0%</div>

        <!-- Gradient progress bar -->
        <div class="proc-bar-wrap">
          <div class="proc-bar-fill" id="procBarFill"></div>
        </div>

        <!-- Rotating premium message -->
        <div class="proc-message" id="procMessage">Loading models…</div>

        <!-- Cancel hint -->
        <div class="proc-cancel-hint">Press ESC to cancel</div>
      </div>
    `;

    document.body.appendChild(overlay);
  }

  // ── Overlay controller ───────────────────────────────────────
  const Overlay = {
    _msgTimer: null,
    _currentPool: 0,
    _msgIdx: 0,

    _el: function () { return document.getElementById('processingOverlay'); },
    _stageName: function () { return document.getElementById('procStageName'); },
    _pct: function () { return document.getElementById('procPct'); },
    _bar: function () { return document.getElementById('procBarFill'); },
    _msg: function () { return document.getElementById('procMessage'); },

    // Show overlay and start rotating messages
    show: function (stageName, pct) {
      const el = this._el();
      if (!el) return;
      this.update(stageName || 'Preparing pipeline…', pct || 0);
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vip-processing-lock');
      this._startMessages(poolForStage(0));
    },

    // Hide overlay and stop messages
    hide: function () {
      const el = this._el();
      if (!el) return;
      el.classList.remove('active');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('vip-processing-lock');
      this._stopMessages();
    },

    // Update stage text + percent + bar
    update: function (stageName, pct, stageIndex) {
      const nameEl = this._stageName();
      const pctEl  = this._pct();
      const barEl  = this._bar();
      if (nameEl && stageName) nameEl.textContent = stageName;
      if (pctEl  && Number.isFinite(pct)) pctEl.textContent = pct + '%';
      if (barEl  && Number.isFinite(pct)) barEl.style.width  = pct + '%';
      // Switch message pool when the phase changes
      if (Number.isFinite(stageIndex)) {
        const pool = poolForStage(stageIndex);
        if (pool !== this._currentPool) {
          this._currentPool = pool;
          this._msgIdx = 0;
          this._cycleMessage();
        }
      }
    },

    // Rotate messages every 1.8 s
    _startMessages: function (pool) {
      this._currentPool = pool || 0;
      this._msgIdx = 0;
      this._stopMessages();
      this._cycleMessage();
      this._msgTimer = setInterval(() => this._cycleMessage(), 1800);
    },

    _stopMessages: function () {
      if (this._msgTimer)    { clearInterval(this._msgTimer);  this._msgTimer    = null; }
      if (this._fadeTimer1)  { clearTimeout(this._fadeTimer1); this._fadeTimer1  = null; }
      if (this._fadeTimer2)  { clearTimeout(this._fadeTimer2); this._fadeTimer2  = null; }
    },

    _cycleMessage: function () {
      const msgEl = this._msg();
      if (!msgEl) return;
      const pool = MSG_POOLS[this._currentPool] || MSG_POOLS[0];
      const text = pool[this._msgIdx % pool.length];
      this._msgIdx++;

      // Crossfade — store handles so _stopMessages can cancel in-flight transitions
      msgEl.classList.add('fade-out');
      this._fadeTimer1 = setTimeout(() => {
        this._fadeTimer1 = null;
        msgEl.textContent = text;
        msgEl.classList.remove('fade-out');
        msgEl.classList.add('fade-in');
        this._fadeTimer2 = setTimeout(() => {
          this._fadeTimer2 = null;
          msgEl.classList.remove('fade-in');
        }, 350);
      }, 350);
    },
  };

  // ── Bootstrap ────────────────────────────────────────────────
  function boot() {
    // Inject CSS link if not already present
    if (!document.getElementById('vip-overlay-css')) {
      const link = document.createElement('link');
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

}(typeof globalThis !== 'undefined' ? globalThis : window));

// ─────────────────────────────────────────────────────────────────────────────
//  app.js overlay integration patch
//  (merged from processing-overlay-patch.js — Patch v1.0)
//
//  Monkey-patches the VoiceIsolatePro app instance to wire VIPOverlay
//  into runPipeline() and pip().
//  Runs after app.js instantiates window.vip / window._vipApp.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Wait until the app class is instantiated on window.vip or window._vipApp
  // (VoiceIsolatePro exposes itself as both names for compatibility)
  function patchWhenReady(attempts) {
    attempts = attempts || 0;
    const vip = window.vip || window._vipApp;
    if (!vip || typeof vip.runPipeline !== 'function') {
      if (attempts < 80) setTimeout(() => patchWhenReady(attempts + 1), 100);
      return;
    }
    applyPatches(vip);
  }

  function applyPatches(vip) {
    // Idempotency guard — prevents double-wrapping on hot-reload or duplicate script load
    if (vip._overlayPatched) return;
    vip._overlayPatched = true;

    // ── showProcessingOverlay ──────────────────────────────────
    vip.showProcessingOverlay = function (stageName, pct) {
      if (window.VIPOverlay) window.VIPOverlay.show(stageName, pct);
    };

    // ── hideProcessingOverlay ──────────────────────────────────
    vip.hideProcessingOverlay = function () {
      if (window.VIPOverlay) window.VIPOverlay.hide();
    };

    // ── updateProcessingOverlay ───────────────────────────────
    vip.updateProcessingOverlay = function (stageName, pct, stageIndex) {
      if (window.VIPOverlay) window.VIPOverlay.update(stageName, pct, stageIndex);
    };

    // ── Patch pip() to call updateProcessingOverlay ───────────
    const origPip = vip.pip ? vip.pip.bind(vip) : null;
    if (origPip) {
      vip.pip = async function (i, t) {
        const pct = Math.round((i + 1) / t * 100);
        // STAGES lives in app.js closure scope, not as a global. Read it via the app instance.
        const stages = window._vipApp && window._vipApp.STAGES;
        const stageName = (stages && stages[i]) ? stages[i] : ('Stage ' + (i + 1));
        this.updateProcessingOverlay(stageName, pct, i);
        return origPip(i, t);
      };
    }

    // ── Patch runPipeline() to show/hide overlay ──────────────
    const origRun = vip.runPipeline.bind(vip);
    vip.runPipeline = async function () {
      this.showProcessingOverlay('Preparing pipeline…', 0);
      try {
        return await origRun();
      } finally {
        this.hideProcessingOverlay();
      }
    };

    console.info('[VIPOverlay] Overlay patch applied.');
  }

  patchWhenReady();
}());
