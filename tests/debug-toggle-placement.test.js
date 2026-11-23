/**
 * @jest-environment jsdom
 *
 * The debug toggle and the live-diagnostics toggle sit in the page toolbar.
 * Collapsed diagnostics must not keep a fixed hit target over other controls.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('debug toolbar button', () => {
  const menu = read('public/app/debug-menu.js');
  const css = read('public/app/debug-menu.css');

  test('keeps the backtick shortcut and the header slot', () => {
    expect(menu).toMatch(/e\.key === '`'/);
    expect(menu).toMatch(/active\.tagName === 'INPUT'/);
    expect(menu).toMatch(/querySelector\('\.hdr-actions'\)/);
    expect(menu).toMatch(/querySelector\('\.v3-header__links'\)/);
    expect(menu).toMatch(/hdrActions\.appendChild\(_btn\)/);
    expect(menu).not.toMatch(/hdrActions\.prepend\(_btn\)/);
  });

  test('exposes an accessible name, expanded state, and panel id', () => {
    expect(menu).toMatch(/setAttribute\('aria-label', 'Toggle live debug menu'\)/);
    expect(menu).toMatch(/setAttribute\('aria-expanded', 'false'\)/);
    expect(menu).toMatch(/setAttribute\('aria-controls', 'vip-debug-panel'\)/);
    expect(menu).toMatch(/setAttribute\('aria-expanded', on \? 'true' : 'false'\)/);
  });

  test('the landing section nav keeps its content width beside a compact DBG', () => {
    expect(menu).toMatch(/<span class="vip-tool-label">DBG<\/span>/);
    expect(menu).toMatch(/setAttribute\('aria-label', 'Toggle live debug menu'\)/);
    expect(css).toMatch(/@media \(min-width: 769px\)/);
    expect(css).toMatch(/body\.v3 \.v3-nav,\s*body\.v3 \.v3-header__status\s*\{[^}]*flex:\s*0 0 auto/);
    expect(css).toMatch(/body\.v3 #vip-debug-toggle\.vip-debug-toggle--landing \.vip-tool-label/);
  });

  test('motion is transform and opacity on the shared curve, with a 44px mobile target', () => {
    expect(css).toMatch(/cubic-bezier\(0\.16,\s*1,\s*0\.3,\s*1\)/);
    expect(css).toMatch(/transition:\s*transform 180ms cubic-bezier\(0\.16, 1, 0\.3, 1\), opacity 180ms/);
    expect(css).not.toMatch(/#vip-debug-toggle\s*\{[^}]*transition:\s*all/);
    expect(css).toMatch(/@media \(max-width: 768px\)/);
    expect(css).toMatch(/min-width:\s*44px/);
    expect(css).toMatch(/min-height:\s*44px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/#vip-debug-toggle:focus-visible/);
    expect(css).toMatch(/#vip-debug-toggle:hover/);
    expect(css).toMatch(/#vip-debug-toggle\.active/);
    expect(css).not.toMatch(/dbg-pulse/);
  });
});

describe('live diagnostics toggle placement', () => {
  let diagnostics;

  beforeAll(async () => {
    diagnostics = await import('../src/diagnostics/LiveDiagnostics.js');
  });

  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('vip-live-diagnostics-style')?.remove();
    document.documentElement.style.cssText = '';
    diagnostics.clearLiveDiagnostics();
  });

  test('a stems header hosts the toggle and the collapsed panel does not take a hit target', () => {
    document.body.innerHTML = '<header class="v3-header"><span class="v3-header__links"><a class="v3-link v3-link--solid">Studio</a></span></header>';
    const panel = diagnostics.mountLiveDiagnostics('stems');
    const button = document.getElementById('vip-diag-toggle');
    expect(button).not.toBeNull();
    expect(button.parentElement.classList.contains('v3-header__links')).toBe(true);
    expect(panel.contains(button)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Toggle live diagnostics');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('vip-live-diagnostics');
    expect(button.classList.contains('vip-tool-btn')).toBe(true);
    expect(panel.dataset.dock).toBe('toolbar');
    expect(panel.dataset.collapsed).toBe('true');

    const style = document.getElementById('vip-live-diagnostics-style');
    const rules = Array.from(style.sheet.cssRules);
    const collapsed = rules.find(
      (rule) => rule.selectorText === '#vip-live-diagnostics[data-dock="toolbar"][data-collapsed="true"]',
    );
    expect(collapsed).toBeDefined();
    expect(collapsed.style.getPropertyValue('pointer-events')).toBe('none');
    expect(collapsed.style.getPropertyValue('width')).toBe('0');
    const reduced = rules.find((rule) => rule.conditionText && /prefers-reduced-motion/.test(rule.conditionText));
    expect(reduced).toBeDefined();
    expect(reduced.cssText).toContain('[data-dock="toolbar"]');
    expect(reduced.cssText).toContain('transition: none');

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.dataset.collapsed).toBe('false');
    button.click();
    expect(panel.dataset.collapsed).toBe('true');
  });

  test('an engineer header hosts the same toggle without changing the log', () => {
    document.body.innerHTML = '<header class="hdr"><div class="hdr-actions"><a class="btn">Download</a></div></header>';
    const panel = diagnostics.mountLiveDiagnostics('engineer');
    const button = document.getElementById('vip-diag-toggle');
    expect(button.parentElement.classList.contains('hdr-actions')).toBe(true);
    expect(button.classList.contains('vip-debug-toggle--engineer')).toBe(true);
    diagnostics.vipLog('info', 'engineer.boot', { page: 'engineer' });
    expect(panel.querySelector('[role="log"]').textContent).toMatch(/engineer\.boot/);
    expect(panel.dataset.collapsed).toBe('true');
  });

  test('without a toolbar the toggle stays on the panel and still expands it', () => {
    const panel = diagnostics.mountLiveDiagnostics('stems');
    const button = document.getElementById('vip-diag-toggle');
    expect(panel.contains(button)).toBe(true);
    expect(panel.dataset.dock).toBeUndefined();
    button.click();
    expect(panel.dataset.collapsed).toBe('false');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
