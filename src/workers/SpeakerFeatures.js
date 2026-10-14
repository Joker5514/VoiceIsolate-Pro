/*
 * VoiceIsolate Pro — speaker-embedding front end (Layer 2 classic-worker helper)
 *
 * Loaded by SpeakerEmbeddingWorker with importScripts() (ORT's vendored build
 * is a classic script, so the worker is classic too). Pure math: no I/O.
 *
 * Kaldi-compatible log-mel filterbank features for the optional ECAPA-TDNN
 * speaker embedding (WeSpeaker voxceleb_ECAPA512): 16 kHz mono, 25 ms frames,
 * 10 ms shift, povey window, 0.97 pre-emphasis, DC removal, 512-point power
 * spectrum, 80 Kaldi mel bins (20 Hz to Nyquist), log with FLT_EPSILON floor,
 * no dither, snip_edges, then per-utterance mean normalisation (CMN).
 * The input is scaled to the int16 range first, as in WeSpeaker training.
 *
 * Pinned against kaldi-native-fbank by tests/speaker-features.test.js.
 */
'use strict';

(function installSpeakerFeatures(scope) {
  const ECAPA_SAMPLE_RATE = 16000;
  const FBANK_BINS = 80;
  const FRAME_LEN = 400; // 25 ms @ 16 kHz
  const FRAME_SHIFT = 160; // 10 ms
  const NFFT = 512;
  const PREEMPH = 0.97;
  const FLT_EPSILON = 1.1920928955078125e-7;
  const LOW_FREQ = 20;

  const melScale = (f) => 1127 * Math.log(1 + f / 700);

  let tables = null;
  function getTables() {
    if (tables) return tables;
    const window = new Float32Array(FRAME_LEN);
    for (let i = 0; i < FRAME_LEN; i++) {
      window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LEN - 1)), 0.85);
    }
    // Kaldi MelBanks: num_fft_bins = NFFT / 2 (the Nyquist bin is excluded).
    const nBins = NFFT / 2;
    const melLow = melScale(LOW_FREQ);
    const melHigh = melScale(ECAPA_SAMPLE_RATE / 2);
    const delta = (melHigh - melLow) / (FBANK_BINS + 1);
    const banks = [];
    for (let m = 0; m < FBANK_BINS; m++) {
      const left = melLow + m * delta;
      const center = left + delta;
      const right = center + delta;
      const w = new Float32Array(nBins);
      let first = -1;
      let last = -1;
      for (let i = 0; i < nBins; i++) {
        const mel = melScale((ECAPA_SAMPLE_RATE * i) / NFFT);
        if (mel > left && mel < right) {
          w[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
          if (first < 0) first = i;
          last = i;
        }
      }
      banks.push({ first, last, w });
    }
    const cos = new Float64Array(NFFT / 2);
    const sin = new Float64Array(NFFT / 2);
    for (let i = 0; i < NFFT / 2; i++) {
      cos[i] = Math.cos((-2 * Math.PI * i) / NFFT);
      sin[i] = Math.sin((-2 * Math.PI * i) / NFFT);
    }
    const rev = new Uint16Array(NFFT);
    for (let i = 0, j = 0; i < NFFT; i++) {
      rev[i] = j;
      let bit = NFFT >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j |= bit;
    }
    tables = { window, banks, cos, sin, rev };
    return tables;
  }

  function fft(re, im, t) {
    for (let i = 0; i < NFFT; i++) {
      const j = t.rev[i];
      if (j > i) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const half = size >> 1;
      const step = NFFT / size;
      for (let s = 0; s < NFFT; s += size) {
        for (let k = 0; k < half; k++) {
          const c = t.cos[k * step];
          const sn = t.sin[k * step];
          const a = s + k;
          const b = a + half;
          const xr = re[b] * c - im[b] * sn;
          const xi = re[b] * sn + im[b] * c;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** Number of fbank frames Kaldi produces for `n` samples (snip_edges). */
  function fbankFrameCount(n) {
    return n < FRAME_LEN ? 0 : 1 + Math.floor((n - FRAME_LEN) / FRAME_SHIFT);
  }

  /**
   * @param {Float32Array} samples 16 kHz mono in [-1, 1]
   * @param {{ cmn?: boolean }} [opts]
   * @returns {{ data: Float32Array, frames: number }} row-major [frames, 80]
   */
  function kaldiFbank(samples, opts = {}) {
    const t = getTables();
    const frames = fbankFrameCount(samples.length);
    const data = new Float32Array(frames * FBANK_BINS);
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    const power = new Float64Array(NFFT / 2);
    for (let f = 0; f < frames; f++) {
      const off = f * FRAME_SHIFT;
      let mean = 0;
      for (let i = 0; i < FRAME_LEN; i++) {
        re[i] = samples[off + i] * 32768;
        mean += re[i];
      }
      mean /= FRAME_LEN;
      for (let i = 0; i < FRAME_LEN; i++) re[i] -= mean;
      for (let i = FRAME_LEN - 1; i > 0; i--) re[i] -= PREEMPH * re[i - 1];
      re[0] -= PREEMPH * re[0];
      for (let i = 0; i < FRAME_LEN; i++) re[i] *= t.window[i];
      re.fill(0, FRAME_LEN);
      im.fill(0);
      fft(re, im, t);
      for (let i = 0; i < NFFT / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i];
      const row = f * FBANK_BINS;
      for (let m = 0; m < FBANK_BINS; m++) {
        const { first, last, w } = t.banks[m];
        let e = 0;
        for (let i = first; i <= last; i++) e += w[i] * power[i];
        data[row + m] = Math.log(Math.max(e, FLT_EPSILON));
      }
    }
    if (opts.cmn !== false && frames > 0) {
      for (let m = 0; m < FBANK_BINS; m++) {
        let s = 0;
        for (let f = 0; f < frames; f++) s += data[f * FBANK_BINS + m];
        s /= frames;
        for (let f = 0; f < frames; f++) data[f * FBANK_BINS + m] -= s;
      }
    }
    return { data, frames };
  }

  /**
   * Band-limited resample to 16 kHz (windowed-sinc, Blackman, 16 zero
   * crossings per side). Exact polyphase for integer ratios such as 48 kHz.
   * @param {Float32Array} samples mono
   * @param {number} sampleRate
   * @returns {Float32Array}
   */
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  /** Above this many filter phases (odd input rates), taps are computed per sample. */
  const MAX_PHASES = 4096;

  /**
   * Windowed-sinc (Blackman, 16 zero crossings) resample to 16 kHz. Rational
   * rates repeat their fractional offset every 16000 / gcd outputs, so the
   * normalised taps are tabulated once per phase (48 kHz: one phase).
   */
  function resampleTo16k(samples, sampleRate) {
    if (sampleRate === ECAPA_SAMPLE_RATE) return samples;
    const ratio = ECAPA_SAMPLE_RATE / sampleRate;
    const outLen = Math.floor(samples.length * ratio);
    const out = new Float32Array(outLen);
    const cutoff = Math.min(1, ratio) * 0.95; // relative to input Nyquist
    const zc = 16;
    const half = Math.ceil(zc / cutoff);
    const taps = 2 * half;
    /** Normalised taps for offsets k = c - half + 1 … c + half at fractional position frac. */
    const kernel = (frac, into) => {
      let norm = 0;
      for (let j = 0; j < taps; j++) {
        const d = frac - (j - half + 1);
        const u = d * cutoff;
        const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
        const wpos = d / half;
        const h = wpos <= -1 || wpos >= 1
          ? 0
          : sinc * (0.42 + 0.5 * Math.cos(Math.PI * wpos) + 0.08 * Math.cos(2 * Math.PI * wpos));
        into[j] = h;
        norm += h;
      }
      for (let j = 0; j < taps; j++) into[j] = norm ? into[j] / norm : 0;
      return into;
    };
    const intRate = Number.isInteger(sampleRate);
    const phases = intRate ? ECAPA_SAMPLE_RATE / gcd(ECAPA_SAMPLE_RATE, sampleRate) : Infinity;
    const table = phases <= MAX_PHASES ? new Float64Array(phases * taps) : null;
    if (table) {
      for (let p = 0; p < phases; p++) {
        kernel(((p * sampleRate) % ECAPA_SAMPLE_RATE) / ECAPA_SAMPLE_RATE, table.subarray(p * taps, (p + 1) * taps));
      }
    }
    const scratch = table ? null : new Float64Array(taps);
    for (let n = 0; n < outLen; n++) {
      let c;
      let h;
      if (table) {
        const p = n % phases;
        c = (n * sampleRate - ((p * sampleRate) % ECAPA_SAMPLE_RATE)) / ECAPA_SAMPLE_RATE;
        h = table.subarray(p * taps, (p + 1) * taps);
      } else {
        const x = n / ratio;
        c = Math.floor(x);
        h = kernel(x - c, scratch);
      }
      const k0 = c - half + 1;
      let acc = 0;
      if (k0 >= 0 && k0 + taps <= samples.length) {
        for (let j = 0; j < taps; j++) acc += samples[k0 + j] * h[j];
      } else {
        for (let j = 0; j < taps; j++) {
          const k = k0 + j;
          if (k >= 0 && k < samples.length) acc += samples[k] * h[j];
        }
      }
      out[n] = acc;
    }
    return out;
  }

  /**
   * Mean-normalised [batch, frames, 80] features for windows of one raw
   * (non-CMN) fbank matrix, as each window would get from its own CMN.
   * @param {Float32Array} raw row-major [totalFrames, 80] from kaldiFbank(x, { cmn: false })
   * @param {Array<[number, number]>} windows [startFrame, endFrame) per window, equal lengths
   */
  function windowFeatures(raw, windows) {
    const frames = windows[0][1] - windows[0][0];
    const out = new Float32Array(windows.length * frames * FBANK_BINS);
    const mean = new Float64Array(FBANK_BINS);
    windows.forEach(([a], w) => {
      mean.fill(0);
      for (let f = 0; f < frames; f++) {
        for (let m = 0; m < FBANK_BINS; m++) mean[m] += raw[(a + f) * FBANK_BINS + m];
      }
      for (let m = 0; m < FBANK_BINS; m++) mean[m] /= frames;
      const base = w * frames * FBANK_BINS;
      for (let f = 0; f < frames; f++) {
        for (let m = 0; m < FBANK_BINS; m++) {
          out[base + f * FBANK_BINS + m] = raw[(a + f) * FBANK_BINS + m] - mean[m];
        }
      }
    });
    return { data: out, frames };
  }

  scope.VipSpeakerFeatures = Object.freeze({
    kaldiFbank, fbankFrameCount, resampleTo16k, windowFeatures, ECAPA_SAMPLE_RATE, FBANK_BINS,
  });
})(typeof self !== 'undefined' ? self : globalThis);
