/**
 * Whisper Boost music controls.
 *
 * Round 9 (t26u) swept bassCrush {0,40,50,60} x musicKill {0,40,60,80} on a
 * synthetic 0 dB whisper + 128 BPM club mix and chose bassCrush 60 / musicKill 0.
 * Rule: maximise the whisper+club export SI-SDR without costing the whisper-only
 * processed stem more than 1 dB of whisper level.
 *
 * Round 11 (t29u) re-ran that rule on a real recorded whisper + club mix and its
 * whisper-only control (48 kHz, sample-aligned, 0 dB). Real app chain on 8f48d5f,
 * WASM ORT, Live-Mix render, nrAmount 30 / voiceTunnel 0, bassCrush swept:
 *
 *   bassCrush            0      20      30      40      50      60
 *   control stem whisper -4.05  -4.53   -5.46   -6.31   -7.33   -8.62 dB
 *   whisper in Removed   13.7   16.3    21.5    26.4    32.2    39.3 %
 *   mix export SI-SDR    -3.86  -3.61   -3.74   -3.80   -3.91   -4.07 dB
 *   control export SI-SDR -0.18 -0.18   -0.24   -0.30   -0.38   -0.47 dB
 *
 * A real whisper carries more low-frequency breath energy than the synthetic
 * one, so bassCrush 60 cost the real whisper-only stem 4.6 dB and put ~40 % of
 * the whisper energy into the Removed stem. Only bassCrush <= 20 meets the 1 dB
 * rule on the real control; of those, 20 gives the best mix export SI-SDR.
 * Trade-off: the synthetic mix export drops 0.86 dB (-1.45 -> -2.31); the
 * synthetic soft-speech mix gains 0.15 dB (2.50 -> 2.65).
 */
'use strict';

let PRESETS; let S;
beforeAll(async () => {
  ({ CALIBRATED_ENGINEER_PRESETS: PRESETS } = await import('../src/core/PresetCalibration.js'));
  S = await import('../src/core/ParameterSchema.js');
});

describe('Whisper Boost music controls', () => {
  test('sets bassCrush 20 (real-whisper retention rule) and leaves musicKill off', () => {
    expect(PRESETS['Whisper Boost'].bassCrush).toBe(20);
    expect(PRESETS['Whisper Boost'].musicKill).toBe(0);
  });
  test('bassCrush reaches the Process-time spectral config (wired)', () => {
    const cfg = S.buildMlProcessingConfig({ ...PRESETS['Whisper Boost'] });
    expect(cfg.spectral.bassCrush).toBe(20);
  });
  test('other presets keep their music controls', () => {
    expect(PRESETS['Voice Clarity'].bassCrush).toBe(0);
    expect(PRESETS['Aggressive Isolate'].bassCrush).toBe(70);
    expect(PRESETS['Aggressive Isolate'].musicKill).toBe(82);
  });
});
