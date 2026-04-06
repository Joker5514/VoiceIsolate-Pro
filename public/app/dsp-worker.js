/* ============================================
   VoiceIsolate Pro v22.1 — DSP Worker
   Threads from Space v11 · 35-Stage Pipeline
   Deca-Pass Offline Processing · Full Quality
   Adaptive Wiener · DNS v2 · Multi-Speaker
   FIX: Issue #15 — updated from v20.0/v10 to v22.1/v11
   ============================================ */

'use strict';

importScripts('dsp-core.js');

const DSP = self.DSPCore;
const AdaptiveNoiseFloor = self.AdaptiveNoiseFloor;
const SR = 48000;

/**
 * Offline 35-stage Deca-Pass pipeline worker.
 * Receives Float32Array audio + param state, processes all stages,
 * returns processed buffer via Transferable (zero-copy).
 */

// ML Worker reference for model inference
let mlPort = null;
let mlCallId = 0;
const mlPending = new Map();

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'process':
      await runPipeline(msg);
      break;

    case 'setMLPort':
      mlPort = e.ports?.[0] || null;
      if (mlPort) {
        mlPort.onmessage = (me) => {
          const res = me.data;
          const pending = mlPending.get(res.id);
          if (pending) {
            mlPending.delete(res.id);
            pending.resolve(res);
          }
        };
      }
      break;

    case 'abort':
      // Signal abort (handled by checking flag in pipeline)
      self._aborted = true;
      break;
  }
};

function progress(stage, pct, label) {
  self.postMessage({ type: 'progress', stage, pct, label });
}

function callML(type, data, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!mlPort) {
      resolve({ type: 'error', msg: 'ML Worker unavailable' });
      return;
    }
    const id = ++mlCallId;
    const timeout = setTimeout(() => {
      mlPending.delete(id);
      resolve({ type: 'error', msg: 'ML timeout' });
    }, 30000);

    mlPending.set(id, {
      resolve: (res) => { clearTimeout(timeout); resolve(res); },
      reject
    });

    if (data instanceof Float32Array) {
      mlPort.postMessage({ type, id, data, ...extra }, [data.buffer]);
    } else {
      mlPort.postMessage({ type, id, data, ...extra });
    }
  });
}

