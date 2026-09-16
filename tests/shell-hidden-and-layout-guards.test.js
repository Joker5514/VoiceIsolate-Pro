/**
 * Regression guards for shell defects found by browser-driven QA:
 *
 *  1. `[hidden]` was defeated by author `display` rules, so state-managed UI
 *     (the Forensic workspace nav, the Quick workflow strip, the hero video
 *     fallback, Landing's export row / cancel buttons) rendered while the JS
 *     that owns them believed it was hidden.
 *  2. The Engineer DSP slider row's five-column grid needs >=380px but the
 *     rack column is ~310-350px at every desktop width, so the lock button
 *     was clipped out of an `overflow:hidden` ancestor and unclickable.
 *  3. `.hdr` was clamped with `height: var(--titlebar-h)` while wrapping onto
 *     two rows, so the second row escaped the sticky header and painted over
 *     the page content.
 *  4. The decorative 2.2 MB hero loop had `preload="auto"` + an eager
 *     `<source>`, making it 43% of the Engineer shell's first-load bytes on
 *     every platform regardless of motion or data preferences.
 *  5. The visualization tablist sat inside `aria-hidden="true"` while its tabs
 *     stayed keyboard-focusable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const landingCss = read('public/landing.css');
const dsTokensCss = read('public/app/ds-tokens.css');
const dsOverridesCss = read('public/app/ds-overrides.css');
const sliderThemeCss = read('public/app/slider-theme.css');
const engineerConsoleCss = read('public/app/engineer-console.css');
const engineerConsoleJs = read('public/app/engineer-console.js');
const engineerHtml = read('public/app/index.html');

/** Strip comments so prose examples never satisfy a guard. */
const code = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('`hidden` attribute stays authoritative', () => {
  for (const [name, css] of [
    ['public/landing.css', landingCss],
    ['public/app/ds-tokens.css', dsTokensCss],
  ]) {
    test(`${name} forces [hidden] { display: none }`, () => {
      expect(code(css)).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    });
  }

  test('no stylesheet gives a [hidden] element a visible display', () => {
    const sheets = [
      'public/landing.css',
      'public/ps-shell.css',
      'public/transport-polish.css',
      'public/premium-refresh.css',
      'public/app/style.css',
      'public/app/ds-tokens.css',
      'public/app/ds-overrides.css',
      'public/app/precision-studio.css',
      'public/app/engineer-console.css',
      'public/app/mobile.css',
      'public/app/slider-theme.css',
    ];
    const offenders = [];
    for (const sheet of sheets) {
      const css = code(read(sheet));
      // Any rule whose selector mentions [hidden] must resolve display to none.
      const ruleRe = /([^{}]*\[hidden\][^{}]*)\{([^}]*)\}/g;
      let m;
      while ((m = ruleRe.exec(css)) !== null) {
        const decls = m[2];
        const display = /display:\s*([^;!]+)/.exec(decls);
        if (display && display[1].trim() !== 'none') {
          offenders.push(`${sheet}: ${m[1].trim()} { display: ${display[1].trim()} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('DSP slider row adapts to its container, not the viewport', () => {
  const css = code(sliderThemeCss);

  test('rack hosts establish an inline-size container', () => {
    expect(css).toMatch(/\.slider-panel[\s\S]{0,200}container-type:\s*inline-size/);
    expect(css).toMatch(/container-name:\s*vip-rack/);
  });

  test('a narrow container stacks the track under the label', () => {
    expect(css).toMatch(/@container\s+vip-rack\s*\(max-width:\s*400px\)/);
    // Stacked areas keep number + reset + lock on the label row.
    expect(css).toMatch(/"label num reset lock"/);
    expect(css).toMatch(/"track track track track"/);
  });

  test('the >=1800px two-column rack raises the container threshold', () => {
    // engineer-console.css splits .slider-panel into two columns there, so each
    // cell is about half the container and the 400px rule would not fire.
    expect(code(engineerConsoleCss)).toMatch(
      /@media \(min-width: 1800px\)[\s\S]*?\.slider-panel\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/,
    );
    expect(css).toMatch(
      /@media \(min-width: 1800px\)\s*\{\s*@container\s+vip-rack\s*\(max-width:\s*800px\)/,
    );
  });

  test('lock and reset keep >=40px hit targets', () => {
    expect(css).toMatch(/--vip-hit:\s*40px/);
    expect(css).toMatch(/\.slider-lock-btn,\s*\n?\s*\.slider-reset-btn\s*\{[\s\S]*?width:\s*var\(--vip-hit\)/);
  });
});

describe('Engineer header sizes to its content', () => {
  test('.hdr is not clamped with a fixed height', () => {
    const rule = /\.hdr\s*\{([^}]*)\}/g;
    let m;
    let sawMinHeight = false;
    while ((m = rule.exec(code(dsOverridesCss))) !== null) {
      const decls = m[1];
      const fixed = /(?<!min-)(?<!max-)height:\s*var\(--titlebar-h\)/.test(decls);
      expect(fixed).toBe(false);
      if (/min-height:\s*var\(--titlebar-h\)/.test(decls)) sawMinHeight = true;
    }
    expect(sawMinHeight).toBe(true);
  });

  test('header rows wrap instead of overflowing', () => {
    const styleCss = code(read('public/app/style.css'));
    expect(styleCss).toMatch(/\.hdr-left\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(styleCss).toMatch(/\.hdr-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  test('the real header height is published as --vip-hdr-h', () => {
    expect(engineerConsoleJs).toMatch(/function trackHeaderHeight\(\)/);
    expect(engineerConsoleJs).toMatch(/setProperty\('--vip-hdr-h'/);
    expect(engineerConsoleJs).toMatch(/trackHeaderHeight\(\);/);
  });

  test('sticky offsets below the header consume --vip-hdr-h', () => {
    expect(code(engineerConsoleCss)).toMatch(/top:\s*calc\(var\(--vip-hdr-h, 48px\)/);
    expect(code(read('public/app/precision-studio.css'))).toMatch(
      /top:\s*var\(--vip-hdr-h,\s*var\(--titlebar-h, 48px\)\)/,
    );
  });
});

describe('decorative hero video is opt-in, not a first-load cost', () => {
  const appJs = read('public/app/app.js');

  test('markup ships no eager <source> and does not preload', () => {
    const tag = /<video id="heroVideo"[\s\S]*?<\/video>/.exec(engineerHtml);
    expect(tag).not.toBeNull();
    expect(tag[0]).toMatch(/preload="none"/);
    expect(tag[0]).not.toMatch(/preload="auto"/);
    expect(tag[0]).not.toMatch(/\bautoplay\b/);
    // The URL lives on data-src so the browser cannot fetch it before app.js
    // decides; a literal <source src> would defeat the whole guard.
    expect(tag[0]).toMatch(/data-src="media\//);
    expect(tag[0]).not.toMatch(/<source\s/);
  });

  /** Body of a named function declaration, brace-matched. */
  const functionBody = (src, name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  };

  test('shouldLoadHeroVideo opts out on motion, data, offline and codec', () => {
    const gate = functionBody(appJs, 'shouldLoadHeroVideo');
    expect(gate).toMatch(/prefers-reduced-motion: reduce/);
    expect(gate).toMatch(/saveData/);
    // The 2G branch is separate from saveData — a slow link is not necessarily
    // a metered one, so deleting it must fail here too.
    expect(gate).toMatch(/effectiveType/);
    expect(gate).toMatch(/2g/);
    expect(gate).toMatch(/navigator\.onLine === false/);
    // Must probe the codec the shipped asset actually uses. Its avcC box reads
    // profile 0x64 (High) level 0x1F (3.1) -> avc1.64001F; probing Baseline
    // would pass on a Baseline-only runtime that still cannot decode the file.
    expect(gate).toMatch(/canPlayType\('video\/mp4; codecs="avc1\.64001F"'\)/);
  });

  test('initHeroVideo consults the gate before attaching any source', () => {
    const init = functionBody(appJs, 'initHeroVideo');
    const guardAt = init.indexOf('shouldLoadHeroVideo()');
    const attachAt = init.indexOf("createElement('source')");
    expect(guardAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(-1);
    // The early return must come first, or the gate cannot prevent the fetch.
    expect(guardAt).toBeLessThan(attachAt);
    expect(init).toMatch(/if \(!shouldLoadHeroVideo\(\)\) \{ showFallback\(\); return; \}/);
  });

  /** Body of `const <name> = () => { … };`, brace-matched. */
  const arrowBody = (src, name) => {
    const start = src.indexOf(`const ${name} = () => {`);
    if (start < 0) throw new Error(`${name} not found`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  };

  // Hiding the element does not cancel an in-flight transfer, so *each* path
  // that gives up on the video must detach the <source> and call load().
  // Asserted per path: counting matches across the whole function would let one
  // path lose its teardown as long as the other still had two statements.
  for (const path of ['showFallback', 'releaseHero']) {
    test(`${path} detaches the source and reloads`, () => {
      const body = arrowBody(functionBody(appJs, 'initHeroVideo'), path);
      expect(body).toMatch(/querySelectorAll\('source'\)\.forEach\(\(s\) => s\.remove\(\)\)/);
      expect(body).toMatch(/video\.load\(\)/);
    });
  }
});

describe('focusable content is never inside aria-hidden', () => {
  // Parse the real markup: a text slice between two offsets would not notice
  // `aria-hidden="true"` appearing on #vizCardBody or any other ancestor
  // outside the slice, which is exactly how this defect could come back.
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(engineerHtml).window.document;

  /** Nearest ancestor (inclusive) carrying aria-hidden="true", or null. */
  const hiddenAncestor = (el) => {
    for (let n = el; n; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return n;
    }
    return null;
  };
  const describeEl = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
    + (n.className ? '.' + String(n.className).split(/\s+/)[0] : '');

  test('the visualization tablist has no aria-hidden ancestor', () => {
    const tabBar = doc.getElementById('tabBar');
    expect(tabBar).not.toBeNull();
    const host = hiddenAncestor(tabBar);
    expect(host && describeEl(host)).toBeNull();
  });

  test('every visualization tab is exposed', () => {
    const tabs = [...doc.querySelectorAll('#tabBar [role="tab"]')];
    expect(tabs.length).toBeGreaterThan(0);
    const buried = tabs.filter((t) => hiddenAncestor(t)).map(describeEl);
    expect(buried).toEqual([]);
  });

  // A shell-wide "no focusable element under aria-hidden" sweep belongs in the
  // browser, not here: several legitimate `aria-hidden` containers (the
  // processing overlay, the preset modal, the isolation confirm bar) are hidden
  // with `display: none` from CSS, which markup alone cannot see, and a
  // display:none subtree is not focusable anyway. That assertion runs against
  // real computed visibility in scripts/precision-studio-ui-smoke.cjs.
});
