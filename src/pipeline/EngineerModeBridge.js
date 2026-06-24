/**
 * EngineerModeBridge
 *
 * Maps rt:true slider IDs from the VoiceIsolate Pro SLIDER_REGISTRY
 * to live AudioParam setters on a PlaybackMixer (Web Audio API).
 *
 * All AudioParam updates use setTargetAtTime with a 0.02s time constant
 * for smooth, click-free transitions.
 */

// ---------------------------------------------------------------------------
// 50 real-time slider IDs
// ---------------------------------------------------------------------------
const RT_IDS = new Set([
  // Stem gains (dB)
  'stemVocal',
  'stemDrums',
  'stemBass',
  'stemOther',
  // Vocal EQ
  'vocalEqLowFreq',
  'vocalEqLowGain',
  'vocalEqMidFreq',
  'vocalEqMidGain',
  'vocalEqMidQ',
  'vocalEqHighFreq',
  'vocalEqHighGain',
  'vocalEqHighShelfQ',
  // Drums EQ
  'drumsEqLowGain',
  'drumsEqMidFreq',
  'drumsEqMidGain',
  // Drums Compressor
  'drumsCompressThreshold',
  'drumsCompressRatio',
  'drumsCompressAttack',
  // Bass EQ
  'bassEqLowFreq',
  'bassEqLowGain',
  'bassEqMidFreq',
  'bassEqMidGain',
  // Bass Compressor
  'bassCompressThreshold',
  'bassCompressRatio',
  // Other EQ
  'otherEqMidFreq',
  'otherEqMidGain',
  'otherEqHighFreq',
  'otherEqHighGain',
  // Other Compressor
  'otherCompressThreshold',
  'otherCompressRatio',
  // De-esser
  'vocalDeessFreq',
  'vocalDeessThreshold',
  'vocalDeessReduction',
  // Reverb
  'vocalReverbMix',
  'vocalReverbDecay',
  'vocalReverbPreDelay',
  // Master
  'masterGain',
  'masterPan',
  'masterStereoWidth',
  'masterLimiterThreshold',
  'masterLimiterCeiling',
  'masterLimiterRelease',
  // Delay
  'delayTime',
  'delayFeedback',
  'delayMix',
  'delayFilter',
  // Gate
  'gateThreshold',
  'gateAttack',
  'gateRelease',
  'gateHold',
]);

/**
 * Helper: convert dB value to linear gain.
 * @param {number} dB
 * @returns {number}
 */
function dbToLinear(dB) {
  return Math.pow(10, dB / 20);
}

// ---------------------------------------------------------------------------
// EngineerModeBridge
// ---------------------------------------------------------------------------

class EngineerModeBridge {
  /**
   * @param {object} mixer - PlaybackMixer instance with the following nodes:
   *
   *   mixer.stemGains.vocal  → GainNode
   *   mixer.stemGains.drums  → GainNode
   *   mixer.stemGains.bass   → GainNode
   *   mixer.stemGains.other  → GainNode
   *
   *   mixer.vocalEQ.low      → BiquadFilterNode (lowshelf)
   *   mixer.vocalEQ.mid      → BiquadFilterNode (peaking)
   *   mixer.vocalEQ.high     → BiquadFilterNode (highshelf)
   *
   *   mixer.drumsEQ.low      → BiquadFilterNode (lowshelf)
   *   mixer.drumsEQ.mid      → BiquadFilterNode (peaking)
   *
   *   mixer.bassEQ.low       → BiquadFilterNode (lowshelf)
   *   mixer.bassEQ.mid       → BiquadFilterNode (peaking)
   *
   *   mixer.otherEQ.mid      → BiquadFilterNode (peaking)
   *   mixer.otherEQ.high     → BiquadFilterNode (highshelf)
   *
   *   mixer.drumsComp        → DynamicsCompressorNode
   *   mixer.bassComp         → DynamicsCompressorNode
   *   mixer.otherComp        → DynamicsCompressorNode
   *
   *   mixer.deEsser          → BiquadFilterNode (peaking, used as de-esser)
   *                             Extended with .threshold AudioParam for
   *                             de-esser sensitivity control.
   *
   *   mixer.reverb           → { mix: GainNode,
   *                               convolver: ConvolverNode }
   *
   *   mixer.master           → { gain: GainNode,
   *                               pan: StereoPannerNode,
   *                               width: StereoPannerNode,
   *                               limiter: DynamicsCompressorNode }
   *
   *   mixer.delay            → { delayNode: DelayNode,
   *                               feedback: GainNode,
   *                               mix: GainNode,
   *                               filter: BiquadFilterNode (lowpass) }
   *
   *   mixer.gate             → { threshold: AudioParam,
   *                               attack: AudioParam,
   *                               release: AudioParam,
   *                               hold: AudioParam }
   */
  constructor(mixer) {
    this._mixer = mixer;
    this._ctx = mixer.context; // AudioContext
    this._now = () => this._ctx.currentTime;

    // Cached reverb parameters that require convolver recreation
    this._pendingReverbDecay = null;
    this._pendingReverbPreDelay = null;
  }

