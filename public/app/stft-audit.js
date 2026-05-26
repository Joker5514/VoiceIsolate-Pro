/**
 * stft-audit.js — Runtime STFT call-count assertion
 * ==================================================
 * AUDIT FIX #12: Architecture constraint — exactly ONE forwardSTFT call
 * and ONE iSTFT call per process() tick. dsp-core.js (65 KB) is large
 * enough to have accumulated duplicate STFT calls across processing paths.
 *
 * This module patches the global dspCore (or any object exposing
 * forwardSTFT / inverseSTFT) to count calls per animation/process frame
 * and emit a loud console.error (non-fatal) when the count exceeds 1.
 *
 * ACTIVATION: Only active when:
 *   - hostname === 'localhost' (local dev), OR
 *   - URL has ?vip_debug=1, OR
 *   - window.VIP_DEBUG === true
 *
 * In production (voiceisolatepro.com) this module loads but immediately
 * returns without patching — zero runtime overhead.
 *
 * USAGE in dsp-core.js or app.js (after dspCore is constructed):
 *   import { installStftAudit } from './stft-audit.js';
 *   installStftAudit(dspCore); // pass the object that owns forwardSTFT
 */

'use strict';

function isDebugEnv() {
  if (typeof window === 'undefined') return false;
  if (window.VIP_DEBUG === true) return true;
  if (typeof location !== 'undefined') {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return true;
    if (location.search.includes('vip_debug=1')) return true;
  }
  return false;
}

/**
 * Installs call-count wrappers around forwardSTFT and inverseSTFT on the
 * provided DSP core object. Noop in production environments.
 *
 * @param {object} dspCore  Object exposing forwardSTFT() and inverseSTFT().
 * @param {object} [opts]
 * @param {number} [opts.maxForward=1]  Max allowed forwardSTFT calls per tick.
 * @param {number} [opts.maxInverse=1]  Max allowed inverseSTFT calls per tick.
 */
export function installStftAudit(dspCore, { maxForward = 1, maxInverse = 1 } = {}) {
  if (!isDebugEnv()) return; // Production: no-op

  if (!dspCore || typeof dspCore.forwardSTFT !== 'function') {
    console.warn('[stft-audit] dspCore.forwardSTFT not found — patch skipped. Ensure installStftAudit() is called after dsp-core initializes.');
    return;
  }

  let forwardCount = 0;
  let inverseCount = 0;
  let frameScheduled = false;

  const _originalForward = dspCore.forwardSTFT.bind(dspCore);
  const _originalInverse = dspCore.inverseSTFT.bind(dspCore);

  function scheduleReset() {
    if (frameScheduled) return;
    frameScheduled = true;
    // Use MessageChannel for sub-frame scheduling (works in AudioWorklet too)
    const mc = new MessageChannel();
    mc.port1.onmessage = () => {
      forwardCount = 0;
      inverseCount = 0;
      frameScheduled = false;
    };
    mc.port2.postMessage(null);
  }

  dspCore.forwardSTFT = function (...args) {
    forwardCount++;
    scheduleReset();
    if (forwardCount > maxForward) {
      console.error(
        `[stft-audit] ⚠️  forwardSTFT called ${forwardCount}× in one tick (max ${maxForward}).`,
        'This violates the Single-Pass STFT constraint and will cause phase smearing.',
        'Stack trace follows:',
        new Error().stack
      );
    }
    return _originalForward(...args);
  };

  dspCore.inverseSTFT = function (...args) {
    inverseCount++;
    scheduleReset();
    if (inverseCount > maxInverse) {
      console.error(
        `[stft-audit] ⚠️  inverseSTFT called ${inverseCount}× in one tick (max ${maxInverse}).`,
        'Multiple iSTFT calls per tick produce aliasing artifacts on voice output.',
        'Stack trace follows:',
        new Error().stack
      );
    }
    return _originalInverse(...args);
  };

  console.info('[stft-audit] STFT call-count audit active (dev mode). Max forward:', maxForward, '/ Max inverse:', maxInverse);
}
