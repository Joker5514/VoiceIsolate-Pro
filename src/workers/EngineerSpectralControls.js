/*
 * VoiceIsolate Pro — Engineer spectral controls (Layer 2 classic-worker helper)
 *
 * Loaded by MLWorker with importScripts(). This file intentionally has no DOM,
 * Web Audio, model, or app-shell dependency: it applies the Process-time
 * Engineer snapshot inside MLWorker's existing fused STFT/iSTFT cycle.
 */
'use strict';

(function installEngineerSpectralControls(scope) {
  const VERSION = 1;
  const EPSILON = 1e-12;

  const RANGES = Object.freeze({
    nrAmount: [0, 100], nrSensitivity: [0, 100], nrSpectralSub: [0, 100],
    nrFloor: [-120, -20], nrSmoothing: [0, 100],
    formantShift: [-12, 12], derevAmt: [0, 100], derevDecay: [0, 100],
    harmRecov: [0, 100], harmOrder: [1, 8],
    voiceFocusLo: [50, 1000], voiceFocusHi: [1000, 16000],
    whisperLift: [0, 40], crowdNull: [0, 100], bassCrush: [0, 100],
    reverbStrip: [0, 2000], voiceTunnel: [0, 100], musicKill: [0, 100],
    snrFloor: [-80, -20], whisperMode: [0, 3], whisperClarity: [0, 100],
    whisperSensitivity: [0, 100], whisperThreshold: [0, 100],
    transientShaper: [-100, 100], breathControl: [0, 100],
    roomCorrection: [0, 100], subHarmonic: [0, 100],
  });

  const DEFAULTS = Object.freeze({
    nrAmount: 52, nrSensitivity: 48, nrSpectralSub: 35, nrFloor: -68, nrSmoothing: 32,
    formantShift: 0, derevAmt: 0, derevDecay: 30, harmRecov: 0, harmOrder: 3,
    voiceFocusLo: 100, voiceFocusHi: 4500,
    whisperLift: 0, crowdNull: 0, bassCrush: 0, reverbStrip: 0, voiceTunnel: 0,
    musicKill: 0, snrFloor: -52, whisperMode: 0, whisperClarity: 65,
    whisperSensitivity: 55, whisperThreshold: 50, transientShaper: 0,
    breathControl: 0, roomCorrection: 0, subHarmonic: 0,
  });

  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Defensive duplicate of the wire contract; the canonical builder lives in ParameterSchema. */
  function sanitizeProcessingConfig(input) {
    if (!input || Number(input.version) !== VERSION || !input.spectral) return null;
    const spectral = {};
    for (const [id, range] of Object.entries(RANGES)) {
      spectral[id] = clamp(finite(input.spectral[id], DEFAULTS[id]), range[0], range[1]);
    }
    if (spectral.voiceFocusHi - spectral.voiceFocusLo < 300) {
      spectral.voiceFocusHi = Math.min(RANGES.voiceFocusHi[1], spectral.voiceFocusLo + 300);
    }
    return {
      version: VERSION,
      revision: typeof input.revision === 'string' ? input.revision.slice(0, 96) : null,
      spectral,
    };
  }

  function smoothStep(value, edge0, edge1) {
    if (edge0 === edge1) return value >= edge1 ? 1 : 0;
    const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return x * x * (3 - 2 * x);
  }

  /**
   * Create per-channel, allocation-free state for the one existing spectral
   * pass. applyFrame mutates positive-frequency complex bins in place.
   */
  function createEngineerFrameProcessor(input, geometry) {
    const config = sanitizeProcessingConfig(input);
    if (!config) return null;
    const bins = Math.max(1, Math.floor(finite(geometry?.bins, 0)));
    const fftSize = Math.max(2, Math.floor(finite(geometry?.fftSize, bins * 2 - 2)));
    const sampleRate = Math.max(8000, finite(geometry?.sampleRate, 48000));
    const hop = Math.max(1, finite(geometry?.hop, Math.max(1, fftSize / 4)));
    const binHz = sampleRate / fftSize;
    const s = config.spectral;
    const noiseFloor = new Float32Array(bins);
    const previousGain = new Float32Array(bins);
    const reverbTail = new Float32Array(bins);
    const previousMagnitude = new Float32Array(bins);
    const warpMagnitude = new Float32Array(bins);
    let initialized = false;

    const mode = Math.round(s.whisperMode);
    const modeStrength = [0, 0.22, 0.48, 0.72][mode] || 0;
    const nrStrength = (s.nrAmount / 100) * (0.25 + (s.nrSpectralSub / 100) * 0.75);
    const nrFloorGain = Math.pow(10, s.nrFloor / 20);
    const snrFloorAmp = Math.pow(10, s.snrFloor / 20);
    const smoothing = 0.05 + (s.nrSmoothing / 100) * 0.9;
    const noiseTrack = 0.005 + ((100 - s.nrSensitivity) / 100) * 0.12;
    // Semitone contract: ±12 moves the spectral envelope by one octave.
    const formantRatio = Math.pow(2, s.formantShift / 12);
    const derevStrength = Math.min(1, (s.derevAmt + s.roomCorrection * 0.5) / 100);
    const reverbStripStrength = Math.min(1, s.reverbStrip / 2000);
    const tailDecay = Math.exp(-hop / sampleRate / (0.04 + (s.derevDecay / 100) * 0.76));
    const harmonicStrength = s.harmRecov / 100;
    const harmonicOrder = Math.round(s.harmOrder);
    const focusEdge = Math.max(100, Math.min(700, (s.voiceFocusHi - s.voiceFocusLo) * 0.12));
    const focusOutsideGain = 1 - Math.min(0.82, 0.12 + (s.nrAmount / 100) * 0.42 + modeStrength * 0.35);
    const tunnelStrength = s.voiceTunnel / 100;
    const crowdStrength = s.crowdNull / 100;
    const bassStrength = s.bassCrush / 100;
    const musicStrength = s.musicKill / 100;
    const whisperLift = Math.pow(10, s.whisperLift / 40 * 12 / 20);
    const clarityFloor = 0.12 + (s.whisperClarity / 100) * 0.58;
    const whisperSensitivity = s.whisperSensitivity / 100;
    const whisperThreshold = 0.5 + (s.whisperThreshold / 100) * 2.5;
    const transientAmount = s.transientShaper / 100;
    const breathStrength = s.breathControl / 100;
    const subHarmonicStrength = s.subHarmonic / 100;

    function applyFrame(re, im, sourceMagnitude, offset) {
      if (!re || !im || !sourceMagnitude) return;
      const maxBins = Math.min(bins, re.length, im.length, sourceMagnitude.length - offset);
      if (maxBins <= 0) return;

      let frameEnergy = 0;
      for (let k = 0; k < maxBins; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        frameEnergy += mag * mag;
        if (!initialized) {
          noiseFloor[k] = Math.max(sourceMagnitude[offset + k] * 0.5, EPSILON);
          previousGain[k] = 1;
          previousMagnitude[k] = mag;
        }
      }
      frameEnergy = Math.sqrt(frameEnergy / Math.max(1, maxBins));

      for (let k = 0; k < maxBins; k++) {
        const hz = k * binHz;
        const source = Math.max(EPSILON, sourceMagnitude[offset + k]);
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const priorNoise = noiseFloor[k] || source;
        noiseFloor[k] = source < priorNoise
          ? source
          : priorNoise + (source - priorNoise) * noiseTrack;
        const noiseRatio = clamp(noiseFloor[k] / source, 0, 1);
        let gain = Math.max(nrFloorGain, 1 - nrStrength * noiseRatio * 0.82);

        // Protect a soft speech band; the shape changes directly with both
        // focus controls and avoids a hard edge that would ring in the iSTFT.
        const below = 1 - smoothStep(hz, s.voiceFocusLo - focusEdge, s.voiceFocusLo + focusEdge);
        const above = smoothStep(hz, s.voiceFocusHi - focusEdge, s.voiceFocusHi + focusEdge);
        gain *= 1 - (below + above - below * above) * (1 - focusOutsideGain);

        // Tail prediction provides a low-cost dereverb/reverb-strip control.
        const tail = reverbTail[k] * tailDecay;
        reverbTail[k] = Math.max(mag, tail);
        if (derevStrength > 0 || reverbStripStrength > 0) {
          const tailRatio = clamp(tail / Math.max(mag, EPSILON), 0, 1);
          gain *= Math.max(0.08, 1 - tailRatio * (derevStrength * 0.58 + reverbStripStrength * 0.72));
        }

        // Extreme controls stay intentionally bounded for Android/WebView but
        // every point in their declared range changes the per-bin gain.
        if (bassStrength > 0 && hz < 80 + bassStrength * 2000) {
          gain *= 1 - bassStrength * (0.55 + 0.4 * (1 - hz / Math.max(1, 80 + bassStrength * 2000)));
        }
        if (crowdStrength > 0 && hz >= 200 && hz <= 2500) {
          const confidence = mag / (mag + noiseFloor[k] * (1.2 - whisperSensitivity * 0.55) + EPSILON);
          gain *= 1 - crowdStrength * (1 - confidence) * 0.78;
        }
        if (musicStrength > 0) {
          const prior = previousMagnitude[k] || mag;
          const stability = 1 - clamp(Math.abs(mag - prior) / Math.max(prior, EPSILON), 0, 1);
          gain *= 1 - musicStrength * stability * 0.48;
        }
        if (source < snrFloorAmp && (crowdStrength > 0 || musicStrength > 0 || s.whisperLift > 0)) {
          gain *= 0.15 + (1 - crowdStrength) * 0.35;
        }
        if (tunnelStrength > 0) {
          const f1 = Math.exp(-Math.pow((hz - 1200) / 560, 2));
          const f2 = Math.exp(-Math.pow((hz - 2800) / 850, 2));
          gain *= 1 + tunnelStrength * (f1 * 0.55 + f2 * 0.42);
          if (hz < 250 || hz > 4300) gain *= 1 - tunnelStrength * 0.34;
        }
        if (subHarmonicStrength > 0 && hz > 20 && hz < Math.max(180, s.voiceFocusLo * 1.4)) {
          gain *= 1 + subHarmonicStrength * (1 - hz / Math.max(181, s.voiceFocusLo * 1.4)) * 0.75;
        }
        if (harmonicStrength > 0 && k > harmonicOrder) {
          const fundamental = Math.sqrt(re[Math.max(1, Math.round(k / harmonicOrder))] ** 2
            + im[Math.max(1, Math.round(k / harmonicOrder))] ** 2);
          gain *= 1 + harmonicStrength * clamp(fundamental / (mag + EPSILON), 0, 1.4) * 0.22;
        }
        if (transientAmount !== 0) {
          const prior = previousMagnitude[k] || mag;
          const transient = clamp((mag - prior) / Math.max(prior, EPSILON), -1, 1);
          gain *= 1 + transientAmount * transient * 0.35;
        }
        if (breathStrength > 0 && hz > 4500 && frameEnergy < 0.025) {
          gain *= 1 - breathStrength * 0.72;
        }

        const speechConfidence = mag / (mag + noiseFloor[k] * whisperThreshold + EPSILON);
        if (mode > 0 || s.whisperLift > 0) {
          const confidenceGain = clarityFloor + (1 - clarityFloor) * speechConfidence;
          gain *= confidenceGain;
          if (speechConfidence > 0.35 - whisperSensitivity * 0.18) {
            gain *= 1 + (whisperLift - 1) * speechConfidence;
          }
        }

        const smoothed = initialized ? previousGain[k] * smoothing + gain * (1 - smoothing) : gain;
        previousGain[k] = Math.max(0, Math.min(4, smoothed));
        previousMagnitude[k] = mag;
        re[k] *= previousGain[k];
        im[k] *= previousGain[k];
      }

      // Formant envelope relocation is intentionally after gain construction:
      // it moves amplitude character but preserves the model-derived phase.
      if (Math.abs(s.formantShift) > 0.001 && Number.isFinite(formantRatio) && formantRatio > 0) {
        for (let k = 0; k < maxBins; k++) {
          const pos = k / formantRatio;
          const i0 = Math.floor(pos);
          if (i0 < 0 || i0 >= maxBins) {
            warpMagnitude[k] = 0;
            continue;
          }
          const i1 = Math.min(maxBins - 1, i0 + 1);
          const t = pos - i0;
          const mag0 = Math.sqrt(re[i0] * re[i0] + im[i0] * im[i0]);
          const mag1 = Math.sqrt(re[i1] * re[i1] + im[i1] * im[i1]);
          warpMagnitude[k] = mag0 * (1 - t) + mag1 * t;
        }
        for (let k = 0; k < maxBins; k++) {
          const destinationMagnitude = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
          const scale = destinationMagnitude > EPSILON
            ? warpMagnitude[k] / destinationMagnitude
            : 0;
          // Preserve each destination bin's model-derived phase: this moves
          // vocal envelope character without frequency-shifting the pitch.
          re[k] *= scale;
          im[k] *= scale;
        }
      }
      initialized = true;
    }

    return Object.freeze({
      revision: config.revision,
      applyFrame,
    });
  }

  scope.createEngineerFrameProcessor = createEngineerFrameProcessor;
  scope.sanitizeEngineerProcessingConfig = sanitizeProcessingConfig;
})(typeof self !== 'undefined' ? self : globalThis);