  /**
   * Returns true if the bridge can handle this slider ID in real-time.
   * @param {string} id
   * @returns {boolean}
   */
  static handles(id) {
    return RT_IDS.has(id);
  }

  /**
   * Apply a slider value to the corresponding AudioParam.
   *
   * Uses setTargetAtTime with timeConstant 0.02 s for smooth,
   * click-free transitions on every update.
   *
   * @param {string} id    - slider ID from SLIDER_REGISTRY
   * @param {number} value - current slider value (units depend on the slider)
   */
  apply(id, value) {
    const t = this._now();
    const TC = 0.02; // time constant in seconds
    const m = this._mixer;

    switch (id) {
      // ===================================================================
      //  Stem Gains  (value in dB → linear)
      // ===================================================================
      case 'stemVocal':
        m.stemGains.vocal.gain.setTargetAtTime(dbToLinear(value), t, TC);
        break;
      case 'stemDrums':
        m.stemGains.drums.gain.setTargetAtTime(dbToLinear(value), t, TC);
        break;
      case 'stemBass':
        m.stemGains.bass.gain.setTargetAtTime(dbToLinear(value), t, TC);
        break;
      case 'stemOther':
        m.stemGains.other.gain.setTargetAtTime(dbToLinear(value), t, TC);
        break;

      // ===================================================================
      //  Vocal EQ
      // ===================================================================
      case 'vocalEqLowFreq':
        m.vocalEQ.low.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqLowGain':
        m.vocalEQ.low.gain.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqMidFreq':
        m.vocalEQ.mid.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqMidGain':
        m.vocalEQ.mid.gain.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqMidQ':
        m.vocalEQ.mid.Q.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqHighFreq':
        m.vocalEQ.high.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqHighGain':
        m.vocalEQ.high.gain.setTargetAtTime(value, t, TC);
        break;
      case 'vocalEqHighShelfQ':
        m.vocalEQ.high.Q.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Drums EQ
      // ===================================================================
      case 'drumsEqLowGain':
        m.drumsEQ.low.gain.setTargetAtTime(value, t, TC);
        break;
      case 'drumsEqMidFreq':
        m.drumsEQ.mid.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'drumsEqMidGain':
        m.drumsEQ.mid.gain.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Drums Compressor
      // ===================================================================
      case 'drumsCompressThreshold':
        m.drumsComp.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'drumsCompressRatio':
        m.drumsComp.ratio.setTargetAtTime(value, t, TC);
        break;
      case 'drumsCompressAttack':
        // value is in ms → convert to seconds
        m.drumsComp.attack.setTargetAtTime(value / 1000, t, TC);
        break;

      // ===================================================================
      //  Bass EQ
      // ===================================================================
      case 'bassEqLowFreq':
        m.bassEQ.low.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'bassEqLowGain':
        m.bassEQ.low.gain.setTargetAtTime(value, t, TC);
        break;
      case 'bassEqMidFreq':
        m.bassEQ.mid.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'bassEqMidGain':
        m.bassEQ.mid.gain.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Bass Compressor
      // ===================================================================
      case 'bassCompressThreshold':
        m.bassComp.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'bassCompressRatio':
        m.bassComp.ratio.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Other EQ
      // ===================================================================
      case 'otherEqMidFreq':
        m.otherEQ.mid.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'otherEqMidGain':
        m.otherEQ.mid.gain.setTargetAtTime(value, t, TC);
        break;
      case 'otherEqHighFreq':
        m.otherEQ.high.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'otherEqHighGain':
        m.otherEQ.high.gain.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Other Compressor
      // ===================================================================
      case 'otherCompressThreshold':
        m.otherComp.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'otherCompressRatio':
        m.otherComp.ratio.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  De-esser
      //  frequency  → peaking filter center frequency
      //  threshold  → de-esser sensitivity (AudioParam on extended node)
      //  reduction  → peaking filter gain (negative dB = more reduction)
      // ===================================================================
      case 'vocalDeessFreq':
        m.deEsser.frequency.setTargetAtTime(value, t, TC);
        break;
      case 'vocalDeessThreshold':
        m.deEsser.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'vocalDeessReduction':
        m.deEsser.gain.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Reverb
      //  mix       → 0-100 % mapped to 0-1.0 gain on the wet send
      //  decay     → stored for later convolver impulse recreation
      //  preDelay  → stored for later convolver impulse recreation
      // ===================================================================
      case 'vocalReverbMix':
        m.reverb.mix.gain.setTargetAtTime(value / 100, t, TC);
        break;
      case 'vocalReverbDecay':
        this._pendingReverbDecay = value;
        // Full reverb update requires convolver impulse recreation.
        // The value is cached and can be consumed by a separate
        // rebuildReverbImpulse() call when the user releases the slider.
        break;
      case 'vocalReverbPreDelay':
        this._pendingReverbPreDelay = value;
        // Full reverb update requires convolver impulse recreation.
        // The value is cached and can be consumed by a separate
        // rebuildReverbImpulse() call when the user releases the slider.
        break;

      // ===================================================================
      //  Master
      //  gain     → dB to linear on master GainNode
      //  pan      → -1…1 on StereoPannerNode
      //  width    → 0-200 % mapped to 0-2.0 on width node's pan param
      //  limiter  → threshold, ceiling, release on DynamicsCompressorNode
      // ===================================================================
      case 'masterGain':
        m.master.gain.gain.setTargetAtTime(dbToLinear(value), t, TC);
        break;
      case 'masterPan':
        m.master.pan.pan.setTargetAtTime(value, t, TC);
        break;
      case 'masterStereoWidth':
        // 0-200 % → 0-2.0
        m.master.width.pan.setTargetAtTime(value / 100, t, TC);
        break;
      case 'masterLimiterThreshold':
        m.master.limiter.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'masterLimiterCeiling':
        m.master.limiter.ceiling.setTargetAtTime(value, t, TC);
        break;
      case 'masterLimiterRelease':
        // value is in ms → convert to seconds
        m.master.limiter.release.setTargetAtTime(value / 1000, t, TC);
        break;

      // ===================================================================
      //  Delay
      //  time    → ms converted to seconds on DelayNode.delayTime
      //  feedback→ 0-95 % mapped to 0-0.95 on feedback GainNode.gain
      //  mix     → 0-100 % mapped to 0-1.0 on mix GainNode.gain
      //  filter  → frequency on lowpass BiquadFilterNode
      // ===================================================================
      case 'delayTime':
        m.delay.delayNode.delayTime.setTargetAtTime(value / 1000, t, TC);
        break;
      case 'delayFeedback':
        m.delay.feedback.gain.setTargetAtTime(value / 100, t, TC);
        break;
      case 'delayMix':
        m.delay.mix.gain.setTargetAtTime(value / 100, t, TC);
        break;
      case 'delayFilter':
        m.delay.filter.frequency.setTargetAtTime(value, t, TC);
        break;

      // ===================================================================
      //  Gate
      //  All time-based params (attack, release, hold) are in ms and
      //  converted to seconds.  Threshold is in dB.
      // ===================================================================
      case 'gateThreshold':
        m.gate.threshold.setTargetAtTime(value, t, TC);
        break;
      case 'gateAttack':
        m.gate.attack.setTargetAtTime(value / 1000, t, TC);
        break;
      case 'gateRelease':
        m.gate.release.setTargetAtTime(value / 1000, t, TC);
        break;
      case 'gateHold':
        m.gate.hold.setTargetAtTime(value / 1000, t, TC);
        break;

      // ===================================================================
      //  Unknown / not handled at runtime
      // ===================================================================
      default:
        // This should never happen if callers check handles() first.
        console.warn(`[EngineerModeBridge] No real-time mapping for slider "${id}"`);
        break;
    }
  }

  // -----------------------------------------------------------------------
  //  Public helpers
  // -----------------------------------------------------------------------

  /**
   * Returns the cached reverb decay value (or null if unchanged).
   * @returns {number|null}
   */
  get pendingReverbDecay() {
    return this._pendingReverbDecay;
  }

  /**
   * Returns the cached reverb pre-delay value (or null if unchanged).
   * @returns {number|null}
   */
  get pendingReverbPreDelay() {
    return this._pendingReverbPreDelay;
  }

  /**
   * Clears the cached reverb parameters.  Call this after consuming
   * them in a convolver impulse-recreation pass.
   */
  clearPendingReverb() {
    this._pendingReverbDecay = null;
    this._pendingReverbPreDelay = null;
  }
}

export default EngineerModeBridge;