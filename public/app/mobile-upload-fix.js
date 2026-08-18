/**
 * mobile-upload-fix.js  v3
 * VoiceIsolate Pro — Mobile Upload Patch
 *
 * Fixes:
 *  1. iOS Safari decodeAudioData callback compat (no Promise return)
 *  2. AudioContext gesture-lock on mobile (create + resume inside gesture)
 *  3. touch-action / pointer-events bleed from slider CSS
 *  4. <input accept> MIME scope for iOS/Android file pickers
 *  5. Android Chrome m4a/AAC decode failure:
 *     — resumes suspended AudioContext BEFORE decoding
 *     — clones the ArrayBuffer so it is never neutered before retry
 *     — retries with webkitAudioContext fallback on EncodingError
 *     — patches the existing loadFile error path to surface real errors
 *
 * v3 fixes:
 *  - Removed double-decode in patchLoadFile: calling original() after
 *    safeDecodeAudioData neutered the ArrayBuffer on Android Chrome,
 *    causing a silent second decode failure.
 *  - Removed window._vipAudioCtx swap inside safeDecodeAudioData retry:
 *    replacing the singleton context orphaned the AudioWorklet graph and
 *    all downstream GainNode routing, producing silence after any retry.
 *
 * Load AFTER app.js. Monkey-patches global helpers and re-wires the
 * upload zone without touching existing logic.
 */

