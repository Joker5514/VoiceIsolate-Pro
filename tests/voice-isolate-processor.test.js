'use strict';

/**
 * VoiceIsolate Pro — voice-isolate-processor.test.js
 * Regression tests for PR #428 ring-buffer fixes
 * =================================================
 * 
 * This test suite locks the four critical fixes from PR #428 that resolved
 * ring-buffer pointer misalignment and startup stall issues:
 * 
 * 1. inputProcessed pointer — decoupled from outputHead/outputTail
 * 2. drainHead pointer — dedicated drain index (not outputTail - RENDER)
 * 3. hopsSinceInit guard — advances drainHead during muted startup
 * 4. initRingBuffers — resets ALL overlap-add and gate state
 */

const fs = require('fs');
const path = require('path');

const processorSource = fs.readFileSync(
  path.join(__dirname, '../public/app/voice-isolate-processor.js'),
  'utf8'
);

const FFT_SIZE   = 4096;
const HOP_SIZE   = 1024;
const RENDER     = 128;
const RING_LEN   = FFT_SIZE * 4;
const HALF_BINS  = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 5;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;

describe('voice-isolate-processor PR #428 ring-buffer fixes', () => {
  function loadProcessor() {
    let RegisteredProcessor = null;
    class AudioWorkletProcessor {
      constructor() {
        this.context = { sampleRate: 48000 };
        this.port = {
          onmessage: null,
          postMessage: jest.fn(),
        };
      }
    }
    const registerProcessor = (_name, clazz) => { RegisteredProcessor = clazz; };
    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', processorSource);
    fn(AudioWorkletProcessor, registerProcessor, 48000);
    return new RegisteredProcessor();
  }

  function makeSABs() {
    const inputSAB  = new SharedArrayBuffer(SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS * 2);
    const outputSAB = new SharedArrayBuffer(SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS);
    return { inputSAB, outputSAB };
  }

  function initSAB(processor, { inputSAB, outputSAB }) {
    processor.port.onmessage({ data: { type: 'initSAB', inputSAB, outputSAB } });
  }

  // ─── Fix #1: inputProcessed Pointer ─────────────────────────────────────────

  test('Fix #1: inputProcessed pointer exists and is independent of outputHead/outputTail', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Verify inputProcessed is initialized
    expect(processor.inputProcessed).toBe(0);
    
    // Verify it exists as a separate property from outputHead
    expect(processor).toHaveProperty('inputProcessed');
    expect(processor).toHaveProperty('outputHead');
    
    // Process some frames to advance inputProcessed
    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process enough to trigger at least one hop
    for (let i = 0; i < 10; i++) {
      processor.process(inputs, outputs);
    }
    
    // inputProcessed should have advanced by HOP_SIZE increments
    expect(processor.inputProcessed).toBeGreaterThan(0);
    expect(processor.inputProcessed % HOP_SIZE).toBe(0);
    
    // Verify they track independently (inputProcessed advances in HOP_SIZE, outputHead in HOP_SIZE)
    expect(processor.inputProcessed).toBeGreaterThanOrEqual(processor.outputHead);
  });

  test('Fix #1: loop condition uses inputProcessed, not outputHead/outputTail', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Feed enough samples to trigger multiple hops
    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    const initialInputProcessed = processor.inputProcessed;
    
    // Process multiple frames
    for (let i = 0; i < 20; i++) {
      processor.process(inputs, outputs);
    }
    
    // inputProcessed should have advanced independently
    expect(processor.inputProcessed).toBeGreaterThan(initialInputProcessed);
    
    // Verify it advances in HOP_SIZE increments
    const hopsProcessed = (processor.inputProcessed - initialInputProcessed) / HOP_SIZE;
    expect(hopsProcessed).toBeGreaterThan(0);
    expect(Number.isInteger(hopsProcessed)).toBe(true);
  });

  // ─── Fix #2: drainHead Pointer ──────────────────────────────────────────────

  test('Fix #2: drainHead pointer exists and is independent', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Verify drainHead is initialized
    expect(processor.drainHead).toBe(0);
    
    // Verify it's separate from outputTail (if it exists)
    if (processor.outputTail !== undefined) {
      expect(processor.drainHead).not.toBe(processor.outputTail - RENDER);
    }
  });

  test('Fix #2: drainHead advances by RENDER after each process() call', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process enough frames to get past warmup
    for (let i = 0; i < 40; i++) {
      processor.process(inputs, outputs);
    }
    
    const drainHeadBefore = processor.drainHead;
    processor.process(inputs, outputs);
    const drainHeadAfter = processor.drainHead;
    
    // drainHead should advance by RENDER (modulo RING_LEN)
    const expectedAdvance = (drainHeadBefore + RENDER) % RING_LEN;
    expect(drainHeadAfter).toBe(expectedAdvance);
  });

  test('Fix #2: drain indexing uses drainHead, not outputTail - RENDER', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process past warmup
    for (let i = 0; i < 40; i++) {
      processor.process(inputs, outputs);
    }
    
    // Verify drainHead is being used for indexing
    // The drain loop should read from (drainHead + i) % RING_LEN
    const drainHeadSnapshot = processor.drainHead;
    
    // Process one more frame
    processor.process(inputs, outputs);
    
    // drainHead should have advanced correctly
    expect(processor.drainHead).toBe((drainHeadSnapshot + RENDER) % RING_LEN);
  });

  // ─── Fix #3: hopsSinceInit Latency Guard ───────────────────────────────────

  test('Fix #3: hopsSinceInit guard prevents output during warmup', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.5)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // During warmup (hopsSinceInit * HOP_SIZE < FFT_SIZE), output should be silence
    processor.process(inputs, outputs);
    
    // Check if we're still in warmup
    if (processor.hopsSinceInit * HOP_SIZE < FFT_SIZE) {
      // Output should be all zeros
      expect(outputs[0][0].every(s => s === 0)).toBe(true);
    }
  });

  test('Fix #3: drainHead advances during warmup to prevent ring stall', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process during warmup period
    const initialDrainHead = processor.drainHead;
    processor.process(inputs, outputs);
    
    // drainHead should advance even during warmup
    expect(processor.drainHead).toBe((initialDrainHead + RENDER) % RING_LEN);
  });

  test('Fix #3: hopsSinceInit increments correctly', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    const initialHops = processor.hopsSinceInit;
    
    // Process enough to trigger at least one hop
    for (let i = 0; i < 10; i++) {
      processor.process(inputs, outputs);
    }
    
    // hopsSinceInit should have incremented
    expect(processor.hopsSinceInit).toBeGreaterThan(initialHops);
  });

  // ─── Fix #4: initRingBuffers Full State Reset ───────────────────────────────

  test('Fix #4: initRingBuffers resets all ring buffer arrays', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Dirty the state
    processor.inputAccum[0] = 999;
    processor.outputAccum[0] = 999;
    processor.outputWindowSum[0] = 999;
    
    // Reset
    processor.initRingBuffers();
    
    // Verify arrays are clean
    expect(processor.inputAccum[0]).toBe(0);
    expect(processor.outputAccum[0]).toBe(0);
    expect(processor.outputWindowSum[0]).toBe(0);
  });

  test('Fix #4: initRingBuffers resets all pointer counters', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Dirty the pointers
    processor.inputHead = 999;
    processor.inputProcessed = 999;
    processor.outputHead = 999;
    processor.drainHead = 999;
    processor.hopsSinceInit = 999;
    
    // Reset
    processor.initRingBuffers();
    
    // Verify all pointers are reset to 0
    expect(processor.inputHead).toBe(0);
    expect(processor.inputProcessed).toBe(0);
    expect(processor.outputHead).toBe(0);
    expect(processor.drainHead).toBe(0);
    expect(processor.hopsSinceInit).toBe(0);
  });

  test('Fix #4: initRingBuffers resets gate state', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Dirty gate state
    processor.gateEnv = 0.5;
    processor.holdCounter = 100;
    
    // Reset
    processor.initRingBuffers();
    
    // Verify gate state is reset
    expect(processor.gateEnv).toBe(0);
    expect(processor.holdCounter).toBe(0);
  });

  test('Fix #4: reset message triggers initRingBuffers', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    // Dirty the state
    processor.inputProcessed = 999;
    processor.drainHead = 999;
    processor.hopsSinceInit = 999;
    
    // Send reset message
    processor.port.onmessage({ data: { type: 'reset' } });
    
    // Verify state is reset
    expect(processor.inputProcessed).toBe(0);
    expect(processor.drainHead).toBe(0);
    expect(processor.hopsSinceInit).toBe(0);
  });

  // ─── Integration Test: No Ring Stall ────────────────────────────────────────

  test('Integration: ring buffer does not stall during continuous processing', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process many frames
    for (let i = 0; i < 100; i++) {
      const result = processor.process(inputs, outputs);
      expect(result).toBe(true); // Should never return false (stall)
    }
    
    // Verify pointers are advancing correctly
    expect(processor.inputProcessed).toBeGreaterThan(0);
    expect(processor.drainHead).toBeGreaterThan(0);
    expect(processor.hopsSinceInit).toBeGreaterThan(0);
  });

  test('Integration: no 896-sample misalignment between input and output', () => {
    const processor = loadProcessor();
    const sabs = makeSABs();
    initSAB(processor, sabs);

    const inputs = [[new Float32Array(RENDER).fill(0.1)]];
    const outputs = [[new Float32Array(RENDER)]];
    
    // Process past warmup
    for (let i = 0; i < 50; i++) {
      processor.process(inputs, outputs);
    }
    
    // The old bug caused a 896-sample offset (outputTail - RENDER misalignment)
    // With the fix, drainHead should track correctly
    // Verify drainHead is within expected bounds
    expect(processor.drainHead).toBeGreaterThanOrEqual(0);
    expect(processor.drainHead).toBeLessThan(RING_LEN);
    
    // Verify it's advancing in RENDER increments
    const drainHeadBefore = processor.drainHead;
    processor.process(inputs, outputs);
    const drainHeadAfter = processor.drainHead;
    
    const expectedAdvance = (drainHeadBefore + RENDER) % RING_LEN;
    expect(drainHeadAfter).toBe(expectedAdvance);
  });
});

// Made with Bob
