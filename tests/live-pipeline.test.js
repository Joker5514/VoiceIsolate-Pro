/**
 * LivePipeline — QuantumHopBridge integration tests
 */
'use strict';

import { QUANTUM, HOP_SIZE, FFT_SIZE_LIVE } from '../src/core/ring-buffer-constants.js';
import { LivePipeline } from '../src/pipeline/LivePipeline.js';

describe('LivePipeline', () => {
  test('fires onHop after QUANTA_PER_HOP quanta', () => {
    const pipeline = new LivePipeline();
    const hops = [];
    pipeline.onHop((window, frameIndex) => {
      hops.push({ length: window.length, frameIndex });
    });

    const q = new Float32Array(QUANTUM).fill(0.5);
    for (let i = 0; i < 3; i++) pipeline.pushQuantum(q);
    expect(hops).toHaveLength(0);

    pipeline.pushQuantum(q);
    expect(hops).toHaveLength(1);
    expect(hops[0].length).toBe(FFT_SIZE_LIVE);
    expect(hops[0].frameIndex).toBe(0);
  });

  test('drainRingBuffer pulls quanta until empty', () => {
    const pipeline = new LivePipeline();
    let pulls = 0;
    const ring = {
      pull: (n) => {
        if (pulls >= 5) return null;
        pulls += 1;
        return new Float32Array(n).fill(pulls);
      },
    };

    const count = pipeline.drainRingBuffer(ring);
    expect(count).toBe(5);
    expect(pipeline.hopBridge.totalQuanta).toBe(5);
  });

  test('synthesis path accumulates grains', () => {
    const pipeline = new LivePipeline({ enableSynthesis: true, outputLength: 4096 });
    const grain = new Float32Array(FFT_SIZE_LIVE).fill(0.1);
    pipeline.addSynthesisGrain(grain, 0);
    pipeline.addSynthesisGrain(grain, 1);
    const out = pipeline.finalizeSynthesis();
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(4096);
    expect(pipeline.reconstructor.framesAdded).toBe(2);
  });

  test('uses blueprint live constants by default', () => {
    const pipeline = new LivePipeline();
    expect(pipeline.quantum).toBe(QUANTUM);
    expect(pipeline.hopSize).toBe(HOP_SIZE);
    expect(pipeline.fftSize).toBe(FFT_SIZE_LIVE);
  });
});