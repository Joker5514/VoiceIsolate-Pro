'use strict';
/**
 * Tests for shared-memory-schema.js
 * Validates that SAB layout constants are self-consistent and correctly sized.
 */

const path = require('path');

// Load the module in CJS mode
const schema = require(path.join(__dirname, '..', 'public/app/shared-memory-schema.js'));

describe('shared-memory-schema — constants', () => {
  test('FFT_SIZE is 4096', () => {
    expect(schema.FFT_SIZE).toBe(4096);
  });

  test('HOP_SIZE is 1024 (75% overlap)', () => {
    expect(schema.HOP_SIZE).toBe(1024);
  });

  test('HALF_BINS equals FFT_SIZE/2 + 1', () => {
    expect(schema.HALF_BINS).toBe(schema.FFT_SIZE / 2 + 1);
    expect(schema.HALF_BINS).toBe(2049);
  });

  test('RENDER_QUANTUM is 128 (Web Audio standard)', () => {
    expect(schema.RENDER_QUANTUM).toBe(128);
  });

  test('FLAG_SLOTS is 5', () => {
    expect(schema.FLAG_SLOTS).toBe(5);
  });

  test('SAB_HEADER_BYTES is FLAG_SLOTS * 4 bytes', () => {
    expect(schema.SAB_HEADER_BYTES).toBe(schema.FLAG_SLOTS * 4);
    expect(schema.SAB_HEADER_BYTES).toBe(20);
  });
});

describe('shared-memory-schema — SAB byte sizes', () => {
  test('INPUT_SAB_BYTES = header + mag + pha + pcm', () => {
    const expected = schema.SAB_HEADER_BYTES
      + schema.HALF_BINS * 4 * 2   // mag + pha
      + schema.HOP_SIZE  * 4;       // pcm
    expect(schema.INPUT_SAB_BYTES).toBe(expected);
  });

  test('OUTPUT_SAB_BYTES = header + mask only', () => {
    const expected = schema.SAB_HEADER_BYTES + schema.HALF_BINS * 4;
    expect(schema.OUTPUT_SAB_BYTES).toBe(expected);
  });

  test('INPUT_SAB_BYTES is larger than OUTPUT_SAB_BYTES', () => {
    expect(schema.INPUT_SAB_BYTES).toBeGreaterThan(schema.OUTPUT_SAB_BYTES);
  });
});

describe('shared-memory-schema — byte offsets', () => {
  test('MAG_BYTE_OFFSET starts right after the header', () => {
    expect(schema.MAG_BYTE_OFFSET).toBe(schema.SAB_HEADER_BYTES);
  });

  test('PHA_BYTE_OFFSET starts after mag region', () => {
    expect(schema.PHA_BYTE_OFFSET).toBe(schema.SAB_HEADER_BYTES + schema.HALF_BINS * 4);
  });

  test('PCM_BYTE_OFFSET starts after pha region', () => {
    expect(schema.PCM_BYTE_OFFSET).toBe(schema.SAB_HEADER_BYTES + schema.HALF_BINS * 4 * 2);
  });

  test('MASK_BYTE_OFFSET same as MAG_BYTE_OFFSET (mask is in output SAB position 0)', () => {
    expect(schema.MASK_BYTE_OFFSET).toBe(schema.SAB_HEADER_BYTES);
  });
});

describe('shared-memory-schema — flag slot indices', () => {
  test('FLAG_WRITE_GEN is 0', () => {
    expect(schema.FLAG_WRITE_GEN).toBe(0);
  });

  test('FLAG_READ_GEN is 1', () => {
    expect(schema.FLAG_READ_GEN).toBe(1);
  });

  test('FLAG_CAPACITY is 2', () => {
    expect(schema.FLAG_CAPACITY).toBe(2);
  });

  test('FLAG_HALF_N is 3', () => {
    expect(schema.FLAG_HALF_N).toBe(3);
  });

  test('all flag indices are unique', () => {
    const indices = [
      schema.FLAG_WRITE_GEN, schema.FLAG_READ_GEN,
      schema.FLAG_CAPACITY,  schema.FLAG_HALF_N, schema.FLAG_RESERVED
    ];
    const unique = new Set(indices);
    expect(unique.size).toBe(indices.length);
  });
});

