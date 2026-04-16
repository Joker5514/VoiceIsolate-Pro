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

  test('passes write-position snapshot into _processSpectralHop() at hop boundaries', () => {
    const processor = loadProcessor();
    const hopSpy = jest.fn();
    processor._processSpectralHop = hopSpy;

    const inputBlock = new Float32Array(1024).fill(0.1);
    const outputBlock = new Float32Array(1024);
    processor.process([[inputBlock]], [[outputBlock]]);
    const expectedSnapshot = processor._writePos;

    expect(hopSpy).toHaveBeenCalledTimes(1);
    expect(hopSpy).toHaveBeenCalledWith(expectedSnapshot);
  });

  test('VAD skips spectral processing and outputs silence for quiet frames', () => {
    const processor = loadProcessor();
    const hopSpy = jest.fn();
    processor._processSpectralHop = hopSpy;

    const inputBlock = new Float32Array(1024).fill(1e-5);
    const outputBlock = new Float32Array(1024);
    processor.process([[inputBlock]], [[outputBlock]]);

    expect(hopSpy).toHaveBeenCalledTimes(0);
    for (let i = 0; i < outputBlock.length; i++) {
      expect(outputBlock[i]).toBe(0);
    }
  });

  test('clears de-ess hysteresis latch when de-essing is disabled', () => {
    const processor = loadProcessor();
    processor._deEssActive[0] = true;
    processor._params.deEssAmt = 0;

    const inputBlock = new Float32Array([0.25]);
    const outputBlock = new Float32Array(1);
    processor.process([[inputBlock]], [[outputBlock]]);

    expect(processor._deEssActive[0]).toBe(false);
  });

  test('SPECTRAL_FRAME RMS is computed from spectral magnitude data', () => {
    const processor = loadProcessor();
    processor._spectralFrameInterval = 1;
    processor._writePos = 0;

    for (let i = 0; i < processor._inBuf.length; i++) {
      processor._inBuf[i] = Math.sin((2 * Math.PI * i) / 64) * 0.5;
    }

    processor._processSpectralHop(0);

    const frameCall = processor.port.postMessage.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg?.type === 'SPECTRAL_FRAME');
    expect(frameCall).toBeTruthy();
    expect(frameCall.rms).toBeCloseTo(processor._calcRMS(frameCall.mag), 8);
    expect(Math.abs(frameCall.rms - processor._calcRMS(processor._reBuffer))).toBeGreaterThan(1e-6);
  });

  test('harmonic enhancement stays finite at extreme amplitudes', () => {
    const processor = loadProcessor();
    processor._params.harmRecov = 100;
    processor._params.harmOrder = 8;
    processor._spectralFrameInterval = 1;

    for (let i = 0; i < processor._inBuf.length; i++) {
      processor._inBuf[i] = 1e6;
    }

    processor._processSpectralHop(0);
    for (let i = 0; i < processor._magBuffer.length; i++) {
      expect(Number.isFinite(processor._magBuffer[i])).toBe(true);
    }
  });

  test('spectral subtraction keeps a non-zero absolute floor under heavy suppression', () => {
    const processor = loadProcessor();
    processor._params.nrAmount = 100;
    processor._params.nrSpectralSub = 100;
    processor._params.nrSensitivity = 100;
    processor._params.nrSmoothing = 0;
    processor._params.nrFloor = -120;
    processor._params.harmRecov = 0;

    processor._inBuf.fill(0);
    processor._processSpectralHop(0);

    let minMag = Infinity;
    for (let i = 0; i < processor._magBuffer.length; i++) {
      if (processor._magBuffer[i] < minMag) minMag = processor._magBuffer[i];
    }
    expect(minMag).toBeGreaterThan(0);
  });
});
