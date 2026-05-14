/**
 * VoiceIsolate Pro — vip-enhancements.js  v1.1.0
 *
 * Thin bridge shim wired on top of app.js:
 *   1. Badge state driver (#vip-proc-badge already in index.html)
 *   2. Speed +/− buttons dispatch synthetic 'change' so flash animation fires
 *   3. Patches VIPOverlay.show/hide, app.setStatus, _showFileLoading,
 *      _hideFileLoading to drive badge state
 *   4. Patches _setABLabel to ensure .tp-ab-tag / .tp-ab-name spans
 *      are never clobbered by textContent assignments in play()/toggleAB()
 *
 * Review fixes v1.1.0:
 *   - P1: _hideFileLoading no longer overwrites error state
 *   - P2: speed buttons dispatch synthetic change event for flash
 *   - CSS id guard: link already has id; no duplicate injection
 *   - Removed dead upgradeFileLoadSpinner() (index.html native helix)
 *   - Removed redundant injectBadge() body (badge in HTML; guard only)
 *   - Used rest params (...args) on all monkey-patched methods
 */

(function vipEnhancements() {
  'use strict';

  /* ── Badge state helper ────────────────────────────────────── */
  function setBadge(state, text) {
    const badge = document.getElementById('vip-proc-badge');
    if (!badge) return;
    badge.setAttribute('data-state', state || 'idle');
    const lbl = badge.querySelector('.vip-pb-label');
    if (lbl && text) lbl.textContent = text;
    const sp = badge.querySelector('.vip-pb-spinner');
    if (sp) sp.style.display = (state === 'processing' || state === 'loading') ? '' : 'none';
  }

  /* ── Speed button flash ──────────────────────────────────── */
  /*
   * P2 fix: _stepSpeed() sets sel.value programmatically but does NOT
   * dispatch 'change'. We intercept the ± button clicks AFTER app.js
   * has run _stepSpeed and fire a synthetic 'change' ourselves so the
   * flash animation always runs when the buttons are used.
   */
  function addSpeedFlash() {
    const sel       = document.getElementById('tpSpeed');
    const btnDown   = document.getElementById('tpSpeedDown');
    const btnUp     = document.getElementById('tpSpeedUp');
    if (!sel) return;

    function flash() {
      sel.classList.remove('tp-speed-flash');
      void sel.offsetWidth; // force reflow so animation restarts
      sel.classList.add('tp-speed-flash');
      sel.addEventListener('animationend', () => sel.classList.remove('tp-speed-flash'), { once: true });
    }

    /* Native select change (keyboard / direct pick) */
    sel.addEventListener('change', flash);

    /* ± buttons: dispatch synthetic change AFTER app.js _stepSpeed runs */
    if (btnDown) btnDown.addEventListener('click', () => {
      /* yield to let _stepSpeed() update sel.value first */
      Promise.resolve().then(() => {
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
    if (btnUp) btnUp.addEventListener('click', () => {
      Promise.resolve().then(() => {
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  /* ── Patch VIPOverlay to also drive badge state ────────────── */
  function patchOverlay() {
    const ensurePatch = () => {
      const ov = window.VIPOverlay;
      if (!ov || ov._vipEnh) return;
      const origShow = ov.show ? ov.show.bind(ov) : null;
      const origHide = ov.hide ? ov.hide.bind(ov) : null;
      ov.show = function(...args) {
        setBadge('processing', args[0] || 'Processing…');
        if (origShow) origShow(...args);
      };
      ov.hide = function(...args) {
        if (origHide) origHide(...args);
      };
      ov._vipEnh = true;
    };
    ensurePatch();
    const t = setInterval(() => {
      if (window.VIPOverlay) { ensurePatch(); clearInterval(t); }
    }, 120);
    setTimeout(() => clearInterval(t), 8000);
  }

  /* ── Hook VoiceIsolatePro methods to drive badge + fix A/B spans ── */
  function hookAppStatus() {
    const hookOn = (app) => {
      if (!app || app._vipEnhHooked) return;

      /* — setStatus hook — */
      const origSetStatus = app.setStatus ? app.setStatus.bind(app) : null;
      app.setStatus = function(...args) {
        if (origSetStatus) origSetStatus(...args);
        const s = String(args[0] || '').toUpperCase();
        if (s === 'PROCESSING') {
          setBadge('processing', 'Neural DSP pipeline running…');
        } else if (s === 'DONE') {
          setBadge('done', 'Processing complete — output ready');
        } else if (s === 'READY') {
          setBadge('idle', 'Signal loaded · ready to process');
        } else if (s === 'ERROR') {
          /* P1 fix: error state must NEVER be overwritten by the finally
           * _hideFileLoading call. We keep error visible here. */
          setBadge('error', 'Pipeline error — check console');
        } else {
          setBadge('idle', args[0] || 'Ready');
        }
      };

      /* — _showFileLoading hook — */
      const origShowFL = app._showFileLoading ? app._showFileLoading.bind(app) : null;
      app._showFileLoading = function(...args) {
        setBadge('loading', args[0] || 'Loading file…');
        if (origShowFL) origShowFL(...args);
      };

      /* — _hideFileLoading hook (P1 fix) —
       *
       * handleFile() calls _hideFileLoading() in a finally block AFTER
       * setStatus('ERROR') in the catch block. Without this guard the
       * badge would flash error and immediately reset to idle/success,
       * misleading the user. We only reset to idle if we are NOT in an
       * error state (the badge wasn't just set to error). */
      const origHideFL = app._hideFileLoading ? app._hideFileLoading.bind(app) : null;
      app._hideFileLoading = function(...args) {
        if (origHideFL) origHideFL(...args);
        const badge = document.getElementById('vip-proc-badge');
        const currentState = badge ? badge.getAttribute('data-state') : '';
        if (currentState !== 'error' && currentState !== 'processing') {
          setBadge('idle', 'File loaded');
        }
      };

      /* — _setABLabel patch (fixes textContent clobber) —
       *
       * app.js play() and toggleAB() both set tpABLabel.textContent
       * (a legacy string fallback) BEFORE calling _setABLabel(). That
       * textContent assignment destroys the child spans. We override
       * _setABLabel to always reconstruct the spans so they're never
       * orphaned regardless of call order. */
      const origSetABLabel = app._setABLabel ? app._setABLabel.bind(app) : null;
      app._setABLabel = function() {
        /* Run original logic (updates data-version, aria-label, etc.) */
        if (origSetABLabel) origSetABLabel();
        /* Guarantee child spans exist with correct content */
        const lbl = app.dom && app.dom.tpABLabel;
        if (!lbl) return;
        const isProcessed = app.abMode === 'processed';
        const version = isProcessed ? 'B' : 'A';
        const name    = isProcessed ? 'Processed' : 'Original';
        let tagEl  = lbl.querySelector('.tp-ab-tag');
        let nameEl = lbl.querySelector('.tp-ab-name');
        /* Rebuild spans if textContent clobbered them */
        if (!tagEl || !nameEl) {
          lbl.innerHTML = '';
          tagEl  = document.createElement('span');
          tagEl.className = 'tp-ab-tag';
          nameEl = document.createElement('span');
          nameEl.className = 'tp-ab-name';
          lbl.appendChild(tagEl);
          lbl.appendChild(document.createTextNode(' '));
          lbl.appendChild(nameEl);
        }
        tagEl.textContent  = version;
        nameEl.textContent = name;
        lbl.setAttribute('data-version', version);
        try {
          lbl.classList.toggle('is-playing', !!app.isPlaying);
        } catch (_) {}
      };

      app._vipEnhHooked = true;
    };

    if (window._vipApp) { hookOn(window._vipApp); return; }
    const t = setInterval(() => {
      if (window._vipApp) { hookOn(window._vipApp); clearInterval(t); }
    }, 80);
    setTimeout(() => clearInterval(t), 10000);
  }

  /* ── Init ─────────────────────────────────────────────────── */
  function init() {
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
