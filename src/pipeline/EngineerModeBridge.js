/**
 * VoiceIsolate Pro — Engineer Mode ↔ Live-Mix Bridge (Layer 3: Pipeline)
 *
 * The legacy Engineer Mode has a defined Live-Mix subset flagged `rt:true`
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
 * Separation → Isolation workflow (Stem-Split & Live-Mix):
 *   1. Process once → clean + noise stems (ML separation)
 *   2. loadStems(clean, noise) into PlaybackMixer
 *   3. Isolation refinements (voiceIso, bgSuppress, gate, EQ…) are Live-Mix
 *      gains only — no second ML pass. voiceIso → cleanGain; bgSuppress →
 *      noiseGain attenuation. Extreme/whisper spectral params still apply on
 *      the next offline Process when needed.
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
  gateLookahead: (m, v) => m.setGateLookahead(v),

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
  hpQ: (m, v) => m.setHighpassQ(v),
  lpFreq: (m, v) => m.setLowpass(v),
  lpQ: (m, v) => m.setLowpassQ(v),

  // ── De-esser (UI amount is 0–24 dB → 0–100%) ───────────────────────────
  deEssFreq: (m, v) => m.setDeEsserFreq(v),
  deEssAmt: (m, v) => m.setDeEsserAmount((v / 24) * 100),

  // ── Tone / output ───────────────────────────────────────────────────────
  specTilt: (m, v) => m.setSpectralTilt(v),
  outGain: (m, v) => m.setOutputGain(v),
  dryWet: (m, v) => m.setDryWet(v),
  outWidth: (m, v) => m.setStereoWidth(v),
  stereoWidth: (m, v) => m.setStereoWidth(v),

  // ── Separation → Isolation (Live-Mix stem balance; never re-runs ML) ─────
  // voiceIso: lift clean stem (0–100 UI → 70–140% gain)
  voiceIso: (m, v) => {
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 72;
    const gainPct = 70 + (pct / 100) * 70;
    m.setVoiceLevel(gainPct);
  },
  // bgSuppress: duck residual/noise stem
  bgSuppress: (m, v) => {
    const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 38;
    m.setNoiseReduction(pct);
  },
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
    this._hasNoiseStem = false;
  }

  /** Slider ids this bridge can drive in real time. */
  static supportedIds() { return Object.keys(PARAM_MAP); }

  /** True when this bridge handles the given slider id. */
  static handles(id) { return Object.prototype.hasOwnProperty.call(PARAM_MAP, id); }

  /**
   * Load a decoded AudioBuffer as the live-mix source. Channels are copied out
   * as Float32Arrays (so cross-context buffers are fine) and paired with a
   * silent noise stem; the mixer's clean lane carries the audio at unity.
   * Prefer {@link loadStemPair} after ML separation so isolation can duck residual.
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
      // loadStems → copyToChannel copies into the mixer's own buffer, so we can
      // hand the source channel data straight through without a second copy.
      clean.push(audioBuffer.getChannelData(ch));
      silent.push(new Float32Array(audioBuffer.length));
    }
    this.mixer.loadStems(clean, silent, audioBuffer.sampleRate);
    this._loaded = true;
    this._hasNoiseStem = false;
  }

  /**
   * Load ML separation stems for Isolation Live-Mix.
   * clean = voice stem; noise = residual/background. Isolation sliders then
   * refine the balance without re-running separation.
   * @param {Float32Array[]|AudioBuffer} clean
   * @param {Float32Array[]|AudioBuffer|null} [noise]
   * @param {number} [sampleRate]
   */
  loadStemPair(clean, noise = null, sampleRate) {
    const toChannels = (src) => {
      if (!src) return null;
      if (Array.isArray(src) && src[0] instanceof Float32Array) return src;
      if (src && typeof src.getChannelData === 'function') {
        const out = [];
        for (let c = 0; c < src.numberOfChannels; c++) out.push(src.getChannelData(c));
        return out;
      }
      if (src instanceof Float32Array) return [src];
      return null;
    };
    const cleanCh = toChannels(clean);
    if (!cleanCh?.length) {
      throw new TypeError('[VIP][EngineerModeBridge] loadStemPair requires clean stem channels.');
    }
    let noiseCh = toChannels(noise);
    if (!noiseCh?.length) {
      noiseCh = cleanCh.map((ch) => new Float32Array(ch.length));
      this._hasNoiseStem = false;
    } else {
      // Match lengths
      const n = cleanCh[0].length;
      noiseCh = noiseCh.map((ch) => {
        if (ch.length === n) return ch;
        const fixed = new Float32Array(n);
        fixed.set(ch.subarray(0, Math.min(ch.length, n)));
        return fixed;
      });
      while (noiseCh.length < cleanCh.length) {
        noiseCh.push(new Float32Array(n));
      }
      this._hasNoiseStem = true;
    }
    const sr = sampleRate
      || (clean && clean.sampleRate)
      || (noise && noise.sampleRate)
      || 48000;
    this.mixer.loadStems(cleanCh, noiseCh, sr);
    this._loaded = true;
  }

  /** True when a real residual/noise stem was loaded (vs silent placeholder). */
  hasNoiseStem() {
    return !!this._hasNoiseStem;
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
    if (!this.mixer) return false;
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

  // ── Transport (delegated to the mixer; no-op safe defaults after dispose) ──
  play() { return this.mixer ? this.mixer.play() : undefined; }
  pause() { return this.mixer ? this.mixer.pause() : undefined; }
  stop() { return this.mixer ? this.mixer.stop() : undefined; }
  seek(seconds) { return this.mixer ? this.mixer.seek(seconds) : undefined; }
  isPlaying() { return this.mixer ? this.mixer.isPlaying() : false; }
  currentTime() { return this.mixer ? this.mixer.currentTime() : 0; }
  duration() { return this.mixer ? this.mixer.duration() : 0; }
  getAnalyser() { return this.mixer ? this.mixer.getAnalyser() : null; }

  /** @returns {Promise<void>} resolves when playback worklets load or bypass */
  workletsReady() {
    return this.mixer?.workletsReady?.() || Promise.resolve();
  }

  /** Snapshot for cockpit pills / debug menu. */
  getWorkletStatus() {
    return this.mixer?.getWorkletStatus?.() || {
      gate: { state: 'pending', node: false },
      deEsser: { state: 'pending', node: false },
    };
  }
  setLoop(on) { return this.mixer ? this.mixer.setLoop(on) : undefined; }
  isLoopEnabled() { return this.mixer ? this.mixer.isLoopEnabled() : false; }
  setCropRegion(inSec, outSec) { return this.mixer ? this.mixer.setCropRegion(inSec, outSec) : undefined; }
  getCropRegion() { return this.mixer ? this.mixer.getCropRegion() : { in: 0, out: 0 }; }
  hasCrop() { return this.mixer ? this.mixer.hasCrop() : false; }
  clearCrop() { return this.mixer ? this.mixer.clearCrop() : undefined; }
  markCropIn(at) { return this.mixer ? this.mixer.markCropIn(at) : undefined; }
  markCropOut(at) { return this.mixer ? this.mixer.markCropOut(at) : undefined; }

  /** Release the underlying mixer and its AudioContext. Idempotent. */
  async dispose() {
    this._loaded = false;
    // Null the reference synchronously before awaiting so a concurrent
    // dispose()/transport call can't touch a mixer mid-teardown.
    const mixer = this.mixer;
    if (mixer) {
      this.mixer = null;
      await mixer.dispose();
    }
  }
}

export { PARAM_MAP };
export default EngineerModeBridge;
