/**
 * VoiceIsolate Pro — Slider UI Bindings (Layer 4: Presentation)
 *
 * Binds HTML range inputs to PlaybackMixer controls. Slider `input` events
 * are coalesced through a single requestAnimationFrame loop so a fast drag
 * produces at most one AudioParam update per display frame — zero-latency
 * feel without flooding the audio thread.
 *
 * THE CONTRACT (CLAUDE.md §1.1): sliders talk to PlaybackMixer AudioParams
 * ONLY. They never call into MLWorker, never re-trigger inference, never
 * touch model state.
 *
 * Expected markup (ids are the public contract; absent sliders are skipped):
 *   <input type="range" id="noiseReductionSlider" min="0" max="100">
 *   <input type="range" id="voiceLevelSlider"     min="0" max="200">
 *   <input type="range" id="volumeSlider"         min="0" max="100">
 *   <input type="range" id="eqLowSlider"          min="-24" max="24">
 *   <input type="range" id="eqHighSlider"         min="-24" max="24">
 */
'use strict';

/**
 * Slider id → PlaybackMixer method, plus the value each control starts at.
 * Single place to extend when a new real-time control is added.
 */
const SLIDER_BINDINGS = Object.freeze([
  { id: 'noiseReductionSlider', method: 'setNoiseReduction', initial: 100 },
  { id: 'voiceLevelSlider', method: 'setVoiceLevel', initial: 100 },
  { id: 'volumeSlider', method: 'setVolume', initial: 100 },
  { id: 'eqLowSlider', method: 'setLowShelf', initial: 0 },
  { id: 'eqHighSlider', method: 'setHighShelf', initial: 0 },
  // Tier-A console (all map to PlaybackMixer AudioParams; absent ids skipped).
  { id: 'eqLowMidSlider', method: 'setEqLowMid', initial: 0 },
  { id: 'eqMidSlider', method: 'setEqMid', initial: 0 },
  { id: 'eqHighMidSlider', method: 'setEqHighMid', initial: 0 },
  { id: 'highpassSlider', method: 'setHighpass', initial: 20 },
  { id: 'lowpassSlider', method: 'setLowpass', initial: 20000 },
  { id: 'compThresholdSlider', method: 'setCompThreshold', initial: 0 },
  { id: 'compRatioSlider', method: 'setCompRatio', initial: 1 },
  { id: 'compAttackSlider', method: 'setCompAttack', initial: 20 },
  { id: 'compReleaseSlider', method: 'setCompRelease', initial: 250 },
  { id: 'compKneeSlider', method: 'setCompKnee', initial: 0 },
  { id: 'makeupGainSlider', method: 'setMakeupGain', initial: 0 },
]);

export class SliderUI {
  /**
   * @param {import('../pipeline/PlaybackMixer.js').PlaybackMixer} mixer
   * @param {object} [options]
   * @param {Document} [options.document]  injectable for tests
   * @param {(label: string, value: number) => void} [options.onChange]
   *        optional hook for readout labels / persistence
   */
  constructor(mixer, options = {}) {
    if (!mixer) throw new TypeError('[VIP][SliderUI] A PlaybackMixer instance is required.');
    this.mixer = mixer;
    this.doc = options.document || globalThis.document;
    this.onChange = options.onChange || null;

    /** Pending values written by 'input' events, flushed once per frame. */
    this._pending = new Map();
    this._rafId = null;
    this._listeners = [];
  }

  /** Wire every known slider present in the DOM. Returns count bound. */
  bind() {
    let bound = 0;
    for (const { id, method, initial } of SLIDER_BINDINGS) {
      const el = this.doc.getElementById(id);
      if (!el) continue;
      if (typeof this.mixer[method] !== 'function') {
        console.warn(`[VIP][SliderUI] Mixer is missing ${method}(); skipping #${id}.`);
        continue;
      }

      // Initialize the audio graph from the slider's current position so the
      // UI and the graph never start out of sync.
      const startValue = el.value !== '' ? Number(el.value) : initial;
      this.mixer[method](startValue);

      const handler = () => {
        this._pending.set(method, Number(el.value));
        this._scheduleFlush();
        if (this.onChange) this.onChange(id, Number(el.value));
      };
      el.addEventListener('input', handler);
      this._listeners.push({ el, handler });
      bound++;
    }
    return bound;
  }

  /** Coalesce slider updates: one rAF flush per display frame. */
  _scheduleFlush() {
    if (this._rafId !== null) return;
    const raf = globalThis.requestAnimationFrame
      ? globalThis.requestAnimationFrame.bind(globalThis)
      : (cb) => setTimeout(cb, 16); // non-browser fallback (tests)
    this._rafId = raf(() => {
      this._rafId = null;
      for (const [method, value] of this._pending) {
        try {
          this.mixer[method](value);
        } catch (err) {
          console.error(`[VIP][SliderUI] ${method}(${value}) failed:`, err);
        }
      }
      this._pending.clear();
    });
  }

  /** Detach all listeners and cancel any pending flush. */
  dispose() {
    for (const { el, handler } of this._listeners) {
      el.removeEventListener('input', handler);
    }
    this._listeners = [];
    if (this._rafId !== null && globalThis.cancelAnimationFrame) {
      globalThis.cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
    this._pending.clear();
  }
}

export { SLIDER_BINDINGS };
export default SliderUI;
