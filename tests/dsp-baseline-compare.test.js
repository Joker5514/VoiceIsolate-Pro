/**
 * Re-runs the pre-fix worker and spectral helper from a320eb7f against the
 * working tree on identical synthetic signals. Fails if a measured defect
 * is still present, or if unity-mask reconstruction drops out of the
 * baseline's passing range.
 */
'use strict';

const { compare, verdict } = require('../scripts/quality/dsp-baseline-compare.cjs');

describe('DSP baseline versus current tree', () => {
  let report;
  let judged;

  beforeAll(async () => {
    report = await compare();
    judged = verdict(report);
  }, 120000);

  test('downward formant shift no longer deletes the upper spectrum', () => {
    expect(judged.formantDefectEliminated).toBe(true);
    expect(judged.formantControlStillMovesLowerSpectrum).toBe(true);
  });

  test('a non-finite mask no longer writes NaN and keeps the input', () => {
    expect(judged.nonFiniteMaskNoLongerPoisons).toBe(true);
    expect(judged.nonFiniteMaskPreservesInput).toBe(true);
  });

  test('a mask above 1 no longer amplifies', () => {
    expect(judged.overrangeMaskNoLongerAmplifies).toBe(true);
  });

  test('a short clean stem no longer writes NaN into the residual', () => {
    expect(judged.residualNaNEliminated).toBe(true);
    expect(report.operations.shortCleanResidual.candidate).toEqual([0, -0.25, 0.125, 0.0625]);
  });

  test('unity-mask reconstruction stays in the baseline passing range', () => {
    expect(judged.unityReconstructionHeld).toBe(true);
  });

  test('noise reduction and listening quality are not claimed', () => {
    expect(judged.noiseReduction).toMatch(/unverified/);
    expect(judged.perceptual).toMatch(/unverified/);
    expect(judged.performance).toMatch(/vm harness only/);
  });
});
