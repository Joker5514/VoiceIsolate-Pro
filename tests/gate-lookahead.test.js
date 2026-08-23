/** Active GateProcessor lookahead contract — no legacy dsp-processor involved. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGateProcessor() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/workers/GateProcessor.js'), 'utf8');
  let Processor = null;
  class AudioWorkletProcessor {
    constructor() { this.port = { onmessage: null }; }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Math,
    Number,
    isFinite,
    sampleRate: 1000,
    registerProcessor: (_name, ctor) => { Processor = ctor; },
  });
  return Processor;
}

describe('GateProcessor lookahead', () => {
  test('declares the bounded AudioParam and delays audible audio while detector opens', () => {
    const GateProcessor = loadGateProcessor();
    const descriptor = GateProcessor.parameterDescriptors.find((item) => item.name === 'lookahead');
    expect(descriptor).toMatchObject({ minValue: 0, maxValue: 20, automationRate: 'k-rate' });

    const processor = new GateProcessor();
    const input = [Float32Array.from([1, 0, 0, 0, 0])];
    const output = [new Float32Array(input[0].length)];
    processor.process([input], [output], {
      threshold: new Float32Array([-20]),
      range: new Float32Array([0]),
      attack: new Float32Array([0]),
      release: new Float32Array([100]),
      hold: new Float32Array([10]),
      lookahead: new Float32Array([2]),
    });
    expect(output[0][0]).toBeCloseTo(0);
    expect(output[0][1]).toBeCloseTo(0);
    expect(output[0][2]).toBeGreaterThan(0.9);
  });

  test('honors canonical extrema and clears delayed samples on transport reset', () => {
    const GateProcessor = loadGateProcessor();
    const descriptors = GateProcessor.parameterDescriptors;
    expect(descriptors.find((item) => item.name === 'threshold')).toMatchObject({ minValue: -120, maxValue: 0 });
    expect(descriptors.find((item) => item.name === 'range')).toMatchObject({ minValue: 0, maxValue: 120 });

    const processor = new GateProcessor();
    const params = {
      threshold: new Float32Array([-120]), range: new Float32Array([120]),
      attack: new Float32Array([0]), release: new Float32Array([100]),
      hold: new Float32Array([0]), lookahead: new Float32Array([2]),
    };
    processor.process([[Float32Array.from([1, 0, 0, 0])]], [[new Float32Array(4)]], params);
    processor.port.onmessage({ data: { type: 'reset' } });
    const afterReset = [new Float32Array(4)];
    processor.process([[new Float32Array(4)]], [afterReset], params);
    expect(Array.from(afterReset[0])).toEqual([0, 0, 0, 0]);
  });
});
