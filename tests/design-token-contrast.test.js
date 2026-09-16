/**
 * WCAG AA contrast guards for the shared design tokens.
 *
 * Browser-driven QA found 21 failing text/background pairs on Landing and 55 on
 * the Engineer Console, all traceable to three tokens plus a repeated one-off
 * hex. These guards pin the ratios so a future palette edit cannot silently
 * reintroduce unreadable text.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * Parse a hex color to [r, g, b].
 *
 * `#RGB` shorthand and `#RRGGBBAA` are both valid CSS, and naive
 * `parseInt(hex, 16)` would read the wrong channels for either — silently
 * shifting every ratio below. Shorthand is expanded; an alpha channel is
 * rejected outright rather than guessed at, because compositing needs a
 * backdrop this helper does not have.
 */
function parseHex(hex) {
  const raw = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(raw)) throw new Error(`not a hex color: ${hex}`);
  if (raw.length === 4 || raw.length === 8) {
    throw new Error(`alpha hex needs compositing against a known backdrop: ${hex}`);
  }
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (full.length !== 6) throw new Error(`unsupported hex length: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** Relative luminance per WCAG 2.1 §1.4.3. */
function luminance(hex) {
  const channels = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a `--token: #hex;` declaration out of a stylesheet. */
function token(css, name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(css);
  if (!m) throw new Error(`token ${name} not found`);
  return m[1].toLowerCase();
}

const landing = read('public/landing.css');
const dsTokens = read('public/app/ds-tokens.css');
const styleCss = read('public/app/style.css');

const AA_NORMAL = 4.5;

describe('contrast helper', () => {
  test('matches known WCAG reference pairs', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 on white is the canonical "exactly AA" grey.
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.6);
  });

  test('handles #RGB shorthand and refuses alpha hex', () => {
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 1);
    expect(luminance('#f00')).toBeCloseTo(luminance('#ff0000'), 10);
    expect(() => luminance('#ffff')).toThrow(/alpha/);
    expect(() => luminance('#ff000080')).toThrow(/alpha/);
    expect(() => luminance('#ff00')).toThrow(/alpha/);
    expect(() => luminance('not-a-color')).toThrow(/hex/);
  });
});

describe('dim text tokens clear AA on their own surfaces', () => {
  const cases = [
    ['landing --text-dim', () => token(landing, '--text-dim'), () => token(landing, '--surface-root')],
    ['engineer --text-dim', () => token(dsTokens, '--text-dim'), () => token(dsTokens, '--surface-root')],
  ];
  for (const [label, fg, bg] of cases) {
    test(`${label} >= ${AA_NORMAL}:1`, () => {
      expect(contrast(fg(), bg())).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  test('engineer --dim clears AA on the console background', () => {
    // --dim paints 8-12px button labels and stat captions.
    expect(contrast(token(styleCss, '--dim'), '#07080c')).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test('--purple (a red accent, historic name) clears AA as text', () => {
    expect(contrast(token(styleCss, '--purple'), '#07080c')).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});

describe('filled action surfaces carry readable foregrounds', () => {
  test('--action-process-solid is defined on both shells', () => {
    expect(token(landing, '--action-process-solid')).toBe(token(dsTokens, '--action-process-solid'));
  });

  test('white text on --action-process-solid clears AA', () => {
    expect(contrast('#ffffff', token(landing, '--action-process-solid'))).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  test('the accent red is still too light for white text, which is why the variant exists', () => {
    // Guards the reason for the token: if this ever passes on its own the
    // variant can be retired, and the assertion will say so.
    expect(contrast('#ffffff', token(landing, '--action-process'))).toBeLessThan(AA_NORMAL);
  });

  test('filled red controls use the solid variant, not the accent', () => {
    const psShell = read('public/ps-shell.css');
    const premium = read('public/premium-refresh.css');
    expect(psShell).toMatch(/\.ps-btn--process \{\s*background: var\(--action-process-solid/);
    expect(psShell).toMatch(/\.ps-skip-link[\s\S]*?background: var\(--action-process-solid/);
    expect(premium).toMatch(/#processBtn \{ background: var\(--action-process-solid/);
  });

  test('the numbered workflow badge is not painted in its own background color', () => {
    const psShell = read('public/ps-shell.css');
    const m = /\.ps-step__n \{([^}]*)\}/.exec(psShell);
    expect(m).not.toBeNull();
    const color = /(?<!background-)color:\s*(#[0-9a-fA-F]{3,8})/.exec(m[1]);
    expect(color).not.toBeNull();
    expect(contrast(color[1], token(landing, '--action-process'))).toBeGreaterThanOrEqual(AA_NORMAL);
    // premium-refresh.css must not re-tint it back to the badge background.
    expect(read('public/premium-refresh.css')).not.toMatch(
      /\.ps-step__n \{[^}]*color:\s*var\(--action-process\)/,
    );
  });
});

describe('one-off dim hex is not reintroduced as text color', () => {
  test('style.css uses the token instead of #64748b for text', () => {
    const textUses = styleCss.match(/(?<!border-)color:\s*#64748b/g) || [];
    expect(textUses).toEqual([]);
  });
});