async function runPipeline(msg) {
  let adaptiveNoiseFloorTracker = null;
  if (msg.params.adaptiveWienerEnabled !== false && typeof AdaptiveNoiseFloor !== 'undefined') {
    adaptiveNoiseFloorTracker = new AdaptiveNoiseFloor(
      msg.params.fftSize ? msg.params.fftSize / 2 : 2048,
      msg.params.adaptiveWienerSmoothingMs || 200,
      msg.params.hopSize || 1024,
      msg.sampleRate || SR
    );
  }
  self._aborted = false;
  const params = msg.params;
  const sr = msg.sampleRate || SR;
  let data = new Float32Array(msg.data);
  let frameCount = 0;

  try {
    // ===== PASS 1: INPUT CONDITIONING (S01–S04) =====
    progress(1, 0, 'Input Conditioning');

    // S01: Already decoded (received as Float32Array at target SR)
    // S02: Channel normalization (mono — handled by caller)
    progress(2, 2, 'Channel Normalized');

    // S03: DC offset removal
    data = DSP.removeDCOffset(data, sr);
    progress(3, 5, 'DC Offset Removed');

    // S04: Pre-gain & headroom
    data = DSP.peakNormalize(data, -3);
    progress(4, 8, 'Normalized to -3dBFS');

    if (self._aborted) return abort();

    // ===== PASS 2: TIME-DOMAIN CLEANUP (S05–S08) =====
    progress(5, 10, 'Noise Gate');

    // S05: Noise Gate
    data = DSP.noiseGate(data, {
      threshold: params.gateThresh ?? -42,
      range: params.gateRange ?? -40,
      attack: params.gateAttack ?? 2,
      release: params.gateRelease ?? 80,
      hold: params.gateHold ?? 20,
      lookahead: params.gateLookahead ?? 5
    }, sr);
    progress(5, 15, 'Noise Gate Applied');

    // S06: Hum removal
    DSP.cascadedNotch(data, [60, 120, 180, 240], 10, sr);
    progress(6, 18, 'Hum Removed');

    // S07: Click/pop removal
    DSP.removeClicks(data);
    progress(7, 20, 'Clicks Removed');

    // S08: De-essing
    const deEssFreq = params.deEssFreq ?? 7000;
    const deEssAmt = params.deEssAmt ?? 30;
    DSP.deEss(data, deEssFreq, deEssAmt, sr);
    progress(8, 22, 'De-Essed');

    if (self._aborted) return abort();

    // Fire VAD early (async) so it overlaps with STFT computation.
    // VAD result is awaited at S11 after the transform is complete.
    let vadConfidence = null;
    const vadData = new Float32Array(data);
    const vadPromise = callML('vad', vadData, { sampleRate: sr });

    // ===== PASS 3: FORWARD TRANSFORM (S09–S10) =====
    progress(9, 25, 'Forward STFT');

    const fftSize = 4096;
    const hopSize = 1024;
    const { mag, phase, frameCount: fc } = DSP.forwardSTFT(data, fftSize, hopSize);
    frameCount = fc;
    progress(10, 30, `STFT: ${frameCount} frames`);

    if (self._aborted) return abort();

    // ===== PASS 4: ML / SPECTRAL ANALYSIS (S11–S14) =====
    // All ML operations run in spectral domain on `mag`, preserving single-pass STFT.

    // S11: Silero VAD — await the result fired before STFT
    progress(11, 32, 'VAD Analysis');
    const vadResult = await vadPromise;
    if (vadResult.confidence) {
      vadConfidence = vadResult.confidence;
    }
    progress(11, 34, 'VAD Complete');

    // S12: ML voice isolation — spectral mask applied directly to mag frames
    progress(12, 36, 'ML Separation A');
    const voiceIso = params.voiceIso ?? 70;
    if (voiceIso > 0) {
      const dns2Stride = 8; // apply mask every 8 frames (~46 ms at hopSize=1024, sr=48000)
      let lastSepMask = null;
      const halfN = mag[0] ? mag[0].length : 0;

      for (let f = 0; f < frameCount; f++) {
        if (f % dns2Stride === 0) {
          const magFrame = _buildDNS2Frame(mag, f, sr, fftSize);
          // Pass magnitude in `extra` so handleDNS2 receives msg.magnitude correctly
          const sepResult = await callML('dns2', null, { magnitude: magFrame });
          if (sepResult.mask) lastSepMask = new Float32Array(sepResult.mask);
        }
        if (lastSepMask && halfN > 0) {
          const isoStrength = voiceIso / 100;
          for (let k = 0; k < halfN; k++) {
            const maskIdx = Math.min(k, lastSepMask.length - 1);
            // Blend: (1 - iso) * passthrough + iso * mask_gain
            const gain = 1 - isoStrength + isoStrength * Math.max(0, Math.min(1, lastSepMask[maskIdx]));
            mag[f][k] *= gain;
          }
        }
      }
    }

    // S13: Multi-speaker spectral separation
    progress(13, 40, 'ML Separation B');
    const multiSpeakerEnabled = params.multiSpeakerEnabled ?? false;
    const separationMode = params.separationMode ?? 'off';
    if (multiSpeakerEnabled && separationMode !== 'off') {
      const msStride = 16;
      let msMask = null;
      const halfN = mag[0] ? mag[0].length : 0;
      const attLin = Math.pow(10, (params.separationAttenuationDb ?? -24) / 20);

      for (let f = 0; f < frameCount; f++) {
        if (f % msStride === 0) {
          const magFrame = _buildDNS2Frame(mag, f, sr, fftSize);
          const msResult = await callML('dns2', null, { magnitude: magFrame });
          if (msResult.mask) msMask = new Float32Array(msResult.mask);
        }
        if (msMask && halfN > 0) {
          for (let k = 0; k < halfN; k++) {
            const maskIdx = Math.min(k, msMask.length - 1);
            const voiceGain = Math.max(0, Math.min(1, msMask[maskIdx]));
            // Boost target voice bins, attenuate background
            mag[f][k] *= voiceGain + (1 - voiceGain) * attLin;
          }
        }
      }
    }

    progress(14, 45, 'ML Separation Complete');

    if (self._aborted) return abort();

    // ===== PASS 5: SPECTRAL OPERATIONS IN-PLACE (S15–S19) =====
    progress(15, 48, 'Spectral Operations');

    // Noise classifier: run before Wiener to inform strategy
    if (params.noiseClassifierEnabled !== false) {
      const classFeatures = _buildNoiseFeatures(mag, sr, fftSize);
      // Fire-and-forget (result forwarded to orchestrator via ML port)
      callML('classifyNoise', classFeatures, {}).catch(() => {});
      const localClass = DSP.classifyNoiseSpectral(mag, sr, fftSize);
      if (localClass.noiseClass === 'music') {
        params._effectiveOverSubtraction = (params.adaptiveWienerOverSubtraction ?? 1.2) * 1.3;
      } else {
        params._effectiveOverSubtraction = params.adaptiveWienerOverSubtraction ?? 1.2;
      }
    }

    // S15: Spectral noise subtraction (per-bin adaptive Wiener, Martin 2001)
    const adaptiveWienerEnabled = params.adaptiveWienerEnabled !== false;
    if (adaptiveWienerEnabled && AdaptiveNoiseFloor) {
      const smoothingMs = params.adaptiveWienerSmoothingMs ?? 200;
      const overSub = params._effectiveOverSubtraction ?? params.adaptiveWienerOverSubtraction ?? 1.2;
      const halfN = mag[0].length;
      const tracker = new AdaptiveNoiseFloor(halfN, smoothingMs, hopSize, sr);
      DSP.applyAdaptiveWiener(mag, vadConfidence, tracker, {
        overSubtraction: overSub,
        spectralFloor: 0.001
      });
    } else if (adaptiveNoiseFloorTracker) {
      DSP.applyAdaptiveWiener(mag, vadConfidence, adaptiveNoiseFloorTracker, {
        overSubtraction: params._effectiveOverSubtraction ?? params.adaptiveWienerOverSubtraction ?? 1.2,
        spectralFloor: 0.001
      });
    }
    progress(15, 52, 'Spectral Noise Subtracted');

    // DNS v2 per-frame mask (sliding window, every dns2Stride frames)
    if (params.dns2Enabled !== false) {
      const dns2Stride = 8;
      let lastMask = null;

      for (let f = 0; f < frameCount; f++) {
        if (f % dns2Stride === 0) {
          const dns2Input = _buildDNS2Frame(mag, f, sr, fftSize);
          const dns2Result = await callML('dns2', null, { magnitude: dns2Input });
          if (dns2Result.mask) lastMask = new Float32Array(dns2Result.mask);
        }
        if (lastMask) {
          const halfN = mag[f].length;
          for (let k = 0; k < halfN; k++) {
            const maskIdx = Math.min(k, lastMask.length - 1);
            mag[f][k] *= lastMask[maskIdx];
          }
        }
      }
    }
    progress(15, 54, 'DNS v2 Gain Mask Applied');

    // S16: 32 ERB band spectral gate
    const nrFloor = params.nrFloor ?? -60;
    DSP.spectralGate(mag, nrFloor, sr);
    progress(16, 56, 'Spectral Gate Applied');

    // S17: Harmonic enhancement
    const harmRecov = params.harmRecov ?? 20;
    if (params.harmonicV2Enabled !== false) {
      DSP.harmonicEnhanceV2(mag, phase, harmRecov, {
        sbr:               params.harmonicV2SBR !== false,
        formantProtection: params.harmonicV2FormantProtection !== false,
        breathinessGain:   params.harmonicV2BreathinessGain ?? 0.8,
        sampleRate:        sr,
        fftSize
      });
    } else {
      DSP.harmonicEnhance(mag, phase, harmRecov);
    }
    progress(17, 60, 'Harmonics Enhanced');

    // S18: Temporal smoothing
    const nrSmoothing = params.nrSmoothing ?? 35;
    DSP.temporalSmooth(mag, nrSmoothing);
    progress(18, 63, 'Temporal Smoothing Applied');

    // S19: Dereverberation
    const derevAmt = params.derevAmt ?? 40;
    const derevDecay = params.derevDecay ?? 0.5;
    DSP.dereverb(mag, derevAmt, derevDecay, sr, hopSize);
    progress(19, 66, 'Dereverberated');

    if (self._aborted) return abort();

    // ===== PASS 6: INVERSE TRANSFORM (S20–S21) =====
    progress(20, 68, 'Inverse STFT');

    data = DSP.inverseSTFT(mag, phase, fftSize, hopSize, data.length);
    progress(21, 72, 'Overlap-Add Complete');

    if (self._aborted) return abort();

    // ===== PASS 7: TIME-DOMAIN ENHANCEMENT (S22–S26) =====

    // S22: High-pass / Low-pass filtering
    progress(22, 74, 'High-Pass / Low-Pass');
    const hpLpBands = [
      { freq: params.hpFreq ?? 80,    gain: 0, Q: params.hpQ ?? 0.71,  type: 'highpass' },
      { freq: params.lpFreq ?? 14000, gain: 0, Q: params.lpQ ?? 0.71,  type: 'lowpass'  }
    ];
    DSP.parametricEQ(data, hpLpBands, sr);

    // S23: Parametric EQ (10-band)
    progress(23, 75, 'Parametric EQ');
    const eqBands = [
      { freq: 40,    gain: params.eqSub ?? -8,      Q: 0.7, type: 'peaking'    },
      { freq: 100,   gain: params.eqBass ?? 0,       Q: 1.0, type: 'peaking'    },
      { freq: 200,   gain: params.eqWarmth ?? 1,     Q: 1.4, type: 'peaking'    },
      { freq: 400,   gain: params.eqBody ?? 0,       Q: 1.4, type: 'peaking'    },
      { freq: 800,   gain: params.eqLowMid ?? -1,    Q: 1.4, type: 'peaking'    },
      { freq: 1500,  gain: params.eqMid ?? 1,        Q: 1.4, type: 'peaking'    },
      { freq: 3000,  gain: params.eqPresence ?? 3,   Q: 1.4, type: 'peaking'    },
      { freq: 5000,  gain: params.eqClarity ?? 2,    Q: 1.4, type: 'peaking'    },
      { freq: 10000, gain: params.eqAir ?? 1,        Q: 1.4, type: 'peaking'    },
      { freq: 16000, gain: params.eqBrill ?? -2,     Q: 0.7, type: 'highshelf'  }
    ];
    DSP.parametricEQ(data, eqBands, sr);

    // S24: Dynamics prep / post-EQ tone correction
    progress(24, 76, 'Dynamics Prep / Tone Control');
    const postEqBands = [
      { freq: 8000, gain: params.postEqHfTrim ?? -0.5, Q: 0.7, type: 'highshelf' }
    ];
    DSP.parametricEQ(data, postEqBands, sr);

    // S25: EQ applied (confirmation stage)
    progress(25, 78, 'EQ Applied');

    // S26: Harmonic stage — spectral processing completed at S17
    progress(26, 80, 'Harmonic Stage (spectral only — S17)');

    if (self._aborted) return abort();

    // ===== PASS 8: DYNAMICS PROCESSING (S27–S30) =====
    progress(27, 82, 'Dynamics Processing');

    // S27: Downward expander
    DSP.downwardExpand(data, -50, 1.5, sr);
    progress(27, 84, 'Expander Applied');

    // S28: Compressor
    DSP.compress(data, {
      threshold: params.compThresh ?? -24,
      ratio: params.compRatio ?? 4,
      attack: params.compAttack ?? 8,
      release: params.compRelease ?? 200,
      knee: params.compKnee ?? 6,
      makeup: params.compMakeup ?? 6
    }, sr);
    progress(28, 87, 'Compressed');

    // S29: LUFS normalization
    const lufsTarget = params.lufsTarget ?? -16;
    DSP.lufsNormalize(data, lufsTarget, sr);
    progress(29, 89, 'LUFS Normalized');

    // S30: De-clipper
    DSP.deClip(data);
    progress(30, 90, 'De-Clipped');

    if (self._aborted) return abort();

    // ===== PASS 9: OUTPUT MASTERING (S31–S34) =====

    // S31: Stereo widener — actual Haas/level-difference implementation
    progress(31, 92, 'Stereo Width');

    const outWidth = params.outWidth ?? 100;
    let stereoOut = null;

    if (outWidth !== 100) {
      const delaySamples = outWidth > 100
        ? Math.floor(((outWidth - 100) / 100) * sr * 0.018)
        : 0;

      stereoOut = new Float32Array(data.length * 2);

      for (let i = 0; i < data.length; i++) {
        const dryMono = data[i];
        const delayed = (delaySamples > 0 && i >= delaySamples)
          ? data[i - delaySamples]
          : dryMono;

        const right = outWidth >= 100
          ? delayed
          : dryMono * (outWidth / 100);

        stereoOut[i * 2]     = dryMono; // left  = dry mono
        stereoOut[i * 2 + 1] = right;   // right = widened
      }
    }

    // S32: True peak limiter
    const limCeiling = params.limThresh ?? -1;
    DSP.truePeakLimit(data, limCeiling);
    if (stereoOut) {
      const ceilLin = Math.pow(10, limCeiling / 20);
      for (let i = 0; i < data.length; i++) {
        stereoOut[i * 2]     = Math.max(-ceilLin, Math.min(ceilLin, stereoOut[i * 2]));
        stereoOut[i * 2 + 1] = Math.max(-ceilLin, Math.min(ceilLin, stereoOut[i * 2 + 1]));
      }
    }
    progress(32, 94, 'Peak Limited');

    // S33: Dither
    const ditherBits = params.bitDepth ?? 16;
    DSP.dither(data, ditherBits);
    progress(33, 95, 'Dithered');

    // S34: Final output gain + dry/wet mix
    const outGainLin = Math.pow(10, (params.outGain ?? 0) / 20);
    for (let i = 0; i < data.length; i++) data[i] *= outGainLin;

    const wetAmt = (params.dryWet ?? 100) / 100;
    if (wetAmt < 1.0 && msg.data) {
      const dry = new Float32Array(msg.data);
      for (let i = 0; i < data.length; i++) {
        data[i] = (1 - wetAmt) * dry[i] + wetAmt * data[i];
      }
    }
    progress(34, 97, 'Final Gain Applied');

    // ===== PASS 10: EXPORT (S35) =====
    // S35 handled by caller (WAV encode / video mux)
    progress(35, 100, 'Pipeline Complete');

    // Return processed data (Transferable = zero-copy)
    const transferables = stereoOut
      ? [data.buffer, stereoOut.buffer]
      : [data.buffer];

    self.postMessage({
      type: 'result',
      data,
      stereoData: stereoOut,
      sampleRate: sr,
      stats: {
        rms: DSP.calcRMS(data),
        peak: DSP.calcPeak(data),
        lufs: DSP.measureLUFS(data, sr),
        frames: frameCount
      }
    }, transferables);

  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message, stack: err.stack });
  }
}

