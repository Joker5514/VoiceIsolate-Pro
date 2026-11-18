/**
 * Whisper Boost music controls (round 9, t26u item 1).
 *
 * Sweep on the 0 dB whisper + 128 BPM club mix and two controls (whisper only,
 * soft speech + club), real app, WASM ORT, Live-Mix render with the #944 chain:
 *   bassCrush {0,40,50,60} x musicKill {0,40,60,80}.
 * Rule: maximise the whisper+club export SI-SDR without lowering whisper-only
 * export SI-SDR and without costing the whisper-only processed stem more than
 * 1 dB of whisper level. bassCrush 60 / musicKill 0 is the best pair that meets it
 * (mix -2.68 -> -1.70 dB, whisper-only 1.25 -> 1.34 dB; musicKill >= 40 costs the
 * whisper-only stem > 1 dB of whisper level).
 * Whispers carry no F0 energy (Ito, Takeda & Itakura 2005, Speech Commun.
 * 45(2):139-152), so a sub/kick cut removes masking without removing the whisper.
 */
'use strict';

let PRESETS; let S;
beforeAll(async () => {
  ({ CALIBRATED_ENGINEER_PRESETS: PRESETS } = await import('../src/core/PresetCalibration.js'));
  S = await import('../src/core/ParameterSchema.js');
});

describe('Whisper Boost music controls', () => {
  test('sets bassCrush 60 and leaves musicKill off', () => {
    expect(PRESETS['Whisper Boost'].bassCrush).toBe(60);
    expect(PRESETS['Whisper Boost'].musicKill).toBe(0);
  });
  test('bassCrush reaches the Process-time spectral config (wired)', () => {
    const cfg = S.buildMlProcessingConfig({ ...PRESETS['Whisper Boost'] });
    expect(cfg.spectral.bassCrush).toBe(60);
  });
  test('other presets keep their music controls', () => {
    expect(PRESETS['Voice Clarity'].bassCrush).toBe(0);
    expect(PRESETS['Aggressive Isolate'].bassCrush).toBe(70);
    expect(PRESETS['Aggressive Isolate'].musicKill).toBe(82);
  });
});
