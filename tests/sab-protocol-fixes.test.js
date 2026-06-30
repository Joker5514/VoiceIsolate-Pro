'use strict';

/**
 * SAB protocol regression coverage.
 *
 * The dual-SAB protocol that wires the AudioWorklet, main thread, and ML worker
 * has a few invariants that previous regressions broke. These tests pin the
 * source-level invariants that match the current implementation:
 *
 *  - dsp-processor.js uses a header-first dual-SAB layout (FFT 4096 / HOP 1024,
 *    4 Int32 flag slots) and ack's the ML worker's write-generation via the
 *    output flags ring.
 *  - app.js allocates the dual SABs and forwards them to the ML worker via the
 *    'initRingBuffers' message, and listens for the worklet's 'sabReady' ack
 *    to swap in worker-allocated SABs when fallback allocation was needed.
 */

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('SAB protocol regression fixes', () => {
  test('dsp-processor uses header-first dual-SAB frame counter protocol', () => {
    const src = read('public/app/dsp-processor.js');
    expect(src).toContain('const FFT_SIZE   = 4096;');
    expect(src).toContain('const HOP_SIZE   = 1024;');
    expect(src).toContain('const FLAG_SLOTS = 5;');
    expect(src).toContain('const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;');
    // Frame-write generation bump on each completed hop:
    expect(src).toContain('Atomics.add(this._inputFlags, 0, 1);');
    // Read-generation ack pattern (writeGen is at slot 0 of the output flags,
    // readGen at slot 1).
    expect(src).toMatch(/Atomics\.load\(this\._outputFlags,\s*0\)/);
    expect(src).toMatch(/Atomics\.store\(this\._outputFlags,\s*1,\s*writeGen\)/);
    // SAB-ready notification back to the main thread.
    expect(src).toContain("type: 'sabReady'");
  });

  test('app.js initializes dual SABs and forwards initRingBuffers', () => {
    const src = read('public/app/app.js');
    expect(src).toContain('const FFT_SIZE = 4096;');
    expect(src).toContain('const HOP_SIZE = 1024;');
    expect(src).toContain('const HALF_BINS = FFT_SIZE / 2 + 1;');
    // Forward dual SABs to the ML worker.
    expect(src).toContain("type: 'initRingBuffers'");
    expect(src).toContain('inputRing: inputSAB');
    expect(src).toContain('maskRing: outputSAB');
    // Listen for the worklet's sabReady ack to swap to worker-owned SABs.
    expect(src).toContain("if (ev.data && ev.data.type === 'sabReady' && ev.data.inputSAB && ev.data.outputSAB) {");
  });

  test('vercel rewrites no longer contain blob placeholder model rewrite', () => {
    const cfg = JSON.parse(read('vercel.json'));
    const rewrites = cfg.rewrites || [];
    const hasModelRewrite = rewrites.some((r) => r && r.source === '/app/models/:model');
    const hasBlobPlaceholder = rewrites.some((r) => String(r && r.destination || '').includes('YOUR_BLOB_STORE'));
    expect(hasModelRewrite).toBe(false);
    expect(hasBlobPlaceholder).toBe(false);
  });
});
