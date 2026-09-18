/**
 * VoiceIsolate Pro — ProcessingController contract tests
 *
 * Pins the Raw / Processed / Removed (delta) workflow from PR #821:
 *  - Raw stays immutable: cloning on ingest, no aliasing of caller arrays,
 *    and getRaw() returns defensive copies.
 *  - Removed is derived as raw − processed, sample for sample, including
 *    the tail when processed is shorter than raw.
 */
'use strict';

let ProcessingController;
let ComparisonModes;

beforeAll(async () => {
  const mod = await import('../src/core/audio/processing/ProcessingController.js');
  ProcessingController = mod.ProcessingController;
  const tokens = await import('../src/ui/tokens/design-tokens.js');
  ComparisonModes = tokens.ComparisonModes;
});

/** Minimal store stub recording controller → store calls. */
function makeStoreStub() {
  const calls = { applyProcessing: [], processingState: [] };
  return {
    calls,
    applyProcessing(update) { calls.applyProcessing.push(update); },
    setProcessingState(state, progress, stage) { calls.processingState.push({ state, progress, stage }); },
    getState() { return { processing: { sampleRate: 48000 } }; },
  };
}

function toFixed(arr, digits = 6) {
  return Array.from(arr, (v) => Number(v.toFixed(digits)));
}

describe('raw immutability', () => {
  test('setRaw deep-clones: mutating the caller array afterwards leaves raw untouched', () => {
    const controller = new ProcessingController(null);
    const raw = [Float32Array.from([0.5, -0.25, 0.125, -0.0625])];
    controller.setRaw(raw, 48000);

    raw[0][0] = 999; // caller trashes its own array

    expect(toFixed(controller.getRaw()[0])).toEqual([0.5, -0.25, 0.125, -0.0625]);
  });

  test('getRaw returns a defensive copy: mutating it does not leak back in', () => {
    const controller = new ProcessingController(null);
    controller.setRaw([Float32Array.from([0.1, 0.2, 0.3])], 48000);

    const first = controller.getRaw();
    first[0][1] = -1;

    expect(toFixed(controller.getRaw()[0])).toEqual([0.1, 0.2, 0.3]);
  });

  test('raw is still byte-identical after setProcessed', () => {
    const controller = new ProcessingController(null);
    const rawValues = [0.5, -0.25, 0.125, -0.0625];
    controller.setRaw([Float32Array.from(rawValues)], 48000);
    controller.setProcessed([Float32Array.from([0.25, -0.125, 0.0625, -0.03125])], 48000);

    expect(toFixed(controller.getRaw()[0])).toEqual(rawValues);
  });
});

describe('removed = raw − processed', () => {
  test('sample-wise delta for equal-length stems', () => {
    const controller = new ProcessingController(null);
    const raw = Float32Array.from([0.8, -0.6, 0.4, -0.2, 0.1]);
    const processed = Float32Array.from([0.5, -0.5, 0.4, 0.0, 0.1]);
    controller.setRaw([raw.slice()], 48000);
    controller.setProcessed([processed.slice()], 48000);

    const removed = controller.getRemoved();
    expect(removed.length).toBe(1);
    expect(toFixed(removed[0])).toEqual([0.3, -0.1, 0.0, -0.2, 0.0]);

    // removed + processed reconstructs raw
    for (let i = 0; i < raw.length; i++) {
      expect(removed[0][i] + processed[i]).toBeCloseTo(raw[i], 6);
    }
  });

  test('when processed is shorter, the raw tail counts as fully removed', () => {
    const controller = new ProcessingController(null);
    controller.setRaw([Float32Array.from([0.4, 0.3, 0.2, 0.1])], 48000);
    controller.setProcessed([Float32Array.from([0.4, 0.2])], 48000);

    expect(toFixed(controller.getRemoved()[0])).toEqual([0.0, 0.1, 0.2, 0.1]);
  });

  test('getBufferForMode serves the right stem per comparison mode', () => {
    const controller = new ProcessingController(null);
    controller.setRaw([Float32Array.from([1, 1])], 48000);
    controller.setProcessed([Float32Array.from([0.5, 0.5])], 48000);

    expect(toFixed(controller.getBufferForMode(ComparisonModes.RAW)[0])).toEqual([1, 1]);
    expect(toFixed(controller.getBufferForMode(ComparisonModes.PROCESSED)[0])).toEqual([0.5, 0.5]);
    expect(toFixed(controller.getBufferForMode(ComparisonModes.REMOVED)[0])).toEqual([0.5, 0.5]);
  });
});

describe('store integration', () => {
  test('setRaw reports raw_set and setProcessed pushes cloned buffers to the store', () => {
    const store = makeStoreStub();
    const controller = new ProcessingController(store);

    controller.setRaw([Float32Array.from([0.5, 0.5])], 48000);
    expect(store.calls.processingState[0]).toMatchObject({ state: 'idle', stage: 'raw_set' });

    controller.setProcessed([Float32Array.from([0.25, 0.25])], 44100);
    expect(store.calls.applyProcessing.length).toBe(1);
    const update = store.calls.applyProcessing[0];
    expect(update.sampleRate).toBe(44100);
    expect(update.channels).toBe(1);
    expect(toFixed(update.processedBuffer[0])).toEqual([0.25, 0.25]);
    expect(toFixed(update.removedBuffer[0])).toEqual([0.25, 0.25]);

    // The buffers handed to the store are clones — mutating them must not
    // corrupt the controller's own stems.
    update.processedBuffer[0][0] = 999;
    update.removedBuffer[0][0] = 999;
    expect(toFixed(controller.getProcessed()[0])).toEqual([0.25, 0.25]);
    expect(toFixed(controller.getRemoved()[0])).toEqual([0.25, 0.25]);
  });
});
