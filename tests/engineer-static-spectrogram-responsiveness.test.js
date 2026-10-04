/**
 * Engineer static spectrogram responsiveness — behavioural.
 *
 * The previous guard asserted that premium-visuals.js mentioned
 * `forwardSTFTAsync`. It did, yet in the browser dsp-bootstrap's synchronous
 * DSP shim (no async variant) shadowed DSPCore, so every Process ended with a
 * full-file STFT in one task: ~1 s per minute of audio, 5 s for 5 minutes.
 * These tests run the real helper against a counting DSP stub instead.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '../public/app/premium-visuals.js'), 'utf8');

function makeCanvas(width = 800, height = 240) {
  const ctx = {
    puts: 0,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() { ctx.puts += 1; },
    drawImage() {},
  };
  return {
    width: 0,
    height: 0,
    ctx,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
  };
}

function load({ clockStepMs = 0 } = {}) {
  let now = 0;
  const yields = { count: 0 };
  const calls = { frames: 0, invocations: 0, maxSignal: 0 };
  const sandbox = {
    console,
    Math,
    Float32Array,
    Uint8Array,
    Uint8ClampedArray,
    Promise,
    Date,
    performance: { now: () => { now += clockStepMs; return now; } },
    setTimeout: (fn) => { yields.count += 1; Promise.resolve().then(fn); return 1; },
    getComputedStyle: () => ({ height: '240px' }),
    VIP_INFERNO_LUT: new Uint8Array(256 * 3).fill(7),
    document: { getElementById: () => null },
    DSPCore: {
      forwardSTFT(signal, fftSize, hop) {
        calls.invocations += 1;
        calls.maxSignal = Math.max(calls.maxSignal, signal.length);
        const frames = signal.length >= fftSize ? Math.floor((signal.length - fftSize) / hop) + 1 : 0;
        calls.frames += frames;
        const mag = [];
        for (let f = 0; f < frames; f++) mag.push(new Float32Array(fftSize / 2 + 1).fill(0.5));
        return { mag, phase: mag, frameCount: frames };
      },
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SRC, sandbox);
  return { draw: sandbox.VIP_drawStaticSpectrogram, calls, yields, sandbox };
}

function audio(seconds, sampleRate = 48000) {
  const data = new Float32Array(seconds * sampleRate);
  return { getChannelData: () => data };
}

describe('Engineer static spectrogram responsiveness', () => {
  test('transforms one frame per canvas column, independent of file length', async () => {
    const { draw, calls } = load();
    const canvas = makeCanvas(800, 240);
    await expect(draw(canvas, audio(600))).resolves.toBe(true);
    // 10 minutes at hop 256 is 112 497 frames; only <= 800 columns are painted.
    expect(calls.frames).toBeLessThanOrEqual(800);
    expect(calls.maxSignal).toBe(1024);
    expect(canvas.ctx.puts).toBe(1);
    expect(canvas.width).toBe(800);
  });

  test('prefers DSPCore over a DSP shim and still works with the shim alone', async () => {
    const both = load();
    let shimCalls = 0;
    both.sandbox.DSP = { forwardSTFT: () => { shimCalls += 1; return { mag: [] }; } };
    await expect(both.draw(makeCanvas(), audio(5))).resolves.toBe(true);
    expect(shimCalls).toBe(0);

    const shimOnly = load();
    shimOnly.sandbox.DSP = shimOnly.sandbox.DSPCore;
    delete shimOnly.sandbox.DSPCore;
    await expect(shimOnly.draw(makeCanvas(), audio(5))).resolves.toBe(true);
  });

  test('yields on a time budget, not per column', async () => {
    const slow = load({ clockStepMs: 5 });
    await slow.draw(makeCanvas(400, 100), audio(30));
    expect(slow.yields.count).toBeGreaterThan(0);

    const fast = load({ clockStepMs: 0 });
    await fast.draw(makeCanvas(400, 100), audio(30));
    expect(fast.yields.count).toBe(0);
  });

  test('a newer draw supersedes a stale in-flight one', async () => {
    const { draw } = load({ clockStepMs: 5 });
    const a = makeCanvas(400, 100);
    const b = makeCanvas(400, 100);
    const first = draw(a, audio(30));
    const second = draw(b, audio(30));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(a.ctx.puts).toBe(0);
    expect(b.ctx.puts).toBe(1);
  });

  test('a clip shorter than one FFT frame still renders (zero-padded)', async () => {
    const { draw, calls } = load();
    const canvas = makeCanvas(200, 80);
    const short = { getChannelData: () => new Float32Array(300).fill(0.2) };
    await expect(draw(canvas, short)).resolves.toBe(true);
    expect(calls.frames).toBe(1);
    expect(canvas.ctx.puts).toBe(1);
  });

  test('is still installed over the legacy synchronous helper', () => {
    expect(SRC).toContain('global.VIP_drawStaticSpectrogram = drawStaticSpectrogramCooperative;');
  });
});
