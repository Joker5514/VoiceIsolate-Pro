'use strict';

const fs = require('fs');
const path = require('path');

const processorSource = fs.readFileSync(path.join(__dirname, '../public/app/dsp-processor.js'), 'utf8');

const FFT_SIZE   = 4096;
const HOP_SIZE   = 1024;
const HALF_BINS  = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 4;
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
    const inputSAB  = new SharedArrayBuffer(SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * HALF_BINS * 2);
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

  test('advances the input frame counter once per completed FFT hop', () => {
    const processor = loadProcessor();
    const { inputSAB, outputSAB } = makeSABs();
    initSAB(processor, { inputSAB, outputSAB });

    const flagsIn = new Int32Array(inputSAB, 0, FLAG_SLOTS);

    // FFT_SIZE samples are needed before the first hop produces a frame.
    // After that, one frame per HOP_SIZE samples.
    const callsToFirstFrame = FFT_SIZE / Q;          // 32
    const callsPerSubsequentHop = HOP_SIZE / Q;      // 8

    for (let i = 0; i < callsToFirstFrame; i++) {
      const inBlock  = new Float32Array(Q).fill(0.05);
      const outBlock = new Float32Array(Q);
      const keep = processor.process([[inBlock]], [[outBlock]]);
      expect(keep).toBe(true);
    }
    // First frame should have emitted exactly one counter bump.
    expect(Atomics.load(flagsIn, 0)).toBe(1);

    for (let i = 0; i < callsPerSubsequentHop; i++) {
      processor.process([[new Float32Array(Q).fill(0.05)]], [[new Float32Array(Q)]]);
    }
    expect(Atomics.load(flagsIn, 0)).toBe(2);
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
