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

  test('app.js gates the fetch on reduced motion, Save-Data and offline', () => {
    expect(appJs).toMatch(/function shouldLoadHeroVideo\(\)/);
    expect(appJs).toMatch(/prefers-reduced-motion: reduce/);
    expect(appJs).toMatch(/saveData/);
    expect(appJs).toMatch(/navigator\.onLine === false/);
    // A browser without H.264 would otherwise fetch 2.2 MB, render nothing and
    // never fire `error` — the hero would just sit blank until the release timer.
    expect(appJs).toMatch(/canPlayType\('video\/mp4; codecs="avc1\.42E01E"'\)/);
    expect(appJs).toMatch(/if \(!shouldLoadHeroVideo\(\)\) \{ showFallback\(\); return; \}/);
  });

  test('release detaches the <source>, not just the src attribute', () => {
    expect(appJs).toMatch(/querySelectorAll\('source'\)\.forEach\(\(s\) => s\.remove\(\)\)/);
  });
});

describe('visualization tablist is exposed to assistive technology', () => {
  test('the scroll wrapper does not hide focusable tabs', () => {
    const wrapper = /<div id="vizTabScroll"[^>]*>/.exec(engineerHtml);
    expect(wrapper).not.toBeNull();
    expect(wrapper[0]).not.toMatch(/aria-hidden="true"/);
  });

  test('no aria-hidden ancestor wraps the tablist', () => {
    const start = engineerHtml.indexOf('<div class="viz-tab-rail">');
    const end = engineerHtml.indexOf('id="tabBar"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(engineerHtml.slice(start, end)).not.toMatch(/aria-hidden="true"/);
  });
});
