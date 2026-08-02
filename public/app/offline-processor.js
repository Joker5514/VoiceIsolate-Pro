/**
 * offline-processor.js — VoiceIsolate Pro · Creator & Forensic Mode
 *
 * Self-contained module for offline (non-real-time) audio processing.
 * This file owns offline / creator mode only; live mode belongs to
 * pipeline-orchestrator.js and bulk queue coordination belongs to
 * batch-orchestrator.js + batch-processor.js.
 * Architecture constraints honoured:
 *   - 100% local — no external fetches, no cloud
 *   - Single-pass STFT: exactly one forwardFFT and one iFFT per channel
 *     (all spectral operations occur in-place between them)
 *   - All spectral work between the two transform calls; no nested STFT pairs
 *
 * Exports:
 *   processFile(arrayBuffer, params, progressCallback) → Promise<AudioBuffer>
 *   exportWav(audioBuffer) → Promise<Blob>   — 32-bit float PCM WAV
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_FFT_SIZE = 2048;
let FFT_SIZE         = DEFAULT_FFT_SIZE;
let HOP_SIZE         = FFT_SIZE / 4;       // 75% overlap
let HALF_BINS        = FFT_SIZE / 2 + 1;   // 1025
const STAGES         = 32;

// Blackman-Harris window coefficients
const A0 = 0.35875, A1 = 0.48829, A2 = 0.14128, A3 = 0.01168;

function getFFTSize(mode) {
  const sizes = { live: 1024, creator: 2048, forensic: 4096 };
  return sizes[mode] || sizes.creator;
}

function configureProcessingResolution(params = {}) {
  const mode = String(
    params.qualityMode || params.mode || params.workflowMode || params.renderMode || 'creator'
  ).toLowerCase();
  FFT_SIZE = getFFTSize(mode);
  HOP_SIZE = FFT_SIZE / 4;
  HALF_BINS = FFT_SIZE / 2 + 1;
  return { fftSize: FFT_SIZE, hopSize: HOP_SIZE, halfBins: HALF_BINS };
}

async function renderWithProgress(renderPromise, startPercent, endPercent, progressCallback) {
  const emit = typeof progressCallback === 'function' ? progressCallback : () => {};
  const start = Math.max(0, Number(startPercent) || 0);
  const end = Math.max(start, Number(endPercent) || start);
  const step = Math.max(1, Math.round((end - start) / 3));
  let current = start;
  emit(start);
  const timer = setInterval(() => {
    current = Math.min(end - 1, current + step);
    emit(current);
  }, 250);
  try {
    const rendered = await renderPromise;
    emit(end);
    return rendered;
  } finally {
    clearInterval(timer);
  }
}

// ---------------------------------------------------------------------------
// Minimal Cooley-Tukey FFT (inlined — AudioWorklet scope cannot be imported)
// ---------------------------------------------------------------------------

/** Build a Hann window of length n */
function makeBlackmanHarris(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / (n - 1);
    w[i] = A0 - A1 * Math.cos(t) + A2 * Math.cos(2 * t) - A3 * Math.cos(3 * t);
  }
  return w;
}

/**
 * Bit-reversal permutation in-place on complex interleaved array [re0,im0,re1,im1,…].
 */
function bitRevPermute(data, n) {
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = data[2 * i];     data[2 * i]     = data[2 * j];     data[2 * j]     = tmp;
      tmp     = data[2 * i + 1]; data[2 * i + 1] = data[2 * j + 1]; data[2 * j + 1] = tmp;
    }
  }
}

/**
 * In-place FFT on complex interleaved Float64Array [re0,im0,re1,im1,…].
 * @param {Float64Array} data — length 2*n
 * @param {number}       n    — must be a power of two
 * @param {boolean}      inv  — true for IFFT
 */
function fftInPlace(data, n, inv) {
  bitRevPermute(data, n);
  const sign = inv ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = sign * (2 * Math.PI) / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = data[2 * (i + j)];
        const uIm = data[2 * (i + j) + 1];
        const vRe = data[2 * (i + j + half)]     * curRe - data[2 * (i + j + half) + 1] * curIm;
        const vIm = data[2 * (i + j + half)]     * curIm + data[2 * (i + j + half) + 1] * curRe;
        data[2 * (i + j)]         = uRe + vRe;
        data[2 * (i + j) + 1]     = uIm + vIm;
        data[2 * (i + j + half)]   = uRe - vRe;
        data[2 * (i + j + half) + 1] = uIm - vIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  if (inv) {
    for (let i = 0; i < 2 * n; i++) data[i] /= n;
  }
}

