'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('SAB protocol regression fixes', () => {
  test('dsp-processor uses header-first dual-SAB frame counter protocol', () => {
    const src = read('public/app/dsp-processor.js');
    expect(src).toContain('const FFT_SIZE   = 4096;');
    expect(src).toContain('const HOP_SIZE   = 1024;');
    expect(src).toContain('const FLAG_SLOTS = 4;');
    expect(src).toContain('const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;');
    expect(src).toContain('Atomics.add(this._flagsIn, 0, 1);');
    expect(src).toContain('if (Atomics.load(this._flagsOut, 1) === 1) {');
    expect(src).toContain('Atomics.store(this._flagsOut, 1, 0);');
    expect(src).toContain('const sampleRate = this.context.sampleRate;');
    expect(src).toContain('const olaScale = 2 * HOP_SIZE / FFT_SIZE;');
    expect(src).toContain("type: 'sabReady'");
  });

  test('app.js initializes dual SABs and forwards initRingBuffers', () => {
    const src = read('public/app/app.js');
    expect(src).toContain('const FFT_SIZE = 4096;');
    expect(src).toContain('const HOP_SIZE = 1024;');
    expect(src).toContain('const HALF_BINS = FFT_SIZE / 2 + 1;');
    expect(src).toContain('processorOptions: { sharedArrayBuffer: { inputSAB, outputSAB } }');
    expect(src).toContain("type: 'initRingBuffers'");
    expect(src).toContain('inputRing: inputSAB');
    expect(src).toContain('maskRing: outputSAB');
    expect(src).toContain('halfN: HALF_BINS');
    expect(src).toContain('ringCapacity: 16');
    expect(src).toContain('quantumSize: 128');
    expect(src).toContain("if ((entry.target === 'worklet' || entry.target === 'both') && workletNode) {");
    expect(src).toContain("workletNode.port.postMessage({ type: 'params', payload });");
    expect(src).toContain("if ((entry.target === 'worker' || entry.target === 'both') && mlWorker) {");
    expect(src).toContain("mlWorker.postMessage({ type: 'setParams', payload });");
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
