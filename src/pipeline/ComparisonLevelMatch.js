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
 *
 * The match measures a BOUNDED excerpt, never the whole file. It runs after
 * every slider move (debounced, once edits settle), so a full-file render
 * froze the tab for seconds on long recordings: renderMix() renders the
 * entire file offline and then runs synchronous full-buffer true-peak scans
 * on the main thread (measureTruePeak is ~3.4 s at 25M frames). A 30 s
 * excerpt is ample for a stable RMS/peak ratio — both lanes are measured
 * over the same fixed window, so the ratio is like-for-like — and it cuts
 * the per-move synchronous true-peak scan from multi-second (3.4–11 s
 * measured at 25M frames, content- and load-dependent) to well under a
 * second. Short files (< 30 s) still measure in full, exactly as before.
 */
export const LEVEL_MATCH_EXCERPT_SEC = 30;
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
    // Bounded excerpt window (see header): the match runs after every slider
    // move, so the measured window must not scale with file length.
    const endSec = Math.min(
      LEVEL_MATCH_EXCERPT_SEC,
      Number.isFinite(original.duration) ? original.duration : LEVEL_MATCH_EXCERPT_SEC,
    );
    // Both lanes pass through Master Volume live, but the render already
    // includes it; scale the original's stats by the same volume so the
    // comparison is like-for-like at any volume setting.
    const master = this.mixer.masterGain?.gain;
    const volume = master ? (this.mixer._parameterTargets?.get(master) ?? master.value) : 1;
    const cleaned = await this.mixer.renderMix({ signal, startSec: 0, endSec });
    if (signal?.aborted) throw cancelled();
    // The original is immutable: measure it once per reference. Both sides
    // are measured over the same fixed excerpt window, so the ratio stays
    // like-for-like; the cached stats remain valid because the window is
    // fixed per reference.
    if (this._originalFor !== original || !this._originalStats) {
      const stats = await measureAudioBuffer(original, { signal, startSec: 0, endSec });
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
