'use strict';
/**
 * Fixture matrix shared by the quality report and its Jest regression gate.
 * Each scenario returns { input, ref, active, kind } where ref is the
 * ground-truth target (the dry voice) or null for no-target scenarios.
 */
const S = require('./lib/signals.cjs');

function scenarios(seconds = 6) {
  const n = Math.round(seconds * S.SR);
  const voice = () => S.talker({ seconds, seed: 11, f0: 125 });
  const list = [];
  const add = (id, label, build, kind = 'separation') => list.push({ id, label, kind, build });

  add('clean-speech', 'Clean speech (no noise)', () => {
    const v = voice();
    return { input: v.signal, ref: v.signal, active: v.active, fricative: v.fricative };
  }, 'preservation');
  add('white-5db', 'Broadband white noise, 5 dB SNR', () => {
    const v = voice();
    const m = S.mixAtSnr(v.signal, S.whiteNoise(n, 101), 5, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('hvac-5db', 'Fan/HVAC rumble + hiss, 5 dB SNR', () => {
    const v = voice();
    const m = S.mixAtSnr(v.signal, S.hvac(n, 102), 5, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('hum-10db', '60 Hz hum + 4 harmonics, 10 dB SNR', () => {
    const v = voice();
    const m = S.mixAtSnr(v.signal, S.hum(n, 60), 10, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('music-0db', 'Instrumental bed (sawtooth triads), 0 dB SNR', () => {
    const v = voice();
    const m = S.mixAtSnr(v.signal, S.music(n, 103), 0, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('babble-0db', 'Two background talkers, 0 dB SNR', () => {
    const v = voice();
    const a = S.talker({ seconds, seed: 23, f0: 190, formantScale: 1.15 }).signal;
    const b = S.talker({ seconds, seed: 37, f0: 105, formantScale: 0.92 }).signal;
    const bed = new Float32Array(n);
    for (let i = 0; i < n; i++) bed[i] = a[i] + b[i];
    const m = S.mixAtSnr(v.signal, bed, 0, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  }, 'competing-speech');
  add('reverb-0.5s', 'Room reverb RT60 0.5 s (target = dry)', () => {
    const v = voice();
    const wet = S.convolve(v.signal, S.roomIr(0.5, 104));
    return { input: wet, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('whisper-clean', 'Whisper only (no noise)', () => {
    const w = S.talker({ seconds, seed: 41, whisper: true });
    return { input: w.signal, ref: w.signal, active: w.active, fricative: w.fricative };
  }, 'preservation');
  add('whisper-white-10db', 'Whisper under white noise, 10 dB SNR', () => {
    const w = S.talker({ seconds, seed: 41, whisper: true });
    const m = S.mixAtSnr(w.signal, S.whiteNoise(n, 105), 10, w.active);
    return { input: m.mix, ref: w.signal, active: w.active, fricative: w.fricative };
  });
  add('whisper-music-5db', 'Whisper under music, 5 dB SNR', () => {
    const w = S.talker({ seconds, seed: 41, whisper: true });
    const m = S.mixAtSnr(w.signal, S.music(n, 106), 5, w.active);
    return { input: m.mix, ref: w.signal, active: w.active, fricative: w.fricative };
  });
  add('quiet-hum', 'Quiet speech (-40 dBFS) + 60 Hz hum, 10 dB SNR', () => {
    const v = voice();
    S.normalizeRms(v.signal, -40, v.active);
    const m = S.mixAtSnr(v.signal, S.hum(n, 60), 10, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  });
  add('overlap-2spk', 'Two overlapping talkers, 0 dB (target = A)', () => {
    const v = voice();
    const b = S.talker({ seconds, seed: 53, f0: 200, formantScale: 1.18 }).signal;
    const m = S.mixAtSnr(v.signal, b, 0, v.active);
    return { input: m.mix, ref: v.signal, active: v.active, fricative: v.fricative };
  }, 'competing-speech');
  add('clipped', 'Clipped speech (x4, hard clip at 0.3)', () => {
    const v = voice();
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.max(-0.3, Math.min(0.3, v.signal[i] * 4));
    return { input: x, ref: x, active: v.active, fricative: v.fricative };
  }, 'preservation');
  add('silence', 'Digital silence', () => ({ input: new Float32Array(n), ref: null, active: null }), 'silence');
  add('noise-only', 'White noise only at -40 dBFS', () => {
    const x = S.normalizeRms(S.whiteNoise(n, 107), -40);
    return { input: x, ref: null, active: null };
  }, 'noise-only');
  return list;
}

module.exports = { scenarios };
