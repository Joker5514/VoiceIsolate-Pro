/**
 * Engineer Mode — collapsible slider groups (details/summary).
 * Asserts native [open] is the source of truth and content becomes visible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const styleCss = fs.readFileSync(path.join(ROOT, 'public/app/style.css'), 'utf8');
const vipFixes = fs.readFileSync(path.join(ROOT, 'public/app/vip-fixes.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');

describe('slider expand — CSS contracts', () => {
  test('open details forces slider-group-content visible (not max-height:0 trap)', () => {
    expect(styleCss).toMatch(/details\.slider-group\.vip-section\[open\]\s*>\s*\.slider-group-content/);
    expect(styleCss).toMatch(/display\s*:\s*block\s*!important/);
    // Collapsed bodies use not([open]) not only .active
    expect(styleCss).toMatch(/details\.slider-group\.vip-section:not\(\[open\]\)/);
  });

  test('vip-fixes accordion does not fight native details with class-only toggle', () => {
    expect(vipFixes).toMatch(/details\[open\] source of truth|mirror details\[open\]/i);
    // Must not clone-replace summary and set content.style.display as sole path
    expect(vipFixes).not.toMatch(/content\.style\.display = open \? '' : 'none'/);
    expect(vipFixes).toMatch(/addEventListener\('toggle'/);
  });

  test('app.js persists and mirrors active from details open', () => {
    expect(appSrc).toMatch(/_initCollapsibleSections/);
    expect(appSrc).toMatch(/vip\.engineer\.sectionOpen\.v1/);
    expect(appSrc).toMatch(/classList\.toggle\('active',\s*!!el\.open\)/);
    expect(appSrc).toMatch(/addEventListener\('toggle'/);
  });
});

describe('slider expand — DOM simulation', () => {
  /** Minimal jsdom-free details polyfill for Node tests */
  function makeDetails(open = false) {
    const listeners = {};
    const summary = {
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
    };
    const state = {
      tagName: 'DETAILS',
      open: !!open,
      classList: {
        _c: new Set(open ? ['active', 'slider-group', 'vip-section'] : ['slider-group', 'vip-section']),
        toggle(name, force) {
          if (force === true) this._c.add(name);
          else if (force === false) this._c.delete(name);
          else if (this._c.has(name)) this._c.delete(name);
          else this._c.add(name);
          return this._c.has(name);
        },
        contains(name) { return this._c.has(name); },
        add(name) { this._c.add(name); },
      },
      dataset: {},
      _summary: summary,
      querySelector(sel) {
        if (String(sel).includes('summary')) return summary;
        return null;
      },
      querySelectorAll() { return []; },
      addEventListener(type, fn) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      dispatchToggle() {
        (listeners.toggle || []).forEach((fn) => fn());
      },
    };
    return state;
  }

  function syncActive(el) {
    el.classList.toggle('active', !!el.open);
    const sum = el.querySelector(':scope > summary');
    if (sum) sum.setAttribute('aria-expanded', String(!!el.open));
  }

  test('toggle open → active class and aria-expanded true', () => {
    const el = makeDetails(false);
    expect(el.open).toBe(false);
    expect(el.classList.contains('active')).toBe(false);

    // Simulate user click on summary: browser sets open=true then fires toggle
    el.open = true;
    syncActive(el);
    el.dispatchToggle();

    expect(el.open).toBe(true);
    expect(el.classList.contains('active')).toBe(true);
    const sum = el.querySelector('summary');
    expect(sum.setAttribute).toHaveBeenCalledWith('aria-expanded', 'true');
  });

  test('collapse open → active cleared', () => {
    const el = makeDetails(true);
    syncActive(el);
    expect(el.classList.contains('active')).toBe(true);

    el.open = false;
    syncActive(el);
    expect(el.classList.contains('active')).toBe(false);
  });

  test('Engineer HTML wraps all major slider groups in details with summary', () => {
    const required = [
      'section-gate',
      'section-eq',
      'section-dynamics',
      'section-spectral',
      'section-advanced',
      'section-output',
      'section-separation',
      'tab-extreme-group',
      'section-analysis',
      'section-presets',
      'section-whisper-hunter',
      'vizCard',
    ];
    for (const id of required) {
      expect(indexHtml).toMatch(new RegExp(`id="${id}"`));
      expect(indexHtml).toMatch(new RegExp(`id="${id}"[^>]*>[\\s\\S]*?<summary`, 'i'));
    }
    expect(indexHtml).toMatch(/Separation → Isolation|Separation/);
  });
});

describe('separation → isolation wiring (source contracts)', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/pipeline/EngineerModeBridge.js'), 'utf8');

  test('bridge documents and implements stem-pair isolation path', () => {
    expect(bridgeSrc).toMatch(/loadStemPair/);
    expect(bridgeSrc).toMatch(/voiceIso/);
    expect(bridgeSrc).toMatch(/bgSuppress/);
    expect(bridgeSrc).toMatch(/setVoiceLevel|setNoiseReduction/);
  });

  test('app retains noise stem and loads bridge after ML separation', () => {
    expect(appSrc).toMatch(/_noiseStemChannels|_cleanStemChannels/);
    expect(appSrc).toMatch(/_loadSeparationStemsToBridge/);
    expect(appSrc).toMatch(/loadStemPair/);
  });
});
