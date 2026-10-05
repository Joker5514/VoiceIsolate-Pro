'use strict';

/**
 * downmixToMonoAsync replaced a synchronous full-track downmix in the
 * post-Process auto-analysis. It must match the synchronous result exactly,
 * never alias a mono input, and stop on abort.
 */
const { pathToFileURL } = require('url');
const path = require('path');

let uiYield;
let features;

beforeAll(async () => {
  uiYield = await import(pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href);
  features = await import(pathToFileURL(path.join(__dirname, '../src/core/FeatureExtractor.js')).href);
});

function signal(n, seed) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.013 * seed) * 0.5 + ((i * seed) % 7) / 70;
  return a;
}

describe('downmixToMonoAsync', () => {
  test('matches downmixToMono sample for sample across chunk boundaries', async () => {
    const chans = [signal(250_001, 1), signal(250_001, 3)];
    const sync = features.downmixToMono(chans);
    const asyncOut = await uiYield.downmixToMonoAsync(chans, { chunkSize: 9_999 });
    expect(asyncOut).toEqual(sync);
  });

  test('copies a single channel instead of aliasing it', async () => {
    const ch = signal(10_000, 2);
    const out = await uiYield.downmixToMonoAsync([ch]);
    expect(out).not.toBe(ch);
    expect(out).toEqual(ch);
  });

  test('rejects when the signal is aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(uiYield.downmixToMonoAsync([signal(1_000, 1), signal(1_000, 2)], { signal: ctrl.signal }))
      .rejects.toThrow();
  });

  test('stops between chunks when aborted after processing starts', async () => {
    const ctrl = new AbortController();
    let lastRead = -1;
    // Abort from inside the downmix, on the first read of sample 25 000.
    const tripwire = new Proxy(signal(200_000, 1), {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const i = Number(prop);
          if (i === 25_000) ctrl.abort();
          lastRead = Math.max(lastRead, i);
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(uiYield.downmixToMonoAsync([tripwire, signal(200_000, 2)], {
      signal: ctrl.signal,
      chunkSize: 10_000,
    })).rejects.toThrow();
    // The chunk holding the abort finishes; no later chunk starts.
    expect(lastRead).toBe(29_999);
  });

  test('empty input returns an empty array', async () => {
    expect((await uiYield.downmixToMonoAsync([])).length).toBe(0);
  });
});

describe('anySignal', () => {
  const realAny = AbortSignal.any;
  afterEach(() => { AbortSignal.any = realAny; });

  for (const mode of ['native', 'fallback']) {
    describe(mode, () => {
      beforeEach(() => { if (mode === 'fallback') AbortSignal.any = undefined; });

      test('aborts when either input aborts', () => {
        for (const which of [0, 1]) {
          const a = new AbortController();
          const b = new AbortController();
          const s = uiYield.anySignal([a.signal, b.signal]);
          expect(s.aborted).toBe(false);
          (which ? b : a).abort('stop');
          expect(s.aborted).toBe(true);
          expect(s.reason).toBe('stop');
        }
      });

      test('is already aborted when an input already is', () => {
        const a = new AbortController();
        a.abort('early');
        const s = uiYield.anySignal([new AbortController().signal, a.signal]);
        expect(s.aborted).toBe(true);
        expect(s.reason).toBe('early');
      });

      test('stops a running downmix when the second signal aborts', async () => {
        const job = new AbortController();
        const source = new AbortController();
        const ch = new Proxy(signal(100_000, 1), {
          get(t, p) {
            if (p === '20000') source.abort();
            const v = Reflect.get(t, p);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
        await expect(uiYield.downmixToMonoAsync([ch, signal(100_000, 2)], {
          signal: uiYield.anySignal([job.signal, source.signal]),
          chunkSize: 10_000,
        })).rejects.toThrow();
      });
    });
  }

  test('passes a single signal through and ignores nulls', () => {
    const a = new AbortController();
    expect(uiYield.anySignal([null, a.signal, undefined])).toBe(a.signal);
    expect(uiYield.anySignal([null])).toBe(null);
  });
});
