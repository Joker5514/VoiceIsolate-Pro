/* ============================================
   VoiceIsolate Pro v22.1 — DSP Worker
   Threads from Space v11 · 35-Stage Pipeline
   Deca-Pass Offline Processing · Full Quality
   ============================================ */

'use strict';

importScripts('dsp-core.js');

const DSP = self.DSPCore;
const SR = 48000;

/**
 * Offline 36-stage Deca-Pass pipeline worker.
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
  self._aborted = false;
  const params = msg.params;

  // [A17] Preserve input SR for final resample-back/reporting, but process at fixed 48kHz.
  const originalSR = msg.sampleRate || SR;
  const processingSR = SR;
  const needsResample = !!originalSR && Math.abs(originalSR - processingSR) > 100;
  const sr = processingSR;

  let data = new Float32Array(msg.data);

  // [A17] Resample input to the fixed processing SR before any downstream DSP/ML stages.
  if (needsResample) {
    const ratio = processingSR / originalSR;
    const outLen = Math.round(data.length * ratio);
    const resampled = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i / ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, data.length - 1);
      const frac = srcIdx - lo;
      resampled[i] = data[lo] * (1 - frac) + data[hi] * frac;
    }
    data = resampled;
  }

  // [C17] Save original before any processing for dry/wet mix
  const wetAmt = (params.dryWet ?? 100) / 100;
  const originalData = wetAmt < 1.0 ? new Float32Array(data) : null;

  try {
    // ===== PASS 1: INPUT CONDITIONING (S01–S04) =====
    progress(1, 0, 'Input Conditioning');

    // S01: Already decoded (received as Float32Array at target SR)
    // S02: Channel normalization (mono — handled by caller)
    // S03: DC offset removal
    data = DSP.removeDCOffset(data, sr);
    progress(3, 5, 'DC Offset Removed');

    // S04: Pre-gain & headroom
    data = DSP.peakNormalize(data, -3);
    progress(4, 8, 'Normalized to -3dBFS');

    if (self._aborted) return abort();

    // ===== PASS 2: TIME-DOMAIN CLEANUP (S05–S08) =====
    progress(5, 10, 'Time-Domain Cleanup');

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

    // ===== PASS 4: ML SOURCE SEPARATION (S11–S14) =====
    progress(11, 32, 'ML Source Separation');

    // S11: Silero VAD
    let vadConfidence = null;
    const vadData = new Float32Array(data); // copy for ML
    const vadResult = await callML('vad', vadData, { sampleRate: sr });
    if (vadResult.confidence) {
      vadConfidence = vadResult.confidence;
    }
    progress(11, 38, 'VAD Complete');

    // S12–S14: Demucs + BSRNN ensemble separation
    // [C19] Apply ML separation as time-domain gain before the single STFT pass
    const voiceIso = params.voiceIso ?? 70;
    if (voiceIso > 0) {
      const sepData = new Float32Array(data);
      const sepResult = await callML('separate', sepData, {
        chunkSize: sr * 10,
        demucsWeight: params.demucsWeight ?? 70,
        bsrnnWeight: params.bsrnnWeight ?? 30
      });

      if (sepResult.data) {
        const isoStrength = voiceIso / 100;
        const separated = new Float32Array(sepResult.data);
        const blended = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
          blended[i] = (1 - isoStrength) * data[i] + isoStrength * separated[i];
        }
        data = blended;
      }
    }
    progress(14, 45, 'ML Separation Complete');

    if (self._aborted) return abort();

    // ===== PASS 3: FORWARD TRANSFORM (S09–S10) =====
    progress(9, 25, 'Forward STFT');

    const fftSize = 4096;
    const hopSize = 1024;
    const { mag, phase, frameCount } = DSP.forwardSTFT(data, fftSize, hopSize);
    progress(10, 30, `STFT: ${frameCount} frames`);

    if (self._aborted) return abort();

    // ===== PASS 5: SPECTRAL OPERATIONS IN-PLACE (S15–S19) =====
    progress(15, 48, 'Spectral Operations');

    // Estimate noise profile from silent segments
    const noiseProfile = DSP.estimateNoiseProfile(data, vadConfidence, fftSize, hopSize);

    // S15: Spectral noise subtraction (Wiener-MMSE)
    const nrAmount = params.nrAmount ?? 55;
    DSP.wienerMMSE(mag, noiseProfile, nrAmount);
    progress(15, 52, 'Spectral Noise Subtracted');

    // S16: 32 ERB band spectral gate
    const nrFloor = params.nrFloor ?? -60;
    DSP.spectralGate(mag, nrFloor, sr);
    progress(16, 56, 'Spectral Gate Applied');

    // S17: Harmonic enhancement
    const harmRecov = params.harmRecov ?? 20;
    DSP.harmonicEnhance(mag, phase, harmRecov);
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
    progress(22, 74, 'Parametric EQ');

    const eqBands = [
      { freq: 40,    gain: params.eqSub ?? -8,      Q: 0.7, type: 'peaking' },    // S22
      { freq: 100,   gain: params.eqBass ?? 0,       Q: 1.0, type: 'peaking' },
      { freq: 200,   gain: params.eqWarmth ?? 1,     Q: 1.4, type: 'peaking' },
      { freq: 400,   gain: params.eqBody ?? 0,       Q: 1.4, type: 'peaking' },
      { freq: 800,   gain: params.eqLowMid ?? -1,    Q: 1.4, type: 'peaking' },
      { freq: 1500,  gain: params.eqMid ?? 1,        Q: 1.4, type: 'peaking' },
      { freq: 3000,  gain: params.eqPresence ?? 3,   Q: 1.4, type: 'peaking' },    // S24
      { freq: 5000,  gain: params.eqClarity ?? 2,    Q: 1.4, type: 'peaking' },
      { freq: 10000, gain: params.eqAir ?? 1,        Q: 1.4, type: 'peaking' },
      { freq: 16000, gain: params.eqBrill ?? -2,     Q: 0.7, type: 'highshelf' },  // S25
    ];
    DSP.parametricEQ(data, eqBands, sr);
    progress(25, 78, 'EQ Applied');

    // S26: Harmonic resynthesis (guard against S17 duplication)
    // Only apply if harmonic recovery was minimal in spectral domain
    if (harmRecov < 30) {
      const harmOrder = params.harmOrder ?? 3;
      // Soft saturation for harmonic regeneration
      const amount = (params.harmRecov ?? 20) / 100;
      for (let i = 0; i < data.length; i++) {
        const x = data[i];
        data[i] = x + amount * 0.3 * Math.tanh(harmOrder * x);
      }
    }
    progress(26, 80, 'Harmonic Resynthesis');

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
    progress(31, 92, 'Output Mastering');

    // S31: Stereo widener (mono passthrough if single channel)
    // Handled at caller level for stereo content

    // S32: True peak limiter
    const limCeiling = params.limThresh ?? -1;
    DSP.truePeakLimit(data, limCeiling);
    progress(32, 94, 'Peak Limited');

    // S33: Dither
    const ditherBits = params.bitDepth ?? 16;
    DSP.dither(data, ditherBits);
    progress(33, 95, 'Dithered');

    // S34: Final output gain
    const outGainLin = Math.pow(10, (params.outGain ?? 0) / 20);
    for (let i = 0; i < data.length; i++) data[i] *= outGainLin;

    // [C17] Dry/wet mix using pre-processing copy saved before any transforms
    if (wetAmt < 1.0 && originalData) {
      for (let i = 0; i < data.length; i++) {
        data[i] = (1 - wetAmt) * originalData[i] + wetAmt * data[i];
      }
    }
    progress(34, 97, 'Final Gain Applied');

    // [A17] Resample back to original SR if we upsampled
    let outputData = data;
    if (sr !== 48000) {
      const ratio = originalSR / 48000;
      const outLen = Math.round(data.length * ratio);
      outputData = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i / ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, data.length - 1);
        const frac = srcIdx - lo;
        outputData[i] = data[lo] * (1 - frac) + data[hi] * frac;
      }
    }

    // ===== PASS 10: EXPORT (S35–S36) =====
    // S35–S36 handled by caller (WAV encode / video mux)
    progress(36, 100, 'Pipeline Complete');

    // [C18] Inline calcPeak/calcRMS (methods not on DSP instance)
    const peak = outputData.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const rms = Math.sqrt(outputData.reduce((s, v) => s + v * v, 0) / outputData.length);

    // Return processed data (Transferable = zero-copy)
    self.postMessage({
      type: 'result',
      data: outputData,
      sampleRate: originalSR,
      stats: {
        rms,
        peak,
        lufs: DSP.measureLUFS(outputData, originalSR),
        frames: frameCount
      }
    }, [outputData.buffer]);

  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message, stack: err.stack });
  }
}

function abort() {
  self.postMessage({ type: 'aborted' });
}
