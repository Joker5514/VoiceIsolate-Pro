/**
 * m4a-decode-fix.js  — VoiceIsolate Pro patch
 * ============================================
 * Fixes: "Cannot decode this audio format" on mobile when loading .m4a files.
 *
 * ROOT CAUSE
 * ----------
 * app.js handleFile() treats audio/mp4 (.m4a) as a plain audio file.
 * On mobile Safari the AudioContext is suspended until a user gesture fully
 * resolves.  decodeAudioData() called on a suspended context can throw
 * "NotAllowedError" or silently reject.  The catch block only has a
 * video-file fallback; pure-audio failures fall straight to the error path.
 *
 * Additionally the isVideoFile regex only matches "video/" MIMEs and
 * video container extensions (.mp4, .m4v …).  An .m4a file has MIME
 * "audio/mp4" and extension ".m4a" — it matches neither branch, so
 * the video-element fallback is never attempted for the one container
 * that most commonly needs it on iOS.
 *
 * FIX STRATEGY
 * ------------
 * 1. Replace handleFile() on the live VoiceIsolatePro prototype with a
 *    version that:
 *      a. Explicitly resumes the AudioContext before calling decodeAudioData.
 *      b. Extends the isVideoFile / audio-mp4 detection to cover .m4a and
 *         "audio/mp4" MIME so the <video>-element decode fallback is tried.
 *      c. Adds a dedicated safeDecodeAudioData() helper with resume+retry.
 * 2. The patch is applied once at DOMContentLoaded (or immediately if the
 *    page is already loaded) so it runs after app.js has defined the class.
 *
 * NO EXTERNAL DEPS — 100 % local, no fetch, no cloud.
 */