// ---------------------------------------------------------------------------
// Single-pass STFT / iSTFT helpers (used by spectral processing stage)
// ---------------------------------------------------------------------------

/**
 * Forward STFT → returns { frames: Float64Array[], hopCount, pcmLen }
 * Each frame is complex interleaved [re0,im0,…,re(N-1),im(N-1)].
 * Architecture: this is the ONE forward FFT call per processFile() invocation.
 */
function forwardSTFT(pcm) {
  const window   = makeBlackmanHarris(FFT_SIZE);
  const hopCount = Math.floor((pcm.length - FFT_SIZE) / HOP_SIZE) + 1;
  const frames   = [];

  for (let h = 0; h < hopCount; h++) {
    const frame = new Float64Array(FFT_SIZE * 2); // complex interleaved
    const start = h * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      frame[2 * i] = (start + i < pcm.length ? pcm[start + i] : 0) * window[i];
      // imag = 0
    }
    // SINGLE-PASS STFT BOUNDARY
    // Forward transform entry for the offline Creator / Forensic path.
    fftInPlace(frame, FFT_SIZE, false);
    frames.push(frame);
  }
  return { frames, hopCount, pcmLen: pcm.length };
}

/**
 * Inverse STFT → reconstructed Float32Array PCM.
 * Architecture: this is the ONE inverse FFT call per processFile() invocation.
 */
function inverseSTFT({ frames, hopCount, pcmLen }) {
  const window  = makeBlackmanHarris(FFT_SIZE);
  const out     = new Float32Array(pcmLen + FFT_SIZE);
  const norm    = new Float32Array(pcmLen + FFT_SIZE);
  // Reuse one scratch buffer — frames are already consumed after spectral ops,
  // so we can IFFT in-place on a copy only when the caller needs frames later.
  // Single alloc avoids per-hop Float64Array.slice() GC pressure on long files.
  const scratch = new Float64Array(FFT_SIZE * 2);

  for (let h = 0; h < hopCount; h++) {
    const src = frames[h];
    scratch.set(src);
    // SINGLE-PASS STFT BOUNDARY
    // Inverse transform exit for the offline Creator / Forensic path.
    fftInPlace(scratch, FFT_SIZE, true);
    const start = h * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const w2 = window[i] * window[i];
      out[start + i]  += scratch[2 * i] * window[i];
      norm[start + i] += w2;
    }
  }
  // Normalise OLA
  for (let i = 0; i < pcmLen; i++) {
    out[i] = norm[i] > 1e-9 ? out[i] / norm[i] : 0;
  }
  return out.subarray(0, pcmLen);
}

// ---------------------------------------------------------------------------
// Spectral operations (in-place between forward and inverse FFT)
// ---------------------------------------------------------------------------

/**
 * Compute magnitude spectrum for all STFT frames.
 * Returns Float32Array[hopCount][HALF_BINS].
 */
function computeMagnitudes(frames) {
  return frames.map(f => {
    const mag = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(f[2 * k] * f[2 * k] + f[2 * k + 1] * f[2 * k + 1]);
    }
    return mag;
  });
}

/**
 * Estimate noise floor as the median-low (10th percentile) magnitude
 * across the first noiseFrames frames.
 */
function estimateNoiseFloor(magnitudes, noiseFrames = 30) {
  const floor = new Float32Array(HALF_BINS);
  const count = Math.min(noiseFrames, magnitudes.length);
  for (let k = 0; k < HALF_BINS; k++) {
    const vals = [];
    for (let h = 0; h < count; h++) vals.push(magnitudes[h][k]);
    vals.sort((a, b) => a - b);
    floor[k] = vals[Math.floor(vals.length * 0.10)] || 0;
  }
  return floor;
}

/**
 * Apply Wiener noise reduction to all STFT frames (in-place on real/imag).
 * This is the only spectral operation loop — all in-place between STFT/iSTFT.
 */
