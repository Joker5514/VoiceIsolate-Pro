/**
 * app-missing-methods.js — VoiceIsolate Pro v22.1
 *
 * Patches four hard-crash blockers that exist in app.js but are never defined:
 *
 *   1. setStatus()         — called on every pipeline stage; crashes runPipeline()
 *   2. structuredLog()     — called globally throughout; crashes diagnostics panel
 *   3. onResize()          — bound in bindEvents() but missing; throws on resize
 *   4. initMLWorker boot   — method exists but init() never calls it; ML never starts
 *
 * Load order in index.html (REQUIRED):
 *   1. dsp-core.js
 *   2. app.js
 *   3. app-patches.js
 *   4. app-missing-methods.js   ← this file
 *   5. vip-boot.js
 */
(function patchMissingMethods() {
  'use strict';

  function applyPatches() {
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[app-missing-methods] VoiceIsolatePro not defined — check load order.');
      return;
    }
    const P = VoiceIsolatePro.prototype;

    // ─────────────────────────────────────────────────────────────────
    // 1. setStatus(state)
    //    state: 'IDLE' | 'LOADING' | 'PROCESSING' | 'READY' | 'ERROR'
    //    Updates the status badge (hStatus) and disables/enables the
    //    process button during active operations.
    // ─────────────────────────────────────────────────────────────────
    P.setStatus = function (state) {
      const STATUS_CONFIG = {
        IDLE:       { label: 'IDLE',       color: '#555e6b', spin: false },
        LOADING:    { label: 'LOADING…',   color: '#f0a500', spin: true  },
        PROCESSING: { label: 'PROCESSING', color: '#f0a500', spin: true  },
        READY:      { label: 'READY',      color: '#00e676', spin: false },
        ERROR:      { label: 'ERROR',      color: '#ff1744', spin: false },
      };

      const cfg = STATUS_CONFIG[state] || STATUS_CONFIG.IDLE;

      // hStatus badge
      const badge = this.dom && this.dom.hStatus;
      if (badge) {
        badge.textContent = cfg.label;
        badge.style.background = cfg.color;
        badge.style.color = (state === 'IDLE' || state === 'ERROR') ? '#fff' : '#000';
        badge.classList.toggle('spinning', cfg.spin);
      }

      // Disable process button while busy
      const btn = this.dom && this.dom.processBtn;
      if (btn) {
        btn.disabled = cfg.spin;
        btn.style.opacity = cfg.spin ? '0.5' : '1';
      }

      // Mirror to browser title for background-tab awareness
      document.title = cfg.spin
        ? `[${cfg.label}] VoiceIsolate Pro`
        : 'VoiceIsolate Pro';

      this._currentStatus = state;
      structuredLog('info', `[setStatus] → ${state}`);
    };

    // ─────────────────────────────────────────────────────────────────
    // 2. structuredLog(level, message, data?)
    //    Global shim. Writes to console and optionally appends to the
    //    diagnostics log panel (#diagLog) if it exists in the DOM.
    //    level: 'info' | 'warn' | 'error' | 'debug'
    // ─────────────────────────────────────────────────────────────────
    if (typeof window.structuredLog !== 'function') {
      window.structuredLog = function structuredLog(level, message, data) {
        // Console output
        const fn = console[level] || console.log;
        if (data !== undefined) {
          fn(`[VIP] ${message}`, data);
        } else {
          fn(`[VIP] ${message}`);
        }

        // Write to diagnostics panel if present
        const panel = document.getElementById('diagLog');
        if (!panel) return;
        const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
        const line = document.createElement('div');
        line.className = `diag-line diag-${level}`;
        line.textContent = `${ts} [${level.toUpperCase()}] ${message}`;
        if (data !== undefined) {
          try {
            const detail = typeof data === 'object'
              ? JSON.stringify(data, null, 0).slice(0, 120)
              : String(data).slice(0, 120);
            line.textContent += ' ' + detail;
          } catch (_) { /* ignore circular refs */ }
        }
        panel.appendChild(line);
        // Auto-scroll and cap at 200 lines to prevent memory growth
        while (panel.children.length > 200) panel.removeChild(panel.firstChild);
        panel.scrollTop = panel.scrollHeight;
      };
      console.info('[app-missing-methods] structuredLog shim installed ✓');
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. onResize()
    //    Bound via window.addEventListener('resize', this.onResize.bind(this))
    //    in bindEvents(). Resizes all canvas elements and redraws the
    //    3D spectrogram + oscilloscope to avoid stretched/blank visuals.
    // ─────────────────────────────────────────────────────────────────
    P.onResize = function () {
      // Debounce — avoid hammering canvas resize on every pixel change
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._doResize();
      }, 120);
    };

    P._doResize = function () {
      const canvasIds = [
        'spectroCanvas',   // 3D spectrogram
        'oscCanvas',       // oscilloscope
        'specOverlay',     // overlay canvas
        'diagCanvas',      // diagnostics
        'waveformCanvas',  // waveform
        'waveformOrig',    // original waveform
      ];

      for (const id of canvasIds) {
        const el = document.getElementById(id);
        if (!el) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width > 0)  el.width  = Math.floor(rect.width);
        if (rect.height > 0) el.height = Math.floor(rect.height);
      }

      // Reset spectrogram scroll state so it doesn't render from an
      // out-of-bounds X position after the canvas was resized
      this.spectroX    = 0;
      this.specOverlayX = 0;

      // Re-draw waveform if a buffer is already loaded
      if (typeof this.drawWaveform === 'function' && this.inputBuffer) {
        this.drawWaveform(this.inputBuffer, 'waveformOrig');
      }
      if (typeof this.drawWaveform === 'function' && this.outputBuffer) {
        this.drawWaveform(this.outputBuffer, 'waveformCanvas');
      }

      structuredLog('debug', '[onResize] canvases resized');
    };

    // ─────────────────────────────────────────────────────────────────
    // 4. init() — call initMLWorker() after the AudioContext is set up
    //    The original init() never calls initMLWorker(). We wrap init()
    //    to fire it after the original completes.
    // ─────────────────────────────────────────────────────────────────
    if (typeof P.init === 'function' && typeof P.initMLWorker === 'function') {
      const _originalInit = P.init;
      P.init = async function () {
        await _originalInit.call(this);

        // Guard: don't double-start if already initialised
        if (this._mlWorkerStarted) return;
        this._mlWorkerStarted = true;

        try {
          await this.initMLWorker();
          structuredLog('info', '[init] ML Worker started successfully');
        } catch (err) {
          // Non-fatal: classical DSP pipeline still works without ML
          structuredLog('warn', '[init] ML Worker failed to start — running classical DSP only', err.message);
        }
      };
      console.info('[app-missing-methods] init() patched to start ML Worker ✓');
    } else {
      console.warn('[app-missing-methods] init() or initMLWorker() not found — skipping ML boot patch.');
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. BONUS: showNotification() guard
    //    Several event handlers call this.showNotification() but it
    //    is only defined in some builds. Provide a safe fallback.
    // ─────────────────────────────────────────────────────────────────
    if (typeof P.showNotification !== 'function') {
      P.showNotification = function (message, type = 'info', duration = 3500) {
        structuredLog(type === 'error' ? 'error' : 'info', `[notify] ${message}`);
        // Try to use an existing toast/snackbar element
        const toast = document.getElementById('toastMsg') || document.getElementById('notification');
        if (!toast) return;
        toast.textContent = message;
        toast.className = `toast toast-${type} show`;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => {
          toast.classList.remove('show');
        }, duration);
      };
    }

    console.info('[app-missing-methods] All missing-method patches applied ✓  (5 patches)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPatches);
  } else {
    applyPatches();
  }
})();
