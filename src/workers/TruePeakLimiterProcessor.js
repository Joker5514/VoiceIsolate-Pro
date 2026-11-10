/**
 * TruePeakLimiterProcessor — playback + export output ceiling (AudioWorklet)
 *
 * The same look-ahead true-peak limiter as src/core/TruePeakLimiter.js, run
 * as a stream so live preview and the offline export render use one
 * algorithm (PlaybackMixer splices it before the ceiling clip in both):
 *
 *   • detection: 4× oversampled true peak (Hann-windowed sinc, 32 taps per
 *     phase), the louder channel — one gain for all channels (stereo-linked);
 *   • attack: sliding minimum of the required gain over the look-ahead, then a
 *     moving average of the same length, so the gain is always at or under
 *     what the coming peak needs and never steps (no clicks, no flat tops);
 *   • release: program-dependent. A fast follower (the Release control) and a
 *     slow follower (slow attack, slow release) run side by side; the gain is
 *     the lower of the two. Isolated peaks recover at the fast rate; sustained
 *     limiting (a hot preset driving every syllable) holds steadily instead of
 *     pumping.
 *
 * Latency is fixed (look-ahead + interpolation half-width) whether or not a
 * ceiling is engaged, so engaging it never shifts the timeline; disengaged it
 * is a pure delay. Playback-only: never ingests a microphone, never runs ML.
 */
const TPL_HALF = 16;
const TPL_TAPS = 32;
const TPL_FACTOR = 4;
const TPL_LOOKAHEAD_MS = 5;
const TPL_MARGIN_DB = 0.05;
const TPL_SLOW_ATTACK_MS = 60;
const TPL_SLOW_RELEASE_FACTOR = 8;
const TPL_MIN_SLOW_RELEASE_MS = 400;

const TPL_PHASES = (() => {
  const out = [];
  for (let p = 1; p < TPL_FACTOR; p++) {
    const h = new Float32Array(TPL_TAPS);
    let sum = 0;
    for (let j = 0; j < TPL_TAPS; j++) {
      const u = (TPL_HALF - 1) + p / TPL_FACTOR - j;
      const sinc = Math.sin(Math.PI * u) / (Math.PI * u);
      const w = Math.abs(u) < TPL_HALF ? 0.5 + 0.5 * Math.cos((Math.PI * u) / TPL_HALF) : 0;
      h[j] = sinc * w;
      sum += h[j];
    }
    for (let j = 0; j < TPL_TAPS; j++) h[j] /= sum;
    out.push(h);
  }
  return out;
})();
const TPL_L1 = Math.max(...TPL_PHASES.map((h) => h.reduce((s, v) => s + Math.abs(v), 0)));

class TruePeakLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Ceiling in dBTP while enabled.
      { name: 'ceiling', defaultValue: -1, minValue: -24, maxValue: 0, automationRate: 'k-rate' },
      // 0 = pure delay (no ceiling), 1 = limit to `ceiling`.
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Fast release, ms (the Limiter Release control).
      { name: 'release', defaultValue: 50, minValue: 1, maxValue: 2000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
    this.sr = sr;
    this.L = Math.max(1, Math.round((TPL_LOOKAHEAD_MS / 1000) * sr));
    this.delay = this.L + TPL_HALF;
    let size = 1;
    while (size < this.delay + TPL_TAPS + 2) size <<= 1;
    this.mask = size - 1;
    this.hist = [new Float32Array(size), new Float32Array(size)];
    this.n = 0;
    this.dqIdx = new Float64Array(this.L + 2);
    this.dqVal = new Float64Array(this.L + 2);
    this.head = 0; this.tail = 0;
    this.ring = new Float64Array(this.L + 1).fill(1);
    this.ringSum = this.L + 1;
    this.gFast = 1; this.gSlow = 1;
    this.slowAttack = Math.exp(-1 / ((TPL_SLOW_ATTACK_MS / 1000) * sr));
    this.port && (this.port.onmessage = (e) => { if (e?.data?.type === 'reset') this._reset(); });
  }

  _reset() {
    for (const h of this.hist) h.fill(0);
    this.n = 0; this.head = 0; this.tail = 0;
    this.ring.fill(1); this.ringSum = this.L + 1;
    this.gFast = 1; this.gSlow = 1;
  }

  _peakAt(p, chCount, skipBelow) {
    const mask = this.mask;
    let peak = 0; let local = 0;
    for (let c = 0; c < chCount; c++) {
      const h = this.hist[c];
      const v = Math.abs(h[p & mask]);
      if (v > peak) peak = v;
      for (let j = 0; j < TPL_TAPS; j++) {
        const a = Math.abs(h[(p - (TPL_HALF - 1) + j) & mask]);
        if (a > local) local = a;
      }
    }
    if (local * TPL_L1 < skipBelow) return peak;
    for (let c = 0; c < chCount; c++) {
      const h = this.hist[c];
      for (let ph = 0; ph < TPL_PHASES.length; ph++) {
        const k = TPL_PHASES[ph];
        let acc = 0;
        for (let j = 0; j < TPL_TAPS; j++) acc += k[j] * h[(p - (TPL_HALF - 1) + j) & mask];
        const a = acc < 0 ? -acc : acc;
        if (a > peak) peak = a;
      }
    }
    return peak;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (output.length === 0) return true;
    const frames = output[0].length;
    const chCount = Math.min(2, Math.max(input.length, 1), output.length);
    const enabled = (parameters.enabled?.[0] ?? 0) >= 0.5;
    const ceilingDb = Math.min(0, Math.max(-24, Number(parameters.ceiling?.[0] ?? -1)));
    const target = Math.pow(10, (ceilingDb - TPL_MARGIN_DB) / 20);
    const releaseMs = Math.min(2000, Math.max(1, Number(parameters.release?.[0] ?? 50)));
    const fastRel = Math.exp(-1 / ((releaseMs / 1000) * this.sr));
    const slowRelMs = Math.max(TPL_MIN_SLOW_RELEASE_MS, releaseMs * TPL_SLOW_RELEASE_FACTOR);
    const slowRel = Math.exp(-1 / ((slowRelMs / 1000) * this.sr));
    const L = this.L; const mask = this.mask; const len = this.dqIdx.length;
    for (let i = 0; i < frames; i++) {
      const n = this.n++;
      for (let c = 0; c < chCount; c++) {
        const src = input[c] || input[0];
        const v = src ? src[i] : 0;
        this.hist[c][n & mask] = Number.isFinite(v) ? v : 0;
      }
      // Required gain for frame p (its interpolation support is complete).
      const p = n - TPL_HALF;
      let greq = 1;
      if (enabled) {
        const pk = this._peakAt(p, chCount, target);
        if (pk > target) greq = target / pk;
      }
      while (this.tail > this.head && this.dqVal[(this.tail - 1) % len] >= greq) this.tail--;
      this.dqIdx[this.tail % len] = p; this.dqVal[this.tail % len] = greq; this.tail++;
      while (this.dqIdx[this.head % len] < p - L) this.head++;
      const a = this.dqVal[this.head % len];
      const slot = ((p % (L + 1)) + (L + 1)) % (L + 1);
      this.ringSum += a - this.ring[slot];
      this.ring[slot] = a;
      const gatt = Math.min(1, this.ringSum / (L + 1));
      this.gFast = gatt < this.gFast ? gatt : this.gFast + (gatt - this.gFast) * (1 - fastRel);
      this.gSlow = gatt < this.gSlow
        ? this.gSlow + (gatt - this.gSlow) * (1 - this.slowAttack)
        : this.gSlow + (gatt - this.gSlow) * (1 - slowRel);
      const g = this.gFast < this.gSlow ? this.gFast : this.gSlow;
      const q = n - this.delay;
      for (let c = 0; c < output.length; c++) {
        const h = this.hist[Math.min(c, chCount - 1)];
        output[c][i] = h[q & mask] * g;
      }
    }
    return true;
  }
}

registerProcessor('vip-true-peak-limiter', TruePeakLimiterProcessor);
