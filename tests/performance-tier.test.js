/**
 * tests/performance-tier.test.js
 *
 * VIP-022 (resource-aware adaptation): the tier decision is pure, so its
 * boundaries are pinned here. The tier never changes processed audio —
 * it only caps cache/visual work (see PerformanceTier.js header) — and
 * the upload tiers in upload-limits.js are covered by upload-limits.test.js.
 * Thermal-state sensing is NOT part of this surface: no web API exposes
 * device thermal state, so the product adapts to memory/cores/pointer/
 * viewport/save-data signals, not to temperature. See
 * docs/guides/RESOURCE_ADAPTATION.md.
 */
'use strict';

let PerformanceTier;
let selectPerformanceTier;
let tierBudgets;

beforeAll(async () => {
  const m = await import('../src/core/PerformanceTier.js');
  PerformanceTier = m.PerformanceTier;
  selectPerformanceTier = m.selectPerformanceTier;
  tierBudgets = m.tierBudgets;
});

test('CONSTRAINED on small memory, few cores, or save-data', () => {
  expect(selectPerformanceTier({ deviceMemory: 2, hardwareConcurrency: 8 })).toBe(PerformanceTier.CONSTRAINED);
  expect(selectPerformanceTier({ deviceMemory: 16, hardwareConcurrency: 2 })).toBe(PerformanceTier.CONSTRAINED);
  expect(selectPerformanceTier({ deviceMemory: 16, hardwareConcurrency: 8, saveData: true })).toBe(PerformanceTier.CONSTRAINED);
  expect(selectPerformanceTier({ deviceMemory: 1.5, hardwareConcurrency: 1 })).toBe(PerformanceTier.CONSTRAINED);
});

test('BALANCED on mid memory/cores or touch-first small viewport', () => {
  expect(selectPerformanceTier({ deviceMemory: 4, hardwareConcurrency: 8 })).toBe(PerformanceTier.BALANCED);
  expect(selectPerformanceTier({ deviceMemory: 16, hardwareConcurrency: 4 })).toBe(PerformanceTier.BALANCED);
  expect(selectPerformanceTier({ coarsePointer: true, viewportWidth: 390 })).toBe(PerformanceTier.BALANCED);
  // Touch-first with unknown memory (deviceMemory is Chromium-only):
  // never the unbounded HIGH tier.
  expect(selectPerformanceTier({ coarsePointer: true })).toBe(PerformanceTier.BALANCED);
});

test('HIGH only on a well-provisioned non-touch device', () => {
  expect(selectPerformanceTier({ deviceMemory: 8, hardwareConcurrency: 8 })).toBe(PerformanceTier.HIGH);
  expect(selectPerformanceTier({})).toBe(PerformanceTier.HIGH);
});

test('budgets: HIGH unbounded, BALANCED 384 MB, CONSTRAINED 160 MB stem cache', () => {
  expect(tierBudgets('HIGH').stemCacheBytes).toBe(Infinity);
  expect(tierBudgets('BALANCED').stemCacheBytes).toBe(384 * 1024 * 1024);
  expect(tierBudgets('CONSTRAINED').stemCacheBytes).toBe(160 * 1024 * 1024);
  expect(tierBudgets('bogus')).toBe(tierBudgets('HIGH'));
});
