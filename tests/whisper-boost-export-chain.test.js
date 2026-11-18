/**
 * Whisper Boost export chain (round 9, t26u).
 *
 * Measured locally on the 0 dB whisper + 128 BPM club mix (real app, WASM ORT):
 * the Live-Mix render that Save Processed exports cost ~9 dB SI-SDR versus the
 * processed stem. Bypassing the compressor alone took the render from
 * -11.34 to -3.55 dB SI-SDR (STOI 0.827 -> 0.909); a flat EQ on top gave -2.68 dB.
 * A -36 dB / 4.5:1 compressor with +7 dB makeup lifts the music between
 * whisper phrases (music relative to whisper +11 dB vs the input). Compression
 * changes output SNR when the input SNR is low, by several dB for aggressive
 * settings (Naylor & Johannesson 2009, J Am Acad Audiol 20(3):161-171,
 * doi:10.3766/jaaa.20.3.2); in noise it gives no consistent benefit over linear
 * gain (Souza 2002, Trends Amplif 6(4):131-165, doi:10.1177/108471380200600402).
 * Peaks stay under the existing true-peak limiter ceiling.
 * PlaybackMixer._updateCompressorRouting routes the compressor in only when
 * ratio > 1, so ratio 1 is a true bypass (no added latency).
 */
'use strict';

const EQ = ['eqSub', 'eqBass', 'eqWarmth', 'eqBody', 'eqLowMid', 'eqMid', 'eqPresence', 'eqClarity', 'eqAir', 'eqBrill'];
let PRESETS; let engineerLevelOverrides;
beforeAll(async () => {
  ({ CALIBRATED_ENGINEER_PRESETS: PRESETS } = await import('../src/core/PresetCalibration.js'));
  ({ engineerLevelOverrides } = await import('../src/core/MixCalibration.js'));
});

describe('Whisper Boost export chain', () => {
  test('compressor is bypassed (ratio <= 1)', () => {
    expect(PRESETS['Whisper Boost'].compRatio).toBeLessThanOrEqual(1);
  });
  test('EQ is flat (no band boosts or cuts)', () => {
    for (const k of EQ) expect([k, PRESETS['Whisper Boost'][k]]).toEqual([k, 0]);
  });
  test('whisper-level calibration overrides do not re-add EQ or compression', () => {
    const o = engineerLevelOverrides('whisper', -48);
    for (const k of EQ) if (k in o) expect([k, o[k]]).toEqual([k, 0]);
    if ('compRatio' in o) expect(o.compRatio).toBeLessThanOrEqual(1);
  });
  test('other presets keep their compression and EQ', () => {
    expect(PRESETS['Voice Clarity'].compRatio).toBe(3.5);
    expect(PRESETS['Podcast Clean'].compRatio).toBeGreaterThan(1);
    expect(PRESETS['Voice Clarity'].hpFreq).toBe(70);
  });
});