(function applyM4ADecodeFix() {
  'use strict';

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /**
   * Resume ctx if suspended, then decode.  Retries once after a short delay
   * to handle the iOS "context not yet running" race.
   * @param {AudioContext} ctx
   * @param {ArrayBuffer}  ab
   * @returns {Promise<AudioBuffer>}
   */
  async function safeDecodeAudioData(ctx, ab) {
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) { /* best-effort */ }
    }
    try {
      return await ctx.decodeAudioData(ab.slice(0));
    } catch (firstErr) {
      // One retry after 120 ms — gives mobile Safari time to fully activate
      await new Promise(r => setTimeout(r, 120));
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_) { /* best-effort */ }
      }
      try {
        return await ctx.decodeAudioData(ab.slice(0));
      } catch (_) {
        throw firstErr; // surface the original error
      }
    }
  }

  /**
   * Detect whether a file should be treated as a container that may need
   * the <video>-element decode fallback.  Covers .m4a / audio/mp4 in
   * addition to the video containers already handled by app.js.
   */
  function needsVideoFallback(file) {
    const mime = (file.type || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return (
      mime.startsWith('video/') ||
      mime === 'audio/mp4'      ||   // .m4a, .m4b, .m4r
      mime === 'audio/x-m4a'   ||
      /\.(mp4|m4v|m4a|m4b|m4r|mov|webm|mkv|avi|ogv|3gp)$/.test(name)
    );
  }

  /* ── patched handleFile ─────────────────────────────────────────────────── */

  async function patchedHandleFile(file) {
    if (!file) return;
    this.stop();
    this.setStatus('LOADING');
    if (this.dom && this.dom.fileInfo) this.dom.fileInfo.textContent = file.name;

    await this.ensureCtx();

    // --- MIDI guard (unchanged) ---
    const midiMimes = ['audio/midi', 'audio/x-midi', 'audio/mid'];
    const isMidi = midiMimes.includes((file.type || '').toLowerCase()) ||
      /\.(mid|midi)$/i.test(file.name || '');
    if (isMidi) {
      if (this.dom && this.dom.fileInfo)
        this.dom.fileInfo.textContent = 'MIDI files are not supported. Use an audio file (WAV, MP3, etc).';
      this.setStatus('ERROR');
      return;
    }

    // --- MIME gate (unchanged) ---
    const isAudio = !file.type ||
      file.type.startsWith('audio/') ||
      file.type.startsWith('video/');
    if (!isAudio) {
      if (this.dom && this.dom.fileInfo)
        this.dom.fileInfo.textContent = 'Unsupported file type: ' + (file.type || 'unknown');
      this.setStatus('ERROR');
      return;
    }

    // --- Extended container detection (KEY FIX) ---
    const isVideoFile = needsVideoFallback(file);

    // Revoke any previous video object URL
    if (this.dom && this.dom.videoPlayer && this.dom.videoPlayer.src) {
      const prev = this.dom.videoPlayer;
      try { URL.revokeObjectURL(prev.src); } catch (_) { /* ignore */ }
      try {
        if (typeof prev.removeAttribute === 'function') prev.removeAttribute('src');
        else prev.src = '';
      } catch (_) { /* ignore */ }
    }

    let buffer;
    try {
      const ab = await file.arrayBuffer();
      // KEY FIX: use safeDecodeAudioData (resumes ctx, retries on mobile)
      buffer = await safeDecodeAudioData(this.ctx, ab);
    } catch (_decodeErr) {
      if (isVideoFile) {
        // Video-element fallback (handles HLS/AAC containers Safari can play
        // but whose raw bytes Web Audio cannot demux directly)
        try {
          buffer = await this.decodeViaVideoElement(file);
          if (buffer && this.dom && this.dom.videoPlayer) {
            try { this.dom.videoPlayer.src = URL.createObjectURL(file); } catch (_) { /* ignore */ }
          }
          if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = '';
          this.isVideo = true;
        } catch (_vidErr) {
          if (this.dom && this.dom.fileInfo)
            this.dom.fileInfo.textContent = 'Cannot decode this file — try converting to WAV or MP3.';
          this.setStatus('ERROR');
          this.showNotification('Cannot decode: ' + file.name, 'error');
          return;
        }
      } else {
        if (this.dom && this.dom.fileInfo)
          this.dom.fileInfo.textContent = 'Cannot decode this audio format — try WAV or MP3.';
        this.setStatus('ERROR');
        this.showNotification('Cannot decode: ' + file.name, 'error');
        return;
      }
    }

    // --- Empty buffer guard ---
    if (!buffer || !buffer.length) {
      if (this.dom && this.dom.fileInfo)
        this.dom.fileInfo.textContent = 'Decoded audio is empty or unreadable.';
      this.setStatus('ERROR');
      return;
    }

    // --- Wire <video> element for visual sync ---
    if (isVideoFile && this.dom && this.dom.videoPlayer) {
      this.isVideo = true;
      try {
        if (!this.dom.videoPlayer.src)
          this.dom.videoPlayer.src = URL.createObjectURL(file);
      } catch (_) { /* ignore */ }
      this.dom.videoPlayer.muted = true;
      if (this.dom.videoCard) this.dom.videoCard.style.display = '';
    } else {
      this.isVideo = false;
      if (this.dom && this.dom.videoPlayer) {
        const vp = this.dom.videoPlayer;
        try {
          if (vp.src) { try { URL.revokeObjectURL(vp.src); } catch (_) { /* ignore */ } }
          if (typeof vp.removeAttribute === 'function') vp.removeAttribute('src');
          else vp.src = '';
        } catch (_) { /* ignore */ }
      }
      if (this.dom && this.dom.videoCard) this.dom.videoCard.style.display = 'none';
    }

    this.inputBuffer = buffer;
    this.origBuffer  = buffer;
    this.onAudioLoaded(file.name);
  }

  /* ── apply patch ────────────────────────────────────────────────────────── */

  function applyPatch() {
    // Wait for the VoiceIsolatePro class to be available
    const VIP = window.VoiceIsolatePro;
    if (!VIP || !VIP.prototype) {
      // Retry up to 20 × 250 ms = 5 s
      if ((applyPatch._retries = (applyPatch._retries || 0) + 1) < 20) {
        setTimeout(applyPatch, 250);
      } else {
        console.warn('[m4a-decode-fix] VoiceIsolatePro not found — patch skipped.');
      }
      return;
    }

    VIP.prototype.handleFile = patchedHandleFile;

    // Also patch the live instance if it already exists
    if (window._vipApp && typeof window._vipApp.handleFile === 'function') {
      window._vipApp.handleFile = patchedHandleFile.bind(window._vipApp);
    }

    // Re-bind the fileInput change handler on the live instance so it calls
    // the patched version (the original was bound in bindEvents() before the
    // patch ran).
    const rebindInstance = window._vipApp;
    if (rebindInstance && rebindInstance.dom && rebindInstance.dom.fileInput) {
      const fi = rebindInstance.dom.fileInput;
      // Clone the element to drop the old listener, then re-add
      const newFi = fi.cloneNode(true);
      fi.parentNode && fi.parentNode.replaceChild(newFi, fi);
      rebindInstance.dom.fileInput = newFi;
      newFi.addEventListener('change', e =>
        rebindInstance.handleFile(e.target.files[0])
      );
    }

    console.info('[m4a-decode-fix] handleFile patched — M4A/audio-mp4 mobile decode fix active.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPatch);
  } else {
    // DOM already ready; wait one tick so app.js module evaluation finishes
    setTimeout(applyPatch, 0);
  }

})();