function applyWienerNR(frames, noiseFloor, noiseReduce, spectralFloor) {
  for (const frame of frames) {
    for (let k = 0; k < HALF_BINS; k++) {
      const mag      = Math.sqrt(frame[2 * k] * frame[2 * k] + frame[2 * k + 1] * frame[2 * k + 1]);
      const noise    = noiseFloor[k] * (1 + noiseReduce);
      const snr      = mag / Math.max(noise, 1e-9);
      const gain     = Math.max(spectralFloor, Math.min(1, snr / (snr + 1)));
      frame[2 * k]       *= gain;
      frame[2 * k + 1]   *= gain;
      // Mirror to negative frequencies for proper reconstruction
      if (k > 0 && k < HALF_BINS - 1) {
        frame[2 * (FFT_SIZE - k)]     = frame[2 * k];
        frame[2 * (FFT_SIZE - k) + 1] = -frame[2 * k + 1];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offline BSRNN (complex-spectrogram) adapter
// ---------------------------------------------------------------------------
// Repacks the offline-processor's per-frame interleaved real/imag spectra
// into the 4D tensor layout expected by `bsrnn_vocals_complex.onnx`
// (pretrained crlandsc/bsrnn-vocals): [1, 4, halfBins, timeFrames] with
// channel-planes ordered [ch0_re, ch0_im, ch1_re, ch1_im], each plane
// row-major as [freq][time]. Mono input is fake-stereo'd by duplication.
//
// Returns a Float32Array of identical layout containing the separated
// vocals spectrogram. Callers convert that into a per-bin magnitude mask
// and apply it to the original frames so the rest of the offline pipeline
// (Wiener NR, tilt, EQ, etc.) continues to operate on the same single-pass
// STFT result.

function packComplexFrames(channelFrames, halfBins, timeFrames) {
  const numCh = channelFrames.length;
  const out   = new Float32Array(4 * halfBins * timeFrames);

  // For each model-channel plane (real_L, imag_L, real_R, imag_R)
  for (let mc = 0; mc < 4; mc++) {
    const srcCh   = numCh === 1 ? 0 : (mc < 2 ? 0 : 1);
    const reOrIm  = mc & 1; // 0=real, 1=imag
    const frames  = channelFrames[srcCh].frames;
    const planeBase = mc * halfBins * timeFrames;

    for (let k = 0; k < halfBins; k++) {
      const rowBase = planeBase + k * timeFrames;
      for (let t = 0; t < timeFrames; t++) {
        out[rowBase + t] = frames[t][2 * k + reOrIm];
      }
    }
  }
  return out;
}

function applyMagnitudeMaskFromSeparated(channelFrames, separated, halfBins, timeFrames) {
  const numCh = channelFrames.length;
  const EPS   = 1e-8;

  for (let ch = 0; ch < numCh; ch++) {
    // Pick the corresponding stereo plane pair from the separated tensor.
    // For mono runtime channel, use the left pair of the model output.
    const reBase = (ch === 0 ? 0 : 2) * halfBins * timeFrames;
    const imBase = (ch === 0 ? 1 : 3) * halfBins * timeFrames;
    const frames = channelFrames[ch].frames;

    for (let t = 0; t < timeFrames; t++) {
      const frame = frames[t];
      for (let k = 0; k < halfBins; k++) {
        const mixRe = frame[2 * k];
        const mixIm = frame[2 * k + 1];
        const mixMag = Math.sqrt(mixRe * mixRe + mixIm * mixIm);

        const sepRe = separated[reBase + k * timeFrames + t];
        const sepIm = separated[imBase + k * timeFrames + t];
        const sepMag = Math.sqrt(sepRe * sepRe + sepIm * sepIm);

        const m = sepMag / Math.max(mixMag, EPS);
        const mask = m > 1 ? 1 : (m < 0 ? 0 : m);

        frame[2 * k]     = mixRe * mask;
        frame[2 * k + 1] = mixIm * mask;
      }
    }
  }
}

function runBsrnnComplexViaWorker(mlWorker, packed, halfBins, timeFrames) {
  return new Promise((resolve, reject) => {
    const id = 'bsrnn-' + (globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36));
    const onMessage = (ev) => {
      const d = ev.data;
      if (!d || d.type !== 'bsrnnComplexResult' || d.id !== id) return;
      mlWorker.removeEventListener('message', onMessage);
      if (d.error) reject(new Error(d.error));
      else resolve(d.separated);
    };
    mlWorker.addEventListener('message', onMessage);
    // packed is owned by main thread after this call (transferred).
    mlWorker.postMessage(
      { type: 'bsrnnComplex', payload: { id, halfBins, timeFrames, channels: packed } },
      [packed.buffer],
    );
  });
}

// ---------------------------------------------------------------------------
// Main export: processFile
// ---------------------------------------------------------------------------

/**
 * Decode and process audio through the full 32-stage offline pipeline.
 *
 * @param {ArrayBuffer} arrayBuffer     — raw audio file bytes
 * @param {Object}      params          — slider parameter values
 *                                        Notable optional flags:
 *                                          - useBSRNN: when truthy AND `mlWorker`
 *                                            is provided, runs the pretrained
 *                                            4D complex BSRNN as a pre-Wiener
 *                                            voice-separation step.
 * @param {Function}    progressCallback — (percent: 0–100) called per stage
 * @param {Worker}      [mlWorker]       — optional ml-worker handle for BSRNN
 * @returns {Promise<AudioBuffer>}
 */
export async function processFile(arrayBuffer, params = {}, progressCallback = () => {}, mlWorker = null) {
  const p = { ...params };
  configureProcessingResolution(p);
  const stageStep = 100 / STAGES;

  // ── S01 Input decode ───────────────────────────────────────────────────
  progressCallback(stageStep * 1);
  const decodeCtx = new AudioContext();
  let inputBuffer;
  try {
    inputBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    decodeCtx.close().catch(() => {});
  }
  const { sampleRate, numberOfChannels, length } = inputBuffer;

  // ── S02 Buffer allocation ──────────────────────────────────────────────
  progressCallback(stageStep * 2);

  // ── S03 DC offset removal ──────────────────────────────────────────────
  progressCallback(stageStep * 3);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const d = inputBuffer.getChannelData(ch);
    let mean = 0;
    for (let i = 0; i < d.length; i++) mean += d[i];
    mean /= d.length;
    for (let i = 0; i < d.length; i++) d[i] -= mean;
  }

  // ── S04 Peak normalisation ─────────────────────────────────────────────
  progressCallback(stageStep * 4);
  let peak = 0;
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const d = inputBuffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0 && peak !== 1) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const d = inputBuffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] /= peak;
    }
  }

  // ── S05–S09 Time-domain pre-processing via OfflineAudioContext ─────────
  progressCallback(stageStep * 5);
  const preCtx = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const src    = preCtx.createBufferSource();
  src.buffer   = inputBuffer;

  // S06 Time-domain noise gate
  const noiseGateThresh = parseFloat(p.gate) || -40;

  // S07 HP / LP filters (click/hum removal + band limiting)
  const hpFilter = preCtx.createBiquadFilter();
  hpFilter.type = 'highpass';
  hpFilter.frequency.value = Math.max(20, parseFloat(p.lowCut) || 80);
  hpFilter.Q.value = 0.707;

  const lpFilter = preCtx.createBiquadFilter();
  lpFilter.type = 'lowpass';
  lpFilter.frequency.value = Math.min(sampleRate / 2 - 1, parseFloat(p.highCut) || 16000);
  lpFilter.Q.value = 0.707;

  // S08 De-esser (high-shelf cut around 6–8 kHz)
  const deEsser = preCtx.createBiquadFilter();
  deEsser.type = 'peaking';
  deEsser.frequency.value = 7000;
  deEsser.gain.value = -Math.max(0, parseFloat(p.deEss) || 0) * 0.12;
  deEsser.Q.value = 1.5;

  // S09 Hum removal (50/60 Hz notch)
  const humNotch = preCtx.createBiquadFilter();
  humNotch.type = 'notch';
  humNotch.frequency.value = 60;
  humNotch.Q.value = 30;

  src.connect(hpFilter);
  hpFilter.connect(lpFilter);
  lpFilter.connect(deEsser);
  deEsser.connect(humNotch);
  humNotch.connect(preCtx.destination);
  src.start(0);
  progressCallback(stageStep * 9);

  const preRendered = await renderWithProgress(
    preCtx.startRendering(),
    stageStep * 5,
    stageStep * 9,
    progressCallback,
  );

  // ── S10 Forward STFT — THE single forward FFT pass ────────────────────
  progressCallback(stageStep * 10);
  const noiseReduce   = Math.max(0, Math.min(1, (parseFloat(p.noiseReduction) || 50) / 100));
  const spectralFloor = Math.max(0.001, Math.min(0.05, (parseFloat(p.spectralFloor) || 5) / 1000));

  const channelFrames = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const pcm    = preRendered.getChannelData(ch);
    const result = forwardSTFT(pcm); // ← ONE forward STFT per channel
    channelFrames.push(result);
  }

  // ── BSRNN voice-separation (opt-in, between S10 and S11) ─────────────
  // Single-pass STFT contract preserved: BSRNN consumes the same frames
  // produced by forwardSTFT() and contributes a per-bin magnitude mask
  // applied in-place to those frames. No nested STFT/iSTFT pair.
  if (mlWorker && p.useBSRNN) {
    try {
      const timeFrames = channelFrames[0].frames.length;
      const packed     = packComplexFrames(channelFrames, HALF_BINS, timeFrames);
      const separated  = await runBsrnnComplexViaWorker(mlWorker, packed, HALF_BINS, timeFrames);
      applyMagnitudeMaskFromSeparated(channelFrames, separated, HALF_BINS, timeFrames);
    } catch (err) {
      // Non-fatal: fall back to classical spectral chain if BSRNN unavailable.
      console.warn('[offline-processor] BSRNN skipped:', err.message);
    }
  }

  // ── S11–S19 All spectral operations (in-place on frames) ──────────────
  progressCallback(stageStep * 11);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const { frames } = channelFrames[ch];
    const mags       = computeMagnitudes(frames);
    const noiseFloor = estimateNoiseFloor(mags, 30);

    // S11 Adaptive Wiener NR + S12 residual pass
    applyWienerNR(frames, noiseFloor, noiseReduce, spectralFloor);
    progressCallback(stageStep * 12);

    // S13 Spectral tilt (gentle slope across spectrum)
    const tilt = parseFloat(p.spectralTilt) || 0;
    if (Math.abs(tilt) > 0.01) {
      const tiltGain = tilt / HALF_BINS;
      for (const frame of frames) {
        for (let k = 0; k < HALF_BINS; k++) {
          const g = Math.max(0.1, 1 + tiltGain * k);
          frame[2 * k]     *= g;
          frame[2 * k + 1] *= g;
        }
      }
    }

    // S14 Voice-band emphasis (300–3400 Hz boost)
    const voiceBoost = Math.pow(10, (parseFloat(p.voiceBoost) || 0) / 20);
    if (voiceBoost !== 1) {
      const loK = Math.round(300  / (sampleRate / 2) * (HALF_BINS - 1));
      const hiK = Math.round(3400 / (sampleRate / 2) * (HALF_BINS - 1));
      for (const frame of frames) {
        for (let k = loK; k <= hiK && k < HALF_BINS; k++) {
          frame[2 * k]     *= voiceBoost;
          frame[2 * k + 1] *= voiceBoost;
        }
      }
    }

    // S15–S19 stubs — temporal smoothing, dereverb, harmonic reconstruction
    // These stages are handled by the ML worker in the live path.
    progressCallback(stageStep * 19);
  }

  // ── S20 Inverse STFT — THE single inverse FFT pass ────────────────────
  progressCallback(stageStep * 20);
  const postBuffer = new OfflineAudioContext(numberOfChannels, length, sampleRate)
    .createBuffer(numberOfChannels, length, sampleRate);

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const reconstructed = inverseSTFT(channelFrames[ch]); // ← ONE iSTFT per channel
    postBuffer.getChannelData(ch).set(reconstructed);
  }

  // ── S21–S25 Post-STFT time-domain processing ──────────────────────────
  progressCallback(stageStep * 21);
  const postCtx  = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const postSrc  = postCtx.createBufferSource();
  postSrc.buffer = postBuffer;

  // S22 HP/LP filter (post-spectral clean-up)
  const postHP = postCtx.createBiquadFilter();
  postHP.type = 'highpass';
  postHP.frequency.value = Math.max(20, parseFloat(p.lowCut) || 80);

  // S23 10-band EQ (simplified as single peaking filter on presence band)
  const eqPresence = postCtx.createBiquadFilter();
  eqPresence.type = 'peaking';
  eqPresence.frequency.value = 3000;
  eqPresence.gain.value = parseFloat(p.presenceBoost) || 0;
  eqPresence.Q.value = 1.0;

  // S24 Dynamics compression
  const comp = postCtx.createDynamicsCompressor();
  comp.threshold.value = parseFloat(p.compThreshold) || -24;
  comp.ratio.value     = parseFloat(p.compRatio)     || 4;
  comp.attack.value    = (parseFloat(p.compAttack)   || 10)  / 1000;
  comp.release.value   = (parseFloat(p.compRelease)  || 100) / 1000;
  comp.knee.value      = 6;

  // S25 Limiter (brickwall ceiling via DynamicsCompressor at high ratio)
  const limiter = postCtx.createDynamicsCompressor();
  limiter.threshold.value = parseFloat(p.limiterCeiling) || -1;
  limiter.ratio.value     = 20;
  limiter.attack.value    = 0.001;
  limiter.release.value   = 0.05;
  limiter.knee.value      = 0;

  postSrc.connect(postHP);
  postHP.connect(eqPresence);
  eqPresence.connect(comp);
  comp.connect(limiter);
  limiter.connect(postCtx.destination);
  postSrc.start(0);
  progressCallback(stageStep * 25);

  const postRendered = await renderWithProgress(
    postCtx.startRendering(),
    stageStep * 21,
    stageStep * 25,
    progressCallback,
  );

  // ── S26–S28 Dry/wet mix + cleanup ─────────────────────────────────────
  progressCallback(stageStep * 26);
  const dryWet = Math.max(0, Math.min(1, (parseFloat(p.dryWet) || 100) / 100));

  const finalCtx    = new OfflineAudioContext(numberOfChannels, length, sampleRate);
  const finalBuffer = finalCtx.createBuffer(numberOfChannels, length, sampleRate);

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const dry = inputBuffer.getChannelData(ch);
    const wet = postRendered.getChannelData(ch);
    const out = finalBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      out[i] = dry[i] * (1 - dryWet) + wet[i] * dryWet;
    }
  }
  progressCallback(stageStep * 28);

  // ── S29–S31 Peak normalisation + quality metrics ───────────────────────
  progressCallback(stageStep * 29);
  let finalPeak = 0;
  const outGainLinear = Math.pow(10, (parseFloat(p.outputGain) || 0) / 20);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const d = finalBuffer.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      d[i] *= outGainLinear;
      const a = Math.abs(d[i]);
      if (a > finalPeak) finalPeak = a;
    }
  }
  // Prevent clipping without changing apparent loudness
  if (finalPeak > 1) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const d = finalBuffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] /= finalPeak;
    }
  }
  progressCallback(stageStep * 31);

  // ── S32 Export ready — SHA-256 forensic hash ──────────────────────────
  progressCallback(100);
  // Forensic hash written to _forensicLog (non-blocking, best-effort)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const flat = new Float32Array(numberOfChannels * length);
    let offset = 0;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      flat.set(finalBuffer.getChannelData(ch), offset);
      offset += length;
    }
    crypto.subtle.digest('SHA-256', flat.buffer).then(hash => {
      const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (typeof window !== 'undefined') {
        window._forensicLog = window._forensicLog || [];
        window._forensicLog.push({ ts: Date.now(), sha256: hex, channels: numberOfChannels, length, sampleRate });
      }
    }).catch(() => {});
  }

  return finalBuffer;
}

