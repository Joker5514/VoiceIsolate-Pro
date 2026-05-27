
import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
import { ModelStatusUI } from './model-status-ui.js';
import { runFullPipeline } from './dsp-stages.js';
// DSP math (forwardSTFT / inverseSTFT) lives on globalThis.DSPCore, exposed by
// the classic <script src="./dsp-core.js"> tag in index.html — loaded before
// this module so the binding is live at evaluation time. `DSP` retained as a
// shorter alias; legacy globalThis.DSP kept as a fallback.
function resolveDSPOrFail() {
  const dsp = globalThis.DSPCore || globalThis.DSP;
  const hasForward = !!dsp && typeof dsp.forwardSTFT === 'function';
  const hasInverse = !!dsp && typeof dsp.inverseSTFT === 'function';

  if (hasForward && hasInverse) return dsp;

  const error = new Error(
    'DSPCore is required but was not initialized correctly. Missing DSP.forwardSTFT and/or DSP.inverseSTFT.'
  );
  const details = {
    hasDSPCore: !!globalThis.DSPCore,
    hasLegacyDSP: !!globalThis.DSP,
    hasForwardSTFT: hasForward,
    hasInverseSTFT: hasInverse,
  };

  console.error('[VIP] Failed to initialize DSP dependency', details);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('vip:dsp-error', {
      detail: {
        message: error.message,
        ...details,
      },
    }));
  }

  throw error;
}
