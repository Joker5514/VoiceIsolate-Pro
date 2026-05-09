'use strict';

const fs = require('fs');
const path = require('path');

const processorSource = fs.readFileSync(path.join(__dirname, '../public/app/dsp-processor.js'), 'utf8');

describe('dsp-processor AudioWorklet behavior', () => {
  function loadProcessor(processorOptions = {}) {
    let RegisteredProcessor = null;
    class AudioWorkletProcessor {
      constructor() {
        this.context = { sampleRate: 44100 };
        this.port = {
          onmessage: null,
          postMessage: jest.fn(),
        };
      }
    }
    const registerProcessor = (_name, clazz) => { RegisteredProcessor = clazz; };
    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', processorSource);
    fn(AudioWorkletProcessor, registerProcessor, 48000);
    return new RegisteredProcessor({ processorOptions });
  }

  test('allocates fallback dual SABs and notifies main thread', () => {
    const processor = loadProcessor();

    expect(processor._inputSAB).toBeInstanceOf(SharedArrayBuffer);
    expect(processor._outputSAB).toBeInstanceOf(SharedArrayBuffer);
    expect(processor.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'sabReady',
        inputSAB: processor._inputSAB,
        outputSAB: processor._outputSAB,
      })
    );
  });

  test('uses provided SABs and advances frame counter once per hop', () => {
    const halfBins = 4096 / 2 + 1;
    const headerBytes = Int32Array.BYTES_PER_ELEMENT * 4;
    const inputSAB = new SharedArrayBuffer(headerBytes + Float32Array.BYTES_PER_ELEMENT * halfBins * 2);
    const outputSAB = new SharedArrayBuffer(headerBytes + Float32Array.BYTES_PER_ELEMENT * halfBins);
    const processor = loadProcessor({ sharedArrayBuffer: { inputSAB, outputSAB } });

    const flagsIn = new Int32Array(inputSAB, 0, 4);
    const inBlock = new Float32Array(1024).fill(0.05);
    const outBlock = new Float32Array(1024);

    const keepAlive = processor.process([[inBlock]], [[outBlock]]);

    expect(keepAlive).toBe(true);
    expect(Atomics.load(flagsIn, 0)).toBe(1);
  });

  test('consumes ready mask flag and clears it after hop processing', () => {
    const halfBins = 4096 / 2 + 1;
    const headerBytes = Int32Array.BYTES_PER_ELEMENT * 4;
    const inputSAB = new SharedArrayBuffer(headerBytes + Float32Array.BYTES_PER_ELEMENT * halfBins * 2);
    const outputSAB = new SharedArrayBuffer(headerBytes + Float32Array.BYTES_PER_ELEMENT * halfBins);
    const processor = loadProcessor({ sharedArrayBuffer: { inputSAB, outputSAB } });

    const flagsOut = new Int32Array(outputSAB, 0, 4);
    const mask = new Float32Array(outputSAB, headerBytes, halfBins);
    mask.fill(1);
    Atomics.store(flagsOut, 1, 1);

    const inBlock = new Float32Array(1024).fill(0.05);
    const outBlock = new Float32Array(1024);
    processor.process([[inBlock]], [[outBlock]]);

    expect(Atomics.load(flagsOut, 1)).toBe(0);
  });
});
