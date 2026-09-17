'use strict';

/**
 * processInChunks used to await a yield after every chunk. A chunk of audio is
 * well under a millisecond of arithmetic, so on any engine without
 * scheduler.yield the per-chunk frame wait (~16 ms) became the entire cost of
 * the pass: a 5-minute file is 150–600 chunks, repeated for every O(N) pass in
 * Process. These guard the time-budgeted behaviour that replaced it.
 */
const { pathToFileURL } = require('url');
const path = require('path');

let uiYield;

beforeAll(async () => {
  uiYield = await import(pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href);
});

describe('processInChunks yield budgeting', () => {
  test('chunk granularity and progress reporting are unchanged', async () => {
    let chunks = 0;
    const ratios = [];
    await uiYield.processInChunks({
      total: 500_000,
      chunkSize: 1_000, // 500 chunks of near-zero work
      runChunk: () => { chunks += 1; },
      onProgress: (r) => { ratios.push(r); },
    });
    expect(chunks).toBe(500);
    expect(ratios).toHaveLength(500);
    expect(ratios[ratios.length - 1]).toBe(1);
  });

  test('a fast pass finishes far quicker than one yield per chunk would allow', async () => {
    const t0 = Date.now();
    let sum = 0;
    await uiYield.processInChunks({
      total: 400_000,
      chunkSize: 1_000,
      runChunk: (start, end) => { sum += end - start; },
    });
    const elapsed = Date.now() - t0;
    expect(sum).toBe(400_000);
    // 400 chunks × even a 1 ms macrotask hop would be ≥ 400 ms.
    expect(elapsed).toBeLessThan(200);
  });

  test('still hands the main thread back during a long pass', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      await uiYield.processInChunks({
        total: 200,
        chunkSize: 1,
        // ~4 ms of work per chunk → many budget windows over ~800 ms
        runChunk: () => {
          const until = Date.now() + 4;
          while (Date.now() < until) { /* burn */ }
        },
      });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  test('an explicit yieldBudgetMs overrides the platform default', async () => {
    const t0 = Date.now();
    await uiYield.processInChunks({
      total: 40,
      chunkSize: 1,
      yieldBudgetMs: 10_000, // never reached → no yields at all
      runChunk: () => {},
    });
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('yieldToBrowser does not await a frame on every call', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) await uiYield.yieldToBrowser();
    // 40 rAF-aligned yields would be ~640 ms; macrotask hops are ~1 ms.
    expect(Date.now() - t0).toBeLessThan(250);
  });
});
