/*
 * VoiceIsolate Pro — mains hum removal (Layer 2 classic-worker helper)
 *
 * Loaded by MLWorker with importScripts() and run once per Process, before
 * the spectral chain. Never a live control: there is no slider and nothing
 * here can start inference.
 *
 * Detection: averaged long-window spectra over a sample of the file look for
 * a stationary 50 or 60 Hz harmonic series (the fundamental may be missing,
 * e.g. 100/120 Hz buzz). Speech and music harmonics move between windows;
 * mains hum stays in the same bin, so a peak must stand out in most windows.
 *
 * Removal: one zero-phase (forward + backward) notch per detected harmonic up
 * to Nyquist. Q is 30 at the fundamental and every notch keeps that same
 * absolute bandwidth (f0 / 30, ~2 Hz). A per-harmonic Q of 30 would widen the
 * notches with frequency until they overlap into a comb above ~1.8 kHz.
 * Each notch is centred on that harmonic's own measured frequency, since
 * f0 × h drifts off a 2 Hz notch at high orders.
 */
'use strict';

(function installMainsHumFilter(scope) {
  const MAINS = [50, 60];
  const Q_FUNDAMENTAL = 30;
  const MAX_WINDOWS = 24;
  const MAX_NOTCHES = 96;
  /** Power ratio a peak must clear over its neighbours (10 dB, 6 dB). */
  const SERIES_PROMINENCE = 10;
  const HARMONIC_PROMINENCE = 4;
  /** Harmonics more than 40 dB below the strongest hum peak are left alone. */
  const HARMONIC_FLOOR = 1e-4;
  /** Largest window-to-window spread of a hum partial, in FFT bins. */
  const FREQ_SPREAD_BINS = 0.3;
  /** Share of windows a peak must appear in to count as stationary. */
  const STATIONARY_SHARE = 0.6;

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function powerSpectrum(x, start, n, win, re, im) {
    for (let i = 0; i < n; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    const bins = (n >> 1) + 1;
    const p = new Float64Array(bins);
    for (let k = 0; k < bins; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    return p;
  }

  /**
   * Peak near `freq`: refined frequency (parabolic on log power) and its
   * power ratio over the median of the surrounding bins.
   */
  function peakAt(p, freq, binHz, searchHz) {
    const lo = Math.max(1, Math.floor((freq - searchHz) / binHz));
    const hi = Math.min(p.length - 2, Math.ceil((freq + searchHz) / binHz));
    if (hi <= lo) return null;
    let k = lo;
    for (let i = lo + 1; i <= hi; i++) if (p[i] > p[k]) k = i;
    const a = Math.log(p[k - 1] + 1e-30);
    const b = Math.log(p[k] + 1e-30);
    const c = Math.log(p[k + 1] + 1e-30);
    const den = a - 2 * b + c;
    const delta = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    // Neighbourhood floor: ±(3..12) Hz, skipping the peak's own main lobe.
    const near = [];
    const inner = Math.max(3, Math.ceil(3 / binHz));
    const outer = Math.max(inner + 4, Math.ceil(12 / binHz));
    for (let d = inner; d <= outer; d++) {
      if (k - d >= 1) near.push(p[k - d]);
      if (k + d < p.length) near.push(p[k + d]);
    }
    near.sort((x, y) => x - y);
    const floor = near.length ? near[near.length >> 1] : 0;
    return { freq: (k + delta) * binHz, power: p[k], prominence: floor > 0 ? p[k] / floor : Infinity };
  }

  /**
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @returns {{ fundamental: number, harmonics: number[] } | null}
   */
  function detectMainsHum(samples, sampleRate) {
    const n = nextPow2(Math.round(sampleRate));
    if (!samples || samples.length < n) return null;
    const binHz = sampleRate / n;
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const span = samples.length - n;
    const count = Math.min(MAX_WINDOWS, Math.max(1, Math.floor(samples.length / n)));
    const spectra = [];
    for (let w = 0; w < count; w++) {
      const start = count === 1 ? 0 : Math.round((span * w) / (count - 1));
      const p = powerSpectrum(samples, start, n, win, re, im);
      let total = 0;
      for (let k = 0; k < p.length; k++) total += p[k];
      if (total > 1e-12) spectra.push(p);
    }
    if (spectra.length === 0) return null;
    const need = Math.ceil(spectra.length * STATIONARY_SHARE);

    let best = null;
    for (const base of MAINS) {
      let hits = 0;
      let f0Sum = 0;
      let f0Count = 0;
      let peakPower = 0;
      for (const p of spectra) {
        let hit = false;
        for (let h = 1; h <= 3; h++) {
          // Mains frequency stays within ±1% of nominal.
          const pk = peakAt(p, base * h, binHz, base * h * 0.01 + binHz);
          if (pk && pk.prominence >= SERIES_PROMINENCE) {
            hit = true;
            f0Sum += pk.freq / h;
            f0Count++;
            if (pk.power > peakPower) peakPower = pk.power;
          }
        }
        if (hit) hits++;
      }
      if (hits >= need && (!best || hits > best.hits)) best = { base, hits, f0: f0Sum / f0Count, peakPower };
    }
    if (!best) return null;

    // Hum harmonics sit at exact multiples of the measured fundamental; the
    // tight window keeps nearby voice or music partials out of the series.
    const nyquist = sampleRate / 2;
    const harmonics = [];
    for (let h = 1; best.f0 * h < nyquist - 2 * binHz && harmonics.length < MAX_NOTCHES; h++) {
      const target = best.f0 * h;
      const found = [];
      for (const p of spectra) {
        const pk = peakAt(p, target, binHz, 1.5 * binHz + target * 0.0005);
        if (pk && pk.prominence >= HARMONIC_PROMINENCE && pk.power >= best.peakPower * HARMONIC_FLOOR) {
          found.push(pk.freq);
        }
      }
      if (found.length < need) continue;
      // A hum partial holds its frequency from window to window; a speech or
      // music partial that drifts through the search window does not.
      const mean = found.reduce((t, f) => t + f, 0) / found.length;
      const spread = Math.sqrt(found.reduce((t, f) => t + (f - mean) * (f - mean), 0) / found.length);
      if (spread <= FREQ_SPREAD_BINS * binHz) harmonics.push(mean);
    }
    if (harmonics.length === 0) return null;
    return { fundamental: best.base, harmonics };
  }

  function notchCoefficients(freq, bandwidth, sampleRate) {
    const w0 = 2 * Math.PI * freq / sampleRate;
    const q = freq / bandwidth;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return { b0: 1 / a0, b1: -2 * cos / a0, b2: 1 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
  }

  function runBiquad(x, c, reverse) {
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
    const n = x.length;
    for (let s = 0; s < n; s++) {
      const i = reverse ? n - 1 - s : s;
      const v = x[i];
      const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      x[i] = y;
    }
  }

  /**
   * Remove detected mains hum. Returns the input unchanged (same array) when
   * no stationary hum series is found.
   * @param {Float32Array} samples
   * @param {number} sampleRate
   * @returns {{ samples: Float32Array, hum: { fundamental: number, harmonics: number[] } | null }}
   */
  function removeMainsHum(samples, sampleRate) {
    const hum = detectMainsHum(samples, sampleRate);
    if (!hum) return { samples, hum: null };
    const bandwidth = hum.fundamental / Q_FUNDAMENTAL;
    // Odd reflection on both sides lets the narrow notches (≈0.2 s time
    // constant) settle before the first real sample and after the last.
    const pad = Math.min(samples.length - 1, Math.round(sampleRate));
    const n = samples.length;
    // Float32 storage keeps a long file's working copy at one extra channel;
    // the filter state itself runs in doubles.
    const work = new Float32Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) {
      work[pad - 1 - i] = 2 * samples[0] - samples[i + 1];
      work[pad + n + i] = 2 * samples[n - 1] - samples[n - 2 - i];
    }
    for (let i = 0; i < n; i++) work[pad + i] = samples[i];
    for (const f of hum.harmonics) {
      const c = notchCoefficients(f, bandwidth, sampleRate);
      runBiquad(work, c, false);
      runBiquad(work, c, true);
    }
    return { samples: work.subarray(pad, pad + n), hum };
  }

  scope.detectMainsHum = detectMainsHum;
  scope.removeMainsHum = removeMainsHum;
})(typeof self !== 'undefined' ? self : globalThis);
