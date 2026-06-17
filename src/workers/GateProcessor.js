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
    ];
  }

  constructor() {
    super();
    this._env = 0;  // envelope-follower state (linear)
    this._gain = 1; // smoothed gate gain (linear)
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const nCh = input.length;
    const nSamp = input[0].length;

    const rangeDb = parameters.range[0];
    // Bypass fast-path: range 0 → never attenuate → pass through untouched.
    if (rangeDb <= 0) {
      for (let c = 0; c < nCh; c++) output[c].set(input[c]);
      this._env = 0;
      this._gain = 1;
      return true;
    }

    const thrLin = Math.pow(10, parameters.threshold[0] / 20);
    const floor = Math.pow(10, -rangeDb / 20); // gain when fully closed
    // One-pole envelope/gain coefficients from the time constants (per sample).
    const atk = Math.exp(-1 / (Math.max(0.05, parameters.attack[0]) * 0.001 * sampleRate));
    const rel = Math.exp(-1 / (Math.max(1, parameters.release[0]) * 0.001 * sampleRate));

    let env = this._env;
    let gain = this._gain;
    for (let i = 0; i < nSamp; i++) {
      // Control signal = peak across channels (keeps L/R gated together).
      let x = 0;
      for (let c = 0; c < nCh; c++) {
        const a = Math.abs(input[c][i]);
        if (a > x) x = a;
      }
      // Fast-attack / slow-release envelope follower.
      env = x > env ? atk * env + (1 - atk) * x : rel * env + (1 - rel) * x;
      const target = env >= thrLin ? 1 : floor;
      // Ramp the gain toward the target (attack when opening, release when closing).
      const coef = target > gain ? atk : rel;
      gain = coef * gain + (1 - coef) * target;
      for (let c = 0; c < nCh; c++) output[c][i] = input[c][i] * gain;
    }
    this._env = env;
    this._gain = gain;
    return true;
  }
}

registerProcessor('vip-gate', GateProcessor);
