/**
 * Landing hero sculpture (Signal Glass L2).
 *
 * Pins the motion policy (opt-outs mirror app.js#shouldLoadHeroVideo; tiers
 * follow PerformanceTier), the 2 px / 6 px drift bounds, the rAF lifecycle
 * (paused when hidden, still under reduced motion), and that the generated
 * still in public/index.html is current and same-origin only.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let policy;
let sculpture;
beforeAll(async () => {
  policy = await import('../src/core/HeroMotionPolicy.js');
  sculpture = await import('../src/presentation/HeroSculpture.js');
});

describe('selectHeroMotion', () => {
  test('HIGH drifts at display rate with bloom', () => {
    expect(policy.selectHeroMotion({ tier: 'HIGH' })).toEqual({ motion: 'drift', fps: 0, bloom: true, reason: 'high-tier' });
  });

  test('BALANCED drifts at 30 fps without bloom', () => {
    expect(policy.selectHeroMotion({ tier: 'BALANCED' })).toEqual({ motion: 'drift', fps: 30, bloom: false, reason: 'balanced-tier' });
  });

  test('CONSTRAINED is the static still', () => {
    expect(policy.selectHeroMotion({ tier: 'CONSTRAINED' })).toMatchObject({ motion: 'still', bloom: false });
  });

  test.each([
    ['reduced motion', { reducedMotion: true }, 'reduced-motion'],
    ['Save-Data', { saveData: true }, 'save-data'],
    ['2G', { effectiveType: '2g' }, '2g'],
    ['slow-2G', { effectiveType: 'slow-2g' }, '2g'],
    ['offline', { onLine: false }, 'offline'],
  ])('%s opts out to the still (same gates as shouldLoadHeroVideo)', (_label, signals, reason) => {
    expect(policy.selectHeroMotion({ tier: 'HIGH', ...signals })).toMatchObject({ motion: 'still', reason });
  });

  test('3G and 4G keep the drift; an unknown tier is treated as HIGH', () => {
    expect(policy.selectHeroMotion({ tier: 'HIGH', effectiveType: '3g' }).motion).toBe('drift');
    expect(policy.selectHeroMotion({ tier: 'nope', effectiveType: '4g' })).toMatchObject({ motion: 'drift', fps: 0 });
  });
});

describe('heroDriftOffset', () => {
  test('starts at rest, repeats every 12 s and never exceeds unit length', () => {
    expect(policy.HERO_DRIFT).toMatchObject({ periodMs: 12000, bodyPx: 2, dustPx: 6 });
    const o0 = policy.heroDriftOffset(0);
    expect(Math.hypot(o0.x, o0.y)).toBeCloseTo(0, 10);
    let max = 0;
    for (let ms = 0; ms <= 24000; ms += 25) {
      const o = policy.heroDriftOffset(ms);
      max = Math.max(max, Math.hypot(o.x, o.y));
      const later = policy.heroDriftOffset(ms + 12000);
      expect(later.x).toBeCloseTo(o.x, 9);
      expect(later.y).toBeCloseTo(o.y, 9);
    }
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(0.85);
  });
});

function makeWin({ reducedMotion = false, connection, cores = 8, memory = 8 } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><div class="v3-sculpture" id="heroStage" data-motion="still">
    <div class="v3-sculpture__frame"><div class="v3-sculpture__layer v3-sculpture__layer--body"></div>
    <div class="v3-sculpture__layer v3-sculpture__layer--dust"></div></div></div>`);
  const win = dom.window;
  const frames = [];
  let now = 0;
  let hidden = false;
  const mqListeners = [];
  Object.defineProperty(win.document, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(win.navigator, 'hardwareConcurrency', { value: cores, configurable: true });
  Object.defineProperty(win.navigator, 'deviceMemory', { value: memory, configurable: true });
  if (connection) Object.defineProperty(win.navigator, 'connection', { value: connection, configurable: true });
  win.matchMedia = (q) => ({
    matches: q.includes('reduced-motion') ? reducedMotion : false,
    addEventListener: (_t, fn) => mqListeners.push(fn),
    removeEventListener: () => {},
  });
  win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  win.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  Object.defineProperty(win, 'performance', { value: { now: () => now }, configurable: true });
  win.IntersectionObserver = class { observe() {} disconnect() {} };
  const tick = (ms) => {
    now += ms;
    const queued = frames.splice(0);
    for (const fn of queued) if (fn) fn(now);
  };
  const setHidden = (v) => { hidden = v; win.document.dispatchEvent(new win.Event('visibilitychange')); };
  return { win, tick, frames, setHidden, mqListeners, stage: win.document.getElementById('heroStage') };
}

const px = (el) => {
  const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(el.style.transform);
  return m ? Math.hypot(Number(m[1]), Number(m[2])) : 0;
};

describe('mountHeroSculpture', () => {
  test('drifts the body <= 2 px and the dust <= 6 px through requestAnimationFrame', () => {
    const { win, tick, stage } = makeWin();
    const { policy: p } = sculpture.mountHeroSculpture(stage, { win });
    expect(p.motion).toBe('drift');
    expect(stage.dataset).toMatchObject({ tier: 'HIGH', motion: 'drift' });
    const body = stage.querySelector('.v3-sculpture__layer--body');
    const dust = stage.querySelector('.v3-sculpture__layer--dust');
    let maxBody = 0, maxDust = 0;
    for (let i = 0; i < 800; i++) {
      tick(16);
      maxBody = Math.max(maxBody, px(body));
      maxDust = Math.max(maxDust, px(dust));
    }
    expect(maxBody).toBeGreaterThan(1.5);
    expect(maxBody).toBeLessThanOrEqual(2.001);
    expect(maxDust).toBeLessThanOrEqual(6.001);
    expect(maxDust).toBeGreaterThan(maxBody);
  });

  test('stops requesting frames while the tab is hidden and resumes after', () => {
    const { win, tick, frames, setHidden, stage } = makeWin();
    sculpture.mountHeroSculpture(stage, { win });
    tick(16);
    setHidden(true);
    expect(frames.filter(Boolean)).toHaveLength(0);
    tick(16);
    expect(frames.filter(Boolean)).toHaveLength(0);
    setHidden(false);
    expect(frames.filter(Boolean)).toHaveLength(1);
  });

  test('reduced motion and Save-Data keep the still: no frames, no transforms', () => {
    for (const opts of [{ reducedMotion: true }, { connection: { saveData: true } }]) {
      const { win, frames, stage } = makeWin(opts);
      const { policy: p } = sculpture.mountHeroSculpture(stage, { win });
      expect(p.motion).toBe('still');
      expect(stage.dataset.motion).toBe('still');
      expect(frames).toHaveLength(0);
      expect(stage.querySelector('.v3-sculpture__layer--body').style.transform).toBe('');
    }
  });

  test('turning on reduced motion mid-visit returns to the still', () => {
    const { win, tick, frames, mqListeners, stage } = makeWin();
    sculpture.mountHeroSculpture(stage, { win });
    tick(16);
    for (const fn of mqListeners) fn({ matches: true });
    expect(stage.dataset.motion).toBe('still');
    expect(frames.filter(Boolean)).toHaveLength(0);
    expect(stage.querySelector('.v3-sculpture__layer--dust').style.transform).toBe('');
  });

  test('BALANCED caps paints at 30 fps', () => {
    const { win, tick, stage } = makeWin({ cores: 4, memory: 4 });
    sculpture.mountHeroSculpture(stage, { win });
    expect(stage.dataset.tier).toBe('BALANCED');
    const body = stage.querySelector('.v3-sculpture__layer--body');
    let paints = 0, prev = body.style.transform;
    for (let i = 0; i < 60; i++) {
      tick(1000 / 60);
      if (body.style.transform !== prev) { paints++; prev = body.style.transform; }
    }
    expect(paints).toBeGreaterThanOrEqual(25);
    expect(paints).toBeLessThanOrEqual(31);
  });

  test('CONSTRAINED devices get the still', () => {
    const { win, frames, stage } = makeWin({ cores: 2, memory: 2 });
    sculpture.mountHeroSculpture(stage, { win });
    expect(stage.dataset).toMatchObject({ tier: 'CONSTRAINED', motion: 'still' });
    expect(frames).toHaveLength(0);
  });
});

describe('generated still in public/index.html', () => {
  const start = html.indexOf('<!-- hero-sculpture:start');
  const end = html.indexOf('<!-- hero-sculpture:end -->');
  const block = html.slice(start, end);

  test('is current with scripts/generate-hero-sculpture.mjs', () => {
    expect(start).toBeGreaterThan(0);
    expect(() => execFileSync(process.execPath, ['scripts/generate-hero-sculpture.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' })).not.toThrow();
  });

  test('labels the three ribbons and loads nothing from another origin', () => {
    for (const label of ['Original', 'Clean Voice', 'Background']) expect(block).toContain(`${label}</li>`);
    expect(block).not.toMatch(/(?:href|src)=["']https?:/i);
    expect(block).not.toMatch(/<(?:script|image|img|use)\b/i);
    expect(block).not.toMatch(/microphone|\bmic\b|\brecord\b|rec-dot/i);
  });

  test('the old WebGL / CSS bar-field fallback is no longer mounted on Landing', () => {
    expect(html).not.toMatch(/id="heroGl"|id="heroFallback"/);
    const js = fs.readFileSync(path.join(ROOT, 'public/landing-v3.js'), 'utf8');
    expect(js).not.toMatch(/hero-gl\.js/);
    expect(js).toMatch(/\/src\/presentation\/HeroSculpture\.js/);
  });
});