function abort() {
  self.postMessage({ type: 'aborted' });
}

// ===== HELPER FUNCTIONS FOR NEW DSP PASSES =====

/**
 * Build a compact noise feature vector from STFT magnitude frames.
 * Computes 64-band log mel-like energies suitable for the noise classifier model.
 * @param {Float32Array[]} mag - STFT magnitude frames
 * @param {number} sr          - Sample rate
 * @param {number} fftSize     - FFT size
 * @returns {Float32Array} 64-element feature vector
 */
function _buildNoiseFeatures(mag, _sr, _fftSize) {
  const numBands = 64;
  const halfN = mag[0] ? mag[0].length : 0;
  const features = new Float32Array(numBands);
  if (halfN === 0) return features;

  const bandSize = halfN / numBands;

  // Average across frames
  const avg = new Float32Array(halfN);
  for (const frame of mag) {
    for (let k = 0; k < halfN; k++) avg[k] += frame[k];
  }
  const nFrames = Math.max(1, mag.length);
  for (let k = 0; k < halfN; k++) avg[k] /= nFrames;

  // Band log energies
  for (let b = 0; b < numBands; b++) {
    const lo = Math.floor(b * bandSize);
    const hi = Math.min(halfN - 1, Math.floor((b + 1) * bandSize));
    let e = 0;
    for (let k = lo; k <= hi; k++) e += avg[k] * avg[k];
    features[b] = Math.log(e / Math.max(1, hi - lo + 1) + 1e-10);
  }
  return features;
}

