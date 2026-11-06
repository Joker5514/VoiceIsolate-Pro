/**
 * Mobile fit + collapsible play button.
 * Layout contract only — playback handlers stay on #playBtn / #tpPlay.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCollapse() {
  const code = fs.readFileSync(path.join(__dirname, '../public/play-collapse.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(code, context);
  return context.VIPPlayCollapse;
}

const collapse = loadCollapse();

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const engineer = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/mobile-fit.css'), 'utf8');

describe('mobile fit stylesheet', () => {
  test('both shells load it last among shared sheets and keep play IDs', () => {
    expect(landing).toContain('href="/mobile-fit.css"');
    expect(engineer).toContain('href="/mobile-fit.css"');
    expect(landing).toContain('src="/play-collapse.js"');
    expect(engineer).toContain('src="/play-collapse.js"');
    expect(landing).toContain('id="playBtn"');
    expect(engineer).toContain('id="tpPlay"');
    expect(landing).not.toMatch(/getUserMedia/);
    expect(engineer).not.toMatch(/getUserMedia/);
  });

  test('Signal Glass tokens, 44px targets, and reduced motion are declared', () => {
    expect(css).toContain('#d90429');
    expect(css).toContain('#ff8fa3');
    expect(css).toContain('#e7dce0');
    expect(css).toContain('#070708');
    expect(css).toContain('cubic-bezier(0.23, 1, 0.32, 1)');
    expect(css).toMatch(/@media \(max-width: 768px\)/);
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('min-width: 44px');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toContain('grid-auto-flow: row');
    expect(css).toContain('overflow-x: visible');
    // Workstation body must keep scrolling the rack. Collapse clips only the play control.
    expect(css).not.toMatch(/body\.eng-console\.ws\s*\{[^}]*overflow/);
  });

  test('the neural skin does not resize play over the collapse contract', () => {
    const skin = fs.readFileSync(path.join(ROOT, 'public/app/neural-console.css'), 'utf8');
    const open = /body\.eng-console\.neural-console #tpPlay\.btn-tp-play \{([^}]*)\}/.exec(skin);
    expect(open).not.toBeNull();
    expect(open[1]).not.toMatch(/\b(?:min-)?(?:width|height)\s*:/);
    expect(skin).toMatch(/\.vip-play-slot\.is-collapsed #tpPlay \{[^}]*width:\s*0/);
    expect(engineer).toContain('id="tpPlayCollapseToggle"');
    expect(engineer).toContain('src="/play-collapse.js"');
  });
});

describe('play collapse control', () => {
  test('landing and engineer expose aria-expanded and aria-controls', () => {
    expect(landing).toMatch(/id="playCollapseToggle"[^>]*aria-expanded="true"/);
    expect(landing).toMatch(/id="playCollapseToggle"[^>]*aria-controls="playBtn"/);
    expect(landing).toContain('aria-label="Collapse play button"');
    expect(engineer).toMatch(/id="tpPlayCollapseToggle"[^>]*aria-expanded="true"/);
    expect(engineer).toMatch(/id="tpPlayCollapseToggle"[^>]*aria-controls="tpPlay"/);
  });

  test('storage round-trip and labels', () => {
    const mem = {
      _v: null,
      getItem() { return this._v; },
      setItem(k, v) { this._v = v; },
    };
    expect(collapse.KEY).toBe('vip-play-collapsed');
    expect(collapse.readCollapsed(mem)).toBe(false);
    expect(collapse.readCollapsed({ getItem() { throw new Error('denied'); } })).toBe(false);
    expect(collapse.writeCollapsed(mem, true)).toBe(true);
    expect(collapse.readCollapsed(mem)).toBe(true);
    expect(collapse.writeCollapsed(mem, false)).toBe(true);
    expect(collapse.readCollapsed(mem)).toBe(false);
    expect(collapse.writeCollapsed({ setItem() { throw new Error('denied'); } }, true)).toBe(false);

    expect(collapse.nextState(false)).toEqual({
      collapsed: false,
      expanded: true,
      toggleLabel: 'Collapse play button',
      playHidden: false,
    });
    expect(collapse.nextState(true).toggleLabel).toBe('Expand play button');
    expect(collapse.nextState(true).playHidden).toBe(true);
  });

  test('applyTo updates the slot without removing the play button', () => {
    const slot = { className: 'vip-play-slot', classList: { toggle(name, on) { this[name] = on; } } };
    const attrs = {};
    const toggle = { setAttribute(k, v) { attrs[k] = v; } };
    const playAttrs = { id: 'playBtn' };
    const play = {
      setAttribute(k, v) { playAttrs[k] = v; },
      removeAttribute(k) { delete playAttrs[k]; },
      getAttribute(k) { return playAttrs[k]; },
    };
    collapse.applyTo(slot, toggle, play, true);
    expect(slot.classList['is-collapsed']).toBe(true);
    expect(attrs['aria-expanded']).toBe('false');
    expect(attrs['aria-label']).toBe('Expand play button');
    expect(playAttrs['aria-hidden']).toBe('true');
    expect(playAttrs.tabindex).toBe('-1');
    expect(playAttrs.id).toBe('playBtn');
    collapse.applyTo(slot, toggle, play, false);
    expect(attrs['aria-expanded']).toBe('true');
    expect(playAttrs['aria-hidden']).toBeUndefined();
    expect(playAttrs.tabindex).toBeUndefined();
  });
});
