'use strict';

const fs = require('fs');
const path = require('path');

const processorSource = fs.readFileSync(path.join(__dirname, '../public/app/dsp-processor.js'), 'utf8');

describe('dsp-processor AudioWorklet behavior', () => {
  function loadProcessor(processorOptions = {}) {
    let RegisteredProcessor = null;
    class AudioWorkletProcessor {
      constructor() {
        this.port = {
          onmessage: null,
          addEventListener: jest.fn(),
          postMessage: jest.fn(),
        };
      }
    }
    const registerProcessor = (_name, clazz) => { RegisteredProcessor = clazz; };
    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', processorSource);
    fn(AudioWorkletProcessor, registerProcessor, 48000);
    return new RegisteredProcessor({ processorOptions });
  }

  test('drains overlap-add leftovers when process() receives no input frames', () => {
    const processor = loadProcessor();
    processor._outBuf[0] = 0.5;
    processor._outWindowSum[0] = 0.25;
    processor._readPos = 0;

    const out = [[new Float32Array(1)]];
    const keepAlive = processor.process([], out);

    expect(keepAlive).toBe(true);
    expect(out[0][0][0]).toBeCloseTo(2.0, 6);
    expect(processor._outBuf[0]).toBe(0);
    expect(processor._outWindowSum[0]).toBe(0);
  });

  test('disconnect message resets SAB frame/write cursor state', () => {
    const numBins = 2049;
    const sabBytes = numBins * Float32Array.BYTES_PER_ELEMENT + 4 * Int32Array.BYTES_PER_ELEMENT;
    const inputSAB = new SharedArrayBuffer(sabBytes);
    const outputSAB = new SharedArrayBuffer(sabBytes);
    const processor = loadProcessor({ inputSAB, outputSAB });

    const flagsIn = new Int32Array(inputSAB, numBins * 4, 4);
    const flagsOut = new Int32Array(outputSAB, numBins * 4, 4);
    Atomics.store(flagsIn, 0, 9);
    Atomics.store(flagsIn, 1, 7);
    Atomics.store(flagsOut, 1, 1);

    processor.port.onmessage({ data: { type: 'disconnect' } });

    expect(Atomics.load(flagsIn, 0)).toBe(0);
    expect(Atomics.load(flagsIn, 1)).toBe(0);
    expect(Atomics.load(flagsOut, 1)).toBe(0);
  });
});
