'use strict';

const fs = require('fs');
const path = require('path');

const processorSource = fs.readFileSync(path.join(__dirname, '../public/app/dsp-processor.js'), 'utf8');

const FFT_SIZE   = 4096;
const HOP_SIZE   = 1024;
const HALF_BINS  = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 5;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
const Q          = 128;  // AudioWorklet quantum size

describe('dsp-processor AudioWorklet behavior', () => {
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
    // inputSAB includes mag + pha + PCM region to match the full protocol layout
    const inputSAB  = new SharedArrayBuffer(SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * (HALF_BINS * 2 + HOP_SIZE));
    const outputSAB = new SharedArrayBuffer(SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS);
    return { inputSAB, outputSAB };
  }

  function initSAB(processor, { inputSAB, outputSAB }) {
    // dsp-processor.js wires SABs via an 'initSAB' port message; this mirrors
    // what the main thread sends via _forwardSabToWorker.
    processor.port.onmessage({ data: { type: 'initSAB', inputSAB, outputSAB } });
  }

  test('exposes a port message handler after registration', () => {
    const processor = loadProcessor();
    expect(typeof processor.port.onmessage).toBe('function');
  });

  test('starts compressor envelope at 0 dB and pre-fills ring pointers for deterministic startup', () => {
    const processor = loadProcessor();
    expect(processor._envDb).toBe(0);
    expect(processor._inRd).toBe(0);
    expect(processor._inWr).toBe(FFT_SIZE);
  });

  test('initSAB message wires both SABs and notifies main thread with sabReady', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });

    expect(processor._inputSAB).toBe(inputSAB);
    expect(processor._outputSAB).toBe(outputSAB);
    expect(processor.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sabReady', inputSAB, outputSAB })
    );
  });

  test('compKnee is accepted via params and clamped to [0,24]', () => {
    const processor = loadProcessor();
    processor.port.onmessage({ data: { type: 'params', payload: { compKnee: 40 } } });
    expect(processor._params.compKnee).toBe(24);
    processor.port.onmessage({ data: { type: 'params', payload: { compKnee: -4 } } });
    expect(processor._params.compKnee).toBe(0);
  });

  test('emits first FFT frame on the first process quantum after startup prefill', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });
    const flagsIn = new Int32Array(inputSAB, 0, FLAG_SLOTS);

    const inBlock = new Float32Array(Q).fill(0.05);
    const outBlock = new Float32Array(Q);
    processor.process([[inBlock]], [[outBlock]]);

    expect(Atomics.load(flagsIn, 0)).toBe(1);
  });

  test('advances the input frame counter once per completed FFT hop', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });

    const flagsIn = new Int32Array(inputSAB, 0, FLAG_SLOTS);

    // With HOP_SIZE-based triggering (FIX [2]), one frame per HOP_SIZE samples.
    // First frame emits after HOP_SIZE / Q quanta.
    const callsPerHop = HOP_SIZE / Q;      // 8

    for (let i = 0; i < callsPerHop; i++) {
      const inBlock  = new Float32Array(Q).fill(0.05);
      const outBlock = new Float32Array(Q);
      const keep = processor.process([[inBlock]], [[outBlock]]);
      expect(keep).toBe(true);
    }
    // First hop should have emitted exactly one counter bump.
    expect(Atomics.load(flagsIn, 0)).toBe(1);

    for (let i = 0; i < callsPerHop; i++) {
      processor.process([[new Float32Array(Q).fill(0.05)]], [[new Float32Array(Q)]]);
    }
    expect(Atomics.load(flagsIn, 0)).toBe(2);
  });

  test('pre-allocates scratch buffers in the constructor (no per-frame allocs)', () => {
    const processor = loadProcessor();
    expect(processor._monoScratch).toBeInstanceOf(Float32Array);
    expect(processor._monoScratch.length).toBe(Q);
    expect(processor._magScratch.length).toBe(HALF_BINS);
    expect(processor._maskedMagScratch.length).toBe(HALF_BINS);
    expect(processor._fallbackPostCount).toBe(0);
  });

  test('SAB fallback postMessage fires only while input readGen is 0, capped at 3', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });
    const flagsIn = new Int32Array(inputSAB, 0, FLAG_SLOTS);

    const callsPerHop = HOP_SIZE / Q;
    for (let hop = 0; hop < 4; hop++) {
      for (let i = 0; i < callsPerHop; i++) {
        processor.process([[new Float32Array(Q).fill(0.05)]], [[new Float32Array(Q)]]);
      }
    }

    const fallbackMsgs = processor.port.postMessage.mock.calls
      .filter((c) => c[0] && c[0].type === 'magnitude');
    expect(fallbackMsgs.length).toBe(3);
    expect(processor._fallbackPostCount).toBe(3);

    // Simulate ML consumer ack — further frames must not spam postMessage.
    Atomics.store(flagsIn, 1, Atomics.load(flagsIn, 0));
    processor.port.postMessage.mockClear();
    for (let i = 0; i < callsPerHop; i++) {
      processor.process([[new Float32Array(Q).fill(0.05)]], [[new Float32Array(Q)]]);
    }
    const afterAck = processor.port.postMessage.mock.calls
      .filter((c) => c[0] && c[0].type === 'magnitude');
    expect(afterAck.length).toBe(0);
  });

  test('consumes the mask write-generation flag and acks it on the read slot', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });

    const flagsOut = new Int32Array(outputSAB, 0, FLAG_SLOTS);
    const mask = new Float32Array(outputSAB, SAB_HEADER_BYTES, HALF_BINS);
    mask.fill(1);

    // Simulate ML worker publishing one mask generation.
    Atomics.store(flagsOut, 0, 1);  // writeGen
    // flagsOut[1] (readGen) starts at 0.

    // Drive enough samples to produce one frame.
    const callsToFirstFrame = FFT_SIZE / Q;
    for (let i = 0; i < callsToFirstFrame; i++) {
      processor.process([[new Float32Array(Q).fill(0.05)]], [[new Float32Array(Q)]]);
    }

    // After consuming the mask, readGen should match writeGen.
    expect(Atomics.load(flagsOut, 1)).toBe(1);
  });
});
