/* global AudioWorkletProcessor, registerProcessor, sampleRate */
/**
 * VoiceIsolate Pro — Noise-Gate AudioWorklet (Layer 2: playback DSP)
 *
 * A real-time downward noise gate for the Live-Mix playback bus. It is a
 * **playback-only** worklet: it processes already-loaded stems during
 * playback exactly like the EQ/compressor nodes — it NEVER ingests a
 * microphone and NEVER re-runs ML. This is the one worklet permitted in
 * src/ (allowlisted in scripts/validate.js); the removed live-mic pipeline
 * stays removed (CLAUDE.md §1.1 / §2.1).
 *
 * Web Audio has no built-in expander/gate (DynamicsCompressorNode only acts
 * *above* a threshold), so the gate needs sample-level envelope following —
 * hence a worklet rather than built-in nodes.
 *
 * Control is AudioParam-only (k-rate), so the UI sliders drive it through the
 * same setTargetAtTime path as every other Live-Mix control:
 *   - threshold (dB): level below which the gate attenuates
 *   - range (dB):     attenuation depth when closed; 0 = bypass (transparent)
 *   - attack (ms):    how fast the gate opens
 *   - release (ms):   how fast the gate closes
 *
 * Default range = 0 dB → the gate is fully transparent until engaged.
 */
'use strict';

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -45, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 0, minValue: 0, maxValue: 80, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 5, minValue: 0, maxValue: 200, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 100, minValue: 0, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0, minValue: 0, maxValue: 500, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._env = 0;  // envelope-follower state (linear)
    this._gain = 1; // smoothed gate gain (linear)
    this._hold = 0; // remaining hold samples after the signal drops below threshold
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) return true;
    const inCh = input.length;
    const outCh = output.length;
    const nSamp = output[0].length;

    const rangeDb = parameters.range[0];
    // Bypass fast-path: range 0 → never attenuate → pass through untouched.
    if (rangeDb <= 0) {
      for (let c = 0; c < outCh; c++) {
        if (input[c]) output[c].set(input[c]);
        else output[c].fill(0);
      }
      this._env = 0;
      this._gain = 1;
      this._hold = 0;
      return true;
    }

    const thrLin = Math.pow(10, parameters.threshold[0] / 20);
    const floor = Math.pow(10, -rangeDb / 20); // gain when fully closed
    // One-pole envelope/gain coefficients from the time constants (per sample).
    const atk = Math.exp(-1 / (Math.max(0.05, parameters.attack[0]) * 0.001 * sampleRate));
    const rel = Math.exp(-1 / (Math.max(1, parameters.release[0]) * 0.001 * sampleRate));
    // Hold keeps the gate open for a fixed tail after the signal drops below
    // threshold, so brief dips between syllables don't chatter it shut.
    const holdSamples = Math.round(Math.max(0, parameters.hold[0]) * 0.001 * sampleRate);

    let env = this._env;
    let gain = this._gain;
    let hold = this._hold;
    for (let i = 0; i < nSamp; i++) {
      // Control signal = peak across channels (keeps L/R gated together).
      let x = 0;
      for (let c = 0; c < inCh; c++) {
        const ch = input[c];
        const a = ch ? Math.abs(ch[i]) : 0;
        if (a > x) x = a;
      }
      // Fast-attack / slow-release envelope follower.
      env = x > env ? atk * env + (1 - atk) * x : rel * env + (1 - rel) * x;
      const aboveThr = env >= thrLin;
      // Refresh the hold tail while open; otherwise count it down.
      if (aboveThr) hold = holdSamples;
      else if (hold > 0) hold--;
      const target = aboveThr || hold > 0 ? 1 : floor;
      // Ramp the gain toward the target (attack when opening, release when closing).
      const coef = target > gain ? atk : rel;
      gain = coef * gain + (1 - coef) * target;
      for (let c = 0; c < outCh; c++) output[c][i] = (input[c] ? input[c][i] : 0) * gain;
    }
    this._env = env;
    this._gain = gain;
    this._hold = hold;
    return true;
  }
}

registerProcessor('vip-gate', GateProcessor);