describe('shared-memory-schema — validateSharedMemoryLayout', () => {
  const { validateSharedMemoryLayout, INPUT_SAB_BYTES, OUTPUT_SAB_BYTES } = schema;

  test('throws if inputSAB is not SharedArrayBuffer', () => {
    const outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
    expect(() => validateSharedMemoryLayout(new ArrayBuffer(INPUT_SAB_BYTES), outputSAB))
      .toThrow('inputSAB must be a SharedArrayBuffer');
  });

  test('throws if outputSAB is not SharedArrayBuffer', () => {
    const inputSAB = new SharedArrayBuffer(INPUT_SAB_BYTES);
    expect(() => validateSharedMemoryLayout(inputSAB, new ArrayBuffer(OUTPUT_SAB_BYTES)))
      .toThrow('outputSAB must be a SharedArrayBuffer');
  });

  test('throws if inputSAB has wrong byte length', () => {
    const inputSAB  = new SharedArrayBuffer(INPUT_SAB_BYTES - 1);
    const outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
    expect(() => validateSharedMemoryLayout(inputSAB, outputSAB))
      .toThrow(/inputSAB\.byteLength/);
  });

  test('throws if outputSAB has wrong byte length', () => {
    const inputSAB  = new SharedArrayBuffer(INPUT_SAB_BYTES);
    const outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES - 1);
    expect(() => validateSharedMemoryLayout(inputSAB, outputSAB))
      .toThrow(/outputSAB\.byteLength/);
  });

  test('does not throw for correctly-sized SABs', () => {
    const inputSAB  = new SharedArrayBuffer(INPUT_SAB_BYTES);
    const outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
    expect(() => validateSharedMemoryLayout(inputSAB, outputSAB)).not.toThrow();
  });
});

describe('shared-memory-schema — factory functions', () => {
  test('createInputSAB returns SharedArrayBuffer of correct size', () => {
    const sab = schema.createInputSAB();
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    expect(sab.byteLength).toBe(schema.INPUT_SAB_BYTES);
  });

  test('createOutputSAB returns SharedArrayBuffer of correct size', () => {
    const sab = schema.createOutputSAB();
    expect(sab).toBeInstanceOf(SharedArrayBuffer);
    expect(sab.byteLength).toBe(schema.OUTPUT_SAB_BYTES);
  });

  test('createInputSAB + createOutputSAB pass validateSharedMemoryLayout', () => {
    const inputSAB  = schema.createInputSAB();
    const outputSAB = schema.createOutputSAB();
    expect(() => schema.validateSharedMemoryLayout(inputSAB, outputSAB)).not.toThrow();
  });
});

describe('shared-memory-schema — consistency with dsp-processor.js', () => {
  const fs = require('fs');
  const procSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public/app/dsp-processor.js'), 'utf8'
  );

  test('dsp-processor.js defines matching FFT_SIZE', () => {
    expect(procSrc).toContain(`const FFT_SIZE   = ${schema.FFT_SIZE};`);
  });

  test('dsp-processor.js defines matching HOP_SIZE', () => {
    expect(procSrc).toContain(`const HOP_SIZE   = ${schema.HOP_SIZE};`);
  });

  test('dsp-processor.js defines matching FLAG_SLOTS', () => {
    expect(procSrc).toContain(`const FLAG_SLOTS = ${schema.FLAG_SLOTS};`);
  });

  test('dsp-processor.js defines matching SAB_HEADER_BYTES', () => {
    expect(procSrc).toContain(`const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS`);
  });
});
