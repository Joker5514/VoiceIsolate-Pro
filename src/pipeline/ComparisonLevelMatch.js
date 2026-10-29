import { measureAudioBuffer, reviewGains } from './AudioReview.js';

/**
 * Level matching for the instant A/B comparison (Layer 3).
 *
 * The comparison itself is playback-only: PlaybackMixer plays the original as
 * a sample-aligned lane beside the Live-Mix graph and switches with a short
 * gain crossfade. This class only measures, in the background, how loud each
 * side is so the louder one can be trimmed down (RMS, attenuation only, with a
 * common peak ceiling — see core/AudioReview.reviewGains). Switching never
 * waits on it: until a match lands the lanes play at unity.
 */
export class ComparisonLevelMatcher {
  /** @param {import('./PlaybackMixer.js').PlaybackMixer} mixer */
  constructor(mixer) {
    this.mixer = mixer;
    /** @type {AudioBuffer|null} */ this._originalFor = null;
    this._originalStats = null;
  }

  /**
   * Render the current mix offline (exactly what the processed lane plays),
   * measure both sides off the main thread and return lane trims.
   * @param {AudioBuffer} original the mixer's comparison reference
   * @param {{ signal?: AbortSignal }} [opts]
   * @returns {Promise<{ original: number, cleaned: number, matched: boolean }>}
   */
  async match(original, { signal } = {}) {
    if (!original) throw new Error('Process a recording before comparing.');
    const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    // Both lanes pass through Master Volume live, but the render already
    // includes it; scale the original's stats by the same volume so the
    // comparison is like-for-like at any volume setting.
    const master = this.mixer.masterGain?.gain;
    const volume = master ? (this.mixer._parameterTargets?.get(master) ?? master.value) : 1;
    const cleaned = await this.mixer.renderMix({ signal });
    if (signal?.aborted) throw cancelled();
    // The original is immutable: measure it once per reference.
    if (this._originalFor !== original || !this._originalStats) {
      const stats = await measureAudioBuffer(original, { signal });
      this._originalFor = original;
      this._originalStats = stats;
    }
    const b = await measureAudioBuffer(cleaned, { signal });
    if (signal?.aborted) throw cancelled();
    const a = this._originalStats;
    const v = Number.isFinite(volume) && volume > 0 ? volume : 1;
    return reviewGains({ ...a, rms: a.rms * v, peak: a.peak * v }, b);
  }
}
