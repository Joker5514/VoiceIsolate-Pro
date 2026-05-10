/* ============================================================
   VoiceIsolate Pro — Processing Overlay Controller
   Unique orbital helix + stage telemetry overlay
   v2.0  ·  Threads from Space v14
   ============================================================ */

(function (global) {
  'use strict';

  const STAGE_GROUPS = [
    {
      label: 'Input Decode',
      icon: '◉',
      start: 0,
      end: 4,
      color: 'cyan',
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
      start: 5,
      end: 8,
      color: 'violet',
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
      start: 9,
      end: 19,
      color: 'pink',
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
      start: 20,
      end: 25,
      color: 'amber',
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
      start: 26,
      end: 31,
      color: 'cyan',
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

  function buildOverlayDOM() {
    if (document.getElementById('processingOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'processingOverlay';
    overlay.className = 'processing-overlay';
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('aria-label', 'Processing audio in VoiceIsolate Pro');

    overlay.innerHTML = `
      <div class="processing-backdrop-grid" aria-hidden="true"></div>
      <div class="processing-card vip-enter">
        <div class="proc-orbit-loader" aria-hidden="true">
          <div class="proc-orbit proc-orbit--outer"></div>
          <div class="proc-orbit proc-orbit--mid"></div>
          <div class="proc-orbit proc-orbit--inner"></div>
          <div class="proc-helix-column proc-helix-column--left">
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
          </div>
          <div class="proc-helix-column proc-helix-column--right">
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
            <span class="proc-helix-dot"></span>
          </div>
          <div class="proc-core-mark">VIP</div>
          <div class="proc-scan-ring"></div>
        </div>

        <div class="proc-title-wrap">
          <div class="proc-badge">PROCESSING</div>
          <div class="proc-title">VoiceIsolate Pro Engine</div>
          <div class="proc-subtitle">32-stage hybrid DSP + ML chain</div>
        </div>

        <div class="proc-stage-cluster">
          <div class="proc-stage-chip" id="procStageChip">◉ Input Decode</div>
          <div class="proc-stage-name" id="procStageName">Preparing pipeline…</div>
          <div class="proc-stage-meta">
            <span class="proc-stage-index" id="procStageIndex">Stage 1 / 32</span>
            <span class="proc-pct" id="procPct">0%</span>
          </div>
        </div>

        <div class="proc-bar-wrap" aria-hidden="true">
          <div class="proc-bar-fill" id="procBarFill"></div>
          <div class="proc-bar-shine"></div>
        </div>

        <div class="proc-phase-track" id="procPhaseTrack">
          ${STAGE_GROUPS.map((group, idx) => `
            <div class="proc-phase-pill proc-phase-pill--${group.color}" data-phase-index="${idx}">
              <span class="proc-phase-icon">${group.icon}</span>
              <span class="proc-phase-label">${group.label}</span>
            </div>
          `).join('')}
        </div>

        <div class="proc-message-wrap">
          <div class="proc-message-label">Current operation</div>
          <div class="proc-message" id="procMessage">Loading models…</div>
        </div>

        <div class="proc-status-grid">
          <div class="proc-status-cell">
            <span class="proc-status-k">Engine</span>
            <span class="proc-status-v">Threads from Space</span>
          </div>
          <div class="proc-status-cell">
            <span class="proc-status-k">Mode</span>
            <span class="proc-status-v" id="procModeVal">Creator / Forensic</span>
          </div>
          <div class="proc-status-cell">
            <span class="proc-status-k">Focus</span>
            <span class="proc-status-v" id="procFocusVal">Spectral isolation</span>
          </div>
        </div>

        <div class="proc-cancel-hint">Processing will finish automatically</div>
      </div>
    `;

    document.body.appendChild(overlay);
  }

  const Overlay = {
    _msgTimer: null,
    _fadeTimer1: null,
    _fadeTimer2: null,
    _currentGroupIndex: 0,
    _msgIdx: 0,
    _lastStageIndex: 0,

    _el() { return document.getElementById('processingOverlay'); },
    _stageChip() { return document.getElementById('procStageChip'); },
    _stageName() { return document.getElementById('procStageName'); },
    _stageIndex() { return document.getElementById('procStageIndex'); },
    _pct() { return document.getElementById('procPct'); },
    _bar() { return document.getElementById('procBarFill'); },
    _msg() { return document.getElementById('procMessage'); },
    _focus() { return document.getElementById('procFocusVal'); },
    _mode() { return document.getElementById('procModeVal'); },
    _phasePills() { if (!this._pills) { this._pills = Array.from(document.querySelectorAll('.proc-phase-pill')); } return this._pills; },

    show(stageName, pct) {
      const el = this._el();
      if (!el) return;
      this.update(stageName || 'Preparing pipeline…', pct || 0, 0);
      el.classList.add('active');
      el.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vip-processing-lock');
      this._startMessages(0);
    },

    hide() {
      const el = this._el();
      if (!el) return;
      el.classList.remove('active');
      el.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('vip-processing-lock');
      this._stopMessages();
    },

    update(stageName, pct, stageIndex) {
      const group = groupForStage(stageIndex);
      const groupIndex = STAGE_GROUPS.indexOf(group);
      this._lastStageIndex = Number.isFinite(stageIndex) ? stageIndex : this._lastStageIndex;

      if (this._stageName() && stageName) this._stageName().textContent = stageName;
      if (this._pct() && Number.isFinite(pct)) this._pct().textContent = `${pct}%`;
      if (this._bar() && Number.isFinite(pct)) this._bar().style.width = `${pct}%`;
      if (this._stageIndex()) this._stageIndex().textContent = `Stage ${Math.min(32, this._lastStageIndex + 1)} / 32`;
      if (this._focus()) this._focus().textContent = group.label;
      if (this._mode()) this._mode().textContent = /offline|creator|forensic/i.test(stageName || '') ? 'Creator / Forensic' : 'Live / Hybrid';

      if (this._stageChip()) {
        this._stageChip().textContent = `${group.icon} ${group.label}`;
        this._stageChip().className = `proc-stage-chip proc-stage-chip--${group.color}`;
      }

      this._phasePills().forEach((pill, idx) => {
        pill.classList.toggle('active', idx === groupIndex);
        pill.classList.toggle('complete', idx < groupIndex || (idx === groupIndex && pct >= 99));
      });

      if (groupIndex !== this._currentGroupIndex) {
        this._currentGroupIndex = groupIndex;
        this._msgIdx = 0;
        this._cycleMessage();
      }
    },

    _startMessages(groupIndex) {
      this._currentGroupIndex = groupIndex || 0;
      this._msgIdx = 0;
      this._stopMessages();
      this._cycleMessage();
      this._msgTimer = setInterval(() => this._cycleMessage(), 1500);
    },

    _stopMessages() {
      if (this._msgTimer) { clearInterval(this._msgTimer); this._msgTimer = null; }
      if (this._fadeTimer1) { clearTimeout(this._fadeTimer1); this._fadeTimer1 = null; }
      if (this._fadeTimer2) { clearTimeout(this._fadeTimer2); this._fadeTimer2 = null; }
    },

    _cycleMessage() {
      const msgEl = this._msg();
      if (!msgEl) return;
      const group = STAGE_GROUPS[this._currentGroupIndex] || STAGE_GROUPS[0];
      const text = group.messages[this._msgIdx % group.messages.length];
      this._msgIdx += 1;

      msgEl.classList.add('fade-out');
      this._fadeTimer1 = setTimeout(() => {
        this._fadeTimer1 = null;
        msgEl.textContent = text;
        msgEl.classList.remove('fade-out');
        msgEl.classList.add('fade-in');
        this._fadeTimer2 = setTimeout(() => {
          this._fadeTimer2 = null;
          msgEl.classList.remove('fade-in');
        }, 260);
      }, 260);
    }
  };

  function boot() {
    if (!document.getElementById('vip-overlay-css')) {
      const link = document.createElement('link');
      link.id = 'vip-overlay-css';
      link.rel = 'stylesheet';
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

    const origPip = vip.pip ? vip.pip.bind(vip) : null;
    if (origPip) {
      vip.pip = async function (i, t) {
        const pct = Math.round(((i + 1) / t) * 100);
        const stages = global._vipApp && global._vipApp.STAGES;
        const stageName = (stages && stages[i]) ? stages[i] : ('Stage ' + (i + 1));
        this.updateProcessingOverlay(stageName, pct, i);
        return origPip(i, t);
      };
    }

    const origRun = vip.runPipeline.bind(vip);
    vip.runPipeline = async function () {
      this.showProcessingOverlay('Preparing pipeline…', 0);
      try {
        return await origRun();
      } finally {
        this.hideProcessingOverlay();
      }
    };

    console.info('[VIPOverlay] v2 overlay patch applied.');
  }

  function patchOverlayWhenReady(attempts) {
    attempts = attempts || 0;
    const vip = global.vip || global._vipApp;
    if (!vip || typeof vip.runPipeline !== 'function') {
      if (attempts < 80) setTimeout(() => patchOverlayWhenReady(attempts + 1), 100);
      return;
    }
    applyOverlayPatches(vip);
  }

  patchOverlayWhenReady();

}(typeof globalThis !== 'undefined' ? globalThis : window));