/**
 * Build a 512-point magnitude frame for DNS v2 ONNX inference.
 * The DNS v2 model expects 512-point STFT magnitudes at 16 kHz.
 * This function resamples from the current STFT resolution.
 * @param {Float32Array[]} mag - STFT magnitude frames
 * @param {number} midFrame    - Frame index to use
 * @param {number} sr          - Current sample rate
 * @param {number} fftSize     - Current FFT size
 * @returns {Float32Array} 257-point magnitude (512-pt FFT, half+1)
 */
function _buildDNS2Frame(mag, midFrame, sr, _fftSize) {
  const dns2Bins = 257; // 512-pt STFT half+1
  const output = new Float32Array(dns2Bins);
  if (!mag || mag.length === 0) return output;

  const srcFrame = mag[Math.min(midFrame, mag.length - 1)];
  const srcBins = srcFrame.length;
  // Frequency scaling ratio (src bins → 512-pt at 16 kHz)
  const srcNyquist = sr / 2;
  const dstNyquist = 8000; // 16 kHz / 2
  const freqScale = dstNyquist / srcNyquist;

  for (let k = 0; k < dns2Bins; k++) {
    const srcK = Math.round(k / freqScale);
    output[k] = srcK < srcBins ? srcFrame[srcK] : 0;
  }
  return output;
}
