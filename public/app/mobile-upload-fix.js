/**
 * mobile-upload-fix.js  v4
 * VoiceIsolate Pro — Mobile Upload Patch
 *
 * Fixes (cumulative — v1–v3 preserved):
 *  1. iOS Safari decodeAudioData callback compat (no Promise return)
 *  2. AudioContext gesture-lock on mobile (create + resume inside gesture)
 *  3. touch-action / pointer-events bleed from slider CSS
 *  4. &lt;input accept&gt; MIME scope for iOS/Android file pickers
 *  5. Android Chrome m4a/AAC decode failure (v1–v3):
 *     — resumes suspended AudioContext BEFORE decoding
 *     — clones the ArrayBuffer so it is never neutered before retry
 *     — retries with webkitAudioContext fallback on EncodingError
 *     — patches the existing loadFile error path to surface real errors
 *
 * NEW in v4 (Android "Unable to decode audio" targeted patch):
 *  A. MIME inference from file extension — Android ContentResolver delivers
 *     application/octet-stream or "" for files from Downloads/SD-card.
 *     Without the correct MIME the error appeared as "corrupt file" before
 *     any decode was ever attempted.
 *  B. 3GP/AMR early-reject — Android built-in voice recorder saves .3gp/.amr
 *     using AMR codecs that Chrome Android / Samsung Internet cannot decode
 *     via AudioContext.decodeAudioData. Now detected pre-decode with an
 *     actionable "convert to WAV/MP3/M4A" message instead of a cryptic
 *     EncodingError falsely labelled as corruption.
 *  C. Detached-buffer double-clone fix — Chromium on Android neuters
 *     arrayBuffer after the first decodeAudioData call, AND neuters buf1
 *     (the first .slice(0) clone) because that is the argument to decodeAudioData.
 *     The retry path then called arrayBuffer.slice(0) on an already-detached
 *     buffer, throwing "ArrayBuffer is detached". Fix: capture buf2 = arrayBuffer.slice(0)
 *     BEFORE the first decode attempt so the retry always has a live buffer.
 *  D. Codec-vs-corruption error messaging — matches Chromium Android's
 *     actual EncodingError text to give the user an actionable hint instead
 *     of falsely claiming the file is corrupt.
 *  E. Gesture-tick AudioContext unlock — ctx.resume() now called synchronously
 *     at the top of patchLoadFile (inside the gesture tick) before the async
 *     FileReader.onload fires, which is outside the gesture window on Android.
 *
 * Load AFTER app.js. Monkey-patches global helpers and re-wires the
 * upload zone without touching existing logic.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Android v4: MIME inference map — used when ContentResolver delivers
  // application/octet-stream or "" for a file that has a valid extension.
  // Covers every container the app's accept list allows.
  // ---------------------------------------------------------------------------
  var EXTENSION_MIME_MAP = {
    mp3:  'audio/mpeg',  wav:  'audio/wav',   wave: 'audio/wav',
    m4a:  'audio/mp4',   aac:  'audio/aac',   ogg:  'audio/ogg',
    oga:  'audio/ogg',   flac: 'audio/flac',  opus: 'audio/opus',
    webm: 'audio/webm',  weba: 'audio/webm',  mp4:  'audio/mp4',
    '3gp':'audio/3gpp',  '3g2':'audio/3gpp2', amr:  'audio/amr',
    aiff: 'audio/aiff',  aif:  'audio/aiff',  caf:  'audio/x-caf',
    wma:  'audio/x-ms-wma',
  };

  // Android v4: containers/codecs that Chrome Android + Samsung Internet
  // cannot decode via AudioContext.decodeAudioData. AMR-NB/AMR-WB in 3GP
  // is the most common source of the "Unable to decode audio" error from
  // Android's built-in voice recorder app.
  var ANDROID_UNSUPPORTED_EXT  = /^(3gp|3g2|3ga|amr|awb|amr-wb)$/i;
  var ANDROID_UNSUPPORTED_MIME = {
    'audio/amr': 1, 'audio/amr-wb': 1,
    'audio/3gpp': 1, 'audio/3gpp2': 1,
    'video/3gpp': 1, 'video/3gpp2': 1,
  };

  /** Returns true when running on Android (any browser or WebView). */
  function isAndroid() {
    try { return /Android/i.test(navigator.userAgent || ''); } catch (_) { return false; }
  }

  /**
   * isGenericMime — returns true for MIME types that carry no format info.
   * Android ContentResolver often delivers these for audio files on SD-card
   * or from third-party apps.
   */
  function isGenericMime(type) {
    var t = (type || '').toLowerCase().trim();
    return !t || t === 'application/octet-stream' || t === 'audio/*' || t === 'video/*';
  }

  /**
   * effectiveMime — infers the real MIME type from the file extension when
   * the File object carries a generic or empty MIME type.
   * Returns the original type if no inference is possible.
   */
  function effectiveMime(file) {
    if (!isGenericMime(file.type)) return file.type;
    var ext = ((file.name || '').split('.').pop() || '').toLowerCase();
    return EXTENSION_MIME_MAP[ext] || file.type || 'audio/mpeg';
  }

  /**
   * getFileExt — returns the lowercase extension of the filename without dot.
   */
  function getFileExt(file) {
    return ((file.name || '').split('.').pop() || '').toLowerCase();
  }

  /* ─── 1. Safe decodeAudioData shim ────────────────────────────────────────
   * iOS Safari webkitAudioContext.decodeAudioData does NOT return a Promise.
   * Android Chrome suspends AudioContext → decodeAudioData throws EncodingError.
   * This shim:
   *   a) ensures the context is resumed before every decode attempt
   *   b) captures TWO clones upfront — buf1 for attempt 1, buf2 for retry —
   *      because Chromium Android neuters BOTH arrayBuffer AND buf1 after the
   *      first decodeAudioData call (v4 fix C: double-clone guard)
   *   c) retries once with a fresh AudioContext on failure
   *
   * FIX (v3): The retry path no longer swaps window._vipAudioCtx to the
   * freshCtx. Replacing the app singleton with an untracked context orphaned
   * the AudioWorklet graph and all GainNode routing. The fresh context is
   * used only for the decode operation and then closed.
   */
  window.safeDecodeAudioData = async function (ctx, arrayBuffer) {
    // Android v4 fix E: resume inside the gesture tick before anything async.
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }

    // Android v4 fix C: capture buf2 BEFORE decodeAudioData is ever called.
    // Chromium Android neuters arrayBuffer AND the slice argument (buf1)
    // after the first decodeAudioData call, so the retry must use a clone
    // that was captured before any decode attempt.
    var buf2 = (arrayBuffer && arrayBuffer.byteLength > 0)
      ? arrayBuffer.slice(0)
      : arrayBuffer;

    // buf1 is the clone fed into the first decode attempt.
    var buf1 = (arrayBuffer && arrayBuffer.byteLength > 0)
      ? arrayBuffer.slice(0)
      : arrayBuffer;

    return new Promise(function (resolve, reject) {
      // Callback form works on all browsers including old iOS WebKit.
      ctx.decodeAudioData(buf1, resolve, async function (err) {
        console.warn('[VIP] decodeAudioData attempt 1 failed:', err);

        // ── Retry: create a fresh context for decode only ────────────────
        // FIX (v3): Do NOT assign freshCtx to window._vipAudioCtx — doing so
        // replaces the app's singleton and orphans the AudioWorklet graph.
        var freshCtx = null;
        try {
          var Ctor = window.AudioContext || window.webkitAudioContext;
          freshCtx = new Ctor();
          await freshCtx.resume();

          // Android v4 fix C: use the pre-captured buf2 clone (buf1 and
          // arrayBuffer are already neutered at this point on Android Chrome).
          var retryBuf = (buf2 && buf2.byteLength > 0)
            ? buf2
            : ((arrayBuffer && arrayBuffer.byteLength > 0) ? arrayBuffer.slice(0) : buf2);

          freshCtx.decodeAudioData(retryBuf, function (decoded) {
            try { freshCtx.close(); } catch (_) {}
            resolve(decoded);
          }, function (err2) {
            try { freshCtx.close(); } catch (_) {}
            console.error('[VIP] decodeAudioData retry also failed:', err2);

            // Android v4 fix D: distinguish codec/container errors from
            // genuine corruption so the user gets an actionable message.
            var errMsg = (err2 && err2.message ? err2.message : String(err2)) || '';
            var errMsg1 = (err && err.message ? err.message : String(err)) || '';
            var isCodecErr = /encodingerror|unable to decode|unsupported|not supported|no supported/i
              .test(errMsg + ' ' + errMsg1);
            var hint = (isAndroid() && isCodecErr)
              ? ' Try converting the file to WAV, MP3, or M4A/AAC before uploading.'
              : '';

            reject(new Error(
              (isCodecErr
                ? 'Audio format not supported by this browser/device.'
                : 'Cannot decode audio. File may be corrupted or format unsupported by this browser.')
              + hint +
              ' (' + errMsg + ')'
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
    var Ctor = window.AudioContext || window.webkitAudioContext;
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
    var selectors = [
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
  var AUDIO_ACCEPT_FULL = [
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
  var AUDIO_ACCEPT_ANDROID_NATIVE = 'audio/*,video/*';

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
      var current = (inp.getAttribute('accept') || '');
      if (/\.vippack|octet-stream/i.test(current)) return;
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
   * v4 additions on top of v3:
   *   A. MIME inference — calls effectiveMime(file) before FileReader runs so
   *      that files with application/octet-stream (Android ContentResolver)
   *      are identified by extension instead of being misclassified.
   *   B. 3GP/AMR early-reject — files that Android Chrome cannot decode are
   *      rejected with an actionable message BEFORE the FileReader starts,
   *      avoiding a misleading "corrupt file" error.
   *   E. Gesture-tick AudioContext unlock — ctx.resume() is now awaited at
   *      the synchronous top of patchLoadFile (still inside the gesture tick),
   *      not only inside FileReader.onload (which is asynchronous and fires
   *      outside the gesture window on Samsung Internet).
   *
   * FIX (v3, preserved): Removed the call to original() after
   * safeDecodeAudioData succeeds to prevent double-decode on neutered buffer.
   */
  function patchLoadFile() {
    if (typeof window.loadFile !== 'function') return;
    if (window.loadFile._mobilePatchApplied) return;

    window.loadFile = async function (file) {
      // Android v4 fix A: infer the real MIME from the file extension when
      // Android ContentResolver delivers application/octet-stream or "".
      // This determines which codec path runs below and what error to show.
      var mime = effectiveMime(file);
      var ext  = getFileExt(file);

      // Android v4 fix B: early-reject 3GP/AMR containers — these use
      // AMR-NB/AMR-WB codecs that Chrome Android and Samsung Internet
      // cannot decode via AudioContext.decodeAudioData. Attempting decode
      // stalls and surfaces a generic EncodingError ("Unable to decode audio")
      // with no actionable guidance. Reject here with an explicit message.
      if (ANDROID_UNSUPPORTED_EXT.test(ext) || ANDROID_UNSUPPORTED_MIME[mime]) {
        var fmtLabel = ext ? ext.toUpperCase() : mime;
        var msg = '\u26a0 ' + fmtLabel + ' format cannot be decoded by this browser. '
          + 'Convert to WAV, MP3, or M4A/AAC and upload again.';
        var fi = document.getElementById('fileInfo');
        if (fi) fi.textContent = msg;
        return Promise.reject(new Error(msg));
      }

      // Android v4 fix E: resume the AudioContext inside the gesture tick
      // BEFORE the async FileReader fires. On Samsung Internet the gesture
      // window closes before FileReader.onload runs, so ctx.resume() inside
      // onload is too late and AudioContext remains suspended.
      var ctx;
      try { ctx = await window.getAudioContext(); } catch (_) {}

      // Read the file once. safeDecodeAudioData handles all buffer cloning.
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = async function (e) {
          var ab = e.target.result;
          try {
            var activeCtx = window._vipAudioCtx || ctx;
            var audioBuffer = await window.safeDecodeAudioData(activeCtx, ab);

            // Store decoded buffer for app.js to pick up.
            window._vipDecodedBuffer = audioBuffer;

            // FIX (v3, preserved): Do NOT call original(file) here.
            // The original path triggers a second decode via FileIngestion
            // → decodeBlobToAudioBuffer on an already-neutered ArrayBuffer,
            // producing silence or an EncodingError swallowed by the catch.
            resolve();
          } catch (decodeErr) {
            console.error('[VIP] safeDecodeAudioData failed:', decodeErr);
            var fiEl = document.getElementById('fileInfo');
            if (fiEl) fiEl.textContent = '\u26a0 ' + (decodeErr.message || 'Decode failed — try WAV or MP3');
            reject(decodeErr);
          }
        };
        reader.onerror = function () {
          var msg = 'File read error — cannot open ' + (file.name || 'file');
          var fiEl = document.getElementById('fileInfo');
          if (fiEl) fiEl.textContent = '\u26a0 ' + msg;
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

    // Debounced observer — subtree:true + sync work on every slider row mount
    // freezes Android WebView during Engineer _renderSliders (50+ nodes).
    var debounceTimer = null;
    var fires = 0;
    var observer = new MutationObserver(function () {
      if (fires > 8) {
        try { observer.disconnect(); } catch (_) {}
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        fires += 1;
        fixUploadZoneTouchTarget();
        patchFileInput();
        patchLoadFile();
        ensureUploadWiring();
        // Stop watching once upload controls are stably wired.
        if (document.getElementById('fileInput') &&
            document.getElementById('fileInput').dataset &&
            document.getElementById('fileInput').dataset.vipChangeBound === '1' &&
            fires >= 2) {
          try { observer.disconnect(); } catch (_) {}
        }
      }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[VIP] mobile-upload-fix.js v4 loaded — Android decode reliability patch');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
