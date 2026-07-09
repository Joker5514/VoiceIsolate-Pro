/* global WhisperHunterAI, PipelineOrchestrator */
/**
 * dsp-bootstrap.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wires three previously disconnected pieces:
 *   1. globalThis.DSP  — exposes forwardSTFT / inverseSTFT so runPipeline()
 *                        produces real audio instead of a silent copy.
 *   2. initAudio()     — patches AudioContext + SharedArrayBuffers onto the app.
 *   3. WhisperHunter   — early _vipWhisperHunter init (retries until module loads).
 *
 * CONSTRAINTS MAINTAINED:
 *   • Exactly ONE forward STFT, in-place spectral ops, ONE iSTFT.
 *   • Zero fetch() to external servers.
 *   • All ML inference stays in the ml-worker via the orchestrator.
 *
 * AUDIT-FIX #12 (2026-05-26): _hannWindow() now uses PERIODIC form (N not N-1).
 *   Symmetric window (N-1) broke COLA at 75% overlap causing amplitude ripple.
 *   forwardSTFT and inverseSTFT updated to match dsp-processor.js + fft-bridge.js.
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function _vipDspBootstrap() {
  'use strict';

  /* ── 1. Standalone Hann-windowed STFT / iSTFT on globalThis.DSP ────────── */

  // AUDIT-FIX #12: Periodic Hann window (denominator N, not N-1).
  // With 75% overlap the COLA sum of squared periodic-Hann windows = 2.0.
  // Symmetric window (N-1) violates this and introduces inter-frame amplitude ripple.
  function _hannWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++)
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N)); // periodic: N not N-1
    return w;
  }

  /** Cooley–Tukey radix-2 DIT FFT — in-place, float32 */
  function _fftInPlace(re, im) {
    const N = re.length;
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const ang  = (-2 * Math.PI) / len;
      const wRe  = Math.cos(ang);
      const wIm  = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let cRe = 1, cIm = 0;
        for (let k = 0; k < half; k++) {
          const uRe =  re[i + k];
          const uIm =  im[i + k];
          const vRe =  re[i + k + half] * cRe - im[i + k + half] * cIm;
          const vIm =  re[i + k + half] * cIm + im[i + k + half] * cRe;
          re[i + k]        = uRe + vRe;  im[i + k]        = uIm + vIm;
          re[i + k + half] = uRe - vRe;  im[i + k + half] = uIm - vIm;
          const nr = cRe * wRe - cIm * wIm;
          cIm      = cRe * wIm + cIm * wRe;
          cRe      = nr;
        }
      }
    }
  }

  /** iFFT — conjugate trick: ifft(x) = conj(fft(conj(x))) / N */
  function _ifftInPlace(re, im) {
    const N = re.length;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    _fftInPlace(re, im);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
  }

  if (!globalThis.DSP || typeof globalThis.DSP.forwardSTFT !== 'function') {
    globalThis.DSP = globalThis.DSP || {};

    globalThis.DSP.forwardSTFT = function forwardSTFT(signal, fftSize, hopSize) {
      const win      = _hannWindow(fftSize); // AUDIT-FIX #12: periodic Hann
      const halfBins = fftSize / 2 + 1;
      const numFrames = Math.max(1, Math.floor((signal.length - fftSize) / hopSize) + 1);
      const mag   = new Array(numFrames);
      const phase = new Array(numFrames);

      for (let f = 0; f < numFrames; f++) {
        const re   = new Float32Array(fftSize);
        const im   = new Float32Array(fftSize);
        const base = f * hopSize;
        for (let i = 0; i < fftSize; i++)
          re[i] = (signal[base + i] || 0) * win[i];

        _fftInPlace(re, im);

        mag[f]   = new Float32Array(halfBins);
        phase[f] = new Float32Array(halfBins);
        for (let b = 0; b < halfBins; b++) {
          mag[f][b]   = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
          phase[f][b] = Math.atan2(im[b], re[b]);
        }
      }
      return { mag, phase, fftSize, hopSize };
    };

    globalThis.DSP.inverseSTFT = function inverseSTFT(mag, phase, fftSize, hopSize, outputLength) {
      const win = _hannWindow(fftSize); // AUDIT-FIX #12: periodic Hann
      const out = new Float32Array(outputLength);
      const env = new Float32Array(outputLength);
      const halfBins = fftSize / 2 + 1;

      for (let f = 0; f < mag.length; f++) {
        const re   = new Float32Array(fftSize);
        const im   = new Float32Array(fftSize);

        for (let b = 0; b < halfBins; b++) {
          const m = mag[f][b];
          const p = phase[f][b];
          re[b] = m * Math.cos(p);
          im[b] = m * Math.sin(p);
          if (b > 0 && b < fftSize - b) {
            re[fftSize - b] =  re[b];
            im[fftSize - b] = -im[b];
          }
        }

        _ifftInPlace(re, im);

        const base = f * hopSize;
        for (let i = 0; i < fftSize; i++) {
          const idx = base + i;
          if (idx >= outputLength) break;
          out[idx] += re[i] * win[i];
          env[idx] += win[i] * win[i];
        }
      }

      for (let i = 0; i < outputLength; i++)
        if (env[i] > 1e-8) out[i] /= env[i];

      return out;
    };

    console.info('[DSP-Bootstrap] globalThis.DSP STFT/iSTFT registered (periodic Hann).');
  }

  // [WHISPER UPDATE] Instantiate WhisperHunterAI for offline paths (Part 4)
  (function _initWhisperHunter(retries) {
    const sr = window._vipAudioCtx?.sampleRate
      || window._vipApp?.ctx?.sampleRate
      || 48000;
    if (typeof ensureWhisperHunterInstance === 'function') {
      ensureWhisperHunterInstance(4096, sr);
      console.info('[DSP-Bootstrap] WhisperHunterAI ready @', sr, 'Hz');
      return;
    }
    if (window._vipWhisperHunter) return;
    if (typeof WhisperHunterAI !== 'undefined') {
      window._vipWhisperHunter = new WhisperHunterAI(4096, sr);
      console.info('[DSP-Bootstrap] WhisperHunterAI ready @', sr, 'Hz');
      return;
    }
    if (retries > 0) setTimeout(() => _initWhisperHunter(retries - 1), 80);
  })(40);


  /* ── 2. Patch initAudio() to boot AudioWorklet + ML Worker ─────────────── */

  const FLAG_SLOTS        = 4;
  const FFT_SIZE          = 4096;
  const _HOP_SIZE         = 1024; // pinned STFT hop — reserved for future SAB sizing
  void _HOP_SIZE;
  const HALF_BINS         = FFT_SIZE / 2 + 1;
  const SAB_HEADER_BYTES  = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
  const INPUT_SAB_BYTES   = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS * 2;
  const OUTPUT_SAB_BYTES  = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS;

  window._vipInitAudioFull = async function initAudioFull() {
    try {
      const audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      window._vipAudioCtx = audioCtx;

      const inputSAB  = new SharedArrayBuffer(INPUT_SAB_BYTES);
      const outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
      window._vipInputSAB  = inputSAB;
      window._vipOutputSAB = outputSAB;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.85;
      window._vipAnalyser = analyser;

      const patch = () => {
        const app = window._vipApp || window.vip;
        if (!app) return;
        app.ctx          = audioCtx;
        if (!window.neonAnalyser) window.neonAnalyser = analyser;
        try {
          if (window._vipOrch) {
            window._vipOrch.audioCtx    = audioCtx;
            if (window._vipWorkletNode) {
              window._vipOrch.workletNode = window._vipWorkletNode;
            }
            if (window._vipMlWorker) {
              window._vipOrch.mlWorker = window._vipMlWorker;
            }
            window._vipOrch.analyser    = analyser;
          }
        } catch (_) {}
        console.info('[DSP-Bootstrap] Audio context patched onto app instance.');
      };

      patch();
      setTimeout(patch, 400);
      setTimeout(patch, 1200);

      console.info('[DSP-Bootstrap] initAudioFull() complete.');
    } catch (e) {
      console.error('[DSP-Bootstrap] initAudioFull() failed:', e);
    }
  };


  /* ── 3. Auto-run after DOM is ready ────────────────────────────────────── */

  function _run() {
    if (typeof AudioContext !== 'undefined') {
      window._vipInitAudioFull().catch(e =>
        console.error('[DSP-Bootstrap] initAudioFull error:', e)
      );
    }
    setTimeout(() => {
      try {
        if (
          typeof PipelineOrchestrator !== 'undefined' &&
          !window._vipOrch
        ) {
          window._vipOrch = new PipelineOrchestrator();
          console.info('[DSP-Bootstrap] PipelineOrchestrator instantiated.');
        }
      } catch (e) {
        console.warn('[DSP-Bootstrap] PipelineOrchestrator init skipped:', e);
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _run, { once: true });
  } else {
    _run();
  }

})();
