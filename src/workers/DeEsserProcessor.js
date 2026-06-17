/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * VoiceIsolate Pro — De-Esser AudioWorklet (Layer 2: playback DSP)
 *
 * A real-time, sample-accurate de-esser for the Live-Mix playback bus —
 * **playback-only**, exactly like GateProcessor: it processes loaded stems,
 * never a microphone, never re-runs ML. The second (and only other) worklet
 * permitted in src/, allowlisted in scripts/validate.js (CLAUDE.md §2.1).
 *
 * Why a worklet rather than built-in nodes: a built-in split-band design must
 * route the sibilance band through a DynamicsCompressorNode, whose ~5 ms
 * lookahead misaligns it from the dry path and comb-filters the highs. Doing
 * the detection + reduction per sample avoids that entirely.
 *
 * Method (complementary filter, no latency, transparent by construction):
 *   low  = one-pole lowpass(x) at `frequency`
 *   high = x − low                      (so low + high == x exactly)
 *   out  = low + g·high                 (reduce only the sibilance band)
 * where g (1 → reduced) follows the high-band envelope: when it exceeds a
 * fixed threshold, g = (thr/env)^amount. amount 0 → g≡1 → fully transparent;
 * and g≡1 whenever the high band is quiet, so non-sibilant audio is untouched
 * at any amount.
 *
 * AudioParams (k-rate) so sliders drive it like any other Live-Mix control:
 *   - frequency (Hz): low/high split point (sibilance band start)
 *   - amount (0–1):   de-essing strength; 0 = off
 */
'use strict';

const SIBILANCE_THRESHOLD = 0.05; // ≈ −26 dBFS high-band level where reduction begins

class DeEsserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 6000, minValue: 2000, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._lp = new Float32Array(2);   // per-channel one-pole lowpass state
    this._high = new Float32Array(2); // scratch: current-sample high band per channel
    this._env = 0;                    // shared high-band envelope
    this._gain = 1;                   // smoothed reduction gain
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;
    const inCh = input.length;
    const outCh = output.length;
    const nSamp = output[0].length;

    const amount = parameters.amount[0];
    // Bypass fast-path: amount 0 → no reduction → pass through untouched.
    if (amount <= 0) {
      for (let c = 0; c < outCh; c++) {
        if (input[c]) output[c].set(input[c]);
        else output[c].fill(0);
      }
      this._env = 0;
      this._gain = 1;
      return true;
    }

    if (this._lp.length < inCh) this._lp = new Float32Array(inCh);
    if (this._high.length < inCh) this._high = new Float32Array(inCh);

    const a = Math.exp(-2 * Math.PI * parameters.frequency[0] / sampleRate); // one-pole LP coef
    const atk = Math.exp(-1 / (0.0005 * sampleRate)); // 0.5 ms detector/gain attack
    const rel = Math.exp(-1 / (0.05 * sampleRate));   // 50 ms release
    const thr = SIBILANCE_THRESHOLD;

    let env = this._env;
    let gain = this._gain;
    for (let i = 0; i < nSamp; i++) {
      // Split each channel into low/high; track the peak |high| for detection.
      let hpk = 0;
      for (let c = 0; c < inCh; c++) {
        const x = input[c] ? input[c][i] : 0;
        const lp = a * this._lp[c] + (1 - a) * x;
        this._lp[c] = lp;
        const high = x - lp;
        this._high[c] = high;
        const ah = high < 0 ? -high : high;
        if (ah > hpk) hpk = ah;
      }
      // Envelope (fast attack, slow release) on the high band.
      env = hpk > env ? atk * env + (1 - atk) * hpk : rel * env + (1 - rel) * hpk;
      // Target reduction gain for the high band; 1 (no cut) until env exceeds thr.
      const target = env > thr ? Math.pow(thr / env, amount) : 1;
      const coef = target < gain ? atk : rel;
      gain = coef * gain + (1 - coef) * target;
      // out = low + g·high; low = x − high so the sum is exact when g = 1.
      for (let c = 0; c < outCh; c++) {
        const x = input[c] ? input[c][i] : 0;
        const high = c < inCh ? this._high[c] : 0;
        output[c][i] = (x - high) + gain * high;
      }
    }
    this._env = env;
    this._gain = gain;
    return true;
  }
}

registerProcessor('vip-deesser', DeEsserProcessor);
