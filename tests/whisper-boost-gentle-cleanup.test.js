/**
 * Whisper Boost cleanup leak (round 9, t26u item 4b).
 *
 * Whisper energy in the Removed (Delta) stem, 0 dB whisper + club mix, real app,
 * WASM ORT, on the #944 + #945 chain: bsrnn_vocals mask alone 23.9 %, the
 * Whisper Boost Process-time cleanup raised it to 37.3 %. A sweep of the cleanup
 * controls found the extra leak comes from Process-time NR (nrAmount 55) and the
 * formant tunnel (voiceTunnel 65). nrAmount 30 + voiceTunnel 0 cuts the leak to
 * 27.0 % (whisper only: 36.6 -> 26.3 %), keeps 1.7 dB more whisper in the stem,
 * and raises export SI-SDR on the mix (-1.70 -> -1.45 dB) and whisper only
 * (1.34 -> 1.57 dB). Stronger spectral subtraction trades residual noise for
 * speech distortion, which is why a spectral floor bounds it (Berouti, Schwartz
 * & Makhoul 1979, ICASSP, doi:10.1109/ICASSP.1979.1170788); a whisper sits near
 * the noise level, so it is the first speech component the subtraction removes.
 */
'use strict';

let PRESETS;
beforeAll(async () => {
  ({ CALIBRATED_ENGINEER_PRESETS: PRESETS } = await import('../src/core/PresetCalibration.js'));
});

describe('Whisper Boost gentle cleanup', () => {
  test('Process-time NR is gentle (nrAmount <= 30)', () => {
    expect(PRESETS['Whisper Boost'].nrAmount).toBeLessThanOrEqual(30);
  });
  test('formant tunnel is off', () => {
    expect(PRESETS['Whisper Boost'].voiceTunnel).toBe(0);
  });
  test('other presets keep their NR', () => {
    expect(PRESETS['Aggressive Isolate'].nrAmount).toBeGreaterThan(30);
  });
});
