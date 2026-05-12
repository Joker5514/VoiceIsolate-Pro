'use strict';

const fs = require('fs');
const path = require('path');

const dspStagesPath = path.join(__dirname, '../public/app/dsp-stages.js');
const dspStagesSrc = fs.readFileSync(dspStagesPath, 'utf8');
const dspStagesEvalSrc = dspStagesSrc.replace(/^export\s+/gm, '');

const DSPStages = new Function(
  `${dspStagesEvalSrc}\nreturn { applyStage, runFullPipeline, stageSpectralCompressor };`
)();

describe('dsp-stages', () => {
  test('runFullPipeline stage list contains 32 stages', () => {
    const listMatch = dspStagesSrc.match(/const stages = \[([\s\S]*?)\];/);
    expect(listMatch).not.toBeNull();
    const items = listMatch[1].match(/'[^']+'/g) || [];
    expect(items.length).toBe(32);
  });

  test('stageSpectralCompressor handles compKnee=0 without NaN/Infinity', () => {
    const mag = new Float32Array([0.01, 0.1, 0.2, 0.8, 1.2]);
    const pha = new Float32Array(mag.length);
    DSPStages.stageSpectralCompressor(mag, pha, {
      compThresh: -24,
      compRatio: 4,
      compKnee: 0,
      compMakeup: 0,
    });
    for (const v of mag) expect(Number.isFinite(v)).toBe(true);
  });

  test('runFullPipeline safety-clamps invalid magnitudes/phases by default', () => {
    const mag = new Float32Array([NaN, Infinity, -1, 0.5]);
    const pha = new Float32Array([NaN, 0, Infinity, 0]);
    const originalMag = new Float32Array([0.1, 0.1, 0.1, 0.1]);

    DSPStages.runFullPipeline(mag, pha, originalMag, {}, {}, 48000);

    for (const v of mag) expect(Number.isFinite(v)).toBe(true);
    for (const v of pha) expect(Number.isFinite(v)).toBe(true);
    expect(mag[2]).toBeGreaterThanOrEqual(0);
  });

  test('applyStage ignores unknown stage names without throwing', () => {
    const mag = new Float32Array([0.1, 0.2]);
    const pha = new Float32Array([0, 0]);
    expect(() => DSPStages.applyStage('does-not-exist', mag, pha, {}, 48000)).not.toThrow();
  });
});
