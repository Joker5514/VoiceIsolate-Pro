'use strict';
/**
 * MLWorker runs the composite DeepFilterNet3 entry: three pinned part
 * sessions, the DeepFilterNet.js helper, the residual noise stem.
 */
const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');
const S = require('../scripts/quality/lib/signals.cjs');
const M = require('../scripts/quality/lib/metrics.cjs');

let worker;
beforeAll(async () => { worker = await createMlWorker(); });

describe('MLWorker deepfilternet strategy', () => {
  it('processes stereo through the composite entry; noise stem is the residual', async () => {
    const v = S.talker({ seconds: 1, seed: 5 });
    const left = S.mixAtSnr(v.signal, S.whiteNoise(v.signal.length, 6), 5, v.active).mix;
    const right = S.mixAtSnr(v.signal, S.whiteNoise(v.signal.length, 9), 5, v.active).mix;
    const out = await worker.separate([left, right], { modelIds: ['deepfilternet3'] });
    expect(out.pipelineMode).toBe('serial-mixed');
    expect(out.modelChain).toEqual(['deepfilternet3']);
    expect(Object.keys(out.sessionBackends)).toEqual(['deepfilternet3']);
    expect(out.appliedProcessingConfigRevision).toBeNull();
    for (const [ch, input] of [left, right].entries()) {
      expect(out.clean[ch].length).toBe(input.length);
      expect(M.nonFinite(out.clean[ch])).toBe(0);
      for (const i of [0, 1000, 30000, input.length - 1]) {
        expect(out.noise[ch][i]).toBeCloseTo(input[i] - out.clean[ch][i], 6);
      }
    }
  });

  it('suppresses a noise-only input by more than 20 dB', async () => {
    const noise = S.whiteNoise(48000, 12);
    const out = await worker.separate([noise], { modelIds: ['deepfilternet3'] });
    expect(M.rmsDb(noise) - M.rmsDb(out.clean[0])).toBeGreaterThan(20);
  });

  it('refuses a part entry on its own and a non-48 kHz input', async () => {
    const x = new Float32Array(4800);
    await expect(worker.separate([x], { modelIds: ['dfn3_enc'] })).rejects.toThrow(/part of a composite/);
    await expect(worker.separate([x], { modelIds: ['deepfilternet3'], sampleRate: 44100 })).rejects.toThrow(/expects 48000 Hz/);
  });
});
