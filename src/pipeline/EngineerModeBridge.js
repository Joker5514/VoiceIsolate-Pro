/**
 * VoiceIsolate Pro — Engineer Mode ↔ Live-Mix Bridge (Layer 3: Pipeline)
 *
 * The legacy Engineer Mode (`public/app/`) has 34 sliders flagged `rt:true`
 * that were meant to apply in real time. Their old real-time path ran through
 * the `PipelineOrchestrator`, which was deliberately deleted with the live-mic
 * pipeline (CLAUDE.md §1.1 / §5). With it gone, those sliders only took effect
 * on a full offline "Reprocess".
 *
 * This bridge restores genuine real-time behaviour the *sanctioned* way: it
 * plays the loaded audio through a {@link PlaybackMixer} (the Stem-Split &
 * Live-Mix engine) and maps each legacy slider id onto a live AudioParam
 * setter. It NEVER re-runs ML, NEVER touches a microphone, and NEVER revives
 * the SharedArrayBuffer transport — it is pure Web Audio, exactly like the
 * modern `/` UI.
 *
 * A single decoded buffer (the processed output, or the original) is loaded as
 * the mixer's "clean" stem with a silent "noise" stem, so the whole Tier-A bus
 * (gate, 10-band graphic EQ, tilt, compressor, limiter, de-esser, width,
 * dry/wet, output trim) acts on it in real time.
 */
'use strict';

import { PlaybackMixer } from './PlaybackMixer.js';

/**
 * Legacy Engineer Mode slider id → PlaybackMixer real-time control.
 * Each entry is `(mixer, value) => void`, including any unit conversion needed
 * to match the legacy slider's range to the mixer setter's contract.
 */
const PARAM_MAP = Object.freeze({
  // ── Noise gate ──────────────────────────────────────────────────────────
  gateThresh: (m, v) => m.setGateThreshold(v),
  // Legacy "range" is the floor in dBFS (e.g. −60); the mixer wants attenuation
  // depth in dB (0 = off). Depth = −floor.
  gateRange: (m, v) => m.setGateRange(-v),
  gateAttack: (m, v) => m.setGateAttack(v),
  gateRelease: (m, v) => m.setGateRelease(v),
  gateHold: (m, v) => m.setGateHold(v),

  // ── 10-band graphic EQ (dB) ─────────────────────────────────────────────
  eqSub: (m, v) => m.setGraphicEq('sub', v),
  eqBass: (m, v) => m.setGraphicEq('bass', v),
  eqWarmth: (m, v) => m.setGraphicEq('warmth', v),
  eqBody: (m, v) => m.setGraphicEq('body', v),
  eqLowMid: (m, v) => m.setGraphicEq('lowMid', v),
  eqMid: (m, v) => m.setGraphicEq('mid', v),
  eqPresence: (m, v) => m.setGraphicEq('presence', v),
  eqClarity: (m, v) => m.setGraphicEq('clarity', v),
  eqAir: (m, v) => m.setGraphicEq('air', v),
  eqBrill: (m, v) => m.setGraphicEq('brilliance', v),

  // ── Compressor ──────────────────────────────────────────────────────────
  compThresh: (m, v) => m.setCompThreshold(v),
  compRatio: (m, v) => m.setCompRatio(v),
  compAttack: (m, v) => m.setCompAttack(v),
  compRelease: (m, v) => m.setCompRelease(v),
  compKnee: (m, v) => m.setCompKnee(v),
  compMakeup: (m, v) => m.setMakeupGain(v),

  // ── Brick-wall limiter ──────────────────────────────────────────────────
  limThresh: (m, v) => m.setLimiterThreshold(v),
  limRelease: (m, v) => m.setLimiterRelease(v),

  // ── HP / LP filters ─────────────────────────────────────────────────────
  hpFreq: (m, v) => m.setHighpass(v),
  lpFreq: (m, v) => m.setLowpass(v),

  // ── De-esser (legacy amount is 0–30 dB → 0–100%) ────────────────────────
  deEssFreq: (m, v) => m.setDeEsserFreq(v),
  deEssAmt: (m, v) => m.setDeEsserAmount((v / 30) * 100),

  // ── Tone / output ───────────────────────────────────────────────────────
  specTilt: (m, v) => m.setSpectralTilt(v),
  outGain: (m, v) => m.setOutputGain(v),
  dryWet: (m, v) => m.setDryWet(v),
  outWidth: (m, v) => m.setStereoWidth(v),
  stereoWidth: (m, v) => m.setStereoWidth(v),
});

export class EngineerModeBridge {
  /**
   * @param {object} [options]
   * @param {PlaybackMixer} [options.mixer]  injectable for tests
   * @param {AudioContext}  [options.context] forwarded to a new PlaybackMixer
   */
  constructor(options = {}) {
    this.mixer = options.mixer || new PlaybackMixer({ context: options.context });
    this._loaded = false;
  }

  /** Slider ids this bridge can drive in real time. */
  static supportedIds() { return Object.keys(PARAM_MAP); }

  /** True when this bridge handles the given slider id. */
  static handles(id) { return Object.prototype.hasOwnProperty.call(PARAM_MAP, id); }

  /**
   * Load a decoded AudioBuffer as the live-mix source. Channels are copied out
   * as Float32Arrays (so cross-context buffers are fine) and paired with a
   * silent noise stem; the mixer's clean lane carries the audio at unity.
   * @param {AudioBuffer} audioBuffer
   */
  loadBuffer(audioBuffer) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new TypeError('[VIP][EngineerModeBridge] loadBuffer requires an AudioBuffer.');
    }
    const channelCount = audioBuffer.numberOfChannels;
    const clean = [];
    const silent = [];
    for (let ch = 0; ch < channelCount; ch++) {
      clean.push(new Float32Array(audioBuffer.getChannelData(ch)));
      silent.push(new Float32Array(audioBuffer.length));
    }
    this.mixer.loadStems(clean, silent, audioBuffer.sampleRate);
    this._loaded = true;
  }

  /** Whether a buffer is loaded and ready to play. */
  isLoaded() { return this._loaded; }

  /**
   * Apply one legacy slider in real time. Unknown / unsupported ids (worker
   * params, stubs like hpQ/ditherAmt) are silently ignored so callers can pass
   * the whole slider stream without filtering.
   * @param {string} id
   * @param {number} value
   * @returns {boolean} true if the id mapped to a control
   */
  applyParam(id, value) {
    const apply = PARAM_MAP[id];
    if (!apply) return false;
    const v = Number(value);
    if (!Number.isFinite(v)) return false;
    apply(this.mixer, v);
    return true;
  }

  /**
   * Apply a whole map of slider id → value (e.g. on load or preset change).
   * @param {Record<string, number>} params
   */
  applyParams(params) {
    if (!params) return;
    for (const id of Object.keys(params)) this.applyParam(id, params[id]);
  }

  // ── Transport (delegated straight to the mixer) ──────────────────────────
  play() { return this.mixer.play(); }
  pause() { return this.mixer.pause(); }
  stop() { return this.mixer.stop(); }
  seek(seconds) { return this.mixer.seek(seconds); }
  isPlaying() { return this.mixer.isPlaying(); }
  currentTime() { return this.mixer.currentTime(); }
  duration() { return this.mixer.duration(); }
  getAnalyser() { return this.mixer.getAnalyser(); }

  /** Release the underlying mixer and its AudioContext. */
  async dispose() {
    this._loaded = false;
    await this.mixer.dispose();
  }
}

export { PARAM_MAP };
export default EngineerModeBridge;
