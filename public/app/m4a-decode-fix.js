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
 * Expose window.decodeM4AWithFallback (resume the AudioContext, decode, retry
 * once). app.js handleFile calls it for AAC/M4A containers. This file no
 * longer patches handleFile (see the note at the bottom).
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

  window.decodeM4AWithFallback = async function decodeM4AWithFallback(ctx, arrayBuffer) {
    return safeDecodeAudioData(ctx, arrayBuffer.slice(0));
  };
  window.__vipM4ADecodeFixLoaded = true;

  /*
   * This file used to replace VoiceIsolatePro#handleFile (on the prototype and
   * on the live instance) with its own loader, and to clone #fileInput to drop
   * app.js's change listener. That loader decoded and set inputBuffer but never
   * bumped _fileSeq, never dropped the previous file's stems and never set
   * _sourceFile. A second upload in the same session re-used the first file's
   * stems ("retained stems"), so two different inputs exported byte-identical
   * WAVs and the integrity sidecar had "source": null (live test t24u/t25u).
   *
   * app.js handleFile already routes AAC/M4A decode through
   * window.decodeM4AWithFallback (_decodeFileBuffer), so only the
   * helper above is needed. handleFile and the file input are left alone.
   */
  console.info('[m4a-decode-fix] decodeM4AWithFallback ready (handleFile not patched).');

})();
