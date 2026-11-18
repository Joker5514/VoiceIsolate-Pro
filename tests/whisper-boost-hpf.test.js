/**
 * Whisper Boost Live-Mix high-pass (round 8, task 2).
 *
 * Whispered speech has no vocal-fold vibration, so there is no F0/harmonic
 * energy at the bottom of the spectrum and low-frequency power is weaker than
 * in phonated speech (Ito, Takeda & Itakura 2005, "Analysis and recognition of
 * whispered speech", Speech Communication 45(2):139-152,
 * doi:10.1016/j.specom.2003.10.005).
 * With the base 70 Hz HPF, kick/bass energy from a 0 dB music bed passes into
 * the Whisper Boost compressor (thresh -36 dB, 4.5:1) and pumps the whisper.
 * Measured locally (round8/hp-check-*): export render SI-SDR on the 0 dB
 * whisper+club mix -11.15 dB @70 Hz -> -8.30 dB @150 Hz.
 */
'use strict';

let PRESETS;
beforeAll(async () => {
  ({ CALIBRATED_ENGINEER_PRESETS: PRESETS } = await import('../src/core/PresetCalibration.js'));
});

describe('Whisper Boost high-pass', () => {
  test('Whisper Boost high-passes at >= 150 Hz (below whisper energy, above kick/bass fundamentals)', () => {
    expect(PRESETS['Whisper Boost'].hpFreq).toBeGreaterThanOrEqual(150);
    expect(PRESETS['Whisper Boost'].hpFreq).toBeLessThanOrEqual(200);
  });

  test('other presets keep their own high-pass (no base change)', () => {
    expect(PRESETS['Voice Clarity'].hpFreq).toBe(70);
    expect(PRESETS['Podcast Clean'].hpFreq).toBe(90);
  });
});
