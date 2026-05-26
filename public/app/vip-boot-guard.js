/**
 * vip-boot-guard.js — AudioContext readiness gate
 * ================================================
 * AUDIT FIX #11: vip-boot.js may attempt to connect AudioNodes before
 * app.js has finished constructing the AudioContext and calling
 * audioContext.audioWorklet.addModule(). This race condition produces:
 *   - "InvalidStateError: AudioNode from a different AudioContext"
 *   - Silent: nodes connected to a closed/suspended context produce no audio
 *   - addModule() Promise rejection if called twice on the same context
 *
 * This module provides a simple Promise-based gate. app.js signals
 * readiness by calling signalAudioContextReady(ctx). vip-boot.js (and
 * any other dependent module) awaits waitForAudioContext() before
 * connecting any nodes.
 *
 * USAGE:
 *
 * In app.js (after addModule completes):
 *   import { signalAudioContextReady } from './vip-boot-guard.js';
 *   await audioContext.audioWorklet.addModule(resolveWorkletUrl());
 *   signalAudioContextReady(audioContext);
 *
 * In vip-boot.js (before any AudioNode.connect calls):
 *   import { waitForAudioContext } from './vip-boot-guard.js';
 *   const ctx = await waitForAudioContext();
 *   // safe to connect nodes now
 */

'use strict';

let _resolveReady;
let _rejectReady;

/** @type {Promise<AudioContext>} */
const _readyPromise = new Promise((resolve, reject) => {
  _resolveReady = resolve;
  _rejectReady  = reject;
});

/** @type {AudioContext|null} */
let _audioContext = null;

/**
 * Called by app.js once AudioContext is constructed AND addModule() has
 * resolved. After this call, waitForAudioContext() resolves immediately.
 *
 * @param {AudioContext} ctx
 */
export function signalAudioContextReady(ctx) {
  if (!ctx || typeof ctx.createGain !== 'function') {
    const err = new Error('[vip-boot-guard] signalAudioContextReady called with invalid AudioContext.');
    _rejectReady(err);
    throw err;
  }
  _audioContext = ctx;
  _resolveReady(ctx);
}

/**
 * Returns a Promise that resolves with the AudioContext once it is ready.
 * Any code that touches AudioNodes (connect, disconnect, createGain, etc.)
 * MUST await this before proceeding.
 *
 * @param {number} [timeoutMs=8000]  Reject if not ready within this window.
 *   Increase for slow devices / large model loads. Decrease for tests.
 * @returns {Promise<AudioContext>}
 */
export function waitForAudioContext(timeoutMs = 8000) {
  // Already resolved — return immediately.
  if (_audioContext) return Promise.resolve(_audioContext);

  if (timeoutMs <= 0) return _readyPromise;

  return Promise.race([
    _readyPromise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(
          `[vip-boot-guard] AudioContext not ready after ${timeoutMs}ms. ` +
          'Ensure app.js calls signalAudioContextReady() after addModule() resolves. ' +
          'Check for COOP/COEP header issues if SharedArrayBuffer is unavailable.'
        )),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Synchronous check. Returns the AudioContext if ready, or null.
 * Use for non-critical UI checks (e.g. disabling a button until ready).
 * @returns {AudioContext|null}
 */
export function getAudioContextSync() {
  return _audioContext;
}
