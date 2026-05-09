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

  test('uses context sampleRate for bin mapping in spectral band-pass', () => {
    const runWithSampleRate = (contextSampleRate) => {
      const processor = loadProcessor();
      processor.context.sampleRate = contextSampleRate;
      processor._params.lowCut = 4500;
      processor._params.highCut = 5500;
      processor._params.gate = 0;
      processor._params.noiseReduction = 0;
      processor._params.voiceBoost = 0;

      const output = new Float32Array(1024);
      for (let frame = 0; frame < 4; frame++) {
        const input = new Float32Array(1024);
        for (let i = 0; i < input.length; i++) {
          const idx = frame * input.length + i;
          input[i] = Math.sin((2 * Math.PI * 5000 * idx) / 44100);
        }
        processor.process([[input]], [[output]]);
      }
      let rms = 0;
      for (let i = 0; i < output.length; i++) rms += output[i] * output[i];
      return Math.sqrt(rms / output.length);
    };

    const rmsAt44100 = runWithSampleRate(44100);
    const rmsAt96000 = runWithSampleRate(96000);

    expect(rmsAt44100).toBeGreaterThan(rmsAt96000 * 1.5);
  });
});
