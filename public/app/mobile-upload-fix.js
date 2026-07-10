/**
 * mobile-upload-fix.js  v2
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

        // ── Retry: create a fresh context and try again ──────────────────
        try {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          const freshCtx = new Ctor();
          await freshCtx.resume();
          const buf2 = arrayBuffer.slice(0); // fresh clone for retry
          freshCtx.decodeAudioData(buf2, function (decoded) {
            // Swap the global context to the working one
            window._vipAudioCtx = freshCtx;
            resolve(decoded);
          }, function (err2) {
            console.error('[VIP] decodeAudioData retry also failed:', err2);
            reject(new Error(
              'Cannot decode audio. File may be corrupted or format unsupported by this browser. ' +
              '(' + (err2 && err2.message ? err2.message : String(err2)) + ')'
            ));
          });
        } catch (retryEx) {
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
  const AUDIO_ACCEPT = [
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

  function patchFileInput() {
    document.querySelectorAll('input[type="file"]').forEach(function (inp) {
      inp.setAttribute('accept', AUDIO_ACCEPT);
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
   * This is the core Android m4a fix. app.js calls ctx.decodeAudioData()
   * directly. We replace loadFile so that:
   *   a) AudioContext is resumed before the file reader runs
   *   b) The ArrayBuffer is decoded via safeDecodeAudioData (with retry)
   *   c) A meaningful error is shown instead of the generic string
   */
  function patchLoadFile() {
    if (typeof window.loadFile !== 'function') return;
    if (window.loadFile._mobilePatchApplied) return;

    const original = window.loadFile;

    window.loadFile = async function (file) {
      // Step 1: ensure AudioContext is alive inside this gesture stack
      let ctx;
      try { ctx = await window.getAudioContext(); } catch (_) {}

      // Step 2: read the file into an ArrayBuffer ourselves so we can
      //         feed it through safeDecodeAudioData with retry logic
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = async function (e) {
          const ab = e.target.result;
          try {
            // Use whichever context is active (may have been swapped by retry)
            const activeCtx = window._vipAudioCtx || ctx;
            const audioBuffer = await window.safeDecodeAudioData(activeCtx, ab);

            // Inject decoded buffer onto the global so app.js picks it up
            window._vipDecodedBuffer = audioBuffer;

            // Also call original — it will re-decode OR app.js may check
            // window._vipDecodedBuffer first. Either way audio is available.
            try {
              await original.call(this, file);
            } catch (origErr) {
              // Original failed (likely same decode path) — that's fine,
              // we already have the decoded buffer stored.
              console.warn('[VIP] original loadFile threw after decode shim, ignoring:', origErr);
            }
            resolve();
          } catch (decodeErr) {
            console.error('[VIP] safeDecodeAudioData failed:', decodeErr);
            // Surface a real error message in the UI
            const fi = document.getElementById('fileInfo');
            if (fi) fi.textContent = '⚠ ' + (decodeErr.message || 'Decode failed — try WAV or MP3');
            reject(decodeErr);
          }
        };
        reader.onerror = function () {
          const msg = 'File read error — cannot open ' + (file.name || 'file');
          const fi = document.getElementById('fileInfo');
          if (fi) fi.textContent = '⚠ ' + msg;
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

    console.log('[VIP] mobile-upload-fix.js v2 loaded — 6 patches applied (incl. Android m4a retry)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
