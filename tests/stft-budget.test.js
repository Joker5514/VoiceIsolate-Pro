/**
 * STFT budget + process spectral plan (audit F-02).
 */
'use strict';

let budget;
let math;

beforeAll(async () => {
  budget = await import('../src/core/stft-budget.js');
  math = await import('../src/core/stft-math.js');
});

describe('createStftBudget', () => {
  test('allows one STFT per owner within maxOwners', () => {
    const b = budget.createStftBudget({ maxOwners: 2, label: 't' });
    const a = b.record(budget.STFT_OWNERS.ENGINEER);
    const c = b.record(budget.STFT_OWNERS.CLEANUP);
    expect(a.allowed).toBe(true);
    expect(c.allowed).toBe(true);
    expect(b.owners().sort()).toEqual([
      budget.STFT_OWNERS.CLEANUP,
      budget.STFT_OWNERS.ENGINEER,
    ].sort());
  });

  test('warns when a third owner appears', () => {
    const b = budget.createStftBudget({ maxOwners: 2, label: 't' });
    b.record('a');
    b.record('b');
    const r = b.record('c');
    expect(r.allowed).toBe(false);
    expect(r.warning).toMatch(/owners > max/);
    expect(b.getWarnings().length).toBeGreaterThan(0);
  });

  test('warns on double STFT same owner', () => {
    const b = budget.createStftBudget({ maxOwners: 3, label: 't' });
    b.record(budget.STFT_OWNERS.USM);
    const r = b.record(budget.STFT_OWNERS.USM);
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(2);
    expect(r.warning).toMatch(/2×|2x|ran/i);
  });
});

describe('planProcessSpectral', () => {
  test('prefers engineer single spectral when needed', () => {
    const p = budget.planProcessSpectral({ needEngineerSpectral: true });
    expect(p.runEngineerSpectral).toBe(true);
    expect(p.reason).toMatch(/engineer/);
  });

  test('skips engineer when cleanup already applied and engineer not needed', () => {
    const p = budget.planProcessSpectral({
      ranCleanup: true,
      needEngineerSpectral: false,
    });
    expect(p.runEngineerSpectral).toBe(false);
    expect(p.reason).toBe('cleanup-already-applied');
  });
});

describe('USM residual label', () => {
  let usm;
  beforeAll(async () => {
    usm = await import('../src/core/UniversalSourceMatrix.js');
  });

  test('auto mode includes residual / other stem', () => {
    const SR = 16000;
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      x[i] = 0.2 * Math.sin((2 * Math.PI * 300 * i) / SR)
        + 0.1 * Math.sin((2 * Math.PI * 2500 * i) / SR);
    }
    const result = usm.separateUniversal(x, SR, {
      numSources: 3,
      nmfIterations: 10,
      seed: 3,
      fftSize: 2048,
      hopSize: 512,
    });
    const residual = result.sources.find((s) => /residual/i.test(s.label));
    expect(residual).toBeTruthy();
    expect(residual.pcm.length).toBe(x.length);
  });
});

describe('stft-math + budget coexistence', () => {
  test('engineer geometry still 75% desktop', () => {
    const g = math.engineerStftGeometry({});
    expect(g.hopSize).toBe(g.fftSize / 4);
  });
});
