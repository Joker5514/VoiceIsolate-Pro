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

describe('the Whisper Mode row keeps its lock inside the rack', () => {
  const css = code(sliderThemeCss);

  test('slider-theme.css re-states the whisper row template it overwrites', () => {
    // `.whisper-mode-row` is also a `.sr-row`, and the four-column `.sr-row`
    // base in slider-theme.css loads after style.css at equal specificity. With
    // only style.css's areas surviving, the group track resolved to the flex
    // group's 201px min-content and the lock landed ~160px outside
    // `#tab-extreme-group`'s overflow:hidden box at 1024/1440/1920.
    expect(css).toMatch(/\.sr-row\.whisper-mode-row[\s\S]{0,400}grid-template-columns:[^;]*minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.whisper-mode-row \.whisper-mode-group\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.whisper-mode-row \.wm-btn\s*\{[^}]*min-width:\s*0/);
  });

  test('a narrow container gives the aggression group its own row', () => {
    const narrow = /@container\s+vip-rack\s*\(max-width:\s*400px\)\s*\{([\s\S]*?)\n\}/.exec(css);
    expect(narrow).not.toBeNull();
    expect(narrow[1]).toMatch(/\.sr-row\.whisper-mode-row/);
    expect(narrow[1]).toMatch(/"group group group group"/);
  });

  test('the >=1800px two-column rack stacks the whisper row too', () => {
    const ultra = /@media \(min-width: 1800px\)\s*\{\s*@container\s+vip-rack\s*\(max-width:\s*800px\)\s*\{([\s\S]*?)\n\s*\}\s*\n\}/.exec(css);
    expect(ultra).not.toBeNull();
    expect(ultra[1]).toMatch(/\.sr-row\.whisper-mode-row/);
  });
});

describe('fixed chrome never swallows a scrolled-to control', () => {
  test('the document scroller reserves room for the sticky header', () => {
    // scroll-padding is read from the scroll container, which for the document
    // viewport is `html` — it does not propagate up from `body`.
    expect(code(read('public/app/precision-studio.css'))).toMatch(
      /:root\s*\{[^}]*scroll-padding-top:\s*calc\(var\(--vip-hdr-h/,
    );
  });

  test('the <=768px document scroller reserves room for the action bar', () => {
    const mobile = code(read('public/app/mobile.css'));
    const block = /@media \(max-width: 768px\)\s*\{([\s\S]*?)\n\}/.exec(mobile);
    expect(block).not.toBeNull();
    // `.mobile-action-bar` is fixed at z-index 200 and owns the bottom ~61px.
    expect(block[1]).toMatch(/:root\s*\{[^}]*scroll-padding-bottom:/);
  });
});

describe('text tokens stay AA-pinned', () => {
  const ALPHA = /--text-ghost:\s*rgba\(244,\s*247,\s*250,\s*([0-9.]+)\)/;

  for (const sheet of ['public/landing.css', 'public/app/ds-tokens.css']) {
    test(`${sheet} keeps --text-ghost above the AA floor`, () => {
      const m = ALPHA.exec(code(read(sheet)));
      expect(m).not.toBeNull();
      // 0.46 measures 4.41:1 on --surface-root — below AA. 0.48 is the first
      // step that clears 4.5:1 on all three VIP surfaces (4.65-4.72:1).
      expect(Number(m[1])).toBeGreaterThanOrEqual(0.48);
    });
  }

  test('the active workflow badge paints white on the solid action colour', () => {
    const psShell = code(read('public/ps-shell.css'));
    const rule = /\.ps-workflow-nav__item--active \.ps-workflow-nav__number\s*\{([^}]*)\}/.exec(psShell);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/color:\s*#fff/);
    // White on --action-process is 3.48:1; the solid variant is 5.05:1.
    expect(rule[1]).toMatch(/background:\s*var\(--action-process-solid/);
    expect(rule[1]).not.toMatch(/background:\s*var\(--action-process,/);
  });

  test('whisper-mode buttons do not reuse the 3:1 greys', () => {
    const styleCss = code(read('public/app/style.css'));
    expect(styleCss).not.toMatch(/\.wm-btn\s*\{[^}]*color:\s*#666\b/);
    expect(styleCss).not.toMatch(/\.wm-btn\.active\[data-mode="2"\][^}]*color:\s*#fb923c/);
  });

  test('the debug panel does not paint labels below AA', () => {
    const dbg = code(read('public/app/debug-menu.css'));
    // `(?<![-\\w])` so `border-color` / `background-color` are not read as text.
    const alphas = [...dbg.matchAll(/(?<![-\w])color:\s*rgba\(176,\s*184,\s*200,\s*([0-9.]+)\)/g)]
      .map((m) => Number(m[1]));
    expect(alphas.length).toBeGreaterThan(0);
    // 0.64 is the alpha at which #b0b8c8 reaches 4.5:1 on the panel gradient.
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.64);
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
