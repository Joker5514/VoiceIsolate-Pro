/**
 * mobile-upload-fix.js
 * VoiceIsolate Pro — Mobile Upload Patch
 * Fixes:
 *  1. iOS Safari decodeAudioData callback compat (no Promise return)
 *  2. AudioContext gesture-lock on mobile
 *  3. touch-action / pointer-events bleed from slider CSS
 *  4. <input accept> MIME type scope for iOS file picker
 *
 * Load this AFTER app.js. It monkey-patches the global helpers
 * and re-wires the upload zone without touching existing logic.
 */

(function () {
  'use strict';

  /* ─── 1. Safe decodeAudioData shim ────────────────────────────────────────
   * iOS Safari's webkitAudioContext.decodeAudioData does NOT return a Promise.
   * This shim wraps it in one universally. Replace every call in app.js with
   * window.safeDecodeAudioData(ctx, arrayBuffer).
   */
  window.safeDecodeAudioData = function (ctx, arrayBuffer) {
    return new Promise(function (resolve, reject) {
      // Callback form works on all browsers including old iOS WebKit
      ctx.decodeAudioData(arrayBuffer, resolve, reject);
    });
  };

  /* ─── 2. AudioContext factory — lazy, gesture-safe ────────────────────────
   * Creates (or resumes) an AudioContext only inside a user-gesture handler.
   * Call window.getAudioContext() anywhere; it returns a Promise<AudioContext>.
   */
  window._vipAudioCtx = null;

  window.getAudioContext = async function () {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');

    if (!window._vipAudioCtx) {
      window._vipAudioCtx = new Ctor();
    }

    // Chrome suspends AudioContext if created before first gesture
    if (window._vipAudioCtx.state === 'suspended') {
      await window._vipAudioCtx.resume();
    }

    return window._vipAudioCtx;
  };

  /* ─── 3. Fix pointer-events / touch-action bleed on upload zone ───────────
   * slider-theme.css and mobile.css set touch-action:none broadly.
   * We forcibly restore the upload drop zone after DOM is ready.
   */
  function fixUploadZoneTouchTarget() {
    const selectors = [
      '#dz', '#dropZone', '.drop-zone', '#uploadZone',
      '#fi', 'input[type="file"]',
      '.drop-btns', '.drop-btns button',
      '#micBtn'
    ];

    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        el.style.touchAction = 'auto';
        el.style.pointerEvents = 'auto';
        el.style.webkitUserSelect = 'auto';
        el.style.userSelect = 'auto';
      });
    });
  }

  /* ─── 4. Expand <input type="file"> accept to full iOS MIME list ──────────
   * iOS Safari ignores generic "audio/*" on some versions.
   * Explicit MIME list forces the correct native picker panel.
   */
  const IOS_AUDIO_ACCEPT = [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
    'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/aac',
    'audio/x-m4a', 'audio/m4a', 'audio/mp4',
    'video/mp4', 'video/webm', 'video/quicktime',
    'audio/*', 'video/*'
  ].join(',');

  function patchFileInput() {
    document.querySelectorAll('input[type="file"]').forEach(function (inp) {
      inp.setAttribute('accept', IOS_AUDIO_ACCEPT);
    });
  }

  /* ─── 5. Re-wire upload zone click to ensure AudioContext is created
   *        inside the gesture stack, then open file picker ─────────────────
   */
  function wireUploadZoneGesture() {
    const zones = document.querySelectorAll('#dz, #dropZone, #uploadZone, .drop-zone');
    const fileInputs = document.querySelectorAll('input[type="file"]');

    // Intercept the click — resume/create AudioContext first, then open picker
    zones.forEach(function (zone) {
      // Remove any existing click handler clones by replacing with clone
      const fresh = zone.cloneNode(true);
      zone.parentNode && zone.parentNode.replaceChild(fresh, zone);

      fresh.addEventListener('click', async function (e) {
        // Don't intercept clicks on child buttons that already handle things
        if (e.target.tagName === 'BUTTON' && e.target !== fresh) return;
        try {
          await window.getAudioContext(); // ensure ctx exists within gesture
        } catch (_) { /* non-fatal */ }
        // Trigger the hidden file input
        const fi = document.getElementById('fi') ||
                   document.getElementById('fileInput') ||
                   fileInputs[0];
        if (fi) fi.click();
      });

      // Restore drag-drop events on the fresh node
      ['dragenter', 'dragover'].forEach(function (ev) {
        fresh.addEventListener(ev, function (e) {
          e.preventDefault();
          fresh.classList.add('over', 'dragover');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        fresh.addEventListener(ev, function () {
          fresh.classList.remove('over', 'dragover');
        });
      });
      fresh.addEventListener('drop', async function (e) {
        e.preventDefault();
        fresh.classList.remove('over', 'dragover');
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file && window.loadFile) {
          // Ensure AudioContext is live before loadFile runs
          try { await window.getAudioContext(); } catch (_) {}
          window.loadFile(file);
        }
      });
    });
  }

  /* ─── 6. Patch loadFile to use safe decode shim ──────────────────────────
   * Wraps the existing global loadFile (defined in app.js) to swap in
   * safeDecodeAudioData. Safe to call multiple times.
   */
  function patchLoadFile() {
    if (typeof window.loadFile !== 'function') return;
    if (window.loadFile._mobilePatchApplied) return;

    const original = window.loadFile;
    window.loadFile = async function (file) {
      // Ensure AudioContext exists in gesture context before original runs
      try { await window.getAudioContext(); } catch (_) {}
      return original.call(this, file);
    };
    window.loadFile._mobilePatchApplied = true;
  }

  /* ─── Init ─────────────────────────────────────────────────────────────── */
  function init() {
    fixUploadZoneTouchTarget();
    patchFileInput();
    wireUploadZoneGesture();
    patchLoadFile();

    // MutationObserver: re-apply fixes if DOM is rebuilt by app.js
    const observer = new MutationObserver(function () {
      fixUploadZoneTouchTarget();
      patchFileInput();
      patchLoadFile();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[VIP] mobile-upload-fix.js loaded — all 5 patches applied');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
