/**
 * UI motion + Signal Glass illustrations.
 *
 * Pins the motion policy (spec timings, reduced motion, tier budgets), the
 * rule that CONSTRAINED work areas run no animations, the compositor-only
 * motion stylesheet, the deterministic same-origin illustrations, and the
 * wiring on both entry points.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let MP; let Geo; let Ill; let MC; let Meters;

beforeAll(async () => {
  MP = await import('../src/core/MotionPolicy.js');
  Geo = await import('../src/core/IllustrationGeometry.js');
  Ill = await import('../src/presentation/Illustrations.js');
  MC = await import('../src/presentation/MotionController.js');
  Meters = await import('../src/ui/components/LiveMeters/LiveMeters.js');
});

const TIERS = ['HIGH', 'BALANCED', 'CONSTRAINED'];
const SURFACES = ['marketing', 'work'];

describe('MotionPolicy (core)', () => {
  test('spec timings and ease', () => {
    expect(MP.MOTION_MS.press).toBe(150);
    expect(MP.MOTION_MS.toggle).toBe(200);
    expect(MP.MOTION_MS.sheet).toBe(300);
    expect(MP.MOTION_MS.sheetReduced).toBe(120);
    expect(MP.MOTION_EASE).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
    expect(MP.MOTION_MS.revealMarketing).toBeGreaterThanOrEqual(600);
    expect(MP.MOTION_MS.revealMarketing).toBeLessThanOrEqual(1200);
    expect(MP.MOTION_MS.stagger).toBeGreaterThanOrEqual(40);
    expect(MP.MOTION_MS.stagger).toBeLessThanOrEqual(80);
    expect(MP.resolveMotionPolicy({ tier: 'HIGH', surface: 'marketing' }).durations.reveal).toBe(MP.MOTION_MS.revealMarketing);
    const p = MP.resolveMotionPolicy({ tier: 'HIGH', surface: 'work' });
    expect(p.durations).toMatchObject({ press: 150, toggle: 200, sheet: 300 });
  });

  test.each(TIERS.flatMap((t) => SURFACES.map((s) => [t, s])))(
    'reduced motion wins on %s / %s: still, instant, sheet is a 120 ms fade',
    (tier, surface) => {
      const p = MP.resolveMotionPolicy({ tier, surface, reducedMotion: true });
      expect(p.level).toBe('still');
      expect(p.reduced).toBe(true);
      expect(p.animations).toBe(false);
      expect(p.entrances).toBe(false);
      expect(p.ambient).toBe(false);
      expect(p.stateMotion).toBe(false);
      expect(p.sheetFadeOnly).toBe(true);
      expect(p.durations).toEqual({ press: 0, toggle: 0, sheet: 120, reveal: 0, stagger: 0 });
    },
  );

  test('CONSTRAINED work areas run no animations at all', () => {
    const p = MP.resolveMotionPolicy({ tier: 'CONSTRAINED', surface: 'work' });
    expect(p.level).toBe('still');
    expect(p.animations).toBe(false);
    expect(p.entrances).toBe(false);
    expect(p.ambient).toBe(false);
    expect(p.stateMotion).toBe(false);
    expect(p.durations.reveal).toBe(0);
    expect(p.durations.stagger).toBe(0);
  });

  test('Save-Data is treated as CONSTRAINED', () => {
    const p = MP.resolveMotionPolicy({ tier: 'HIGH', surface: 'work', saveData: true });
    expect(p.tier).toBe('CONSTRAINED');
    expect(p.animations).toBe(false);
  });

  test('work areas never get ambient motion below HIGH', () => {
    expect(MP.resolveMotionPolicy({ tier: 'HIGH', surface: 'work' }).ambient).toBe(true);
    const balanced = MP.resolveMotionPolicy({ tier: 'BALANCED', surface: 'work' });
    expect(balanced.ambient).toBe(false);
    expect(balanced.stateMotion).toBe(true);
  });

  test('marketing keeps entrances on CONSTRAINED but drops ambient motion', () => {
    const p = MP.resolveMotionPolicy({ tier: 'CONSTRAINED', surface: 'marketing' });
    expect(p.entrances).toBe(true);
    expect(p.ambient).toBe(false);
    expect(p.durations.stagger).toBe(0);
  });

  test('unknown tier falls back to BALANCED, unknown surface to marketing', () => {
    const p = MP.resolveMotionPolicy({ tier: 'TURBO', surface: 'nope' });
    expect(p.tier).toBe('BALANCED');
    expect(p.surface).toBe('marketing');
  });

  test('stagger is capped so long rows never trail', () => {
    const p = MP.resolveMotionPolicy({ tier: 'HIGH' });
    expect(MP.staggerDelay(0, p)).toBe(0);
    expect(MP.staggerDelay(2, p)).toBe(120);
    expect(MP.staggerDelay(50, p)).toBe(MP.MOTION_MS.staggerMaxSteps * 60);
    expect(MP.staggerDelay(3, MP.resolveMotionPolicy({ reducedMotion: true }))).toBe(0);
  });

  test('root attributes and custom properties', () => {
    const m = MP.resolveMotionPolicy({ tier: 'CONSTRAINED', surface: 'marketing' });
    const w = MP.resolveMotionPolicy({ tier: 'CONSTRAINED', surface: 'work' });
    expect(MP.motionDataAttributes(m, w)).toEqual({
      'data-motion': 'calm',
      'data-motion-work': 'still',
      'data-motion-tier': 'CONSTRAINED',
      'data-motion-ambient': 'off',
      'data-motion-work-ambient': 'off',
      'data-motion-work-state': 'off',
    });
    const vars = MP.motionCustomProperties(MP.resolveMotionPolicy({ tier: 'HIGH', surface: 'work' }));
    expect(vars['--vip-motion-press']).toBe('150ms');
    expect(vars['--vip-motion-ease']).toBe(MP.MOTION_EASE);
  });

  test('stays a pure Layer 1 module', () => {
    for (const rel of ['src/core/MotionPolicy.js', 'src/core/IllustrationGeometry.js']) {
      const src = read(rel);
      expect(src).not.toMatch(/\bdocument\b|\bwindow\b|AudioContext|from '\.\.\//);
    }
  });
});

describe('MotionController (presentation)', () => {
  const policy = (o) => MP.resolveMotionPolicy(o);
  const el = () => {
    const calls = [];
    return { calls, animate: (frames, opts) => { calls.push({ frames, opts }); return { frames, opts }; } };
  };

  test('playEntrance does nothing in CONSTRAINED work areas or under reduced motion', () => {
    for (const p of [policy({ tier: 'CONSTRAINED', surface: 'work' }), policy({ tier: 'HIGH', surface: 'work', reducedMotion: true })]) {
      for (const kind of ['panel', 'toast']) {
        const e = el();
        expect(MC.playEntrance(e, p, { kind })).toBeNull();
        expect(e.calls).toHaveLength(0);
      }
      const w = el();
      expect(MC.playWipe(w, p)).toBeNull();
    }
  });

  test('reduced motion keeps sheets as a 120 ms opacity-only fade', () => {
    const e = el();
    MC.playEntrance(e, policy({ reducedMotion: true, surface: 'work' }), { kind: 'sheet' });
    expect(e.calls).toHaveLength(1);
    expect(e.calls[0].opts.duration).toBe(120);
    for (const f of e.calls[0].frames) expect(Object.keys(f)).toEqual(['opacity']);
  });

  test('entrances animate transform and opacity only, at spec timings', () => {
    const p = policy({ tier: 'HIGH', surface: 'work' });
    const panel = el(); MC.playEntrance(panel, p, { kind: 'panel' });
    const sheet = el(); MC.playEntrance(sheet, p, { kind: 'sheet' });
    const toast = el(); MC.playEntrance(toast, p, { kind: 'toast' });
    expect(sheet.calls[0].opts.duration).toBe(300);
    expect(toast.calls[0].opts.duration).toBe(200);
    for (const c of [...panel.calls, ...sheet.calls, ...toast.calls]) {
      expect(c.opts.easing).toBe(MP.MOTION_EASE);
      for (const f of c.frames) {
        for (const k of Object.keys(f)) expect(['opacity', 'transform']).toContain(k);
      }
    }
  });

  function dom(html, { reduced = false, query = '' } = {}) {
    const d = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
      url: `http://localhost/${query}`, pretendToBeVisual: true,
    });
    const win = d.window;
    win.matchMedia = (q) => ({ matches: reduced && /reduce/.test(q), addEventListener() {} });
    Object.defineProperty(win.navigator, 'hardwareConcurrency', { value: 8, configurable: true });
    Object.defineProperty(win.navigator, 'deviceMemory', { value: 8, configurable: true });
    return { win, doc: win.document };
  }

  test('readMotionSignals honours reduced motion and the motionTier override', () => {
    const a = dom('', { reduced: true });
    expect(MC.readMotionSignals(a.win).reducedMotion).toBe(true);
    const b = dom('', { query: '?motionTier=CONSTRAINED' });
    const s = MC.readMotionSignals(b.win);
    expect(s.tier).toBe('CONSTRAINED');
    const { work } = MC.computePolicies(s);
    expect(work.animations).toBe(false);
  });

  test('applyPolicies publishes still flags on <html> for CONSTRAINED', () => {
    const { win, doc } = dom('', { query: '?motionTier=CONSTRAINED' });
    MC.applyPolicies(doc, MC.computePolicies(MC.readMotionSignals(win)));
    const root = doc.documentElement;
    expect(root.getAttribute('data-motion-work')).toBe('still');
    expect(root.getAttribute('data-motion-work-ambient')).toBe('off');
    expect(root.getAttribute('data-motion-work-state')).toBe('off');
  });

  test('Engineer empty state mounts once, is a note, and leaves on file import', () => {
    const { win, doc } = dom('<div id="np-canvas-wrap"></div>');
    const work = MP.resolveMotionPolicy({ tier: 'CONSTRAINED', surface: 'work' });
    const box = MC.mountEngineerEmptyState(doc, win, () => work);
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('note');
    expect(box.querySelector('svg.vi-engineer')).not.toBeNull();
    expect(MC.mountEngineerEmptyState(doc, win, () => work)).toBeNull();
    win.dispatchEvent(new win.CustomEvent('vip:fileLoaded'));
    expect(box.hidden).toBe(true);
  });

  test('segment groups cover A/B compare, the comparison toggle and Engineer tabs', () => {
    const sels = MC.SEGMENT_GROUPS.map((g) => g.selector).join(' ');
    expect(sels).toMatch(/compare-row__ab/);
    expect(sels).toMatch(/vip-comparison-toggle/);
    expect(sels).toMatch(/#tabBar/);
    const ab = MC.SEGMENT_GROUPS[0];
    const tone = (id) => ab.tone({ id });
    expect([tone('compareOriginalBtn'), tone('compareCleanedBtn'), tone('compareRemovedBtn')]).toEqual(['ref', 'voice', 'bgst']);
  });

  test('scroll reveals never target the working Quick Clean / mixer cards', () => {
    for (const sel of MC.MARKETING_REVEAL_SELECTORS) {
      expect(sel).not.toMatch(/v3-card|uploadPanel|enhancePanel|v3-workspace|tab-/);
    }
  });

  test('pointer effects are Landing-only, never in work areas, never under reduced motion', () => {
    for (const t of TIERS) expect(policy({ tier: t, surface: 'work' }).pointerEffects).toBe(false);
    expect(policy({ tier: 'HIGH', surface: 'marketing', reducedMotion: true }).pointerEffects).toBe(false);
    expect(policy({ tier: 'CONSTRAINED', surface: 'marketing' }).pointerEffects).toBe(false);
    expect(policy({ tier: 'HIGH', surface: 'marketing' }).pointerEffects).toBe(true);
    expect(MC.MAGNETIC_SELECTOR).toMatch(/^body\.v3 /);
    expect(MC.TILT_SELECTOR).toMatch(/^body\.v3 /);
    expect(read('src/presentation/MotionController.js')).toMatch(/\(pointer: fine\)/);
  });

  test('magnetic pull and tilt are clamped', () => {
    const rect = { left: 0, top: 0, width: 200, height: 50 };
    const far = MC.magneticOffset(10000, 10000, rect);
    expect(far.x).toBe(MC.MAGNET_MAX_PX);
    expect(Math.abs(far.y)).toBeLessThanOrEqual(MC.MAGNET_MAX_PX);
    expect(MC.magneticOffset(100, 25, rect)).toEqual({ x: 0, y: 0 });
    const corner = MC.tiltFromPointer(0, 0, rect);
    expect(corner.rx).toBe(MC.TILT_MAX_DEG);
    expect(corner.ry).toBe(-MC.TILT_MAX_DEG);
    expect(MC.tiltFromPointer(100, 25, rect)).toMatchObject({ rx: 0, ry: 0, u: 0.5, v: 0.5 });
  });

  test('splitHeadingLines wraps each <br> line and keeps the text', () => {
    const d = new JSDOM('<h2 id="t" class="v3-h2">Simple on the surface.<br><em>Strict underneath.</em></h2>');
    const h = d.window.document.getElementById('t');
    expect(MC.splitHeadingLines(h)).toBe(2);
    expect(h.querySelectorAll('.vip-line > .vip-line__inner')).toHaveLength(2);
    expect(h.querySelector('em').textContent).toBe('Strict underneath.');
    expect(h.dataset.vipSplit).toBe('pending');
    expect(MC.splitHeadingLines(h)).toBe(0);
  });

  test('never touches audio, the mixer or the ML path', () => {
    for (const rel of ['src/presentation/MotionController.js', 'src/presentation/Illustrations.js', 'src/ui/motion/motion.css']) {
      expect(read(rel)).not.toMatch(/AudioContext|PlaybackMixer|MLWorker|getUserMedia|setTargetAtTime/);
    }
  });
});

describe('motion.css', () => {
  const css = read('src/ui/motion/motion.css').replace(/\/\*[\s\S]*?\*\//g, '');

  test('keyframes animate only transform / opacity', () => {
    const frames = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\})\s*\}/g)];
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const [, body] of frames) {
      for (const [, prop] of body.matchAll(/([a-z-]+)\s*:/g)) {
        expect(['transform', 'opacity']).toContain(prop);
      }
    }
  });

  test('no transition on layout properties', () => {
    for (const [, value] of css.matchAll(/transition\s*:\s*([^;}]+)/g)) {
      expect(value).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\b/);
    }
  });

  test('every work-area animation is gated by a work motion flag', () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*animation\s*:[^{}]*)\}/g)];
    for (const [, selector, body] of rules) {
      if (/animation\s*:\s*none/.test(body)) continue;
      if (/#uploadPanel|vip-drop-art|vip-empty/.test(selector)) {
        expect(selector).toMatch(/data-motion-work-(ambient|state)="on"/);
      }
    }
  });

  test('reduced motion and still levels stop illustration motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/html\[data-motion="still"\] \.vi-svg \*/);
    expect(css).toMatch(/html\[data-motion-work="still"\] :is\(\.vip-drop-art, \.vip-empty\) \.vi-svg \*/);
    expect(css).toMatch(/animation-play-state: paused/);
  });

  test('never linear or a default easing keyword', () => {
    const decls = [...css.matchAll(/(transition(?:-timing-function)?|animation)\s*:\s*([^;}]+)/g)];
    expect(decls.length).toBeGreaterThan(10);
    for (const [, , value] of decls) {
      const v = value.replace(/var\([^)]*\)/g, '').replace(/cubic-bezier\([^)]*\)/g, '');
      expect(v).not.toMatch(/\b(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)\b/);
    }
  });

  test('split-line headings, magnetic CTAs and card tilt switch off under reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .vi-svg'));
    expect(reduced).toMatch(/\.vip-line__inner \{ transform: none !important/);
    expect(reduced).toMatch(/\.vip-spec \{ display: none; \}/);
    expect(reduced).toMatch(/scroll-behavior: auto/);
    expect(css).toMatch(/\[data-vip-split="pending"\] \.vip-line__inner \{ transform: translateY\(108%\); opacity: 0; filter: blur\(8px\)/);
  });

  test('publishes the Signal Glass tokens and spec timings', () => {
    expect(css).toMatch(/--vip-voice: #22d3ee/);
    expect(css).toMatch(/--vip-bgst: #f5b942/);
    expect(css).toMatch(/--vip-ref: #c3cbd5/);
    expect(css).toMatch(/--vip-canvas: #0a0e14/);
    expect(css).toMatch(/--vip-motion-ease: cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
  });
});

describe('Illustrations', () => {
  test('geometry is deterministic', () => {
    const a = Geo.barWavePath({ x: 0, y: 10, width: 100, height: 20, bars: 12, seed: 5 });
    const b = Geo.barWavePath({ x: 0, y: 10, width: 100, height: 20, bars: 12, seed: 5 });
    expect(a).toBe(b);
    expect(Geo.seededRandom(3)()).toBe(Geo.seededRandom(3)());
    expect(Geo.envelopePath({ x: 0, y: 0, width: 10, height: 4, points: 4 })).toMatch(/^M.*Z$/);
  });

  test.each(['split', 'drop', 'engineer-empty', 'pipeline-input', 'pipeline-separate', 'pipeline-export'])(
    '%s is same-origin, accessible and light', (name) => {
      const svg = Ill.illustrationMarkup(name);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/https?:|<image|<foreignObject|<script|xlink:href="(?!#)/);
      expect(svg).toMatch(/aria-hidden="true"|role="img" aria-label="[^"]+"/);
      expect(svg).toMatch(/focusable="false"/);
      expect(Buffer.byteLength(svg)).toBeLessThan(26 * 1024);
    },
  );

  test('voice is cyan, background is gold, original is silver', () => {
    const svg = Ill.illustrationMarkup('split');
    expect(svg).toMatch(/#22d3ee/);
    expect(svg).toMatch(/#f5b942/);
    expect(svg).toMatch(/#c3cbd5/);
    expect(svg).toMatch(/CLEAN VOICE/);
    expect(svg).toMatch(/BACKGROUND/);
  });

  test('two instances never share gradient / mask ids', () => {
    const ids = (s) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const a = ids(Ill.illustrationMarkup('drop'));
    const b = ids(Ill.illustrationMarkup('drop'));
    expect(a.length).toBeGreaterThan(3);
    for (const id of a) expect(b).not.toContain(id);
  });

  test('every pipeline step has a glyph and unknown names render nothing', () => {
    expect(Ill.PIPELINE_GLYPH_NAMES).toEqual(['input', 'decode', 'separate', 'spectral', 'reconstruct', 'livemix', 'export']);
    expect(Ill.illustrationMarkup('nope')).toBe('');
  });
});

describe('Meters', () => {
  test('attack is instant, release eases over 300 ms, fill is scaleX not width', () => {
    expect(Meters.METER_RELEASE_MS).toBe(300);
    const up = Meters.meterFillStyle(0.2, 0.8);
    expect(up.transition).toBe('none');
    expect(up.transform).toBe('scaleX(0.8000)');
    const down = Meters.meterFillStyle(0.8, 0.2);
    expect(down.transition).toMatch(/^transform 300ms/);
    expect(Meters.meterFillStyle(undefined, 2).frac).toBe(1);
    expect(read('src/ui/components/LiveMeters/LiveMeters.js')).not.toMatch(/fillEl\.style\.width/);
  });
});

describe('Wiring', () => {
  const landing = read('public/index.html');
  const app = read('public/app/index.html');

  test('both entry points load the shared motion layer from same-origin /src', () => {
    expect(landing).toMatch(/<link rel="stylesheet" href="\/src\/ui\/motion\/motion\.css">/);
    expect(app).toMatch(/href="\/src\/ui\/motion\/motion\.css"/);
    expect(read('public/landing-v3.js')).toMatch(/import\('\/src\/presentation\/MotionController\.js'\)/);
    expect(app).toMatch(/import\('\/src\/presentation\/MotionController\.js'\)[\s\S]*initMotion\(\{ page: 'engineer' \}\)/);
  });

  test('Landing reads in workflow order: hero, five user steps, workspace, pipeline, Engineer, uses, trust', () => {
    const at = (needle) => {
      const i = landing.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const order = ['id="home"', 'id="howItWorks"', 'id="stems"', 'id="pipeline"', 'id="engineer"', 'id="useCasesLabel"', 'id="trust"'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const steps = [...landing.matchAll(/<span class="v3-flow__num">(\d\d)<\/span>[\s\S]*?<strong>([^<]+)<\/strong>/g)].map((m) => [m[1], m[2]]);
    expect(steps).toEqual([['01', 'Import'], ['02', 'Choose outcome'], ['03', 'Process locally'], ['04', 'Compare A/B'], ['05', 'Adjust and export']]);
    const targets = [...landing.matchAll(/<li><a href="(#[A-Za-z]+)"><span class="v3-flow__num">/g)].map((m) => m[1]);
    expect(targets).toEqual(['#uploadPanel', '#modelSelect', '#processBtn', '#compareRow', '#exportRow']);
    for (const t of targets) expect(landing).toContain(`id="${t.slice(1)}"`);
    // Inside the workspace: import (with Process) before compare, compare before export.
    expect(at('id="uploadPanel"')).toBeLessThan(at('id="processBtn"'));
    expect(at('id="processBtn"')).toBeLessThan(at('id="compareRow"'));
    expect(at('id="compareOriginalBtn"')).toBeLessThan(at('id="exportRow"'));
  });

  test('Landing hosts the how-it-works figure, seven pipeline glyphs and the drop-zone drawing', () => {
    expect(landing).toMatch(/data-vip-illustration="split"/);
    for (const n of ['input', 'decode', 'separate', 'spectral', 'reconstruct', 'livemix', 'export']) {
      expect(landing).toContain(`data-vip-illustration="pipeline-${n}"`);
    }
    expect(landing).toMatch(/id="uploadZone"[^>]*>\s*<span class="vip-drop-art" data-vip-illustration="drop" aria-hidden="true">/);
  });
});
