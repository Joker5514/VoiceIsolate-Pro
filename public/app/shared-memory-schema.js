/**
 * VoiceIsolate Pro — shared-memory-schema.js
 * ===========================================
 * Canonical source for all SharedArrayBuffer layout constants.
 *
 * CRITICAL: These values must match dsp-processor.js and ml-worker.js exactly.
 * Any change here requires a coordinated update across all consumers.
 *
 * SharedArrayBuffer layout for inputSAB / outputSAB:
 *
 *   [  0 .. 19]  Int32 flags (FLAG_SLOTS × 4 bytes)
 *                  [0] writeGen   — writer increments; reader polls
 *                  [1] readGen    — reader increments after consuming
 *                  [2] capacity   — HALF_BINS (immutable)
 *                  [3] halfN      — HALF_BINS duplicate for fast reads
 *                  [4] reserved   — reserved for future use
 *   [ 20 .. 20+HALF_BINS*4)       Float32 mag   (inputSAB) / mask (outputSAB)
 *   [ 20+HALF_BINS*4 .. 20+HALF_BINS*8)  Float32 pha   (inputSAB only)
 *   [ 20+HALF_BINS*8 .. 20+HALF_BINS*8+HOP_SIZE*4)  Float32 pcm (inputSAB only)
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    const exports = factory();
    Object.assign(root, exports);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FFT_SIZE         = 4096;
  const HOP_SIZE         = 1024;
  const HALF_BINS        = FFT_SIZE / 2 + 1;   // 2049
  const RENDER_QUANTUM   = 128;
  const FLAG_SLOTS       = 5;
  const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS; // 20

  // SAB byte sizes
  const INPUT_SAB_BYTES  = SAB_HEADER_BYTES
    + HALF_BINS * Float32Array.BYTES_PER_ELEMENT * 2   // mag + pha
    + HOP_SIZE  * Float32Array.BYTES_PER_ELEMENT;       // pcm

  const OUTPUT_SAB_BYTES = SAB_HEADER_BYTES
    + HALF_BINS * Float32Array.BYTES_PER_ELEMENT;       // mask

  // Flag-slot indices (Int32Array offsets into the SAB header)
  const FLAG_WRITE_GEN  = 0;
  const FLAG_READ_GEN   = 1;
  const FLAG_CAPACITY   = 2;
  const FLAG_HALF_N     = 3;
  const FLAG_RESERVED   = 4;

  // Float32 region offsets from byte 0 of the SAB
  const MAG_BYTE_OFFSET  = SAB_HEADER_BYTES;
  const PHA_BYTE_OFFSET  = SAB_HEADER_BYTES + HALF_BINS * 4;
  const PCM_BYTE_OFFSET  = SAB_HEADER_BYTES + HALF_BINS * 8;
  const MASK_BYTE_OFFSET = SAB_HEADER_BYTES;

  /**
   * Validate that an inputSAB and outputSAB pair have the correct byte lengths.
   * Throws if either SAB is misconfigured.
   *
   * @param {SharedArrayBuffer} inputSAB
   * @param {SharedArrayBuffer} outputSAB
   */
  function validateSharedMemoryLayout(inputSAB, outputSAB) {
    if (!(inputSAB instanceof SharedArrayBuffer)) {
      throw new TypeError('validateSharedMemoryLayout: inputSAB must be a SharedArrayBuffer');
    }
    if (!(outputSAB instanceof SharedArrayBuffer)) {
      throw new TypeError('validateSharedMemoryLayout: outputSAB must be a SharedArrayBuffer');
    }
    if (inputSAB.byteLength !== INPUT_SAB_BYTES) {
      throw new RangeError(
        `validateSharedMemoryLayout: inputSAB.byteLength=${inputSAB.byteLength} ` +
        `expected ${INPUT_SAB_BYTES}`
      );
    }
    if (outputSAB.byteLength !== OUTPUT_SAB_BYTES) {
      throw new RangeError(
        `validateSharedMemoryLayout: outputSAB.byteLength=${outputSAB.byteLength} ` +
        `expected ${OUTPUT_SAB_BYTES}`
      );
    }
  }

  /** Create a correctly-sized inputSAB. @returns {SharedArrayBuffer} */
  function createInputSAB() {
    return new SharedArrayBuffer(INPUT_SAB_BYTES);
  }

  /** Create a correctly-sized outputSAB. @returns {SharedArrayBuffer} */
  function createOutputSAB() {
    return new SharedArrayBuffer(OUTPUT_SAB_BYTES);
  }

  return {
    FFT_SIZE, HOP_SIZE, HALF_BINS, RENDER_QUANTUM,
    FLAG_SLOTS, SAB_HEADER_BYTES,
    INPUT_SAB_BYTES, OUTPUT_SAB_BYTES,
    FLAG_WRITE_GEN, FLAG_READ_GEN, FLAG_CAPACITY, FLAG_HALF_N, FLAG_RESERVED,
    MAG_BYTE_OFFSET, PHA_BYTE_OFFSET, PCM_BYTE_OFFSET, MASK_BYTE_OFFSET,
    validateSharedMemoryLayout, createInputSAB, createOutputSAB,
  };
}));
