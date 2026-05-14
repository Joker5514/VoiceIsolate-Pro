/**
 * VoiceIsolate Pro — vip-enhancements.js  v1.0.0
 *
 * Thin enhancement shim wired on top of the existing app.js:
 *   1. Injects the #vip-proc-badge status element above the pipeline bar
 *   2. Swaps .vip-eq-spinner → .vip-helix-spinner (8 strands) in the
 *      file-load indicator and process button
 *   3. Adds a flash effect when speed is changed via the ± buttons
 *   4. Patches VIPOverlay.show/hide to drive the badge state so the
 *      badge and the full-screen neural overlay stay in sync
 *
 * Zero dependencies — drops in as an ES module imported last.
 */

(function vipEnhancements() {
  'use strict';

  /* ── 1. Inject stylesheet ─────────────────────────────────── */
  if (!document.getElementById('vip-enh-css')) {
    const lnk = document.createElement('link');
    lnk.id   = 'vip-enh-css';
    lnk.rel  = 'stylesheet';
    lnk.href = 'vip-enhancements.css';
    document.head.appendChild(lnk);
  }

  /* ── 2. Helix spinner HTML template ──────────────────────── */
  const HELIX_HTML = '<span class="vip-helix-spinner" aria-hidden="true">'
    + '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';

  /* ── 3. Inject #vip-proc-badge above pipeline bar ─────────── */
  function injectBadge() {
    if (document.getElementById('vip-proc-badge')) return;
    const pipelineBox = document.querySelector('.pipeline-box');
    if (!pipelineBox) return;
    const badge = document.createElement('div');
    badge.id = 'vip-proc-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.setAttribute('data-state', 'idle');
    badge.innerHTML = [
      '<span class="vip-pb-dot" aria-hidden="true"></span>',
      '<span class="vip-pb-label">Ready — drop a file or record to begin</span>',
      HELIX_HTML.replace('vip-helix-spinner', 'vip-helix-spinner vip-pb-spinner'),
    ].join('');
    /* Insert before the pipe-header */
    const pipeHeader = pipelineBox.querySelector('.pipe-header');
    pipelineBox.insertBefore(badge, pipeHeader || pipelineBox.firstChild);
  }

  /* ── 4. Badge state helper ───────────────────────────────── */
  function setBadge(state, text) {
    const badge = document.getElementById('vip-proc-badge');
    if (!badge) return;
    badge.setAttribute('data-state', state || 'idle');
    const lbl = badge.querySelector('.vip-pb-label');
    if (lbl && text) lbl.textContent = text;
    /* Show/hide the helix spinner inside the badge */
    const sp = badge.querySelector('.vip-pb-spinner');
    if (sp) sp.style.display = (state === 'processing' || state === 'loading') ? '' : 'none';
  }

  /* ── 5. Swap eq-spinner → helix-spinner in fileLoadIndicator */
  function upgradeFileLoadSpinner() {
    const indicator = document.getElementById('fileLoadIndicator');
    if (!indicator) return;
    const old = indicator.querySelector('.vip-eq-spinner');
    if (old) {
      const helix = document.createElement('span');
      helix.innerHTML = HELIX_HTML;
      old.parentNode.replaceChild(helix.firstChild, old);
    }
  }

  /* ── 6. Speed button flash ───────────────────────────────── */
  function addSpeedFlash() {
    const sel = document.getElementById('tpSpeed');
    if (!sel) return;

    const flashSpeed = () => {
      sel.classList.remove('tp-speed-flash');
      // Force reflow so animation restarts
      void sel.offsetWidth; // eslint-disable-line no-void
      sel.classList.add('tp-speed-flash');
      sel.addEventListener('animationend', () => sel.classList.remove('tp-speed-flash'), { once: true });
    };

    sel.addEventListener('change', flashSpeed);

    const proto = (typeof HTMLSelectElement !== 'undefined' && HTMLSelectElement.prototype)
      || Object.getPrototypeOf(sel);
    const valueDesc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (!valueDesc || typeof valueDesc.get !== 'function' || typeof valueDesc.set !== 'function') return;

    Object.defineProperty(sel, 'value', {
      configurable: true,
      enumerable: valueDesc.enumerable,
      get() {
        return valueDesc.get.call(this);
      },
      set(nextValue) {
        const prevValue = valueDesc.get.call(this);
        valueDesc.set.call(this, nextValue);
        if (prevValue !== valueDesc.get.call(this)) {
          flashSpeed();
        }
      }
    });
  }

  /* ── 7. Patch VIPOverlay to also drive badge state ───────── */
  function patchOverlay() {
    const ensurePatch = () => {
      const ov = window.VIPOverlay;
      if (!ov || ov._vipEnh) return;
      const origShow = ov.show ? ov.show.bind(ov) : null;
      const origHide = ov.hide ? ov.hide.bind(ov) : null;
      ov.show = function(msg, pct) {
        setBadge('processing', msg || 'Processing…');
        if (origShow) origShow(msg, pct);
      };
      ov.hide = function() {
        /* Badge will be finalized by setStatus hook below */
        if (origHide) origHide();
      };
      ov._vipEnh = true;
    };
    /* Try immediately, then wait for the overlay module to load */
    ensurePatch();
    const t = setInterval(() => {
      if (window.VIPOverlay) { ensurePatch(); clearInterval(t); }
    }, 120);
    setTimeout(() => clearInterval(t), 8000);
  }

  /* ── 8. Hook VoiceIsolatePro.setStatus to drive badge ──────── */
  function hookAppStatus() {
    const hookOn = (app) => {
      if (!app || app._vipEnhHooked) return;
      const orig = app.setStatus ? app.setStatus.bind(app) : null;
      app.setStatus = function(status) {
        if (orig) orig(status);
        const s = String(status).toUpperCase();
        if (s === 'PROCESSING') {
          setBadge('processing', 'Neural DSP pipeline running…');
        } else if (s === 'DONE') {
          setBadge('done', 'Processing complete — output ready');
        } else if (s === 'READY') {
          setBadge('idle', 'Signal loaded · ready to process');
        } else if (s === 'ERROR') {
          setBadge('error', 'Pipeline error — check console');
        } else {
          setBadge('idle', status || 'Ready');
        }
      };
      /* Also hook _showFileLoading / _hideFileLoading */
      const origShow = app._showFileLoading ? app._showFileLoading.bind(app) : null;
      const origHide = app._hideFileLoading ? app._hideFileLoading.bind(app) : null;
      app._showFileLoading = function(text) {
        setBadge('loading', text || 'Loading file…');
        if (origShow) origShow(text);
      };
      app._hideFileLoading = function() {
        setBadge('idle', 'File loaded');
        if (origHide) origHide();
      };
      app._vipEnhHooked = true;
    };

    /* Hook immediately if app is ready, otherwise poll */
    if (window._vipApp) { hookOn(window._vipApp); return; }
    const t = setInterval(() => {
      if (window._vipApp) { hookOn(window._vipApp); clearInterval(t); }
    }, 80);
    setTimeout(() => clearInterval(t), 10000);
  }

  /* ── 9. Init on DOMContentLoaded (or immediately if ready) ── */
  function init() {
    injectBadge();
    upgradeFileLoadSpinner();
    addSpeedFlash();
    patchOverlay();
    hookAppStatus();
    setBadge('idle', 'Ready — drop a file or record to begin');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