(function () {
  'use strict';

  /* ─── 1. Safe decodeAudioData shim ────────────────────────────────────────
   * iOS Safari webkitAudioContext.decodeAudioData does NOT return a Promise.
   * Android Chrome suspends AudioContext → decodeAudioData throws EncodingError.
   * This shim:
   *   a) ensures the context is resumed before every decode attempt
   *   b) clones the ArrayBuffer so the original is never neutered
   *   c) retries once with a fresh AudioContext on failure
   *
   * FIX (v3): The retry path no longer swaps window._vipAudioCtx to the
   * freshCtx. Replacing the app singleton with an untracked context orphaned
   * the AudioWorklet graph and all GainNode routing. The fresh context is
   * used only for the decode operation and then closed.
   */
  window.safeDecodeAudioData = async function (ctx, arrayBuffer) {
    // Always resume first — Android Chrome requires this before decode
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }

    // Clone the buffer — decodeAudioData neuters the original on some Android builds
    const buf1 = arrayBuffer.slice(0);

    return new Promise(function (resolve, reject) {
      // Callback form works on all browsers including old iOS WebKit
      ctx.decodeAudioData(buf1, resolve, async function (err) {
        console.warn('[VIP] decodeAudioData attempt 1 failed:', err);

        // ── Retry: create a fresh context for decode only ────────────────
        // FIX: Do NOT assign freshCtx to window._vipAudioCtx — doing so
        // replaces the app's singleton and orphans the AudioWorklet graph.
        let freshCtx = null;
        try {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          freshCtx = new Ctor();
          await freshCtx.resume();
          const buf2 = arrayBuffer.slice(0); // fresh clone for retry
          freshCtx.decodeAudioData(buf2, function (decoded) {
            // Close the temporary context — we only needed it for decode.
            try { freshCtx.close(); } catch (_) {}
            resolve(decoded);
          }, function (err2) {
            try { freshCtx.close(); } catch (_) {}
            console.error('[VIP] decodeAudioData retry also failed:', err2);
            reject(new Error(
              'Cannot decode audio. File may be corrupted or format unsupported by this browser. ' +
              '(' + (err2 && err2.message ? err2.message : String(err2)) + ')'
            ));
          });
        } catch (retryEx) {
          if (freshCtx) try { freshCtx.close(); } catch (_) {}
          reject(retryEx);
        }
      });
    });
  };

  /* ─── 2. AudioContext factory — lazy, gesture-safe ────────────────────────
   * Creates (or resumes) an AudioContext only inside a user-gesture handler.
   */
  window._vipAudioCtx = null;

  window.getAudioContext = async function () {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API not supported');

    if (!window._vipAudioCtx) {
      window._vipAudioCtx = new Ctor();
    }

    if (window._vipAudioCtx.state === 'suspended') {
      await window._vipAudioCtx.resume();
    }

    return window._vipAudioCtx;
  };

  /* ─── 3. Fix pointer-events / touch-action bleed on upload zone ───────────
   * slider-theme.css and mobile.css set touch-action:none broadly.
   */
  function fixUploadZoneTouchTarget() {
    const selectors = [
      '#dz', '#dropZone', '.drop-zone', '#uploadZone',
      '#fi', 'input[type="file"]',
      '.drop-btns', '.drop-btns button',
      '#fileBtn'
    ];
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        el.style.touchAction    = 'auto';
        el.style.pointerEvents  = 'auto';
        el.style.webkitUserSelect = 'auto';
        el.style.userSelect     = 'auto';
      });
    });
  }

  /* ─── 4. Expand <input type="file"> accept to full MIME list ─────────────
   * Explicit MIME list forces the correct native picker on iOS + Android.
   */
  /** Desktop/mobile-web: full list. Capacitor Android: compact wildcards (OEM picker safe). */
  const AUDIO_ACCEPT_FULL = [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave',
    'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/aac', 'audio/x-aac',
    'audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/webm', 'audio/amr',
    'audio/aiff', 'audio/x-aiff', 'audio/x-caf', 'audio/x-ms-wma',
    'audio/opus', 'audio/ac3', 'audio/eac3',
    'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/ogg', 'video/3gpp', 'video/3gpp2',
    'video/x-ms-wmv', 'video/mpeg', 'video/mp2t', 'video/x-flv',
    'audio/*', 'video/*',
    '.wav', '.wave', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus',
    '.flac', '.webm', '.weba', '.aiff', '.aif', '.caf', '.wma', '.mka',
    '.m4b', '.m4r', '.amr', '.ac3', '.eac3',
    '.mp4', '.m4v', '.mov', '.mkv', '.avi', '.ogv', '.3gp', '.3g2',
    '.wmv', '.mpeg', '.mpg', '.ts', '.m2ts', '.mts', '.flv', '.f4v', '.asf',
  ].join(',');
  const AUDIO_ACCEPT_ANDROID_NATIVE = [
    'audio/*', 'video/*',
    'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm',
    'video/mp4', 'video/webm', 'video/quicktime',
    '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.webm', '.mp4', '.mov',
  ].join(',');

  function isAndroidNativeShell() {
    try {
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
          && window.Capacitor.isNativePlatform()) {
        var p = typeof window.Capacitor.getPlatform === 'function' ? window.Capacitor.getPlatform() : '';
        if (p === 'android') return true;
      }
    } catch (_) {}
    var ua = navigator.userAgent || '';
    return /Android/i.test(ua) && (/; wv\)/i.test(ua) || /VoiceIsolatePro\//i.test(ua));
  }

  function patchFileInput() {
    var accept = isAndroidNativeShell() ? AUDIO_ACCEPT_ANDROID_NATIVE : AUDIO_ACCEPT_FULL;
    document.querySelectorAll('input[type="file"]').forEach(function (inp) {
      inp.setAttribute('accept', accept);
    });
  }

  /* ─── 5. Re-wire upload controls WITHOUT cloning DOM nodes ───────────────
   * Cloning #dropZone / #uploadZone orphaned app.js handlers and could fire
   * fileInput.click() twice (zone + nested zone).  Instead, refresh live DOM
   * refs on _vipApp and bind idempotent listeners once the app boots.
   */
  function ensureUploadWiring() {
    var app = window._vipApp;
    var fi = document.getElementById('fileInput');
    if (!fi) return false;

    if (app && app.dom) {
      app.dom.fileInput = fi;
      var fb = document.getElementById('fileBtn');
      if (fb) app.dom.fileBtn = fb;
      var uz = document.getElementById('uploadZone');
      if (uz) app.dom.uploadZone = uz;
      var dz = document.getElementById('dropZone');
      if (dz) app.dom.dropZone = dz;
    }

    // Re-bind change in case a legacy patch cloned/replaced the input node.
    if (!fi.dataset.vipChangeBound) {
      fi.dataset.vipChangeBound = '1';
      fi.addEventListener('change', function (e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;
        var live = window._vipApp;
        if (live && typeof live.handleFile === 'function') {
          live.handleFile(file);
        }
      });
    }

    var dropZone = document.getElementById('dropZone');
    if (dropZone && !dropZone.dataset.vipDropBound) {
      dropZone.dataset.vipDropBound = '1';
      ['dragenter', 'dragover'].forEach(function (ev) {
        dropZone.addEventListener(ev, function (e) {
          e.preventDefault();
          dropZone.classList.add('drag-over', 'dragover', 'over');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        dropZone.addEventListener(ev, function () {
          dropZone.classList.remove('drag-over', 'dragover', 'over');
        });
      });
      dropZone.addEventListener('drop', async function (e) {
        e.preventDefault();
        dropZone.classList.remove('drag-over', 'dragover', 'over');
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        try { await window.getAudioContext(); } catch (_) {}
        var live = window._vipApp;
        if (live && typeof live.handleFile === 'function') {
          live.handleFile(file);
        }
      });
    }

    return true;
  }

  function waitForUploadWiring() {
    if (ensureUploadWiring()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (ensureUploadWiring() || ++tries >= 40) clearInterval(timer);
    }, 250);
  }

  /* ─── 6. Patch loadFile — intercept the decode call with safeDecodeAudioData
   *
   * This is the core Android m4a fix. Ensures:
   *   a) AudioContext is resumed before the file reader runs
   *   b) The ArrayBuffer is decoded via safeDecodeAudioData (with retry)
   *   c) A meaningful error is shown instead of the generic string
   *
   * FIX (v3): Removed the call to original() after safeDecodeAudioData
   * succeeds. The original loadFile path calls decodeBlobToAudioBuffer via
   * FileIngestion — a separate code path that never reads _vipDecodedBuffer.
   * Calling it after safeDecodeAudioData had already neutered the ArrayBuffer
   * (Android Chrome detaches the buffer after decodeAudioData) caused a
   * silent second-decode failure swallowed by the catch block.
   * Now: safeDecodeAudioData succeeds → store buffer → done. No double-decode.
   */
  function patchLoadFile() {
    if (typeof window.loadFile !== 'function') return;
    if (window.loadFile._mobilePatchApplied) return;

    window.loadFile = async function (file) {
      // Step 1: ensure AudioContext is alive inside this gesture stack
      let ctx;
      try { ctx = await window.getAudioContext(); } catch (_) {}

      // Step 2: read the file into an ArrayBuffer and decode via the shim
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = async function (e) {
          const ab = e.target.result;
          try {
            const activeCtx = window._vipAudioCtx || ctx;
            const audioBuffer = await window.safeDecodeAudioData(activeCtx, ab);

            // Store decoded buffer for app.js to pick up
            window._vipDecodedBuffer = audioBuffer;

            // FIX: Do NOT call original(file) here. The original path
            // triggers a second decode (FileIngestion → decodeBlobToAudioBuffer)
            // on an already-neutered ArrayBuffer, producing silence or an
            // EncodingError silently swallowed by the catch below.
            resolve();
          } catch (decodeErr) {
            console.error('[VIP] safeDecodeAudioData failed:', decodeErr);
            const fi = document.getElementById('fileInfo');
            if (fi) fi.textContent = '\u26a0 ' + (decodeErr.message || 'Decode failed — try WAV or MP3');
            reject(decodeErr);
          }
        };
        reader.onerror = function () {
          const msg = 'File read error — cannot open ' + (file.name || 'file');
          const fi = document.getElementById('fileInfo');
          if (fi) fi.textContent = '\u26a0 ' + msg;
          reject(new Error(msg));
        };
        reader.readAsArrayBuffer(file);
      });
    };

    window.loadFile._mobilePatchApplied = true;
  }

  /* ─── Init ─────────────────────────────────────────────────────────────── */
  function init() {
    fixUploadZoneTouchTarget();
    patchFileInput();
    waitForUploadWiring();
    patchLoadFile();

    // MutationObserver: re-apply if DOM is rebuilt by app.js
    const observer = new MutationObserver(function () {
      fixUploadZoneTouchTarget();
      patchFileInput();
      patchLoadFile();
      ensureUploadWiring();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[VIP] mobile-upload-fix.js v3 loaded — double-decode & context-swap bugs fixed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