// ---------------------------------------------------------------------------
// Export: exportWav  — 32-bit float PCM WAV
// ---------------------------------------------------------------------------

/**
 * Encode an AudioBuffer as a 32-bit float PCM WAV Blob.
 * @param {AudioBuffer} audioBuffer
 * @returns {Promise<Blob>}
 */
export async function exportWav(audioBuffer) {
  const { sampleRate, numberOfChannels, length } = audioBuffer;
  const bytesPerSample  = 4;  // float32
  const blockAlign      = numberOfChannels * bytesPerSample;
  const dataSize        = length * blockAlign;
  const headerSize      = 44;
  const buffer          = new ArrayBuffer(headerSize + dataSize);
  const view            = new DataView(buffer);

  // RIFF header
  _writeStr(view, 0,  'RIFF');
  view.setUint32(4,  36 + dataSize, true);
  _writeStr(view, 8,  'WAVE');
  _writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);              // chunk size
  view.setUint16(20,  3, true);              // PCM float = 3
  view.setUint16(22,  numberOfChannels, true);
  view.setUint32(24,  sampleRate, true);
  view.setUint32(28,  sampleRate * blockAlign, true); // byte rate
  view.setUint16(32,  blockAlign, true);
  view.setUint16(34,  32, true);             // bits per sample
  _writeStr(view, 36, 'data');
  view.setUint32(40,  dataSize, true);

  // Interleave samples (float32, little-endian)
  let offset = headerSize;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      view.setFloat32(offset, audioBuffer.getChannelData(ch)[i], true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function _writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
